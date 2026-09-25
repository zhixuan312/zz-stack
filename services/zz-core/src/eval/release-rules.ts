/**
 * `releaseDecision` and `rollbackDecision` (Task I-22, FR-49, FR-50, AC-49.1, AC-50.1): the pure
 * promotion and rollback rules a release path decides from. `checks/eval-release-rules.ts` (the
 * plan's own check) imports both straight off `dist/`, so their exact refusal order and reasons
 * are pinned there rather than restated here.
 *
 * `releaseDecision` is FR-49's own compare-and-swap read as a pure function of five facts:
 * whether any owner is required at all, whether proof established release eligibility, whether
 * every required owner has approved, whether the digest actually being applied is the one that
 * was approved, and whether the currently released subject is still the candidate's own
 * `base_subject_version_id`. The order matters and is checked in exactly this sequence, stopping
 * at the first hit, because each later branch assumes the earlier ones already passed —
 * `approval_required` firing on a third-party subject that never had an owner to approve would
 * misreport "nobody signed off" for "nobody COULD," and `stale_baseline` firing ahead of
 * `digest_mismatch` would send a caller to rebase a candidate whose real problem is a patch that
 * no longer matches what was approved.
 *
 * `release_prepare` (`release.ts`, this same task) does not call this function: at prepare time
 * nothing has been approved yet, so `approval_required` would fire on every legitimate call. Its
 * own gate is the first branch of this same order alone — `no_release_owners` — plus a
 * `not_eligible` refusal for a candidate that has not itself reached `proof_passed`. The
 * remaining branches belong to `release_apply`, a later task this plan does not implement (the
 * plan's own task boundary: "final deliverable content is not in this plan"), once a currently
 * released subject and an approved document both exist to check the rest of the order against.
 *
 * `rollbackDecision` reuses `pairedDecision` (`stats.ts`, Task I-19) exactly the way
 * `candidate_prove` already does: the same percentile-bootstrap interval over a set of paired
 * deltas, with `mme` fixed at 0 rather than a protocol's own minimum-meaningful-effect — FR-50's
 * own words ask for "below 0" (any established regression at all), never "below the
 * meaningful-effect threshold" a release already had to clear before it was ever proved. A
 * guardrail failure decides on its own, ahead of the statistics and without needing a resolved
 * interval: FR-50 names a required-guardrail failure and a statistically established regression
 * as two independent triggers, never a conjunction of both.
 */
import { pairedDecision } from "./stats.js";

interface ReleaseDecisionInput {
  readonly current_subject_id: string;
  readonly base_subject_id: string;
  readonly approved_patch_digest: string;
  readonly patch_digest: string;
  readonly required_owners: readonly string[];
  readonly approvals: readonly string[];
  readonly proof_eligible: boolean;
}

type ReleaseDecisionReason =
  | "no_release_owners"
  | "not_eligible"
  | "approval_required"
  | "digest_mismatch"
  | "stale_baseline";

type ReleaseDecisionResult =
  | { readonly kind: "apply" }
  | { readonly kind: "refuse"; readonly reason: ReleaseDecisionReason };

/** FR-49's own refusal order — see the module note for why each branch assumes the ones above it
 *  already passed. Pure: the same five facts always produce the same verdict. */
export function releaseDecision(input: ReleaseDecisionInput): ReleaseDecisionResult {
  if (input.required_owners.length === 0) return { kind: "refuse", reason: "no_release_owners" };
  if (!input.proof_eligible) return { kind: "refuse", reason: "not_eligible" };
  const unapproved = input.required_owners.some((owner) => !input.approvals.includes(owner));
  if (unapproved) return { kind: "refuse", reason: "approval_required" };
  if (input.patch_digest !== input.approved_patch_digest) return { kind: "refuse", reason: "digest_mismatch" };
  if (input.current_subject_id !== input.base_subject_id) return { kind: "refuse", reason: "stale_baseline" };
  return { kind: "apply" };
}

interface RollbackDecisionInput {
  readonly deltas: readonly number[];
  readonly guardrail_failed: boolean;
  readonly resamples: number;
  readonly seed: string;
}

/** FR-50: true when a required guardrail has already failed, or when the released version's own
 *  paired per-case deltas against its predecessor show a 95% bootstrap interval entirely below
 *  zero — an established regression, never merely "not an established improvement" (an
 *  `unresolved` interval that straddles zero is not itself grounds for rollback). */
export function rollbackDecision(input: RollbackDecisionInput): boolean {
  if (input.guardrail_failed) return true;
  const decision = pairedDecision(
    input.deltas, 0, { resamples: input.resamples, seed: input.seed, confidence: 0.95 });
  return decision.upper < 0;
}
