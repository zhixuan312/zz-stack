/**
 * THE COMPARISON DESIGN, AND THE PERMISSION IT DOES NOT CARRY.
 *
 * This module holds an instantiated evaluation protocol for the assessor question: three arms,
 * a pinned case inventory, tolerances, a sample-adequacy rule, and the separation between the
 * development and held-out sets. What it does NOT hold is a single measurement, because none
 * has been taken. Every arm is unrun. Every tolerance is unset. The honest shape of that is a
 * protocol that may be DRAFTED and may not be ACTIVATED, and the asymmetry is the whole point:
 * writing the procedure down is how you find out what you have not decided, and it needs no
 * permission. Running it produces numbers people will act on, and that does.
 *
 * SO `activationAllowed` IS DERIVED, NEVER STORED. {@link activationBlockers} enumerates every
 * reason the protocol may not run, and the flag is the emptiness of that list. A field somebody
 * could set to true is a field somebody will set to true; a derived one has to be earned by
 * closing each gap, and the gaps are named rather than counted so that closing them is work
 * somebody can actually pick up. `draftingAllowed` is the constant `true` beside it, which is
 * not an oversight — nothing in this file may ever block writing the procedure.
 *
 * ARM A IS THE ACTUAL LEGACY METHOD, AND THAT IS A CLAIM THIS MODULE CHECKS RATHER THAN MAKES.
 * The oldest way to rig a three-arm comparison is to implement the incumbent yourself, badly,
 * and beat it. Nothing downstream can see that: the table looks the same either way. So
 * {@link EvalArm.isStrawman} is COMPUTED, by comparing what each arm is described as doing
 * against the method it claims to instantiate — capabilities omitted, a smaller attempt budget,
 * a different case set, a different cutoff, different evidence access. Any of those and the arm
 * `departs`, which is what `isStrawman` reports.
 *
 * AND THE THIRD STATE MATTERS AS MUCH AS THE OTHER TWO. An arm whose baseline nobody has
 * recorded is not faithful and is not rigged: it is `undetermined`, and `isStrawman` is false
 * because claiming otherwise would accuse a design nobody has written down yet. Undetermined
 * blocks activation exactly like a departure does, so the honest-but-unverifiable case cannot
 * quietly become the case that runs. Arm A is in that state today, deliberately: the legacy
 * assessment path has not been pinned to a reference in this repository, and inventing one
 * would be the same fabrication as inventing a number.
 *
 * A NEGATIVE IS A RESULT. {@link conclude} can return `negative`, which disables the assessment
 * branch and expressly preserves the independent-review path — the point being that failing to
 * qualify an assessor removes an option and takes nothing else away. What it must never return
 * is `eligible` on absent numbers, and it cannot: an unrun arm makes the finding `inconclusive`
 * before any tolerance is consulted.
 */
import {
  eligibilityOf, sliceAdequacy, sliceKey,
  type Adequacy, type EvalCase, type EvalSlice,
} from "./eval-case.js";
import { costOf, type CostEstimate } from "./eval-cost.js";

/** A, the actual legacy method; B, the improved shared method under a separately attributed
 *  general-model assessor; C, the same loop under the candidate specialist. Three, because two
 *  cannot tell an improvement in the METHOD apart from an improvement in the MODEL. */
export type ArmId = "A" | "B" | "C";

/** What a method does, in the terms an arm can be compared against. Every field is nullable
 *  because every one of them is genuinely undecided for at least one arm today, and a decided
 *  value standing in for an undecided one is the defect this whole module is built around. */
export interface MethodDescription {
  /** Where the method actually is. `null` is a method nobody has pinned a reference for. */
  readonly method_ref: string | null;
  readonly capabilities: readonly string[];
  readonly attempt_budget: number | null;
  readonly case_set_ref: string | null;
  readonly cutoff_policy: string | null;
  readonly evidence_access: string | null;
}

/** One arm as it is declared, before anything is derived from it. */
export interface ArmSpec {
  readonly id: ArmId;
  readonly label: string;
  /** Which backends this arm's usage and cost are charged to. Separate attribution is what
   *  makes B and C comparable on price at all: a shared account cannot tell them apart. */
  readonly attributed_to: readonly string[];
  readonly described: MethodDescription;
  /** The method this arm claims to be a faithful instance of. `null` means nobody has recorded
   *  one, which is a gap rather than an endorsement. */
  readonly baseline: MethodDescription | null;
}

