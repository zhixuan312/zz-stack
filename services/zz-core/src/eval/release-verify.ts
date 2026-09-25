/**
 * `release_verify`'s own planning + statistics (Task I-24, FR-50, AC-50.1): the automatic,
 * no-gate check a released candidate crosses after `release_record` moves it to `released` —
 * the same planner/reducer split `candidate_validate`/`candidate_prove` already keep against
 * `packages/tools/src/replay/launch.ts`, applied to a "prior subject vs released subject"
 * comparison instead of a "baseline vs candidate" one. This file plans which (case, side) pairs
 * still need a completed, scored `zz.replay_run` and reduces them into a verdict once evidence
 * is complete; it never runs a replay itself, and it never applies a patch, checks out a
 * worktree or runs a shell command — `packages/tools/src/release/rollback.ts` does that, once
 * this file has already decided `rolled_back` and handed back a plan naming what to restore.
 *
 * Held cases, not the proof split reopened for search: FR-50's "proof-equivalent held cases"
 * means the SAME `zz.replay_case` rows `candidate_prove` already sealed for this candidate's own
 * case set (`split = 'proof'`) — reused here for a different purpose, well after promotion, not
 * fed back into optimization. FR-28's own boundary is about search never seeing proof before
 * final selection; post-release verification runs after release_apply/release_record, with no
 * search session left to leak into. So this file mints its OWN fresh
 * `zz.replay_verifier_token` row for the SAME candidate_id (migration 079's table takes no
 * second identity, and a `context: "search"` `replay_start` call refuses `split: "proof"`
 * outright — see `replay-runs.ts`'s own `PROOF_SEALED`), reusing the exact mechanism
 * `candidate-prove.ts` already built rather than adding a second one. The proof allocation
 * `candidate_prove` minted is long since revoked by the time a candidate reaches `released`, so
 * the two tokens never collide.
 *
 * Both sides of the comparison are read through `baselineRuns` (`candidate-validate.ts`) — never
 * `candidateRuns` — because neither side is a candidate anymore by the time a subject is
 * released: "prior" is `zz.release_attempt.base_subject_version_id`, "released" is
 * `zz.release_attempt.released_subject_version_id`, and `baselineRuns` already takes any
 * `subject_version_id`, not specifically a baseline's. Calling it twice, once per side, is the
 * whole read.
 *
 * State lives on `zz.release_attempt.verification` (migration 077, null until this file's first
 * resolved call) rather than on a status column, because — unlike `candidate.status`, which
 * `candidate_prove` moves `selected -> proving -> proof_passed/...` — `zz.release_attempt.status`
 * has no interim "verifying" value and must not gain one: the attempt IS still `released` for
 * the whole time verification is running, and only moves to `rolled_back` later, through
 * `release_record`, once `rollback.ts` has actually restored the prior version. So a resolved
 * verdict is a CAS on `verification is null` (`resolveVerify`, below) rather than a CAS on
 * `status`, and a `rolled_back` verdict does NOT itself change `status` — it hands back a
 * `rollback_plan` for the CLI, exactly the way `release_apply` hands back a `patch`/`plan` for
 * `packages/tools/src/release/apply.ts` to execute and report back through `release_record`.
 *
 * No rollback without evidence (FR-50's own words, restated in the task): too few held cases, or
 * an interval that never resolves by the protocol's own liveness bound, both resolve to
 * `not_established` with a named reason — never a rollback, and never an indefinite wait either.
 */
import { randomBytes } from "node:crypto";

import { sha256, SearchPolicy, ThreeWaySplitPolicy } from "@zz/contracts";
import type pg from "pg";

import {
  baselineRuns, groupByCase, mean, protocolHasModelBackedMeasure, summariseDimensions,
  summariseGuardrails, summariseResourceUsage, type PerCaseDelta, type SideRun,
} from "./candidate-validate.js";
import { withIdempotency, type IdempotencyOutcome, type MutatorOutcome } from "./idempotency.js";
import { writeBranchFacts } from "./protocol.js";
import { rollbackDecision } from "./release-rules.js";
import { pairedDecision } from "./stats.js";
import { Refusal } from "../refusal.js";

// -------------------------------------------------------------------------------------------
// Release attempt + its verification policy.

