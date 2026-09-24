/**
 * The seven states a declared check can be in, and nothing else.
 *
 * COUPLED: an audit record says what state a check was observed in, and an observation
 * manifest says what state a check was captured in. Both import the vocabulary from here, so
 * there is one list rather than two that can disagree invisibly.
 *
 * The seven are not a scale and must not collapse. Three are facts about the check's result
 * (`passed`, `failed`) or its absence (`unrun`); three are facts about the record (`declared`,
 * `present`, `invoked`); `unknown` is the answer when the record cannot say.
 *
 *   declared  a document names this check. Nobody has looked for the file.
 *   present   the file exists at the declared path. Nobody has run it.
 *   invoked   something ran it. Its result has not been read back.
 *   passed    it ran and reported no failure.
 *   failed    it ran and reported a failure.
 *   unrun     it was not run, and that is established rather than assumed.
 *   unknown   the record cannot determine which of the above is true.
 *
 * `unknown` is the default and must never be written as `passed` or `failed`. A check whose
 * result cannot be determined has not passed, and has also not failed.
 *
 * DELIBERATE: typed `readonly string[]`, not a tuple. Consumers ask `CHECK_STATES.includes(s)`
 * with an `s` that arrived as data, and a tuple type refuses that question at compile time and
 * forces every consumer to cast.
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
 * Narrow an arbitrary value to a state, or to `unknown`. It neither throws nor guesses: a
 * value this function does not recognise becomes `unknown`, because every other choice is a
 * claim nobody measured.
 */
export function asCheckState(value: unknown): CheckState {
  return typeof value === "string" && CHECK_STATES.includes(value)
    ? (value as CheckState)
    : UNDETERMINED_CHECK_STATE;
}
