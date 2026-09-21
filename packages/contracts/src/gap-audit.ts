/**
 * THE AUDITS, KEPT OUT OF REACH OF THE MECHANISMS THEY AUDIT.
 *
 * Every flag in this subject area is asserted FALSE by its caller — nothing was dropped,
 * nothing was invented, nothing deadlocks. A flag like that is worthless the moment it is
 * computed from the same table as the decision it is checking: the day the resolver table
 * loses an entry, an audit built on that table loses the same entry, agrees with itself, and
 * reports clean. A sibling task in this initiative shipped exactly that shape and it stayed
 * green while detecting nothing.
 *
 * So this module IMPORTS NOTHING. It has no `Gap`, no `Action`, no resolver table and no
 * vocabulary belonging to either — it takes plain lists of strings and answers structural
 * questions about them. A router cannot make `coverageAudit` agree with it, because there is
 * nothing here for the router to be consulted about.
 *
 * FOUR QUESTIONS, EACH ANSWERED FROM TWO SIDES THAT WERE PRODUCED SEPARATELY:
 *
 *   coverage      — what was asked for, against what was emitted. The demand side comes from
 *                   the caller's own input; the emitted side from the plan built for it.
 *   citation      — what a result CITES, against what actually exists plus what that same
 *                   result is entitled to mint. Anything outside that union was invented.
 *   deadlock      — what a permission REQUIRES, against the subjects the transition holding
 *                   that permission is about to unsettle. An overlap is a transition that
 *                   cannot start until it has finished.
 *   authority     — what an action CARRIES, against what its caller actually held. A ref that
 *                   appears on the way out and was never on the way in was minted, and a
 *                   selection of work is never a grant of permission to do it.
 *
 * THE COUNT GUARD IN `coverageAudit` IS THE HALF THAT CANNOT BE FAKED. Coverage labels are
 * stamped on the emitted side by whoever built it, so a planner that stamped every label on
 * one action would satisfy a label-only audit while having collapsed the plan to a single
 * action — the precise failure the flag exists to catch. The second signal compares COUNTS,
 * which no label can move, and the two are OR-ed: either one firing is a collapse.
 */

/** What was asked for. `ids` is only as strong as the caller's own ids — where none were
 *  supplied the demand is carried by `kinds` alone, and the count guard below still holds. */
export interface Demand {
  readonly kinds: readonly string[];
  readonly ids: readonly string[];
}

/** What one emitted unit of work claims to cover. ONE KIND PER UNIT is what makes the label
 *  half meaningful: a unit stamped with every kind in the demand covers everything by
 *  construction and proves nothing. Callers that emit one unit per demand kind satisfy this
 *  naturally; the count guard catches the ones that do not. */
export interface Covered {
  readonly kinds: readonly string[];
  readonly ids: readonly string[];
}

export interface CoverageVerdict {
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
 * Used for two different subjects on purpose — the demands of a gap against the actions
 * planned for it, and the dependent readiness of a correction against what that correction
 * invalidated. Both are the same structural question ("is anything on the left missing from
 * the right"), and one audited implementation is better than two that can disagree.
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

export interface CitationVerdict {
  readonly inventedPriorOutcome: boolean;
  readonly fabricated: readonly string[];
}

/**
 * Whether a result leans on anything that does not exist.
 *
 * `known` is what the control state actually holds; `minted` is what this very result is
 * entitled to create and name — its own objective, its own gap. A reference outside that
 * union is a prior outcome nobody produced, whether it arrived as a citation, as a target id
 * or as a gap id. NOT JUST THE CITATION FIELD: a first action pointed at an artifact that was
 * never produced invents a previous outcome exactly as surely as a sentence claiming one, and
 * an audit that reads only the field named "cited" walks straight past it.
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

export interface DeadlockVerdict {
  readonly requiresForwardProgressFirst: boolean;
  readonly deadlockedOn: readonly string[];
  /** How many preconditions were examined. A verdict of false over an EMPTY set is a verdict
   *  about nothing, and a caller reporting it as a clean bill of health is reporting its own
   *  silence — so the number is on the record. */
  readonly examined: number;
}

/**
 * Whether a transition's own permission is waiting on the transition.
 *
 * `unsettled` is what this transition is about to create, edit or invalidate. A precondition
 * demanding that one of those subjects already be established or already be granted cannot be
 * met before the transition runs, and the transition cannot run until it is met. That is the
 * circular permission deadlock, and it is the same shape at the first objective (nothing is
 * established yet), at a corrective return (what it came back to fix is what it unsettles) and
 * at a close (the thing being closed is the thing the grant is about).
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

export interface AuthorityVerdict {
  readonly mintedAuthority: boolean;
  readonly minted: readonly string[];
}

/**
 * Whether anything left carrying a permission its caller never had.
 *
 * Selecting the work that resolves a gap is a semantic judgement and this platform makes it
 * freely. Deciding that the work is permitted is not, and the one way that line gets crossed
 * quietly is an authority ref appearing on an action because the action needed one. `held` is
 * what the caller brought; anything else on the way out was minted here.
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
