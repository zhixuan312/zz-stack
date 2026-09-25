/**
 * `candidate_prove`'s own planning + statistics (Task I-21, FR-28, FR-43, AC-28.1, AC-43.1): the
 * sealed proof a selected candidate opens exactly once. Kept apart from `candidates.ts` the same
 * way `candidate-validate.ts` and `candidate-search.ts` already are — every decision this
 * contract asks for lives here, `candidates.ts` keeps only the tool's own registration.
 *
 * Two calls, never one blocking round trip (the plan's own words, mirrored from
 * `candidate_validate`'s own split): a first call against a `selected` candidate MINTS a
 * `verifier_token` (migration 079's `zz.replay_verifier_token`, real validation `replay-runs.ts`
 * has been checking against since Task I-16 — nothing before this file ever inserted a row there)
 * bound to the allocation's candidate and case set (migration 088), and moves the candidate to
 * `proving`, returning the token, the case set and how many runs each side still needs — COUNTS
 * only, never a proof case id: the IMPROVE agent drives `replay_start(context: "verifier",
 * verifier_token)` that many times per side, and `replay_start` draws each proof case
 * server-side (`replay-verifier.ts`, whose module note states what the token can reach and the
 * residual it leaves). A LATER call, once enough proof-split `zz.replay_run` rows are
 * `completed` and scored, computes `proof_status` from them and stores it. Never an executor
 * itself — exactly the planner/reducer split `candidate_validate` already keeps from the
 * launcher.
 *
 * Reused wholesale from `candidate-validate.ts`: `mean`, `groupByCase`, `baselineRuns`,
 * `candidateRuns`, `escalateOneRepeat`, `summariseGuardrails`, `summariseResourceUsage`,
 * `summariseDimensions` and `protocolHasModelBackedMeasure` — none of them hard-code a split
 * literal, so a proof run is scored by the SAME machinery a validation run is, over case ids this
 * file resolves to `split: 'proof'` instead. `pairedDecision` (`stats.ts`) is the same pure
 * bootstrap both files feed. `screenLeakage` (`candidate-leakage.ts`) is the SAME critic
 * `candidate_validate` ran before this candidate was built — asked again here, once, before the
 * resolving transaction opens, and recorded inside it; at proof an inconclusive answer is
 * `leakage_unresolved`, never a pass. The verdict itself is `candidate-prove-decide.ts`.
 *
 * FR-28's "one opening" is also a fact about the CASES, not only the candidate: opening proof
 * claims the case set's proof split (`zz.replay_case_set.proof_spent_*`, migration 088), so no
 * second candidate opens the same sealed cases while this one is proving. Resolution decides
 * whether the claim becomes spent for good (`proofSplitSpent`, `candidate-prove-decide.ts`): a
 * sealed proof leaks at most one bit per resolved decision, so `proof_passed`/`proof_failed`
 * spend it, and so does a `not_established` outcome whose runs executed on the proof cases (they
 * observed them). A `not_established` outcome where no run ever executed, or where the only gap
 * was an `unavailable` leakage answer, releases it for a fresh improvement_start.
 *
 * FR-28's own "spent allocation refuses a second opening": once a candidate reaches
 * `proof_passed` or `proof_failed`, a call with a KEY THIS ALLOCATION HAS NEVER SEEN refuses
 * outright. FR-59 still governs it, though: a call whose key/digest is the exact one that
 * produced the resolution is a retry of that same call, not a second opening, and reads the
 * stored `zz.candidate_evaluation` row back rather than refusing it — `lookupRow` (`idempotency.ts`,
 * exported for exactly this file) is read directly, outside `withIdempotency`'s own proceed/
 * replay/conflict decision, because the status gate above would otherwise refuse the retry before
 * `withIdempotency` ever got to recognise it. The mint call and the resolve call both digest
 * `{candidate_id, phase}` — never bare `{candidate_id}` — so a caller who (wrongly) reuses the
 * OPEN key for what is now a resolve, or vice versa, gets `idempotency_conflict` rather than a
 * false replay that would hand back the wrong table's row under the other call's own response
 * shape.
 *
 * `candidate.status` DOES carry a separate `proof_not_established` value (migration 081, fix
 * dispatch on this same task): an unestablished proof — too few proof cases
 * (`insufficient_proof_cases`), an interval that never resolved by the liveness bound
 * (`proof_unresolved`), or an allocation nobody could finish (`abandoned`, below) — is spent
 * for this candidate exactly as a statistically failed one is (`SPENT_STATUSES` covers all
 * three; a second `candidate_prove` call against any of them refuses or reads back, never
 * re-opens — whether the CASE SET's proof split stays spent is the rule above), but it is
 * NOT a rejected hypothesis. `REJECTED_CANDIDATE_STATUSES` (`proposer-bundle.ts`) deliberately
 * leaves `proof_not_established` out — an evidence gap is not FR-38's "already rejected idea" —
 * so `candidate_record` refuses to re-record only a genuinely `proof_failed` hypothesis; a
 * `proof_not_established` one may be proposed again under a fresh `improvement_start`
 * (`zz.improvement_run` row), exactly as FR-28's "a resumed search restarts from the pre-proof
 * history" already requires. `loadProposerBundle` (`proposer-bundle.ts`) goes one step further
 * and excludes BOTH `proof_failed` and `proof_not_established` from what a proposer/search
 * session ever reads back as `prior_rejected_hypotheses` — FR-28's "proof results must not be
 * fed back into search" covers an unestablished proof exactly as it covers a failed one, even
 * though `proof_not_established` alone does not block `candidate_record`'s own re-proposal.
 *
 * `candidate_prove(candidate_id, abandon: true, idempotency_key)` (this same fix dispatch, FR-28)
 * is this file's recovery path for a lost response: if the caller of the call that opened proof
 * (minted the verifier_token, moved `proving`) never saw its own reply, the allocation is stuck
 * `proving` with a token nobody holds and no ordinary `candidate_prove` call ever resolves it —
 * every remaining branch needs proof-split replay evidence nothing can now produce. `abandon`
 * resolves it as `not_established, reason: "abandoned"` through the SAME `resolveOutcome`
 * transaction every other terminal outcome uses (own idempotency phase, `cancelProofRuns` tears
 * down whatever the token already spawned), so a later search needs a new allocation, per FR-28.
 */
