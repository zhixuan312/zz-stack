/**
 * `candidate_validate`'s own planning + statistics (Task I-19, AC-40.1, AC-41.1): everything
 * between `candidate_record`'s ledger row and a stored `zz.candidate_evaluation` — build+gate
 * isolation (`candidate-build.ts`), which replay runs are still missing, and the paired
 * bootstrap decision (`stats.ts`) once every validation case has enough of them. `candidates.ts`
 * keeps only the tool's own registration and description; every decision this contract asks for
 * lives here, so it can be read and reasoned about on its own.
 *
 * Orchestration split (the plan's own "decide the split and state it"): `candidate_validate`
 * never launches a replay itself. `packages/tools/src/replay/launch.ts` (the launcher) is what
 * runs a candidate or baseline session end to end, and only the IMPROVE agent drives it — one
 * `replay_start` (now `case_id`-steerable, this same task's own fix to `replay-runs.ts`) plus
 * `launchReplay` per planned run. This tool plans which `(case, side)` pairs still need one,
 * reports that as `runs_required` when the evidence on hand cannot yet decide, and computes
 * statistics purely from `zz.replay_run` rows that are already `completed` and carry a score
 * (`replay_score`, the sibling task this same initiative closed) — a planner and a reducer,
 * never an executor. The contract's own words for this: "the tool adds repeats while the result
 * is unresolved" — represented here as data in the response, never as a loop inside this call.
 *
 * `split = 'validation'` only, everywhere a case is read: `proof` and `evolve` cases are never
 * named in a query this file writes, which is what "never reads proof cases" (the contract's own
 * invariant) means in practice — not a runtime check, a query that cannot reach them.
 *
 * Reused by `candidate-prove.ts` (Task I-21): `mean`, `groupByCase`, `SideRun`, `baselineRuns`,
 * `candidateRuns`, `PerCaseDelta`, `summariseGuardrails`, `summariseResourceUsage`, `summariseDimensions` and
 * `protocolHasModelBackedMeasure` are exported below for exactly that — a proof run is scored by
 * the SAME machinery a validation run is, over whichever case ids the caller already resolved to
 * `split: 'proof'` rather than `split: 'validation'`. None of these functions hard-code a split
 * literal themselves; the split is decided once, by whichever caller fetches the case ids. Proof
 * plans its own runs as counts, never case ids, so the per-case `runs_required` shape stays here.
 *
 * The leakage screen (FR-38, `candidate-leakage.ts`) runs here, on the first call against a
 * `recorded` candidate, before it is built — `screenBeforeBuild`.
 */
import type pg from "pg";

import {
  applyCandidatePatch, buildAndGate, createCandidateWorktree, discoverRepoRoot,
  linkWorkspaceDependencies, removeCandidateWorktree, VALIDATING_LEASE_MS, type BuildOutcome, type Worktree,
} from "./candidate-build.js";
import { loadDimensions } from "./evaluate.js";
import type { GuardrailResult } from "./evaluate-measures.js";
import { withIdempotency, type IdempotencyOutcome, type MutatorOutcome } from "./idempotency.js";
import { screenLeakage } from "./candidate-leakage.js";
import type { TouchedComponent } from "./complexity.js";
import { parseSearchPolicy } from "./search-rules.js";
import { pairedDecision, type PairedDecisionResult } from "./stats.js";
import { insertEvaluatorAnswer } from "../semantic.js";

// -------------------------------------------------------------------------------------------
// Candidate + its validation policy.

interface CandidateRow {
  readonly id: string;
  readonly status: string;
  readonly improvement_run_id: string;
  readonly base_subject_version_id: string;
  readonly complexity_delta: number;
}

async function loadCandidate(p: pg.Pool, candidateId: string): Promise<CandidateRow | null> {
  const row = (await p.query<CandidateRow>(`
    select id::text as id, status, improvement_run_id::text as improvement_run_id,
           base_subject_version_id::text as base_subject_version_id, complexity_delta
      from zz.candidate where id = $1::uuid`, [candidateId])).rows[0];
  return row ?? null;
}

interface ValidationPolicy { minRepeats: number; mme: number; confidence: number; wallClockHours: number }

type ValidationContext =
  | { readonly ok: true; readonly caseSetId: string; readonly policy: ValidationPolicy; readonly improvementRunCreatedAt: Date }
  | { readonly ok: false; readonly error: string };

