/**
 * OBSERVE (FR-8, Task I-7): the pre-protocol immutable evidence snapshot. `plugin_profile` binds
 * one `subject_version_id` (from `plugin_locate`/`plugin_register`) to a resolved window of real
 * runs and writes exactly one immutable `zz.eval_observation_snapshot` row — never updated, so
 * DISCOVER (a later task) and EVALUATE can bind a stable evidence reference without racing this
 * call, and the same release observed a second time (a different window, a different deployed
 * environment) produces a second snapshot on the same subject rather than overwriting the first.
 *
 * FIXED (was DELIBERATE, migration 001 — fix dispatch on I-29's own follow-on): the row used to
 * store no facts, only the digest over them (`evidence_digest`) — so a deterministic/outcome
 * measure could read only whichever two facts a caller also happened to pass as raw columns.
 * `facts` (001) now stores the whole computed map, keyed by `OBSERVATION_FACT_KEYS`
 * (observe-facts.ts), so a measure can read any of them by dotted `definition.factPath`
 * (evaluate-measures.ts). The digest and the replay-recomputation behaviour are unchanged: a
 * replay of an idempotent call still recomputes the facts fresh, over the row's own stored
 * (resolved) window, and reports whether that recomputation still hashes to what was stored —
 * surfacing drift rather than silently serving whatever the facts happen to be today under the
 * old id.
 *
 * Every fact below is `{numerator, denominator, value, coverage}` or `{value: null, reason}` —
 * never a bare 0 for a population with nothing in it. The heavier queries live in
 * observe-facts.ts, kept separate to stay under this repository's 700-line ceiling.
 */
import { createHash } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseCaller } from "@zz/contracts";
import { requestHeaders, serviceVersion, text } from "@zz/mcp-http";
import type pg from "pg";
import { z } from "zod";

import { entryOf, servesOwnDoor, toolsNamedBy } from "./plugin-eval.js";
import {
  latencyAndByteFacts, outcomeAndApprovalFacts, refusalDetail, tokenAndCostFacts,
  rate, type ObservedFact,
} from "./observe-facts.js";
import {
  pluginTraces, unboundedRunsClause, type EvidenceWindow,
} from "./plugin-profile.js";
import { withIdempotency, canonicalJson, type IdempotencyOutcome, type MutatorOutcome } from "./idempotency.js";
import { recordStage } from "./stage-record.js";
import { logActivity } from "../persist.js";
import { userRoot } from "../paths.js";
import { Refusal } from "../refusal.js";
import { db } from "../platform-db.js";

const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const noDb = () => text("ERROR: this deployment has no platform database, so no observation can be recorded");
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The subject a `subject_version_id` names, or null for one nothing minted — checked BEFORE
 *  `withIdempotency` so a refused call writes no ledger row (the same order `plugin_locate`
 *  uses). A malformed uuid is refused the same way a well-formed but unknown one is: `::uuid`
 *  on garbage throws Postgres error 22P02, which is not this contract's refusal text. */
async function resolveSubject(
  pool: pg.Pool, subjectVersionId: string,
): Promise<{ plugin: string; declaredVersion: string } | null> {
  if (!UUID_RE.test(subjectVersionId)) return null;
  const row = (await pool.query<{ plugin: string; declared_version: string }>(`
    select p.name as plugin, sv.declared_version
      from zz.eval_subject_version sv
      join zz.plugin p on p.id = sv.plugin_id
     where sv.id = $1::uuid`, [subjectVersionId])).rows[0];
  return row ? { plugin: row.plugin, declaredVersion: row.declared_version } : null;
}

type EvidenceWindowInput = { from: string; to: string } | { last_runs: number };

/** `{from, to}` is already resolved. `{last_runs: n}` is resolved here, against every run this
 *  window's population has EVER produced (`unboundedRunsClause` — no window to bound by yet) —
 *  the caller's most recent `n`, spanning from the OLDEST of those runs' `started_at` to the
 *  YOUNGEST run's own end — never its `started_at`. A run's events happen AFTER it starts, so a
 *  window bounded by `max(started_at)` alone clips the very events the most recent run in the
 *  window exists to include; verified against real seeded rows during this task (a run's events
 *  one and two minutes after its own `started_at` were silently dropped before this fix). A run
 *  still open (`ended_at is null`) bounds by `now()`, so an in-progress run's events so far are
 *  still admitted rather than excluded for having no recorded end yet.
 *
 *  No run matches: an explicit empty range (`from` after `to`), so `between` downstream matches
 *  nothing and `pluginTraces` reports `runs: 0` with its own named reason, rather than this
 *  function inventing a window that happens to be wide enough to catch something else. */