import { randomBytes } from "node:crypto";

import { sha256, ThreeWaySplitPolicy } from "@zz/contracts";
import type pg from "pg";

import {
  baselineRuns, candidateRuns, groupByCase, mean, protocolHasModelBackedMeasure,
  summariseDimensions, summariseGuardrails, summariseResourceUsage,
  type PerCaseDelta, type SideRun,
} from "./candidate-validate.js";
import { screenLeakage } from "./candidate-leakage.js";
import { needsMoreRepeats, proofSplitSpent, proofVerdict } from "./candidate-prove-decide.js";
import type { TouchedComponent } from "./complexity.js";
import {
  lookupRow, withIdempotency, type IdempotencyOutcome, type IdempotencyRow, type MutatorOutcome,
} from "./idempotency.js";
import { writeBranchFacts } from "./protocol.js";
import { parseSearchPolicy } from "./search-rules.js";
import { pairedDecision, type PairedDecisionResult } from "./stats.js";
import { db } from "../platform-db.js";
import { Refusal } from "../refusal.js";
import { insertEvaluatorAnswer, type AskedEvaluatorAnswer } from "../semantic.js";
import { abandonProof } from "./candidate-prove-abandon.js";

// -------------------------------------------------------------------------------------------
// Candidate + its proof policy.

export interface CandidateRow {
  readonly id: string;
  readonly status: string;
  readonly improvement_run_id: string;
  readonly base_subject_version_id: string;
  readonly complexity_delta: number;
  readonly hypothesis: string;
  readonly diff: string;
  readonly touched_components: readonly TouchedComponent[];
  readonly touched_owners: readonly string[];
}

async function loadCandidate(p: pg.Pool, candidateId: string): Promise<CandidateRow | null> {
  const row = (await p.query<{
    id: string; status: string; improvement_run_id: string; base_subject_version_id: string;
    complexity_delta: number; hypothesis: string; diff: string | null;
    touched_components: TouchedComponent[] | null; touched_owners: string[] | null;
  }>(`
    select id::text as id, status, improvement_run_id::text as improvement_run_id,
           base_subject_version_id::text as base_subject_version_id, complexity_delta, hypothesis,
           patchset->>'diff' as diff, touched_components, touched_owners
      from zz.candidate where id = $1::uuid`, [candidateId])).rows[0];
  if (!row) return null;
  return {
    id: row.id, status: row.status, improvement_run_id: row.improvement_run_id,
    base_subject_version_id: row.base_subject_version_id, complexity_delta: row.complexity_delta,
    hypothesis: row.hypothesis, diff: row.diff ?? "",
    touched_components: row.touched_components ?? [], touched_owners: row.touched_owners ?? [],
  };
}

interface ProofPolicy { readonly minRepeats: number; readonly mme: number; readonly confidence: number; readonly wallClockHours: number }

// Proof reads `SearchPolicy` (never a fallback — `search-rules.ts`) rather than the freeform
// `ProofPolicy` column: spec v8 fixes no shape for that column beyond "an object", while
// `SearchPolicy.minRepeats/minMeaningfulEffect/confidence` are exactly FR-57's own frozen
// numbers — a second, parallel shape for the same three would be a policy nobody agreed to.

const DEFAULT_SPLIT_POLICY = {
  evolve: 0.4, validation: 0.3, proof: 0.3, min: { evolve: 5, validation: 10, proof: 10 },
} as const;

type ProofContext =
  | {
      readonly ok: true; readonly caseSetId: string; readonly minProofCases: number;
      readonly policy: ProofPolicy; readonly improvementRunCreatedAt: Date;
    }
  | { readonly ok: false; readonly error: string };