/** The case set this candidate validates against is not the candidate's own — it is the plugin's
 *  evidence, bound once at `evaluation_start` and read back through
 *  `improvement_run -> eval_run -> eval_evidence_snapshot.case_set_version_id`. Never "the newest
 *  case set for this plugin": that would silently validate against evidence the eval_run this
 *  candidate was proposed to fix never saw. */
async function loadValidationContext(p: pg.Pool, candidate: CandidateRow): Promise<ValidationContext> {
  const run = (await p.query<{ eval_run_id: string; search_policy: unknown; created_at: string }>(
    "select eval_run_id::text as eval_run_id, search_policy, created_at from zz.improvement_run where id = $1::uuid",
    [candidate.improvement_run_id])).rows[0];
  if (!run) return { ok: false, error: `ERROR: improvement_run ${candidate.improvement_run_id} no longer exists` };

  const snapshot = (await p.query<{ case_set_version_id: string | null }>(`
    select es.case_set_version_id::text as case_set_version_id
      from zz.eval_run er join zz.eval_evidence_snapshot es on es.id = er.evidence_snapshot_id
     where er.id = $1::uuid`, [run.eval_run_id])).rows[0];
  if (!snapshot?.case_set_version_id) {
    return {
      ok: false,
      error: `ERROR: improvement_run ${candidate.improvement_run_id}'s own eval_run bound no ` +
        "case_set_version_id — call replay_case_set_build and bind its case set at evaluation_start " +
        "before a candidate from this run can be validated",
    };
  }

  // No fallback policy (search-rules.ts): a malformed snapshot is refused, never validated
  // against an invented `mme: 0`.
  const parsed = parseSearchPolicy(run.search_policy, candidate.improvement_run_id);
  if ("error" in parsed) return { ok: false, error: parsed.error };
  const policy: ValidationPolicy = {
    minRepeats: parsed.minRepeats, mme: parsed.minMeaningfulEffect,
    confidence: parsed.confidence, wallClockHours: parsed.wallClockHours,
  };
  return { ok: true, caseSetId: snapshot.case_set_version_id, policy, improvementRunCreatedAt: new Date(run.created_at) };
}

/** Fix 2: `replay_score` correctly scores every measure of a protocol that declares none capable
 *  of judging a replay — `deterministic`/`outcome` always exclude for a replay case (no
 *  observation snapshot exists for one), and `human` always excludes (no ingestion pipeline). If
 *  a protocol's own dimensions carry no `bounded_semantic`/`generative_critic` measure either,
 *  EVERY replay of it scores `overall: null` forever, on both sides, and `planValidation`'s own
 *  `score is not null` filter (`baselineRuns`/`candidateRuns`) never counts a single run as
 *  "completed, scored" — `runs_required` asks for the same repeats indefinitely, with nothing in
 *  the response saying why. This is the named reason instead: refused once, before a single
 *  replay is ever planned, rather than an unbounded loop that looks like "not enough evidence
 *  yet" and never becomes anything else. Reads the plugin's newest protocol version, the same one
 *  `replay_start`'s own `pluginProtocol` (`replay-runs.ts`) binds a fresh run to. */
export async function protocolHasModelBackedMeasure(
  p: pg.Pool, baseSubjectVersionId: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
  const subject = (await p.query<{ plugin_id: string }>(
    "select plugin_id::text as plugin_id from zz.eval_subject_version where id = $1::uuid",
    [baseSubjectVersionId])).rows[0];
  if (!subject) return { ok: false, error: `ERROR: base_subject_version_id ${baseSubjectVersionId} no longer resolves to a plugin` };

  const protocolRow = (await p.query<{ id: string }>(`
    select epv.id::text as id
      from zz.eval_protocol_version epv
      join zz.eval_protocol ep on ep.id = epv.protocol_id
     where ep.plugin_id = $1::uuid
     order by epv.version desc limit 1`, [subject.plugin_id])).rows[0];
  if (!protocolRow) return { ok: false, error: "ERROR: this plugin has no recorded protocol version yet" };

  const dims = await loadDimensions(p, protocolRow.id);
  const modelBacked = dims.some((d) => d.applicable && d.measures.some((m) =>
    m.evaluator_type === "bounded_semantic" || m.evaluator_type === "generative_critic"));
  if (!modelBacked) {
    return {
      ok: false,
      error: "ERROR: this plugin's own protocol version declares no bounded_semantic or " +
        "generative_critic measure, so every replay of it scores overall: null (deterministic/" +
        "outcome measures carry no observation snapshot to read for a replay case, and human " +
        "measures have no ingestion pipeline) — candidate_validate could never resolve a verdict " +
        "from evidence like that. Add a model-backed measure to the protocol before validating a " +
        "candidate against it.",
    };
  }
  return { ok: true };
}