interface AttemptRow {
  readonly id: string;
  readonly status: string;
  readonly candidate_id: string;
  readonly base_subject_version_id: string;
  readonly released_subject_version_id: string | null;
  readonly verification: VerificationState | null;
  readonly created_at: string;
}

interface VerificationState {
  readonly case_set_id?: string;
  readonly verifier_token_id?: string;
  readonly verdict?: "established" | "rolled_back" | "not_established";
  readonly reason?: string | null;
  readonly evidence?: { deltas_summary: unknown; guardrails: unknown } | null;
  readonly rollback_plan?: RollbackPlan | null;
}

async function loadAttempt(p: pg.Pool, id: string): Promise<AttemptRow | null> {
  const row = (await p.query<AttemptRow>(`
    select id::text as id, status, candidate_id::text as candidate_id,
           base_subject_version_id::text as base_subject_version_id,
           released_subject_version_id::text as released_subject_version_id,
           verification, created_at
      from zz.release_attempt where id = $1::uuid`, [id])).rows[0];
  return row ?? null;
}

interface CandidateRow {
  readonly id: string; readonly improvement_run_id: string; readonly complexity_delta: number;
}

async function loadCandidate(p: pg.Pool, candidateId: string): Promise<CandidateRow | null> {
  const row = (await p.query<CandidateRow>(`
    select id::text as id, improvement_run_id::text as improvement_run_id, complexity_delta
      from zz.candidate where id = $1::uuid`, [candidateId])).rows[0];
  return row ?? null;
}

interface SubjectDesc { readonly plugin: string; readonly declared_version: string }

async function loadSubjectDesc(p: pg.Pool, subjectVersionId: string): Promise<SubjectDesc | null> {
  const row = (await p.query<SubjectDesc>(`
    select pl.name as plugin, sv.declared_version
      from zz.eval_subject_version sv join zz.plugin pl on pl.id = sv.plugin_id
     where sv.id = $1::uuid`, [subjectVersionId])).rows[0];
  return row ?? null;
}

interface VerifyPolicy { readonly minRepeats: number; readonly confidence: number; readonly wallClockHours: number }

/** Same fallback `candidate-validate.ts`'s own `DEFAULT_POLICY` and `candidate-prove.ts`'s own
 *  `DEFAULT_PROOF_POLICY` use, for the same reason: a protocol naming no `improvement_policy.
 *  search` is not a release with no verification, it is one using these. `mme` is deliberately
 *  NOT read from here — `rollbackDecision` (`release-rules.ts`) fixes it at 0 itself, FR-50's own
 *  "below 0" rather than a protocol's minimum-meaningful-effect a release already had to clear
 *  before it was ever proved. */
const DEFAULT_VERIFY_POLICY: VerifyPolicy = { minRepeats: 3, confidence: 0.95, wallClockHours: 24 };

type VerifyContext =
  | { readonly ok: true; readonly caseSetId: string; readonly minProofCases: number; readonly policy: VerifyPolicy }
  | { readonly ok: false; readonly error: string };

/** The same join `candidate-validate.ts`'s own `loadValidationContext` and `candidate-prove.ts`'s
 *  own `loadProofContext` resolve their case set through — `improvement_run -> eval_run ->
 *  eval_evidence_snapshot.case_set_version_id` — plus the plugin's newest protocol version's
 *  `replay_policy.splitPolicy.min.proof`, the same floor `candidate_prove` reads before ever
 *  planning a single replay. Not exported from `candidate-prove.ts`, so rebuilt here rather than
 *  reached across a file boundary for a private helper — the same call `candidate-prove.ts`'s own
 *  module note makes about `candidate-validate.ts`'s `planValidation`. */
