/**
 * close.ts — what a closing record may say, and what a handover may claim to have verified.
 *
 * The honest version of each record here and the flattering version look identical to a later
 * reader. This module is the only assembler of all three, so the flattering version is not
 * something it refuses — it is something it cannot express.
 *
 * It has no notion of order: no list of stages, and every stage name is opaque caller text, so
 * it cannot name a stage nobody mentioned.
 *
 * A type is exported here when another module names it. The rest are reachable only through a
 * signature position and emit as private declarations in the `.d.ts`.
 *
 * A closing record is corrected by revising it. A second closing call is refused.
 */

// The vocabulary

/**
 * The three outcomes the platform derives, and the only three strings this module produces as
 * one. A single frozen list rather than a type alone, because {@link deriveOutcome} produces
 * from it and the hand-written-outcome observation tests membership of it.
 */
const OUTCOMES = Object.freeze(["accepted", "delivered", "abandoned"] as const);

type Outcome = (typeof OUTCOMES)[number];

/**
 * What the caller says happened, which is not the outcome and is a shorter list: work either
 * finished or it stopped. Whether finishing was accepted or merely delivered follows from
 * whether an acceptor exists — see {@link deriveOutcome}.
 */
type Disposition = "finished" | "abandoned";

/** Where a stage stands, in the same two words the control state uses for a step, so a control
 *  state's own records pass in unchanged rather than through a translation. */
type StageState = "established" | "not_established";

/** What a close can say about the gates it declared. Three values: "nobody said" and "somebody
 *  said no" are different facts, and collapsing them makes a record assert an unmade claim. */
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
 *  nothing still has a number to report. */
function present(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim().length > 0;
}

/** Whether a value is one of the three words the platform derives — asked of the same frozen
 *  list {@link deriveOutcome} returns from. */
function isOutcomeWord(value: unknown): boolean {
  return typeof value === "string" && (OUTCOMES as readonly string[]).includes(value);
}

// The outcome

/**
 * What a close is told, and everything the outcome may be derived from.
 *
 * `no_signoff_reason` is recorded and is not an input to the derivation: work that finished
 * without an acceptor was delivered whether or not anybody explained why. Its absence is
 * recorded too.
 */
interface OutcomeBasis {
  readonly disposition: Disposition;
  readonly accepted_by?: string | null;
  readonly no_signoff_reason?: string | null;
}

/**
 * The one producer of an outcome.
 *
 * Returns `null` rather than guessing when the disposition is not one of the two this platform
 * knows. The type keeps that case out of every compiled caller; this is for the path where a
 * disposition arrives as data from a document somebody wrote.
 */
export function deriveOutcome(basis: OutcomeBasis): Outcome | null {
  if (basis.disposition === "abandoned") return "abandoned";
  if (basis.disposition === "finished") return named(basis.accepted_by) ? "accepted" : "delivered";
  return null;
}

// The stages a close may record

/** One stage as the caller recorded it, in the control state's own field names so its records
 *  pass straight in. Any `state` carried alongside is ignored — see {@link stageRecord}. */
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
 * The only function in this file that builds a stage record, and it computes the state from
 * the evidence it keeps, in the same expression.
 *
 * A caller's own opinion of a stage's state never reaches here: {@link StageEvidence} carries
 * evidence and a name, and a state attached to an incoming record is dropped. `established` is
 * what having evidence is called, and a blank string is not evidence.
 */
function stageRecord(step: string, evidence: readonly string[] | undefined): StageRecord {
  const kept = (evidence ?? []).filter((e): e is string => named(e));
  const state: StageState = kept.length > 0 ? "established" : "not_established";
  return Object.freeze({ step, state, evidence: Object.freeze([...kept]) });
}

/**
 * The stages a closing record states, and nothing else.
 *
 * The stage the work reached is appended with no evidence when the caller recorded none for
 * it. Nothing before it is invented, because nothing in this module knows what came before it.
 */
function deriveStages(
  records: readonly StageEvidence[] | undefined,
  reached: string | undefined,
): readonly StageRecord[] {
  const out = (records ?? []).map((r) => stageRecord(r.step, r.evidence));
  if (named(reached) && !out.some((s) => s.step === reached)) out.push(stageRecord(reached, []));
  return Object.freeze(out);
}

// The close

/**
 * What a caller may hand a close. There is no field an outcome fits in.
 *
 * `already` and `gatesRecorded` are facts the caller read back off the record store before
 * calling; this module refuses on them and never writes either one.
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
 * When `ok` is false the outcome is `null` and the stages are empty: a refusal is not a
 * partial close.
 */
interface CloseRecord {
  readonly ok: boolean;
  readonly outcome: Outcome | null;
  /** Computed: a caller supplied an outcome rather than letting it be derived. */
  readonly acceptedByHand: boolean;
  readonly stages: readonly StageRecord[];
  readonly gatePosture: GatePosture;
  /** Who accepted the work, where one did. Kept beside the outcome it was derived from, so an
   *  outcome of `accepted` cannot stand with nobody named. */
  readonly accepted_by: string | null;
  readonly no_signoff_reason: string | null;
  /** What this record does not know, named rather than defaulted. */
  readonly unstated: readonly string[];
  readonly refusals: readonly string[];
}