interface StoredEvaluation {
  readonly id: string;
  readonly aggregate_score: { mean_delta: number; lower: number; upper: number; verdict: PairedDecisionResult["verdict"] };
  readonly guardrails: unknown;
  readonly resource_usage: unknown;
}

/** This candidate's own stored `split: 'validation'` row, if `candidate_validate` has already
 *  resolved one — `null` the first time, and on a candidate still `recorded` (nothing has run
 *  yet). See the caller's own note on why a second call must read this back rather than insert
 *  a second row. */
async function existingValidationEvaluation(p: pg.Pool, candidateId: string): Promise<StoredEvaluation | null> {
  const row = (await p.query<StoredEvaluation>(`
    select id::text as id, aggregate_score, guardrails, resource_usage
      from zz.candidate_evaluation
     where candidate_id = $1::uuid and split = 'validation'
     order by created_at desc limit 1`, [candidateId])).rows[0];
  return row ?? null;
}

// -------------------------------------------------------------------------------------------
// Pairing: which validation cases exist, which replay_run rows already answer them.

export interface SideRun {
  readonly case_id: string;
  readonly overall: number;
  readonly score: { dimensions?: { key: string; score: number | null }[] } | null;
  /** The rich `GuardrailResult[]` `replay_score` stores on `zz.replay_run.guardrails` (Task I-29's
   *  own fix dispatch — was a bare `"pass"|"fail"|"not_established"[]`). `summariseGuardrails`
   *  below reads `.status` off each entry. */
  readonly guardrails: readonly GuardrailResult[] | null;
  readonly cost: number | null;
  readonly duration_ms: number | null;
}

async function validationCaseIds(p: pg.Pool, caseSetId: string): Promise<string[]> {
  return (await p.query<{ case_id: string }>(`
    select id::text as case_id from zz.replay_case
     where case_set_id = $1::uuid and split = 'validation' and status = 'replayable'
     order by id`, [caseSetId])).rows.map((r) => r.case_id);
}

/** Completed, scored replay_run rows for one side. `score->>'overall'` not null is the same
 *  "carries a score" test `candidates.ts`'s own contract line reads as "paired per-case scores"
 *  — a run `replay_score` has not yet reached, or one still `registered`/`running`/`failed`, is
 *  simply not counted, never treated as a zero. */
export async function baselineRuns(p: pg.Pool, caseIds: readonly string[], baseSubjectVersionId: string): Promise<SideRun[]> {
  if (!caseIds.length) return [];
  return (await p.query<SideRun>(`
    select case_id::text as case_id, (score->>'overall')::float8 as overall, score, guardrails, cost::float8 as cost, duration_ms::float8 as duration_ms
      from zz.replay_run
     where case_id = any($1::uuid[]) and subject_version_id = $2::uuid and status = 'completed'
       and score is not null and score->>'overall' is not null
     order by created_at`, [caseIds, baseSubjectVersionId])).rows;
}

export async function candidateRuns(p: pg.Pool, caseIds: readonly string[], candidateId: string): Promise<SideRun[]> {
  if (!caseIds.length) return [];
  return (await p.query<SideRun>(`
    select case_id::text as case_id, (score->>'overall')::float8 as overall, score, guardrails, cost::float8 as cost, duration_ms::float8 as duration_ms
      from zz.replay_run
     where case_id = any($1::uuid[]) and candidate_id = $2::uuid and status = 'completed'
       and score is not null and score->>'overall' is not null
     order by created_at`, [caseIds, candidateId])).rows;
}

export function mean(xs: readonly number[]): number { return xs.reduce((a, b) => a + b, 0) / xs.length; }

