/**
 * What a gap makes somebody do next, and the nine shapes that work can take.
 *
 * A gap is the difference between what a piece of work rests on and what it would need to
 * rest on. Its kind says what is missing — a fact, a verification, an analysis, a preference,
 * something only one person holds, an authority nobody here has — and each is resolved by
 * different work done by a different party.
 *
 * Kinds coexist: a gap carrying both a missing fact and an undecided authority gets both an
 * evidence action and a person asked.
 *
 * COUPLED: gap-audit.ts computes `collapsedToOne` and `mintedAuthority` over this module's
 * output and imports nothing from it.
 *
 * DELIBERATE: this layer selects the work and never grants the authority to do it. Every
 * `authorityRef` an action carries came in on the gap; none is minted here.
 *
 * DELIBERATE: a gap with no permitted action pauses, and a pause is never a success. Its
 * resumption condition is built from the gap's own targets and the refused kinds, ending in
 * the observation that settles it — routing this gap again and getting back a kind that is
 * not a pause.
 *
 * DELIBERATE: no stage is named here. `targetStage` is whatever the caller passed; this
 * module never reads it for meaning and holds no list to compare it to.
 */
import {
  authorityMintAudit,
  coverageAudit,
  type Covered,
} from "./gap-audit.js";

/** The nine shapes of work.
 *
 *  DELIBERATE: there is no `advance` kind. The next stage is a fact about a flow's
 *  declaration, which this module cannot see; closing is reached by a grant of eligibility. */
export type ActionKind =
  | "gather-evidence"
  | "investigate"
  | "run-experiment"
  | "deepen-analysis"
  | "revise-targeted"
  | "ask-person"
  | "return-corrective"
  | "grant-close-eligibility"
  | "pause";

/** What one kind of action is pointed at, and what has to be observed for it to be over.
 *  Both are rules rather than instances; an emitted action instantiates them against its own
 *  targets and gap ids. */
interface ActionContract {
  readonly kind: ActionKind;
  readonly target: string;
  readonly completion: string;
}

const contract = (kind: ActionKind, target: string, completion: string): ActionContract =>
  Object.freeze({ kind, target, completion });

/**
 * The inventory: every kind's target and completion, written once. `ACTION_KINDS` is derived
 * from its keys rather than listed separately.
 */
export const ACTION_CONTRACTS: Readonly<Record<ActionKind, ActionContract>> = Object.freeze({
  "gather-evidence": contract(
    "gather-evidence",
    "the sources a known question is to be answered from",
    "the named evidence exists, is cited by id against the gap, and the gap's question is " +
    "answerable from it without further interpretation"),
  "investigate": contract(
    "investigate",
    "an open question for which no source has been identified yet",
    "the question is restated as something a source could answer AND at least one candidate " +
    "source is named — an investigation that produced neither is not finished"),
  "run-experiment": contract(
    "run-experiment",
    "the claim whose truth is in doubt",
    "a trial ran against that claim and its result is recorded, confirming or refuting it; a " +
    "trial nobody ran and an argument about the claim are both incompletions"),
  "deepen-analysis": contract(
    "deepen-analysis",
    "the analysis that stops short of the relation in question",
    "the relation is explained from evidence already held and the explanation is recorded " +
    "against the analysis it extends"),
  "revise-targeted": contract(
    "revise-targeted",
    "the section of an already-produced artifact the gap stands against",
    "the named gap ids are closed in that artifact and the revision is recorded against it — " +
    "closing is per gap id, never per document"),
  "ask-person": contract(
    "ask-person",
    "the person who holds the decision, the preference or the information nobody else has",
    "an answer to the exact blocked decision is recorded and attributed to whoever gave it; " +
    "an inference about what they would probably say does not complete this"),
  "return-corrective": contract(
    "return-corrective",
    "the upstream target this grant authorises a bounded edit to",
    "the bounded edit is recorded and every dependent readiness the return invalidated has " +
    "been re-established on the corrected ground"),
  "grant-close-eligibility": contract(
    "grant-close-eligibility",
    "the objective this grant makes eligible to close",
    "the grant's named conditions are observed to hold and the close is recorded separately — " +
    "eligibility is a permission to close and is never itself a close"),
  "pause": contract(
    "pause",
    "nothing is targeted, because no permitted action reaches this gap",
    "the resumption condition is observed to hold and the gap is routed again — a pause ends " +
    "in a new routing decision and never in a completion"),
});

