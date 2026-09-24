/**
 * Planting each fault these rules claim to catch, and watching the detector fire.
 *
 * Every rule below is exercised twice: once on a healthy subject, where the detector must stay
 * silent, and once with one specific fault planted, where it must fire. A detector that only ever
 * ran against healthy material has been watched doing nothing.
 *
 * The silent half matters as much as the other: almost every rule in this subject is a refusal,
 * and a module that refused everything would satisfy every faulted column while being useless. So
 * the healthy column carries the things that must still work — a genuinely recorded transition is
 * reported as observed, an inference with a real basis is kept, a finding with a passing
 * verification behind it closes, and a digest computed over bytes somebody read is written down.
 *
 * Two kinds of fault. Most are planted in the subject, and the real function under test is what
 * reports them. Two are planted in a faulted local copy of the computation itself
 * (`closesFinding`, `deriveFromActivity`), because the rules they break are rules about what the
 * function may do and a subject cannot violate those. Those copies are never exported and nothing
 * calls them but this file.
 *
 * Nothing here is a measurement: the ids, the stage tokens and the timestamps are invented
 * fixtures. DELIBERATE: the stage tokens are `s1`/`s2` — this package has no stage vocabulary and
 * a probe that borrowed one would demonstrate the opposite of what it is here to show.
 */
import {
  applyAssessment,
  recordAudit,
  recordFinding,
  resolveFinding,
  UNAVAILABLE,
  type AssessedFinding,
  type Assessment,
  type AuditOutcome,
  type Finding,
  type FindingDisposition,
  type FindingWithdrawal,
  type RecordedResolution,
  type RequiredTest,
  type TestDischarge,
} from "./audit-identity.js";
import {
  importLegacyAudits,
  type LegacyAuditRow,
} from "./audit-legacy-import.js";
import {
  transitionsFor,
  type InferredRelation,
  type ObservedTransition,
  type TransitionEvent,
  type TransitionInput,
  type TransitionRecord,
  type TransitionRelationKind,
} from "./stage-transition.js";

/** One detector, watched on a healthy subject and on a faulted one. `fires` is true only when
 *  it stayed silent on the first and spoke on the second — either half failing makes the
 *  detector worthless, and for opposite reasons. */
export interface AuditIdentityProbeRow {
  readonly detector: string;
  readonly healthy: string;
  readonly faulted: string;
  readonly fires: boolean;
}

const row = (
  detector: string,
  healthy: [boolean, string],
  faulted: [boolean, string],
): AuditIdentityProbeRow => Object.freeze({
  detector,
  healthy: `${healthy[0] ? "silent" : "MISFIRED"} — ${healthy[1]}`,
  faulted: `${faulted[0] ? "fires" : "MISSED"} — ${faulted[1]}`,
  fires: healthy[0] && faulted[0],
});

// The two faulted local copies

/** The fault the real `applyAssessment` cannot have: a mapping from an assessment's value to a
 *  disposition. Written out in full because it is four lines — the entire distance between a
 *  reading and a verdict. */
function closesFinding(finding: Finding, assessment: Assessment): FindingDisposition {
  if (assessment.question_id === "repeats_finding" && assessment.value === "false") {
    return "resolved";
  }
  return finding.disposition;
}

/** The fault the real `observedTransitions` cannot have: a derivation of a transition from linked
 *  sources and approval order. It is plausible, it produces a number, and every value in the row
 *  it builds is guessed from material that says something else. */
function deriveFromActivity(
  linkedSources: readonly string[],
  approvals: readonly { readonly at: string }[],
): readonly ObservedTransition[] {
  if (linkedSources.length === 0 || approvals.length < 2) return [];
  return [Object.freeze({
    kind: "observed" as TransitionRelationKind,
    from: "s2", to: "s1", run: `inferred-from-${linkedSources[0]}`,
    at: approvals[approvals.length - 1].at,
  })];
}

// Fixtures

/** A required test that has been declared and nothing more — the honest starting state, and
 *  the one a reading must not be able to move. */