/** Whether the arm was shown to be a faithful instance of what it claims to instantiate. */
export type Faithfulness = "no_departure_found" | "departs" | "undetermined";

/** An arm with the faithfulness verdict derived. `isStrawman` is exactly
 *  `faithfulness === "departs"` — a demonstrated weakening, never a suspicion and never a
 *  field somebody wrote down. */
export interface EvalArm extends ArmSpec {
  readonly faithfulness: Faithfulness;
  readonly isStrawman: boolean;
  /** Ways the arm is weaker than the method it instantiates. */
  readonly departures: readonly string[];
  /** Dimensions neither side records, so faithfulness could not be decided on them. */
  readonly unchecked: readonly string[];
}

/** A tolerance the measurement has to clear. `value: null` is a tolerance nobody has set, and
 *  it blocks activation — you cannot pass a bar that does not exist, and a bar invented to
 *  make a protocol runnable is a bar chosen to be cleared. */
export interface Limit {
  readonly metric: string;
  readonly direction: "at_least" | "at_most";
  readonly value: number | null;
  readonly unit: string;
  /** Who set it. `null` alongside a non-null value would be a number with no owner. */
  readonly set_by: string | null;
}

/** The pinned inventory. `enumerated` false is a manifest pinned by reference whose cases have
 *  not been written out — the state today, and one that blocks activation because a protocol
 *  cannot have denominators it has never counted. */
export interface CaseInventory {
  readonly inventory_ref: string;
  readonly digest: string | null;
  readonly enumerated: boolean;
  readonly cases: readonly EvalCase[];
}

/** Everything a protocol is declared with, before the three derived fields. */
export interface ProtocolDraft {
  readonly protocol_id: string;
  readonly inventory: CaseInventory;
  readonly arms: readonly ArmSpec[];
  readonly limits: readonly Limit[];
  readonly dev_initiative_ids: readonly string[];
  readonly heldout_initiative_ids: readonly string[];
  readonly sample_adequacy_rule_ref: string | null;
  readonly owner_approval_ref: string | null;
}

/** A draft plus what follows from it. The three derived fields are the only ones a reader
 *  should consult to decide whether the measurement may be taken. */
export interface EvaluationProtocol extends ProtocolDraft {
  readonly draftingAllowed: boolean;
  readonly activationAllowed: boolean;
  readonly activation_blockers: readonly string[];
}

// ── what makes an arm a strawman ───────────────────────────────────────────────────────────

const DIMENSIONS = ["case_set_ref", "cutoff_policy", "evidence_access"] as const;

function compare(described: MethodDescription, baseline: MethodDescription): {
  departures: string[];
  unchecked: string[];
} {
  const departures: string[] = [];
  const unchecked: string[] = [];

  for (const capability of baseline.capabilities) {
    if (!described.capabilities.includes(capability)) departures.push(`omits ${capability}`);
  }
  if (baseline.attempt_budget === null || described.attempt_budget === null) {
    unchecked.push("attempt_budget");
  } else if (described.attempt_budget < baseline.attempt_budget) {
    departures.push(
      `runs on ${described.attempt_budget} attempts where the method it instantiates gets ${baseline.attempt_budget}`);
  }
  // THE THREE WAYS TO RIG AN ARM WITHOUT TOUCHING ITS CAPABILITIES: measure it on different
  // cases, judge it to a different cutoff, or give it different evidence. Each reads as a
  // configuration detail and each decides the comparison on its own.
  for (const dimension of DIMENSIONS) {
    const mine = described[dimension];
    const theirs = baseline[dimension];
    if (mine === null || theirs === null) unchecked.push(dimension);
    else if (mine !== theirs) departures.push(`${dimension} is "${mine}" against "${theirs}"`);
  }
  return { departures, unchecked };
}

/**
 * The arms with their faithfulness derived.
 *
 * `undetermined` wins over `no_departure_found` whenever anything could not be compared, which
 * is the conservative direction: an arm nobody could check is not an arm that passed.
 */
