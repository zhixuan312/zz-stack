/**
 * THE THREE MOVES THAT ARE NOT ORDINARY WORK, AND THE DEADLOCK EACH OF THEM INVITES.
 *
 * NAMED `stage-progression`, NOT `stage-transitions`, and the distinction is not cosmetic.
 * `stage-transition.ts` is a different subject by one letter: whether a transition is a
 * recorded fact or an inferred relation. This file is about whether a move is PERMITTED —
 * opening with no predecessor, returning to correct, and granting close eligibility. Two
 * modules a letter apart, each importable from the same door, is a mis-import nobody would
 * see in review.
 *
 * Routing a gap to the work that resolves it (gap-routing.ts) covers the ordinary case: the
 * objective exists, the ground under it holds, and something is missing from it. Three moves
 * sit outside that, and every one of them has the same failure available to it — a permission
 * that cannot be granted until the thing it permits has already happened.
 *
 *   BOOTSTRAP. There is no previous outcome, because this is the first objective. The failure
 *   is inventing one: citing ground nobody established, or pointing the first action at an
 *   artifact that was never produced, either of which makes an opening look like a
 *   continuation. `citationAudit` compares every reference this result carries against what
 *   the control state actually holds plus the two refs this bootstrap is entitled to mint,
 *   and anything else is an invented prior — whether it arrived as a citation, a target id or
 *   a gap id.
 *
 *   CORRECTIVE RETURN. Something upstream was wrong, so a BOUNDED edit is granted to it, and
 *   the readiness that was computed on the old ground stops holding. The failure is a
 *   precondition demanding that the corrected target already be established before the
 *   correction may run — forward progress required before the step that makes progress
 *   possible. That is a deadlock and it is reported as one.
 *
 *   CLOSE. The failure here is subtler and it is the reason there is no `advance` kind
 *   anywhere in this subject area: a final step has nowhere to advance TO, and a controller
 *   that answers "advance" at the end either invents a stage that does not exist or silently
 *   treats the last step as a completion of the whole objective. So closing is a GRANT of
 *   eligibility, with its conditions named — the close itself is a separate, recorded act by
 *   whoever holds that grant.
 *
 * NO STAGE IS NAMED IN THIS FILE. `targetStage` is an opaque string the caller supplies and
 * nothing here reads it for meaning; the defaults below are placeholders so the no-argument
 * form is answerable, and a caller that means something specific passes its own.
 *
 * THE DEFAULTS CARRY A NON-EMPTY PRECONDITION SET ON PURPOSE. A deadlock verdict of false over
 * an empty list is a verdict about nothing, and would report a clean bill of health that was
 * only silence. Each default below supplies one real, satisfiable precondition, so the false
 * it produces was computed over something.
 */
import {
  authorityMintAudit,
  citationAudit,
  coverageAudit,
  deadlockAudit,
  type Covered,
  type PermissionPrecondition,
} from "./gap-audit.js";
import { routeGap, type Action, type Gap } from "./gap-routing.js";

/** The first objective, as this transition mints it. `citedPriorOutcomes` exists so that
 *  citing one is POSSIBLE and therefore detectable; a bootstrap that cites nothing is the
 *  correct one and the field is empty. */
export interface Objective {
  readonly objectiveRef: string;
  readonly intendedChange: string;
  readonly citedPriorOutcomes: readonly string[];
}

export interface BootstrapInput {
  readonly objectiveRef?: string;
  readonly intendedChange?: string;
  readonly citedPriorOutcomes?: readonly string[];
  /** The outcome refs the control state actually holds. EMPTY AT A REAL BOOTSTRAP, which is
   *  what makes any reference outside the minted pair an invention. */
  readonly knownOutcomeRefs?: readonly string[];
  readonly openingGap?: Gap;
  readonly preconditions?: readonly PermissionPrecondition[];
  readonly authorityRefs?: readonly string[];
}

