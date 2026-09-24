/**
 * The audits, kept out of reach of the mechanisms they audit.
 *
 * Every flag in this subject area is asserted false by its caller — nothing was dropped, nothing
 * was invented, nothing deadlocks. A flag like that is worthless the moment it is computed from the
 * same table as the decision it is checking: the day the resolver table loses an entry, an audit
 * built on that table loses the same entry, agrees with itself, and reports clean.
 *
 * DELIBERATE: this module imports nothing. It has no `Gap`, no `Action`, no resolver table and no
 * vocabulary belonging to either — it takes plain lists of strings and answers structural questions
 * about them, so a router cannot make `coverageAudit` agree with it.
 *
 * Four questions, each answered from two sides that were produced separately:
 *
 *   coverage      — what was asked for, against what was emitted. The demand side comes from the
 *                   caller's own input; the emitted side from the plan built for it.
 *   citation      — what a result cites, against what exists plus what that same result is entitled
 *                   to mint. Anything outside that union was invented.
 *   deadlock      — what a permission requires, against the subjects the transition holding that
 *                   permission is about to unsettle. An overlap is a transition that cannot start
 *                   until it has finished.
 *   authority     — what an action carries, against what its caller actually held. A ref that
 *                   appears on the way out and was never on the way in was minted.
 *
 * The count guard in `coverageAudit` is the half that cannot be faked. Coverage labels are stamped
 * on the emitted side by whoever built it, so a planner that stamped every label on one action
 * would satisfy a label-only audit. The second signal compares counts, which no label can move, and
 * the two are OR-ed: either one firing is a collapse.
 */

/** What was asked for. `ids` is only as strong as the caller's own ids — where none were
 *  supplied the demand is carried by `kinds` alone, and the count guard below still holds. */
interface Demand {
  readonly kinds: readonly string[];
  readonly ids: readonly string[];
}

/** What one emitted unit of work claims to cover. One kind per unit is what makes the label
 *  half meaningful: a unit stamped with every kind in the demand covers everything by
 *  construction and proves nothing. Callers that emit one unit per demand kind satisfy this
 *  naturally; the count guard catches the ones that do not. */
export interface Covered {
  readonly kinds: readonly string[];
  readonly ids: readonly string[];
}

interface CoverageVerdict {
  /** True when something asked for is missing from what was emitted, OR when fewer units came
   *  out than there were distinct kinds going in. Two independent signals, OR-ed. */
  readonly collapsedToOne: boolean;
  readonly uncoveredKinds: readonly string[];
  readonly uncoveredIds: readonly string[];
  readonly demandKindCount: number;
  readonly emittedCount: number;
  /** Which of the two signals spoke, so a reader can tell a dropped demand from a plan that
   *  kept all the labels and threw away the units. */
  readonly signals: readonly string[];
}

const distinct = (xs: readonly string[]): string[] => [...new Set(xs)];

/**
 * Whether a plan still answers everything its gap asked for.
 *
 * Used for two different subjects: the demands of a gap against the actions planned for it, and the
 * dependent readiness of a correction against what that correction invalidated. Both are the same
 * structural question — is anything on the left missing from the right.
 */
export function coverageAudit(demand: Demand, emitted: readonly Covered[]): CoverageVerdict {
  const coveredKinds = new Set(emitted.flatMap((e) => e.kinds));
  const coveredIds = new Set(emitted.flatMap((e) => e.ids));
  const uncoveredKinds = distinct(demand.kinds).filter((k) => !coveredKinds.has(k));
  const uncoveredIds = distinct(demand.ids).filter((i) => !coveredIds.has(i));
  const demandKindCount = distinct(demand.kinds).length;
  const short = emitted.length < demandKindCount;

  const signals: string[] = [];
  if (uncoveredKinds.length > 0) signals.push(`kinds asked for and not answered: ${uncoveredKinds.join(", ")}`);
  if (uncoveredIds.length > 0) signals.push(`ids asked for and not answered: ${uncoveredIds.join(", ")}`);
  if (short) {
    signals.push(
      `${emitted.length} unit(s) emitted for ${demandKindCount} distinct demand kind(s) — a ` +
      "count no coverage label can move");
  }

  return Object.freeze({
    collapsedToOne: uncoveredKinds.length > 0 || uncoveredIds.length > 0 || short,
    uncoveredKinds: Object.freeze(uncoveredKinds),
    uncoveredIds: Object.freeze(uncoveredIds),
    demandKindCount,
    emittedCount: emitted.length,
    signals: Object.freeze(signals),
  });
}