export function armsOf(p: EvaluationProtocol): readonly EvalArm[] {
  return Object.freeze(p.arms.map((arm): EvalArm => {
    if (!arm.baseline || arm.described.method_ref === null) {
      const missing = !arm.baseline
        ? "no baseline method is recorded for it"
        : "it points at no method reference";
      return Object.freeze({
        ...arm,
        faithfulness: "undetermined" as const,
        isStrawman: false,
        departures: Object.freeze([]),
        unchecked: Object.freeze([`the whole arm, because ${missing}`]),
      });
    }
    const { departures, unchecked } = compare(arm.described, arm.baseline);
    const faithfulness: Faithfulness =
      departures.length ? "departs" : unchecked.length ? "undetermined" : "no_departure_found";
    return Object.freeze({
      ...arm,
      faithfulness,
      isStrawman: faithfulness === "departs",
      departures: Object.freeze(departures),
      unchecked: Object.freeze(unchecked),
    });
  }));
}

// ── when the measurement may be taken ──────────────────────────────────────────────────────

/**
 * WHETHER THE HELD-OUT SET IS ACTUALLY HELD OUT, checked against the cases rather than against
 * the two lists.
 *
 * Comparing the lists to each other catches a typo and nothing else. The separation the split
 * exists for is a property of the CASES, and it has two halves, both of which have to hold:
 *
 *   · BY INITIATIVE. Every case belongs to exactly one side. A case whose initiative is in
 *     neither list is in no set and would be counted by whichever loop reached it first; a case
 *     whose initiative is in both is held out and tuned against at once, which is the failure
 *     with the lists agreeing that nothing is wrong.
 *   · BY TIME. Held-out work must come AFTER development work, because a method tuned on later
 *     cases and measured on earlier ones is measured on material its own design has already
 *     seen the shape of. Interleaved cutoffs look like a clean split in a list of ids and are
 *     not one.
 *
 * NOTHING IS CHECKED UNTIL THE INVENTORY IS ENUMERATED, because until then there are no cases
 * to check and silence here is not a pass — the unenumerated inventory is its own blocker.
 */
function separationBlockers(draft: ProtocolDraft): string[] {
  if (!draft.inventory.enumerated) return [];
  const dev = new Set(draft.dev_initiative_ids);
  const held = new Set(draft.heldout_initiative_ids);
  const stray = new Set<string>();
  const devCutoffs: string[] = [];
  const heldCutoffs: string[] = [];
  for (const evalCase of draft.inventory.cases) {
    const inDev = dev.has(evalCase.initiative_id);
    const inHeld = held.has(evalCase.initiative_id);
    if (inDev === inHeld) stray.add(evalCase.initiative_id);
    else if (inDev) devCutoffs.push(evalCase.cutoff);
    else heldCutoffs.push(evalCase.cutoff);
  }
  const blockers: string[] = [];
  if (stray.size) {
    blockers.push(
      `initiative(s) ${[...stray].join(", ")} carry cases and belong to neither set or to both, ` +
      "so those cases cannot be told held out from development");
  }
  if (devCutoffs.length && heldCutoffs.length) {
    const latestDev = devCutoffs.reduce((a, b) => (a > b ? a : b));
    const earliestHeld = heldCutoffs.reduce((a, b) => (a < b ? a : b));
    if (earliestHeld <= latestDev) {
      blockers.push(
        `the split is not time-separated: the earliest held-out cutoff ${earliestHeld} is not ` +
        `after the latest development cutoff ${latestDev}`);
    }
  }
  return blockers;
}

/** Every reason the protocol may not run, named rather than counted. An empty list is the only
 *  thing that makes {@link EvaluationProtocol.activationAllowed} true. Module-private: the
 *  list it returns is carried on the protocol as `activation_blockers`, and a second way to
 *  ask the same question is a second answer waiting to disagree with the first. */
function activationBlockers(draft: ProtocolDraft, arms: readonly EvalArm[]): readonly string[] {
  const blockers: string[] = [];

  for (const limit of draft.limits) {
    if (limit.value === null) blockers.push(`no tolerance is set for ${limit.metric}`);
    else if (limit.set_by === null) blockers.push(`the tolerance for ${limit.metric} has a value and no owner`);
  }
  if (!draft.sample_adequacy_rule_ref) {
    blockers.push("no sample-adequacy rule is pinned, so no slice can be called big enough to conclude from");
  }
  if (!draft.owner_approval_ref) blockers.push("no owner approval of this protocol is recorded");
  if (!draft.inventory.enumerated) {
    blockers.push(`the case inventory ${draft.inventory.inventory_ref} is pinned by reference and not enumerated, so no slice has a denominator`);
  }
  if (!draft.dev_initiative_ids.length) blockers.push("the development set is not pinned to any initiative");
  if (!draft.heldout_initiative_ids.length) blockers.push("the held-out set is not pinned to any initiative");

  const overlap = draft.dev_initiative_ids.filter((id) => draft.heldout_initiative_ids.includes(id));
  if (overlap.length) {
    blockers.push(`${overlap.join(", ")} appears in both the development and held-out sets, so the held-out set is not held out`);
  }
  blockers.push(...separationBlockers(draft));
  const ids = arms.map((a) => a.id).sort();
  if (ids.join(",") !== "A,B,C") blockers.push(`the arms are ${ids.join(", ") || "none"}; A, B and C are all required`);
  for (const arm of arms) {
    if (arm.isStrawman) blockers.push(`arm ${arm.id} departs from the method it instantiates: ${arm.departures.join("; ")}`);
    if (arm.faithfulness === "undetermined") {
      blockers.push(`arm ${arm.id}'s faithfulness is undetermined (${arm.unchecked.join(", ")})`);
    }
  }
  return Object.freeze(blockers);
}