/** The nine, derived from the inventory above. */
export const ACTION_KINDS: readonly ActionKind[] =
  Object.freeze(Object.keys(ACTION_CONTRACTS) as ActionKind[]);

/** The gap kinds this router resolves. An input kind outside this set is neither dropped nor
 *  guessed at: it pauses, named, so it still shows up covered in the coverage audit. */
export const GAP_KINDS: readonly string[] = Object.freeze([
  "fact",
  "verification",
  "analysis",
  "preference",
  "uniquely-held-information",
  "authority",
]);

/** The gap kinds whose resolver is a person rather than a piece of work. All three end at the
 *  same action, each naming a different thing it is blocked on. */
const PERSON_KINDS: readonly string[] = Object.freeze([
  "preference",
  "uniquely-held-information",
  "authority",
]);

/**
 * A gap as its holder can describe it. Everything but `kinds` is optional: a caller that knows
 * less still gets a routed action rather than a refusal. `againstProducedRef` and
 * `questionOpen` change which resolver a fact gap reaches.
 */
export interface Gap {
  readonly kinds: readonly string[];
  /** The ids of the gaps themselves, where the caller keeps them. */
  readonly gapIds?: readonly string[];
  /** What is blocked: the target ids the resolved work is pointed at. */
  readonly blockedTargets?: readonly string[];
  /** Evidence already held against this gap. Carried onto the action so the work starts from
   *  what exists rather than from nothing. */
  readonly evidenceIds?: readonly string[];
  /** Opaque, caller-supplied, never interpreted here. */
  readonly targetStage?: string;
  /** The decision a person is blocked on, in the caller's own words. Where it is absent one
   *  is composed from the gap, never omitted. */
  readonly decision?: string;
  /** True when the question itself is not yet settled: that routes to an investigation, where
   *  a fact gap whose question is known routes to evidence collection. */
  readonly questionOpen?: boolean;
  /** The already-produced artifact this gap stands against, if it stands against one. */
  readonly againstProducedRef?: string;
  /** Authority grants the caller already holds. Nothing else may reach an action. */
  readonly authorityRefs?: readonly string[];
  /** Set by a caller whose permission layer has refused every candidate action. */
  readonly noPermittedAction?: boolean;
  /** The action kinds that permission layer refused, where it says. */
  readonly deniedKinds?: readonly string[];
}

/** One unit of work, with everything its doer and its judge need and nothing they do not. */
export interface Action {
  readonly kind: ActionKind;
  /** Opaque: whatever the gap carried, or null. */
  readonly targetStage: string | null;
  readonly targetIds: readonly string[];
  readonly gapIds: readonly string[];
  /** The single gap kind this action was built for. One kind per action is what keeps the
   *  coverage audit honest. */
  readonly forGapKind: string;
  /** Points at the {@link ActionContract} that says what this kind of work is. */
  readonly workContractRef: string;
  readonly completionCondition: string;
  /** Carried in from the gap, or null. Never minted here. */
  readonly authorityRef: string | null;
  /** The exact decision a person is blocked on — non-null only on `ask-person`. */
  readonly blockedDecision: string | null;
  /** What must be observed for a pause to end — non-null only on `pause`. */
  readonly resumptionCondition: string | null;
}

/** What routing a gap produced: the actions, the primary one's fields flattened for a caller
 *  that asked about a single kind, and the two audits run over the result. */
export interface GapRouting {
  /** The first action's kind, in the order the gap listed its kinds. */
  readonly kind: ActionKind;
  readonly actions: readonly Action[];
  /** The first blocked decision any action names, or null when no person is in the path. */
  readonly blockedDecision: string | null;
  /** The first resumption condition any action names, or null when nothing paused. */
  readonly resumptionCondition: string | null;
  /** Audited in gap-audit.ts, which knows nothing about resolvers. */
  readonly collapsedToOne: boolean;
  readonly collapseSignals: readonly string[];
  /** Audited likewise: an authority ref on the way out that was not on the way in. */
  readonly mintedAuthority: boolean;
}

const list = (xs: readonly string[] | undefined): readonly string[] => Object.freeze([...(xs ?? [])]);

