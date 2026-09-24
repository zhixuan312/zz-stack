/**
 * What an effectiveness score means — the one rule, shared by everything that prints one.
 *
 * In contracts because two services need it and neither may own it: zz-core computes the score
 * and names the band when a round is scored, and the gateway names the same band when the
 * console asks what a plugin scored. A copy in either would drift the first time a boundary
 * moved, with the console printing one word and the report another.
 *
 * The band is derived, never stored. A caption computed from a column in the same row is a
 * cache, not a fact: change the words below and every stored caption is wrong while every
 * stored score stays right. The score is the fact.
 *
 * A band describes the measurement and nothing else:
 *
 *      working well    ·  working  ·  working poorly  ·  not working
 *
 * DELIBERATE: no label asserts a defect or available improvement. A low score says the marks
 * came in below the top of the scale; the cause might be a defect, a harsh ruler, or work
 * nobody can do anything about. Whether anything can be done is the headroom axis, which is
 * independent — a plugin can sit at 5 with nothing identified at all.
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
 *  ruler that yielded neither a mark nor a threshold. Not a fifth rung on the scale: it is the
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
 * What is left to do — the second axis, and the one the reader acts on.
 *
 * The spine is a boolean: `no change needed` and `change identified` are one question with two
 * answers. The other two are not degrees between them — they are states in which the question
 * has no answer yet, and folding either into the boolean would report "we do not know" as
 * "nothing is needed".
 *
 * DELIBERATE: this is an axis, not a recommendation. A `keep`/`retire` column has one permanent
 * answer — somebody installed a plugin for a reason and is going to keep it — so it carries no
 * information.
 *
 * It promises nothing about fixability. "Change identified" says a change exists on the record,
 * not that it will work or is worth doing. "Unexplained gap" says the score is short and nobody
 * has said why, and stops there.
 */
export const HEADROOM = Object.freeze({
  /** At the ceiling with nothing named. Affirmative, not an absence: the plugin needs nothing,
   *  which is a finding. */
  NONE: "no change needed",
  /** At least one named change is open — an unmet threshold, or a recorded finding that
   *  proposes one. The report says what it is. */
  IDENTIFIED: "change identified",
  /** Below the ceiling and nothing named. The one state where the right move is to find out
   *  why rather than to change anything: we cannot say whether a change is needed. */
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
 *  `points <= 1` is the ceiling: a plugin within one point of ten with nothing named is
 *  working. */
export function headroomState(points: number | null, named: number): string {
  if (points === null) return HEADROOM.ABSENT;
  if (named > 0) return HEADROOM.IDENTIFIED;
  return points <= 1 ? HEADROOM.NONE : HEADROOM.UNEXPLAINED;
}

/**
 * The platform's mark scale, declared once.
 *
 * The prompt spells the ends of the scale and `judge-score.ts` rescales a mean against them; a
 * ruler on any other scale would be prompted for one range and normalised against another,
 * silently, with every number downstream still looking ordinary.
 *
 * COUPLED: the ruler's own columns are called `five_means` and `one_means`, in the type above,
 * in the SQL that reads them and in the table itself. This constant makes the two computed uses
 * agree; moving the scale still means migrating those names.
 */
export const MARK_SCALE = { min: 1, max: 5 } as const;
