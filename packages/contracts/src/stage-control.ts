/**
 * One controller for every step a flow declares.
 *
 * A flow's steps are declared in its own catalog entry, and each binds a contract: what the step is
 * meant to change, what evidence it may not be entered without, and which gates it is subject to.
 * The profile is data and this module is the one path through it. {@link createController} is handed
 * an {@link ExecutionProfile} — the bound contracts, resolved above this layer — and every step
 * resolves its contract, reconciles against the control state and settles its outcome through the
 * same three functions. This module cannot name a step: it has no list, and the only step ids it
 * sees are the ones in the profile it was handed. How many steps a flow has is a fact about that
 * flow's declaration, never a constant here.
 *
 * The control state alone carries a revision. What a step produced enters as evidence and
 * verification refs, which this module records and never versions — the documents they point at are
 * versioned where they live. An entry or a settlement carries the control revision its caller last
 * saw; if the control state has moved on, the call is refused and the refusal carries the current
 * revision. It never proceeds against whatever the controller holds now, and never silently
 * re-reads.
 *
 * Entry evidence is returned, not defaulted: a step entered without the evidence its contract
 * requires comes back with the missing kinds named.
 *
 * Evidence is required at a standard, and the standard is part of the requirement. A requirement
 * says how firmly its evidence must stand, a holding says how firmly it does stand, and the
 * comparison is ordered — see {@link EvidenceStandard}. Which standard applies to which kind is the
 * caller's fact about its own world, arriving as data like everything else here.
 *
 * A requirement may be discharged rather than met, on a named ground. {@link EntryWaiver} carries
 * that ground, for one named kind, and it is carried back out on {@link EntryAdmission.waived}, so
 * an admission granted on a waiver is never mistaken for one granted on evidence.
 *
 * `needs_revisit` is computed, never set: a step that was established and is settled again with a
 * gap open is a step whose outcome no longer holds, and the controller says so from the prior
 * outcome it already holds rather than from a caller's opinion of its own state.
 */
import { readiness, type AuditContext, type ObservedSignals, type ReadinessVerdict } from "./readiness.js";

/** Where a step's intended change stands. `not_established` is the state a step starts in and
 *  returns to nothing from; `needs_revisit` is reserved for an outcome that did hold and has stopped
 *  holding, because losing that distinction loses the reason to look again. */
export type OutcomeState = "not_established" | "established" | "needs_revisit";

/** How firmly a piece of evidence stands, or has to. `recorded` is "it exists and somebody can read
 *  it"; `ratified` is "somebody with standing has signed it off". The two are ordered, and the order
 *  is the whole rule: ratification satisfies a demand for a record, and nothing but ratification
 *  satisfies a demand for ratification. */
export type EvidenceStandard = "recorded" | "ratified";

/** The ordering, written once. A string comparison would put `ratified` below `recorded`
 *  alphabetically and be wrong in exactly the direction that admits an unratified step. */
const STANDING: Readonly<Record<EvidenceStandard, number>> = Object.freeze({ recorded: 1, ratified: 2 });

/** One kind of evidence at one standard. The same shape stands on both sides of the entry question
 *  — a contract's requirement is the standard demanded, a caller's holding is the standard reached —
 *  because they are the two halves of one comparison. */
export interface EvidenceStanding {
  readonly kind: string;
  readonly standard: EvidenceStandard;
}

/** A requirement discharged rather than met, and the ground it was discharged on.
 *
 *  It names one kind: a blanket waiver would discharge requirements its ground says nothing about.
 *  `ground` is not optional — it is the sentence a reader is owed when they ask why a step was
 *  entered without what its contract asked for. */
export interface EntryWaiver {
  readonly kind: string;
  readonly ground: string;
}

/** A requirement the caller did not meet, with what was demanded and what was actually held. `held`
 *  is null when nothing of that kind was offered at all, which is a different situation from
 *  evidence that exists and has not been ratified: a caller answers them differently — go and
 *  produce it, against go and get it signed. */
export interface UnmetRequirement {
  readonly kind: string;
  readonly required: EvidenceStandard;
  readonly held: EvidenceStandard | null;
}

/** Whether the entry requirements are satisfied, and on what. The admitted half carries the
 *  waivers it was granted on — empty when every requirement was met by evidence, which is how
 *  the two are told apart. */
export type EntryAdmission =
  | { readonly admitted: true; readonly waived: readonly EntryWaiver[] }
  | { readonly admitted: false; readonly unmet: readonly UnmetRequirement[] };

/**
 * May a step be entered, given what has been recorded.
 *
 * Exported rather than kept inside {@link createController} because it is a rule and not a handler:
 * it reads no state, names no step and holds nothing. A caller asking this question without an
 * execution to hang it on — a guard on a single write — would otherwise fabricate an identity, a
 * profile and a revision it has no use for, or keep a second copy of the rule.
 *
 * A waiver is read only where the requirement was not met: a waiver over evidence that was there
 * anyway would be recorded as the reason a step was entered when it was not the reason.
 */