/** The same join `candidate-validate.ts`'s own `loadValidationContext` resolves the validation
 *  case set through — `improvement_run -> eval_run -> eval_evidence_snapshot.case_set_version_id`
 *  — plus, additionally, the plugin's newest protocol version's own `splitPolicy.min.proof`
 *  (`replay_policy.splitPolicy`, the same column `replay-cases.ts`'s own `splitPolicyOf` reads at
 *  case-set-build time): FR-57's "below a minimum" is a floor on how many proof cases EXIST, not
 *  on how many repeats have run against them, and that floor is knowable before a single replay
 *  is planned. */
async function loadProofContext(p: pg.Pool, candidate: CandidateRow): Promise<ProofContext> {
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
        "before a candidate from this run can be proved",
    };
  }

  const subjectRow = (await p.query<{ plugin_id: string }>(
    "select plugin_id::text as plugin_id from zz.eval_subject_version where id = $1::uuid",
    [candidate.base_subject_version_id])).rows[0];
  const protocolRow = subjectRow ? (await p.query<{ replay_policy: unknown }>(`
    select epv.replay_policy
      from zz.eval_protocol_version epv
      join zz.eval_protocol ep on ep.id = epv.protocol_id
     where ep.plugin_id = $1::uuid
     order by epv.version desc limit 1`, [subjectRow.plugin_id])).rows[0] : undefined;
  const splitParsed = ThreeWaySplitPolicy.safeParse(
    (protocolRow?.replay_policy as { splitPolicy?: unknown } | null)?.splitPolicy);
  const minProofCases = splitParsed.success ? splitParsed.data.min.proof : DEFAULT_SPLIT_POLICY.min.proof;

  const searchParsed = parseSearchPolicy(run.search_policy, candidate.improvement_run_id);
  if ("error" in searchParsed) return { ok: false, error: searchParsed.error };
  const policy: ProofPolicy = {
    minRepeats: searchParsed.minRepeats, mme: searchParsed.minMeaningfulEffect,
    confidence: searchParsed.confidence, wallClockHours: searchParsed.wallClockHours,
  };

  return {
    ok: true, caseSetId: snapshot.case_set_version_id, minProofCases, policy,
    improvementRunCreatedAt: new Date(run.created_at),
  };
}

async function proofCaseIds(p: pg.Pool, caseSetId: string): Promise<string[]> {
  return (await p.query<{ case_id: string }>(`
    select id::text as case_id from zz.replay_case
     where case_set_id = $1::uuid and split = 'proof' and status = 'replayable'
     order by id`, [caseSetId])).rows.map((r) => r.case_id);
}

// -------------------------------------------------------------------------------------------
// Planning: which proof (case, side) pairs still need a completed, scored replay_run — the exact
// shape `candidate-validate.ts`'s own `planValidation` computes, rebuilt here because that
// function re-derives its own case ids internally (hard-coded to `split = 'validation'`) rather
// than taking them as an argument; everything it calls (`baselineRuns`/`candidateRuns`/
// `groupByCase`/`mean`) is reused unchanged.

/** What the caller still has to run, as COUNTS per side — never a proof case id (FR-30):
 *  `replay_start` under the verifier_token draws each case itself. `case_set_id` is what that
 *  `replay_start` names. */
interface ProofRunsRequired { readonly case_set_id: string; readonly baseline: number; readonly candidate: number }

type Plan =
  | { readonly kind: "pending"; readonly runs_required: ProofRunsRequired }
  | { readonly kind: "resolved"; readonly perCase: PerCaseDelta[]; readonly baseline: SideRun[]; readonly candidateSide: SideRun[] };

async function planProof(
  p: pg.Pool, candidate: CandidateRow, caseSetId: string, caseIds: readonly string[], minRepeats: number,
): Promise<Plan> {
  const baseline = await baselineRuns(p, caseIds, candidate.base_subject_version_id);
  const candidateSide = await candidateRuns(p, caseIds, candidate.id);
  const byBaseline = groupByCase(baseline);
  const byCandidate = groupByCase(candidateSide);

  let baselineShort = 0;
  let candidateShort = 0;
  const perCase: PerCaseDelta[] = [];
  for (const caseId of caseIds) {
    const b = byBaseline.get(caseId) ?? [];
    const k = byCandidate.get(caseId) ?? [];
    baselineShort += Math.max(minRepeats - b.length, 0);
    candidateShort += Math.max(minRepeats - k.length, 0);
    if (b.length >= minRepeats && k.length >= minRepeats) {
      const baseline_mean = mean(b.map((r) => r.overall));
      const candidate_mean = mean(k.map((r) => r.overall));
      perCase.push({ case_id: caseId, baseline_mean, baseline_n: b.length, candidate_mean, candidate_n: k.length, delta: candidate_mean - baseline_mean });
    }
  }
  if (baselineShort || candidateShort) {
    return { kind: "pending", runs_required: { case_set_id: caseSetId, baseline: baselineShort, candidate: candidateShort } };
  }
  return { kind: "resolved", perCase, baseline, candidateSide };
}

// -------------------------------------------------------------------------------------------
// Verifier token minting (FR-28, FR-31's own words: "a fresh verifier session with no proposer/
// search capability"). Hashed exactly the way `zz.pat` is (`replay-runs.ts`'s own
// `verifyVerifierToken`, real validation since Task I-16) — the plaintext is returned once here
// and never stored again.

