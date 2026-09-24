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
// DELIBERATE: the lane-to-match-kind mapping is not on this door — it runs inside
// `recall-trial.ts`.
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
// good. `admitToExecute` is the other half; neither substitutes for the other.
export {
  admitToExecute,
  validatePlan,
  type ExecuteAdmission,
  type ExecuteAdmissionRequest,
  type ExecuteRefusal,
  type PlanStructuralReport,
  type PlanViolation,
  type PlanViolationKind,
} from "./plan-validation.js";

// The semantic-assessment port. A label with no probability yields an empty signals array, never
// zero, 0.5 or a one-hot distribution. A confidence the model typed as text is `self_reported`
// however numeric it looks; only a declared native channel is a distribution. `unavailable` (the
// call failed) is distinct from `unknown` (the assessor could not tell).
// DELIBERATE: whether an assessment may carry a semantic advance is asked through
// `evaluateBranch`, not through a predicate on this door.
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

// Grant issuance, internal only. Every ControlGrant field is derived — issuer component digest,
// originating decision, effect digest, sorted dependency pins — and none is caller-supplied.
// `INTERNAL_GRANT_ISSUANCE` is the one spelling of the name.
// DELIBERATE: `issueControlGrant`, `claimAgainstGrant`, `createGrantStore` and `canonicalTarget`
// are not on this door; consumers outside the package get `control-grant-fixture.ts`. The three
// digest helpers stay private to `control-grant.ts`.
export {
  INTERNAL_GRANT_ISSUANCE,
  type ApprovedIssuer,
  type ClaimOutcome,
  type ControlDecision,
  type ControlEffect,
  type ControlGrant,
  type DependencyPin,
  type GrantClaim,
  type GrantIssuance,
  type GrantIssuanceRequest,
  type GrantStore,
  type GrantUse,
  type GrantWorldSeed,
  type ProbeableGrantStore,
  type ResourceIdentity,
  type TrustedHostContext,
} from "./control-grant.js";

// The door stand-in. `@zz/contracts` sits below `services/` and cannot import from it, so this is
// a fixture, never the real registry: it lets the refusal and the successful control both be run.
export {
  callTool,
  grantFixtureWorld,
  issueForTest,
  registeredTools,
  resetGrantFixture,
  type FixtureRole,
  type FixtureWorld,
  type IssueForTestRequest,
  type RegisteredTool,
  type ToolOutcome,
} from "./control-grant-fixture.js";

// Central role bindings. A run resolves its binding once, at enrolment, and stores it; an in-flight
// run never reads the current default again. `rebind` suspends and reconciles first, revokes the
// grants that depended on the old binding, and refuses to carry calibration or cached answers
// across. `rebindDetectorProbe` plants faults through a private seam and reports which detectors
// noticed.
// DELIBERATE: filing a threshold or an invocation, the shapes either produces, and the run's event
// ledger stay module-private. `RebindResult` answers `suspendedFirst` and `historyPreserved` from
// the entries a rebind appended.
export {
  rebind,
  rebindDetectorProbe,
  resolveFor,
  setDefaultBinding,
  startRun,
  type EnrolledRun,
  type ProbeReport,
  type RebindRequest,
  type RebindResult,
  type ResolvedBinding,
  type RoleBindings,
} from "./bindings.js";

// The register's vocabulary: what a profile ref is, separately from what it is bound to — the
// declaration a caller writes, the resolved shape, and the slice a measurement is qualified on.
// DELIBERATE: `declareProfile` and `qualificationKey` are not on this door; `bindings.ts` reaches
// them as a sibling. A key minted elsewhere is one no rebind can find.
export {
  type BoundRole,
  type ProfileDeclaration,
  type QualificationSlice,
  type ResolvedProfile,
} from "./profiles.js";

// The dependency snapshot. `content_hash` is recorded as a witness and never compared — a
// record-local digest cannot see an external dependency move while the target's own bytes stay put.
// Validity iterates the closed set of dependency kinds, not the snapshot's own entries: a kind with
// no entry is a coverage gap, and a gap pauses rather than passing. `stillValid` is all a caller
// gets; the verdict behind it stays in the module.
export {
  snapshot,
  snapshotCoverageProbe,
  stillValid,
  type CoverageFinding,
  type CoverageProbeRow,
  type DependencyPinEntry,
  type DependencySnapshot,
  type DependencyValue,
  type DependencyWorld,
  type PinState,
  type ValidityState,
  type VersionPredicate,
} from "./dependency-snapshot.js";

