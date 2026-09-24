/**
 * What a policy branch may consume, and the one number it may never consume.
 *
 * A branch that needs a probability — a threshold, a cost-weighted choice, anything that
 * multiplies — needs a number whose provenance is not the assessor's own token stream. A
 * self-reported `confidence: 0.93` read as one puts a word the model wrote where a measurement
 * belongs, and nothing about the row afterwards says which it was.
 *
 * So a branch requiring a probability, given an assessment carrying only a self-reported one,
 * resolves `unsupported`, or routes to a named independent review where the profile permits
 * it. Both are `decided: false`. What is never returned is a decision, a zero, or an invented
 * confidence.
 *
 * Two origins qualify: `native_distribution`, copied from a provider's own primitive, and
 * `empirical_calibration`, supplied by a separately validated calibration. `native_score` does
 * not — a score on a declared scale is a magnitude, not a probability.
 *
 * The assessment must also be answered. A native distribution can arrive on an assessment the
 * port left `unsupported`, which is what it does when no qualified mapping declares where the
 * decision bounds are; deciding on it here would perform the mapping the port refused to.
 */
import { authorizesSemanticAdvance, type SemanticAssessment } from "./assessment.js";

/** What the branch needs before it may move. */
type BranchRequirement =
  /** A declared answer is enough: the branch switches on which label came back. */
  | "label"
  /** A number the assessor did not generate. Most branches do not need this; the ones that do
   *  may not be satisfied with something that merely looks like it. */
  | "native_probability";

/** `answered` is the only one that carries a decision. The other two are refusals that differ
 *  in what happens next, not in what was decided. */
type BranchOutcome = "answered" | "unsupported" | "independent_review";

/** One branch, one assessment, and whatever route out the profile permits. */
interface BranchRequest {
  readonly requires: BranchRequirement;
  readonly assessment: SemanticAssessment;
  /** A reviewer the profile has declared permitted for this branch. Absent means there is no
   *  declared route out, and the branch says `unsupported` rather than inventing one. */
  readonly independentReview?: string;
}

/** `decided` and `outcome` answer two different questions on purpose. A caller that reads only
 *  the outcome still cannot act on a refusal, because acting is gated on `decided`. */
interface BranchVerdict {
  readonly decided: boolean;
  readonly outcome: BranchOutcome;
  readonly reason: string;
}

const QUALIFYING = ["native_distribution", "empirical_calibration"] as const;

const verdict = (decided: boolean, outcome: BranchOutcome, reason: string): BranchVerdict =>
  Object.freeze({ decided, outcome, reason });

/** The declared route out, or none. Named separately because every refusal below takes it and
 *  none of them may differ about what a permitted review means. */
function decline(request: BranchRequest, reason: string): BranchVerdict {
  const review = request.independentReview;
  return review === undefined
    ? verdict(false, "unsupported", reason)
    : verdict(false, "independent_review", `${reason}; routed to the permitted independent review ${review}`);
}

/** Why the assessment could not carry a decision, in the assessment's own words where it has
 *  any. `failure_reason` is null on a clean answer, so the status carries the rest. */
const unanswered = (assessment: SemanticAssessment): string =>
  assessment.failure_reason === null
    ? `the assessment is ${assessment.status} and carries no value`
    : `the assessment is ${assessment.status}: ${assessment.failure_reason}`;

/**
 * May this branch move, on this assessment.
 *
 * The self-reported case gets its own sentence rather than a generic refusal: "no probability
 * arrived" and "a probability-shaped number arrived and this branch may not consume it" are
 * different facts about the run.
 */
export function evaluateBranch(request: BranchRequest): BranchVerdict {
  const { assessment } = request;
  const answered = authorizesSemanticAdvance(assessment);

  if (request.requires === "label") {
    return answered
      ? verdict(true, "answered", "a declared answer was established and this branch needs nothing further")
      : decline(request, unanswered(assessment));
  }

  const qualified = assessment.signals.find((s) => (QUALIFYING as readonly string[]).includes(s.origin));
  if (qualified === undefined) {
    const selfReported = assessment.signals.some((s) => s.origin === "self_reported");
    return decline(request, selfReported
      ? "this branch requires a probability and the assessment carries only a self-reported number, "
        + "which the assessor generated and this branch may not consume"
      : "this branch requires a probability and the assessment carries none");
  }
  if (!answered) {
    return decline(request, `a ${qualified.origin} accompanied the reply and ${unanswered(assessment)}`);
  }
  return verdict(true, "answered", `the decision rests on a ${qualified.origin} the assessor did not generate`);
}
