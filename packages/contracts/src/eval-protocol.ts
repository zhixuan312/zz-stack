/**
 * Evaluation Protocol contract types — spec v8 (FR-6, AC-6.1, AC-20.1): the durable measurement
 * object a plugin version is scored against. Pure zod schemas and their inferred types; no I/O.
 *
 * Field names below are the protocol body's own, camelCase, one-to-one with spec v8's
 * `EvaluationProtocol` type. Migration 077 (services/gateway/migrations/077_plugin_eval_next.sql)
 * stores this same content under snake_case columns on `zz.eval_protocol_version` — `suites`,
 * `replay_policy`, `qualification_policy`, `scoring_policy`, `improvement_policy` — mapped
 * positionally by the write path. This module never speaks snake_case.
 *
 * `PROTOCOL_ENUMS` and `EVAL_STATE_ENUMS` are the one source both this schema's `z.enum(...)`
 * calls and every later writer draw their vocabulary from — the check that validates a value and
 * the dashboard that renders it share one list, and so does the gate's "every state the schema
 * allows can actually be reached" check, which looks for each literal named somewhere in source.
 *
 * Every zod object below follows the same pattern: `export const X = z.object({...});
 * export type X = z.infer<typeof X>;` — a value and a type sharing one name in two namespaces,
 * so a single named re-export from `index.ts` carries both.
 */
import { z } from "zod";

// -------------------------------------------------------------------------------------------
// Enum vocabularies — one array per concept, each backing exactly one z.enum(...) below and one
// entry of PROTOCOL_ENUMS or EVAL_STATE_ENUMS. Nothing restates a value list a second time.

const CANONICAL_KINDS = [
  "effectiveness", "reliability", "constraint_adherence",
  "recovery_robustness", "efficiency", "generalization",
] as const;

const EVALUATOR_TYPES = [
  "deterministic", "outcome", "bounded_semantic", "generative_critic", "human",
] as const;

/** Which suite a measure runs in — zz.eval_measure.suite (077) and Measure.suite below. */
const SUITES = ["capability", "regression", "production"] as const;

const REPLAY_MODES = [
  "sandbox", "recorded", "simulated", "live_read_only", "non_replayable",
] as const;

/** zz.eval_evaluator_qualification.state (077) and QualificationPolicy.boundedSemanticMinimum
 *  below — the same ladder under two names: how sure an evaluator's verdict has to be before
 *  its qualification, or a protocol's minimum bar for one, is admitted. */
const QUALIFICATION_STATES = [
  "unqualified", "mechanically_qualified", "operationally_qualified", "human_calibrated",
] as const;

/** zz.eval_failure_mode_candidate.owner_kind and zz.eval_finding.owner_kind (077) — the same
 *  vocabulary on two tables, so one array backs both check constraints. */
const OWNER_KINDS = [
  "plugin", "dependency", "platform", "environment", "user_input", "unknown",
] as const;

/** zz.eval_finding.kind (078) — Task I-13's EVALUATE-produced finding, distinct from the
 *  rubric-era finding's own `scope` (generic/specific), which keeps its separate vocabulary. */
const FINDING_KINDS = ["strength", "defect", "unknown"] as const;

const FAILURE_CANDIDATE_STATUSES = ["candidate", "accepted", "rejected", "merged"] as const;
const REPLAY_CASE_STATUSES = ["replayable", "not_replayable"] as const;
const REPLAY_CASE_SPLITS = ["evolve", "validation", "proof"] as const;
const REPLAY_EVENT_VISIBILITIES = ["actor", "user_oracle", "evaluation_oracle"] as const;
const EVAL_RUN_RUN_STATUSES = ["pending", "running", "completed", "failed", "cancelled"] as const;
const EVAL_RUN_SCORE_STATUSES = ["established", "provisional", "not_established"] as const;
const EVAL_RUN_GUARDRAIL_STATUSES = ["pass", "fail", "not_established"] as const;
const IMPROVEMENT_RUN_STATUSES = [
  "open", "searching", "selected", "proofing", "proof_failed",
  "ready_for_approval", "released", "closed", "cancelled",
] as const;
/** `proof_not_established` (migration 081, fix dispatch on I-21): a candidate whose sealed proof
 *  never resolved to passed or failed — too few proof cases, an interval that never cleared mme
 *  by the liveness bound, or the allocation's token holder abandoned it — is spent (the proof
 *  allocation is used up either way) but is NOT a rejected hypothesis. Distinct from
 *  `proof_failed` so `REJECTED_CANDIDATE_STATUSES` (proposer-bundle.ts) can bar the latter from
 *  re-proposal without also barring an idea that was never actually tested. */