const VERIFIER_TOKEN_BYTES = 32;

/** Not `mintPat()` (`@zz/contracts`): that mints a `zzpat_`-branded platform credential recorded
 *  in `zz.pat`, checked by the gateway's own PAT auth on every door. A verifier_token is neither —
 *  it is a bare secret recorded in `zz.replay_verifier_token` and checked by exactly one function
 *  (`verifyVerifierToken`, `replay-runs.ts`) as a call ARGUMENT, never as request authentication.
 *  Branding it as a PAT would claim an authority it does not carry. */
function mintVerifierToken(): string {
  return randomBytes(VERIFIER_TOKEN_BYTES).toString("hex");
}

// -------------------------------------------------------------------------------------------
// The tool's own result shape and orchestrator.

export interface CandidateProveOutcome {
  readonly proof_status: "proof_passed" | "proof_failed" | "not_established" | null;
  readonly reason: string | null;
  readonly release_eligible: boolean;
  readonly candidate_evaluation_id: string | null;
  readonly verifier_token: string | null;
  readonly token_already_issued: boolean;
  readonly runs_required?: ProofRunsRequired;
  readonly status: string;
  /** On a resolution: whether the case set's sealed proof split stays spent or was released. */
  readonly proof_split?: "spent" | "released";
  readonly facts_recorded?: boolean;
  readonly facts?: Record<string, string>;
  readonly facts_refused?: string;
}

/** FR-58: the same soft `writeBranchFacts` wrapper `candidate-search.ts` uses — a conflict is
 *  folded into `facts_refused`, never raised. `initiative_fact` is append-only, so this is
 *  written only for an outcome nothing in this initiative resumes from (see the call site). */
async function recordNothingToPromote(
  initiative: string | undefined,
): Promise<{ facts_recorded?: boolean; facts?: Record<string, string>; facts_refused?: string }> {
  if (!initiative) return {};
  const written = await writeBranchFacts(initiative, { release_mode: "not_applicable" });
  return typeof written === "string"
    ? { facts_recorded: false, facts_refused: written }
    : { facts_recorded: true, facts: written };
}

const OPEN_STATUSES = new Set(["selected", "proving"]);
export const SPENT_STATUSES = new Set(["proof_passed", "proof_failed", "proof_not_established"]);

/** Records the proof allocation's terminal outcome — the ONE ledger write this call makes,
 *  whatever combination of leakage/statistics/guardrails/ownership (or `abandonProof`) decided
 *  it. `candidate.status` moves to `proof_passed`, `proof_not_established` (migration 081 —
 *  `insufficient_proof_cases`, `proof_unresolved` and `abandoned` all land here: an evidence gap,
 *  never a rejected hypothesis) or `proof_failed` (a real statistical/leakage/guardrail
 *  rejection) — and `improvement_run.status` moves to `ready_for_approval` (passed AND an owner
 *  exists to approve it), `closed` (passed but no release_owners are recorded for this base
 *  subject's plugin — a proposal-only outcome, FR-51) or `proof_failed` (every other terminal
 *  outcome, `not_established` included — 077 gives `zz.improvement_run` no third status and this
 *  dispatch's contract is the candidate's own status column, not the run's) — the same "one
 *  transaction, both tables" shape `candidate-search.ts`'s own `runCandidateSearch` already uses
 *  for `selected`/`closed`. The same transaction keeps or releases the case set's proof split
 *  (`proofSplitSpent`). `phase` defaults to `"resolve"`; `abandonProof` passes `"abandon"` so
 *  the two calls never share a digest (see the module note and `readBackIfSameResolve`'s own
 *  comment on why phases must not collide). */
