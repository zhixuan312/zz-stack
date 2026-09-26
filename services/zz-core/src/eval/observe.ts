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
import { pluginForDoor } from "@zz/catalog";
import { parseCaller } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import type pg from "pg";
import { z } from "zod";

import { entryOf, helperSkillsOf, servesOwnDoor, toolsNamedBy } from "./plugin-eval.js";
import {
  latencyAndByteFacts, outcomeAndApprovalFacts, refusalDetail, tokenAndCostFacts,
  measured, rate, type ObservedFact,
} from "./observe-facts.js";
import {
  ownTools, pluginTraces, surfaceCoverage, unboundedRunsClause, versionsWithUse, type EvidenceWindow,
} from "./plugin-profile.js";
import { OWN_TOOLS } from "../door.js";
import { withIdempotency, canonicalJson, type IdempotencyOutcome, type MutatorOutcome } from "./idempotency.js";
import { recordStage } from "./stage-record.js";
import { logActivity } from "../persist.js";
import { userRoot } from "../paths.js";
import { PLATFORM_VERSION } from "../platform-version.js";
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

/** The tools this plugin's own door serves at `version`, and where that answer came from: the
 *  surface recorded for that release (zz.plugin_tool), else what this process registered for the
 *  door the plugin's manifest names, else null — a plugin with no door of its own, or a door
 *  nothing here recorded, whose skill-named tools then stand unnarrowed (`ownTools`). */
async function doorSurface(
  pool: pg.Pool, plugin: string, version: string, serves: boolean,
): Promise<{ tools: string[] | null; source: string }> {
  if (!serves) return { tools: null, source: "no door of its own: the tools its skills name" };
  const recorded = (await pool.query<{ name: string }>(`
    select pt.name from zz.plugin_tool pt
      join zz.plugin_version pv on pv.id = pt.plugin_version_id
      join zz.plugin p on p.id = pv.plugin_id
     where p.name = $1 and pv.version = $2`, [plugin, version])).rows.map((r) => r.name);
  if (recorded.length) return { tools: recorded, source: `zz.plugin_tool at ${version}` };
  // A version released before its door recorded a surface (/manage recorded none before 0.77.3):
  // the nearest recorded version's, named, rather than every tool its skills mention — which
  // counted /core's tools as zz-access's and as never called.
  const nearest = (await pool.query<{ version: string; names: string[] }>(`
    select pv.version, array_agg(pt.name order by pt.name) as names
      from zz.plugin_tool pt
      join zz.plugin_version pv on pv.id = pt.plugin_version_id
      join zz.plugin p on p.id = pv.plugin_id
     where p.name = $1 and pv.version ~ '^[0-9]+\\.[0-9]+\\.[0-9]+$' and $2 ~ '^[0-9]+\\.[0-9]+\\.[0-9]+$'
     group by pv.version
     -- the first recorded version at or after this one, else the newest before it
     order by (string_to_array(pv.version, '.')::int[] >= string_to_array($2, '.')::int[]) desc,
              case when string_to_array(pv.version, '.')::int[] >= string_to_array($2, '.')::int[]
                   then string_to_array(pv.version, '.')::int[] end asc,
              string_to_array(pv.version, '.')::int[] desc
     limit 1`, [plugin, version])).rows[0];
  if (nearest) return { tools: nearest.names, source: `zz.plugin_tool at ${nearest.version}, the nearest version that recorded one` };
  const registered = [...OWN_TOOLS].filter(([, door]) => pluginForDoor(door) === plugin).map(([name]) => name);
  if (registered.length) return { tools: registered, source: "this service's registered door (no surface recorded for this version)" };
  return { tools: null, source: "no surface recorded for this door: the tools its skills name, unnarrowed" };
}

interface Observation {
  traces: Awaited<ReturnType<typeof pluginTraces>>;
  facts: Record<string, ObservedFact>;
  coverageSurface: { observed: number; total: number; source: string };
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
  const serves = servesOwnDoor(plugin);
  const surface = await doorSurface(pool, plugin, version, serves);
  const reachable = ownTools(toolsNamedBy(plugin), surface.tools);

  const traces = await pluginTraces(pool, plugin, version, reachable, stages, serves, window, helperSkillsOf(plugin));
  // Whoever's calls wrote a document: a door's own record, or a flow's runs writing through the
  // baseline door. Read off `record` alone, every flow reported "wrote no document".
  const writesDocuments = traces.use.some((u) =>
    ["document_write", "document_patch", "document_revise"].includes(u.tool.split(":").pop() ?? ""));