async function resolveWindow(
  pool: pg.Pool, plugin: string, version: string, serves: boolean, input: EvidenceWindowInput,
): Promise<EvidenceWindow> {
  if ("from" in input) return { from: input.from, to: input.to };
  const row = (await pool.query<{ from: string | null; to: string | null }>(`
    select min(started_at)::text as from, max(coalesce(ended_at, now()))::text as to
      from (select r.started_at, r.ended_at ${unboundedRunsClause(serves)}
             order by r.started_at desc limit $3) r`,
    [plugin, version, input.last_runs])).rows[0];
  if (!row?.from || !row?.to) return { from: "infinity", to: "-infinity" };
  return { from: row.from, to: row.to };
}

interface Observation {
  traces: Awaited<ReturnType<typeof pluginTraces>>;
  facts: Record<string, ObservedFact>;
  coverageSurface: { observed: number; total: number };
  runtimeIdentity: { service_versions: Record<string, string>; models: string[] };
}

/** Everything OBSERVE computes for one subject over one resolved window — called once for a
 *  fresh write, and again (over the row's own stored window) to answer a replay, so a replay's
 *  response is never a copy of the fresh path's in-memory result but an honest recomputation. */
async function computeObservation(
  pool: pg.Pool, plugin: string, version: string, window: EvidenceWindow,
): Promise<Observation> {
  const entry = entryOf(plugin);
  const stages: string[] = (entry?.manifest.stages ?? []).map((s) => s.name);
  const reachable = toolsNamedBy(plugin);
  const serves = servesOwnDoor(plugin);

  const traces = await pluginTraces(pool, plugin, version, reachable, stages, serves, window);
  const writesDocuments = traces.record !== null;

  const [latencyBytes, outcomes, tokens, detail, models] = await Promise.all([
    latencyAndByteFacts(pool, plugin, version, serves, window),
    outcomeAndApprovalFacts(pool, plugin, writesDocuments, window),
    tokenAndCostFacts(pool, plugin, version, window),
    refusalDetail(pool, plugin, version, serves, window),
    pool.query<{ model: string }>(`
      select distinct mc.model
        from zz.model_call mc join zz.event e on e.id = mc.event_id
       where mc.plugin = $1 and mc.ts between $2 and $3
         and (e.team_slug is null or e.team_slug not like 'replay-%')
       order by mc.model`, [plugin, window.from, window.to]),
  ]);

  const totalCalls = traces.use.reduce((s, u) => s + u.calls, 0);
  const totalRefusals = traces.use.reduce((s, u) => s + u.refusals, 0);
  const totalGuardrail = traces.use.reduce((s, u) => s + u.guardrail, 0);
  const totalOurs = traces.use.reduce((s, u) => s + u.ours, 0);
  const totalTheirs = traces.use.reduce((s, u) => s + u.theirs, 0);
  const attributedRefusals = totalGuardrail + totalOurs + totalTheirs;
  const totalStepVisits = traces.stage_paths.reduce((s, p) => s + p.steps.length, 0);
  const totalUnplaced = traces.unplaced.reduce((s, u) => s + u.count, 0);
  const called = new Set(traces.use.map((u) => u.tool.split(":").pop() ?? u.tool));

  const noEvents = "no event is recorded for this subject in this window";
  const noSteps = "no run in this window recorded a step";
  const noCalls = "no tool call is recorded for this subject in this window";
  const noRefusals = "no refusal is recorded for this subject in this window";

  const facts: Record<string, ObservedFact> = {
    // The two facts this measure system read as special-cased raw columns before `facts` existed —
    // folded into the same `facts` map every other entry lives in, by `OBSERVATION_FACT_KEYS`'s
    // own two names, so a deterministic measure's `definition.factPath` addresses them exactly
    // the way it addresses every other fact. `usable_run_count`/`total_run_count` and
    // `coverage.surface` stay on the row as their own columns too (evaluation_score's own
    // coverage-floor check reads the raw counts, not a rate) — this is the SAME numbers, read a
    // second way, never a second computation.
    usable_run_coverage: rate(traces.usable_runs, traces.runs, traces.usable_runs, traces.runs, noEvents),
    tool_coverage: rate(called.size, reachable.length, called.size, reachable.length,
      "this plugin's skills name no tool this scan can check reachability for"),
    stage_return_rate: rate(traces.returns.length, totalStepVisits,
      traces.coverage.with_step, traces.coverage.events, noSteps),
    unplaced_step_rate: rate(totalUnplaced, totalStepVisits,
      traces.coverage.with_step, traces.coverage.events, noSteps),
    tool_call_volume: rate(totalCalls, traces.coverage.events,
      totalCalls, traces.coverage.events, noEvents),
    tool_refusal_rate: { ...rate(totalRefusals, totalCalls, totalCalls, totalCalls, noCalls), detail },
    dependency_failure_rate: rate(totalTheirs, totalRefusals,
      attributedRefusals, totalRefusals, noRefusals),
    never_called_rate: rate(traces.never_called.length, reachable.length,
      reachable.length, reachable.length,
      "this plugin's skills name no tool this scan can check reachability for"),
    ...latencyBytes,
    ...outcomes,
    ...tokens,
  };

  return {
    traces, facts,
    coverageSurface: { observed: called.size, total: reachable.length },
    runtimeIdentity: {
      service_versions: { "zz-core": serviceVersion(import.meta.url) },
      models: models.rows.map((r) => r.model),
    },
  };
}

