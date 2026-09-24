/**
 * Planting a fault under every flag that is asserted false, and watching it fire.
 *
 * Three flags in this subject area are checked by asserting they are false — nothing was
 * collapsed, nothing was invented, nothing deadlocks — and `return false` satisfies all three
 * forever, as does a detector computed from the same table as the decision it audits. So each
 * flag is exercised twice: once on a healthy subject, where it must stay silent, and once with
 * a fault planted, where it must fire. A row whose `fires` is false is a finding about the
 * detector, never about its subject.
 *
 * The healthy column carries weight: most answers here are refusals, and a router that refused
 * everything would satisfy every faulted column. It is what shows the six gap kinds reach work,
 * that a gap with a permitted action gets that action rather than a pause, and that a
 * correction with an ordinary precondition is not called a deadlock.
 *
 * Where a fault cannot be planted through the front door it is planted at the audit: the router
 * copies the gap's own authority ref and cannot mint one, so the mint detector is shown firing
 * on a hand-built plan carrying a ref its gap never held. The coverage rows are the same — the
 * collapse the flag catches is a plan missing a unit, so the faulted plans are built by hand.
 *
 * Nothing here is a measurement. Every ref, target and precondition below is invented for the
 * table.
 */
import {
  authorityMintAudit,
  citationAudit,
  coverageAudit,
  deadlockAudit,
  type Covered,
} from "./gap-audit.js";
import {
  ACTION_CONTRACTS,
  ACTION_KINDS,
  GAP_KINDS,
  routeGap,
  type ActionKind,
  type Gap,
} from "./gap-routing.js";
import { bootstrap, correctiveReturn, reviewClose } from "./stage-progression.js";

/** One detector, watched on a healthy subject and on a faulted one. `fires` is true only when
 *  it stayed silent on the first and spoke on the second — either half failing makes the
 *  detector worthless, and for opposite reasons. */
export interface GapRoutingProbeRow {
  readonly detector: string;
  readonly healthy: string;
  readonly faulted: string;
  readonly fires: boolean;
}

const row = (
  detector: string,
  healthy: [boolean, string],
  faulted: [boolean, string],
): GapRoutingProbeRow => Object.freeze({
  detector,
  healthy: `${healthy[0] ? "silent" : "MISFIRED"} — ${healthy[1]}`,
  faulted: `${faulted[0] ? "fires" : "MISSED"} — ${faulted[1]}`,
  fires: healthy[0] && faulted[0],
});

// Fixtures

const ALPHA = "target://alpha";
const BETA = "target://beta";
const INVENTED_PRIOR = "outcome://never-produced";

/** A gap carrying two kinds at once, which is the case a binary collapse destroys. */
const TWO_KINDS: Gap = Object.freeze({
  kinds: Object.freeze(["fact", "authority"]),
  gapIds: Object.freeze(["gap://f", "gap://a"]),
  blockedTargets: Object.freeze([ALPHA]),
});

const coveredOf = (kinds: readonly string[], ids: readonly string[]): Covered =>
  Object.freeze({ kinds: Object.freeze([...kinds]), ids: Object.freeze([...ids]) });

// Rows

/** The two ways a plan collapses, and the two independent signals that catch them. */
function collapseRows(): GapRoutingProbeRow[] {
  const healthy = routeGap(TWO_KINDS);
  const demand = { kinds: TWO_KINDS.kinds, ids: TWO_KINDS.gapIds ?? [] };

  // Fault 1: a unit dropped. The plan answers the fact and forgets the authority.
  const dropped = coverageAudit(demand, [coveredOf(["fact"], ["gap://f", "gap://a"])]);

  // Fault 2: nothing dropped as far as the labels go — one unit stamped with both kinds, which
  // is what a planner that collapsed to a single action would produce if it labelled honestly.
  // A label-only audit passes this; the count comparison does not.
  const relabelled = coverageAudit(demand, [coveredOf(["fact", "authority"], ["gap://f", "gap://a"])]);

  return [
    row("collapsedToOne — a demand kind answered by nothing",
      [!healthy.collapsedToOne,
        `two coexisting kinds routed to ${healthy.actions.map((a) => a.kind).join(" + ")}, ` +
        `${healthy.actions.length} units for ${new Set(TWO_KINDS.kinds).size} kinds`],
      [dropped.collapsedToOne, `${dropped.signals.join("; ")}`]),
    row("collapsedToOne — one unit wearing every label (the audit must not trust the label)",
      [!healthy.collapsedToOne, "the honest plan carries one kind per unit and passes both signals"],
      [relabelled.collapsedToOne,
        `labels covered every kind and the count still spoke: ${relabelled.signals.join("; ")}`]),
  ];
}

