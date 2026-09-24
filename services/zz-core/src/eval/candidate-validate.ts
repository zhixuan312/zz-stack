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
 */
import { SearchPolicy } from "@zz/contracts";
import type pg from "pg";

import {
  applyCandidatePatch, buildAndGate, createCandidateWorktree, discoverRepoRoot,
  linkWorkspaceDependencies, removeCandidateWorktree, type BuildOutcome, type Worktree,
} from "./candidate-build.js";
import { withIdempotency, type IdempotencyOutcome, type MutatorOutcome } from "./idempotency.js";
import { pairedDecision, type PairedDecisionResult } from "./stats.js";

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

/** Search policy defaults for a protocol whose `improvement_policy.search` this task's own plan
 *  boundary leaves free to omit — never thrown on, because a missing policy is not a missing
 *  candidate: 3 repeats, no meaningful-effect floor, a conventional 95% interval, a one-day
 *  liveness bound. Generous enough that a real protocol always overrides them. */
const DEFAULT_POLICY: ValidationPolicy = { minRepeats: 3, mme: 0, confidence: 0.95, wallClockHours: 24 };

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

  const parsed = SearchPolicy.safeParse(run.search_policy);
  const policy: ValidationPolicy = parsed.success
    ? { minRepeats: parsed.data.minRepeats, mme: parsed.data.minMeaningfulEffect,
        confidence: parsed.data.confidence, wallClockHours: parsed.data.wallClockHours }
    : DEFAULT_POLICY;
  return { ok: true, caseSetId: snapshot.case_set_version_id, policy, improvementRunCreatedAt: new Date(run.created_at) };
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

interface SideRun {
  readonly case_id: string;
  readonly overall: number;
  readonly score: { dimensions?: { key: string; score: number | null }[] } | null;
  readonly guardrails: readonly string[] | null;
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
async function baselineRuns(p: pg.Pool, caseIds: readonly string[], baseSubjectVersionId: string): Promise<SideRun[]> {
  if (!caseIds.length) return [];
  return (await p.query<SideRun>(`
    select case_id::text as case_id, (score->>'overall')::float8 as overall, score, guardrails, cost::float8 as cost, duration_ms::float8 as duration_ms
      from zz.replay_run
     where case_id = any($1::uuid[]) and subject_version_id = $2::uuid and status = 'completed'
       and score is not null and score->>'overall' is not null
     order by created_at`, [caseIds, baseSubjectVersionId])).rows;
}

async function candidateRuns(p: pg.Pool, caseIds: readonly string[], candidateId: string): Promise<SideRun[]> {
  if (!caseIds.length) return [];
  return (await p.query<SideRun>(`
    select case_id::text as case_id, (score->>'overall')::float8 as overall, score, guardrails, cost::float8 as cost, duration_ms::float8 as duration_ms
      from zz.replay_run
     where case_id = any($1::uuid[]) and candidate_id = $2::uuid and status = 'completed'
       and score is not null and score->>'overall' is not null
     order by created_at`, [caseIds, candidateId])).rows;
}

function mean(xs: readonly number[]): number { return xs.reduce((a, b) => a + b, 0) / xs.length; }

function groupByCase(xs: readonly SideRun[]): Map<string, SideRun[]> {
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

interface PerCaseDelta {
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

function summariseGuardrails(runs: readonly SideRun[]): { status: "pass" | "fail" | "not_established"; by_run: { case_id: string; guardrails: readonly string[] | null }[] } {
  const flat = runs.flatMap((r) => r.guardrails ?? []);
  const status = flat.includes("fail") ? "fail" : flat.includes("not_established") ? "not_established" : "pass";
  return { status, by_run: runs.map((r) => ({ case_id: r.case_id, guardrails: r.guardrails })) };
}

function summariseResourceUsage(baseline: readonly SideRun[], candidateSide: readonly SideRun[], complexityDelta: number): unknown {
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

function summariseDimensions(baseline: readonly SideRun[], candidateSide: readonly SideRun[]): unknown {
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

/** `null` on success (the candidate is now `valid`); an error object on failure — the caller
 *  returns it to the MCP client as-is, never through `withIdempotency` (the contract's own
 *  "never replayed"): a build/gate failure is reported fresh on every call, not cached as a
 *  ledger replay, and a candidate marked `invalid` here is refused by the status gate above
 *  before this function is ever reached again. */
async function buildCandidateInIsolation(p: pg.Pool, candidate: CandidateRow): Promise<{ error: string } | null> {
  const repoRoot = discoverRepoRoot();
  if (!repoRoot) {
    return { error: "ERROR: this deployment has no git checkout to build a candidate's own worktree from" };
  }
  const patchRow = (await p.query<{ diff: string | null }>(
    "select patchset->>'diff' as diff from zz.candidate where id = $1::uuid", [candidate.id])).rows[0];
  if (!patchRow?.diff) return { error: `ERROR: candidate ${candidate.id} carries no patchset.diff to build` };

  let worktree: Worktree | undefined;
  try {
    worktree = createCandidateWorktree(repoRoot, candidate.id);
    linkWorkspaceDependencies(repoRoot, worktree.path);
    applyCandidatePatch(worktree.path, patchRow.diff);
    const attempt: BuildOutcome = buildAndGate(worktree.path);
    if (attempt.ok) {
      await p.query("update zz.candidate set status = 'valid' where id = $1::uuid", [candidate.id]);
      return null;
    }
    if (attempt.stage === "timeout") {
      // Not the candidate's fault — refuse rather than mark it invalid on an environment that
      // never finished judging it.
      return { error: `ERROR: ${attempt.command} did not finish in time building candidate ${candidate.id} — try again` };
    }
    await p.query("update zz.candidate set status = 'invalid' where id = $1::uuid", [candidate.id]);
    return {
      error: `ERROR: candidate ${candidate.id} failed its own ${attempt.stage}, which invalidates it. ` +
        `Failing command tail follows:\n${attempt.output}`,
    };
  } finally {
    if (worktree) removeCandidateWorktree(repoRoot, worktree);
  }
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
  const candidate = await loadCandidate(p, candidateId);
  if (!candidate) return { error: `ERROR: no candidate ${candidateId}` };
  if (candidate.status !== "recorded" && candidate.status !== "valid") {
    return {
      error: `ERROR: candidate_validate is only callable for status in (recorded, valid); ` +
        `candidate ${candidateId} is ${candidate.status}`,
    };
  }

  if (candidate.status === "recorded") {
    const built = await buildCandidateInIsolation(p, candidate);
    if (built) return built;
  }

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
}
