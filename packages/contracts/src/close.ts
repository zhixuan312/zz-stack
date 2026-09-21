/**
 * close.ts — what a closing record may say, and what a handover may claim to have verified.
 *
 * THE SUBJECT IS THE FAILURE MODE, NOT THE PAPERWORK. Every field here exists because the
 * honest version of it and the flattering version of it look identical to a later reader. A
 * piece of work that nobody signed off reads exactly like one that was accepted, once
 * somebody has written `accepted` into a record by hand. A number an author typed into a
 * handover reads exactly like a number the platform counted, once both are printed in the
 * same table. A piece of work that stopped early reads exactly like one that got all the way
 * through, once closing it fills in the stages it never reached. So this module is not a
 * validator bolted onto a record somebody else assembles: it is the only assembler, and the
 * flattering version of each of those three records is not something it refuses — it is
 * something it cannot express.
 *
 * ONE PRODUCER OF AN OUTCOME. {@link deriveOutcome} is it. {@link closeInitiative} calls it
 * and never assembles an outcome of its own, and the request type it takes has no field an
 * outcome could arrive in. That is the type-level half. The runtime half is
 * {@link CloseRecord.acceptedByHand}, which is an OBSERVATION rather than a flag: the request
 * is destructured into the fields this module reads and a rest, and any leftover field
 * carrying one of the three outcome words is a caller writing by hand what the platform
 * derives. The read set is the destructure itself rather than a second list of key names,
 * because a second list is free to drift from the first and the drift is invisible until the
 * day it lets one through.
 *
 * A STAGE'S STATE AND ITS EVIDENCE ARE ONE DERIVATION. {@link stageRecord} is the only
 * function in this file that can build a stage record, and it computes `state` from the
 * evidence it was handed in the same expression that keeps the evidence. There is no path
 * that sets one without the other, so "established means it carries evidence" is a property
 * of the structure rather than a convention somebody has to remember. That is what makes an
 * abandoned close safe: closing work that stopped cannot assert that what came before it
 * succeeded, because the only way to get `established` is to hand over the evidence for it.
 *
 * AND THIS MODULE HAS NO NOTION OF ORDER. It holds no list of stages and no idea which one
 * follows which — every stage in a record is one the caller handed it, by a name it treats as
 * opaque text. It therefore cannot name a stage nobody mentioned, which is the abandonment
 * invariant and the reason the kernel stays generic, in one property.
 *
 * EXPECTED IMPACT IS NOT OBSERVED IMPACT, and a declared count is not an enforced one. The
 * handover half of this file keeps two builders: one stamps a claim as the author's own word,
 * one stamps a claim as something a named reader read back, and a value arriving without a
 * reader degrades to the first rather than being trusted as the second. The proposed count
 * routes through the declaring builder in code. Nothing reads that count back — the check
 * that once did was deliberately removed, because it made work that had been abandoned
 * impossible to close — so there is no input that could route it through the other builder,
 * and `proposedIsEnforced` is an observation of where the claim came from rather than a
 * constant somebody set to false.
 *
 * WHICH TYPES ARE PUBLIC, AND THE RULE THAT DECIDES IT. A type is exported here when some
 * other module names it — close-probe.ts names six, because a probe that plants a fault has to
 * build the faulted subject and hold the record it gets back. The rest are reachable only
 * through a signature position, so they emit as private declarations in the `.d.ts`: a caller
 * still gets full checking on what these functions take and return, without this package
 * carrying a public name nobody imports. An exported type with no importer is dead surface
 * with a door on it, and the same sweep that refuses a dead function refuses it.
 *
 * WHAT MAY BE CORRECTED LATER. A closing record can be corrected the way every other document
 * is corrected, by revising it. The disposition that closed the work is not revised and not
 * written twice: a second closing call is refused, and the refusal says so in the place
 * somebody will actually read it.
 */

// ── the vocabulary ─────────────────────────────────────────────────────────────────────────

/**
 * The three outcomes the platform derives, and the only three strings this module will ever
 * produce as one. It is a single frozen list rather than a type alone because two different
 * jobs need it: {@link deriveOutcome} produces from it, and the hand-written-outcome
 * observation tests membership of it. Two lists would be two answers to "what counts as an
 * outcome", and the observation would stop seeing the word the derivation had just added.
 */
