/**
 * WHAT AN EFFECTIVENESS SCORE MEANS — the one rule, shared by everything that prints one.
 *
 * IN CONTRACTS BECAUSE TWO SERVICES NEED IT AND NEITHER MAY OWN IT. zz-core computes the score
 * and names the band when a round is recommended; the gateway names the same band when the
 * console asks what a plugin scored. A copy in either would be a second opinion about what
 * "good" means, and the two would drift the first time a boundary moved — the console printing
 * one word and the report another, with nothing on screen saying which to believe.
 *
 * THE BAND IS DERIVED AND IS NO LONGER STORED. `zz.eval.effectiveness_band` held the label
 * beside the number for one release, which is one release longer than it should have: a caption
 * computed from a column in the same row is not a fact, it is a cache, and the moment the words
 * below changed every stored caption was wrong while every stored score stayed right. The score
 * is the fact. This is the rule. Migration 068 dropped the cache.
 *
 * A BAND DESCRIBES THE MEASUREMENT AND NOTHING ELSE, and the first vocabulary did not.
 *
 * It read: "working well", "working, with a defect worth fixing", "underperforming, improvement
 * available", "not effective". Two of those four assert things the score cannot establish. A
 * 7.06 does not say a DEFECT exists — it says the marks came in below the top of the scale, and
 * the cause might be a defect, or a ruler that is harsh, or work nobody can do anything about.
 * "Improvement available" is a stronger claim still: whether there is anything to DO is the
 * headroom axis, which is deliberately independent, and a plugin can sit at 5 with nothing
 * identified at all — `headroom()` has a whole branch for that case and calls it "a measurement
 * nobody has explained".
 *
 * So the label was smuggling the second axis into the first one's name, which is precisely the
 * confusion the two axes exist to prevent. These say where the number sits on the scale, in
 * plain words, and stop:
 *
 *      working well    ·  working  ·  working poorly  ·  not working
 *
 * What to do about it is the recommendation. Whether anything CAN be done is the headroom. This
 * is only how it scored.
 */

/** The boundaries, high to low. Fixed before any round is read: a band drawn after seeing a
 *  number is a band fitted to it, and every report prints these beside its own score so a
 *  reader can check the label against the figure rather than take it. */
export const BANDS: readonly { readonly at: number; readonly label: string }[] = Object.freeze([
  { at: 8, label: "working well" },
  { at: 6, label: "working" },
  { at: 4, label: "working poorly" },
  { at: 0, label: "not working" },
]);

/** What a round says when it could not produce a score at all — a collapsed control, or a
 *  ruler that yielded neither a mark nor a threshold. NOT a fifth rung on the scale: it is the
 *  absence of a measurement, and a reader must never read it as a low one. */
export const NOT_MEASURABLE = "not measurable";

/** The band a score falls in. `null` — no score — is the void case, never "not working": a
 *  plugin nobody could measure and a plugin that does not work are different findings, and
 *  collapsing them would report the first as the second. */
export function band(score: number | null): string {
  if (score === null) return NOT_MEASURABLE;
  return BANDS.find((b) => score >= b.at)?.label ?? BANDS[BANDS.length - 1].label;
}

/**
 * WHAT IS LEFT TO DO — the second axis, and the one the reader acts on.
 *
 * THE SPINE IS A BOOLEAN and the two exceptions are the cases where it cannot be answered.
 * `no change needed` and `change identified` are one question with two answers. The other two
 * are not degrees between them: they are states in which the question has no answer yet, and
 * folding either into the boolean would report "we do not know" as "nothing is needed".
 *
 * IT REPLACED A RECOMMENDATION — `keep`, `keep-and-change`, `re-run`, `not-evaluable`,
 * `retire` — and the reason it had to is that the question it asked has one permanent answer.
 * Somebody installed a plugin for a reason; they are going to keep it. `retire` is advice
 * nobody takes, `keep` is information nobody needed, and the middle three were the second axis
 * wearing a decision's clothes. A column whose value is always the same is a column with no
 * information in it.
 *
 * IT PROMISES NOTHING ABOUT FIXABILITY, which the previous vocabulary did twice over. "Change
 * identified" says a change exists ON THE RECORD — not that it will work, not that it is worth
 * doing. "Unexplained gap" says the score is short and nobody has said why, and stops there.
 * Whether a thing CAN be improved is not something a score can establish, and the labels no
 * longer pretend otherwise.
 */
export const HEADROOM = Object.freeze({
  /** At the ceiling with nothing named. AFFIRMATIVE, not an absence: the plugin needs nothing,
   *  which is a finding. Its first spelling was "nothing to do", which described a hole in the
   *  report where the best outcome on this axis belonged. */
  NONE: "no change needed",
  /** At least one named change is open — an unmet threshold, or a recorded finding that
   *  proposes one. The report says what it is. */
  IDENTIFIED: "change identified",
  /** Below the ceiling and nothing named. The one state where the right move is to find out
   *  WHY rather than to change anything: we cannot say whether a change is needed, and saying
   *  so is more use than guessing. */
  UNEXPLAINED: "unexplained gap",
  /** No score at all, so nothing to say either way. Never a low reading — a plugin nobody could
   *  measure and a plugin that needs nothing are different findings. */
  ABSENT: "not measured",
} as const);

export type HeadroomState = (typeof HEADROOM)[keyof typeof HEADROOM];

/** Every state, for a check or a doc that has to name the closed set. */
export const HEADROOM_STATES: readonly string[] = Object.freeze(Object.values(HEADROOM));

/** Which state a round is in, from figures it already carries. One rule, so the console and
 *  the report cannot disagree about what "no change needed" means.
 *
 *  `points <= 1` is the ceiling, the same line `headroom()` has always drawn: a plugin within
 *  one point of ten with nothing named is working, and a flow that cannot say so pads its own
 *  report. */
export function headroomState(points: number | null, named: number): string {
  if (points === null) return HEADROOM.ABSENT;
  if (named > 0) return HEADROOM.IDENTIFIED;
  return points <= 1 ? HEADROOM.NONE : HEADROOM.UNEXPLAINED;
}

/**
 * THE PLATFORM'S MARK SCALE, DECLARED ONCE.
 *
 * It was written in two places in two forms and neither read the other: the prompt spelled the
 * ends as the literals `5 =` and `1 =`, and `judge-score.ts` rescaled a mean with
 * `(qualMean - 1) / 4`. A ruler on any other scale would have been PROMPTED for one range and
 * NORMALISED against another, silently, with every number downstream still looking ordinary.
 *
 * WHAT THIS DOES NOT FIX, said plainly rather than left for somebody to discover: the ruler's
 * own columns are called `five_means` and `one_means`, in the type above, in the SQL that reads
 * them and in the table itself. Those names encode the same two numbers a third time, and
 * moving the scale means migrating them. This constant makes the two COMPUTED uses agree and
 * derive from one place; it does not make the scale free to change.
 */
export const MARK_SCALE = { min: 1, max: 5 } as const;