/** Invented prior ground, in the field named for it and in the fields that are not. */
function inventionRows(): GapRoutingProbeRow[] {
  const healthy = bootstrap();
  const citedFault = bootstrap({ citedPriorOutcomes: [INVENTED_PRIOR] });
  // The realistic bug: nothing cites a prior outcome, the first action is simply pointed at an
  // artifact nobody produced. An audit reading only `citedPriorOutcomes` never sees it.
  const targetFault = bootstrap({
    openingGap: { kinds: ["fact"], gapIds: ["gap://opening"], blockedTargets: [INVENTED_PRIOR] },
  });
  // The subtlest of the three: the invented ref arrives as the artifact a targeted revision is
  // pointed at, a field the citation walk only reaches because the router puts it on the
  // action's target ids rather than leaving it in the gap.
  const revisionFault = bootstrap({
    openingGap: { kinds: ["fact"], gapIds: ["gap://opening"], againstProducedRef: INVENTED_PRIOR },
  });
  const evidenceFault = bootstrap({
    openingGap: { kinds: ["fact"], gapIds: ["gap://opening"], evidenceIds: [INVENTED_PRIOR] },
  });
  return [
    row("inventedPriorOutcome — a citation to ground nobody established",
      [!healthy.inventedPriorOutcome,
        `the opening objective cites nothing and opens with ${healthy.firstAction.kind}`],
      [citedFault.inventedPriorOutcome, `fabricated: ${citedFault.fabricatedRefs.join(", ")}`]),
    row("inventedPriorOutcome — a first action pointed at an artifact nobody produced",
      [!healthy.inventedPriorOutcome, "every ref the healthy result carries is one it minted itself"],
      [targetFault.inventedPriorOutcome,
        `no citation field was touched; the target id gave it away: ${targetFault.fabricatedRefs.join(", ")}`]),
    row("inventedPriorOutcome — an opening that revises an artifact nobody produced",
      [!healthy.inventedPriorOutcome && healthy.firstAction.kind === "investigate",
        "the healthy opening investigates an open question and revises nothing"],
      [revisionFault.inventedPriorOutcome && revisionFault.firstAction.kind === "revise-targeted",
        `routed to a targeted revision of ${revisionFault.fabricatedRefs.join(", ")}, which exists nowhere`]),
    row("inventedPriorOutcome — evidence claimed as already held at a bootstrap",
      [!healthy.inventedPriorOutcome, "the healthy opening holds no evidence, because nothing has run"],
      [evidenceFault.inventedPriorOutcome,
        `evidence claimed at an empty control state: ${evidenceFault.fabricatedRefs.join(", ")}`]),
  ];
}

/** The two fields all three transitions report a deadlock through. Named so the three can be
 *  put in one table without a union that says less than either half. */
interface DeadlockReport {
  readonly requiresForwardProgressFirst: boolean;
  readonly deadlockedOn: readonly string[];
}

/** The circular permission deadlock, at each of the three transitions that invite it. */
function deadlockRows(): GapRoutingProbeRow[] {
  const boot = bootstrap();
  const bootFault = bootstrap({
    preconditions: [{ subject: "objective://first", demands: "granted" }],
  });
  const corr = correctiveReturn();
  const corrFault = correctiveReturn({
    preconditions: [{ subject: "target://corrected", demands: "established" }],
  });
  const close = reviewClose();
  const closeFault = reviewClose({
    preconditions: [{ subject: "objective://first", demands: "established" }],
  });
  const cases: readonly [string, DeadlockReport, DeadlockReport][] = [
    ["at bootstrap", boot, bootFault],
    ["at a corrective return", corr, corrFault],
    ["at a close grant", close, closeFault],
  ];
  return cases.map(([where, ok, bad]) => row(
    `requiresForwardProgressFirst ${where}`,
    [!ok.requiresForwardProgressFirst,
      "one ordinary precondition examined and none of it demands the transition's own result"],
    [bad.requiresForwardProgressFirst, bad.deadlockedOn.join("; ")]));
}

