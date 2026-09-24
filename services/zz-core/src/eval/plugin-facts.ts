/**
 * The facts a threshold is drawn over, and whether the line can reach them.
 *
 * This file produces no judgement: it assembles figures a tool computed and answers one
 * mechanical question about a ruler — does the figure this line needs exist on the sheet.
 * `round_judge`, which marks against a legacy `zz.rubric`, reaches it; the removed `ruler_record`
 * (Task I-10) used to, ahead of writing a ruler, and no writer reaches it any more.
 *
 * `applyThresholds` answers NOT MET when the facts lack the figure a line needs, so an
 * unmeasurable line is indistinguishable from a failed one afterwards: `zz.eval_score` holds 1
 * for both. It deflates the score, because it counts against the quantitative half, and
 * inflates the headroom, because it counts as a named change.
 *
 * So a line names its figure and the name is resolved at the gate, while the ruler is still a
 * draft and before any artifact has been marked.
 */
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

import { ARTIFACTS_DIR } from "@zz/indexing";
import type pg from "pg";

import { entryOf, servesOwnDoor, toolsNamedBy } from "./plugin-eval.js";
import { UNBOUNDED_WINDOW, pluginTraces } from "./plugin-profile.js";
import { sanitize } from "../paths.js";

/** The document body, out of the artifact store. Resolved here and not passed in, which is what
 *  keeps the judge's input out of the conversation: the caller names a plugin and a version. */
export const bodyOf = (team: string, initiative: string, path: string): string | null => {
  try {
    const f = join(ARTIFACTS_DIR, "teams", sanitize(team), initiative, path);
    return existsSync(f) ? readFileSync(f, "utf8") : null;
  } catch { return null; }
};

/** Everything a threshold could be written against, as one sheet.
 *
 * The whole profile minus the stage paths: a threshold reads a figure, and stage_paths is a
 * per-initiative listing rather than a figure. Everything else stays, because a sheet trimmed
 * to what somebody expected the thresholds to ask makes an unanswerable line look failed. */
export async function factObject(p: pg.Pool, plugin: string, version: string): Promise<Record<string, unknown>> {
  const entry = entryOf(plugin);
  const stages: string[] = (entry?.manifest.stages ?? []).map((s) => s.name);
  // round_judge judges a plugin's whole recorded history, not one bounded evidence window —
  // Task I-7's window is `plugin_profile`'s own (observe.ts), named
  // explicitly here rather than defaulted inside pluginTraces.
  const traces = await pluginTraces(p, plugin, version, toolsNamedBy(plugin), stages,
    servesOwnDoor(plugin), UNBOUNDED_WINDOW);
  const { stage_paths, ...figures } = traces;
  const named = toolsNamedBy(plugin);
  return {
    plugin, version,
    // The denominator, stated. A threshold is routinely written as a share of "the tools this
    // plugin's skills name", and a judge left to infer that set from `never_called` and `use`
    // counts a called tool the skills do not name. A figure a threshold is measured against
    // belongs on the sheet.
    tools_named: named,
    tools_named_count: named.length,
    // The total, alongside the per-tool rows: a threshold over refusals is written as a share,
    // and a judge handed the per-tool rows alone has to add columns across all of them first.
    refusals: figures.use.reduce(
      (a, u) => ({ total: a.total + u.refusals, guardrail: a.guardrail + u.guardrail,
                   ours: a.ours + u.ours, theirs: a.theirs + u.theirs,
                   unattributed: a.unattributed + u.unattributed }),
      { total: 0, guardrail: 0, ours: 0, theirs: 0, unattributed: 0 }),
    // The record, on the sheet: a threshold over rows needs the rows counted here, not inferred
    // by a judge that reads markdown.
    record: figures.record
      ? { ...figures.record,
          revised_with_evidence_pct: figures.record.revised
            ? Math.round(1000 * Number(figures.record.revised_with_evidence) / Number(figures.record.revised)) / 10
            : null,
          patched_with_evidence_pct: figures.record.patched
            ? Math.round(1000 * Number(figures.record.patched_with_evidence) / Number(figures.record.patched)) / 10
            : null }
      : null,
    traces: { ...figures, initiatives_with_a_path: stage_paths.length },
  };
}

/** Does this dotted path reach a figure on the sheet?
 *
 *  Present is not the same as true, and both null and undefined are absent. `record` is null
 *  for a plugin whose door writes no documents, so `record.revised` is a legitimate line on one
 *  subject and unanswerable on another.
 *
 *  An empty array is present: `never_called: []` is the answer "none of them", and a line like
 *  "at most a third were never called" is met by it. */
export function reaches(sheet: Record<string, unknown>, path: string): boolean {
  let at: unknown = sheet;
  for (const key of path.split(".")) {
    if (at === null || typeof at !== "object") return false;
    at = (at as Record<string, unknown>)[key];
  }
  return at !== undefined && at !== null;
}

/** Every dotted path a line could name, for a refusal that shows the caller the sheet.
 *
 *  A refusal that says only "that figure is not on the sheet" sends an author guessing at key
 *  names. Arrays and their elements are not walked: a threshold reads a figure, and
 *  `use[3].refusals` is one plugin-run's row.
 *
 *  A null is not listed, on the same rule `reaches` applies one line up — a list of what you
 *  may write has to be the list the gate accepts. */
function figuresOn(sheet: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(sheet)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      out.push(...figuresOn(v as Record<string, unknown>, path));
    } else if (v !== undefined && v !== null) {
      out.push(path);
    }
  }
  return out;
}

/** The refusal a ruler earns when a quantitative line names no figure, or names one that is not
 *  there. Returns null when every line can be measured.
 *
 *  One refusal for both faults: a line with no `reads` has not been checked against anything,
 *  and a line whose `reads` misses has been checked and cannot be. */
export function readsRefusal(
  dims: { name: string; kind: string; reads?: string[] | null }[],
  sheet: Record<string, unknown>,
): string | null {
  const faults: string[] = [];
  for (const d of dims) {
    if (d.kind !== "quantitative") continue;
    const reads = (d.reads ?? []).filter((r) => r.trim());
    if (!reads.length) {
      faults.push(`"${d.name}" names no figure — give \`reads\`, the dotted path(s) on the ` +
                  "facts sheet this line is drawn over");
      continue;
    }
    const missing = reads.filter((r) => !reaches(sheet, r.trim()));
    if (missing.length) {
      faults.push(`"${d.name}" reads ${missing.map((m) => `\`${m}\``).join(", ")}, which ` +
                  `${missing.length === 1 ? "is" : "are"} not on this plugin's facts sheet`);
    }
  }
  if (!faults.length) return null;
  return (
    `REFUSED: ${faults.join("; ")}. A quantitative dimension is a line drawn over a figure a ` +
    "tool computed, and the threshold pass answers NOT MET when the figure is absent — so a " +
    "line that cannot reach its figure does not come back unanswered, it comes back FAILED, " +
    "and nothing afterwards can tell that from a line the plugin really missed. It would " +
    "lower the score and raise the headroom at the same time, for a question the evidence " +
    "was never asked.\n\nThe figures this plugin's sheet actually carries:\n" +
    figuresOn(sheet).map((f) => `  ${f}`).join("\n") +
    "\n\nIf the figure you want is not there, the line is not a threshold yet: either compute " +
    "it in plugin_profile first, or make the property true by construction in the tool that " +
    "writes it — a rule enforced at the door needs no line, no figure and no judge."
  );
}
