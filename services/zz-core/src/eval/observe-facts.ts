/**
 * The facts `plugin_profile` (observe.ts, Task I-7) adds beyond what `pluginTraces` already
 * counts: outcomes, document approvals, latency, request/response bytes, refusal text/owner
 * detail, and tokens/cost. Kept out of observe.ts to stay under this repository's 700-line
 * ceiling, and out of plugin-profile.ts because these queries have no reader outside OBSERVE.
 *
 * DELIBERATE: every exported function returns `ObservedFact` values — `{numerator, denominator,
 * value, coverage}` for a non-empty population, `{value: null, reason}` for an empty one — and
 * never a bare `0` standing in for "nothing to measure". That is this task's own rule (the plan's
 * "missing inputs are null with a reason, never 0"), so it is enforced once, in `rate()` and
 * `measured()` below, rather than at each call site.
 */
import type pg from "pg";

import { toolCallEvents, type EvidenceWindow } from "./plugin-profile.js";

/** Every fact key `plugin_profile` (observe.ts) writes into `zz.eval_observation_snapshot.facts`
 *  (001, fix dispatch on I-29's own follow-on) — the canonical list `protocol-record.ts`
 *  refuses a deterministic/outcome measure's `definition.factPath` against (its first dotted
 *  segment must name one of these) and `evaluate-measures.ts` reads one entry of by that same
 *  path. `usable_run_coverage`/`tool_coverage` are computed directly in observe.ts's own
 *  `computeObservation` (from `traces.usable_runs`/`traces.runs` and the tool-coverage count), not
 *  by a function in this file — still listed here because this file is the facts registry, not
 *  because this file computes them. The other sixteen are this file's own exported functions'
 *  keys, plus the six observe.ts derives straight from `pluginTraces`. Keep this list and
 *  `computeObservation`'s own `facts` object literal in lockstep — `checks/eval-fact-path.ts` is
 *  pure (no database) and cannot see a live drift between the two; only a real `plugin_profile`
 *  call, whose `facts` keys are compared against this list, catches that. */
export const OBSERVATION_FACT_KEYS = [
  "usable_run_coverage", "tool_coverage",
  "stage_return_rate", "unplaced_step_rate", "tool_call_volume", "tool_refusal_rate",
  "dependency_failure_rate", "never_called_rate",
  "latency_p50_ms", "latency_p90_ms", "request_bytes_avg", "response_bytes_avg",
  "outcome_delivered_rate", "outcome_accepted_rate", "outcome_abandoned_rate", "doc_approval_rate",
  "doc_deferral_rate",
  "tokens_per_model_call_avg", "cost_per_model_call_avg",
] as const;

export interface Fact {
  readonly numerator: number;
  readonly denominator: number;
  readonly value: number;
  readonly coverage: { readonly observed: number; readonly total: number };
  /** A breakdown a reader needs beside the headline number — the refusal-text/owner buckets a
   *  single rate cannot carry. Only `tool_refusal_rate` sets it. */
  readonly detail?: unknown;
}
interface MissingFact {
  readonly value: null;
  readonly reason: string;
  /** Set only by `tool_refusal_rate`, whichever shape it takes — see `Fact.detail`. */
  readonly detail?: unknown;
}
export type ObservedFact = Fact | MissingFact;

/** A fact whose `value` IS numerator/denominator — a share, a rate. Exported: observe.ts builds
 *  a few facts (returns, never-called, dependency failures) directly from `pluginTraces`' own
 *  arrays rather than a fresh query, and goes through the same null-not-zero guard. */
export function rate(numerator: number, denominator: number, observed: number, total: number, reason: string): ObservedFact {
  if (denominator === 0) return { value: null, reason };
  return { numerator, denominator, value: numerator / denominator, coverage: { observed, total } };
}