export async function resolveOutcome(
  candidate: CandidateRow, idempotencyKey: string, principal: string,
  outcome: {
    readonly proof_status: "proof_passed" | "proof_failed" | "not_established";
    readonly reason: string;
    readonly release_eligible: boolean;
    readonly decision: PairedDecisionResult | null;
    readonly guardrails: unknown;
    readonly resource_usage: unknown;
    readonly dimension_scores: unknown;
    readonly statistics: unknown;
    /** Whether any run of this allocation executed on a proof case (`proofSplitSpent`) — or
     *  the allocations whose runs decide it, counted inside this transaction after the token is
     *  revoked (`abandonProof`), so a run registered before the count is always seen. */
    readonly observed: boolean | { readonly allocations: readonly string[] };
    /** The proof-time leakage answer, recorded in this transaction so it rolls back with it. */
    readonly leakage_assessment?: AskedEvaluatorAnswer;
  },
  phase: "resolve" | "abandon" = "resolve",
  initiative?: string,
): Promise<CandidateProveOutcome> {
  const candidateStatus = outcome.proof_status === "proof_passed" ? "proof_passed"
    : outcome.proof_status === "not_established" ? "proof_not_established" : "proof_failed";
  const runStatus = outcome.proof_status === "proof_passed"
    ? (outcome.release_eligible ? "ready_for_approval" : "closed")
    : "proof_failed";
  // screenLeakage's own reading rule: no reading from the critic is `unavailable`.
  const leakageReading = outcome.leakage_assessment
    ? outcome.leakage_assessment.result.reading ?? "unavailable" : null;
  let splitSpent = typeof outcome.observed === "boolean"
    ? proofSplitSpent(outcome.proof_status, outcome.observed, leakageReading) : true;

  const ledgerOutcome: IdempotencyOutcome<{ id: string }> = await withIdempotency(
    // phase: "resolve"/"abandon" — never bare {candidate_id} — so a caller who reuses the OPEN
    // call's own key here, or an abandon key for an ordinary resolve or vice versa, gets
    // idempotency_conflict (a different digest under the same key) rather than a false replay
    // against zz.replay_verifier_token's row id, which this call's own reader below would misread
    // as a candidate_evaluation id. See the module note.
    principal, "candidate_prove", idempotencyKey, { candidate_id: candidate.id, phase },
    async (client): Promise<MutatorOutcome<{ id: string }>> => {
      // CAS, checked first: two concurrent resolving calls (two different candidate_prove
      // requests, each with its own idempotency_key, racing the SAME candidate) must produce at
      // most one zz.candidate_evaluation row — AC-28.1's own "once per proof allocation." The
      // loser's own UPDATE matches zero rows once the winner's has committed 'proof_passed'/
      // 'proof_failed', and this throws before ever inserting — the same CAS-via-UPDATE shape
      // `candidate-validate.ts`'s own `acquireValidatingLock` (Fix 5, that file's module note)
      // uses, applied here inside the transaction rather than as a standalone statement, because
      // resolution is exactly the row this call's own ledger entry is about.
      //
      // status = any('selected','proving'): resolveOutcome's own caller reaches this from BOTH —
      // the insufficient-proof-cases fast path resolves a candidate that never left `selected`
      // (it is refused before the open/mint step ever runs), while every other path resolves a
      // `proving` one. `OPEN_STATUSES` names the same pair for the same reason at the top of
      // this file; both are "not yet spent," which is the only thing this CAS cares about.
      const claimed = await client.query(
        "update zz.candidate set status = $2 where id = $1::uuid and status = any($3::text[])",
        [candidate.id, candidateStatus, [...OPEN_STATUSES]]);
      if ((claimed.rowCount ?? 0) === 0) {
        throw new Refusal(
          `ERROR: candidate ${candidate.id} is no longer open for proof — another candidate_prove ` +
          "call already resolved this allocation; call candidate_prove again to read its current state");
      }
      if (outcome.leakage_assessment) await insertEvaluatorAnswer(client, outcome.leakage_assessment);
      // The allocation is now spent — its verifier_token must not go on authenticating
      // context: "verifier" replay_start calls for the rest of its natural expiry (FR-28's own
      // "refuses a second opening" would otherwise have a side door: the token itself still
      // works even though candidate_prove refuses to open this candidate again). Revoked before
      // any run is counted below, so no run can start after the count on a token still valid.
      await client.query(
        "update zz.replay_verifier_token set revoked_at = now() where candidate_id = $1::uuid and revoked_at is null",
        [candidate.id]);
      let statistics = outcome.statistics;
      if (typeof outcome.observed !== "boolean") {
        const observed = await anyRunOf(client, outcome.observed.allocations);
        splitSpent = proofSplitSpent(outcome.proof_status, observed, leakageReading);
        statistics = { ...(outcome.statistics as Record<string, unknown>), proof_runs_executed: observed };
      }
      const row = (await client.query<{ id: string }>(`
        insert into zz.candidate_evaluation
          (candidate_id, split, aggregate_score, dimension_scores, guardrails, statistics, resource_usage, created_at)
        values ($1::uuid, 'proof', $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, now())
        returning id::text as id`,
        [candidate.id,
         JSON.stringify({
           proof_status: outcome.proof_status, reason: outcome.reason, release_eligible: outcome.release_eligible,
           mean_delta: outcome.decision?.mean ?? null, lower: outcome.decision?.lower ?? null,
           upper: outcome.decision?.upper ?? null, verdict: outcome.decision?.verdict ?? null,
         }),
         JSON.stringify(outcome.dimension_scores), JSON.stringify(outcome.guardrails),
         JSON.stringify(statistics), JSON.stringify(outcome.resource_usage)])).rows[0];
      if (!row) throw new Error("insert into zz.candidate_evaluation produced no row");
      await client.query("update zz.improvement_run set status = $2 where id = $1::uuid", [candidate.improvement_run_id, runStatus]);
      // The opening's claim on the case set's proof split: kept (spent) or released, by
      // proofSplitSpent. Keyed on the claimant, so an allocation that never opened (the
      // insufficient-proof-cases path) touches nothing.
      if (!splitSpent) {
        await client.query(`
          update zz.replay_case_set set proof_spent_at = null, proof_spent_by_candidate_id = null
           where proof_spent_by_candidate_id = $1::uuid`, [candidate.id]);
      }
      return { result: { id: row.id }, result_table: "zz.candidate_evaluation", result_id: row.id };
    },
  );
  const candidateEvaluationId = ledgerOutcome.replayed ? ledgerOutcome.result_id : ledgerOutcome.result.id;
  const proofSplit = ledgerOutcome.replayed && typeof outcome.observed !== "boolean"
    ? await proofSplitOf(db() as pg.Pool, candidate.id) : splitSpent ? "spent" : "released";

  // FR-58: `release_mode: not_applicable` is append-only, so it is written only when this
  // initiative has nothing left to resume. A genuine `proof_failed` spends the allocation and the
  // hypothesis. A `not_established` outcome (insufficient cases, unresolved, leakage unresolved,
  // abandoned) is an evidence gap: its hypothesis may be re-proposed under a fresh
  // improvement_start in this same initiative, and a fact written now would block that search's
  // own release. A non-owned candidate still has proposal_prepare open to it either way.
  const facts = outcome.proof_status === "proof_failed" && phase === "resolve" && candidate.touched_owners.length > 0
    ? await recordNothingToPromote(initiative) : {};

  return {
    proof_status: outcome.proof_status, reason: outcome.reason, release_eligible: outcome.release_eligible,
    candidate_evaluation_id: candidateEvaluationId, verifier_token: null, token_already_issued: true,
    status: candidateStatus, proof_split: proofSplit, ...facts,
  };
}