/** Readiness computed on ground a correction moved, and whether it was actually invalidated. */
function invalidationRows(): GapRoutingProbeRow[] {
  const healthy = correctiveReturn();
  // Fault: the grant edits the upstream target and invalidates nothing, leaving a readiness
  // verdict standing on material that has changed underneath it.
  const fault = correctiveReturn({ invalidates: [] });
  return [row("invalidatesDependentReadiness — a verdict left standing on moved ground",
    [healthy.invalidatesDependentReadiness,
      `${healthy.invalidated.join(", ")} fell with the bounded edit to ${healthy.boundedEdits.join(", ")}`],
    [!fault.invalidatesDependentReadiness, `left standing: ${fault.leftStanding.join(", ")}`])];
}

/** Semantic selection of work must never arrive carrying permission to do it. */
function authorityRows(): GapRoutingProbeRow[] {
  const healthy = bootstrap();
  const asserted = bootstrap({
    openingGap: { kinds: ["fact"], gapIds: ["gap://opening"], authorityRefs: ["auth://not-held"] },
    authorityRefs: [],
  });
  // The router copies the gap's own ref and can mint nothing, so the front door cannot produce
  // the fault at all. Planted at the audit instead, in the shape it would meet if it could.
  const handBuilt = authorityMintAudit(["auth://invented-by-the-router"], []);
  return [
    row("mintedAuthority — a grant asserted by a caller that does not hold it",
      [!healthy.mintedAuthority, "the healthy opening action carries no authority ref at all"],
      [asserted.mintedAuthority, "an action left carrying auth://not-held against empty holdings"]),
    row("mintedAuthority — a ref invented between the gap and the action",
      [!routeGap(TWO_KINDS).mintedAuthority,
        "routing copies the gap's holdings and structurally cannot invent one"],
      [handBuilt.mintedAuthority, `planted at the audit: ${handBuilt.minted.join(", ")}`]),
  ];
}

/** The nine kinds, and whether they are nine contracts or nine names for fewer. */
function distinctnessRows(): GapRoutingProbeRow[] {
  const targets = ACTION_KINDS.map((k) => ACTION_CONTRACTS[k].target);
  const completions = ACTION_KINDS.map((k) => ACTION_CONTRACTS[k].completion);
  const dupes = (xs: readonly string[]): number => xs.length - new Set(xs).size;
  const faultedCompletions = [...completions];
  faultedCompletions[1] = faultedCompletions[0];
  return [row("the nine kinds carry distinct target and completion contracts",
    [dupes(targets) === 0 && dupes(completions) === 0,
      `${ACTION_KINDS.length} kinds, ${new Set(targets).size} distinct targets, ` +
      `${new Set(completions).size} distinct completion contracts`],
    [dupes(faultedCompletions) > 0,
      "two kinds given the same completion contract are caught as one contract under two names"])];
}