export function admitEntry(
  required: readonly EvidenceStanding[],
  held: readonly EvidenceStanding[],
  waivers: readonly EntryWaiver[],
): EntryAdmission {
  // The strongest holding of each kind, not the last one offered. A caller listing the same kind
  // twice is describing one thing it knows two facts about.
  const strongest = new Map<string, EvidenceStandard>();
  for (const h of held) {
    const prior = strongest.get(h.kind);
    if (prior === undefined || STANDING[h.standard] > STANDING[prior]) strongest.set(h.kind, h.standard);
  }
  const grounds = new Map<string, EntryWaiver>();
  for (const w of waivers) if (!grounds.has(w.kind)) grounds.set(w.kind, w);

  const unmet: UnmetRequirement[] = [];
  const waived: EntryWaiver[] = [];
  for (const r of required) {
    const at = strongest.get(r.kind) ?? null;
    if (at !== null && STANDING[at] >= STANDING[r.standard]) continue;
    const ground = grounds.get(r.kind);
    if (ground) { waived.push(ground); continue; }
    unmet.push(Object.freeze({ kind: r.kind, required: r.standard, held: at }));
  }
  return unmet.length > 0
    ? Object.freeze({ admitted: false as const, unmet: Object.freeze(unmet) })
    : Object.freeze({ admitted: true as const, waived: Object.freeze(waived) });
}

/** One unmet requirement as a phrase, for the sentence a refusal carries. It says which of the two
 *  situations this is, so the caller does not have to re-derive it from the fields. */
const unmetPhrase = (u: UnmetRequirement): string =>
  u.held === null
    ? `${u.kind}, of which nothing is held`
    : `${u.kind} ${u.required}, and it is only ${u.held}`;

/** One step's bound contract, as the profile carries it. */
export interface StepContract {
  readonly step: string;
  readonly intendedChange: string;
  /** Evidence without which the step may not be entered, each at the standard it must reach. */
  readonly entryEvidence: readonly EvidenceStanding[];
  readonly gates: readonly string[];
}

/** The bound contracts one execution runs against, resolved above this layer. */
export interface ExecutionProfile {
  readonly profileRef: string;
  readonly steps: readonly StepContract[];
}

/** Which execution is calling, and which profile it was bound to. The second field is checked
 *  against the controller's own profile: an execution carrying another profile's ref is a
 *  binding that moved under a run in flight, which is refused rather than reconciled. */
export interface ExecutionIdentity {
  readonly executionRef: string;
  readonly profileRef: string;
}

export interface StageEntry {
  readonly identity: ExecutionIdentity;
  readonly step: string;
  readonly revision: number;
  /** The evidence the caller holds at entry, each at the standard it actually reaches. */
  readonly evidenceHeld: readonly EvidenceStanding[];
  /** Grounds on which this caller claims a requirement is discharged rather than met. Required and
   *  empty where none is claimed: this is the difference between a refusal and an entry. */
  readonly waivers: readonly EntryWaiver[];
}

export interface StageSettlement {
  readonly identity: ExecutionIdentity;
  readonly step: string;
  readonly revision: number;
  readonly evidence: readonly string[];
  readonly gaps: readonly string[];
  readonly gatesRecorded: boolean;
  readonly verification: readonly string[];
  readonly observed?: ObservedSignals;
  readonly audit?: AuditContext;
}

export type RefusalKind =
  | "unbound_profile"
  | "unknown_step"
  | "stale_revision"
  | "missing_entry_evidence";

/** Why the controller would not proceed, with the material the caller needs to fix it. Both
 *  `missingEvidence` and `currentRevision` are populated on every refusal — the first empty where it
 *  does not apply, the second always the truth about the control state. */
export interface StageRefusal {
  readonly kind: RefusalKind;
  readonly step: string;
  readonly missingEvidence: readonly string[];
  /** The same requirements as `missingEvidence`, with the standard each demanded and the standard
   *  actually held. `missingEvidence` is the kinds alone, for a caller that only wants to name them;
   *  this is for a caller that has to answer them. */
  readonly unmet: readonly UnmetRequirement[];
  readonly currentRevision: number;
  readonly detail: string;
}

export interface StageOutcome {
  readonly step: string;
  readonly intendedChange: string;
  readonly state: OutcomeState;
  readonly evidence: readonly string[];
  readonly unresolvedGaps: readonly string[];
  readonly verification: readonly string[];
  readonly readiness: ReadinessVerdict;
  /** The control state revision this outcome was written at. */
  readonly revision: number;
}

export type StageAdmission =
  | { readonly admitted: true; readonly contract: StepContract; readonly waived: readonly EntryWaiver[] }
  | { readonly admitted: false; readonly refusal: StageRefusal };

export type StageSettlementResult =
  | { readonly settled: true; readonly outcome: StageOutcome }
  | { readonly settled: false; readonly refusal: StageRefusal };

/** The control state as anybody outside may read it. */
export interface ControlState {
  readonly revision: number;
  readonly outcomes: readonly StageOutcome[];
}