const OUTCOMES = Object.freeze(["accepted", "delivered", "abandoned"] as const);

type Outcome = (typeof OUTCOMES)[number];

/**
 * What the caller says happened, which is NOT the outcome and is deliberately a shorter list.
 * Work either finished or it stopped. Whether finishing was accepted or merely delivered is
 * not something the caller gets to say — it follows from whether an acceptor exists, and that
 * derivation is the whole point of {@link deriveOutcome}.
 */
type Disposition = "finished" | "abandoned";

/** Where a stage stands, in the same two words the control state already uses for a step, so
 *  a control state's own records pass in here unchanged rather than through a translation
 *  whose two halves are free to disagree. */
type StageState = "established" | "not_established";

/** What a close can say about the gates it declared. THREE VALUES, because "nobody said" and
 *  "somebody said no" are different facts and collapsing them is how a record ends up
 *  asserting something nobody claimed. */
type GatePosture = "recorded" | "unrecorded" | "unstated";

/** Where a claim in a handover came from. `read-back` is stampable by exactly one builder. */
export type ClaimBasis = "self-reported" | "read-back";
const SELF_REPORTED: ClaimBasis = "self-reported";
const READ_BACK: ClaimBasis = "read-back";

/** A non-empty string, and the answer to "does an acceptor exist" and "was a reader named". */
function named(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Present enough to record. `0` is a real count and must survive: a handover that minted
 *  nothing has a number to report, and dropping it would leave the record silent about the
 *  very case the reader most needs to see. */
function present(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim().length > 0;
}

/** Whether a value is one of the three words the platform derives — asked of the SAME frozen
 *  list {@link deriveOutcome} returns from. */
function isOutcomeWord(value: unknown): boolean {
  return typeof value === "string" && (OUTCOMES as readonly string[]).includes(value);
}

// ── the outcome ────────────────────────────────────────────────────────────────────────────

/**
 * What a close is told, and everything the outcome may be derived from.
 *
 * `no_signoff_reason` IS ACCEPTED AND IS NOT AN INPUT TO THE DERIVATION. A reason explains a
 * delivery; it does not make one. Work that finished without an acceptor was delivered
 * whether or not anybody explained why nobody signed it off — and if the derivation consulted
 * the reason, supplying a sentence would silently change the outcome, which is a hand-written
 * outcome wearing a different hat. The reason is recorded, and its absence is recorded too.
 */
interface OutcomeBasis {
  readonly disposition: Disposition;
  readonly accepted_by?: string | null;
  readonly no_signoff_reason?: string | null;
}

/**
 * The one producer of an outcome.
 *
 * Returns `null` rather than guessing when the disposition is not one of the two this
 * platform knows. The type keeps that case out of every compiled caller; this is for the
 * other path, where a disposition arrives as data from a document somebody wrote. Defaulting
 * an unrecognised disposition to `delivered` would mean the most honest-looking outcome in
 * the record was the one nobody established, which is this module's subject exactly.
 */
export function deriveOutcome(basis: OutcomeBasis): Outcome | null {
  if (basis.disposition === "abandoned") return "abandoned";
  if (basis.disposition === "finished") return named(basis.accepted_by) ? "accepted" : "delivered";
  return null;
}

// ── the stages a close may record ──────────────────────────────────────────────────────────

/** One stage as the caller recorded it, in the control state's own field names so its records
 *  pass straight in. Any `state` carried alongside is IGNORED — see {@link stageRecord}. */
export interface StageEvidence {
  readonly step: string;
  readonly evidence?: readonly string[];
}

/** One stage as the closing record states it. */
export interface StageRecord {
  readonly step: string;
  readonly state: StageState;
  readonly evidence: readonly string[];
}

/**
 * THE ONLY FUNCTION IN THIS FILE THAT BUILDS A STAGE RECORD, and it computes the state from
 * the evidence it keeps, in the same breath as keeping it.
 *
 * A caller's own opinion of a stage's state never reaches here: {@link StageEvidence} carries
 * evidence and a name, and if a record arrives with a state attached it is dropped on the way
 * in. So `established` is not a word a caller can write — it is what having evidence is
 * called, and the empty case is `not_established` rather than anything softer.
 *
 * Blank strings are not evidence. A record whose evidence is three empty strings is a record
 * with no evidence, and treating it as three would make the flattering version reachable
 * through whitespace.
 */
function stageRecord(step: string, evidence: readonly string[] | undefined): StageRecord {
  const kept = (evidence ?? []).filter((e): e is string => named(e));
  const state: StageState = kept.length > 0 ? "established" : "not_established";
  return Object.freeze({ step, state, evidence: Object.freeze([...kept]) });
}

/**
 * The stages a closing record states, and nothing else.
 *
 * The stage the work reached is appended with NO evidence when the caller recorded none for
 * it, which is the abandoned case written down honestly: the work got here, and nothing is
 * claimed about it. Nothing before it is invented, because nothing in this module knows what
 * came before it.
 */
function deriveStages(
  records: readonly StageEvidence[] | undefined,
  reached: string | undefined,
): readonly StageRecord[] {
  const out = (records ?? []).map((r) => stageRecord(r.step, r.evidence));
  if (named(reached) && !out.some((s) => s.step === reached)) out.push(stageRecord(reached, []));
  return Object.freeze(out);
}

// ── the close ──────────────────────────────────────────────────────────────────────────────

/**
 * What a caller may hand a close. Note what is absent: there is no field an outcome fits in.
 *
 * `already` and `gatesRecorded` are facts the caller read back off the record store before
 * calling, not opinions — this module refuses on them and never writes either one.
 */
export interface CloseRequest {
  readonly disposition: Disposition;
  readonly accepted_by?: string | null;
  readonly no_signoff_reason?: string | null;
  /** The stage the work got to, as opaque caller text. */
  readonly reachedStage?: string;
  readonly stages?: readonly StageEvidence[];
  /** `true` recorded, `false` declared but unrecorded, absent means nobody said. */
  readonly gatesRecorded?: boolean;
  /** Whether a closing record already exists for this work. */
  readonly already?: boolean;
}

/**
 * The closing record: the outcome the platform derived, the stages it can honestly state, the
 * posture it was told about the gates, and what it was not told.
 *
 * A REFUSAL IS NOT A PARTIAL CLOSE. When `ok` is false the outcome is `null` and the stages
 * are empty, because nothing was closed — a half-filled record is the artefact somebody
 * later reads as a whole one.
 */
interface CloseRecord {
  readonly ok: boolean;
  readonly outcome: Outcome | null;
  /** Computed: a caller supplied an outcome rather than letting it be derived. */
  readonly acceptedByHand: boolean;
  readonly stages: readonly StageRecord[];
  readonly gatePosture: GatePosture;
  /** Who accepted the work, where one did. AN OUTCOME OF `accepted` WITH NOBODY NAMED IS THE
   *  unverifiable claim this file exists to prevent, so the acceptor the outcome was derived
   *  from is kept beside it rather than left in the call that produced it. */
  readonly accepted_by: string | null;
  readonly no_signoff_reason: string | null;
  /** What this record does NOT know, named rather than defaulted. */
  readonly unstated: readonly string[];
  readonly refusals: readonly string[];
}

const NO_STAGES: readonly StageRecord[] = Object.freeze([]);

/**
 * Close a piece of work, or refuse and say why.
 *
 * WHAT A BARE CALL ASSUMES ABOUT GATES, and why. `{ disposition }` alone is not refused, and
 * its gate posture is recorded as `unstated` rather than as either of the other two. The rule
 * is that work whose DECLARED gates are unrecorded may not be closed — and a caller that says
 * nothing has declared no gate to this call, so there is nothing unrecorded to refuse over.
 * Writing `gatesRecorded ?? true` instead would have the record assert, on behalf of a caller
 * who said nothing, that gates were recorded; writing `?? false` would make work that
 * declared no gates unclosable. Both invent a fact. The third value costs a word in the
 * record and states exactly what is true: nobody said.
 *
 * Every refusal is collected rather than the first one thrown, so a caller fixes one call's
 * worth of problems rather than discovering them one round at a time.
 */
export function closeInitiative(request: CloseRequest): CloseRecord {
  // THE DESTRUCTURE IS THE READ SET. Every field this module consumes is named here, and
  // `rest` is therefore, by construction, everything it does not. No second list to drift.
  const { disposition, accepted_by, no_signoff_reason, reachedStage, stages, gatesRecorded, already, ...rest } =
    request;

  const handWritten = Object.entries(rest as Record<string, unknown>)
    .filter(([, value]) => isOutcomeWord(value))
    .map(([key]) => key);
  const acceptedByHand = handWritten.length > 0;

  const gatePosture: GatePosture =
    gatesRecorded === true ? "recorded" : gatesRecorded === false ? "unrecorded" : "unstated";

  const refusals: string[] = [];
  if (acceptedByHand) {
    refusals.push(
      `the outcome was supplied by hand in ${handWritten.join(", ")}; it is derived from the ` +
        "disposition and whether an acceptor exists, and is never written by a caller",
    );
  }
  if (already === true) {
    refusals.push(
      "a closing record already exists for this work. It may be corrected by revising it, " +
        "the way any document is corrected; the disposition that closed the work is not written twice",
    );
  }
  if (gatePosture === "unrecorded") {
    refusals.push("a declared gate is unrecorded, so what it was meant to hold has not been established");
  }

  const derived = deriveOutcome({ disposition, accepted_by, no_signoff_reason });
  if (derived === null) {
    refusals.push(`no outcome can be derived from a disposition of ${JSON.stringify(disposition)}`);
  }

  const ok = refusals.length === 0;
  const reason = named(no_signoff_reason) ? no_signoff_reason : null;

  // NAMED, NOT FILLED IN. Work delivered with no reason given is delivered with no reason
  // given; the gap belongs in the record rather than in the head of whoever wrote it.
  const unstated: string[] = [];
  if (derived === "delivered" && reason === null) unstated.push("no_signoff_reason");
  if (gatePosture === "unstated") unstated.push("gatesRecorded");

  return Object.freeze({
    ok,
    outcome: ok ? derived : null,
    acceptedByHand,
    stages: ok ? deriveStages(stages, reachedStage) : NO_STAGES,
    gatePosture,
    accepted_by: named(accepted_by) ? accepted_by : null,
    no_signoff_reason: reason,
    unstated: Object.freeze(unstated),
    refusals: Object.freeze(refusals),
  });
}

// ── the handover ───────────────────────────────────────────────────────────────────────────

/** One thing a handover states, and where it got it. */
export interface Claim {
  readonly field: string;
  readonly value: string;
  readonly basis: ClaimBasis;
}

const PROPOSED_FIELD = "proposed_team_nodes";
const MINTED_FIELD = "minted_team_nodes";
const EXPECTED_FIELD = "expected_impact";
const OBSERVED_FIELD = "observed_impact";

/**
 * A claim in the author's own words. There is no reader, so there is no basis but this one —
 * the function takes no reader argument, which is how the absence stays structural.
 */
function declaredClaim(field: string, value: unknown): Claim | null {
  if (!present(value)) return null;
  return Object.freeze({ field, value: String(value), basis: SELF_REPORTED });
}

/**
 * The ONLY builder that can stamp {@link READ_BACK}, and it will not do so without a named
 * reader. A number handed over with nothing named as having read it is the author's word for
 * it, whatever bucket it arrived in — so the degradation is the second structural layer under
 * the routing: even a value wrongly routed here stays self-reported until something is named
 * as having read it.
 */
function observedClaim(field: string, value: unknown, readBy: unknown): Claim | null {
  if (!present(value)) return null;
  return Object.freeze({ field, value: String(value), basis: named(readBy) ? READ_BACK : SELF_REPORTED });
}

/**
 * What a handover is handed. Each field routes to exactly one builder, in code, below.
 *
 * `impactReading` and `impactReadBy` are one fact in two halves and are consumed as one: a
 * measurement with nothing named as having taken it is not an observation. `expectedImpact`
 * is the author's forecast and reaches neither of them.
 */
export interface HandoverDeclaration {
  /** The author's own count of what they propose. Nothing reads this back. */
  readonly proposed_team_nodes?: string | number;
  /** How many were actually minted. */
  readonly mintedTeamNodes?: number;
  /** What read the minted count back, if anything did. */
  readonly mintedReadBy?: string;
  /** What the author expects to change. A forecast. */
  readonly expectedImpact?: string;
  /** A measurement of what actually changed. */
  readonly impactReading?: string;
  /** What took that measurement. */
  readonly impactReadBy?: string;
}

/**
 * A handover that describes its own verification.
 *
 * EVERY FIELD HERE IS AN OBSERVATION OF `claims`, AND THAT IS THE WHOLE DESIGN. A flag beside
 * the claims, computed from something else, is free to disagree with them — and a reader who
 * branches on the flag rather than reading the list would never find out. So `selfReported`
 * counts the same list the statement prints, and `expectedImpact` is the forecast claim's own
 * value rather than a second reading of the declaration through a second predicate.
 *
 * A GENERAL NAME MUST NOT CARRY A NARROW READING. `selfReported` was once the basis of the
 * proposed count alone, so a handover whose every claim was the author's word reported
 * `selfReported: false` — a record that reads, to someone who was not there, as something it
 * is not, which is the exact failure this file exists to prevent. The name is general, so the
 * question it answers is general: does this handover assert anything nobody read back?
 * `proposedIsEnforced` keeps the narrow reading because its name is narrow — it names the one
 * field it is about, and with no count declared there is nothing being presented as enforced.
 */
interface HandoverRecord {
  readonly claims: readonly Claim[];
  /** Computed from `claims`: this handover asserts at least one thing nobody read back. */
  readonly selfReported: boolean;
  /** Computed: something read THE PROPOSED COUNT back. Nothing does, and a handover that
   *  declares no count has nothing to present as enforced, so this is false either way. */
  readonly proposedIsEnforced: boolean;
  /** The forecast, taken from its own claim so the two can never disagree. */
  readonly expectedImpact: string | null;
  /** Present only when a measurement AND a reader both arrived. Absent is the default and the
   *  honest answer; a forecast can never land here. */
  readonly observedImpact?: string;
  /** The sentence the handover carries: what was read back, and what is the author's word. */
  readonly statement: string;
}

export function handoverClaims(declaration: HandoverDeclaration): HandoverRecord {
  // THE ROUTING IS THE CONTRACT. Two fields go to the declaring builder and two pairs go to
  // the reading one, and there is no input that moves any of them across.
  const proposed = declaredClaim(PROPOSED_FIELD, declaration.proposed_team_nodes);
  const expected = declaredClaim(EXPECTED_FIELD, declaration.expectedImpact);
  const minted = observedClaim(MINTED_FIELD, declaration.mintedTeamNodes, declaration.mintedReadBy);
  const observed = observedClaim(OBSERVED_FIELD, declaration.impactReading, declaration.impactReadBy);

  const claims = Object.freeze(
    [proposed, minted, expected, observed].filter((c): c is Claim => c !== null),
  );

  const readBack = claims.filter((c) => c.basis === READ_BACK).map((c) => c.field);
  const asserted = claims.filter((c) => c.basis === SELF_REPORTED).map((c) => c.field);

  return Object.freeze({
    claims,
    // THE SAME LIST THE STATEMENT PRINTS. Not `proposed?.basis === SELF_REPORTED`: that answers
    // a question about one field under a name that promises an answer about the handover.
    selfReported: asserted.length > 0,
    proposedIsEnforced: proposed?.basis === READ_BACK,
    expectedImpact: expected?.value ?? null,
    observedImpact: observed !== null && observed.basis === READ_BACK ? observed.value : undefined,
    statement:
      `read back: ${readBack.length > 0 ? readBack.join(", ") : "nothing"}; ` +
      `self-reported and not read back: ${asserted.length > 0 ? asserted.join(", ") : "nothing"}`,
  });
}