export interface BootstrapResult {
  readonly objective: Objective;
  /** Routed through the ordinary router: an opening move is ordinary work. */
  readonly firstAction: Action;
  readonly inventedPriorOutcome: boolean;
  readonly fabricatedRefs: readonly string[];
  readonly requiresForwardProgressFirst: boolean;
  readonly deadlockedOn: readonly string[];
  readonly mintedAuthority: boolean;
}

const OBJECTIVE_REF = "objective://first";
const OPENING_GAP_ID = "gap://opening";

/**
 * The first objective, and the first thing to do about it.
 *
 * The opening gap is a FACT gap whose question is still open, which routes to an
 * investigation — the honest opening move when nothing has been established. A bootstrap that
 * opened by revising something would be a bootstrap that believed something had already been
 * produced, and that belief is exactly what the citation audit exists to catch.
 */
export function bootstrap(input: BootstrapInput = {}): BootstrapResult {
  const objectiveRef = input.objectiveRef ?? OBJECTIVE_REF;
  const openingGap: Gap = input.openingGap ?? {
    kinds: ["fact"],
    gapIds: [OPENING_GAP_ID],
    questionOpen: true,
  };
  const objective: Objective = Object.freeze({
    objectiveRef,
    intendedChange: input.intendedChange ?? "the change this objective is opened to make",
    citedPriorOutcomes: Object.freeze([...(input.citedPriorOutcomes ?? [])]),
  });

  const firstAction = routeGap(openingGap).actions[0];

  // EVERY REF THIS RESULT CARRIES, not only the one field with "cited" in its name. A first
  // action pointed at an artifact nobody produced invents a previous outcome just as surely
  // as a sentence claiming one, and an audit reading only the citation field walks past it.
  // EVIDENCE HELD AT A BOOTSTRAP IS GROUND TOO. The control state is empty here, so evidence
  // the opening gap claims to already hold was produced by nothing and is an invented prior in
  // the same way a citation is.
  const referenced = [
    ...objective.citedPriorOutcomes,
    ...firstAction.targetIds,
    ...firstAction.gapIds,
    ...(openingGap.evidenceIds ?? []),
  ];
  const minted = [objectiveRef, ...(openingGap.gapIds ?? [OPENING_GAP_ID])];
  const citations = citationAudit(referenced, input.knownOutcomeRefs ?? [], minted);

  const preconditions = input.preconditions ?? [{ subject: objectiveRef, demands: "recorded" as const }];
  const deadlock = deadlockAudit(preconditions, [objectiveRef, ...firstAction.targetIds]);
  const authority = authorityMintAudit([firstAction.authorityRef], [...(input.authorityRefs ?? [])]);

  return Object.freeze({
    objective,
    firstAction,
    inventedPriorOutcome: citations.inventedPriorOutcome,
    fabricatedRefs: citations.fabricated,
    requiresForwardProgressFirst: deadlock.requiresForwardProgressFirst,
    deadlockedOn: deadlock.deadlockedOn,
    mintedAuthority: authority.mintedAuthority,
  });
}

/** One readiness record standing on ground a correction may be about to move. NOT a readiness
 *  verdict — this is a dependency edge, and the name says so to keep it apart from the verdict
 *  types it will sit beside. */
export interface DependentReadiness {
  readonly target: string;
  readonly dependsOn: readonly string[];
}

export interface CorrectiveReturnInput {
  /** Opaque and caller-supplied; never interpreted here. */
  readonly targetStage?: string;
  /** The upstream targets this return authorises an edit to. BOUNDED: anything not named
   *  here is not editable under this grant. */
  readonly editableTargetIds?: readonly string[];
  /** What currently stands as ready, and on what. */
  readonly standingReadiness?: readonly DependentReadiness[];
  /** What the return actually invalidates. Separate from the dependency graph above ON
   *  PURPOSE — the audit recomputes what SHOULD have been invalidated from the graph and
   *  compares, and an audit handed only the invalidation decision could only agree with it. */
  readonly invalidates?: readonly string[];
  readonly preconditions?: readonly PermissionPrecondition[];
  readonly authorityRef?: string | null;
  readonly heldAuthorityRefs?: readonly string[];
  readonly gapIds?: readonly string[];
}