const NO_STAGES: readonly StageRecord[] = Object.freeze([]);

/**
 * Close a piece of work, or refuse and say why.
 *
 * `{ disposition }` alone is not refused, and its gate posture is recorded as `unstated`. The
 * rule refuses work claiming to have finished with its declared gates unrecorded, and a caller
 * that says nothing has declared no gate. `gatesRecorded ?? true` would assert gates were
 * recorded on behalf of a caller who said nothing; `?? false` would make work that declared no
 * gates unclosable.
 *
 * Every refusal is collected rather than the first one thrown.
 */
export function closeInitiative(request: CloseRequest): CloseRecord {
  // The destructure is the read set: every field this module consumes is named here, so `rest`
  // is by construction everything it does not. No second list to drift.
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
  // Only work that claims to have finished is refused over a gate. Work that stopped is
  // precisely work whose gates were never passed, so applying this to it leaves two exits:
  // approve a gate nobody agreed to, or leave the work open for ever.
  //
  // The posture is recorded either way, and only the refusal turns on the disposition — an
  // abandoned close carrying `unrecorded` states something true.
  if (gatePosture === "unrecorded" && disposition === "finished") {
    refusals.push("a declared gate is unrecorded, so what it was meant to hold has not been established");
  }

  const derived = deriveOutcome({ disposition, accepted_by, no_signoff_reason });
  if (derived === null) {
    refusals.push(`no outcome can be derived from a disposition of ${JSON.stringify(disposition)}`);
  }

  const ok = refusals.length === 0;
  const reason = named(no_signoff_reason) ? no_signoff_reason : null;

  // Named, not filled in: work delivered with no reason given is delivered with no reason
  // given, and the gap belongs in the record.
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

// The handover

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
 * A claim in the author's own words. The function takes no reader argument, so there is no
 * basis but this one.
 */
function declaredClaim(field: string, value: unknown): Claim | null {
  if (!present(value)) return null;
  return Object.freeze({ field, value: String(value), basis: SELF_REPORTED });
}

/**
 * The only builder that can stamp {@link READ_BACK}, and it will not do so without a named
 * reader: a value wrongly routed here stays self-reported until something is named as having
 * read it.
 */
function observedClaim(field: string, value: unknown, readBy: unknown): Claim | null {
  if (!present(value)) return null;
  return Object.freeze({ field, value: String(value), basis: named(readBy) ? READ_BACK : SELF_REPORTED });
}

/**
 * What a handover is handed. Each field routes to exactly one builder, in code, below.
 *
 * `impactReading` and `impactReadBy` are one fact in two halves and are consumed as one: a
 * measurement with nothing named as having taken it is not an observation. `expectedImpact` is
 * the author's forecast and reaches neither of them.
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
 * Every field here is an observation of `claims`. A flag beside the claims, computed from
 * something else, is free to disagree with them, so `selfReported` counts the same list the
 * statement prints and `expectedImpact` is the forecast claim's own value.
 *
 * `selfReported` answers a general question — does this handover assert anything nobody read
 * back? `proposedIsEnforced` keeps a narrow reading because it names the one field it is
 * about, and with no count declared there is nothing presented as enforced.
 */
interface HandoverRecord {
  readonly claims: readonly Claim[];
  /** Computed from `claims`: this handover asserts at least one thing nobody read back. */
  readonly selfReported: boolean;
  /** Computed: something read the proposed count back. Nothing does, and a handover that
   *  declares no count has nothing to present as enforced, so this is false either way. */
  readonly proposedIsEnforced: boolean;
  /** The forecast, taken from its own claim so the two can never disagree. */
  readonly expectedImpact: string | null;
  /** Present only when a measurement and a reader both arrived. Absent is the default; a
   *  forecast can never land here. */
  readonly observedImpact?: string;
  /** The sentence the handover carries: what was read back, and what is the author's word. */
  readonly statement: string;
}

export function handoverClaims(declaration: HandoverDeclaration): HandoverRecord {
  // The routing is the contract: two fields go to the declaring builder, two pairs to the
  // reading one, and no input moves any of them across.
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
    // The same list the statement prints. Not `proposed?.basis === SELF_REPORTED`: that answers
    // a question about one field under a name that promises one about the handover.
    selfReported: asserted.length > 0,
    proposedIsEnforced: proposed?.basis === READ_BACK,
    expectedImpact: expected?.value ?? null,
    observedImpact: observed !== null && observed.basis === READ_BACK ? observed.value : undefined,
    statement:
      `read back: ${readBack.length > 0 ? readBack.join(", ") : "nothing"}; ` +
      `self-reported and not read back: ${asserted.length > 0 ? asserted.join(", ") : "nothing"}`,
  });
}