// The commit boundary: the predicate check and the effect publication happen inside one
// serialization covering the separate permission store, or a stale grant races a revocation.
// `holdsLockAcrossModelCall` is computed from the step list — no model call or backoff may hold a
// document lock.
export {
  boundaryDetectorProbe,
  boundaryOf,
  type BoundaryProbeRow,
  type CommitBoundary,
} from "./commit-boundary.js";

// Commit-result reconciliation: what a caller may conclude from each of the mutation kernel's three
// replies. The canonical no-op (`committed: true, changed: false`, null transaction, null commit
// sequence) is `applied` with its nulls left as nulls; a pending projection is catch-up work on an
// applied write, not a fourth result; an unknown commit reconciles against the transaction and key
// it was already sent under. The four negative flags are computed by an audit comparing plan to
// reply, not set by the branch that built the plan.
export {
  reconcile,
  reconcileDetectorProbe,
  type CommitOutcome,
  type CommitRefusal,
  type DurableWrite,
  type FollowUpStep,
  type OriginalOperation,
  type ProposedRequest,
  type ReconcileProbeRow,
  type Reconciliation,
  type ReconciliationPlan,
} from "./commit-reconciliation.js";

// A second executable assessor that declares it has no probability primitive.
// `native_distributions: false` for a backend returning a word: `confidence: "0.93"` is a string,
// so it is `self_reported` and never a distribution, and a branch needing a probability declines
// rather than consuming it. A `local-only` profile with its primary down reaches a declared local
// standby; locality is a register field, never a reading of a name.
export { labelAdapter } from "./label-adapter.js";
export { evaluateBranch } from "./branch-policy.js";
export { resolveEndpoint } from "./local-transport.js";

// The first production assessor adapter. A hosted service asserting its own version is a provider
// assertion, not cryptographic proof: a match records `provider_reported`, an alias pin records
// `unverified`. The sibling label adapter compares deployment digests and may reach
// `deployment_verified`.
// DELIBERATE: the model name is never fed to the port as an observed identity.
export { jevAdapter } from "./adapters/jev.js";
// What a caller needs to ask through it and to read what came back: how one question's reply is to
// be validated, and the record plus validated readings each reply becomes.
export type { JevAnswerOptions, JevParseResult } from "./adapters/jev.js";

// The runtime adapter port. A dispatch returns a work id and cannot report a completion —
// `completed` is typed `never`. A cancellation request is not a confirmation: only the confirmed arm
// of `CancelOutcome` carries `treatedAsStopped`, naming the runtime record behind it. A lease expiry
// never proves a worker stopped, so `lease_expiry_proves_stop` is typed `false`. The last line of a
// feed is the last activity observed, so `Observation` pairs completeness with receipt and names its
// elapsed field for the floor it is. An unsupported capability is declared (`simulated: false`) and
// admission decides whether the work may run.
// DELIBERATE: only shapes are published here. The port's vocabularies, digest and admission rule
// are named by `claude-code.ts`, `batch-queue.ts` and `conformance.ts` beside it; a consumer meets
// all three through `runConformance` below.
export type {
  CapabilityDeclaration,
  AssetRole, BoundAsset, CancelOutcome, CancelRequest, CancelState,
  CancellationLimits, CompletionReceipt, DeclaredUnsupported,
  DispatchAck, DispatchRequest, EventFormatIdentity, LoadMethodRequest,
  MethodBinding, Observation, ObservedCompleteness, ObservedEvent,
  ObserveRequest, ReceiptAssurance, ResumeOutcome, ResumeRequest,
  RuntimeAdapter, RuntimeAdmission, RuntimeCapabilities,
  RuntimeCapability, StopEvidence, TaskProfile,
} from "./adapters/port.js";

// What a piece of work consumed: a record is counted exactly when no ancestor of it is marked as
// already including its descendants. An unresolvable ancestry excludes the record by name and drops
// the total to `floor_only`, a lower bound that says so. Each adapter runs the rule while turning
// its runtime's accounting into a `UsageTotal`, so a consumer is handed the total, never the
// counting.
export type {
  UsageCompleteness, UsageRecord, UsageTotal,
} from "./adapters/usage.js";

// Every runtime adapter this release ships, and the protocol all of them are driven through.
// `runConformance` asserts each adapter against its own declaration: an adapter that says it can
// confirm a stop must confirm one, and an adapter that says it cannot must never produce the
// confirmed answer.
export {
  adapters, runConformance,
  type ConformanceReport,
} from "./adapters/conformance.js";