  const [latencyBytes, outcomes, tokens, detail, models] = await Promise.all([
    latencyAndByteFacts(pool, plugin, version, serves, window),
    outcomeAndApprovalFacts(pool, plugin, version, serves, writesDocuments, window),
    tokenAndCostFacts(pool, plugin, version, window),
    refusalDetail(pool, plugin, version, serves, window),
    pool.query<{ model: string }>(`
      select distinct mc.model
        from zz.model_call mc
       where mc.plugin = $1 and mc.ts between $2 and $3
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
  const called = surfaceCoverage(traces.use.map((u) => u.tool), reachable);

  const noEvents = "no event is recorded for this subject in this window";
  const noSteps = "no run in this window recorded a step";
  const noCalls = "no tool call is recorded for this subject in this window";
  const noRefusals = "no refusal is recorded for this subject in this window";
  const noStages = "this plugin's manifest declares no stage order, so the steps its runs record " +
    "belong to the flows that called it and neither a return nor an unplaced step is defined";

  const facts: Record<string, ObservedFact> = {
    // The two facts this measure system read as special-cased raw columns before `facts` existed —
    // folded into the same `facts` map every other entry lives in, by `OBSERVATION_FACT_KEYS`'s
    // own two names, so a deterministic measure's `definition.factPath` addresses them exactly
    // the way it addresses every other fact. `usable_run_count`/`total_run_count` and
    // `coverage.surface` stay on the row as their own columns too (evaluation_score's own
    // coverage-floor check reads the raw counts, not a rate) — this is the SAME numbers, read a
    // second way, never a second computation.
    usable_run_coverage: rate(traces.usable_runs, traces.runs, traces.usable_runs, traces.runs, noEvents),
    tool_coverage: rate(called.observed, called.total, called.observed, called.total,
      "this plugin's skills name no tool this scan can check reachability for"),
    // A return and an unplaced step are defined against the stage order this plugin's own
    // manifest declares. A plugin that declares none — a door like zz-core, whose runs record
    // the steps of whichever flow was calling it — has no order for either to be measured
    // against; every step came out "unplaced", reported as a rate of 1.
    stage_return_rate: stages.length
      ? rate(traces.returns.length, totalStepVisits, traces.coverage.with_step, traces.coverage.events, noSteps)
      : { value: null, reason: noStages },
    unplaced_step_rate: stages.length
      ? rate(totalUnplaced, totalStepVisits, traces.coverage.with_step, traces.coverage.events, noSteps)
      : { value: null, reason: noStages },
    // Calls per run: a volume, not a rate, so its coverage is the runs it is averaged over.
    tool_call_volume: measured(traces.runs ? totalCalls / traces.runs : null, traces.runs, traces.runs, noEvents),
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
    coverageSurface: { ...called, source: surface.source },
    runtimeIdentity: {
      service_versions: { "zz-core": PLATFORM_VERSION },
      models: models.rows.map((r) => r.model),
    },
  };
}

function returnsByPair(returns: Observation["traces"]["returns"]): { from_step: string; back_to_step: string; count: number }[] {
  const by = new Map<string, { from_step: string; back_to_step: string; count: number }>();
  for (const r of returns) {
    const k = `${r.from_step}\u0000${r.back_to_step}`;
    const had = by.get(k);
    if (had) had.count++; else by.set(k, { from_step: r.from_step, back_to_step: r.back_to_step, count: 1 });
  }
  return [...by.values()].sort((a, b) => b.count - a.count);
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
    // Extra context beyond the contract's own fields — the traces this snapshot's facts were
    // rolled up from. Every stage visit is summarised rather than listed: at 95 runs the list
    // alone was 25KB of a 71KB response, more than a calling agent's context takes in one
    // result, and nothing downstream reads it from here — DISCOVER recomputes it.
    traces: {
      ...observation.traces,
      stage_paths: {
        initiatives: observation.traces.stage_paths.length,
        visits: observation.traces.stage_paths.reduce((n, p) => n + p.steps.length, 0),
      },
      // Counted per pair of stages, not listed per visit: 109 returns were 17KB of sdlc's reply.
      returns: returnsByPair(observation.traces.returns),
      // What EVALUATE needs to cite a run, and nothing it does not.
      run_refs: observation.traces.run_refs.map(({ run_id, team, initiative }) => ({ run_id, team, initiative })),
    },
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
      // An empty window is refused, not recorded: a snapshot of nothing carried an evaluation
      // through DISCOVER and DEFINE on no evidence at all. The usual cause is evaluating the
      // version just released, which nobody but the evaluation has used yet — so the refusal
      // names the versions that were used. A door's use is its calls, which an admin act makes
      // outside any run; a flow's is its runs.
      const calls = observation.traces.use.reduce((n, u) => n + u.calls, 0);
      if (serves ? calls === 0 : observation.traces.runs === 0) {
        const used = await versionsWithUse(pool, plugin, serves);
        const unit = serves ? "call" : "run";
        throw new Refusal(
          `ERROR: ${plugin} ${declaredVersion} has no ${unit} in this window (${window.from} to ${window.to}), ` +
          "not counting evaluations' own — there is nothing to observe. " +
          (used.length
            ? `Versions of ${plugin} that were used: ${used.map((v) =>
                `${v.version} (${v.uses} ${v.unit}${v.uses === 1 ? "" : "s"}, last ${v.last})`).join("; ")}. ` +
              "IDENTIFY one of those with plugin_locate(version), or wait for real use of this one."
            : `No version of ${plugin} has been used yet.`));
      }

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
