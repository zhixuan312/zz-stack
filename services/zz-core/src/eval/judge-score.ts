/**
 * How good is it, and what is left to fix — two questions, two numbers, kept separate.
 *
 * A single word from a closed set (keep, re-run, retire) is a decision, not a measurement: it
 * does not say whether a plugin is excellent or barely adequate.
 *
 * The two axes are independent:
 *
 *        high score + headroom   good, and there is a next move
 *        high score + none       leave it alone
 *        low  score + headroom   underperforming, and we know what to do
 *        low  score + none       underperforming and nobody knows why — the retire signal
 *
 * Computed, not asked. Every input is already on the round and no model is in the derivation.
 * The weights below are a judgement, written here rather than in a caller.
 */
import { MARK_SCALE, NOT_MEASURABLE, band, headroomState } from "@zz/contracts";

/** The qualitative half against the quantitative half.
 *
 *  Quality leads because it is read from the artifacts across every subject, while the
 *  thresholds are two or three lines somebody drew. At 0.4 over three thresholds, one failing
 *  costs 1.3 points — a band boundary's worth, not a verdict on its own. */
const QUALITATIVE_WEIGHT = 0.6;
const QUANTITATIVE_WEIGHT = 0.4;

/** Below this, the ruler could not tell the right artifact from the wrong one and the
 *  qualitative half is noise. COUPLED: round_scores prints the same line beside the gap. */
const COLLAPSE_GAP = 1.5;

// COUPLED: the bands live in @zz/contracts, so the console and the reports name the same band.
// `band()` is arithmetic over a number in the same row, so nothing stores the label — a stored
// caption goes wrong the day the words change while every stored score stays right.

interface Effectiveness {
  /** 0-10, or null when the round is void. Never a number over a void round: a mean below a
   *  collapsed control is noise, and printing it with a caveat is how the caveat gets lost. */
  score: number | null;
  band: string;
  qualitative: number | null;
  quantitative: number | null;
  /** The figures the score is made of, so a reader can redo the arithmetic. */
  basis: string;
}

interface Headroom {
  /** Distance from 10. Present even when the score is high — that is the point of a second
   *  axis. Null when the score is. */
  points: number | null;
  /** Things somebody could actually do, each one already written down somewhere: an unmet
   *  threshold names a figure and a line, a generic finding names a change by construction
   *  (finding_record refuses one that proposes none). */
  named_changes: number;
  /** One of the four, from @zz/contracts — a closed set, not a sentence. The state says which of
   *  four situations the round is in; the explaining is the report's job. A paragraph here is
   *  unreadable in a table cell or a tile and unqueryable everywhere. */
  state: string;
}

/** The effectiveness score, from figures the round already carries.
 *
 *  `qualMean` is on the platform's 1-5 scale and is rescaled, so a ruler whose dimensions all
 *  sit at 1 scores 0 rather than 2 — the floor of the scale is not a fifth of the way to good. */
export function effectiveness(
  qualMean: number | null, thresholdsMet: number, thresholdsTotal: number, gap: number | null,
): Effectiveness {
  if (gap !== null && gap < COLLAPSE_GAP) {
    return {
      score: null, band: NOT_MEASURABLE, qualitative: null, quantitative: null,
      basis: `the judge-on-trial gap is ${gap}, below the ${COLLAPSE_GAP} line — the ruler could ` +
             "not tell this plugin's work from another's, so every qualitative mean in this " +
             "round is noise and no score is computed from them",
    };
  }
  // Rescaled from the declared scale, not from two literals: `(qualMean - 1) / 4` is a second
  // spelling of the scale the prompt that produced `qualMean` already states.
  const SPAN = MARK_SCALE.max - MARK_SCALE.min;
  const qual = qualMean === null
    ? null : Math.round(((qualMean - MARK_SCALE.min) / SPAN) * 1000) / 100;
  const quant = thresholdsTotal ? Math.round((thresholdsMet / thresholdsTotal) * 1000) / 100 : null;
  // Either half alone is the whole score. A ruler of purely qualitative dimensions has no
  // thresholds to read, and one of purely quantitative dimensions is marked by no judge. Both
  // are legal rulers, and re-weighting a missing half to zero would score them as failures.
  const score = qual !== null && quant !== null
    ? Math.round((QUALITATIVE_WEIGHT * qual + QUANTITATIVE_WEIGHT * quant) * 100) / 100
    : qual ?? quant;
  if (score === null) {
    return { score: null, band: NOT_MEASURABLE, qualitative: null, quantitative: null,
             basis: "the round produced neither a qualitative mark nor a threshold" };
  }
  const parts = [
    qual !== null ? `qualitative ${qual} (mean ${qualMean} of ${MARK_SCALE.max})` : null,
    quant !== null ? `quantitative ${quant} (${thresholdsMet} of ${thresholdsTotal} thresholds met)` : null,
  ].filter(Boolean);
  return {
    score, band: band(score), qualitative: qual, quantitative: quant,
    basis: qual !== null && quant !== null
      ? `${QUALITATIVE_WEIGHT} x ${qual} + ${QUANTITATIVE_WEIGHT} x ${quant} = ${score}; ${parts.join(", ")}`
      : `${parts[0]} — the ruler has only one kind of dimension, so that half is the whole score`,
  };
}

/** What is left to do, counted from things already written down rather than inferred.
 *
 *  The two kinds of named change this platform holds: an unmet threshold, which names a figure
 *  and the line it missed, and a generic finding, which names a change because `finding_record`
 *  refuses one that proposes nothing.
 *
 *  Below the ceiling with nothing named is the distinction that matters: a plugin two points
 *  short with changes waiting is ordinary work, while one two points short with nothing
 *  identified is a measurement nobody has explained. */
export function headroom(score: number | null, unmetThresholds: number, genericFindings: number): Headroom {
  const named = unmetThresholds + genericFindings;
  const points = score === null ? null : Math.round((10 - score) * 100) / 100;
  return { points, named_changes: named, state: headroomState(points, named) };
}