export interface CorrectiveReturn {
  readonly action: Action;
  /** The edits this grant permits, and the boundary of what it permits. */
  readonly boundedEdits: readonly string[];
  readonly invalidated: readonly string[];
  /** True when nothing that depended on an edited target was left standing. Computed by
   *  comparing the dependency graph against the invalidation, in gap-audit.ts. */
  readonly invalidatesDependentReadiness: boolean;
  readonly leftStanding: readonly string[];
  readonly requiresForwardProgressFirst: boolean;
  readonly deadlockedOn: readonly string[];
  readonly mintedAuthority: boolean;
}

const UPSTREAM_STAGE = "stage://upstream-of-the-correction";
const CORRECTED_TARGET = "target://corrected";
const DEPENDENT_TARGET = "target://dependent-on-corrected";

/**
 * A bounded edit upstream, and the readiness it costs.
 *
 * The grant does two things at once and both are load-bearing. It PERMITS an edit to named
 * upstream targets and to nothing else; and it INVALIDATES every readiness record computed on
 * the ground it is about to move, because a verdict reached on material that has since changed
 * is a verdict about a document that no longer exists.
 *
 * It requires no forward progress to be exercised. That is the deadlock this whole module is
 * written against: a correction whose permission demanded that the thing being corrected
 * already be established could never be the first thing to happen after a failure, which is
 * precisely when it has to be.
 */
export function correctiveReturn(input: CorrectiveReturnInput = {}): CorrectiveReturn {
  const targetStage = input.targetStage ?? UPSTREAM_STAGE;
  const editable = [...(input.editableTargetIds ?? [CORRECTED_TARGET])];
  const standing = input.standingReadiness ?? [
    { target: DEPENDENT_TARGET, dependsOn: [editable[0]] },
  ];

  // What the dependency graph says must fall, recomputed here rather than taken from the
  // return's own decision.
  const dependent = standing
    .filter((r) => r.dependsOn.some((d) => editable.includes(d)))
    .map((r) => r.target);
  const invalidated = [...(input.invalidates ?? dependent)];

  const covered: readonly Covered[] = invalidated.map((i): Covered =>
    Object.freeze({ kinds: Object.freeze([]), ids: Object.freeze([i]) }));
  const coverage = coverageAudit({ kinds: [], ids: dependent }, covered);

  const preconditions = input.preconditions ?? [{ subject: targetStage, demands: "recorded" as const }];
  const deadlock = deadlockAudit(preconditions, [targetStage, ...editable, ...invalidated]);

  const gap: Gap = {
    kinds: ["fact"],
    gapIds: input.gapIds ?? ["gap://correction"],
    blockedTargets: editable,
    targetStage,
    againstProducedRef: editable[0],
    authorityRefs: input.authorityRef ? [input.authorityRef] : [],
  };
  const revision = routeGap(gap).actions[0];

  // The correction's own action is the RETURN, not the revision it authorises: the revision is
  // what the holder of this grant then does inside the boundary it draws.
  const action: Action = Object.freeze({
    ...revision,
    kind: "return-corrective" as const,
    workContractRef: "action-contract://return-corrective",
    completionCondition:
      `the bounded edit to ${editable.join(", ")} is recorded and the readiness invalidated ` +
      `by this return (${invalidated.length > 0 ? invalidated.join(", ") : "none"}) has been ` +
      `re-established on the corrected ground. Edits outside ${editable.join(", ")} are not ` +
      "permitted by this grant and do not complete it.",
  });

  // HELD IS WHAT THE CALLER BROUGHT, and a supplied ref counts as brought unless the caller
  // states its holdings separately — which is the call that gets audited. Folding the supplied
  // ref into the holdings unconditionally would make this verdict unfalsifiable.
  const authority = authorityMintAudit(
    [action.authorityRef],
    input.heldAuthorityRefs ?? (input.authorityRef ? [input.authorityRef] : []));

  return Object.freeze({
    action,
    boundedEdits: Object.freeze(editable),
    invalidated: Object.freeze(invalidated),
    invalidatesDependentReadiness: coverage.uncoveredIds.length === 0,
    leftStanding: coverage.uncoveredIds,
    requiresForwardProgressFirst: deadlock.requiresForwardProgressFirst,
    deadlockedOn: deadlock.deadlockedOn,
    mintedAuthority: authority.mintedAuthority,
  });
}

