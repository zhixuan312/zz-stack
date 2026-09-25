/**
 * `candidate_prove(candidate_id, abandon: true, ...)` (FR-28) — split out of `candidate-prove.ts`
 * to stay under this repository's 700-line ceiling once Task I-29's own fix dispatch (the
 * not_established guardrail short-circuit) pushed that file over it. This is the recovery path
 * for a lost response: if the caller of the call that opened proof (minted the verifier_token,
 * moved `proving`) never saw its own reply, the allocation is stuck `proving` with a token nobody
 * holds and no ordinary `candidate_prove` call ever resolves it — every remaining branch needs
 * proof-split replay evidence nothing can now produce. `abandon` resolves it as `not_established,
 * reason: "abandoned"` through the SAME `resolveOutcome` transaction (`candidate-prove.ts`)
 * every other terminal outcome uses, own idempotency phase, after `cancelProofRuns` tears down
 * whatever the token already spawned — so a later search needs a new allocation, per FR-28.
 * The token is revoked first, on its own commit, and the runs are counted inside the resolving
 * transaction: an abandon before any proof run was registered releases the case set's proof
 * split; one after keeps it spent (`proofSplitSpent`).
 */
import type pg from "pg";

import { proofSplitOf, resolveOutcome, SPENT_STATUSES, type CandidateProveOutcome, type CandidateRow, type StoredProofEvaluation } from "./candidate-prove.js";
import { closeRun } from "./replay-runs.js";

/** Every proof-split replay_run THIS candidate's own verifier_token allocation spawned and is
 *  still `registered`/`running` — candidate-side and baseline-side alike, scoped by
 *  `verifier_allocation_id` (migration 082) rather than by `candidate_id`/`base_subject_version_id`.
 *  Closed through `closeRun` (`replay-runs.ts`), the SAME teardown `replay_close`/`sweepExpired`
 *  already use — never a second, ad hoc teardown that could drift from that one's own admin-event
 *  record.
 *
 *  FIXED (was DELIBERATE, Task I-21's own defect closed later): baseline-side runs used to be
 *  matched by `base_subject_version_id` alone, with no verifier_token-scoped column to narrow
 *  further — a second candidate proving the SAME base subject against the SAME case set at the
 *  same time would then also lose its own still-registered baseline runs here.
 *  `verifier_allocation_id` is stamped by `replay_start` from the exact `verifier_token`
 *  presented (`replay-runs.ts`'s own `requireContext`), so it identifies one allocation and
 *  nothing wider — two concurrent allocations against the same base subject and case set now
 *  cancel only their own runs. */
async function cancelProofRuns(
  p: pg.Pool, verifierAllocationId: string, principal: string,
): Promise<void> {
  const { rows } = await p.query<{ id: string; team_slug: string; pat_id: string }>(`
    select rr.id::text as id, rr.team_slug, rr.pat_id::text as pat_id
      from zz.replay_run rr
     where rr.verifier_allocation_id = $1::uuid
       and rr.status in ('registered', 'running')`,
    [verifierAllocationId]);
  for (const run of rows) await closeRun(p, run, "cancelled", principal, "abandoned");
}

/** Revokes every still-open `zz.replay_verifier_token` of this candidate, committed on its own
 *  statement BEFORE anything else `abandon` does, and returns the allocation ids it revoked.
 *  From this commit on `verifierAllocation` (replay-verifier.ts) refuses the token, so no new
 *  proof run can start while the runs it already spawned are cancelled and counted. Empty when
 *  nothing was open (the token row vanished mid-flight) — the abandon still resolves; it only
 *  means nothing was left to cancel. */
async function revokeVerifierTokens(p: pg.Pool, candidateId: string): Promise<string[]> {
  const { rows } = await p.query<{ id: string }>(`
    update zz.replay_verifier_token set revoked_at = now()
     where candidate_id = $1::uuid and revoked_at is null
    returning id::text as id`, [candidateId]);
  return rows.map((r) => r.id);
}

/** The candidate's own latest proof `zz.candidate_evaluation` row, however it got there (a
 *  normal resolve, or a prior abandon) — read back for `abandon`'s own no-op-on-already-spent
 *  contract below, which answers the CURRENT terminal state whatever idempotency_key the caller
 *  used to reach it, unlike `candidate-prove.ts`'s own `readBackIfSameResolve`'s exact-retry
 *  match. */
async function latestProofEvaluation(p: pg.Pool, candidateId: string): Promise<StoredProofEvaluation | null> {
  return (await p.query<StoredProofEvaluation>(`
    select id::text as id, aggregate_score from zz.candidate_evaluation
     where candidate_id = $1::uuid and split = 'proof'
     order by created_at desc limit 1`, [candidateId])).rows[0] ?? null;
}

/** `abandon: true` — see the module note. `selected` REFUSES (nothing was ever opened, so there
 *  is no allocation to abandon); `proving` cancels whatever the token spawned and resolves the
 *  allocation `not_established, reason: "abandoned"` through `resolveOutcome`'s own `"abandon"`
 *  phase; an already-spent candidate (by this call or any other terminal path) is a NO-OP
 *  read-back of its own current state, never a refusal — FR-28's "revokes the token" is already
 *  true by the time a second abandon reaches it. */
export async function abandonProof(
  p: pg.Pool, candidate: CandidateRow, idempotencyKey: string, principal: string, initiative?: string,
): Promise<CandidateProveOutcome | { error: string }> {
  if (candidate.status === "selected") {
    return { error: `ERROR: candidate ${candidate.id} has no open proof allocation to abandon — it was never opened` };
  }
  if (SPENT_STATUSES.has(candidate.status)) {
    const stored = await latestProofEvaluation(p, candidate.id);
    if (!stored) {
      return { error: `ERROR: candidate ${candidate.id} is spent but its own proof evaluation cannot be read back` };
    }
    return {
      proof_status: stored.aggregate_score.proof_status, reason: stored.aggregate_score.reason,
      release_eligible: stored.aggregate_score.release_eligible, candidate_evaluation_id: stored.id,
      verifier_token: null, token_already_issued: true, status: candidate.status,
      proof_split: await proofSplitOf(p, candidate.id),
    };
  }

  // proving: revoke the token first, so nothing new can start; then cancel whatever it already
  // spawned — scoped to this candidate's own allocations (migration 082), never to a case set or
  // base subject a different candidate's own allocation could share.
  //
  // Whether any run was drawn onto a proof case decides whether the case set's proof split is
  // released (`proofSplitSpent`, candidate-prove-decide.ts). Counted inside the resolving
  // transaction, after the revoke, whatever the run's status — cancelling does not undo a case a
  // session was already handed, and a count taken before the revoke would miss a run started in
  // the gap.
  const allocations = await revokeVerifierTokens(p, candidate.id);
  for (const allocation of allocations) await cancelProofRuns(p, allocation, principal);

  return resolveOutcome(candidate, idempotencyKey, principal, {
    proof_status: "not_established", reason: "abandoned", release_eligible: false,
    decision: null, guardrails: null, resource_usage: null, dimension_scores: null,
    statistics: { abandoned: true }, observed: { allocations },
  }, "abandon", initiative);
}
