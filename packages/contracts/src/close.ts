/**
 * close.ts — what a closing record may say.
 *
 * The honest version of a closing record and the flattering version look identical to a later
 * reader. This module is the only assembler of one, so the flattering version is not something it
 * refuses — it is something it cannot express.
 *
 * It has no notion of order: no list of stages, and every stage name is opaque caller text, so
 * it cannot name a stage nobody mentioned.
 *
 * A type is exported here when another module names it. The rest are reachable only through a
 * signature position and emit as private declarations in the `.d.ts`.
 *
 * A closing record is corrected by revising it. A second closing call is refused.
 */
import { OUTCOMES } from "./outcomes.js";

// The vocabulary

/** The three outcomes the platform derives, and the only three strings this module produces as
 *  one: {@link deriveOutcome} produces from the list and the hand-written-outcome observation
 *  tests membership of it. */
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

/** A non-empty string, and the answer to "does an acceptor exist". */
function named(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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
  if (basis.disposition === "finished") {
    return (named(basis.accepted_by) ? "accepted" : "delivered") satisfies (typeof OUTCOMES)[number];
  }
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