/** A fact whose `value` is a measured quantity (a percentile, an average) rather than
 *  numerator/denominator itself — `numerator` is how many rows in the population actually
 *  carried the measurement, `denominator` is the population it was drawn from, so a reader can
 *  still see how much of the window backs the number even though the number itself is not their
 *  ratio. */
export function measured(value: number | null, carrying: number, population: number, reason: string): ObservedFact {
  if (population === 0 || value === null) return { value: null, reason };
  return { numerator: carrying, denominator: population, value, coverage: { observed: carrying, total: population } };
}

const N = (v: string | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));
const F = (v: string | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

/** Latency (p50/p90) and request/response byte averages, over the exact event population `use`
 *  was aggregated over (`toolCallEvents`) — same window, same denominator
 *  as every figure `pluginTraces` already reports. */
export async function latencyAndByteFacts(
  pool: pg.Pool, plugin: string, version: string, servesOwnDoor: boolean, window: EvidenceWindow,
): Promise<Record<string, ObservedFact>> {
  const row = (await pool.query<{
    total: string; with_duration: string; p50: string | null; p90: string | null;
    with_req_bytes: string; avg_req_bytes: string | null;
    with_resp_bytes: string; avg_resp_bytes: string | null;
  }>(`
    select count(*)::text as total,
           count(e.duration_ms)::text as with_duration,
           percentile_cont(0.5) within group (order by e.duration_ms)::text as p50,
           percentile_cont(0.9) within group (order by e.duration_ms)::text as p90,
           count(e.request_bytes)::text as with_req_bytes,
           avg(e.request_bytes)::text as avg_req_bytes,
           count(e.response_bytes)::text as with_resp_bytes,
           avg(e.response_bytes)::text as avg_resp_bytes
      ${toolCallEvents(servesOwnDoor)}`,
    [plugin, version, window.from, window.to])).rows[0];

  const total = N(row?.total);
  const noRows = "no tool-call event is recorded for this plugin in this window";
  return {
    latency_p50_ms: measured(F(row?.p50), N(row?.with_duration), total,
      total === 0 ? noRows : "no tool-call event in this window recorded a duration"),
    latency_p90_ms: measured(F(row?.p90), N(row?.with_duration), total,
      total === 0 ? noRows : "no tool-call event in this window recorded a duration"),
    request_bytes_avg: measured(F(row?.avg_req_bytes), N(row?.with_req_bytes), total,
      total === 0 ? noRows : "no tool-call event in this window recorded a request size"),
    response_bytes_avg: measured(F(row?.avg_resp_bytes), N(row?.with_resp_bytes), total,
      total === 0 ? noRows : "no tool-call event in this window recorded a response size"),
  };
}

/** Lower-cased, with a UUID or a digit run folded to `#` — the one normalisation both this
 *  module's `refusalDetail` and `discover.ts`'s deterministic grouping (Task I-9) apply to
 *  `zz.event.refusal`, so two rows that differ only by which run's UUID or which retry count
 *  they happened to carry still fold into one text. Exported so DISCOVER's own query, which
 *  additionally needs the failing tool and the event id neither `refusalDetail` nor its shape
 *  carries, computes the identical string rather than a second, drifting copy of this regex. */
export const NORMALIZED_REFUSAL_SQL = `lower(regexp_replace(
             regexp_replace(coalesce(e.refusal, ''),
               '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '#', 'gi'),
             '[0-9]+', '#', 'g'))`;

/** The top refusal texts, normalised (lower-cased; UUIDs and digit runs folded to `#`) and
 *  grouped with their `refusal_owner` — the detail the AC's "refusals with normalised text and
 *  dependency owner" asks for. Aggregate rates (refusal rate, dependency-failure rate) are built
 *  by the caller from `pluginTraces`' own `use` rows, which already carry calls/refusals/owner
 *  counts; this is only the text breakdown those rows cannot carry. */
export async function refusalDetail(
  pool: pg.Pool, plugin: string, version: string, servesOwnDoor: boolean, window: EvidenceWindow,
): Promise<{ text: string; owner: string; count: number }[]> {
  const rows = (await pool.query<{ normalized: string; owner: string; n: string }>(`
    select ${NORMALIZED_REFUSAL_SQL} as normalized,
           coalesce(e.refusal_owner, 'unattributed') as owner,
           count(*)::text as n
      ${toolCallEvents(servesOwnDoor)}
        and e.ok is false
     group by 1, 2
     order by count(*) desc
     limit 20`,
    [plugin, version, window.from, window.to])).rows;
  return rows.map((r) => ({ text: r.normalized, owner: r.owner, count: Number(r.n) }));
}

/** Wording that defers a document's meaning to somewhere a reader cannot follow. A fact, not a
 *  judge: sdlc's text judge could not tell "the stakeholder settled these decisions" (stated) from
 *  "as agreed on the call" (deferred), and this pattern can. */
const DEFERRAL = String.raw`(\yas (agreed|discussed)\y|\yper (the|our) (call|meeting|chat|conversation)\y|\ysee the (chat|thread|call|ticket)\y|\y(agreed|discussed|decided) (on|in|during) the (call|meeting|chat)\y|\yTBD\y)`;

/** Initiative outcomes and document approvals, scoped to the initiatives this plugin's own door
 *  traffic touched in this window — never the whole platform's `zz.doc` table, which would make
 *  these facts a statement about the install rather than about the subject and window observed.
 *
 *  An outcome belongs to an initiative, not to a document: `initiative_close` stamps it on the
 *  one agreement document of a closed initiative. So each outcome rate is over the touched
 *  initiatives that closed, and its coverage is how many of the touched initiatives closed at
 *  all. Divided by every document instead, one accepted close among 284 documents read as an
 *  acceptance rate of 0.0035. Approvals are a property of gated documents and stay per document.
 *
 *  `null` for a plugin that wrote no document in this window: a door that was merely read from,
 *  or a window with no matching traffic at all. A flow's documents are written by its runs'
 *  calls, so a flow has outcomes — the effectiveness a flow exists for. */
export async function outcomeAndApprovalFacts(
  pool: pg.Pool, plugin: string, version: string, servesOwnDoor: boolean, writesDocuments: boolean,
  window: EvidenceWindow,
): Promise<Record<string, ObservedFact>> {
  const noDocs = writesDocuments
    ? "no document in the initiatives this window's calls touched is live (or none was found)"
    : "this plugin wrote no document in this window — outcomes and approvals do not apply";
  if (!writesDocuments) {
    return {
      outcome_delivered_rate: { value: null, reason: noDocs },
      outcome_accepted_rate: { value: null, reason: noDocs },
      outcome_abandoned_rate: { value: null, reason: noDocs },
      doc_approval_rate: { value: null, reason: noDocs },
      doc_deferral_rate: { value: null, reason: noDocs },
    };
  }
  const row = (await pool.query<{
    initiatives: string; closed: string; delivered: string; accepted: string; abandoned: string;
    documents: string; approved: string; deferring: string;
  }>(`
    -- The initiatives this subject's own calls touched: a door's calls, or the calls inside a
    -- flow's runs — the same population every other fact here is drawn from (toolCallEvents).
    with touched as (
      select distinct e.team_slug, e.initiative ${toolCallEvents(servesOwnDoor)}
         and e.initiative is not null and e.initiative <> ''
    ),
    live as (select d.* from zz.doc d
               join touched t on t.team_slug = d.team_slug and t.initiative = d.initiative
              where d.path not like '\\_versions/%'),
    closes as (select team_slug, initiative, min(outcome) as outcome
                 from live where outcome is not null group by team_slug, initiative)
    select (select count(*) from (select distinct team_slug, initiative from live) i)::text as initiatives,
           (select count(*) from closes)::text as closed,
           (select count(*) from closes where outcome = 'delivered')::text as delivered,
           (select count(*) from closes where outcome = 'accepted')::text as accepted,
           (select count(*) from closes where outcome = 'abandoned')::text as abandoned,
           -- Gated documents only — the ones a flow puts a status on. Sources and free documents
           -- are never approved by design; counted in, 259 sources put sdlc at 13 of 291.
           (select count(*) from live where status <> '')::text as documents,
           (select count(*) from live where status <> '' and approved_by is not null)::text as approved,
           -- A gated document that sends its reader somewhere else for what it means: to a
           -- conversation, a meeting, a thread, or to later. Read whole, across every team's
           -- documents in the window — a text judge could read one team's, 24,000 characters at a time.
           (select count(*) from live where status <> '' and body ~* '${DEFERRAL}')::text as deferring`,
    [plugin, version, window.from, window.to])).rows[0];

  const initiatives = N(row?.initiatives);
  const closed = N(row?.closed);
  const documents = N(row?.documents);
  const noClose = initiatives
    ? `none of the ${initiatives} initiative(s) this window touched has closed — no outcome is recorded yet`
    : noDocs;
  return {
    outcome_delivered_rate: rate(N(row?.delivered), closed, closed, initiatives, noClose),
    outcome_accepted_rate: rate(N(row?.accepted), closed, closed, initiatives, noClose),
    outcome_abandoned_rate: rate(N(row?.abandoned), closed, closed, initiatives, noClose),
    doc_approval_rate: rate(N(row?.approved), documents, documents, documents, noDocs),
    doc_deferral_rate: rate(N(row?.deferring), documents, documents, documents, noDocs),
  };
}

/** Model-call tokens for this plugin VERSION in this window. Cost has no column anywhere on
 *  this platform's schema — `zz.model_call` carries token counts and not a price — so it is
 *  reported as missing with a named reason rather than left out of the facts map entirely (the
 *  plan's "missing inputs are null with a reason" applies to a fact nothing records, not only to
 *  one whose population happens to be empty).
 *
 * `zz.model_call` itself carries no version column — only `plugin` — so the join to `zz.event`
 * is load-bearing: without `e.plugin_version = $2`, a second
 * subject_version_id for the SAME plugin name (a different declared version, still in the same
 * window) would silently attribute the first version's token usage to itself. A model call this
 * join cannot resolve to an event (should not happen — every model_call.event_id is written by
 * the same code path that writes the event) drops out rather than being guessed at. */
export async function tokenAndCostFacts(
  pool: pg.Pool, plugin: string, version: string, window: EvidenceWindow,
): Promise<Record<string, ObservedFact>> {
  const row = (await pool.query<{ calls: string; with_tokens: string; total_tokens: string | null }>(`
    select count(*)::text as calls,
           count(*) filter (where mc.input_tokens is not null or mc.output_tokens is not null)::text as with_tokens,
           sum(coalesce(mc.input_tokens, 0) + coalesce(mc.output_tokens, 0))::text as total_tokens
      from zz.model_call mc
      join zz.event e on e.id = mc.event_id
     where mc.plugin = $1 and e.plugin_version = $2
       and mc.ts between $3 and $4`,
    [plugin, version, window.from, window.to])).rows[0];

  const calls = N(row?.calls);
  const withTokens = N(row?.with_tokens);
  const totalTokens = F(row?.total_tokens);
  const avgTokens = withTokens > 0 && totalTokens !== null ? totalTokens / withTokens : null;
  return {
    tokens_per_model_call_avg: measured(avgTokens, withTokens, calls,
      calls === 0 ? "no model call is recorded for this plugin in this window" :
        "every model call in this window recorded no token count"),
    cost_per_model_call_avg: {
      value: null,
      reason: "no cost is recorded anywhere on this platform's schema — zz.model_call carries " +
        "token counts and not a price",
    },
  };
}