export function groupByCase(xs: readonly SideRun[]): Map<string, SideRun[]> {
  const m = new Map<string, SideRun[]>();
  for (const x of xs) {
    const arr = m.get(x.case_id);
    if (arr) arr.push(x); else m.set(x.case_id, [x]);
  }
  return m;
}

interface RunsRequiredEntry {
  readonly case_id: string;
  readonly side: "baseline" | "candidate";
  readonly subject_version_id: string | null;
  readonly candidate_id: string | null;
  readonly count: number;
}

export interface PerCaseDelta {
  readonly case_id: string; readonly baseline_mean: number; readonly baseline_n: number;
  readonly candidate_mean: number; readonly candidate_n: number; readonly delta: number;
}

type Plan =
  | { readonly kind: "empty" }
  | { readonly kind: "pending"; readonly runs_required: RunsRequiredEntry[] }
  | { readonly kind: "resolved"; readonly perCase: PerCaseDelta[]; readonly baseline: SideRun[]; readonly candidateSide: SideRun[] };

/** One pass over every validation case: a case with fewer than `minRepeats` completed, scored
 *  runs on EITHER side names itself in `runs_required` for that side specifically — a candidate
 *  with plenty of baseline coverage and no candidate runs yet asks only for the candidate side,
 *  never both, so the driver is not sent to re-run evidence it already has. Only once every case
 *  clears the floor on both sides does this reduce to per-case deltas. */
async function planValidation(p: pg.Pool, candidate: CandidateRow, caseSetId: string, minRepeats: number): Promise<Plan> {
  const caseIds = await validationCaseIds(p, caseSetId);
  if (!caseIds.length) return { kind: "empty" };

  const baseline = await baselineRuns(p, caseIds, candidate.base_subject_version_id);
  const candidateSide = await candidateRuns(p, caseIds, candidate.id);
  const byBaseline = groupByCase(baseline);
  const byCandidate = groupByCase(candidateSide);

  const runsRequired: RunsRequiredEntry[] = [];
  const perCase: PerCaseDelta[] = [];
  for (const caseId of caseIds) {
    const b = byBaseline.get(caseId) ?? [];
    const k = byCandidate.get(caseId) ?? [];
    if (b.length < minRepeats) {
      runsRequired.push({ case_id: caseId, side: "baseline", subject_version_id: candidate.base_subject_version_id, candidate_id: null, count: minRepeats - b.length });
    }
    if (k.length < minRepeats) {
      runsRequired.push({ case_id: caseId, side: "candidate", subject_version_id: null, candidate_id: candidate.id, count: minRepeats - k.length });
    }
    if (b.length >= minRepeats && k.length >= minRepeats) {
      const baseline_mean = mean(b.map((r) => r.overall));
      const candidate_mean = mean(k.map((r) => r.overall));
      perCase.push({ case_id: caseId, baseline_mean, baseline_n: b.length, candidate_mean, candidate_n: k.length, delta: candidate_mean - baseline_mean });
    }
  }
  if (runsRequired.length) return { kind: "pending", runs_required: runsRequired };
  return { kind: "resolved", perCase, baseline, candidateSide };
}

/** `unresolved` under the liveness bound asks for exactly one more repeat per case per side —
 *  the contract's own "adds repeats while the result is unresolved," applied uniformly rather
 *  than guessing which case is the noisy one. */
