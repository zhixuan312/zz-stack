/**
 * The deterministic half of DISCOVER (Task I-9, FR-11): grouping real failures into candidate
 * failure modes before any model is asked anything. Kept out of discover.ts to stay under this
 * repository's 700-line ceiling — discover.ts is the tool, the evaluator and the model calls;
 * this is the SQL and the grouping arithmetic behind it.
 *
 * Two grouping passes, because the plan header names two evidence shapes and "prevalence" means
 * a different population for each:
 *   - REFUSAL groups: one (tool, refusal rule, owner) triple per group, over the
 *     exact event population `toolCallEvents` already bounds `pluginTraces`' own `use` rows to.
 *     Denominator is the total tool-call events in the window — the same population
 *     `tool_refusal_rate` (observe-facts.ts) reports against, so a reader can cross-check one
 *     figure against the other.
 *   - RETURN groups: one (from_step, back_to_step) pair per group, folded from `pluginTraces`'
 *     own `returns` array — a stage revisited after a later one already ran. Denominator is the
 *     total step visits, matching `stage_return_rate`'s own population. A plugin that declares
 *     no stages (zz-core) produces no returns at all and this pass reports an empty array — an
 *     honest "nothing to group", not a missing feature.
 *
 * DELIBERATE: no fact here is classified. A group's `tool`/`normalized_text`/`from_step`/
 * `back_to_step` are names read straight off the event log; discover.ts is the only place that
 * turns a group into a description, a prevalence share of a whole and an owner_kind.
 */
import type pg from "pg";

import { toolCallEvents, type EvidenceWindow, type pluginTraces } from "./plugin-profile.js";
import { NORMALIZED_REFUSAL_SQL } from "./observe-facts.js";

/** One deterministic failure-mode group drawn from refusal evidence — always has a `tool` and an
 *  `owner`, and a `normalized_text` that is empty exactly when every grouped event recorded no
 *  refusal text at all (`coalesce(e.refusal, '')`), which is the signal discover.ts reads to
 *  decide a group is one the deterministic pass cannot describe on its own. */
export interface RefusalGroup {
  readonly kind: "refusal";
  readonly tool: string;
  readonly normalized_text: string;
  readonly owner: string;
  readonly count: number;
  /** Up to 5 real `zz.event.id` values behind this group, oldest-called-first — the evidence a
   *  candidate's `evidence_refs` points back at. */
  readonly sample_event_ids: string[];
  /** Up to 3 distinct RAW (un-normalised) refusal texts behind this group — what a
   *  generative-critic call reads when `normalized_text` itself is empty. */
  readonly sample_raw_texts: string[];
}

/** One deterministic failure-mode group drawn from a stage-return pattern — always labelable
 *  deterministically, because `from_step`/`back_to_step` are names the manifest already gives
 *  meaning to; discover.ts never sends one of these to the generative critic. */
export interface ReturnGroup {
  readonly kind: "return";
  readonly from_step: string;
  readonly back_to_step: string;
  readonly count: number;
  /** Up to 5 distinct initiative slugs this pattern was seen in. */
  readonly sample_initiatives: string[];
}

/** The refusal-evidence groups for one plugin version's window, deterministic and ungraded —
 *  ordered most-frequent-first so a caller that caps how many groups it turns into candidates
 *  keeps the ones with the most evidence behind them. */
export async function refusalGroups(
  pool: pg.Pool, plugin: string, version: string, servesOwnDoor: boolean, window: EvidenceWindow,
): Promise<RefusalGroup[]> {
  const rows = (await pool.query<{
    tool: string; normalized: string; owner: string; n: string;
    sample_ids: string[] | null; sample_raw: string[] | null;
  }>(`
    select coalesce(e.tool_key, e.subject) as tool,
           ${NORMALIZED_REFUSAL_SQL} as normalized,
           coalesce(e.refusal_owner, 'unattributed') as owner,
           count(*)::text as n,
           (array_agg(e.id::text order by e.ts))[1:5] as sample_ids,
           (array_agg(distinct coalesce(e.refusal, '')))[1:3] as sample_raw
      ${toolCallEvents(servesOwnDoor)}
        and e.ok is false
     group by 1, 2, 3
     order by count(*) desc
     limit 50`,
    [plugin, version, window.from, window.to])).rows;
  return foldByRule(rows.map((r) => ({
    kind: "refusal" as const,
    tool: r.tool,
    normalized_text: r.normalized,
    owner: r.owner,
    count: Number(r.n),
    sample_event_ids: r.sample_ids ?? [],
    sample_raw_texts: r.sample_raw ?? [],
  })));
}

/** Grammatical number, folded to one form: the same refusal says "supports … was added" for one
 *  file and "support … were added" for two. Only these pairs — a rule is otherwise its words. */
const NUMBER: readonly [RegExp, string][] = [
  [/\bsupports\b/g, "support"], [/\bwere\b/g, "was"], [/\bare\b/g, "is"], [/\bthey\b/g, "it"],
  [/\bthem\b/g, "it"], [/\bthese\b/g, "this"], [/\bthose\b/g, "that"], [/\bhave\b/g, "has"],
];

