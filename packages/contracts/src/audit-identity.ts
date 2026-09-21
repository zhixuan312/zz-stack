/**
 * WHO AUDITED WHAT, AND WHY A READING OF A FINDING CANNOT CLOSE IT.
 *
 * An audit is a claim about somebody else's work, and a claim nobody can attribute is not
 * review — it is an opinion with a timestamp. So an audit record here carries six identities
 * and is refused without them: which execution ran it, which attempt inside that execution it
 * was, who reviewed, what was reviewed, where the report is, and how it ended. Five of the six
 * are ordinary bookkeeping. The sixth, the reviewer, is the one that decides whether the word
 * "independent" in front of "review" means anything, and it is the one most easily filled in
 * with whatever identifier happened to be to hand.
 *
 * AN ASSESSMENT IS A READING, NOT A VERDICT, and this module is built so that no caller can
 * make it one. {@link applyAssessment} returns a NEW record beside the finding; the finding
 * goes into it untouched and the disposition on the result is copied off the finding. There is
 * no branch, no lookup and no mapping from an assessment's value to a disposition anywhere in
 * this file, and {@link Assessment} carries no field that could supply one. An assessment that
 * reads "this finding repeats an earlier one" is a sentence somebody's model produced about a
 * finding that is still open, and the finding is still open afterwards.
 *
 * THIS IS THE SHAPE THIS INITIATIVE KEEPS FINDING IN ITS OWN WORK. A signal is produced, the
 * signal is confident, and one layer later the signal is standing where a test result should
 * be. Hence two flags on the result rather than a sentence in this comment:
 *
 *   · `deleted` — COMPUTED, by asking what is still on the ledger after the assessment and
 *     looking for the finding by id. It is not the constant false. A finding carrying a
 *     withdrawal that names an assessment does not survive {@link assessedLedger}, and
 *     `deleted` then reports true, which is the detector doing its job rather than this
 *     comment promising it would.
 *   · `substitutesForTest` — COMPUTED, by collecting the required tests standing discharged by
 *     an assessment rather than by a run. Nothing in this module ever writes that discharge;
 *     the shape is representable precisely so the guard has something to catch.
 *
 * A LATER ROUND THAT DISPUTES AN EARLIER FINDING ADDS A ROW. {@link disputeFinding} returns
 * both findings, verbatim, and the dispute as a relation between them. Neither is rewritten
 * and neither is dropped: collapsing them would mean the record of what the first round found
 * is whatever the second round thought of it, and the first round's evidence is exactly what a
 * reader needs when the two disagree.
 *
 * CHECK STATES STAY SEVEN. Declared, present, invoked, passed, failed, unrun and unknown are
 * seven different facts about a check and every collapse of them hides a different lie: a
 * check that was never invoked reported as passed, a check that could not run reported as
 * failed, a check nobody declared reported as absent. They are one frozen list here so that
 * no consumer gets to invent an eighth or quietly merge two. THE SEVEN LIVE IN ONE MODULE and
 * this one imports them: a second copy of a vocabulary is a second copy free to drift from the
 * first, and a check state this module recognised while another did not would be a state that
 * changed meaning depending on who was reading it.
 */
import { type CheckState } from "./check-state.js";


/** The two dispositions a finding can stand at: it is open, or something ran and passed.
 *
 *  THIS CARRIED FOUR AND CONSTRUCTED TWO. `deferred` and `disputed` were never produced by any
 *  code in this repository — not by a function here, not by the probe, not by the gate check —
 *  and the comment that justified them named "the spec's gap disposition set", which does not
 *  exist: `GAP_KINDS` in gap-routing.ts is six unrelated kinds and no document or migration
 *  names a four-value disposition set anywhere.
 *
 *  Each was a second copy of a word that already meant something else. `deferred` is the OPEN
 *  state in zz.eval_finding — the state a recorded finding starts at and counts against
 *  headroom in — so a reader moving between the two vocabularies met one word with two
 *  meanings and nothing saying which was in force. `disputed` is live in eval-case.ts's
 *  `LabelStatus`, where it is actually constructed and carries the reasons and the voided
 *  reviewers behind it; here it was a name for a state {@link disputeFinding} deliberately
 *  refuses to write, so the only thing it could do was suggest that function does something it
 *  documents itself as not doing. A vocabulary nothing writes is a vocabulary free to drift
 *  from the one that is real, and neither of these had a way to be found wrong. */
export type FindingDisposition = "open" | "resolved";

// ── the six identities ─────────────────────────────────────────────────────────────────────

/** The six identities every audit carries. All six are strings the caller supplies; this
 *  module never derives one from another, because every derivation available here would be a
 *  guess: an execution id inferred from a timestamp, a reviewer inferred from whoever filed
 *  the report. The legacy import is the one path allowed to write {@link UNAVAILABLE}, and it
 *  says per field where each value came from. */