// Whether a step may advance. Bytes added, rounds elapsed, a model's confidence in itself and an
// aggregate score are each carried into the verdict's `disregarded` list by name with the reason
// they were set aside. `advance` is computed from outcome evidence, closed gaps and recorded gates
// and from nothing else. An episode's key digests subject and criteria and never the label, so a
// rename spends the same budget; exhaustion sets `exhausted` and a blocker, never `advance`.
// DELIBERATE: the keying function is not published — `readiness` applies it to every input it is
// given.
export {
  readiness,
  type AuditContext,
  type AuditEpisode,
  type DisregardedObservation,
  type ObservedSignals,
  type ReadinessInput,
  type ReadinessVerdict,
} from "./readiness.js";

// One controller for every step a flow declares. The bound contracts arrive as data in an
// `ExecutionProfile` resolved above this layer, so this module has no step list and cannot name one.
// A step entered without its entry evidence returns the missing kinds; a call against a superseded
// revision is refused and carries the current one; `needs_revisit` is computed from the outcome the
// controller holds, never set by a caller. Evidence is required at a standard and can be discharged
// on a named ground rather than met; which standard applies and what grounds exist are
// caller-supplied.
// DELIBERATE: `admitEntry` is the only half on this door — the entry rule alone, so a caller with no
// execution to hang the question on, such as `services/zz-core/src/guards.ts`, can ask it without
// fabricating an identity and a revision. The full controller is built and exercised by
// `stage-control-probe.ts` beside it; nothing in this repository drives a declared flow.
export {
  admitEntry,
  type ControlState,
  type EntryAdmission,
  type EntryWaiver,
  type EvidenceStanding,
  type EvidenceStandard,
  type ExecutionIdentity,
  type ExecutionProfile,
  type OutcomeState,
  type RefusalKind,
  type StageAdmission,
  type StageController,
  type StageEntry,
  type StageOutcome,
  type StageRefusal,
  type StageSettlement,
  type StageSettlementResult,
  type StepContract,
  type UnmetRequirement,
} from "./stage-control.js";

// The negative control. Each rule above is exercised twice: silent on a healthy subject, firing on
// a planted fault. Its fixture profile is seven generic steps — this package sits below the layer
// that binds a flow's declared names.
export { stageControlProbe, type StageControlProbeRow } from "./stage-control-probe.js";

// The seven check states, owned by neither consumer: an audit record and an observation manifest
// need the same seven words. `unknown` is the default and is never written as `passed` or `failed`.
// DELIBERATE: the list and the type are published, not the coercion. Narrowing an arbitrary value
// happens in the two modules here that read a record off disk; a consumer outside holds a
// `CheckState` and asks `CHECK_STATES.includes(…)` where it must.
export {
  CHECK_STATES,
  type CheckState,
} from "./check-state.js";

// Audit identity. Every audit carries execution, attempt, reviewer, target, report and completion
// identity, and an assessment can neither resolve a finding, delete one, nor stand in for a
// required test — each is a computed refusal.
// DELIBERATE: recording a finding and reading an assessment against one are published; opening an
// audit record and closing a finding are not, and stay exported only to this package's own probes.
// `recordAudit` refuses six missing identities, `resolveFinding` refuses a verification that did not
// pass, and `finding_decide` in zz-core keeps its own vocabulary.
export {
  applyAssessment,
  recordFinding,
  type AssessedFinding,
  type Assessment,
  type AuditIdentity,
  type Finding,
  type FindingDisposition,
  type FindingInput,
  type FindingWithdrawal,
  type RecordedResolution,
  type RequiredTest,
  type TestDischarge,
} from "./audit-identity.js";

// The six historical rounds, imported with what is missing still missing. No report records who
// reviewed it, so every imported row reads `unavailable` rather than borrowing `contributed_by`,
// which records source intake and is not reviewer identity. A digest exists only when a caller
// supplies the bytes, and is then labelled `computed_at_import`.
export {
  importLegacyAudits,
  type FieldOrigin,
  type LegacyAuditRow,
  type LegacySnapshotBytes,
  type RepositoryGrounding,
} from "./audit-legacy-import.js";

// Linked sources and approval chronology show that a version changed and cited an input; they
// cannot show which stage the work returned from. An inferred relation is kept as `inferred` and
// can never be represented as `observed`.
export {
  transitionsFor,
  type InferredRelation,
  type ObservedTransition,
  type RejectedEvent,
  type TransitionEvent,
  type TransitionInput,
  type TransitionRecord,
  type TransitionRelationKind,
} from "./stage-transition.js";

// The negative control for the three rules above: ten planted faults, each shown firing on a
// damaged subject and silent on a healthy one.
export { auditIdentityProbe, type AuditIdentityProbeRow } from "./audit-identity-probe.js";