async function loadVerifyContext(p: pg.Pool, candidate: CandidateRow): Promise<VerifyContext> {
  const run = (await p.query<{ eval_run_id: string; search_policy: unknown }>(
    "select eval_run_id::text as eval_run_id, search_policy from zz.improvement_run where id = $1::uuid",
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
        "case_set_version_id — this candidate was never validated/proved against a real case set, " +
        "so it has no held cases to verify the released subject against",
    };
  }

  const subjectRow = (await p.query<{ plugin_id: string }>(`
    select sv.plugin_id::text as plugin_id
      from zz.candidate c join zz.eval_subject_version sv on sv.id = c.base_subject_version_id
     where c.id = $1::uuid`, [candidate.id])).rows[0];
  const protocolRow = subjectRow ? (await p.query<{ replay_policy: unknown; search_policy: unknown }>(`
    select epv.replay_policy
      from zz.eval_protocol_version epv
      join zz.eval_protocol ep on ep.id = epv.protocol_id
     where ep.plugin_id = $1::uuid
     order by epv.version desc limit 1`, [subjectRow.plugin_id])).rows[0] : undefined;
  const splitParsed = ThreeWaySplitPolicy.safeParse(
    (protocolRow?.replay_policy as { splitPolicy?: unknown } | null)?.splitPolicy);
  const minProofCases = splitParsed.success ? splitParsed.data.min.proof : 10;

  const searchParsed = SearchPolicy.safeParse(run.search_policy);
  const policy: VerifyPolicy = searchParsed.success
    ? { minRepeats: searchParsed.data.minRepeats, confidence: searchParsed.data.confidence,
        wallClockHours: searchParsed.data.wallClockHours }
    : DEFAULT_VERIFY_POLICY;

  return { ok: true, caseSetId: snapshot.case_set_version_id, minProofCases, policy };
}

async function proofCaseIds(p: pg.Pool, caseSetId: string): Promise<string[]> {
  return (await p.query<{ case_id: string }>(`
    select id::text as case_id from zz.replay_case
     where case_set_id = $1::uuid and split = 'proof' and status = 'replayable'
     order by id`, [caseSetId])).rows.map((r) => r.case_id);
}

// -------------------------------------------------------------------------------------------
// Planning: which (case, side) pairs still need a completed, scored replay_run.

interface VerifyRunsRequiredEntry {
  readonly case_id: string;
  readonly side: "prior" | "released";
  readonly subject_version_id: string;
  readonly count: number;
}

type Plan =
  | { readonly kind: "pending"; readonly runs_required: VerifyRunsRequiredEntry[] }
  | { readonly kind: "resolved"; readonly perCase: PerCaseDelta[]; readonly prior: SideRun[]; readonly released: SideRun[] };

async function planVerify(
  p: pg.Pool, caseIds: readonly string[], priorId: string, releasedId: string, minRepeats: number,
): Promise<Plan> {
  const prior = await baselineRuns(p, caseIds, priorId);
  const released = await baselineRuns(p, caseIds, releasedId);
  const byPrior = groupByCase(prior);
  const byReleased = groupByCase(released);

  const runsRequired: VerifyRunsRequiredEntry[] = [];
  const perCase: PerCaseDelta[] = [];
  for (const caseId of caseIds) {
    const a = byPrior.get(caseId) ?? [];
    const b = byReleased.get(caseId) ?? [];
    if (a.length < minRepeats) {
      runsRequired.push({ case_id: caseId, side: "prior", subject_version_id: priorId, count: minRepeats - a.length });
    }
    if (b.length < minRepeats) {
      runsRequired.push({ case_id: caseId, side: "released", subject_version_id: releasedId, count: minRepeats - b.length });
    }
    if (a.length >= minRepeats && b.length >= minRepeats) {
      const baseline_mean = mean(a.map((r) => r.overall));
      const candidate_mean = mean(b.map((r) => r.overall));
      perCase.push({ case_id: caseId, baseline_mean, baseline_n: a.length, candidate_mean, candidate_n: b.length, delta: candidate_mean - baseline_mean });
    }
  }
  if (runsRequired.length) return { kind: "pending", runs_required: runsRequired };
  return { kind: "resolved", perCase, prior, released };
}