const CANDIDATE_STATUSES = [
  "recorded", "rejected_precheck", "validating", "valid", "invalid", "selected",
  "proving", "proof_passed", "proof_failed", "proof_not_established", "stale", "released",
  // Migration 084: release_record's rollback path marks the candidate whose release it undid.
  "rolled_back",
] as const;
/** zz.replay_run.status (077) — distinct from replay_case.status above: a case is either
 *  replayable or not, once; a run against it moves through its own execution lifecycle and can
 *  fail or be cancelled independently of the case it replays. */
const REPLAY_RUN_STATUSES = [
  "registered", "running", "completed", "failed", "not_replayable", "cancelled",
] as const;
/** zz.candidate_evaluation.split (077) — distinct from replay_case.split above: a case is drawn
 *  once into evolve/validation/proof; a candidate's *evaluation* against the pool is scored as
 *  validation/proof/post_release, the third being a released candidate re-scored in production. */
const CANDIDATE_EVALUATION_SPLITS = ["validation", "proof", "post_release"] as const;
const RELEASE_ATTEMPT_STATUSES = [
  "prepared", "applying", "released", "refused", "failed", "rolled_back",
] as const;
const ANSWER_KINDS = ["noul", "choice", "score"] as const;

/** Every protocol-body enum — the field names inside Dimension, Measure, ReplayDependencyPolicy
 *  and QualificationPolicy below, not a migration's check constraints. One source for the
 *  z.enum(...) calls in this file and for the dashboard that renders a protocol's own choices
 *  back to a person. */
export const PROTOCOL_ENUMS = {
  canonicalKind: CANONICAL_KINDS,
  evaluatorType: EVALUATOR_TYPES,
  suite: SUITES,
  replayMode: REPLAY_MODES,
  boundedSemanticMinimum: QUALIFICATION_STATES,
} as const;

/** Every state column migration 077 constrains, one array per column (two columns sharing a
 *  vocabulary — owner_kind, the qualification ladder — share one array rather than restate it).
 *  Every later writer takes its values from here; a value that only ever lived in the SQL CHECK
 *  is a state the gate's "every state the schema allows can actually be reached" check reports
 *  as unreachable. */
export const EVAL_STATE_ENUMS = {
  qualificationState: QUALIFICATION_STATES,
  failureCandidateStatus: FAILURE_CANDIDATE_STATUSES,
  replayCaseStatus: REPLAY_CASE_STATUSES,
  replayCaseSplit: REPLAY_CASE_SPLITS,
  replayEventVisibility: REPLAY_EVENT_VISIBILITIES,
  scoreStatus: EVAL_RUN_SCORE_STATUSES,
  guardrailStatus: EVAL_RUN_GUARDRAIL_STATUSES,
  runStatus: EVAL_RUN_RUN_STATUSES,
  improvementRunStatus: IMPROVEMENT_RUN_STATUSES,
  candidateStatus: CANDIDATE_STATUSES,
  candidateEvaluationSplit: CANDIDATE_EVALUATION_SPLITS,
  replayRunStatus: REPLAY_RUN_STATUSES,
  releaseAttemptStatus: RELEASE_ATTEMPT_STATUSES,
  ownerKind: OWNER_KINDS,
  answerKind: ANSWER_KINDS,
  findingKind: FINDING_KINDS,
} as const;

/** A free-form object whose shape spec v8 does not fix beyond "an object" — used wherever a
 *  field's contents are the writing stage's business (a measure's evaluator reference, a suite's
 *  own settings, a search's proof/release policy) and no reader depends on a fixed shape yet.
 *  Guessing one here would be exactly the speculative abstraction this file's task boundary
 *  excludes: "final deliverable content is not in this plan." */
const FreeformRecord = z.record(z.string(), z.unknown());

// -------------------------------------------------------------------------------------------
// Dimension / Measure — one canonical scoring dimension inside a protocol version, and the
// weighted measures inside it. Mirrors zz.eval_dimension / zz.eval_measure (077).

export const Measure = z.object({
  key: z.string().min(1),
  evaluatorType: z.enum(EVALUATOR_TYPES),
  // Positive, never zero or negative: a zero weight is a measure that counts for nothing, and a
  // negative one lets two measures sum to 1 while one of them scores backwards.
  weight: z.number().positive(),
  suite: z.enum(SUITES),
  required: z.boolean(),
  definition: FreeformRecord,
  evaluator: FreeformRecord.nullable(),
});
export type Measure = z.infer<typeof Measure>;

