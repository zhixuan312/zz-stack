/**
 * ONE CONTROLLER FOR EVERY STEP A FLOW DECLARES, and the reason there is only one.
 *
 * A flow's steps are declared in its own catalog entry, and each of them binds a contract: what
 * the step is meant to change, what evidence it may not be entered without, and which gates it
 * is subject to. The temptation is a resolver per step, because each step really does have its
 * own contract — and what that buys is seven places for the rule to be slightly different, of
 * which six are read by nobody until the day one of them lets a step through on a default.
 *
 * So the profile is DATA and this module is the one path through it. {@link createController}
 * is handed an {@link ExecutionProfile} — the bound contracts, resolved above this layer from
 * whatever the flow declared — and every step resolves its contract, reconciles against the
 * control state and settles its outcome through the same three functions. This module cannot
 * name a step; it has no list, and the only step ids it ever sees are the ones in the profile
 * it was handed. That is what keeps the kernel generic, and it is also why the number of steps
 * a flow has is a fact about that flow's declaration and never a constant here.
 *
 * THE CONTROL STATE IS RECONCILED, NOT ASSUMED — and it is the control state alone that
 * carries a revision here. What a step produced enters as evidence and verification REFS,
 * which this module records and never versions: the documents they point at are versioned
 * where they live, and a second revision counter here would be a copy free to disagree with
 * the first. An entry or a settlement carries the control revision its caller last saw. If the control state has moved on, the call is
 * REFUSED and the refusal carries the current revision — it does not proceed against whatever
 * the controller happens to hold now, and it does not silently re-read. The whole class of
 * defect here is a second writer whose work is overwritten by a first writer that never
 * noticed it existed.
 *
 * ENTRY EVIDENCE IS RETURNED, NOT DEFAULTED. A step entered without the evidence its contract
 * requires comes back with the missing kinds named. The alternative — entering anyway on an
 * empty default and discovering downstream that the ground was never established — is the
 * failure this refusal exists for, and it is worse than refusing because the work that follows
 * looks exactly like work that had its ground.
 *
 * `needs_revisit` IS COMPUTED, never set. A step that was established and is settled again
 * with a gap open is a step whose outcome no longer holds, and the controller says so from the
 * prior outcome it already holds rather than from a caller's opinion of its own state.
 */
import { readiness, type AuditContext, type ObservedSignals, type ReadinessVerdict } from "./readiness.js";

/** Where a step's intended change stands. `not_established` is the state a step starts in and
 *  returns to nothing from; `needs_revisit` is reserved for an outcome that DID hold and has
 *  stopped holding, because losing that distinction loses the reason to look again. */
export type OutcomeState = "not_established" | "established" | "needs_revisit";

/** One step's bound contract, as the profile carries it. */
export interface StepContract {
  readonly step: string;
  readonly intendedChange: string;
  /** Evidence kinds without which the step may not be entered. */
  readonly entryEvidence: readonly string[];
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
  /** The evidence kinds the caller holds at entry. */
  readonly evidenceHeld: readonly string[];
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
 *  `missingEvidence` and `currentRevision` are populated on every refusal — the first is empty
 *  where it does not apply, and the second is always the truth about the control state, so a
 *  caller reconciling after a refusal never has to guess which of them it may trust. */
export interface StageRefusal {
  readonly kind: RefusalKind;
  readonly step: string;
  readonly missingEvidence: readonly string[];
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
  | { readonly admitted: true; readonly contract: StepContract }
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
 * A controller over one execution's bound contracts.
 *
 * `startingRevision` is a parameter rather than a constant so a controller can be rebuilt over
 * a control state that already exists — a run resumed is not a run started, and a controller
 * that always began at zero would hand a resumed run a revision every earlier caller has
 * already seen.
 */
export function createController(
  profile: ExecutionProfile,
  startingRevision = 0,
): StageController {
  const contracts = new Map(profile.steps.map((s) => [s.step, s]));
  const outcomes = new Map<string, StageOutcome>();
  let revision = startingRevision;

  const refuse = (kind: RefusalKind, step: string, missing: readonly string[], detail: string): StageRefusal =>
    Object.freeze({
      kind,
      step,
      missingEvidence: Object.freeze([...missing]),
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
      // NOT A TOOL: `reconcile` here is the English verb this task's own Output line uses —
      // settling an execution's binding, step and revision against the control state — and it
      // is a local arrow function declared a few lines above, in a package that sits below
      // services/ and can reach no door at all. The platform tool once called that is
      // `knowledge_reconcile` now, and it has nothing to do with this.
      const r = reconcile(entry.identity, entry.step, entry.revision);
      if ("refusal" in r) return Object.freeze({ admitted: false as const, refusal: r.refusal });
      const held = new Set(entry.evidenceHeld);
      const missing = r.contract.entryEvidence.filter((k) => !held.has(k));
      if (missing.length > 0) {
        return Object.freeze({
          admitted: false as const,
          refusal: refuse("missing_entry_evidence", entry.step, missing,
            `${entry.step} may not be entered without ${missing.join(", ")}`),
        });
      }
      return Object.freeze({ admitted: true as const, contract: r.contract });
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