const UNRUN_TEST: RequiredTest = Object.freeze({ id: "t1", state: "declared", discharged: null });

const OPEN_FINDING = recordFinding({
  id: "probe-f1",
  disposition: "open",
  summary: "a fixture finding, open and unverified",
  requiredTests: [UNRUN_TEST],
});

const ASSESSMENT: Assessment = Object.freeze({ value: "false", question_id: "repeats_finding" });

/** The fault: a finding erased by something that cannot erase findings. */
const ASSESSMENT_WITHDRAWAL: FindingWithdrawal =
  Object.freeze({ by: "assessment", assessment_ref: "probe-a1" });
const WITHDRAWN_BY_ASSESSMENT = recordFinding({
  ...OPEN_FINDING,
  disposition: "open",
  withdrawal: ASSESSMENT_WITHDRAWAL,
});

/** The fault: a required test standing discharged by a reading instead of a run. */
const ASSESSMENT_DISCHARGE: TestDischarge =
  Object.freeze({ by: "assessment", assessment_ref: "probe-a1" });
const TEST_DISCHARGED_BY_ASSESSMENT = recordFinding({
  ...OPEN_FINDING,
  disposition: "open",
  requiredTests: [{ ...UNRUN_TEST, discharged: ASSESSMENT_DISCHARGE }],
});

/** One verification that ran and passed, and one that never ran. */
const PASSED: RecordedResolution =
  Object.freeze({ verification_ref: "run-1", outcome: "passed", at: "2026-09-21T00:00:00.000Z" });
const NEVER_RAN: RecordedResolution =
  Object.freeze({ verification_ref: "run-2", outcome: "unrun", at: "2026-09-21T00:00:00.000Z" });

/** Document activity: one cited input and two approvals in order. It is the entire basis the
 *  inference has, and on its own it is not a transition. */
const ACTIVITY: TransitionInput = Object.freeze({
  linked_sources: ["s-1"],
  approvals: Object.freeze([{ at: "2026-09-20" }, { at: "2026-09-21" }]),
});

/** A transition somebody actually recorded, and the same recorder omitting the run. */
const RECORDED: TransitionEvent =
  Object.freeze({ kind: "stage_transition", from: "s2", to: "s1", run: "r1" });
const FRAGMENT: TransitionEvent = Object.freeze({ kind: "stage_transition", from: "s2", to: "s1" });

/** The address the intake field really holds is the account that filed the six reports. A
 *  placeholder stands in for it: the fault being planted is the promotion of an intake field into
 *  a reviewer column, and that is the fault whatever the address is. */
const INTAKE_ADDRESS = "intake@example.invalid";

/** The fault, and it is not invented: the digest an earlier export task recorded for the first of
 *  the six reports, copied as it stands. It is sixty-three hex characters and a sha256 is
 *  sixty-four, so the string cannot be the digest it is filed as, and the row below carries it
 *  with no record of when or over what it was computed. That is why the import writes no digest
 *  by default — an unlabelled hash reads as a signature and cannot be checked against anything. */
const RECORDED_ELSEWHERE_63 = "bdc919a2ea64ac460d4370b9d2ee45d5ab3010c53a4456098703bccd9e3bde0";

const FAULTED_HISTORIC_HASH: readonly LegacyAuditRow[] = importLegacyAudits().map((r) =>
  Object.freeze({
    ...r,
    snapshot_sha256: RECORDED_ELSEWHERE_63,
    hash_origin: "unavailable" as const,
  }));

const FAULTED_PROMOTED_REVIEWER: readonly LegacyAuditRow[] = importLegacyAudits().map((r) =>
  Object.freeze({ ...r, reviewer_identity: INTAKE_ADDRESS }));

const SNAPSHOT_BYTES = new Map(
  importLegacyAudits().map((r) => [r.report_ref, `fixture bytes for ${r.id}`]));

// The detectors