interface CitationVerdict {
  readonly inventedPriorOutcome: boolean;
  readonly fabricated: readonly string[];
}

/**
 * Whether a result leans on anything that does not exist.
 *
 * `known` is what the control state actually holds; `minted` is what this very result is entitled
 * to create and name. A reference outside that union is a prior outcome nobody produced, whether it
 * arrived as a citation, a target id or a gap id — not just the citation field: a first action
 * pointed at an artifact that was never produced invents a previous outcome as surely as a sentence
 * claiming one.
 */
export function citationAudit(
  referenced: readonly string[],
  known: readonly string[],
  minted: readonly string[],
): CitationVerdict {
  const legitimate = new Set([...known, ...minted]);
  const fabricated = distinct(referenced).filter((r) => !legitimate.has(r));
  return Object.freeze({
    inventedPriorOutcome: fabricated.length > 0,
    fabricated: Object.freeze(fabricated),
  });
}

/** What a permission demands before it may be exercised, and of what. `recorded` is the only
 *  one a transition can satisfy by doing its own work; the other two are states that only
 *  forward progress produces, which is what makes them capable of deadlocking. */
export interface PermissionPrecondition {
  readonly subject: string;
  readonly demands: "established" | "granted" | "recorded";
}

interface DeadlockVerdict {
  readonly requiresForwardProgressFirst: boolean;
  readonly deadlockedOn: readonly string[];
  /** How many preconditions were examined. A verdict of false over an empty set is a verdict
   *  about nothing, and a caller reporting it as a clean bill of health is reporting its own
   *  silence — so the number is on the record. */
  readonly examined: number;
}

/**
 * Whether a transition's own permission is waiting on the transition.
 *
 * `unsettled` is what this transition is about to create, edit or invalidate. A precondition
 * demanding that one of those subjects already be established or already be granted cannot be met
 * before the transition runs, and the transition cannot run until it is met. It is the same shape
 * at a first objective, at a corrective return and at a close.
 */
export function deadlockAudit(
  preconditions: readonly PermissionPrecondition[],
  unsettled: readonly string[],
): DeadlockVerdict {
  const blocked = new Set(unsettled);
  const deadlockedOn = preconditions
    .filter((p) => p.demands !== "recorded" && blocked.has(p.subject))
    .map((p) => `${p.subject} must be ${p.demands} before a transition that unsettles it may run`);
  return Object.freeze({
    requiresForwardProgressFirst: deadlockedOn.length > 0,
    deadlockedOn: Object.freeze(deadlockedOn),
    examined: preconditions.length,
  });
}

interface AuthorityVerdict {
  readonly mintedAuthority: boolean;
  readonly minted: readonly string[];
}

/**
 * Whether anything left carrying a permission its caller never had.
 *
 * Selecting the work that resolves a gap is a semantic judgement this platform makes freely;
 * deciding that the work is permitted is not. `held` is what the caller brought, and anything else
 * on the way out was minted here.
 */
export function authorityMintAudit(
  carried: readonly (string | null)[],
  held: readonly string[],
): AuthorityVerdict {
  const legitimate = new Set(held);
  const minted = distinct(carried.filter((c): c is string => c !== null)).filter((c) => !legitimate.has(c));
  return Object.freeze({
    mintedAuthority: minted.length > 0,
    minted: Object.freeze(minted),
  });
}