export interface CloseEligibilityInput {
  readonly objectiveRef?: string;
  readonly targetIds?: readonly string[];
  /** Gaps still open against the objective. Each one is a condition on the grant. */
  readonly openGapIds?: readonly string[];
  readonly preconditions?: readonly PermissionPrecondition[];
  readonly authorityRef?: string | null;
  readonly heldAuthorityRefs?: readonly string[];
}

export interface CloseGrant {
  /** WIDENED TO `string` DELIBERATELY. Callers check this against `advance` — a kind that does
   *  not exist in this subject area and must not — and a comparison against a literal union
   *  that excludes it is a compile error rather than a check. The one place the absent kind
   *  has to be expressible is the comparison that proves it is absent. */
  readonly kind: string;
  readonly action: Action;
  /** Whether the conditions are already met. Computed from the open gaps and nothing else —
   *  never from whether an authority ref was supplied, which is a different question. */
  readonly eligible: boolean;
  readonly conditions: readonly string[];
  readonly requiresForwardProgressFirst: boolean;
  readonly deadlockedOn: readonly string[];
  readonly mintedAuthority: boolean;
}

/**
 * Eligibility to close, granted — never an advance.
 *
 * There is nothing after the last step, so the answer at the end cannot be a move to the next
 * one. What it can be is a permission with its conditions written down: these gaps are closed,
 * this material is recorded, and somebody holding this grant may now close the objective and
 * record that they did. The distinction is not pedantic — a controller that answers "advance"
 * at the end is a controller whose final verdict is indistinguishable from its ordinary ones,
 * and the close nobody performed looks exactly like the close that happened.
 */
export function reviewClose(input: CloseEligibilityInput = {}): CloseGrant {
  const objectiveRef = input.objectiveRef ?? OBJECTIVE_REF;
  const targets = [...(input.targetIds ?? [objectiveRef])];
  const open = [...(input.openGapIds ?? [])];

  const conditions = [
    ...open.map((g) => `gap ${g} is closed against ${objectiveRef}`),
    `the close of ${objectiveRef} is recorded by whoever holds this grant — the grant permits ` +
    "the close and is not itself the close",
  ];

  const gap: Gap = {
    kinds: ["fact"],
    gapIds: open.length > 0 ? open : [`gap://close-of-${objectiveRef}`],
    blockedTargets: targets,
    authorityRefs: input.authorityRef ? [input.authorityRef] : [],
  };
  const routed = routeGap(gap).actions[0];
  const action: Action = Object.freeze({
    ...routed,
    kind: "grant-close-eligibility" as const,
    workContractRef: "action-contract://grant-close-eligibility",
    completionCondition:
      `${conditions.join("; ")}. Eligibility is a permission to close and is never itself a ` +
      "close; nothing here advances to a further step, because there is none.",
  });

  const preconditions = input.preconditions ?? [{ subject: objectiveRef, demands: "recorded" as const }];
  const deadlock = deadlockAudit(preconditions, [objectiveRef, ...targets]);
  const authority = authorityMintAudit(
    [action.authorityRef],
    input.heldAuthorityRefs ?? (input.authorityRef ? [input.authorityRef] : []));

  return Object.freeze({
    kind: action.kind,
    action,
    eligible: open.length === 0,
    conditions: Object.freeze(conditions),
    requiresForwardProgressFirst: deadlock.requiresForwardProgressFirst,
    deadlockedOn: deadlock.deadlockedOn,
    mintedAuthority: authority.mintedAuthority,
  });
}