export const Dimension = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  canonicalKind: z.enum(CANONICAL_KINDS),
  // Non-negative here, positive when applicable (the superRefine below): `score.ts` drops an
  // applicable: false dimension from both weighted sums, so its weight is never read and 0 is an
  // honest value for it. An applicable dimension at 0 would count for nothing.
  weight: z.number().nonnegative(),
  required: z.boolean(),
  applicable: z.boolean(),
  notApplicableReason: z.string().nullable(),
  measures: z.array(Measure).min(1),
}).superRefine((dim, ctx) => {
  // (c) a dimension's measure weights sum to 1, applicable or not — a non-applicable dimension
  // still names a real measure set; it is only excluded from the protocol-level dimension
  // weighting in EvaluationProtocol's own superRefine below.
  const total = dim.measures.reduce((sum, m) => sum + m.weight, 0);
  if (Math.abs(total - 1) > 1e-9) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ["measures"],
      message: `measure weights inside dimension "${dim.key}" sum to ${total}, not 1`,
    });
  }
  if (dim.applicable && dim.weight <= 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ["weight"],
      message: `dimension "${dim.key}" is applicable, so its weight must be positive`,
    });
  }
  // (e) a non-applicable dimension must say why, so "applicable: false" is never a silent drop
  // of a dimension nobody explained.
  if (!dim.applicable && (!dim.notApplicableReason || !dim.notApplicableReason.trim())) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ["notApplicableReason"],
      message: `dimension "${dim.key}" is not applicable and must name a notApplicableReason`,
    });
  }
  // (e, reversed) an applicable dimension carries no reason for not applying — a reason beside
  // `applicable: true` is two answers to one question, and a reader cannot tell which one holds.
  if (dim.applicable && dim.notApplicableReason !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ["notApplicableReason"],
      message: `dimension "${dim.key}" is applicable, so its notApplicableReason must be null`,
    });
  }
});
export type Dimension = z.infer<typeof Dimension>;

// -------------------------------------------------------------------------------------------
// Replay — how a case's dependencies replay, and the three-way pool a case-set version splits
// into. Mirrors zz.replay_case.split (evolve/validation/proof), never zz.candidate_evaluation's
// own split — that vocabulary is disjoint and lives in EVAL_STATE_ENUMS.candidateEvaluationSplit.

export const ReplayDependencyPolicy = z.object({
  surface: z.string().min(1),
  mode: z.enum(REPLAY_MODES),
  matcher: FreeformRecord.nullable(),
});
export type ReplayDependencyPolicy = z.infer<typeof ReplayDependencyPolicy>;

export const ThreeWaySplitPolicy = z.object({
  evolve: z.number(),
  validation: z.number(),
  proof: z.number(),
  min: z.object({
    evolve: z.number(),
    validation: z.number(),
    proof: z.number(),
  }),
});
export type ThreeWaySplitPolicy = z.infer<typeof ThreeWaySplitPolicy>;

// -------------------------------------------------------------------------------------------
// Qualification, establishment and uncertainty — how sure an evaluator has to be before its
// verdict counts, and how a run's score earns "established" rather than "provisional".

export const QualificationPolicy = z.object({
  boundedSemanticMinimum: z.enum(QUALIFICATION_STATES),
  thresholds: FreeformRecord,
  labelMappings: z.array(z.union([z.string(), FreeformRecord])),
});
export type QualificationPolicy = z.infer<typeof QualificationPolicy>;

export const EstablishmentPolicy = z.object({
  bootstrap: z.boolean().default(false),
  minCoverage: FreeformRecord,
});
export type EstablishmentPolicy = z.infer<typeof EstablishmentPolicy>;

/** Spec v8 does not fix an uncertainty-policy shape beyond "an object" — see FreeformRecord. */
export const UncertaintyPolicy = FreeformRecord;
export type UncertaintyPolicy = z.infer<typeof UncertaintyPolicy>;

// -------------------------------------------------------------------------------------------
// Improvement search — how a candidate generation is bounded, how candidates are ranked, and
// the free-form proof/release policies and named guardrails around them.