/** The response shape, built once for a fresh write and once (with the drift fields added) for
 *  a replay — so the two paths cannot silently disagree about what a snapshot's response looks
 *  like. */
function respond(
  id: string, plugin: string, declaredVersion: string, window: EvidenceWindow,
  observation: Observation, drift?: { stored_evidence_digest: string; drifted: boolean },
) {
  const evidenceDigest = sha256(canonicalJson(observation.facts));
  return {
    observation_snapshot_id: id,
    plugin, declared_version: declaredVersion,
    window,
    usable_run_count: observation.traces.usable_runs,
    total_run_count: observation.traces.runs,
    coverage: { surface: observation.coverageSurface },
    facts: observation.facts,
    environment_digest: sha256(canonicalJson(observation.runtimeIdentity)),
    evidence_digest: evidenceDigest,
    // Extra context beyond the contract's own fields — the raw traces this snapshot's facts
    // were rolled up from, for a reader (or DISCOVER, later) that wants the detail rather than
    // the summary.
    traces: observation.traces,
    sufficient_for_judging: observation.traces.sufficient,
    ...(drift ? {
      replayed: true,
      evidence_digest_stored: drift.stored_evidence_digest,
      evidence_digest_drifted: drift.drifted,
      drift_note: drift.drifted
        ? "this replay recomputed the facts over the snapshot's own stored window and got a " +
          "different digest than what was recorded — the underlying event log moved (a " +
          "correction, a deletion) since the snapshot was written; the snapshot row itself is " +
          "unchanged, this response reports the live recomputation"
        : undefined,
    } : {}),
  };
}

