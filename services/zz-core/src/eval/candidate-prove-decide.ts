/**
 * `candidate_prove`'s verdict over finished proof evidence (FR-43), pure so
 * `checks/eval-proof-verdict.ts` proves the order of its branches on values alone. The order
 * matters:
 *   1. `needsMoreRepeats` first, and it checks for an accepted pruning trade-off before it
 *      answers. A pruning candidate (negative complexity_delta) whose interval never dips below
 *      zero has settled "no regression" even when the interval still straddles mme. Asking for
 *      more repeats there sends the caller back for evidence it does not need, and at the bound
 *      that becomes a false `proof_unresolved`.
 *   2. Leakage: a clear `yes` is `proof_failed`. `unclear`/`unavailable` is `not_established`
 *      (`leakage_unresolved`). FR-43 asks for "no unresolved leakage", and an unanswered critic
 *      has not ruled leakage out.
 *   3. A critical guardrail nothing measured is missing evidence, never a failure
 *      (`guardrails_not_established`).
 *   4. An interval still unresolved at the bound, pruning aside, is `proof_unresolved`.
 *   5. Otherwise improvement (or accepted pruning) plus passing guardrails is `proof_passed`, and
 *      anything else is `proof_failed`.
 */
import type { PairedDecisionResult } from "./stats.js";

export function acceptedPruning(complexityDelta: number, decision: Pick<PairedDecisionResult, "lower">): boolean {
  return complexityDelta < 0 && decision.lower >= 0;
}

/** True when the caller should run one more repeat per case rather than resolve now. */
export function needsMoreRepeats(
  decision: Pick<PairedDecisionResult, "verdict" | "lower">, complexityDelta: number, boundReached: boolean,
): boolean {
  return decision.verdict === "unresolved" && !acceptedPruning(complexityDelta, decision) && !boundReached;
}

interface ProofVerdict {
  readonly proof_status: "proof_passed" | "proof_failed" | "not_established";
  readonly reason: string;
  readonly release_eligible: boolean;
}

export function proofVerdict(input: {
  readonly decision: Pick<PairedDecisionResult, "verdict" | "lower">;
  readonly complexityDelta: number;
  readonly guardrails: "pass" | "fail" | "not_established";
  readonly leakage: { readonly reading: "yes" | "no" | "unclear" | "unavailable"; readonly reason: string | null };
  readonly hasOwners: boolean;
}): ProofVerdict {
  const { decision, complexityDelta, guardrails, leakage, hasOwners } = input;
  const failed = (reason: string): ProofVerdict => ({ proof_status: "proof_failed", reason, release_eligible: false });
  const unestablished = (reason: string): ProofVerdict => ({ proof_status: "not_established", reason, release_eligible: false });

  if (leakage.reading === "yes") return failed(`leakage_detected: ${leakage.reason ?? ""}`);
  if (leakage.reading !== "no") return unestablished("leakage_unresolved");
  if (guardrails === "not_established") return unestablished("guardrails_not_established");

  const pruning = acceptedPruning(complexityDelta, decision);
  if (decision.verdict === "unresolved" && !pruning) return unestablished("proof_unresolved");
  if (guardrails !== "pass") return failed("guardrails_failed");
  if (decision.verdict !== "improves" && !pruning) return failed("improvement_below_meaningful_effect");

  return {
    proof_status: "proof_passed",
    reason: hasOwners ? "proof_passed" : "proof_passed; release_eligible false — no release owners recorded for this plugin/subject",
    release_eligible: hasOwners,
  };
}
