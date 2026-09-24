/**
 * Who audited what, and why a reading of a finding cannot close it.
 *
 * An audit record carries six identities and is refused without them: which execution ran it,
 * which attempt inside that execution it was, who reviewed, what was reviewed, where the
 * report is, and how it ended.
 *
 * An assessment is a reading, not a verdict. {@link applyAssessment} returns a new record
 * beside the finding; the finding goes into it untouched and the disposition on the result is
 * copied off the finding. There is no branch, no lookup and no mapping from an assessment's
 * value to a disposition anywhere in this file, and {@link Assessment} carries no field that
 * could supply one.
 *
 * Two flags on the result are computed rather than constant:
 *
 *   · `deleted` — by asking what is still on the ledger after the assessment and looking for
 *     the finding by id. A finding carrying a withdrawal that names an assessment does not
 *     survive {@link assessedLedger}.
 *   · `substitutesForTest` — by collecting the required tests standing discharged by an
 *     assessment rather than by a run. Nothing in this module writes that discharge; the shape
 *     is representable so the guard has something to catch.
 *
 * COUPLED: the seven check states — declared, present, invoked, passed, failed, unrun and
 * unknown — live in ./check-state.js and this module imports them. A second copy is free to
 * drift, and a state one module recognised while another did not would change meaning
 * depending on who was reading it.
 */
import { type CheckState } from "./check-state.js";


/** The two dispositions a finding can stand at: it is open, or something ran and passed.
 *
 *  DELIBERATE: two, not four. `deferred` is the open state in zz.eval_finding and `disputed`
 *  is live in eval-case.ts's `LabelStatus`; either name here would be a second meaning for a
 *  word already in use, in a vocabulary nothing in this module writes. */
export type FindingDisposition = "open" | "resolved";

// The six identities

/** The six identities every audit carries. All six are strings the caller supplies; this
 *  module never derives one from another. The legacy import is the one path allowed to write
 *  {@link UNAVAILABLE}, and it says per field where each value came from. */
export interface AuditIdentity {
  readonly execution_id: string;
  readonly attempt_id: string;
  readonly reviewer_identity: string;
  readonly target: string;
  readonly report_ref: string;
  readonly completion: string;
}

/** The identity field names, in one place, so the refusal below reads the list rather than
 *  retyping it. DELIBERATE: not exported — a consumer that needs the six reads the shape of
 *  {@link AuditIdentity}, which the compiler checks. */
const AUDIT_IDENTITY_FIELDS: readonly string[] = Object.freeze([
  "execution_id", "attempt_id", "reviewer_identity", "target", "report_ref", "completion",
]);

/** The sentinel for a fact the record does not contain. It is a value, not an absence, so that
 *  "nobody wrote this down" and "nobody thought to ask" stop looking alike. */
export const UNAVAILABLE = "unavailable";

/** A refusal to record an audit, naming every identity that was missing rather than the first
 *  one found. */
interface AuditRefusal {
  readonly recorded: false;
  readonly missing: readonly string[];
  readonly detail: string;
}

interface AuditRecord {
  readonly recorded: true;
  readonly identity: AuditIdentity;
  readonly findings: readonly Finding[];
}

export type AuditOutcome = AuditRecord | AuditRefusal;

/**
 * Recording a new audit, refused without all six identities.
 *
 * DELIBERATE: `unavailable` is refused here and accepted by the legacy import. A report written
 * years ago cannot be made to name its reviewer; an audit being recorded now can name every one
 * of the six.
 */
export function recordAudit(
  identity: Partial<AuditIdentity>,
  findings: readonly Finding[] = [],
): AuditOutcome {
  const missing = AUDIT_IDENTITY_FIELDS.filter((field) => {
    const value = (identity as Record<string, unknown>)[field];
    return typeof value !== "string" || value.trim() === "" || value === UNAVAILABLE;
  });
  if (missing.length) {
    return Object.freeze({
      recorded: false as const,
      missing: Object.freeze(missing),
      detail: `a new audit cannot be recorded without ${missing.join(", ")}; ` +
        `"${UNAVAILABLE}" is honest about a historical report and is not an identity a round ` +
        "being run today may claim",
    });
  }
  return Object.freeze({
    recorded: true as const,
    identity: Object.freeze({ ...identity } as AuditIdentity),
    findings: Object.freeze([...findings]),
  });
}