export interface AuditIdentity {
  readonly execution_id: string;
  readonly attempt_id: string;
  readonly reviewer_identity: string;
  readonly target: string;
  readonly report_ref: string;
  readonly completion: string;
}

/** The identity field names, in one place, so the refusal below reads the list rather than
 *  retyping it. Deliberately not exported: a consumer that needs the six should be reading the
 *  shape of {@link AuditIdentity}, which the compiler checks, rather than a runtime array of
 *  names it would then have to keep in step by hand. */
const AUDIT_IDENTITY_FIELDS: readonly string[] = Object.freeze([
  "execution_id", "attempt_id", "reviewer_identity", "target", "report_ref", "completion",
]);

/** The sentinel for a fact the record does not contain. It is a value, not an absence, so that
 *  "nobody wrote this down" and "nobody thought to ask" stop looking alike. */
export const UNAVAILABLE = "unavailable";

/** A refusal to record an audit, naming every identity that was missing rather than the first
 *  one found — a caller fixing these one round-trip at a time is a caller who stops after the
 *  third and fills the rest in with something plausible. */
export interface AuditRefusal {
  readonly recorded: false;
  readonly missing: readonly string[];
  readonly detail: string;
}

export interface AuditRecord {
  readonly recorded: true;
  readonly identity: AuditIdentity;
  readonly findings: readonly Finding[];
}

export type AuditOutcome = AuditRecord | AuditRefusal;

/**
 * RECORDING A NEW AUDIT, WHICH IS REFUSED WITHOUT ALL SIX IDENTITIES.
 *
 * `unavailable` is refused here and accepted by the legacy import, and that asymmetry is the
 * whole point. A report written years ago cannot be made to name its reviewer, and pretending
 * otherwise loses the only honest thing left to say about it. An audit being recorded NOW can
 * name every one of the six, and a new record that cannot is a record whose independence
 * nobody will ever be able to check — so it does not get written.
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

// ── findings, and the two ways one can leave the ledger ────────────────────────────────────

/** How a required test came to be discharged.
 *
 *  `assessment` IS REPRESENTABLE AND IS NEVER WRITTEN HERE. A union with only the honest arm
 *  would make {@link AssessedFinding.substitutesForTest} a constant false dressed up as a
 *  computation — nothing could ever set it, so nothing could ever test that it fires. The
 *  dishonest arm exists so the guard has a subject, and the probe plants exactly it. */
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

/** How a finding came off the ledger. Same construction as {@link TestDischarge}, for the same
 *  reason: the `assessment` arm is what {@link assessedLedger} refuses to carry forward, and
 *  without it `deleted` could not be shown to fire. */
export type FindingWithdrawal =
  | { readonly by: "recorded_withdrawal"; readonly ref: string; readonly reason: string }
  | { readonly by: "assessment"; readonly assessment_ref: string };

/** What a round found. `evidence_ref` may be null — a finding whose evidence was not filed is
 *  a weaker finding, and it is still a finding; dropping it for want of a reference would be
 *  this module deleting findings on a technicality. */
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
 *  `disposition` IS TYPED `"open"` AND NOT {@link FindingDisposition}, which is the whole of
 *  the rule this module spends its header asserting. It took the full set, so
 *  `recordFinding({ id, disposition: "resolved" })` was legal: this file refused an assessment
 *  the right to close a finding and then handed the same power to anyone recording one. The
 *  rule was stated in three paragraphs at the top and held by two of the three functions
 *  underneath them.
 *
 *  It stays as a field rather than being deleted because `disposition: "open"` is a true thing
 *  a caller may want to write down, and the gate check writes it. What it may no longer be is
 *  anything else. */
export interface FindingInput {
  readonly id: string;
  readonly disposition?: "open";
  readonly summary?: string;
  readonly evidence_ref?: string | null;
  readonly requiredTests?: readonly RequiredTest[];
  readonly withdrawal?: FindingWithdrawal | null;
  readonly resolution?: RecordedResolution | null;
}

/** A NEW FINDING IS OPEN, AND THERE IS NO EXPRESSION HERE THAT PRODUCES ANY OTHER STATE.
 *
 *  `"open"` is written as a literal rather than copied from `input`, for the reason the type
 *  above is narrow: a type is erased at runtime and an input cast from JSON is not, so a
 *  narrow field alone would leave `recordFinding(row as FindingInput)` able to record a
 *  finding closed. Both together mean a closed recording is neither writable nor typeable.
 *
 *  `resolution` is still carried, because {@link resolveFinding} is the one thing that files
 *  one and its output has to be constructible. A resolution arriving here without a
 *  disposition to go with it lands on a finding that is still open — which is what it is. */
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

// ── an assessment, and everything it is structurally unable to do ──────────────────────────

