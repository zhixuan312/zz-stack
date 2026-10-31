/**
 * The control loop's contracts, through one door.
 *
 * COUPLED: `index.ts` re-exports this file with a single wildcard. A new control-loop module is
 * added here, and `index.ts` does not change.
 *
 * Every module below is re-exported by explicit name, so a name that stops existing breaks the
 * build. Nothing is declared in this file.
 */

// The generic control-loop host: what a reviewed module is, the five operations a host serves
// (`run_start`, `method_read`, `evidence_record`, `control_evaluate`, `action_claim`), and the
// digest a registration is checked against.
// DELIBERATE: the second-flow signature is computed inside the module and reaches a consumer on
// `SecondFlowRun`, not as an exported function.
export {
  createHost,
  moduleDigest,
  runSecondFlowFixture,
  type ActionGrant,
  type CompletionRule,
  type ControlVerdict,
  type EnrolmentRule,
  type EvidenceDraft,
  type EvidenceEntry,
  type EvidenceKind,
  type Host,
  type ProcedureSignature,
  type ProcedureStep,
  type ReviewedModule,
  type RunCaller,
  type SecondFlowRun,
} from "./host.js";

// What a documentary recall episode concluded. `retrieval_inconclusive` (could not answer) is
// distinct from `no_relevant_match_in_searched_scope` (ran cleanly, found nothing); `RecallBlocker`
// enumerates every reason the first is owed instead of the second.
export {
  recallResultFrom,
  type RecallBlocker,
  type RecallBudgetLine,
  type RecallClaimKind,
  type RecallCompleteness,
  type RecallEpisodeBudget,
  type RecallFinding,
  type RecallFindingStatus,
  type RecallMatchKind,
  type RecallOutcome,
  type RecallQuote,
  type RecallReceiptStatus,
  type RecallResult,
  type RecallSearchItem,
  type RecallSearchOutcome,
  type RecallSearchReceipt,
  type RecallSupport,
} from "./recall.js";

// A plan's structural report says whether the document can be executed from — unique task ids, an
// Output per task, dependencies that resolve, no cycle — and nothing about whether the plan is any
// good.
export {
  validatePlan,
  type PlanStructuralReport,
  type PlanViolation,
  type PlanViolationKind,
} from "./plan-validation.js";

// The semantic-assessment port. A label with no probability yields an empty signals array, never
// zero, 0.5 or a one-hot distribution. A confidence the model typed as text is `self_reported`
// however numeric it looks; only a declared native channel is a distribution. `unavailable` (the
// call failed) is distinct from `unknown` (the assessor could not tell).
export {
  QUESTION_FAMILIES,
  interpret,
  type AnswerOption,
  type AnswerSpec,
  type AskedQuestion,
  type AssessmentCall,
  type AssessmentStatus,
  type CallFailure,
  type IdentityAssurance,
  type SemanticAssessment,
  type SemanticQuestion,
  type SemanticValue,
  type SignalOrigin,
  type StatisticalSignal,
} from "./assessment.js";


// The first production assessor adapter. A hosted service asserting its own version is a provider
// assertion, not cryptographic proof: a match records `provider_reported`, an alias pin records
// `unverified`.
// DELIBERATE: the model name is never fed to the port as an observed identity.
export { jevAdapter } from "./adapters/jev.js";
// What a caller needs to ask through it and to read what came back: how one question's reply is to
// be validated, and the record plus validated readings each reply becomes.
export type { JevAnswerOptions, JevParseResult } from "./adapters/jev.js";

// Whether a step may be entered: evidence is required at a standard, a holding at a lower standard
// is reported as held rather than absent, and a requirement discharged on a named ground carries
// that ground out on the admission.
export {
  admitEntry,
  type EntryAdmission,
  type EntryWaiver,
  type EvidenceStanding,
  type EvidenceStandard,
  type UnmetRequirement,
} from "./stage-control.js";

// `deriveOutcome` is the only producer of an outcome and `closeInitiative` cannot be handed one;
// `acceptedByHand` observes that a caller supplied one. `no_signoff_reason` is carried and is not an
// input to the derivation. `state` and `evidence` come out of one builder, so `established` with no
// evidence is not a shape this module can produce.
export {
  closeInitiative,
  deriveOutcome,
} from "./close.js";

// DELIBERATE: no types from `close.js` are on this door. Its other interfaces are reachable only
// through a return position, so TypeScript emits them into the `.d.ts` as local declarations and a
// consumer gets the full shape by inference; the three it exports are named by its probe. Nothing
// outside this package names either group.

// The negative control for the refusals above: each detector silent on a healthy subject and
// firing on a planted fault.
export { closeProbe, type CloseProbeRow } from "./close-probe.js";