// Findings, and the two ways one can leave the ledger

/** How a required test came to be discharged.
 *
 *  DELIBERATE: the `assessment` arm is representable and is never written here. Without it
 *  {@link AssessedFinding.substitutesForTest} would be a constant false dressed up as a
 *  computation, and nothing could test that it fires. The probe plants exactly this arm. */
export type TestDischarge =
  | { readonly by: "test_run"; readonly run_ref: string; readonly outcome: CheckState }
  | { readonly by: "assessment"; readonly assessment_ref: string };

/** A test a finding cannot be closed without. `state` is one of the seven, so "nobody ran it"
 *  and "it ran and failed" remain different answers. */
export interface RequiredTest {
  readonly id: string;
  readonly state: CheckState;
  readonly discharged: TestDischarge | null;
}

/** How a finding came off the ledger. COUPLED: same construction as {@link TestDischarge} —
 *  the `assessment` arm is what {@link assessedLedger} refuses to carry forward, and without
 *  it `deleted` could not be shown to fire. */
export type FindingWithdrawal =
  | { readonly by: "recorded_withdrawal"; readonly ref: string; readonly reason: string }
  | { readonly by: "assessment"; readonly assessment_ref: string };

/** What a round found. `evidence_ref` may be null: a finding whose evidence was not filed is
 *  a weaker finding, and it is still a finding. */
export interface Finding {
  readonly id: string;
  readonly disposition: FindingDisposition;
  readonly summary: string;
  readonly evidence_ref: string | null;
  readonly requiredTests: readonly RequiredTest[];
  readonly withdrawal: FindingWithdrawal | null;
  readonly resolution: RecordedResolution | null;
}

/** What it takes to close a finding: a verification that actually ran, with its outcome.
 *  {@link Assessment} has none of these fields and there is no conversion between them, so the
 *  only way to reach {@link resolveFinding} is to have run something. */
export interface RecordedResolution {
  readonly verification_ref: string;
  readonly outcome: CheckState;
  readonly at: string;
}

/** What a caller hands {@link recordFinding}. Everything but the id has a defensible default.
 *
 *  DELIBERATE: `disposition` is typed `"open"` and not {@link FindingDisposition}. The full set
 *  would make `recordFinding({ id, disposition: "resolved" })` legal, handing a recording
 *  caller the power this module refuses an assessment. It stays as a field because
 *  `disposition: "open"` is a true thing a caller may want to write down, and the gate check
 *  writes it. */
export interface FindingInput {
  readonly id: string;
  readonly disposition?: "open";
  readonly summary?: string;
  readonly evidence_ref?: string | null;
  readonly requiredTests?: readonly RequiredTest[];
  readonly withdrawal?: FindingWithdrawal | null;
  readonly resolution?: RecordedResolution | null;
}

/** A new finding is open, and no expression here produces any other state.
 *
 *  DELIBERATE: `"open"` is a literal rather than copied from `input`. A type is erased at
 *  runtime and an input cast from JSON is not, so the narrow field above alone would leave
 *  `recordFinding(row as FindingInput)` able to record a finding closed.
 *
 *  `resolution` is still carried, because {@link resolveFinding} files one and its output has
 *  to be constructible. A resolution arriving here without a disposition lands on a finding
 *  that is still open. */
export function recordFinding(input: FindingInput): Finding {
  return Object.freeze({
    id: input.id,
    disposition: "open",
    summary: input.summary ?? "",
    evidence_ref: input.evidence_ref ?? null,
    requiredTests: Object.freeze([...(input.requiredTests ?? [])]),
    withdrawal: input.withdrawal ?? null,
    resolution: input.resolution ?? null,
  });
}

// An assessment, and everything it is structurally unable to do

/** A bounded question's answer about a finding. `value` is whatever the assessor returned —
 *  a choice, a score, a probability, rendered as text — and this module never interprets it.
 *
 *  DELIBERATE: no disposition, no verification reference, no outcome, no authority. Those
 *  absences are the mechanism — a function wanting to close a finding from an assessment would
 *  have nothing to read. */