/** Routing is not a blanket pause, a pause is not a success, and its condition is this gap's. */
function pauseRows(): GapRoutingProbeRow[] {
  const permitted = routeGap({ kinds: ["verification"], blockedTargets: [ALPHA] });
  const refused = routeGap({ kinds: ["verification"], blockedTargets: [ALPHA], noPermittedAction: true });
  const unnamed = routeGap({ kinds: [], noPermittedAction: true });
  const elsewhere = routeGap({ kinds: [], noPermittedAction: true, blockedTargets: [BETA] });
  const unknown = routeGap({ kinds: ["no-such-kind"], blockedTargets: [ALPHA] });
  return [
    row("a gap with no permitted action pauses, and one with a permitted action does not",
      [permitted.kind === "run-experiment",
        "a verification gap that is permitted reaches an experiment, so the pause is not blanket"],
      [refused.kind === "pause" && refused.resumptionCondition !== null,
        "refused everything and returned a pause carrying a resumption condition, not a success"]),
    row("the resumption condition is derived from the gap it pauses, not a constant",
      [(unnamed.resumptionCondition ?? "").includes("the objective this gap blocks"),
        "a gap naming no target names what it blocks instead, and the observation that ends it"],
      [!(elsewhere.resumptionCondition ?? "").includes("the objective this gap blocks")
        && (elsewhere.resumptionCondition ?? "").includes(BETA),
        `another gap's pause names ${BETA} and not the first gap's subject`]),
    row("an unroutable gap kind is paused by name, never dropped",
      [GAP_KINDS.every((k) => routeGap({ kinds: [k] }).kind !== "pause"),
        `all ${GAP_KINDS.length} known kinds reach work`],
      [unknown.kind === "pause" && !unknown.collapsedToOne,
        "an unknown kind pauses and still covers its own demand, so the coverage audit can see it"]),
  ];
}

/** Every gap kind against the resolver it is contracted to reach. */
function resolverRows(): GapRoutingProbeRow[] {
  const expected: readonly [string, ActionKind, Gap][] = [
    ["fact", "gather-evidence", { kinds: ["fact"] }],
    ["fact, question still open", "investigate", { kinds: ["fact"], questionOpen: true }],
    ["fact, against something produced", "revise-targeted",
      { kinds: ["fact"], againstProducedRef: "doc://produced" }],
    ["verification", "run-experiment", { kinds: ["verification"] }],
    ["analysis", "deepen-analysis", { kinds: ["analysis"] }],
    ["preference", "ask-person", { kinds: ["preference"] }],
    ["uniquely-held-information", "ask-person", { kinds: ["uniquely-held-information"] }],
    ["authority", "ask-person", { kinds: ["authority"] }],
  ];
  const wrong = expected.filter(([, want, gap]) => routeGap(gap).kind !== want);

  // One predicate, applied to both halves. A faulted column asserting a property of a subject
  // built to have it proves nothing; the detector has to be the same question asked twice.
  const namesDecision = (a: { readonly kind: ActionKind; readonly blockedDecision: string | null }): boolean =>
    a.kind !== "ask-person" || (a.blockedDecision ?? "").length > 0;
  const personBound = expected
    .filter(([, want]) => want === "ask-person")
    .map(([, , gap]) => routeGap(gap).actions[0]);
  // The fault: a person reached with no statement of what they are being asked to settle.
  const stripped = { ...personBound[0], blockedDecision: null };
  return [row("every gap kind reaches its resolver, and a person is never reached unnamed",
    [wrong.length === 0 && personBound.every(namesDecision),
      `${expected.length} routings hold, and all ${personBound.length} person-bound kinds ` +
      "pass the same predicate the faulted column fails"],
    [!namesDecision(stripped),
      "the same predicate over an ask-person action whose blocked decision was removed"])];
}

/** The audits' own boundaries: each is shown refusing to speak about a healthy subject it has
 *  every opportunity to misreport, which is the half a detector hardcoded to true would fail.
 *  An audit that fired on everything would pass every faulted column above. */
function auditBoundaryRows(): GapRoutingProbeRow[] {
  const known = citationAudit(["outcome://real"], ["outcome://real"], []);
  const minted = citationAudit(["objective://first"], [], ["objective://first"]);
  const invented = citationAudit([INVENTED_PRIOR], ["outcome://real"], ["objective://first"]);
  const recorded = deadlockAudit([{ subject: ALPHA, demands: "recorded" }], [ALPHA]);
  const elsewhere = deadlockAudit([{ subject: BETA, demands: "established" }], [ALPHA]);
  const real = deadlockAudit([{ subject: ALPHA, demands: "established" }], [ALPHA]);
  return [
    row("citationAudit does not call established ground an invention",
      [!known.inventedPriorOutcome && !minted.inventedPriorOutcome,
        "a ref the control state holds, and a ref this result minted, both pass"],
      [invented.inventedPriorOutcome, `and ${invented.fabricated.join(", ")} does not`]),
    row("deadlockAudit does not call an ordinary precondition a deadlock",
      [!recorded.requiresForwardProgressFirst && !elsewhere.requiresForwardProgressFirst,
        "recording what the transition itself does, and demanding a subject it does not " +
        "unsettle, are both fine"],
      [real.requiresForwardProgressFirst, real.deadlockedOn.join("; ")]),
  ];
}