/** What the gap points at, in words, for a condition that has to be readable. Never empty. */
function targetPhrase(gap: Gap): string {
  const targets = list(gap.blockedTargets);
  if (targets.length > 0) return targets.join(", ");
  const ids = list(gap.gapIds);
  if (ids.length > 0) return `the work blocked by gap(s) ${ids.join(", ")}`;
  return gap.targetStage ? `the work in progress at ${gap.targetStage}` : "the objective this gap blocks";
}

/** The decision a person is being asked for: the caller's own words when it gave them,
 *  otherwise the most specific sentence the gap supports. Never blank. */
function blockedDecisionFor(kind: string, gap: Gap): string {
  if (gap.decision) return gap.decision;
  const subject = targetPhrase(gap);
  if (kind === "preference") return `which option to take for ${subject}, where more than one is workable`;
  if (kind === "authority") return `whether ${subject} is authorised to proceed, and under whose authority`;
  return `the information only this person holds about ${subject}`;
}

/** Which resolver a fact gap reaches. A gap against something already written is a targeted
 *  revision, a gap whose question is not yet settled is an investigation, and everything else
 *  is evidence to be collected.
 *
 *  DELIBERATE: collection is the default. A known question with unnamed sources routed to an
 *  investigation would send somebody to rediscover a question the gap already states. */
function factResolver(gap: Gap): ActionKind {
  if (gap.againstProducedRef) return "revise-targeted";
  if (gap.questionOpen) return "investigate";
  return "gather-evidence";
}

/** The resolver for one gap kind, or null when this router has none, which becomes a pause
 *  rather than a guess. */
function resolverFor(kind: string, gap: Gap): ActionKind | null {
  if (kind === "fact") return factResolver(gap);
  if (kind === "verification") return "run-experiment";
  if (kind === "analysis") return "deepen-analysis";
  if (PERSON_KINDS.includes(kind)) return "ask-person";
  return null;
}

/** The condition that ends a pause: what is refused, over what, and the observation that
 *  settles it. Built from this gap's own fields, so two gaps never share a condition. */
function resumptionFor(kind: string, gap: Gap, refused: readonly string[]): string {
  const denied = refused.length > 0 ? refused.join(", ") : "every action kind this router can reach";
  const why = gap.noPermittedAction
    ? `the permission layer refused ${denied}`
    : kind === ""
      ? "this gap names no kind, so nothing was asked for"
      : `no resolver is defined for a gap of kind ${kind}`;
  return (
    `${why} for ${targetPhrase(gap)}. Resume when the refusal is lifted for at least one of ` +
    `${denied}, or when the gap is restated under a kind this router resolves ` +
    `(${GAP_KINDS.join(", ")}); observed by routing this gap again and receiving a kind other ` +
    "than pause. Until then this gap is open — a pause is not a completion and closes nothing."
  );
}

/** The gap an action answers, named by id where the caller kept ids and by kind where it did
 *  not. A gap naming no kind is the ordinary case for a pause, so the kind is omitted rather
 *  than interpolated blank. */
function gapReference(forGapKind: string, gapIds: readonly string[]): string {
  if (gapIds.length > 0) return gapIds.join(", ");
  return forGapKind === ""
    ? "the gap this action was routed from"
    : `the ${forGapKind} gap this action was routed from`;
}

/** A clause that is already a sentence, made to read as one. */
function asSentence(clause: string): string {
  const trimmed = clause.trim();
  const capitalised = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return capitalised.endsWith(".") ? capitalised : `${capitalised}.`;
}

/**
 * The completion contract, instantiated. The pause is built separately because it is the one
 * kind that closes nothing: eight kinds end by closing the gap they were routed from, and a
 * pause ends in a new routing decision. A single template over all nine would write
 * `Closes <gap>` onto a pause while its own `resumptionCondition` says the gap stays open.
 *
 * The pause's target is also already a sentence where the other eight are noun phrases, so
 * each half is derived from the contract rather than from one template.
 */