function noAssessmentCloses(): AuditIdentityProbeRow {
  const real: AssessedFinding = applyAssessment(OPEN_FINDING, ASSESSMENT);
  const faulted = closesFinding(OPEN_FINDING, ASSESSMENT);
  return row(
    "an assessment does not close a finding",
    [real.disposition === OPEN_FINDING.disposition,
     `the real path leaves the disposition at ${real.disposition} after an assessment ` +
     `answering ${ASSESSMENT.question_id} with ${ASSESSMENT.value}`],
    [faulted !== OPEN_FINDING.disposition,
     `a four-line value-to-disposition mapping turns the same reading into ${faulted}`],
  );
}

function deletionIsComputed(): AuditIdentityProbeRow {
  const healthy: AssessedFinding = applyAssessment(OPEN_FINDING, ASSESSMENT);
  const faulted: AssessedFinding = applyAssessment(WITHDRAWN_BY_ASSESSMENT, ASSESSMENT);
  return row(
    "`deleted` is read off the surviving ledger, not written as false",
    [!healthy.deleted && healthy.ledger.length === 1,
     "an open finding is still on the ledger after the assessment"],
    [faulted.deleted && faulted.ledger.length === 0,
     "a finding whose withdrawal names an assessment is off the ledger, and `deleted` says so"],
  );
}

function substitutionIsComputed(): AuditIdentityProbeRow {
  const healthy = applyAssessment(OPEN_FINDING, ASSESSMENT);
  const faulted = applyAssessment(TEST_DISCHARGED_BY_ASSESSMENT, ASSESSMENT);
  return row(
    "`substitutesForTest` counts tests discharged by a reading",
    [!healthy.substitutesForTest && healthy.substitutedTests.length === 0,
     "a required test that nobody has run is not discharged by assessing the finding"],
    [faulted.substitutesForTest && faulted.substitutedTests.includes("t1"),
     `t1 stands discharged by an assessment and is named: ${faulted.substitutedTests.join(", ")}`],
  );
}

function verifiedResolutionStillWorks(): AuditIdentityProbeRow {
  const closed = resolveFinding(OPEN_FINDING, PASSED);
  const notClosed = resolveFinding(OPEN_FINDING, NEVER_RAN);
  return row(
    "a finding still closes on a verification that ran and passed",
    [closed.closed && closed.finding.disposition === "resolved"
      && closed.finding.resolution !== null,
     "a passing verification closes the finding and the reference is on the record"],
    // The refusal is read, not only the record. Asserting only that the finding came back open
    // and carrying nothing is satisfied by a function that ignores its argument entirely, so the
    // caller also has to have been told — naming the check it cited and the state that check was
    // actually in.
    [!notClosed.closed && notClosed.finding.disposition === "open"
      && notClosed.finding.resolution === null
      && notClosed.refusal.includes("run-2") && notClosed.refusal.includes("unrun"),
     "a resolution citing a check that never ran leaves the finding open, files nothing, and " +
     "is refused in words that name the check and its state rather than passing silently"],
  );
}

function newAuditNeedsSixIdentities(): AuditIdentityProbeRow {
  const complete: AuditOutcome = recordAudit({
    execution_id: "e1", attempt_id: "a1", reviewer_identity: "reviewer-1",
    target: "spec.md", report_ref: "r1", completion: "concluded_with_findings",
  });
  const sentinel: AuditOutcome = recordAudit({
    execution_id: "e1", attempt_id: "a1", reviewer_identity: UNAVAILABLE,
    target: "spec.md", report_ref: "r1", completion: "concluded_with_findings",
  });
  return row(
    "a new audit is refused without all six identities",
    [complete.recorded, "a round naming all six is recorded"],
    [!sentinel.recorded && sentinel.missing.includes("reviewer_identity"),
     "a round being run today may not claim the unavailable sentinel as its reviewer"],
  );
}