/** The rule a normalised refusal states, with the files it happened to name folded out. The
 *  normalised text still carries paths and document names, so one refusal family — "a source
 *  added after the version you are replacing must be cited" — arrived as one candidate per
 *  document it named (spec.md, plan.md) and per count of sources. A token with a `/` in it, or
 *  a name with a file extension, is a file; a list of files is one. */
export function refusalRule(normalized: string): string {
  let rule = foldFiles(normalized);
  for (const [from, to] of NUMBER) rule = rule.replace(from, () => to);
  return rule;
}

/** The refusal with its files folded out and its grammar left alone — what a candidate's
 *  description says and the owner-kind evaluator reads. `refusalRule` is only the merge key. */
function foldFiles(normalized: string): string {
  const folded = normalized.split(/(\s+)/).map((tok) => {
    const m = /^([`'"(]*)(.*?)([`'"),.;:]*)$/.exec(tok);
    if (!m || !m[2]) return tok;
    const core = m[2];
    return core.includes("/") || /^[\w<>#-]+\.(md|json|ya?ml|ts|js|txt)$/.test(core) ? `${m[1]}<file>${m[3]}` : tok;
  }).join("");
  return folded.replace(/<file>(?:,\s*<file>)*(?:,?\s+and\s+<file>)?/g, "<file>");
}

/** One group per (tool, rule, owner): the rows `refusalRule` says state the same rule are one
 *  failure mode, their counts summed and their samples pooled. Most frequent first, as before. */
export function foldByRule(groups: readonly RefusalGroup[]): RefusalGroup[] {
  const byKey = new Map<string, RefusalGroup & { sample_event_ids: string[]; sample_raw_texts: string[] }>();
  for (const g of groups) {
    const rule = refusalRule(g.normalized_text);
    const key = `${g.tool}\u0000${rule}\u0000${g.owner}`;
    const had = byKey.get(key);
    if (!had) {
      byKey.set(key, { ...g, normalized_text: foldFiles(g.normalized_text), sample_event_ids: [...g.sample_event_ids],
                       sample_raw_texts: [...g.sample_raw_texts] });
      continue;
    }
    byKey.set(key, {
      ...had, count: had.count + g.count,
      sample_event_ids: [...new Set([...had.sample_event_ids, ...g.sample_event_ids])].slice(0, 5),
      sample_raw_texts: [...new Set([...had.sample_raw_texts, ...g.sample_raw_texts])].slice(0, 3),
    });
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count);
}

/** The total tool-call population `refusalGroups`' own denominators are a share of — the exact
 *  same event population `pluginTraces`' `use` rows are aggregated over (`toolCallEvents`), so
 *  the caller never reports a prevalence against a population the grouping query itself did not
 *  draw from. */
export async function totalToolCallEvents(
  pool: pg.Pool, plugin: string, version: string, servesOwnDoor: boolean, window: EvidenceWindow,
): Promise<number> {
  const row = (await pool.query<{ n: string }>(`
    select count(*)::text as n ${toolCallEvents(servesOwnDoor)}`,
    [plugin, version, window.from, window.to])).rows[0];
  return Number(row?.n ?? 0);
}

/** `pluginTraces`' own return type, read structurally rather than restated — the same technique
 *  observe.ts uses for the same reason: `PluginTraces` is not exported and this file has no
 *  business defining a second copy of its shape. */
type Traces = Awaited<ReturnType<typeof pluginTraces>>;

interface MutableReturnGroup {
  from_step: string; back_to_step: string; count: number; initiatives: Set<string>;
}

/** Folds `pluginTraces`' own `returns` array (one row per revisit) into one group per
 *  (from_step, back_to_step) pair — pure, in memory, because `pluginTraces` already ran the
 *  query and paid for the join; this only aggregates what it returned. */
export function returnGroups(returns: Traces["returns"]): ReturnGroup[] {
  const byKey = new Map<string, MutableReturnGroup>();
  for (const r of returns) {
    const key = `${r.from_step}\u0000${r.back_to_step}`;
    let g = byKey.get(key);
    if (!g) {
      g = { from_step: r.from_step, back_to_step: r.back_to_step, count: 0, initiatives: new Set() };
      byKey.set(key, g);
    }
    g.count += 1;
    if (g.initiatives.size < 5) g.initiatives.add(r.initiative);
  }
  return [...byKey.values()]
    .map((g): ReturnGroup => ({
      kind: "return", from_step: g.from_step, back_to_step: g.back_to_step, count: g.count,
      sample_initiatives: [...g.initiatives],
    }))
    .sort((a, b) => b.count - a.count);
}

/** The total step-visit population `returnGroups`' own denominators are a share of — identical
 *  to observe.ts's own `stage_return_rate` denominator, so DISCOVER's prevalence for a return
 *  pattern and OBSERVE's aggregate return rate read against the same whole. */
export function totalStepVisits(stagePaths: Traces["stage_paths"]): number {
  return stagePaths.reduce((sum, p) => sum + p.steps.length, 0);
}