export interface StoredProofEvaluation {
  readonly id: string;
  readonly aggregate_score: {
    proof_status: "proof_passed" | "proof_failed" | "not_established";
    reason: string; release_eligible: boolean;
  };
}

/** FR-59 on an already-spent candidate: a retry of the EXACT call that spent it (same key, same
 *  digest) is a replay, not a second opening, and must answer the same result it did the first
 *  time — `lookupRow` reads the ledger directly because the status gate in `proveCandidate` would
 *  otherwise refuse this retry before `withIdempotency` ever got a chance to recognise it as one.
 *  Null when the key names no row, or names one that is not this candidate's own resolving write
 *  (an unrelated key collision `withIdempotency`'s own `(principal, tool, key)` primary key
 *  already rules out in practice, but never trusted here without the `candidate_evaluation_id`
 *  match) — either way the caller falls through to the ordinary "allocation spent" refusal. */
async function readBackIfSameResolve(
  p: pg.Pool, candidateId: string, idempotencyKey: string, principal: string,
): Promise<CandidateProveOutcome | null> {
  const row: IdempotencyRow | null = await lookupRow(p, principal, "candidate_prove", idempotencyKey);
  if (!row || row.result_table !== "zz.candidate_evaluation") return null;
  const stored = (await p.query<StoredProofEvaluation>(
    "select id::text as id, aggregate_score from zz.candidate_evaluation where id = $1::uuid and candidate_id = $2::uuid",
    [row.result_id, candidateId])).rows[0];
  if (!stored) return null;
  const candStatus = (await p.query<{ status: string }>(
    "select status from zz.candidate where id = $1::uuid", [candidateId])).rows[0]?.status ?? "proof_failed";
  return {
    proof_status: stored.aggregate_score.proof_status, reason: stored.aggregate_score.reason,
    release_eligible: stored.aggregate_score.release_eligible, candidate_evaluation_id: stored.id,
    verifier_token: null, token_already_issued: true, status: candStatus,
    proof_split: await proofSplitOf(p, candidateId),
  };
}

/** True once any of these allocations has a run at all, whatever its status: `replay_start`
 *  draws a sealed proof case and binds it to a session when it registers the run, and a run
 *  already `cancelled` may have been running when it was. Conservative on purpose — a sealed
 *  proof errs toward spent.
 *
 *  The token rows are locked FOR UPDATE first: a `replay_start` whose run insert is in flight
 *  holds a KEY SHARE lock on its token row through the `verifier_allocation_id` foreign key until
 *  it commits, so this waits for that run and then counts it, rather than reading past it. */
async function anyRunOf(client: Pick<pg.PoolClient, "query">, allocations: readonly string[]): Promise<boolean> {
  if (!allocations.length) return false;
  await client.query("select id from zz.replay_verifier_token where id = any($1::uuid[]) for update", [[...allocations]]);
  const row = (await client.query<{ any: boolean }>(
    "select exists (select 1 from zz.replay_run where verifier_allocation_id = any($1::uuid[])) as any",
    [[...allocations]])).rows[0];
  return row?.any ?? false;
}

/** A resolved candidate's `proof_split`, read back: it still holds a case set's split (spent) or
 *  its resolution released it. For a caller that lost the resolving response. */
export async function proofSplitOf(p: pg.Pool, candidateId: string): Promise<"spent" | "released"> {
  const row = (await p.query<{ held: boolean }>(
    "select exists (select 1 from zz.replay_case_set where proof_spent_by_candidate_id = $1::uuid) as held",
    [candidateId])).rows[0];
  return row?.held ? "spent" : "released";
}