function escalateOneRepeat(caseIds: readonly string[], priorId: string, releasedId: string): VerifyRunsRequiredEntry[] {
  const out: VerifyRunsRequiredEntry[] = [];
  for (const caseId of caseIds) {
    out.push({ case_id: caseId, side: "prior", subject_version_id: priorId, count: 1 });
    out.push({ case_id: caseId, side: "released", subject_version_id: releasedId, count: 1 });
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// Verifier token — the same mechanism candidate_prove mints, for the same candidate_id, under a
// fresh row (the proof allocation's own token is already revoked by the time a candidate is
// released).

const VERIFIER_TOKEN_BYTES = 32;
function mintVerifierToken(): string { return randomBytes(VERIFIER_TOKEN_BYTES).toString("hex"); }

// -------------------------------------------------------------------------------------------
// The tool's own result shape.

interface RollbackPlan {
  readonly plugin: string;
  readonly declared_version: string;
  readonly prior_subject_version_id: string;
  readonly branch: string;
}

export interface VerifyOutcome {
  readonly verdict: "established" | "rolled_back" | "not_established" | null;
  readonly reason: string | null;
  readonly evidence: { deltas_summary: unknown; guardrails: unknown } | null;
  readonly rollback_plan: RollbackPlan | null;
  readonly runs_required?: VerifyRunsRequiredEntry[];
  readonly verifier_token?: string | null;
  readonly token_already_issued?: boolean;
  readonly status: string;
  readonly facts_recorded?: boolean;
  readonly facts?: Record<string, string>;
  readonly facts_refused?: string;
}

const rollbackBranchFor = (attemptId: string): string => `release/rollback-${attemptId}`;

/** Builds the terminal response from an attempt row that already carries a resolved verdict
 *  (`verification.verdict` set) — read back rather than recomputed, the same contract
 *  `describeApplyOutcome`'s own note keeps: a replay answers "what is true now." `status` is the
 *  release_attempt's own CURRENT status — `released` for `established`/`not_established`, and
 *  either `released` (decided, not yet executed) or `rolled_back` (executed, `release_record`
 *  already recorded it) for a `rolled_back` verdict; both are valid, truthful answers. */
function terminalOutcome(attempt: AttemptRow): VerifyOutcome {
  const v = attempt.verification!;
  return {
    verdict: v.verdict ?? null, reason: v.reason ?? null, evidence: v.evidence ?? null,
    rollback_plan: v.rollback_plan ?? null, status: attempt.status,
  };
}

/** Mints a fresh verifier_token for this candidate, once — `withIdempotency` makes a same-key
 *  retry a no-op replay (`token_already_issued: true`), and `attempt.verification.
 *  verifier_token_id` (checked by the caller before this is ever reached) makes a DIFFERENT key
 *  calling into an already-opened verification a no-op too, the same "check the marker, then
 *  mint" shape `candidate_prove`'s own status-CAS keeps, simplified because nothing here needs a
 *  second column to CAS against — see the module note on why `verification` alone carries this
 *  file's whole state. */
async function ensureVerifierToken(
  attempt: AttemptRow, idempotencyKey: string, principal: string,
): Promise<{ token: string | null; alreadyIssued: boolean }> {
  if (attempt.verification?.verifier_token_id) return { token: null, alreadyIssued: true };

  const opened: IdempotencyOutcome<{ id: string; token: string }> = await withIdempotency(
    principal, "release_verify", idempotencyKey, { release_attempt_id: attempt.id, phase: "open" },
    async (client): Promise<MutatorOutcome<{ id: string; token: string }>> => {
      const token = mintVerifierToken();
      // No fixed expiry policy of its own — release_verify has no liveness-bound "opened_at" to
      // anchor one against the way candidate_prove's own policy.wallClockHours does, so this
      // reuses the same generous default candidate_prove's own token would have carried, wide
      // enough that a post-release verification run is never cut off mid-flight by the token
      // alone (the protocol's own wallClockHours bound is what actually ends verification).
      const expiresAt = new Date(Date.now() + 24 * 3_600_000).toISOString();
      const row = (await client.query<{ id: string }>(`
        insert into zz.replay_verifier_token (token_hash, candidate_id, expires_at, created_at)
        values ($1, $2::uuid, $3, now()) returning id::text as id`,
        [sha256(token), attempt.candidate_id, expiresAt])).rows[0];
      if (!row) throw new Error("insert into zz.replay_verifier_token produced no row");
      await client.query(
        `update zz.release_attempt set verification = coalesce(verification, '{}'::jsonb) || $2::jsonb where id = $1::uuid`,
        [attempt.id, JSON.stringify({ verifier_token_id: row.id })]);
      return { result: { id: row.id, token }, result_table: "zz.replay_verifier_token", result_id: row.id };
    },
  );
  return { token: opened.replayed ? null : opened.result.token, alreadyIssued: opened.replayed };
}

/** FR-58: the same soft `writeBranchFacts` wrapper `candidate-search.ts`/`candidate-prove.ts`
 *  use for their own nothing-to-promote terminal states. In practice this arm is unreachable —
 *  `release_prepare` (release.ts) already requires `initiative` and already set release_mode:
 *  promotable before this attempt's own release_attempt row could exist, so `writeBranchFacts`
 *  here refuses (soft, folded into `facts_refused`) rather than writes. Implemented for the
 *  symmetry the task names explicitly (candidate_search, candidate_prove, release_verify), and
 *  so a future caller of `release_verify` standing on facts release_prepare never wrote — a
 *  hand-seeded release_attempt, say — is not left with an undetermined branch either. */
async function recordNothingToPromote(
  initiative: string | undefined,
): Promise<{ facts_recorded?: boolean; facts?: Record<string, string>; facts_refused?: string }> {
  if (!initiative) return {};
  const written = await writeBranchFacts(initiative, { release_mode: "not_applicable" });
  return typeof written === "string"
    ? { facts_recorded: false, facts_refused: written }
    : { facts_recorded: true, facts: written };
}

/** The one ledger write a resolution ever makes: a `zz.candidate_evaluation` row (`split:
 *  'post_release'`) plus `zz.release_attempt.verification`. CAS'd on `verification is null` (or,
 *  for the rare row that only ever held `{verifier_token_id}` from `ensureVerifierToken` above,
 *  on it carrying no `verdict` yet) — two concurrent resolving calls against the same attempt
 *  must produce at most one `post_release` evaluation, the same property `candidate_prove`'s own
 *  `resolveOutcome` CAS keeps for `proof`. The loser throws before ever inserting; its own caller
 *  falls through to the read-back path on its next call. */
async function resolveVerify(
  p: pg.Pool, attempt: AttemptRow, idempotencyKey: string, principal: string,
  outcome: {
    readonly verdict: "established" | "rolled_back" | "not_established";
    readonly reason: string;
    readonly evidence: { deltas_summary: unknown; guardrails: unknown };
    readonly rollback_plan: RollbackPlan | null;
    readonly dimension_scores: unknown;
    readonly guardrails: unknown;
    readonly statistics: unknown;
    readonly resource_usage: unknown;
  },
  initiative?: string,
): Promise<VerifyOutcome> {
  const verification: VerificationState = {
    ...(attempt.verification ?? {}),
    verdict: outcome.verdict, reason: outcome.reason, evidence: outcome.evidence,
    rollback_plan: outcome.rollback_plan,
  };

  const ledger: IdempotencyOutcome<{ id: string }> = await withIdempotency(
    principal, "release_verify", idempotencyKey, { release_attempt_id: attempt.id, phase: "resolve" },
    async (client): Promise<MutatorOutcome<{ id: string }>> => {
      const claimed = await client.query(
        `update zz.release_attempt set verification = $2::jsonb
           where id = $1::uuid and not coalesce(verification ? 'verdict', false)
         returning id`,
        [attempt.id, JSON.stringify(verification)]);
      if (!claimed.rows.length) {
        throw new Refusal(
          `ERROR: release_attempt ${attempt.id} already has a resolved verification — another ` +
          "release_verify call already recorded it; call release_verify again to read its current state");
      }
      const row = (await client.query<{ id: string }>(`
        insert into zz.candidate_evaluation
          (candidate_id, split, aggregate_score, dimension_scores, guardrails, statistics, resource_usage, created_at)
        values ($1::uuid, 'post_release', $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, now())
        returning id::text as id`,
        [attempt.candidate_id,
         JSON.stringify({ verdict: outcome.verdict, reason: outcome.reason, evidence: outcome.evidence }),
         JSON.stringify(outcome.dimension_scores), JSON.stringify(outcome.guardrails),
         JSON.stringify(outcome.statistics), JSON.stringify(outcome.resource_usage)])).rows[0];
      if (!row) throw new Error("insert into zz.candidate_evaluation produced no row");
      return { result: { id: row.id }, result_table: "zz.candidate_evaluation", result_id: row.id };
    },
  );

  if (!ledger.replayed) {
    // FR-58: `rolled_back` is the one verdict this call reaches with nothing left standing to
    // promote — the release it would have promoted just got reverted. See the note on
    // `recordNothingToPromote` above for why this arm is unreachable in practice today.
    const facts = outcome.verdict === "rolled_back" ? await recordNothingToPromote(initiative) : {};
    return {
      verdict: outcome.verdict, reason: outcome.reason, evidence: outcome.evidence,
      rollback_plan: outcome.rollback_plan, status: attempt.status, ...facts,
    };
  }
  // Replayed — read the attempt back rather than trust this call's own locally-built `outcome`,
  // the same contract `describeApplyOutcomeForReplay` keeps.
  const fresh = await loadAttempt(p, attempt.id);
  return fresh?.verification ? terminalOutcome(fresh) : terminalOutcome({ ...attempt, verification });
}

const RESAMPLES = 2000;

export async function verifyRelease(
  p: pg.Pool, releaseAttemptId: string, idempotencyKey: string, principal: string,
  initiative?: string,
): Promise<VerifyOutcome | { error: string }> {
  const attempt = await loadAttempt(p, releaseAttemptId);
  if (!attempt) return { error: `ERROR: no release_attempt ${releaseAttemptId}` };

  // Already resolved, on ANY idempotency_key — a rolled_back verdict may since have been
  // executed (status moved to rolled_back by release_record) or may still be sitting released
  // awaiting rollback.ts; either way this is a true read-back, never a re-decision.
  if (attempt.verification?.verdict) return terminalOutcome(attempt);

  if (attempt.status !== "released" && attempt.status !== "rolled_back") {
    return {
      error: `ERROR: not_released — release_attempt ${releaseAttemptId} is ${attempt.status}, not ` +
        "released; post-release verification only runs against an attempt release_record has " +
        "already moved to released",
    };
  }
  if (!attempt.released_subject_version_id) {
    return { error: `ERROR: release_attempt ${releaseAttemptId} carries no released_subject_version_id to verify` };
  }

  const candidate = await loadCandidate(p, attempt.candidate_id);
  if (!candidate) return { error: `ERROR: candidate ${attempt.candidate_id} no longer exists` };

  const modelBacked = await protocolHasModelBackedMeasure(p, attempt.base_subject_version_id);
  if (!modelBacked.ok) return { error: modelBacked.error };

  const ctx = await loadVerifyContext(p, candidate);
  if (!ctx.ok) return { error: ctx.error };

  const caseIds = await proofCaseIds(p, ctx.caseSetId);

  // FR-50: "no rollback without evidence" — below the protocol's own proof-case floor, no amount
  // of replaying ever changes the answer, so this resolves immediately with no token ever minted.
  if (caseIds.length < ctx.minProofCases) {
    return resolveVerify(p, attempt, idempotencyKey, principal, {
      verdict: "not_established", reason: "insufficient_proof_cases",
      evidence: { deltas_summary: null, guardrails: null }, rollback_plan: null,
      dimension_scores: null, guardrails: null, resource_usage: null,
      statistics: { available_held_cases: caseIds.length, required_minimum: ctx.minProofCases },
    });
  }

  // Anchored on the release_attempt's own created_at — release_verify has no improvement_run
  // clock of its own to reuse the way candidate_validate/candidate_prove reuse
  // improvement_run.created_at, and this attempt's own row is the closest durable "verification
  // started around here" marker this schema carries.
  const boundReached = Date.now() - new Date(attempt.created_at).getTime() >= ctx.policy.wallClockHours * 3_600_000;

  const plan = await planVerify(p, caseIds, attempt.base_subject_version_id, attempt.released_subject_version_id, ctx.policy.minRepeats);
  if (plan.kind === "pending") {
    // Unlike candidate_validate/candidate_prove — which wait indefinitely for missing repeats,
    // because nothing is live at risk before a candidate is ever released — a real released
    // subject may be regressed RIGHT NOW while replay evidence never arrives (a stuck IMPROVE
    // agent, an exhausted sandbox budget). FR-50's own "if replays are unavailable, the verdict
    // is not_established with a reason" governs the missing-runs case too, not only a resolved-
    // but-unresolved statistical interval, so the liveness bound is checked here as well.
    if (boundReached) {
      return resolveVerify(p, attempt, idempotencyKey, principal, {
        verdict: "not_established", reason: "replays_unavailable",
        evidence: { deltas_summary: null, guardrails: null }, rollback_plan: null,
        dimension_scores: null, guardrails: null, resource_usage: null,
        statistics: { runs_required: plan.runs_required, liveness_bound_reached: true },
      });
    }
    const ensured = await ensureVerifierToken(attempt, idempotencyKey, principal);
    return {
      verdict: null, reason: null, evidence: null, rollback_plan: null,
      runs_required: plan.runs_required, verifier_token: ensured.token,
      token_already_issued: ensured.alreadyIssued, status: attempt.status,
    };
  }

  const deltas = plan.perCase.map((c) => c.delta);
  const decision = pairedDecision(deltas, 0, { resamples: RESAMPLES, seed: releaseAttemptId, confidence: ctx.policy.confidence });

  if (decision.verdict === "unresolved" && !boundReached) {
    return {
      verdict: null, reason: null, evidence: null, rollback_plan: null,
      runs_required: escalateOneRepeat(plan.perCase.map((c) => c.case_id), attempt.base_subject_version_id, attempt.released_subject_version_id),
      verifier_token: null, token_already_issued: true, status: attempt.status,
    };
  }

  const guardrailSummary = summariseGuardrails(plan.released);
  const guardrailFailed = guardrailSummary.status === "fail";
  const dimension_scores = summariseDimensions(plan.prior, plan.released);
  const resource_usage = summariseResourceUsage(plan.prior, plan.released, candidate.complexity_delta);
  const statistics = {
    per_case: plan.perCase, paired_decision: decision, policy: ctx.policy,
    resamples: RESAMPLES, seed: releaseAttemptId, liveness_bound_reached: boundReached,
  };
  const deltas_summary = { mean_delta: decision.mean, lower: decision.lower, upper: decision.upper, verdict: decision.verdict };

  // FR-9/FR-23 (Task I-29's own fix dispatch), the same reason candidate-prove.ts's own proof
  // resolution short-circuits on this: a critical guardrail this held-case replay evidence never
  // measured is missing evidence, not a verified regression — reported honestly here rather than
  // folded into `established` (silently treating an unmeasurable guardrail as passed, which would
  // let a release the protocol cannot actually vouch for stand unverified) or into `rolled_back`
  // (treating it as a proven failure it was never shown to be).
  if (guardrailSummary.status === "not_established") {
    return resolveVerify(p, attempt, idempotencyKey, principal, {
      verdict: "not_established", reason: "guardrails_not_established",
      evidence: { deltas_summary, guardrails: guardrailSummary }, rollback_plan: null,
      dimension_scores, guardrails: guardrailSummary, resource_usage, statistics,
    });
  }

  if (decision.verdict === "unresolved" && boundReached) {
    // Every case cleared minRepeats, but the interval still straddles zero at the liveness bound
    // — a real answer (FR-50's own "no rollback without evidence"), never an indefinite wait.
    return resolveVerify(p, attempt, idempotencyKey, principal, {
      verdict: "not_established", reason: "verification_unresolved",
      evidence: { deltas_summary, guardrails: guardrailSummary }, rollback_plan: null,
      dimension_scores, guardrails: guardrailSummary, resource_usage, statistics,
    });
  }

  const rolledBack = rollbackDecision({
    deltas, guardrail_failed: guardrailFailed, resamples: RESAMPLES, seed: releaseAttemptId,
  });

  if (!rolledBack) {
    return resolveVerify(p, attempt, idempotencyKey, principal, {
      verdict: "established", reason: "no_regression_established",
      evidence: { deltas_summary, guardrails: guardrailSummary }, rollback_plan: null,
      dimension_scores, guardrails: guardrailSummary, resource_usage, statistics,
    }, initiative);
  }

  const prior = await loadSubjectDesc(p, attempt.base_subject_version_id);
  const rollbackPlan: RollbackPlan | null = prior ? {
    plugin: prior.plugin, declared_version: prior.declared_version,
    prior_subject_version_id: attempt.base_subject_version_id, branch: rollbackBranchFor(attempt.id),
  } : null;

  return resolveVerify(p, attempt, idempotencyKey, principal, {
    verdict: "rolled_back", reason: guardrailFailed ? "guardrail_failed" : "regression_established",
    evidence: { deltas_summary, guardrails: guardrailSummary }, rollback_plan: rollbackPlan,
    dimension_scores, guardrails: guardrailSummary, resource_usage, statistics,
  }, initiative);
}