function reviewerIsNeverPromoted(): AuditIdentityProbeRow {
  const real = importLegacyAudits();
  const promoted = FAULTED_PROMOTED_REVIEWER.filter((r) => r.reviewer_identity !== UNAVAILABLE);
  return row(
    "the intake account is never promoted to reviewer identity",
    [real.every((r) => r.reviewer_identity === UNAVAILABLE),
     `all ${real.length} imported rows carry the unavailable sentinel`],
    [promoted.length === 6,
     `promoting the intake field would make ${promoted.length} unattributed rounds look ` +
     "like the work of one named reviewer"],
  );
}

function hashIsNeverHistoric(): AuditIdentityProbeRow {
  const withBytes = importLegacyAudits(SNAPSHOT_BYTES);
  const misLabelled = FAULTED_HISTORIC_HASH.filter(
    (r) => r.snapshot_sha256 !== null && r.hash_origin !== "computed_at_import");
  return row(
    "a digest carries the moment it was computed, never a historic signature",
    [withBytes.every((r) => r.snapshot_sha256 !== null && r.hash_origin === "computed_at_import"
      && r.hash_observed_at !== null && r.hashed_byte_count !== null),
     "bytes read today produce a digest labelled at-import, timed, and sized"],
    [misLabelled.length === 6 && RECORDED_ELSEWHERE_63.length !== 64,
     `${misLabelled.length} rows would present a digest with no computation on record — and ` +
     `the one planted here is ${RECORDED_ELSEWHERE_63.length} hex characters, so it is not ` +
     "the sha256 it would be read as"],
  );
}

function noObservedWithoutEvents(): AuditIdentityProbeRow {
  const real: TransitionRecord = transitionsFor(ACTIVITY);
  const faulted = deriveFromActivity(ACTIVITY.linked_sources ?? [], ACTIVITY.approvals ?? []);
  return row(
    "no transition is derived from linked sources and approval order",
    [real.observed.length === 0,
     "a cited input and two ordered approvals produce zero observed transitions"],
    [faulted.length === 1,
     `a derivation over the same material invents ${faulted.length} transition whose every ` +
     "field is guessed"],
  );
}

function inferenceIsKeptAndLabelled(): AuditIdentityProbeRow {
  const real: TransitionRecord = transitionsFor(ACTIVITY);
  const mislabelled: readonly InferredRelation[] = real.inferred.map((r) =>
    Object.freeze({ ...r, kind: "observed" as TransitionRelationKind }));
  return row(
    "an inference is kept, and is never labelled observed",
    [real.inferred.length === 2 && real.inferred.every((r) => r.kind === "inferred"),
     `both relations are retained and stamped inferred: ${real.inferred.map((r) => r.relation).join(", ")}`],
    [mislabelled.some((r) => r.kind === "observed"),
     "relabelling the same rows observed is what fabricating the fact would look like"],
  );
}

function recordedTransitionIsReported(): AuditIdentityProbeRow {
  const real: TransitionRecord = transitionsFor({ events: [RECORDED] });
  const fragment: TransitionRecord = transitionsFor({ events: [FRAGMENT] });
  return row(
    "a genuinely recorded transition is reported as observed",
    [real.observed.length === 1 && real.observed[0].kind === "observed" && real.observed[0].run === "r1",
     "the recorded event comes back observed, with the run that recorded it"],
    [fragment.observed.length === 0 && fragment.rejected.length === 1,
     `an event with no run is rejected by name rather than completed: ` +
     `${fragment.rejected[0].reason.slice(0, 48)}…`],
  );
}

/** Every detector in this module, each watched twice. A row whose `fires` is false is a
 *  finding about this module and not about its subject. */
export function auditIdentityProbe(): readonly AuditIdentityProbeRow[] {
  return Object.freeze([
    noAssessmentCloses(),
    deletionIsComputed(),
    substitutionIsComputed(),
    verifiedResolutionStillWorks(),
    newAuditNeedsSixIdentities(),
    reviewerIsNeverPromoted(),
    hashIsNeverHistoric(),
    noObservedWithoutEvents(),
    inferenceIsKeptAndLabelled(),
    recordedTransitionIsReported(),
  ]);
}