export async function proveCandidate(
  p: pg.Pool, candidateId: string, idempotencyKey: string, principal: string, abandon = false,
  initiative?: string,
): Promise<CandidateProveOutcome | { error: string }> {
  const candidate = await loadCandidate(p, candidateId);
  if (!candidate) return { error: `ERROR: no candidate ${candidateId}` };

  if (!OPEN_STATUSES.has(candidate.status) && !SPENT_STATUSES.has(candidate.status)) {
    return { error: "ERROR: only the selected candidate may open proof" };
  }

  if (abandon) return abandonProof(p, candidate, idempotencyKey, principal, initiative);

  if (SPENT_STATUSES.has(candidate.status)) {
    const replay = await readBackIfSameResolve(p, candidateId, idempotencyKey, principal);
    if (replay) return replay;
    return { error: spentAllocationRefusal(candidate) };
  }

  const ctx = await loadProofContext(p, candidate);
  if (!ctx.ok) return { error: ctx.error };

  const modelBacked = await protocolHasModelBackedMeasure(p, candidate.base_subject_version_id);
  if (!modelBacked.ok) return { error: modelBacked.error };

  const caseIds = await proofCaseIds(p, ctx.caseSetId);

  // FR-57: below the proof minimum, no amount of replaying ever changes the answer — resolved
  // immediately, on whichever call first reaches it (open or continuing), with no verifier_token
  // ever minted for it.
  if (caseIds.length < ctx.minProofCases) {
    return resolveOutcome(candidate, idempotencyKey, principal, {
      proof_status: "not_established", reason: "insufficient_proof_cases", release_eligible: false,
      decision: null, guardrails: null, resource_usage: null, dimension_scores: null,
      statistics: { available_proof_cases: caseIds.length, required_minimum: ctx.minProofCases },
      observed: false,
    }, "resolve", initiative);
  }

  // Opening: a `selected` candidate has never had a proof allocation — mint the token and move to
  // `proving`, but never resolve in the same call (the plan's own words: "the first call mints
  // the verifier token and plans the proof runs"), even if, by coincidence, enough runs already
  // existed. This is the call's only ledger write when it fires.
  if (candidate.status === "selected") {
    const spentBy = await caseSetSpentBy(p, ctx.caseSetId);
    if (spentBy && spentBy !== candidateId) return { error: spentRefusal(ctx.caseSetId, spentBy) };
    const opened: IdempotencyOutcome<{ id: string; token: string }> = await withIdempotency(
      // phase: "open" — see the module note on why this and the resolve call never share a digest.
      principal, "candidate_prove", idempotencyKey, { candidate_id: candidateId, phase: "open" },
      async (client): Promise<MutatorOutcome<{ id: string; token: string }>> => {
        // CAS, checked first, same reason and shape as the resolve transaction's own: two
        // concurrent opening calls must mint at most one verifier_token for this allocation
        // (AC-28.1's "once"). The loser's own UPDATE matches zero rows once the winner's has
        // committed 'proving', and this throws before ever minting.
        const claimed = await client.query(
          "update zz.candidate set status = 'proving' where id = $1::uuid and status = 'selected'",
          [candidateId]);
        if ((claimed.rowCount ?? 0) === 0) {
          throw new Refusal(
            `ERROR: candidate ${candidateId} is no longer selected — another candidate_prove call ` +
            "already opened this allocation (or it has since resolved); call candidate_prove again " +
            "to read its current state");
        }
        // This opening claims the case set's proof split (migration 088) — the same CAS shape,
        // so two candidates racing for one case set open it at most once between them. The
        // resolution keeps it spent or releases it (resolveOutcome, proofSplitSpent).
        const spent = await client.query(`
          update zz.replay_case_set set proof_spent_at = now(), proof_spent_by_candidate_id = $2::uuid
           where id = $1::uuid and proof_spent_at is null`, [ctx.caseSetId, candidateId]);
        if ((spent.rowCount ?? 0) === 0) {
          const by = (await client.query<{ by: string | null }>(
            "select proof_spent_by_candidate_id::text as by from zz.replay_case_set where id = $1::uuid",
            [ctx.caseSetId])).rows[0]?.by ?? "another candidate";
          throw new Refusal(spentRefusal(ctx.caseSetId, by));
        }
        const token = mintVerifierToken();
        const expiresAt = new Date(Date.now() + ctx.policy.wallClockHours * 3_600_000).toISOString();
        const row = (await client.query<{ id: string }>(`
          insert into zz.replay_verifier_token (token_hash, candidate_id, case_set_id, expires_at, created_at)
          values ($1, $2::uuid, $3::uuid, $4, now()) returning id::text as id`,
          [sha256(token), candidateId, ctx.caseSetId, expiresAt])).rows[0];
        if (!row) throw new Error("insert into zz.replay_verifier_token produced no row");
        await client.query("update zz.improvement_run set status = 'proofing' where id = $1::uuid", [candidate.improvement_run_id]);
        return { result: { id: row.id, token }, result_table: "zz.replay_verifier_token", result_id: row.id };
      },
    );

    // Plans the FULL minRepeats requirement per case. On a fresh allocation nothing has run yet,
    // so `planProof` computes the real requirement (and, should evidence already exist from a
    // stale prior state, reports none — a later call against the now-`proving` candidate
    // resolves it).
    const openingPlan = await planProof(p, candidate, ctx.caseSetId, caseIds, ctx.policy.minRepeats);
    return {
      proof_status: null, reason: null, release_eligible: false, candidate_evaluation_id: null,
      verifier_token: opened.replayed ? null : opened.result.token, token_already_issued: opened.replayed,
      runs_required: openingPlan.kind === "pending" ? openingPlan.runs_required
        : { case_set_id: ctx.caseSetId, baseline: 0, candidate: 0 },
      status: "proving",
    };
  }

  // Continuing (`proving`): plan from whatever proof-split replay_run rows already exist. Pending
  // evidence is read-only — no ledger row, the same as candidate_validate's own runs_required
  // branch — resolution is the only write.
  const plan = await planProof(p, candidate, ctx.caseSetId, caseIds, ctx.policy.minRepeats);
  const stillProving = (runs_required: ProofRunsRequired): CandidateProveOutcome => ({
    proof_status: null, reason: null, release_eligible: false, candidate_evaluation_id: null,
    verifier_token: null, token_already_issued: true, runs_required, status: "proving",
  });
  if (plan.kind === "pending") return stillProving(plan.runs_required);

  const boundReached = Date.now() - ctx.improvementRunCreatedAt.getTime() >= ctx.policy.wallClockHours * 3_600_000;
  const deltas = plan.perCase.map((c) => c.delta);
  const decision = pairedDecision(deltas, ctx.policy.mme, { resamples: 2000, seed: candidateId, confidence: ctx.policy.confidence });

  // One more repeat per case per side — but only after an accepted pruning trade-off has had
  // its look (candidate-prove-decide.ts): that one is settled, not undecided.
  if (needsMoreRepeats(decision, candidate.complexity_delta, boundReached)) {
    return stillProving({ case_set_id: ctx.caseSetId, baseline: caseIds.length, candidate: caseIds.length });
  }

  // FR-43's own "no unresolved leakage": asked here, before the resolving transaction opens,
  // and recorded inside it (resolveOutcome's `leakage_assessment`).
  const leakage = await screenLeakage({
    hypothesis: candidate.hypothesis, diff: candidate.diff, touched_components: candidate.touched_components,
  }, principal);

  // FR-9/FR-23: a critical guardrail this candidate's own replay evidence never measured is
  // missing evidence, never a failure — `proofVerdict` answers `guardrails_not_established`.
  const guardrails = summariseGuardrails(plan.candidateSide);
  const resource_usage = summariseResourceUsage(plan.baseline, plan.candidateSide, candidate.complexity_delta);
  const dimension_scores = summariseDimensions(plan.baseline, plan.candidateSide);
  const statistics = {
    per_case: plan.perCase, paired_decision: decision, policy: ctx.policy, resamples: 2000, seed: candidateId,
    liveness_bound_reached: boundReached, leakage: { reading: leakage.reading, reason: leakage.reason },
  };
  const verdict = proofVerdict({
    decision, complexityDelta: candidate.complexity_delta, guardrails: guardrails.status,
    leakage, hasOwners: candidate.touched_owners.length > 0,
  });
  return resolveOutcome(candidate, idempotencyKey, principal, {
    ...verdict, decision, guardrails, resource_usage, dimension_scores, statistics,
    observed: true, leakage_assessment: leakage.pending ?? undefined,
  }, "resolve", initiative);
}