/** Turns a draft into a protocol by deriving the two permissions. The only constructor; there
 *  is no path by which a caller hands in `activationAllowed` ready-made. */
export function assembleProtocol(draft: ProtocolDraft): EvaluationProtocol {
  const provisional: EvaluationProtocol = Object.freeze({
    ...draft, draftingAllowed: true, activationAllowed: false, activation_blockers: Object.freeze([]),
  });
  const blockers = activationBlockers(draft, armsOf(provisional));
  return Object.freeze({
    ...draft,
    // NOTHING BLOCKS WRITING THE PROCEDURE DOWN. Discovering what is undecided is the work
    // drafting does, and gating it behind the decisions it exists to surface is a deadlock.
    draftingAllowed: true,
    activationAllowed: blockers.length === 0,
    activation_blockers: blockers,
  });
}

/**
 * Moving a held-out initiative into the development set, which is what reusing one to tune
 * against actually IS.
 *
 * A held-out set read once is a measurement. Read twice, with anything changed in between, it
 * is a development set wearing the first read's authority — and the change need not be a code
 * change: choosing a threshold because of what the first read showed is tuning. So this does
 * not "allow" a reuse, it RECORDS one, by returning a protocol in which that initiative is a
 * development initiative and the permissions have been re-derived. The held-out set that
 * remains is whatever is genuinely left.
 */
export function reuseHeldOutForTuning(p: EvaluationProtocol, initiativeId: string): EvaluationProtocol {
  return assembleProtocol({
    ...p,
    dev_initiative_ids: Object.freeze([...new Set([...p.dev_initiative_ids, initiativeId])]),
    heldout_initiative_ids: Object.freeze(p.heldout_initiative_ids.filter((id) => id !== initiativeId)),
  });
}

// ── what the arms produced, and what may be concluded from it ──────────────────────────────

/** One arm's result in one slice. `measured` is the only state in which the numbers mean
 *  anything, and every number beside it is nullable so that `not_run` is not spelled `0`. */
export interface ArmSliceOutcome {
  readonly arm_id: ArmId;
  readonly slice: EvalSlice;
  readonly slice_key: string;
  /** Eligible cases in this slice. `null` when the inventory has not been enumerated. */
  readonly denominator: number | null;
  readonly successes: number | null;
  readonly rate: number | null;
  /** The uncertainty on `rate`, as an interval. Null while nothing has been measured — a
   *  point estimate with no interval is a claim of certainty nobody earned. */
  readonly interval: readonly [number, number] | null;
  readonly state: "not_run" | "measured";
  readonly adequacy: Adequacy;
  readonly adequacy_reason: string;
  readonly cost: CostEstimate;
}

/**
 * The per-arm, per-slice table, with denominators drawn from the pinned inventory and every
 * measured quantity left null.
 *
 * NO ROW IS INVENTED AND NO ROW IS OMITTED. A slice present in the inventory gets a row for
 * every arm, including arms that have not run, because a table that silently drops unrun arms
 * is a table whose reader cannot tell a missing arm from a missing slice. The cost on each row
 * is `costOf({})` — unknown, not zero — until a real backend account replaces it.
 */