export interface StageController {
  readonly profileRef: string;
  /** The step ids this profile bound, in declaration order. */
  readonly steps: readonly string[];
  admit(entry: StageEntry): StageAdmission;
  settle(settlement: StageSettlement): StageSettlementResult;
  state(): ControlState;
  outcomeOf(step: string): StageOutcome | null;
}

/**
 * A controller over one execution's bound contracts. `startingRevision` is a parameter rather than a
 * constant so a controller can be rebuilt over a control state that already exists — one that always
 * began at zero would hand a resumed run a revision every earlier caller has already seen.
 */
export function createController(
  profile: ExecutionProfile,
  startingRevision = 0,
): StageController {
  const contracts = new Map(profile.steps.map((s) => [s.step, s]));
  const outcomes = new Map<string, StageOutcome>();
  let revision = startingRevision;

  const refuse = (kind: RefusalKind, step: string, unmet: readonly UnmetRequirement[], detail: string): StageRefusal =>
    Object.freeze({
      kind,
      step,
      // Derived from `unmet`, never passed alongside it: two lists a caller could populate
      // independently are two lists that can disagree about which requirements were unmet.
      missingEvidence: Object.freeze(unmet.map((u) => u.kind)),
      unmet: Object.freeze([...unmet]),
      currentRevision: revision,
      detail,
    });

  /** Everything both entry points check before either does its own work: the binding, the
   *  step, and the revision — in that order, because a stale revision reported for a step this
   *  profile never bound would send a caller to reconcile a state that was never its problem. */
  const reconcile = (
    identity: ExecutionIdentity,
    step: string,
    atRevision: number,
  ): { readonly contract: StepContract } | { readonly refusal: StageRefusal } => {
    if (identity.profileRef !== profile.profileRef) {
      return {
        refusal: refuse("unbound_profile", step, [],
          `execution ${identity.executionRef} is bound to ${identity.profileRef}, and this ` +
          `controller runs ${profile.profileRef}`),
      };
    }
    const contract = contracts.get(step);
    if (!contract) {
      return { refusal: refuse("unknown_step", step, [], `${profile.profileRef} binds no contract for ${step}`) };
    }
    if (atRevision !== revision) {
      return {
        refusal: refuse("stale_revision", step, [],
          `the call was made against revision ${atRevision} and the control state is at ${revision}`),
      };
    }
    return { contract };
  };

  return Object.freeze({
    profileRef: profile.profileRef,
    steps: Object.freeze(profile.steps.map((s) => s.step)),

    admit(entry: StageEntry): StageAdmission {
      // NOT A TOOL: `reconcile` here is a local arrow function declared a few lines above, in a
      // package that sits below services/ and can reach no door at all — not `knowledge_reconcile`.
      const r = reconcile(entry.identity, entry.step, entry.revision);
      if ("refusal" in r) return Object.freeze({ admitted: false as const, refusal: r.refusal });
      // Through `admitEntry`, which is what every caller outside this module reaches too. A set
      // difference written here would be a second copy of the entry rule.
      const decision = admitEntry(r.contract.entryEvidence, entry.evidenceHeld, entry.waivers);
      if (!decision.admitted) {
        return Object.freeze({
          admitted: false as const,
          refusal: refuse("missing_entry_evidence", entry.step, decision.unmet,
            `${entry.step} may not be entered without ${decision.unmet.map(unmetPhrase).join(", ")}`),
        });
      }
      return Object.freeze({ admitted: true as const, contract: r.contract, waived: decision.waived });
    },

    settle(settlement: StageSettlement): StageSettlementResult {
      // NOT A TOOL: the same local verb as in `admit` above, for the same reason.
      const r = reconcile(settlement.identity, settlement.step, settlement.revision);
      if ("refusal" in r) return Object.freeze({ settled: false as const, refusal: r.refusal });

      const verdict = readiness({
        ...settlement.observed,
        ...settlement.audit,
        evidence: settlement.evidence,
        gaps: settlement.gaps,
        gatesRecorded: settlement.gatesRecorded,
      });

      const held = outcomes.get(settlement.step);
      const state: OutcomeState = verdict.advance
        ? "established"
        : held?.state === "established" ? "needs_revisit" : "not_established";

      revision += 1;
      const outcome: StageOutcome = Object.freeze({
        step: settlement.step,
        intendedChange: r.contract.intendedChange,
        state,
        evidence: Object.freeze([...settlement.evidence]),
        unresolvedGaps: Object.freeze([...settlement.gaps]),
        verification: Object.freeze([...settlement.verification]),
        readiness: verdict,
        revision,
      });
      outcomes.set(settlement.step, outcome);
      return Object.freeze({ settled: true as const, outcome });
    },

    state(): ControlState {
      return Object.freeze({
        revision,
        outcomes: Object.freeze(profile.steps
          .map((s) => outcomes.get(s.step))
          .filter((o): o is StageOutcome => o !== undefined)),
      });
    },

    outcomeOf(step: string): StageOutcome | null {
      return outcomes.get(step) ?? null;
    },
  });
}