function completionFor(
  actionKind: ActionKind,
  forGapKind: string,
  gap: Gap,
  targets: readonly string[],
  gapIds: readonly string[],
  from: string,
): string {
  const spec = ACTION_CONTRACTS[actionKind];
  const over = targets.length > 0 ? targets.join(", ") : targetPhrase(gap);
  if (actionKind === "pause") {
    return (
      `${spec.completion}. ${asSentence(spec.target)} What waits: ${over}. This action closes ` +
      `nothing: ${gapReference(forGapKind, gapIds)} stays open.${from}`
    );
  }
  return `${spec.completion}. Pointed at ${spec.target}: ${over}. ` +
    `Closes ${gapReference(forGapKind, gapIds)}.${from}`;
}

function buildAction(
  actionKind: ActionKind,
  forGapKind: string,
  gap: Gap,
  refused: readonly string[],
): Action {
  // The artifact being revised is a target of the revision: off the action, a targeted
  // revision states nothing to revise, and an audit walking an action's refs cannot see it.
  // Deduplicated, because a caller that names it in both fields means it once.
  const targets = Object.freeze([...new Set([
    ...(gap.blockedTargets ?? []),
    ...(actionKind === "revise-targeted" && gap.againstProducedRef ? [gap.againstProducedRef] : []),
  ])]);
  const gapIds = list(gap.gapIds);
  const evidence = list(gap.evidenceIds);
  const held = list(gap.authorityRefs);

  const from = evidence.length > 0 ? ` Starts from evidence already held: ${evidence.join(", ")}.` : "";

  return Object.freeze({
    kind: actionKind,
    targetStage: gap.targetStage ?? null,
    targetIds: targets,
    gapIds,
    forGapKind,
    workContractRef: `action-contract://${actionKind}`,
    completionCondition: completionFor(actionKind, forGapKind, gap, targets, gapIds, from),
    // DELIBERATE: never minted — the gap's first grant or nothing at all. authorityMintAudit
    // checks the way out against the way in.
    authorityRef: held.length > 0 ? held[0] : null,
    blockedDecision: actionKind === "ask-person" ? blockedDecisionFor(forGapKind, gap) : null,
    resumptionCondition: actionKind === "pause" ? resumptionFor(forGapKind, gap, refused) : null,
  });
}

/**
 * Route a gap to the work that resolves it: one action per distinct kind, in the order the gap
 * listed them. A kind with no resolver, and every kind when the caller's permission layer has
 * refused everything, becomes a `pause` that still covers the kind it could not route, so a
 * dropped demand stays visible to the coverage audit.
 */
export function routeGap(gap: Gap): GapRouting {
  const kinds = [...new Set(gap.kinds)];
  const refused = list(gap.deniedKinds);

  const actions: Action[] = [];
  if (gap.noPermittedAction) {
    // Nothing this router would have chosen is permitted. Each kind still gets its own pause
    // carrying its own refused resolver, which is what the person lifting the refusal needs.
    const denied = refused.length > 0
      ? refused
      : kinds.map((k) => resolverFor(k, gap)).filter((r): r is ActionKind => r !== null);
    if (kinds.length === 0) actions.push(buildAction("pause", "", gap, denied));
    else for (const k of kinds) actions.push(buildAction("pause", k, gap, denied));
  } else if (kinds.length === 0) {
    // DELIBERATE: a gap naming no kind is not an automatic success. It is a gap nobody has
    // characterised, and the resumption condition says so.
    actions.push(buildAction("pause", "", gap, refused));
  } else {
    for (const k of kinds) {
      const resolver = resolverFor(k, gap);
      actions.push(resolver === null
        ? buildAction("pause", k, gap, refused)
        : buildAction(resolver, k, gap, refused));
    }
  }

  const covered: readonly Covered[] = actions.map((a): Covered => Object.freeze({
    kinds: Object.freeze([a.forGapKind].filter((k) => k !== "")),
    ids: a.gapIds,
  }));
  const coverage = coverageAudit({ kinds, ids: list(gap.gapIds) }, covered);
  const authority = authorityMintAudit(actions.map((a) => a.authorityRef), list(gap.authorityRefs));

  return Object.freeze({
    kind: actions[0].kind,
    actions: Object.freeze(actions),
    blockedDecision: actions.find((a) => a.blockedDecision !== null)?.blockedDecision ?? null,
    resumptionCondition: actions.find((a) => a.resumptionCondition !== null)?.resumptionCondition ?? null,
    collapsedToOne: coverage.collapsedToOne,
    collapseSignals: coverage.signals,
    mintedAuthority: authority.mintedAuthority,
  });
}