function escalateOneRepeat(caseIds: readonly string[], candidate: CandidateRow): RunsRequiredEntry[] {
  const out: RunsRequiredEntry[] = [];
  for (const caseId of caseIds) {
    out.push({ case_id: caseId, side: "baseline", subject_version_id: candidate.base_subject_version_id, candidate_id: null, count: 1 });
    out.push({ case_id: caseId, side: "candidate", subject_version_id: null, candidate_id: candidate.id, count: 1 });
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// Guardrails / resource usage / dimension scores — reported, never gated on (the contract's own
// "cost/latency/complexity as reported objectives, not caps").

export function summariseGuardrails(runs: readonly SideRun[]): { status: "pass" | "fail" | "not_established"; by_run: { case_id: string; guardrails: readonly GuardrailResult[] | null }[] } {
  const flatStatuses = runs.flatMap((r) => (r.guardrails ?? []).map((g) => g.status));
  const status = flatStatuses.includes("fail") ? "fail" : flatStatuses.includes("not_established") ? "not_established" : "pass";
  return { status, by_run: runs.map((r) => ({ case_id: r.case_id, guardrails: r.guardrails })) };
}

export function summariseResourceUsage(baseline: readonly SideRun[], candidateSide: readonly SideRun[], complexityDelta: number): unknown {
  const avg = (xs: readonly (number | null)[]): number | null => {
    const vs = xs.filter((v): v is number => v !== null);
    return vs.length ? mean(vs) : null;
  };
  return {
    baseline: { mean_cost: avg(baseline.map((r) => r.cost)), mean_duration_ms: avg(baseline.map((r) => r.duration_ms)) },
    candidate: { mean_cost: avg(candidateSide.map((r) => r.cost)), mean_duration_ms: avg(candidateSide.map((r) => r.duration_ms)) },
    complexity_delta: complexityDelta,
  };
}

export function summariseDimensions(baseline: readonly SideRun[], candidateSide: readonly SideRun[]): unknown {
  const valuesByKey = (runs: readonly SideRun[]): Map<string, number[]> => {
    const m = new Map<string, number[]>();
    for (const r of runs) {
      for (const d of r.score?.dimensions ?? []) {
        if (d.score === null) continue;
        const arr = m.get(d.key);
        if (arr) arr.push(d.score); else m.set(d.key, [d.score]);
      }
    }
    return m;
  };
  const b = valuesByKey(baseline);
  const k = valuesByKey(candidateSide);
  const out: { key: string; baseline_mean: number | null; candidate_mean: number | null; delta: number | null }[] = [];
  for (const key of new Set([...b.keys(), ...k.keys()])) {
    const bv = b.get(key);
    const kv = k.get(key);
    const baseline_mean = bv?.length ? mean(bv) : null;
    const candidate_mean = kv?.length ? mean(kv) : null;
    out.push({ key, baseline_mean, candidate_mean, delta: baseline_mean !== null && candidate_mean !== null ? candidate_mean - baseline_mean : null });
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// Build + gate isolation.

/** `null` on success; an error object on failure — the caller returns it to the MCP client
 *  as-is, never through `withIdempotency` (the contract's own "never replayed"): a build/gate
 *  failure is reported fresh on every call, not cached as a ledger replay. Writes NO status
 *  itself: the candidate stays `validating` (the caller's lock) until the caller's own `finally`
 *  writes the resting status — a `valid` written here, mid-call, dropped the lock while the rest
 *  of the call still ran, and let a second call in. `retryable` tells the caller whether the
 *  candidate itself was judged (`invalid` — a real build/gate failure) or whether nothing was
 *  judged at all (a timeout — not this candidate's fault, so it goes back to `recorded`). */
async function buildCandidateInIsolation(
  p: pg.Pool, candidate: CandidateRow,
): Promise<{ error: string; retryable: boolean } | null> {
  const repoRoot = discoverRepoRoot();
  if (!repoRoot) {
    return { error: "ERROR: this deployment has no git checkout to build a candidate's own worktree from", retryable: true };
  }
  const patchRow = (await p.query<{ diff: string | null }>(
    "select patchset->>'diff' as diff from zz.candidate where id = $1::uuid", [candidate.id])).rows[0];
  if (!patchRow?.diff) {
    return { error: `ERROR: candidate ${candidate.id} carries no patchset.diff to build`, retryable: true };
  }

  let worktree: Worktree | undefined;
  try {
    worktree = createCandidateWorktree(repoRoot, candidate.id);
    linkWorkspaceDependencies(repoRoot, worktree.path);
    applyCandidatePatch(worktree.path, patchRow.diff);
    const attempt: BuildOutcome = buildAndGate(worktree.path);
    if (attempt.ok) return null;
    if (attempt.stage === "timeout") {
      // Not the candidate's fault — refuse rather than mark it invalid on an environment that
      // never finished judging it. retryable: true, so the caller's own CAS lock (fix 5) hands
      // the candidate back to 'recorded' rather than stranding it 'validating'.
      return {
        error: `ERROR: ${attempt.command} did not finish in time building candidate ${candidate.id} — try again`,
        retryable: true,
      };
    }
    return {
      error: `ERROR: candidate ${candidate.id} failed its own ${attempt.stage}, which invalidates it. ` +
        `Failing command tail follows:\n${attempt.output}`,
      retryable: false,
    };
  } finally {
    if (worktree) removeCandidateWorktree(repoRoot, worktree);
  }
}

/** Screens a `recorded` candidate for leakage (candidate-leakage.ts) and records the answer.
 *  Returns the refusal text when the critic says `yes` — the caller then rests the candidate at
 *  `rejected_precheck`, with the reason on `expected_effect._rejection_reason` where
 *  `candidate_search` reports it from — or null to go on to the build. */
async function screenBeforeBuild(p: pg.Pool, candidateId: string, principal: string): Promise<string | null> {
  const row = (await p.query<{
    hypothesis: string; diff: string | null; touched_components: TouchedComponent[] | null; patch_digest: string;
  }>(
    "select hypothesis, patchset->>'diff' as diff, touched_components, patch_digest from zz.candidate where id = $1::uuid",
    [candidateId])).rows[0];
  if (!row) return `ERROR: no candidate ${candidateId}`;
  // A retry after a timed-out build screens the same subject again: an earlier recorded answer
  // is read back rather than asked twice (candidate-leakage.ts's `reuse`).
  const verdict = await screenLeakage(
    { hypothesis: row.hypothesis, diff: row.diff ?? "", touched_components: row.touched_components ?? [] }, principal,
    { pool: p, patchDigest: row.patch_digest });
  if (verdict.pending) await insertEvaluatorAnswer(p, verdict.pending);
  if (verdict.reading !== "yes") return null;
  await p.query(
    "update zz.candidate set expected_effect = expected_effect || $2::jsonb where id = $1::uuid",
    [candidateId, JSON.stringify({ _rejection_reason: verdict.reason })]);
  return `ERROR: candidate ${candidateId} is rejected_precheck — ${verdict.reason}`;
}

/** Fix 5: `candidate_validate` never wrote `'validating'` (a legal status per migration 002's own
 *  check constraint, but nothing before this fix ever set it), so two concurrent calls against
 *  the same `recorded` candidate both read `status = 'recorded'`, both called
 *  `buildCandidateInIsolation`, and both raced `createCandidateWorktree`'s own deterministic
 *  (`candidateId`-keyed) path — the second `git worktree add` colliding with, or silently
 *  clobbering, the first's in-flight build.
 *
 *  A single `WITH ... FOR UPDATE` statement — one round trip, one implicit transaction, no
 *  explicit `BEGIN` spanning the (potentially ten-plus-minute) build — is the compare-and-set:
 *  it locks the row, reads its CURRENT status, and only WRITES `'validating'` when that status
 *  is still `recorded` or `valid`. A concurrent second caller's own attempt at the same statement
 *  blocks on the row lock until the first commits, then finds zero matching rows (the first
 *  caller already moved it to `'validating'`) and updates nothing — `null` here, a named refusal
 *  in the caller, never a silent block for the whole build's duration. */
async function acquireValidatingLock(p: pg.Pool, candidateId: string): Promise<"recorded" | "valid" | null> {
  const row = (await p.query<{ prior_status: string }>(`
    with prior as (
      select status from zz.candidate where id = $1::uuid and status in ('recorded', 'valid') for update
    )
    update zz.candidate c set status = 'validating', validating_since = now()
      from prior
     where c.id = $1::uuid
    returning prior.status as prior_status`, [candidateId])).rows[0];
  if (!row) return null;
  return row.prior_status as "recorded" | "valid";
}

/** The lease on `validating` (migration 002's `validating_since`): the hold above is released by
 *  the call's own `finally`, which a process killed mid-build (SIGKILL, a redeploy) never runs.
 *  A hold older than `VALIDATING_LEASE_MS` — longer than any build and gate can take — is such a
 *  process, and its candidate goes back to where it can be validated again: `valid` when its
 *  build already passed (a stored validation verdict exists), `recorded` otherwise, which
 *  screens and builds it again. Scoped to one candidate (`candidate_validate`) or one run
 *  (`candidate_search`, whose generations never settle while a candidate is `validating`). */
export async function releaseStaleValidating(
  p: pg.Pool, scope: { readonly candidateId: string } | { readonly improvementRunId: string },
): Promise<void> {
  const [column, id] = "candidateId" in scope ? ["id", scope.candidateId] : ["improvement_run_id", scope.improvementRunId];
  await p.query(`
    update zz.candidate c
       set status = case when exists (
             select 1 from zz.candidate_evaluation ce where ce.candidate_id = c.id and ce.split = 'validation'
           ) then 'valid' else 'recorded' end,
           validating_since = null
     where c.${column} = $1::uuid and c.status = 'validating'
       and c.validating_since < now() - make_interval(secs => $2)`,
    [id, VALIDATING_LEASE_MS / 1000]);
}

// -------------------------------------------------------------------------------------------
// The tool's own result shape and orchestrator.

interface ValidateOutcome {
  readonly candidate_evaluation_id: string | null;
  readonly verdict: PairedDecisionResult["verdict"] | null;
  readonly interval: [number, number] | null;
  readonly mean_delta: number | null;
  readonly guardrails: unknown;
  readonly resource_usage: unknown;
  readonly runs_required?: RunsRequiredEntry[];
  readonly status: string;
}

/** Seeded from `candidateId` (never a call-time random value): the same candidate's statistics
 *  reproduce bit for bit across retries and across "more runs required" follow-up calls that
 *  land on the same evidence, exactly as `pairedDecision`'s own seeding contract promises. 2000
 *  resamples: `SearchPolicy` names no `resamples` field of its own (this task's plan boundary
 *  again), so this is a DELIBERATE constant, the same order of magnitude the plan's own
 *  `checks/eval-paired-stats.ts` uses. */
const RESAMPLES = 2000;

export async function validateCandidate(
  p: pg.Pool, candidateId: string, idempotencyKey: string, principal: string,
): Promise<ValidateOutcome | { error: string }> {
  // Before the status gate below, so a hold whose process died is repaired rather than refused.
  await releaseStaleValidating(p, { candidateId });
  const candidate = await loadCandidate(p, candidateId);
  if (!candidate) return { error: `ERROR: no candidate ${candidateId}` };
  if (candidate.status !== "recorded" && candidate.status !== "valid") {
    return {
      error: `ERROR: candidate_validate is only callable for status in (recorded, valid); ` +
        `candidate ${candidateId} is ${candidate.status}`,
    };
  }

  // Fix 5: locks the row for the rest of this call (build, plan, statistics, store) against a
  // second concurrent candidate_validate on the SAME candidate — see acquireValidatingLock's own
  // note for why this is one statement rather than a held transaction.
  const priorStatus = await acquireValidatingLock(p, candidateId);
  if (!priorStatus) {
    const now = await loadCandidate(p, candidateId);
    return {
      error: `ERROR: candidate ${candidateId} is not available for candidate_validate right now ` +
        `(status: ${now?.status ?? "unknown"}) — another candidate_validate call is already in ` +
        "progress against it",
    };
  }
  // What status this call leaves the candidate in when it returns, written in the `finally`
  // below — defaults to what it was before this call locked it (the safe fallback on a thrown
  // exception this function did not anticipate), and is narrowed as the call actually progresses.
  let finalStatus: string = priorStatus;
  try {
    if (priorStatus === "recorded") {
      // FR-38's leakage screen, before anything is built — see candidate-leakage.ts for why a
      // clear `yes` alone rejects here while proof holds the stricter bar.
      const leaked = await screenBeforeBuild(p, candidate.id, principal);
      if (leaked) {
        finalStatus = "rejected_precheck";
        return { error: leaked };
      }
      const built = await buildCandidateInIsolation(p, candidate);
      if (built) {
        finalStatus = built.retryable ? "recorded" : "invalid";
        return { error: built.error };
      }
    }
    // Written by the `finally` below, never mid-call: the row stays 'validating' — locked
    // against a second candidate_validate — until this call has stored its verdict or returned.
    finalStatus = "valid";

    // A candidate stays `valid` after its verdict is stored (a `not_improved` candidate is not
    // rejected — see the module note), so this tool stays callable on it indefinitely. Without
    // this, a second call — with its own fresh idempotency_key, which the ledger above never
    // replays against — would recompute and INSERT a second `split: 'validation'` row for the
    // same candidate, and a later eligibility check reading "the" validation evaluation would find
    // several. One candidate, one stored validation verdict; every call past the first reads it
    // back rather than re-deciding it.
    const stored = await existingValidationEvaluation(p, candidateId);
    if (stored) {
      return {
        candidate_evaluation_id: stored.id, verdict: stored.aggregate_score.verdict,
        interval: [stored.aggregate_score.lower, stored.aggregate_score.upper],
        mean_delta: stored.aggregate_score.mean_delta,
        guardrails: stored.guardrails, resource_usage: stored.resource_usage, status: "valid",
      };
    }

    const ctx = await loadValidationContext(p, candidate);
    if (!ctx.ok) return { error: ctx.error };

    const modelBacked = await protocolHasModelBackedMeasure(p, candidate.base_subject_version_id);
    if (!modelBacked.ok) return { error: modelBacked.error };

    const plan = await planValidation(p, candidate, ctx.caseSetId, ctx.policy.minRepeats);
    if (plan.kind === "empty") {
      return { error: `ERROR: case set ${ctx.caseSetId} has no replayable validation-split case` };
    }
    if (plan.kind === "pending") {
      return {
        candidate_evaluation_id: null, verdict: null, interval: null, mean_delta: null,
        guardrails: null, resource_usage: null, runs_required: plan.runs_required, status: "valid",
      };
    }

    const deltas = plan.perCase.map((c) => c.delta);
    const decision = pairedDecision(deltas, ctx.policy.mme, {
      resamples: RESAMPLES, seed: candidateId, confidence: ctx.policy.confidence,
    });

    const boundReached = Date.now() - ctx.improvementRunCreatedAt.getTime() >= ctx.policy.wallClockHours * 3_600_000;
    if (decision.verdict === "unresolved" && !boundReached) {
      return {
        candidate_evaluation_id: null, verdict: null, interval: null, mean_delta: null,
        guardrails: null, resource_usage: null,
        runs_required: escalateOneRepeat(plan.perCase.map((c) => c.case_id), candidate),
        status: "valid",
      };
    }

    // Resolved, or `unresolved` at the liveness bound — the contract's own "unresolved" outcome is
    // still stored as this candidate's final validation split, rather than looping forever on a
    // candidate whose effect this evidence can never pin down further.
    const guardrails = summariseGuardrails(plan.candidateSide);
    const resource_usage = summariseResourceUsage(plan.baseline, plan.candidateSide, candidate.complexity_delta);
    const dimension_scores = summariseDimensions(plan.baseline, plan.candidateSide);
    const statistics = {
      per_case: plan.perCase, paired_decision: decision,
      policy: ctx.policy, resamples: RESAMPLES, seed: candidateId, liveness_bound_reached: boundReached,
    };

    const outcome: IdempotencyOutcome<{ id: string }> = await withIdempotency(
      principal, "candidate_validate", idempotencyKey, { candidate_id: candidateId },
      async (client): Promise<MutatorOutcome<{ id: string }>> => {
        const row = (await client.query<{ id: string }>(`
          insert into zz.candidate_evaluation
            (candidate_id, split, aggregate_score, dimension_scores, guardrails, statistics, resource_usage, created_at)
          values ($1::uuid, 'validation', $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, now())
          returning id::text as id`,
          [candidateId,
           JSON.stringify({ mean_delta: decision.mean, lower: decision.lower, upper: decision.upper, verdict: decision.verdict }),
           JSON.stringify(dimension_scores), JSON.stringify(guardrails), JSON.stringify(statistics),
           JSON.stringify(resource_usage)])).rows[0];
        if (!row) throw new Error("insert into zz.candidate_evaluation produced no row");
        return { result: { id: row.id }, result_table: "zz.candidate_evaluation", result_id: row.id };
      },
    );
    const candidateEvaluationId = outcome.replayed ? outcome.result_id : outcome.result.id;

    return {
      candidate_evaluation_id: candidateEvaluationId, verdict: decision.verdict,
      interval: [decision.lower, decision.upper], mean_delta: decision.mean,
      guardrails, resource_usage, status: "valid",
    };
  } finally {
    // The ONE status write this call makes: whatever it decided the candidate's resting status
    // is — and the one thing standing between a thrown exception (a DB error mid-plan, say) and
    // a candidate stuck 'validating' forever.
    await p.query(
      "update zz.candidate set status = $2, validating_since = null where id = $1::uuid and status = 'validating'",
      [candidateId, finalStatus]);
  }
}
