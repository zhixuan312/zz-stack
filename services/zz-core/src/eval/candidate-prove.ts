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
 * and moves the candidate to `proving`, returning the token and the `(case, side)` pairs still
 * needed; the IMPROVE agent drives `replay_start(context: "verifier", verifier_token)` plus
 * `launchReplay` (Task I-21's own `--verifier-token` addition to `packages/tools/src/replay/
 * launch.ts`) against each one; a LATER call, once enough proof-split `zz.replay_run` rows are
 * `completed` and scored, computes `proof_status` from them and stores it. Never an executor
 * itself — exactly the planner/reducer split `candidate_validate` already keeps from the
 * launcher.
 *
 * Reused wholesale from `candidate-validate.ts`: `mean`, `groupByCase`, `baselineRuns`,
 * `candidateRuns`, `escalateOneRepeat`, `summariseGuardrails`, `summariseResourceUsage`,
 * `summariseDimensions` and `protocolHasModelBackedMeasure` — none of them hard-code a split
 * literal, so a proof run is scored by the SAME machinery a validation run is, over case ids this
 * file resolves to `split: 'proof'` instead. `pairedDecision` (`stats.ts`) is the same pure
 * bootstrap both files feed. `screenLeakage`/`LEAKAGE_EVALUATOR` (`candidate-search.ts`) is the
 * SAME critic `candidate_search` already ran before this candidate ever reached `valid` — run
 * again here, once, against the finished proof evidence, because FR-43's own eligibility line
 * ("no unresolved leakage") names it as a proof-time check, not only a pre-validation one.
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
 * A candidate.status has no separate `not_established` value (migration 077's own check
 * constraint), so an unestablished proof — too few proof cases, or an interval that never
 * resolved by the liveness bound — is stored under `proof_failed` too: it is exactly as spent as
 * a statistically failed one, and `REJECTED_CANDIDATE_STATUSES` (`proposer-bundle.ts`) already
 * treats `proof_failed` as a hypothesis this plugin should not propose again, which is exactly
 * FR-28's "a resumed search restarts from the pre-proof history" — a fresh `improvement_start`
 * (a new `zz.improvement_run` row) is what resumes it, never this same allocation. NAMED
 * CONSEQUENCE, not resolved here: this also means a candidate whose proof failed only because
 * its case set had too few proof cases (`insufficient_proof_cases`, an evidence gap, not a
 * rejected idea) is barred from re-proposal exactly as a genuinely rejected hypothesis is — 077
 * gives this file no third status to keep the two apart.
 */
import { randomBytes } from "node:crypto";

import { sha256, SearchPolicy, ThreeWaySplitPolicy } from "@zz/contracts";
import type pg from "pg";

import {
  baselineRuns, candidateRuns, escalateOneRepeat, groupByCase, mean, protocolHasModelBackedMeasure,
  summariseDimensions, summariseGuardrails, summariseResourceUsage,
  type PerCaseDelta, type RunsRequiredEntry, type SideRun,
} from "./candidate-validate.js";
import { LEAKAGE_EVALUATOR, screenLeakage, type LeakageSubject } from "./candidate-search.js";
import type { TouchedComponent } from "./complexity.js";
import { registerEvaluator } from "./evaluators.js";
import {
  lookupRow, withIdempotency, type IdempotencyOutcome, type IdempotencyRow, type MutatorOutcome,
} from "./idempotency.js";
import { pairedDecision, type PairedDecisionResult } from "./stats.js";
import { Refusal } from "../refusal.js";

// -------------------------------------------------------------------------------------------
// Candidate + its proof policy.

interface CandidateRow {
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

/** Same fallback numbers `candidate-validate.ts`'s own `DEFAULT_POLICY` uses, for the same
 *  reason: a protocol naming no `improvement_policy.search` is not a candidate with no proof, it
 *  is a run using these. Proof reuses `SearchPolicy` rather than the freeform `ProofPolicy`
 *  (`@zz/contracts`) column, because spec v8 fixes no shape for that column beyond "an object"
 *  (FR-6's own words) while `SearchPolicy.minRepeats/minMeaningfulEffect/confidence` are exactly
 *  FR-57's own frozen "Repeats"/"Minimum meaningful effect"/"Decision rule" numbers — inventing a
 *  second, parallel shape under `improvement_policy.proof` for the same three numbers would be a
 *  second, silent policy nobody agreed to. */
const DEFAULT_PROOF_POLICY: ProofPolicy = { minRepeats: 3, mme: 0, confidence: 0.95, wallClockHours: 24 };

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

  const searchParsed = SearchPolicy.safeParse(run.search_policy);
  const policy: ProofPolicy = searchParsed.success
    ? { minRepeats: searchParsed.data.minRepeats, mme: searchParsed.data.minMeaningfulEffect,
        confidence: searchParsed.data.confidence, wallClockHours: searchParsed.data.wallClockHours }
    : DEFAULT_PROOF_POLICY;

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

type Plan =
  | { readonly kind: "pending"; readonly runs_required: RunsRequiredEntry[] }
  | { readonly kind: "resolved"; readonly perCase: PerCaseDelta[]; readonly baseline: SideRun[]; readonly candidateSide: SideRun[] };

async function planProof(
  p: pg.Pool, candidate: CandidateRow, caseIds: readonly string[], minRepeats: number,
): Promise<Plan> {
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

interface CandidateProveOutcome {
  readonly proof_status: "proof_passed" | "proof_failed" | "not_established" | null;
  readonly reason: string | null;
  readonly release_eligible: boolean;
  readonly candidate_evaluation_id: string | null;
  readonly verifier_token: string | null;
  readonly token_already_issued: boolean;
  readonly runs_required?: RunsRequiredEntry[];
  readonly status: string;
}

const OPEN_STATUSES = new Set(["selected", "proving"]);
const SPENT_STATUSES = new Set(["proof_passed", "proof_failed"]);

/** Records the proof allocation's terminal outcome — the ONE ledger write this call makes,
 *  whatever combination of leakage/statistics/guardrails/ownership decided it. `candidate.status`
 *  moves to `proof_passed`/`proof_failed` (migration 077's own vocabulary has no third value —
 *  see the module note on why `not_established` is stored as `proof_failed` too) and
 *  `improvement_run.status` moves to `ready_for_approval` (passed AND an owner exists to approve
 *  it), `closed` (passed but no release_owners are recorded for this base subject's plugin — a
 *  proposal-only outcome, FR-51) or `proof_failed` (any other terminal outcome) — the same "one
 *  transaction, both tables" shape `candidate-search.ts`'s own `runCandidateSearch` already uses
 *  for `selected`/`closed`. */
async function resolveOutcome(
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
  },
): Promise<CandidateProveOutcome> {
  const candidateStatus = outcome.proof_status === "proof_passed" ? "proof_passed" : "proof_failed";
  const runStatus = outcome.proof_status === "proof_passed"
    ? (outcome.release_eligible ? "ready_for_approval" : "closed")
    : "proof_failed";

  const ledgerOutcome: IdempotencyOutcome<{ id: string }> = await withIdempotency(
    // phase: "resolve" — never bare {candidate_id} — so a caller who reuses the OPEN call's own
    // key here gets idempotency_conflict (a different digest under the same key) rather than a
    // false replay against zz.replay_verifier_token's row id, which this call's own reader below
    // would misread as a candidate_evaluation id. See the module note.
    principal, "candidate_prove", idempotencyKey, { candidate_id: candidate.id, phase: "resolve" },
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
         JSON.stringify(outcome.statistics), JSON.stringify(outcome.resource_usage)])).rows[0];
      if (!row) throw new Error("insert into zz.candidate_evaluation produced no row");
      await client.query("update zz.improvement_run set status = $2 where id = $1::uuid", [candidate.improvement_run_id, runStatus]);
      // The allocation is now spent — its verifier_token must not go on authenticating
      // context: "verifier" replay_start calls for the rest of its natural expiry (FR-28's own
      // "refuses a second opening" would otherwise have a side door: the token itself still
      // works even though candidate_prove refuses to open this candidate again).
      await client.query(
        "update zz.replay_verifier_token set revoked_at = now() where candidate_id = $1::uuid and revoked_at is null",
        [candidate.id]);
      return { result: { id: row.id }, result_table: "zz.candidate_evaluation", result_id: row.id };
    },
  );
  const candidateEvaluationId = ledgerOutcome.replayed ? ledgerOutcome.result_id : ledgerOutcome.result.id;

  return {
    proof_status: outcome.proof_status, reason: outcome.reason, release_eligible: outcome.release_eligible,
    candidate_evaluation_id: candidateEvaluationId, verifier_token: null, token_already_issued: true,
    status: candidateStatus,
  };
}

interface StoredProofEvaluation {
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
  };
}

export async function proveCandidate(
  p: pg.Pool, candidateId: string, idempotencyKey: string, principal: string,
): Promise<CandidateProveOutcome | { error: string }> {
  const candidate = await loadCandidate(p, candidateId);
  if (!candidate) return { error: `ERROR: no candidate ${candidateId}` };

  if (!OPEN_STATUSES.has(candidate.status) && !SPENT_STATUSES.has(candidate.status)) {
    return { error: "ERROR: only the selected candidate may open proof" };
  }
  if (SPENT_STATUSES.has(candidate.status)) {
    const replay = await readBackIfSameResolve(p, candidateId, idempotencyKey, principal);
    if (replay) return replay;
    return { error: "ERROR: proof allocation spent; a new allocation or new evidence is required" };
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
    });
  }

  // Opening: a `selected` candidate has never had a proof allocation — mint the token and move to
  // `proving`, but never resolve in the same call (the plan's own words: "the first call mints
  // the verifier token and plans the proof runs"), even if, by coincidence, enough runs already
  // existed. This is the call's only ledger write when it fires.
  if (candidate.status === "selected") {
    const opened: IdempotencyOutcome<{ id: string; token: string }> = await withIdempotency(
      // phase: "open" — see the module note on why this and the resolve call never share a digest.
      principal, "candidate_prove", idempotencyKey, { candidate_id: candidateId, phase: "open" },
      async (client): Promise<MutatorOutcome<{ id: string; token: string }>> => {
        // CAS, checked first, same reason and shape as the resolve transaction's own below: two
        // concurrent opening calls must mint at most one verifier_token for this allocation
        // (AC-28.1's "once"). The loser's own UPDATE matches zero rows once the winner's has
        // committed 'proving', and this throws before ever minting — the winner's own retry with
        // a FRESH idempotency_key lands on the now-`proving` candidate and gets `runs_required`
        // with no new token, exactly as a second, later call against an already-open allocation
        // always does.
        const claimed = await client.query(
          "update zz.candidate set status = 'proving' where id = $1::uuid and status = 'selected'",
          [candidateId]);
        if ((claimed.rowCount ?? 0) === 0) {
          throw new Refusal(
            `ERROR: candidate ${candidateId} is no longer selected — another candidate_prove call ` +
            "already opened this allocation (or it has since resolved); call candidate_prove again " +
            "to read its current state");
        }
        const token = mintVerifierToken();
        const expiresAt = new Date(Date.now() + ctx.policy.wallClockHours * 3_600_000).toISOString();
        const row = (await client.query<{ id: string }>(`
          insert into zz.replay_verifier_token (token_hash, candidate_id, expires_at, created_at)
          values ($1, $2::uuid, $3, now()) returning id::text as id`,
          [sha256(token), candidateId, expiresAt])).rows[0];
        if (!row) throw new Error("insert into zz.replay_verifier_token produced no row");
        await client.query("update zz.improvement_run set status = 'proofing' where id = $1::uuid", [candidate.improvement_run_id]);
        return { result: { id: row.id, token }, result_table: "zz.replay_verifier_token", result_id: row.id };
      },
    );

    // Plans the FULL minRepeats requirement per case — never `escalateOneRepeat`'s single-repeat
    // nudge, which is only correct once every case has already cleared the floor once. On a
    // fresh allocation nothing has run yet, so `planProof` itself computes the real requirement
    // (and, on the vanishingly unlikely chance evidence already exists from a stale prior state,
    // reports none — a later call against the now-`proving` candidate resolves it).
    const openingPlan = await planProof(p, candidate, caseIds, ctx.policy.minRepeats);
    const runsRequired = openingPlan.kind === "pending" ? openingPlan.runs_required : [];
    return {
      proof_status: null, reason: null, release_eligible: false, candidate_evaluation_id: null,
      verifier_token: opened.replayed ? null : opened.result.token, token_already_issued: opened.replayed,
      runs_required: runsRequired, status: "proving",
    };
  }

  // Continuing (`proving`): plan from whatever proof-split replay_run rows already exist. Pending
  // evidence is read-only — no ledger row, the same as candidate_validate's own runs_required
  // branch — resolution is the only write.
  const plan = await planProof(p, candidate, caseIds, ctx.policy.minRepeats);
  if (plan.kind === "pending") {
    return {
      proof_status: null, reason: null, release_eligible: false, candidate_evaluation_id: null,
      verifier_token: null, token_already_issued: true, runs_required: plan.runs_required, status: "proving",
    };
  }

  const boundReached = Date.now() - ctx.improvementRunCreatedAt.getTime() >= ctx.policy.wallClockHours * 3_600_000;
  const deltas = plan.perCase.map((c) => c.delta);
  const decision = pairedDecision(deltas, ctx.policy.mme, { resamples: 2000, seed: candidateId, confidence: ctx.policy.confidence });

  if (decision.verdict === "unresolved" && !boundReached) {
    return {
      proof_status: null, reason: null, release_eligible: false, candidate_evaluation_id: null,
      verifier_token: null, token_already_issued: true,
      runs_required: escalateOneRepeat(plan.perCase.map((c) => c.case_id), candidate), status: "proving",
    };
  }

  // FR-43's own "no unresolved leakage": the SAME critic candidate_search already ran before this
  // candidate ever reached valid/selected, re-asked once more against the finished proof evidence.
  const evaluator = await registerEvaluator(LEAKAGE_EVALUATOR);
  const leakageSubject: LeakageSubject = {
    hypothesis: candidate.hypothesis, diff: candidate.diff, touched_components: candidate.touched_components,
  };
  const leakage = await screenLeakage(evaluator.evaluator_version_id, leakageSubject, principal);

  const guardrails = summariseGuardrails(plan.candidateSide);
  const resource_usage = summariseResourceUsage(plan.baseline, plan.candidateSide, candidate.complexity_delta);
  const dimension_scores = summariseDimensions(plan.baseline, plan.candidateSide);
  const statistics = {
    per_case: plan.perCase, paired_decision: decision, policy: ctx.policy, resamples: 2000, seed: candidateId,
    liveness_bound_reached: boundReached, leakage,
  };

  if (leakage.leaked) {
    return resolveOutcome(candidate, idempotencyKey, principal, {
      proof_status: "proof_failed", reason: `leakage_detected: ${leakage.reason ?? ""}`, release_eligible: false,
      decision, guardrails, resource_usage, dimension_scores, statistics,
    });
  }

  // FR-43: "improvement above the protocol's meaningful/noise threshold OR an accepted pruning
  // trade-off." `decision.verdict === "improves"` is the first; a candidate whose own
  // complexity_delta is negative (FR-44's own pruning) and whose interval shows no evidence of
  // regression (lower bound at or above zero, whatever mme itself requires) is the second — a
  // pure simplification that measures no worse is accepted even when it never had a positive
  // effect large enough to clear mme on its own. Computed BEFORE the `unresolved` branch below:
  // a pruning candidate whose interval merely straddles mme (never dipping below zero) is a
  // RESOLVED "no regression", not an undecided one — `acceptedPruning` must get first look, or a
  // real pruning trade-off is misreported `not_established` for evidence that already settled it.
  const acceptedPruning = candidate.complexity_delta < 0 && decision.lower >= 0;
  const improvementClears = decision.verdict === "improves" || acceptedPruning;
  const guardrailsPass = guardrails.status === "pass";

  if (decision.verdict === "unresolved" && !acceptedPruning) {
    // Every case cleared minRepeats, but the interval still straddles mme at the liveness bound —
    // a real answer, never a reason to keep asking for repeats past the bound the protocol set.
    return resolveOutcome(candidate, idempotencyKey, principal, {
      proof_status: "not_established", reason: "proof_unresolved", release_eligible: false,
      decision, guardrails, resource_usage, dimension_scores, statistics,
    });
  }

  if (!improvementClears || !guardrailsPass) {
    const reason = !guardrailsPass ? "guardrails_failed" : "improvement_below_meaningful_effect";
    return resolveOutcome(candidate, idempotencyKey, principal, {
      proof_status: "proof_failed", reason, release_eligible: false,
      decision, guardrails, resource_usage, dimension_scores, statistics,
    });
  }

  const hasOwners = candidate.touched_owners.length > 0;
  return resolveOutcome(candidate, idempotencyKey, principal, {
    proof_status: "proof_passed",
    reason: hasOwners ? "proof_passed" : "proof_passed; release_eligible false — no release owners recorded for this plugin/subject",
    release_eligible: hasOwners, decision, guardrails, resource_usage, dimension_scores, statistics,
  });
}