export const SearchPolicy = z.object({
  // Counts: a fractional or non-positive bound makes `generationCapRefusal` compare against a
  // number no candidate count can meet the way the protocol meant.
  maxGenerations: z.number().int().positive(),
  maxCandidatesPerGeneration: z.number().int().positive(),
  // A zero or negative bound expires every run before it starts.
  wallClockHours: z.number().positive(),
  // A repeat count: validation waits for this many scored runs per side, so a fraction is never met.
  minRepeats: z.number().int().positive(),
  // A negative mme would read a regression as meaningful improvement.
  minMeaningfulEffect: z.number().nonnegative(),
  // A confidence level: 0 or 1 makes the paired interval empty or unbounded.
  confidence: z.number().gt(0).lt(1),
  // A band width: a negative one makes "equivalent" impossible even for identical scores.
  equivalenceBand: z.number().nonnegative(),
  complexity: z.string().min(1),
});
export type SearchPolicy = z.infer<typeof SearchPolicy>;

export const CandidateSelectionPolicy = z.object({
  order: z.array(z.string().min(1)).min(1),
});
export type CandidateSelectionPolicy = z.infer<typeof CandidateSelectionPolicy>;

/** Spec v8 does not fix a proof-policy shape beyond "an object" — see FreeformRecord. */
export const ProofPolicy = FreeformRecord;
export type ProofPolicy = z.infer<typeof ProofPolicy>;

/** Spec v8 does not fix a release-policy shape beyond "an object" — see FreeformRecord. */
export const ReleasePolicy = FreeformRecord;
export type ReleasePolicy = z.infer<typeof ReleasePolicy>;

/** A named guardrail inside `improvement.criticalGuardrails` (Task I-29's own fix dispatch, FR-6,
 *  FR-23): the measure key it binds to, and the threshold its normalised `[0,1]` value must meet
 *  or exceed to pass — `evaluateGuardrails` (`services/zz-core/src/eval/evaluate-measures.ts`) is
 *  the one place that number is read, so a guardrail with no explicit threshold is a protocol that
 *  never said what "pass" means for it. A richer object may still carry whatever else the protocol
 *  wants recorded about it, through `catchall`. */
export const Guardrail = z.object({ key: z.string().min(1), threshold: z.number().min(0).max(1) }).catchall(z.unknown());
export type Guardrail = z.infer<typeof Guardrail>;

/** A named failure mode inside `failureTaxonomy` — same shape as Guardrail, for the same reason:
 *  DISCOVER may hand back a bare stable_key or a richer candidate record. */
export const FailureMode = z.union([z.string().min(1), z.object({ key: z.string().min(1) }).catchall(z.unknown())]);
export type FailureMode = z.infer<typeof FailureMode>;

// -------------------------------------------------------------------------------------------
// The protocol body itself — spec v8's EvaluationProtocol type (FR-6). Field names are the
// protocol body's own, camelCase, one-to-one; migration 077 stores this content under
// snake_case columns on zz.eval_protocol_version, mapped positionally, never renamed here.

/** One of `suites.capability` / `.regression` / `.production` — spec v8 does not fix a shape
 *  for a suite definition beyond "an object" naming that suite's own settings. */
const SuiteDefinition = FreeformRecord;

export const EvaluationProtocol = z.object({
  protocolKey: z.string().min(1),
  version: z.number(),
  pluginPurpose: z.string().min(1),
  observableSurfaces: z.array(z.string().min(1)),
  failureTaxonomy: z.array(FailureMode),
  dimensions: z.array(Dimension).min(1),
  suites: z.object({
    capability: SuiteDefinition,
    regression: SuiteDefinition,
    production: SuiteDefinition,
  }),
  replay: z.object({
    dependencies: z.array(ReplayDependencyPolicy),
    caseSelection: FreeformRecord,
    splitPolicy: ThreeWaySplitPolicy,
  }),
  qualification: QualificationPolicy,
  scoring: z.object({
    establishment: EstablishmentPolicy,
    uncertainty: UncertaintyPolicy,
  }),
  improvement: z.object({
    evolvable: z.boolean(),
    search: SearchPolicy,
    selection: CandidateSelectionPolicy,
    proof: ProofPolicy,
    criticalGuardrails: z.array(Guardrail),
    release: ReleasePolicy,
  }),
}).superRefine((protocol, ctx) => {
  // (b) dimension weights over applicable dimensions sum to 1. A dimension marked not
  // applicable carries no weight in the protocol's own scoring, so it is excluded here — its
  // own superRefine (above, on Dimension) is what still requires it to name a reason.
  const applicable = protocol.dimensions.filter((d) => d.applicable);
  const total = applicable.reduce((sum, d) => sum + d.weight, 0);
  if (Math.abs(total - 1) > 1e-9) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ["dimensions"],
      message: `dimension weights over the ${applicable.length} applicable dimension(s) ` +
               `sum to ${total}, not 1`,
    });
  }
});
export type EvaluationProtocol = z.infer<typeof EvaluationProtocol>;
