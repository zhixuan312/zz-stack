/**
 * The control loop's contracts, through one door.
 *
 * WHY THIS FILE EXISTS AT ALL, since `index.ts` is already the package's door. `index.ts` is
 * 660 lines against a 700-line ceiling this repository enforces with no exemption list, and
 * the control loop arrives as many modules rather than one. A block per module appended
 * there would take the package's own door over the ceiling, and the task that happened to be
 * last would be the one reported for it — a failure attached to the wrong change.
 *
 * So the modules aggregate HERE and `index.ts` carries a single block re-exporting this file.
 * That block is written once and never edited again — which is the whole reason it is the one
 * wildcard in that file: a module added below has to reach every consumer of `@zz/contracts`
 * without anybody touching the door, and a name list there would have to be edited by every
 * task that adds a module, which is the growth the ceiling cannot take.
 *
 * EXPLICIT NAMES HERE, THOUGH, one commented block per module — the same shape `index.ts`
 * uses for the four modules it re-exports directly. The wildcard buys a door that never has
 * to change; this file is where a reader asks where a symbol comes from and gets an answer
 * without consulting a resolver, and where a name that stops existing breaks the build
 * rather than quietly disappearing from the package surface.
 *
 * NOTHING IS DECLARED HERE. This file re-exports and does no other work; a helper declared in
 * an aggregator is a helper nobody expects to find in one.
 */