export function outcomesOf(p: EvaluationProtocol): readonly ArmSliceOutcome[] {
  const census = new Map<string, { slice: EvalSlice; eligible: number }>();
  for (const evalCase of p.inventory.cases) {
    const key = sliceKey(evalCase.slice);
    const seen = census.get(key) ?? { slice: evalCase.slice, eligible: 0 };
    if (eligibilityOf(evalCase).eligible) seen.eligible += 1;
    census.set(key, seen);
  }
  const agreement = p.limits.find((l) => l.metric === AGREEMENT_METRIC)?.value ?? null;
  const rows: ArmSliceOutcome[] = [];
  for (const arm of p.arms) {
    for (const [key, { slice, eligible }] of census) {
      // A DENOMINATOR ONLY EXISTS ONCE THE CASES DO. An unenumerated inventory yields null
      // here rather than the zero a `.length` on an empty list would hand back, because zero
      // eligible cases and no count at all lead to opposite decisions.
      const denominator = p.inventory.enumerated ? eligible : null;
      const adequacy = sliceAdequacy(denominator, agreement);
      rows.push(Object.freeze({
        arm_id: arm.id,
        slice,
        slice_key: key,
        denominator,
        successes: null,
        rate: null,
        interval: null,
        state: "not_run" as const,
        adequacy: adequacy.adequacy,
        adequacy_reason: adequacy.reason,
        cost: costOf({}),
      }));
    }
  }
  return Object.freeze(rows);
}

/** The metric the sample-adequacy rule is sized against: how often an arm's answer matches the
 *  adjudicated label. Named once, here, because `outcomesOf` and the protocol's own limit list
 *  would otherwise agree only by coincidence. */
export const AGREEMENT_METRIC = "agreement_with_adjudicated_labels";

/** What the evaluation found. `negative` is a finding; `inconclusive` is the absence of one. */
export type ConclusionKind = "eligible" | "negative" | "inconclusive";

/** The eligibility record, or the honest negative, or the honest neither.
 *
 *  `preserved_path` is on every conclusion rather than only on the negative, because the fact
 *  that independent review survives a failed assessor is not a consolation to add when the news
 *  is bad — it is a property of the design, true in all three cases. */
export interface Conclusion {
  readonly kind: ConclusionKind;
  readonly reasons: readonly string[];
  /** True only for a negative: the assessment branch stops being an option. */
  readonly disables_assessment_branch: boolean;
  readonly preserved_path: string;
}

/**
 * Reads the table and says what may be concluded from it.
 *
 * ORDER IS THE ARGUMENT. Activation blockers are consulted before any outcome, and an unrun
 * arm before any tolerance, so there is no path on which a tolerance is compared against a
 * number that does not exist. An `eligible` verdict is reachable only from a table in which
 * every row is measured and every adequate slice clears its bar.
 */
export function conclude(p: EvaluationProtocol, outcomes: readonly ArmSliceOutcome[]): Conclusion {
  const preserved_path = "independent_review";
  if (!p.activationAllowed) {
    return Object.freeze({
      kind: "inconclusive" as const,
      reasons: Object.freeze([
        "the protocol was never activated, so no arm ran and there is nothing to conclude from",
        ...p.activation_blockers,
      ]),
      disables_assessment_branch: false,
      preserved_path,
    });
  }
  const unrun = outcomes.filter((o) => o.state === "not_run");
  if (!outcomes.length || unrun.length) {
    return Object.freeze({
      kind: "inconclusive" as const,
      reasons: Object.freeze(outcomes.length
        ? [`${unrun.length} of ${outcomes.length} arm-slice cells have not been measured`]
        : ["the outcome table is empty, so no arm has produced a result"]),
      disables_assessment_branch: false,
      preserved_path,
    });
  }
  const usable = outcomes.filter((o) => o.adequacy === "adequate");
  if (!usable.length) {
    return Object.freeze({
      kind: "inconclusive" as const,
      reasons: Object.freeze(["every measured slice is underpowered or empty, so no slice supports a verdict"]),
      disables_assessment_branch: false,
      preserved_path,
    });
  }
  const bar = p.limits.find((l) => l.metric === AGREEMENT_METRIC)?.value ?? null;
  const missed = bar === null ? [] : usable.filter((o) => o.rate !== null && o.rate < bar);
  if (missed.length) {
    return Object.freeze({
      kind: "negative" as const,
      reasons: Object.freeze(missed.map((o) =>
        `${o.arm_id} scored ${o.rate} against a tolerance of ${bar} on ${o.slice_key} (n=${o.denominator})`)),
      disables_assessment_branch: true,
      preserved_path,
    });
  }
  return Object.freeze({
    kind: "eligible" as const,
    reasons: Object.freeze([`every one of ${usable.length} adequately powered slices cleared ${bar}`]),
    disables_assessment_branch: false,
    preserved_path,
  });
}