/** A bounded question's answer about a finding. `value` is whatever the assessor returned —
 *  a choice, a score, a probability, rendered as text — and this module never interprets it.
 *
 *  NOTE WHAT IS NOT HERE: no disposition, no verification reference, no outcome, no authority.
 *  Those absences are the mechanism. A function that wanted to close a finding from an
 *  assessment would have nothing to read. */
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
  /** COPIED OFF THE FINDING. Nothing in {@link Assessment} is read to produce this. */
  readonly disposition: FindingDisposition;
  readonly assessment: Assessment;
  /** The findings still standing after the assessment was applied. */
  readonly ledger: readonly Finding[];
  /** COMPUTED: the finding is not on `ledger`. */
  readonly deleted: boolean;
  /** COMPUTED: at least one required test stands discharged by an assessment. */
  readonly substitutesForTest: boolean;
  /** Which required tests those are, named, so a caller fixing this knows what to run. */
  readonly substitutedTests: readonly string[];
}

/**
 * THE LEDGER AFTER AN ASSESSMENT, which is how `deleted` gets computed rather than asserted.
 *
 * An assessment is applied to a finding, so the finding is what stands after it. The one shape
 * that does not survive is a withdrawal naming an assessment as its author, because that is a
 * finding erased by something that cannot erase findings — and a ledger that carried it
 * forward would let `deleted` report false about a finding that is gone.
 *
 * A finding withdrawn by a RECORDED withdrawal stays on the ledger, withdrawn. The record of
 * what was found does not disappear because somebody decided it no longer applies.
 */
function assessedLedger(finding: Finding): readonly Finding[] {
  return Object.freeze([finding].filter((f) => f.withdrawal?.by !== "assessment"));
}

/**
 * READING A FINDING, AND CHANGING NOTHING ABOUT IT.
 *
 * The three things this cannot do, and how each is prevented rather than documented:
 *
 *   · CLOSE IT — `disposition` on the result is `finding.disposition`. There is no other
 *     expression in this function that produces a disposition, and {@link Assessment} has no
 *     field of that type to supply one.
 *   · DELETE IT — `deleted` is read off {@link assessedLedger}'s output by id. An assessment
 *     is not a parameter of that function, so no assessment value can influence the answer.
 *   · STAND IN FOR A TEST — `substitutesForTest` counts required tests discharged by an
 *     assessment. This module writes no such discharge; where one appears the flag says so.
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

/** What became of an attempt to close a finding. BOTH ARMS CARRY THE FINDING, so a caller
 *  wanting the record as it now stands never has to read `closed` to get it, and `refusal`
 *  says which check was cited and what state it was in. */
export type FindingClosure =
  | { readonly closed: true; readonly finding: Finding }
  | { readonly closed: false; readonly finding: Finding; readonly refusal: string };

/**
 * THE ONE WAY A FINDING CLOSES: something ran, and its outcome is on the record.
 *
 * REFUSING SILENTLY IS NOT REFUSING. This returned the finding unchanged on a resolution
 * citing a check that had failed or never run — the right record, and no way for the caller to
 * tell it apart from a finding that was already resolved, or from a close that worked. A
 * refusal nobody can observe is indistinguishable from success at the call site, which is how
 * the caller most likely to be wrong is the one least likely to find out. So the outcome is on
 * the result and the reason is a sentence, the way `finding_decide` answers in zz-core: it
 * names what it refused and why rather than handing back something that looks like agreement.
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
  // BUILT FROM THE FINDING, NOT THROUGH `recordFinding`. It used to go through it, and that
  // coupling is what made the defect above reachable: `recordFinding` had to accept a closed
  // disposition because this line needed to hand it one. A resolved finding is the finding it
  // was plus the verification that closed it, and saying so here costs one spread and leaves
  // the recording constructor with no reason to know the word "resolved".
  return Object.freeze({
    closed: true as const,
    finding: Object.freeze({ ...finding, disposition: "resolved" as const, resolution }),
  });
}

/** A dispute between two rounds, as a relation rather than an edit. */
export interface FindingDispute {
  readonly disputed_id: string;
  readonly by_id: string;
}

/** Both findings and the relation between them. There is no winner field: which of two
 *  disagreeing rounds was right is a judgement a reader makes from the evidence, and a field
 *  here would be this module making it for them. */
export interface FindingLedger {
  readonly entries: readonly Finding[];
  readonly disputes: readonly FindingDispute[];
}

/**
 * A LATER ROUND DISPUTING AN EARLIER FINDING, WITH BOTH SURVIVING.
 *
 * Neither record is rewritten. The earlier finding keeps the disposition it was recorded at,
 * and the disagreement is the relation between the two rather than an edit to either: writing
 * a second round's view onto the first round's row would mean the record of what the first
 * round found is whatever the second thought of it, and the first round's account is exactly
 * what somebody needs when the two conflict.
 */
export function disputeFinding(original: Finding, later: Finding): FindingLedger {
  return Object.freeze({
    entries: Object.freeze([original, later]),
    disputes: Object.freeze([{ disputed_id: original.id, by_id: later.id }]),
  });
}