// Nine action kinds. `ACTION_KINDS` is the keys of the contract inventory, so the count cannot pass
// a length check while an entry is missing. Coexisting gap kinds stay separate — `collapsedToOne` is
// observed by counting the units that answer them — and a gap with no permitted action resolves to a
// pause carrying a concrete resumption condition. There is no `advance` kind: review grants close
// eligibility.
// DELIBERATE: `ACTION_CONTRACTS` and `GAP_KINDS` are not on this door; both are read by `routeGap`
// on the way to a routing, and the routing carries the answer they encode.
export {
  ACTION_KINDS,
  routeGap,
  type Action,
  type ActionKind,
  type Gap,
  type GapRouting,
} from "./gap-routing.js";

// The three moves that are not ordinary work, each inviting the same deadlock: a permission that
// cannot be granted until the thing it permits has happened. Opening invents no prior outcome; a
// corrective return invalidates dependent readiness and never requires forward progress first;
// close eligibility is a grant, never a close. One letter from `stage-transition.js` above and a
// different subject: this is whether a move is permitted, that is whether one was recorded.
export {
  bootstrap,
  correctiveReturn,
  reviewClose,
  type BootstrapInput,
  type BootstrapResult,
  type CloseEligibilityInput,
  type CloseGrant,
  type CorrectiveReturn,
  type CorrectiveReturnInput,
  type DependentReadiness,
  type Objective,
} from "./stage-progression.js";

// The four audits, which import nothing — not the router, not the contract inventory, not the gap
// vocabulary. They answer structural questions about plain string lists, so the mechanism cannot
// make them agree with it.
// DELIBERATE: the audits are not on this door. They run over the lists `routeGap`, `bootstrap`,
// `correctiveReturn` and `reviewClose` produce — no one of those runs every audit, because not every
// move can commit every fault — and a caller reads the result. Published here is the precondition
// shape a caller supplies to be audited.
export {
  type PermissionPrecondition,
} from "./gap-audit.js";

// The negative control: nineteen rows, each silent on a healthy subject and firing on a planted
// fault, covering every flag above that says something did not happen.
export { gapRoutingProbe, type GapRoutingProbeRow } from "./gap-routing-probe.js";

// What the work touched, including what git was told to ignore: a build artifact or a report
// written outside version control is still an output, so the walk never reads an ignore rule and
// `includesIgnored` is reduced over what was actually excluded. Completeness is reported —
// `complete`, `bounded` or `incomplete`, with a reason per gap.
export {
  captureManifest,
  type ManifestCapture,
  type ManifestCaptureOptions,
} from "./observation-manifest.js";

// The baseline a caller carries between two captures. The only name the walk puts on the door:
// everything else it exports is a seam the manifest module imports, not a public surface.
export { type FileManifest } from "./observation-walk.js";

// `deriveOutcome` is the only producer of an outcome and `closeInitiative` cannot be handed one;
// `acceptedByHand` observes that a caller supplied one. `no_signoff_reason` is carried and is not an
// input to the derivation. `state` and `evidence` come out of one builder, so `established` with no
// evidence is not a shape this module can produce. `proposed_team_nodes` is labelled self-reported
// and nothing reads it back.
export {
  closeInitiative,
  deriveOutcome,
  handoverClaims,
} from "./close.js";

// DELIBERATE: no types from `close.js` are on this door. Seven of its interfaces are reachable only
// through a return position, so TypeScript emits them into the `.d.ts` as local declarations and a
// consumer gets the full shape by inference; six more are exported from the module for its probe.
// Nothing outside this package names either group.

// The negative control for the four refusals above, written to disk so the closing review can watch
// each fire without re-running the worker.
export { closeProbe, type CloseProbeRow } from "./close-probe.js";

// One recall episode end to end: public search, a pinned read of the original, source and
// supersession traversal, and a result in the language the asker used. A broadened or graph hit is a
// lead until original text supports the claim; a current head may be fetched to check supersession
// but never replaces the revision a citation named; a translation is a search hypothesis and is
// never written back into the document. `answer_language` is derived from the question alone.
export { trial } from "./recall-trial.js";

// The negative control for the four computed flags above, including faulted local copies of
// computations that no input can make the real ones perform.
export { recallTrialProbe, type RecallTrialProbeRow } from "./recall-trial-probe.js";

// The trial's own analyzer, on the door so its agreement with `@zz/indexing`'s is measurable. The
// corpus needs Han segmentation and this package sits below `@zz/indexing`, so it keeps a copy of
// the Han half.
// COUPLED: the copy has to track `identifierTokens` in `@zz/indexing`; a gate check imports both
// and holds the copy to the original. Nothing else names this export.
// DELIBERATE: named by module, not by analyzer version. `ANALYZER_NAME` is `zz-lexical-v3` and has
// moved before; the copy tracks whatever that module emits, not a numbered generation.
export { trialAnalyze } from "./recall-trial-corpus.js";