/** A candidate proves once, whatever its outcome. What a caller can do next depends on it: a
 *  `proof_not_established` hypothesis may be re-recorded under a fresh improvement_start, and
 *  whether that search can prove on the same case set is what this resolution's `proof_split`
 *  said. */
function spentAllocationRefusal(candidate: CandidateRow): string {
  const next = candidate.status === "proof_not_established"
    ? "its hypothesis may be re-recorded under a fresh improvement_start, which can prove on the " +
      "same case set only if this proof released its sealed split (proof_split: released — no run " +
      "executed on a proof case, or the only gap was an unavailable leakage answer); otherwise " +
      "build a new case set (new evidence)"
    : "a new candidate needs new evidence (a new case set) to prove";
  return `ERROR: proof allocation spent — candidate ${candidate.id} already resolved ${candidate.status}; ${next}`;
}

/** Which candidate holds this case set's proof split (proving now, or spent it), or null. */
async function caseSetSpentBy(p: pg.Pool, caseSetId: string): Promise<string | null> {
  const row = (await p.query<{ by: string | null; at: string | null }>(
    "select proof_spent_by_candidate_id::text as by, proof_spent_at::text as at from zz.replay_case_set where id = $1::uuid",
    [caseSetId])).rows[0];
  return row?.at ? (row.by ?? "another candidate") : null;
}

function spentRefusal(caseSetId: string, by: string): string {
  return `ERROR: case set ${caseSetId}'s sealed proof cases are held by candidate ${by} — either it ` +
    "is proving them now, or its proof resolved with runs that executed on them (proof_passed, " +
    "proof_failed, or not_established after its runs observed the cases), which spends them. A " +
    "proof that ended before any run executed, or whose only gap was an unavailable leakage " +
    "answer, would have released them. Build a new case set (new evidence) before proving again";
}