/**
 * The text this module generates.
 *
 * A `completionCondition` is assembled from the contract and the gap. Assembled by the same
 * template as the other eight, the pause's ended `Closes <gap>` while the `resumptionCondition`
 * beside it in the same object said the gap stays open. These two rows look at the emitted
 * string rather than at the code that produces it.
 */
function completionTextRows(): GapRoutingProbeRow[] {
  const pause = routeGap({ kinds: [], noPermittedAction: true }).actions[0];
  const ordinary = routeGap({ kinds: ["fact"], gapIds: ["gap://f"] }).actions[0];

  // One predicate over the emitted text, applied to every column below: an action claims
  // closure when it says it closes something other than nothing.
  const claimsClosure = (t: string): boolean =>
    /\bcloses\b/i.test(t) && !/\bcloses nothing\b/i.test(t);
  // A seam is the template showing through: a blank gap kind interpolated into `the  gap`, or
  // the pause's target — which is already a sentence — wrapped as though it were a noun phrase.
  const seam = (t: string): boolean => t.includes("  ") || t.includes("Pointed at nothing");

  // The regression, rebuilt exactly as the one template assembled it before the pause was given
  // text of its own. Kept here rather than described, so the faulted column is the real string.
  const spec = ACTION_CONTRACTS["pause"];
  const reinstated =
    `${spec.completion}. Pointed at ${spec.target}: the objective this gap blocks. ` +
    "Closes the  gap this action was routed from.";

  // All nine kinds' emitted text, since two of them are only reachable through a transition.
  const everyKind = [
    routeGap({ kinds: ["fact"] }).actions[0],
    routeGap({ kinds: ["fact"], questionOpen: true }).actions[0],
    routeGap({ kinds: ["fact"], againstProducedRef: "doc://produced" }).actions[0],
    routeGap({ kinds: ["verification"] }).actions[0],
    routeGap({ kinds: ["analysis"] }).actions[0],
    routeGap({ kinds: ["preference"] }).actions[0],
    correctiveReturn().action,
    reviewClose().action,
    pause,
  ];
  const covered = new Set(everyKind.map((a) => a.kind));

  return [
    row("a pause's completion condition does not claim to close a gap",
      [!claimsClosure(pause.completionCondition) && claimsClosure(ordinary.completionCondition),
        "the pause says it closes nothing and its gap stays open, while an ordinary action " +
        "says which gap it closes — so the predicate is reading the text, not agreeing with it"],
      [claimsClosure(reinstated),
        "the template's closing clause reinstated: a pause asserting it closes the gap its own " +
        "resumption condition says stays open"]),
    row("no kind's assembled completion text carries a template seam",
      [covered.size === ACTION_KINDS.length && !everyKind.some((a) => seam(a.completionCondition)),
        `all ${ACTION_KINDS.length} kinds' emitted text is free of a blank interpolated gap ` +
        "kind and of a sentence wrapped as a noun phrase"],
      [seam(reinstated),
        "the one template over all nine wrote `the  gap` and `Pointed at nothing is targeted`"]),
  ];
}

/** Every row, and the table is the report. */
export function gapRoutingProbe(): readonly GapRoutingProbeRow[] {
  return Object.freeze([
    ...collapseRows(),
    ...inventionRows(),
    ...deadlockRows(),
    ...invalidationRows(),
    ...authorityRows(),
    ...distinctnessRows(),
    ...pauseRows(),
    ...resolverRows(),
    ...auditBoundaryRows(),
    ...completionTextRows(),
  ]);
}