export interface Assessment {
  readonly value: string;
  readonly question_id?: string;
  readonly ref?: string;
}

/** What standing beside a finding after an assessment looks like. The finding itself is
 *  carried whole rather than spread into this record, so there is one copy of it and a reader
 *  can see the assessment did not touch it. */
export interface AssessedFinding {
  readonly finding: Finding;
  /** Copied off the finding. Nothing in {@link Assessment} is read to produce this. */
  readonly disposition: FindingDisposition;
  readonly assessment: Assessment;
  /** The findings still standing after the assessment was applied. */
  readonly ledger: readonly Finding[];
  /** Computed: the finding is not on `ledger`. */
  readonly deleted: boolean;
  /** Computed: at least one required test stands discharged by an assessment. */
  readonly substitutesForTest: boolean;
  /** Which required tests those are, named, so a caller fixing this knows what to run. */
  readonly substitutedTests: readonly string[];
}

/**
 * The ledger after an assessment, which is how `deleted` is computed rather than asserted.
 *
 * The finding stands after the assessment. The one shape that does not survive is a withdrawal
 * naming an assessment as its author: carrying it forward would let `deleted` report false
 * about a finding that is gone.
 *
 * A finding withdrawn by a recorded withdrawal stays on the ledger, withdrawn.
 */
function assessedLedger(finding: Finding): readonly Finding[] {
  return Object.freeze([finding].filter((f) => f.withdrawal?.by !== "assessment"));
}

/**
 * Reading a finding, and changing nothing about it. Three things this cannot do, each prevented
 * rather than documented:
 *
 *   · close it — `disposition` on the result is `finding.disposition`, and {@link Assessment}
 *     has no field of that type to supply another.
 *   · delete it — `deleted` is read off {@link assessedLedger}'s output by id, and an
 *     assessment is not a parameter of that function.
 *   · stand in for a test — `substitutesForTest` counts required tests discharged by an
 *     assessment. This module writes no such discharge.
 */
export function applyAssessment(finding: Finding, assessment: Assessment): AssessedFinding {
  const ledger = assessedLedger(finding);
  const substitutedTests = finding.requiredTests
    .filter((t) => t.discharged !== null && t.discharged.by === "assessment")
    .map((t) => t.id);
  return Object.freeze({
    finding,
    disposition: finding.disposition,
    assessment,
    ledger,
    deleted: !ledger.some((f) => f.id === finding.id),
    substitutesForTest: substitutedTests.length > 0,
    substitutedTests: Object.freeze(substitutedTests),
  });
}

/** What became of an attempt to close a finding. Both arms carry the finding, so a caller
 *  wanting the record as it now stands never has to read `closed` to get it, and `refusal`
 *  says which check was cited and what state it was in. */
type FindingClosure =
  | { readonly closed: true; readonly finding: Finding }
  | { readonly closed: false; readonly finding: Finding; readonly refusal: string };

/**
 * The one way a finding closes: something ran, and its outcome is on the record.
 *
 * A refusal is observable: the outcome is on the result and the reason is a sentence, the way
 * `finding_decide` answers in zz-core. Returning the finding unchanged would be
 * indistinguishable at the call site from a close that worked.
 */
export function resolveFinding(finding: Finding, resolution: RecordedResolution): FindingClosure {
  if (resolution.outcome !== "passed") {
    return Object.freeze({
      closed: false as const,
      finding,
      refusal: `${finding.id} stays open: closing it cites ${resolution.verification_ref}, ` +
        `which is "${resolution.outcome}" and not "passed". A finding closed by a reference ` +
        "to evidence that says it is still open is worse than one nobody closed, because the " +
        "reference reads afterwards as though somebody checked.",
    });
  }
  // Built from the finding, not through `recordFinding`: a resolved finding is the finding it
  // was plus the verification that closed it, which leaves the recording constructor with no
  // reason to know the word "resolved".
  return Object.freeze({
    closed: true as const,
    finding: Object.freeze({ ...finding, disposition: "resolved" as const, resolution }),
  });
}
