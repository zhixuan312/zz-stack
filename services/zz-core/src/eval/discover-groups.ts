/**
 * The deterministic half of DISCOVER (Task I-9, FR-11): grouping real failures into candidate
 * failure modes before any model is asked anything. Kept out of discover.ts to stay under this
 * repository's 700-line ceiling — discover.ts is the tool, the evaluator and the model calls;
 * this is the SQL and the grouping arithmetic behind it.
 *
 * Two grouping passes, because the plan header names two evidence shapes and "prevalence" means
 * a different population for each:
 *   - REFUSAL groups: one (tool, normalised refusal text, owner) triple per group, over the
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
  return rows.map((r) => ({
    kind: "refusal" as const,
    tool: r.tool,
    normalized_text: r.normalized,
    owner: r.owner,
    count: Number(r.n),
    sample_event_ids: r.sample_ids ?? [],
    sample_raw_texts: r.sample_raw ?? [],
  }));
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
