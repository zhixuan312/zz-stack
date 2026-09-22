/**
 * check-state.ts — the seven states a declared check can be in, and nothing else.
 *
 * WHY THIS IS ITS OWN MODULE AND NOT A CONSTANT INSIDE ONE OF ITS CONSUMERS. Two independent
 * subjects need the same vocabulary: an audit record says what state a check was observed in,
 * and an observation manifest says what state a check was captured in. If either owned the
 * list, the other would import a vocabulary through a module about a different subject — and
 * the first time the two disagreed the disagreement would be invisible, because there would be
 * two lists. There is one list. That is the entire content of this file.
 *
 * THE SEVEN ARE NOT A SCALE AND MUST NOT COLLAPSE INTO ONE. The distinction that does the work
 * is between the three that are facts about the check's RESULT (`passed`, `failed`) or its
 * absence (`unrun`), and the three that are facts about the RECORD (`declared`, `present`,
 * `invoked`) — plus `unknown`, which is the one honest answer when the record cannot say.
 *
 *   declared  a document names this check. Nobody has looked for the file.
 *   present   the file exists at the declared path. Nobody has run it.
 *   invoked   something ran it. Its result has not been read back.
 *   passed    it ran and reported no failure.
 *   failed    it ran and reported a failure.
 *   unrun     it was not run, and that is established rather than assumed.
 *   unknown   the record cannot determine which of the above is true.
 *
 * `unknown` IS THE DEFAULT AND MUST NEVER BE WRITTEN AS `passed` OR AS `failed`. A check whose
 * result cannot be determined has not passed. It has also not failed. Collapsing it into either
 * is the defect this vocabulary exists to make impossible: a silent capture that reads, later
 * and to someone who was not there, exactly like a complete one.
 *
 * TYPED `readonly string[]` DELIBERATELY. Consumers ask `CHECK_STATES.includes(s)` with an `s`
 * that arrived as data — from a report on disk, from a caller. A tuple type would refuse that
 * question at compile time and force every consumer to cast, which is how a vocabulary check
 * turns into a cast nobody reads.
 */

/** The seven states, in the order above: record facts, then result facts, then the honest gap. */
export const CHECK_STATES: readonly string[] = Object.freeze([
  "declared",
  "present",
  "invoked",
  "passed",
  "failed",
  "unrun",
  "unknown",
]);

/** The same seven as a type, for code that holds one rather than validating one. */
export type CheckState =
  | "declared"
  | "present"
  | "invoked"
  | "passed"
  | "failed"
  | "unrun"
  | "unknown";

/** The state a record must carry when it cannot establish any of the other six. */
const UNDETERMINED_CHECK_STATE: CheckState = "unknown";

/**
 * Narrow an arbitrary value to a state, or to `unknown`.
 *
 * NOT A VALIDATOR THAT THROWS, and not one that guesses. A value this function does not
 * recognise becomes `unknown` — the state that says "the record cannot determine which" —
 * because the alternative available to a reader of an unrecognised value is to pick one, and
 * every pick is a claim nobody measured.
 */
export function asCheckState(value: unknown): CheckState {
  return typeof value === "string" && CHECK_STATES.includes(value)
    ? (value as CheckState)
    : UNDETERMINED_CHECK_STATE;
}