export function registerObserveTools(server: McpServer): void {
  server.registerTool(
    "plugin_profile",
    {
      description:
        "WHEN a subject (from plugin_locate/plugin_register) needs its pre-protocol evidence " +
        "computed: OBSERVE. Builds deterministic production facts — outcomes, stage paths and " +
        "returns, tool calls, refusals (normalised text and dependency owner), latency " +
        "p50/p90, request/response bytes, document approvals/revisions, never-called tools, " +
        "tokens/cost where recorded, dependency failures — every count and rate carrying " +
        "numerator, denominator and coverage, a missing input `null` with a named reason and " +
        "never 0. RETURNS an immutable observation_snapshot_id with no protocol required. A " +
        "mutator: it writes exactly one zz.eval_observation_snapshot row through the FR-59 " +
        "idempotency ledger, so a retried call with the same idempotency_key replays rather " +
        "than minting a second row (the same subject observed under a different window or a " +
        "different deployed environment DOES mint a second snapshot — that is a different " +
        "observation, not a retry). REFUSES a subject_version_id nothing minted.",
      inputSchema: {
        subject_version_id: z.string(),
        evidence_window: z.union([
          z.object({ from: z.string(), to: z.string() }),
          z.object({ last_runs: z.number().int().positive() }),
        ]),
        idempotency_key: z.string().min(1),
        initiative: z.string().optional().describe(
          "The initiative this evaluation runs in: records observation_snapshot_id as its OBSERVE record, " +
          "which initiative_status hands to a stage started in a new conversation."),
      },
    },
    async ({ subject_version_id, evidence_window, idempotency_key, initiative }) => {
      const pool = db();
      if (!pool) return noDb();

      const subject = await resolveSubject(pool, subject_version_id);
      if (!subject) throw new Refusal("ERROR: unknown subject_version_id");
      const { plugin, declaredVersion } = subject;

      const serves = servesOwnDoor(plugin);
      const window = await resolveWindow(pool, plugin, declaredVersion, serves, evidence_window);
      const observation = await computeObservation(pool, plugin, declaredVersion, window);

      const principal = parseCaller(requestHeaders()).email;
      const outcome: IdempotencyOutcome<{ id: string }> = await withIdempotency(
        principal, "plugin_profile", idempotency_key, { subject_version_id, evidence_window },
        async (client): Promise<MutatorOutcome<{ id: string }>> => {
          const row = (await client.query<{ id: string }>(`
            insert into zz.eval_observation_snapshot
              (subject_version_id, production_window, coverage, usable_run_count, total_run_count,
               runtime_identity, environment_digest, evidence_digest, facts, created_at)
            values ($1::uuid, $2::jsonb, $3::jsonb, $4, $5, $6::jsonb, $7, $8, $9::jsonb, now())
            returning id::text as id`,
            [subject_version_id,
             JSON.stringify({ requested: evidence_window, resolved: window }),
             JSON.stringify({ surface: observation.coverageSurface }),
             observation.traces.usable_runs, observation.traces.runs,
             JSON.stringify(observation.runtimeIdentity),
             sha256(canonicalJson(observation.runtimeIdentity)),
             sha256(canonicalJson(observation.facts)),
             JSON.stringify(observation.facts)])).rows[0];
          return { result: { id: row.id }, result_table: "zz.eval_observation_snapshot", result_id: row.id };
        },
      );

      if (!outcome.replayed) {
        logActivity(await userRoot(), null,
          { user: principal, action: "plugin_profile", plugin, version: declaredVersion,
            observation_snapshot_id: outcome.result.id, replayed: false });
        const recorded = await recordStage(initiative, "zz-plugin-observe",
          { subject_version_id, observation_snapshot_id: outcome.result.id });
        return json({ ...respond(outcome.result.id, plugin, declaredVersion, window, observation), ...recorded });
      }

      // Replay: recompute over the ROW'S OWN stored window, not necessarily this call's — a
      // `last_runs: n` request resolves against whatever runs exist at call time, so a replay
      // years later must recompute against what was actually observed then, read back from
      // `production_window.resolved`, never re-resolved.
      const stored = (await pool.query<{
        id: string; production_window: { resolved: EvidenceWindow }; evidence_digest: string;
      }>(`
        select id::text as id, production_window, evidence_digest
          from zz.eval_observation_snapshot where id = $1::uuid`,
        [outcome.result_id])).rows[0];
      if (!stored) {
        throw new Refusal("ERROR: idempotency ledger points at an observation snapshot this call cannot read back");
      }
      const storedWindow = stored.production_window.resolved;
      const recomputed = await computeObservation(pool, plugin, declaredVersion, storedWindow);
      const freshDigest = sha256(canonicalJson(recomputed.facts));
      logActivity(await userRoot(), null,
        { user: principal, action: "plugin_profile", plugin, version: declaredVersion,
          observation_snapshot_id: stored.id, replayed: true,
          evidence_digest_drifted: freshDigest !== stored.evidence_digest });
      const recorded = await recordStage(initiative, "zz-plugin-observe",
        { subject_version_id, observation_snapshot_id: stored.id });
      return json({ ...respond(stored.id, plugin, declaredVersion, storedWindow, recomputed,
        { stored_evidence_digest: stored.evidence_digest, drifted: freshDigest !== stored.evidence_digest }), ...recorded });
    },
  );
}