// The generic control-loop host: what a reviewed module is, the five operations a host serves
// (`run_start`, `method_read`, `evidence_record`, `control_evaluate`, `action_claim`), the
// digest a registration is checked against, and the structural signature that says whether a
// procedure is a second flow or the platform's own pipeline under other names.
export {
  createHost,
  moduleDigest,
  procedureSignature,
  reusesGatedDocumentPipeline,
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

// What a documentary recall EPISODE concluded, and the distinction the whole type exists for:
// a search that could not answer (`retrieval_inconclusive`) is not a search that ran cleanly and
// found nothing (`no_relevant_match_in_searched_scope`). A complete empty means no match under
// that search — never that the team never decided the topic. `RecallBlocker` enumerates every
// reason the first verdict is owed instead of the second.
export {
  matchKindFromVia,
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

// SHAPE, NOT ADEQUACY. A plan's structural report says whether the document can be executed
// from — unique task ids, an Output per task, dependencies that resolve, no cycle — and says
// nothing about whether the plan is any good. `admitToExecute` is the other half and the whole
// point: a human approval is a verdict on CONTENT and can never stand in for the report, and a
// missing report is not a pass. Neither substitutes for the other.
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

// THE SEMANTIC-ASSESSMENT PORT, and most of its value is in what it refuses to invent. A label
// with no probability yields an EMPTY signals array — not zero, not 0.5, and never a one-hot
// distribution manufactured from a category. A confidence number the model typed as text is
// `self_reported` however numeric it looks; only a declared native channel is a distribution.
// And `unavailable` (the call failed) is kept distinct from `unknown` (the assessor answered
// and could not tell), because collapsing them turns a timeout into a considered judgement.
export {
  QUESTION_FAMILIES,
  authorizesSemanticAdvance,
  interpret,
  interpretBatch,
  type AnswerOption,
  type AnswerSpec,
  type AskedQuestion,
  type AssessmentCall,
  type AssessmentStatus,
  type BatchAssessment,
  type CallFailure,
  type IdentityAssurance,
  type SemanticAssessment,
  type SemanticQuestion,
  type SemanticValue,
  type SignalOrigin,
  type StatisticalSignal,
} from "./assessment.js";

// GRANT ISSUANCE, which is internal-only and must stay that way. Every field of a ControlGrant
// is DERIVED — the issuer's component digest, the decision it came from, the effect digest, the
// sorted dependency pins — and none is caller-supplied, because a grant a caller can describe is
// a bearer permission wearing a server record's name. `INTERNAL_GRANT_ISSUANCE` is the one
// spelling of the name, so nothing downstream can register a second.
//
// THE ENGINE ITSELF IS NOT ON THIS DOOR, and that is the point rather than an omission.
// `issueControlGrant`, `claimAgainstGrant`, `createGrantStore` and `canonicalTarget` are
// reached only by `control-grant-fixture.ts` beside them, which is what a consumer outside
// this package is given: a driveable stand-in, never the minting function. Publishing them
// here would put the one operation this release refuses to register within one import of
// anybody who can write `@zz/contracts`. The three digest helpers are narrower still — they
// are private to `control-grant.ts`, because every one of them is a step in a derivation the
// handler re-runs rather than a question a caller is entitled to ask.
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

// The door STAND-IN, kept in its own module and named as one. `@zz/contracts` sits below
// `services/` and cannot import from it, so this can never be the real registry — it is a
// fixture that lets the refusal and the successful control both be exercised. That the real
// doors register no issuer is established against real source, not here.
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

// CENTRAL ROLE BINDINGS. A global default change must not reach work already under way: a run
// resolves its binding ONCE, at enrolment, and stores it — there is no path by which an
// in-flight run reads the current default again. Moving one onto a new profile is a deliberate
// act (`rebind`) that suspends and reconciles first, revokes the grants that depended on the
// old binding, and refuses to carry calibration or cached answers across, because those were
// qualified against a different model identity.
//
// `rebindDetectorProbe` is a NEGATIVE CONTROL, not a convenience. It plants faults through a
// seam this module keeps private and reports whether each detector noticed — because a
// detector that answers "no defect" for everything answers it for a real defect too. The first
// version of this module compared qualification keys to audit a key-based retirement
// mechanism, and the probe is what showed both detectors silent exactly when the mechanism was
// broken.
export {
  bindingHistory,
  rebind,
  rebindDetectorProbe,
  recordCalibration,
  recordInvocation,
  resolveFor,
  revokeProfile,
  setDefaultBinding,
  startRun,
  type BindingEvent,
  type BindingEventKind,
  type CalibrationEntry,
  type EnrolledRun,
  type InvocationRecord,
  type ProbeReport,
  type ProfileRevocation,
  type Qualified,
  type RebindRequest,
  type RebindResult,
  type ResolvedBinding,
  type RoleBindings,
} from "./bindings.js";

// THE REGISTER — what a profile ref IS, separately from what it is bound to. Resolution, the
// immutable-ref rule, the handle grammar (a ref resolves to a host-held handle and never to a
// URL or a secret) and the qualification key. Split from `bindings.ts` because those are two
// subjects: this one is the vocabulary, that one is what changing a binding costs.
export {
  declareProfile,
  qualificationKey,
  type BoundRole,
  type ProfileDeclaration,
  type QualificationSlice,
  type ResolvedProfile,
} from "./profiles.js";

// THE DEPENDENCY SNAPSHOT, and the one thing it must not do. `content_hash` is recorded as a
// witness and NEVER compared — because a record-local digest cannot see an external dependency
// moving while the target's own bytes stay put, and that is the whole defect this task exists
// for. Validity is decided by iterating the CLOSED SET of dependency kinds, not the snapshot's
// own entries: a kind with no entry is a coverage gap, and a gap pauses rather than passing.
export {
  revalidate,
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
  type ValidityVerdict,
  type VersionPredicate,
} from "./dependency-snapshot.js";

// THE COMMIT BOUNDARY: the predicate check and the effect publication have to happen inside one
// serialization, and it has to cover the separate permission store, or a stale grant races a
// revocation. `holdsLockAcrossModelCall` is computed from the step list rather than asserted —
// no model call or backoff may hold a document lock.
export {
  boundaryDetectorProbe,
  boundaryOf,
  type BoundaryProbeRow,
  type CommitBoundary,
} from "./commit-boundary.js";

// Commit-result reconciliation: what a caller may conclude from each of the mutation kernel's
// three replies. The canonical no-op (`committed: true, changed: false`, null transaction, null
// commit sequence) is `applied` with its nulls left as nulls; a pending projection is catch-up
// work attached to an applied write rather than a fourth result; an unknown commit reconciles
// against the transaction and the key it was already sent under. The four negative flags are
// COMPUTED by an audit that compares the plan against the reply, not set by the branch that
// built the plan — `reconcileDetectorProbe` plants one fault per flag and shows each fire.
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

// A SECOND EXECUTABLE ASSESSOR, differing from the one with a probability primitive in exactly
// the way that matters: it declares it has none. `native_distributions: false` is the truthful
// statement about a backend that returns a word, and the rest follows from refusing to paper
// over it — a model emitting `confidence: "0.93"` has emitted a string, so it is `self_reported`
// and never a distribution; a branch that genuinely needs a probability DECLINES rather than
// consuming that number; and a `local-only` profile with its primary down reaches a declared
// local standby, because locality is a field in the register and never a reading of a name.
export { labelAdapter } from "./label-adapter.js";
export { evaluateBranch } from "./branch-policy.js";
export { resolveEndpoint } from "./local-transport.js";

// THE FIRST PRODUCTION ASSESSOR ADAPTER. Its identity rule is the half most easily got wrong:
// a hosted service asserting its own exact version is a PROVIDER ASSERTION, never cryptographic
// proof, so a match records `provider_reported` and an alias pin records `unverified`. The
// sibling label adapter compares deployment DIGESTS and may reach `deployment_verified`; the
// two are different evidence reaching different assurance, not a disagreement. An adapter that
// instead fed the model NAME to the port as an observed identity would have the port comparing
// a vendor's self-report against a pin — green on every test, verifying nothing.
export { jevAdapter } from "./adapters/jev.js";
// What a caller needs to ASK through it and to READ what came back: how one question's reply is
// to be validated, and the record plus validated readings each reply becomes.
export type { JevAnswerOptions, JevParseResult } from "./adapters/jev.js";

// THE RUNTIME ADAPTER PORT, and the second adapter that is the only reason it can be called
// one. A dispatch returns a work id and cannot report a completion — `completed` is typed
// `never`. A cancellation request is not a confirmation: only the confirmed arm of
// `CancelOutcome` carries `treatedAsStopped`, and it has to name the runtime record behind it.
// A lease expiry never proves a worker stopped, which is why `lease_expiry_proves_stop` is
// typed `false`. The last line of a feed is the last activity observed, so `Observation` pairs
// its completeness with its receipt and names its elapsed field for the floor it is. An
// unsupported capability is DECLARED (`simulated: false`) and admission decides whether the
// work may run at all.
//
// THE PORT PUBLISHES SHAPES HERE AND NOTHING ELSE. Its vocabularies, its digest and its
// admission rule are named by `claude-code.ts`, `batch-queue.ts` and `conformance.ts` beside
// it and by nothing outside this package — a contract's own implementations are not its
// consumers. A consumer meets all three through `runConformance` below, which is the form in
// which they are meant to be met: an adapter judged against its own declaration, rather than
// a set of constants a caller could re-implement the judgement from.
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

// WHAT A PIECE OF WORK CONSUMED, under one rule stated in the data: a record is counted
// exactly when no ancestor of it is marked as already including its descendants. Where an
// ancestry cannot be resolved the record is excluded BY NAME and the total drops to
// `floor_only` — a lower bound that says it is one. The rule runs where the records are read:
// each adapter calls it while turning its runtime's own accounting into a `UsageTotal`, so a
// consumer is handed the total and never the counting. Publishing the counter beside the total
// would offer a second way to arrive at a different number.
export type {
  UsageCompleteness, UsageRecord, UsageTotal,
} from "./adapters/usage.js";

// EVERY RUNTIME ADAPTER THIS RELEASE SHIPS, and the protocol all of them are driven through.
// `runConformance` asserts each adapter against ITS OWN declaration — an adapter that says it
// can confirm a stop must confirm one, and an adapter that says it cannot must never produce
// the confirmed answer — so neither can be satisfied by imitating the other.
export {
  adapters, runConformance,
  type ConformanceReport,
} from "./adapters/conformance.js";

// WHETHER A STEP MAY ADVANCE, and the four measurements that are real and are not grounds.
// Bytes added, rounds elapsed, a model's confidence in itself, an aggregate score — each is
// carried into the verdict's `disregarded` list BY NAME with the reason it was set aside,
// rather than hidden, so a reader can see it was seen and refused. `advance` is computed from
// outcome evidence, closed gaps and recorded gates, and from nothing else; a twelve-byte
// evidenced correction advances and half a megabyte with a gap open does not. An episode is
// keyed by what it audits (`episodeKey` digests subject and criteria, never the label), so a
// rename spends the same budget — and exhaustion sets `exhausted` and a blocker, never `advance`.
export {
  episodeKey,
  readiness,
  type AuditContext,
  type AuditEpisode,
  type DisregardedObservation,
  type ObservedSignals,
  type ReadinessInput,
  type ReadinessVerdict,
} from "./readiness.js";

// ONE CONTROLLER FOR EVERY STEP A FLOW DECLARES. The bound contracts arrive as DATA in an
// `ExecutionProfile`, resolved above this layer from whatever the flow declared — this module
// has no step list and cannot name one, which is what keeps the kernel generic. A step entered
// without its entry evidence returns the missing kinds; a call against a superseded revision is
// refused and carries the current one; `needs_revisit` is COMPUTED from the outcome the
// controller already holds, never set by a caller. `admitEntry` is the entry rule itself,
// exported beside the controller because a caller with no execution to hang the question on —
// a guard on a single write — must not have to fabricate an identity and a revision, and must
// not keep a second copy of the rule instead. Evidence is required at a STANDARD, and a
// requirement can be DISCHARGED on a named ground rather than met; which standard applies and
// what grounds exist are caller-supplied facts, like every other input here.
export {
  admitEntry,
  createController,
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

// The negative control. Each rule above is exercised twice — silent on a healthy subject, firing
// on a planted fault — because a detector nobody has watched fail is a detector nobody has
// tested. Its fixture profile is seven generic steps: this package is below the layer that binds
// a flow's declared names, and the probe demonstrates that a seven-step profile resolves every
// contract through the one controller without knowing what any of them is called.
export { stageControlProbe, type StageControlProbeRow } from "./stage-control-probe.js";

// THE SEVEN CHECK STATES, OWNED BY NEITHER CONSUMER. An audit record says what state a check
// was observed in and an observation manifest says what state it was captured in; both need the
// same seven words, and a vocabulary owned by one of two equal consumers is two vocabularies
// waiting to disagree. `unknown` is the default and is never written as `passed` or `failed`.
export {
  CHECK_STATES,
  UNDETERMINED_CHECK_STATE,
  asCheckState,
  type CheckState,
} from "./check-state.js";

// AUDIT IDENTITY, AND THE THREE THINGS AN ASSESSMENT CANNOT DO. Every audit carries execution,
// attempt, reviewer, target, report and completion identity; a finding a later round disputes
// coexists with the original rather than replacing it; and an assessment can neither resolve a
// finding, delete one, nor stand in for a required test — each of those is a computed refusal
// rather than a convention. `UNAVAILABLE` is the sentinel for what a record genuinely lacks.
export {
  applyAssessment,
  disputeFinding,
  recordAudit,
  recordFinding,
  resolveFinding,
  UNAVAILABLE,
  type AssessedFinding,
  type Assessment,
  type AuditIdentity,
  type AuditOutcome,
  type AuditRecord,
  type AuditRefusal,
  type Finding,
  type FindingClosure,
  type FindingDisposition,
  type FindingDispute,
  type FindingInput,
  type FindingLedger,
  type FindingWithdrawal,
  type RecordedResolution,
  type RequiredTest,
  type TestDischarge,
} from "./audit-identity.js";

// THE SIX HISTORICAL ROUNDS, IMPORTED WITH WHAT IS MISSING STILL MISSING. None of the six
// reports records who reviewed it, so every imported row reads `unavailable` rather than
// borrowing `contributed_by`, which records source intake and is not reviewer identity. A
// digest exists only when a caller supplies the bytes, and is then labelled `computed_at_import`
// — a hash computed today is never presented as a signature somebody left behind.
export {
  importLegacyAudits,
  type FieldOrigin,
  type LegacyAuditRow,
  type LegacySnapshotBytes,
  type RepositoryGrounding,
} from "./audit-legacy-import.js";

// A TRANSITION IS A RECORDED FACT OR IT IS NOT A FACT. Linked sources and approval chronology
// show that a version changed and cited an input; they cannot show which stage the work
// returned from. So an inferred relation is kept as `inferred` — discarding it would lose a
// real signal — and can never be represented as `observed`. Chronology is not causality.
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

// The negative control for the three rules above: eleven planted faults, each shown firing on a
// damaged subject and silent on a healthy one. A refusal nobody has watched fail is untested.
export { auditIdentityProbe, type AuditIdentityProbeRow } from "./audit-identity-probe.js";

// NINE ACTION KINDS, AND A GAP THAT REACHES THE WORK THAT RESOLVES IT. `ACTION_KINDS` is the
// keys of the contract inventory, so the count cannot pass a length check while an entry is
// missing. Coexisting gap kinds stay separate — `collapsedToOne` is observed by counting the
// units that answer them, not asserted — and a gap with no permitted action resolves to a pause
// carrying a concrete resumption condition. There is NO `advance` kind: review grants close
// eligibility, which is why it cannot advance to a stage that does not exist.
export {
  ACTION_CONTRACTS,
  ACTION_KINDS,
  GAP_KINDS,
  routeGap,
  type Action,
  type ActionContract,
  type ActionKind,
  type Gap,
  type GapRouting,
} from "./gap-routing.js";

// THE THREE MOVES THAT ARE NOT ORDINARY WORK, each inviting the same deadlock: a permission that
// cannot be granted until the thing it permits has already happened. Opening invents no prior
// outcome; a corrective return invalidates dependent readiness rather than leaving it standing,
// and never requires forward progress first; close eligibility is a grant, never a close.
// Named `stage-progression`, one letter from `stage-transition.js` above and a different
// subject: this is whether a move is PERMITTED, that is whether a transition was RECORDED.
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

// THE FOUR AUDITS, WHICH IMPORT NOTHING — not the router, not the contract inventory, not the
// gap vocabulary. They answer structural questions about plain string lists, so the mechanism
// cannot make them agree with it. An audit that shares the mechanism's assumption is the defect
// this initiative kept finding in its own work, and this module is the shape of not having it.
export {
  authorityMintAudit,
  citationAudit,
  coverageAudit,
  deadlockAudit,
  type AuthorityVerdict,
  type CitationVerdict,
  type CoverageVerdict,
  type Covered,
  type Demand,
  type DeadlockVerdict,
  type PermissionPrecondition,
} from "./gap-audit.js";

// The negative control: nineteen rows, each silent on a healthy subject and firing on a planted
// fault, covering every flag above that says something did NOT happen.
export { gapRoutingProbe, type GapRoutingProbeRow } from "./gap-routing-probe.js";

// WHAT THE WORK ACTUALLY TOUCHED, INCLUDING WHAT GIT WAS TOLD TO IGNORE. A build artifact, a
// generated bundle or a report written outside version control is still an output, and a
// manifest that consults `.gitignore` makes exactly those invisible in the record. So the walk
// never reads an ignore rule, and `includesIgnored` is observed by reducing over what was
// actually excluded rather than asserted. Completeness is REPORTED — `complete`, `bounded` or
// `incomplete`, with a reason per gap — because a capture that quietly skipped half a tree reads,
// later and to someone who was not there, exactly like a capture that found nothing to skip.
export {
  captureManifest,
  type ManifestCapture,
  type ManifestCaptureOptions,
} from "./observation-manifest.js";

// The baseline a caller carries between two captures. The only name the walk puts on the door:
// everything else it exports is a seam the manifest module imports, not a public surface.
export { type FileManifest } from "./observation-walk.js";

// A CLOSE SAYS ONLY WHAT IS KNOWN, AND A HANDOVER CLAIMS ONLY WHAT IT VERIFIED. `deriveOutcome`
// is the only producer of an outcome and `closeInitiative` cannot be handed one — `acceptedByHand`
// observes that a caller supplied one rather than recording that somebody remembered not to. A
// reason explains a delivery and never makes one, so `no_signoff_reason` is carried and is not an
// input to the derivation. An abandoned close cannot assert that the stages before it succeeded:
// `state` and `evidence` come out of one builder, so `established` with no evidence is not a
// shape this module can produce. And a self-reported count arrives labelled self-reported,
// because nothing reads `proposed_team_nodes` back — expected impact is not observed impact.
export {
  closeInitiative,
  deriveOutcome,
  handoverClaims,
} from "./close.js";

// NO TYPES FROM THAT MODULE ON THIS DOOR, DELIBERATELY. Seven of its interfaces are reachable
// only through a return position, so TypeScript emits them into the `.d.ts` as local
// declarations and a consumer still gets the full shape by inference. Six more are exported
// from the module because its probe names them to build faulted subjects — a real importer,
// inside the package. Neither group belongs here: a name on the package door with no importer
// is the one thing the hygiene rule forbids, and nothing outside this package names them.

// The negative control for the four refusals above, on disk rather than in a transcript: the
// closing review has to be able to watch each of them fire without re-running the worker that
// wrote them.
export { closeProbe, type CloseProbeRow } from "./close-probe.js";

// ONE RECALL EPISODE END TO END: public search, a pinned read of the original, source and
// supersession traversal, and a result in the language the asker used. The traversal rules are
// what this exists to pin down — a broadened or graph hit is a LEAD until original text supports
// the claim, a current head may be fetched to check supersession but never replaces the revision
// a citation named, and a translation is a search hypothesis that is never written back into the
// document. `answer_language` is derived from the question alone, so a monolingual corpus cannot
// make it right by accident.
export { trial } from "./recall-trial.js";

// The negative control for the four computed flags above, including faulted local copies of
// computations that no input can make the real ones perform.
export { recallTrialProbe, type RecallTrialProbeRow } from "./recall-trial-probe.js";

// THE TRIAL'S OWN ANALYZER, ON THE DOOR SO ITS AGREEMENT WITH `zz-lexical-v2` IS MEASURABLE.
// The corpus needs Han segmentation and this package sits BELOW `@zz/indexing`, so it cannot
// import the real analyzer and keeps a copy of the Han half — the layering forces that and it
// is legitimate. What is not is leaving the two unwatched: `rederivation-generation.ts` exists
// because two implementations of one weighting drifted apart, and this is the same shape one
// directory over. A gate check may import from both packages, so this name is here for that
// check to hold the copy to the original. Nothing else names it; the fixture reaches it as
// `searchCorpus`'s default analyzer, inside its own module.
export { trialAnalyze } from "./recall-trial-corpus.js";
