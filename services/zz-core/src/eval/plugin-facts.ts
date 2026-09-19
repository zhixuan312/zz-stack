/**
 * THE FACTS A THRESHOLD IS DRAWN OVER, AND WHETHER THE LINE CAN REACH THEM.
 *
 * SPLIT OUT OF plugin-judge.ts BY SUBJECT, not because that file reached its ceiling. Every
 * tool there produces or reads a JUDGEMENT. This file produces neither: it assembles figures a
 * tool computed, and answers one mechanical question about a ruler — does the figure this line
 * needs exist on the sheet. That question has to be answerable from `ruler_record`, which
 * writes a ruler, and from `round_judge`, which marks against one, and a helper reached by both
 * belongs beside neither.
 *
 * WHY THE QUESTION EXISTS AT ALL. A threshold was prose and nothing checked it against the
 * evidence the platform can actually produce. zz-plugin-eval 0.56.0 was scored against "every
 * non-control round recorded against this plugin version has a control round naming it" — a
 * figure `plugin_profile` does not compute and never has. `applyThresholds` is instructed to
 * answer NOT MET when the facts lack the figure a line needs, so the line came back failed, at
 * 11%, and became the headline of a report that had already been approved and closed. It was
 * false: every round at that version did carry a control.
 *
 * THE COST IS PAID TWICE, IN OPPOSITE DIRECTIONS, which is what makes it worth a gate rather
 * than a warning. An unmeasurable line DEFLATES the score, because it counts against the
 * quantitative half — 7.06 where the same marks otherwise give 9.06, a whole band — and
 * INFLATES the headroom, because the same line counts as a named change. Afterwards nothing
 * can separate the two cases: `zz.eval_score` holds 1 for a line that failed and 1 for a line
 * that was never asked. See journal 0143.
 *
 * SO THE LINE NAMES ITS FIGURE AND THE NAME IS RESOLVED, at the gate, while the ruler is still
 * a draft and before any artifact has been marked. This is the same argument that already puts
 * `threshold` and `threshold_reason` before the judge sees anything — a line you can still move
 * once you know the answer is not a line.
 */
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

import { ARTIFACTS_DIR } from "@zz/indexing";
import type pg from "pg";

import { entryOf, servesOwnDoor, toolsNamedBy } from "./plugin-eval.js";
import { pluginTraces } from "./plugin-profile.js";
import { sanitize } from "../paths.js";

/** The document body, out of the artifact store. Resolved HERE and not passed in, which is what
 *  keeps the judge's input out of the conversation: the caller names a plugin and a version. */
export const bodyOf = (team: string, initiative: string, path: string): string | null => {
  try {
    const f = join(ARTIFACTS_DIR, "teams", sanitize(team), initiative, path);
    return existsSync(f) ? readFileSync(f, "utf8") : null;
  } catch { return null; }
};

/** Everything a threshold could be written against, as one sheet.
 *
 * THE WHOLE PROFILE MINUS THE STAGE PATHS. A threshold reads a figure — how many runs, how many
 * returns, how many named tools were never called, what the mean delta was — and stage_paths is
 * a per-initiative listing rather than a figure, so it is the one block that would spend the
 * budget without being able to answer anything. Everything else stays, because a fact sheet
 * trimmed to what somebody expected the thresholds to ask makes an unanswerable threshold look
 * like a failed one. */
export async function factObject(p: pg.Pool, plugin: string, version: string): Promise<Record<string, unknown>> {
  const entry = entryOf(plugin);
  const stages: string[] = (entry?.manifest.stages ?? []).map((s) => s.name);
  const traces = await pluginTraces(p, plugin, version, toolsNamedBy(plugin), stages, servesOwnDoor(plugin));
  const { stage_paths, ...figures } = traces;
  const named = toolsNamedBy(plugin);
  return {
    plugin, version,
    // THE DENOMINATOR, STATED. A threshold is routinely written as a share of "the tools this
    // plugin's skills name" — and the sheet listed `never_called` and `use` but never that
    // set, so the judge had to infer its size from the two and got it wrong: zz-core's ruler
    // was read against 16 named tools on a plugin that names 15, because the one tool a run
    // had called (`skill_read`) is not one this plugin's skills name and was added in anyway.
    // A figure a threshold is measured against belongs on the sheet, not in the reader's head.
    tools_named: named,
    tools_named_count: named.length,
    // THE TOTAL, ALONGSIDE THE PER-TOOL ROWS. A threshold over refusals is written as a SHARE
    // -- at least half of them are the guardrail firing -- and a judge handed fifteen per-tool
    // rows has to add four columns across all of them before it can read the line. It is the
    // same argument as tools_named_count above: a figure a threshold is measured against
    // belongs on the sheet rather than in the reader's arithmetic.
    refusals: figures.use.reduce(
      (a, u) => ({ total: a.total + u.refusals, guardrail: a.guardrail + u.guardrail,
                   ours: a.ours + u.ours, theirs: a.theirs + u.theirs,
                   unattributed: a.unattributed + u.unattributed }),
      { total: 0, guardrail: 0, ours: 0, theirs: 0, unattributed: 0 }),
    // THE RECORD, ON THE SHEET. A threshold over rows needs the rows counted here; asking a
    // judge that reads markdown about the contents of a database column is how a dimension
    // comes to measure something other than what it is named for.
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
 *  PRESENT IS NOT THE SAME AS TRUE, and both null and undefined are absent. `record` is null for
 *  a plugin whose door writes no documents, so `record.revised` is a legitimate line on zz-core
 *  and unanswerable on sdlc — the same ruler text, measurable against one subject and not the
 *  other. A path that lands on null has no figure behind it, and that is the whole question.
 *
 *  AN EMPTY ARRAY IS PRESENT. `never_called: []` is the answer "none of them", which is a figure
 *  a line can be drawn over — "at most a third were never called" is MET by an empty list, and
 *  treating it as missing would refuse the ruler that is working best. */
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
 *  NAMING WHAT EXISTS IS THE HALF THAT MAKES THE GATE USABLE. A refusal that says only "that
 *  figure is not on the sheet" sends an author guessing at key names, and the guess costs
 *  another round trip through a gated document. Arrays and their elements are not walked: a
 *  threshold reads a figure, and `use[3].refusals` is one plugin-run's row rather than a line
 *  anybody should draw. */
function figuresOn(sheet: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(sheet)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      out.push(...figuresOn(v as Record<string, unknown>, path));
    } else if (v !== undefined) {
      out.push(path);
    }
  }
  return out;
}

/** The refusal a ruler earns when a quantitative line names no figure, or names one that is not
 *  there. Returns null when every line can be measured.
 *
 *  ONE REFUSAL FOR BOTH FAULTS, because they are the same fault at different stages: a line with
 *  no `reads` has not been checked against anything, and a line whose `reads` misses has been
 *  checked and cannot be. Either way the round it would produce is a number nobody can read. */
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
