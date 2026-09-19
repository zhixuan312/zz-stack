/**
 * HOW GOOD IS IT, AND WHAT IS LEFT TO FIX — two questions, two numbers, deliberately separate.
 *
 * A round used to end in one word from a closed set: keep, keep-and-change, re-run,
 * not-evaluable, retire. That word is a DECISION and it was being read as a MEASUREMENT, which
 * it cannot be. "Keep" does not say whether a plugin is excellent or barely adequate, and a
 * reader who needs to know how good something is cannot get it out of a verb.
 *
 * THE TWO AXES ARE INDEPENDENT, and that is the whole design. A plugin scoring 9 can still have
 * something worth fixing; a plugin scoring 5 with nothing identifiable to do about it is a
 * different and worse situation than a 5 with three named changes waiting. Collapsing them into
 * one scale loses exactly the distinction a person needs to act:
 *
 *        high score + headroom   good, and there is a next move
 *        high score + none       leave it alone
 *        low  score + headroom   underperforming, and we know what to do
 *        low  score + none       underperforming and nobody knows why — the retire signal
 *
 * COMPUTED, NOT ASKED. Every input is already on the round and no model is anywhere in the
 * derivation. A number a model produced is one more thing a reader has to trust; arithmetic
 * over figures they can see is one they can disagree with. The weights below are a judgement
 * and they are written down here rather than buried in a caller, so disagreeing with them is a
 * one-line change and not an argument.
 */

/** The qualitative half against the quantitative half.
 *
 *  Quality leads because it is read from the artifacts themselves across every subject, while
 *  the thresholds are two or three lines somebody drew — coarse by construction, so one unmet
 *  line should move the score without dominating it. At 0.4 over three thresholds, one failing
 *  costs 1.3 points, which is a band boundary's worth and not a verdict on its own. */
const QUALITATIVE_WEIGHT = 0.6;
const QUANTITATIVE_WEIGHT = 0.4;

/** Below this, the ruler could not tell the right artifact from the wrong one and the
 *  qualitative half is noise. The same line round_scores already prints beside the gap — named
 *  once, here, so the score and the note cannot drift apart. */
const COLLAPSE_GAP = 1.5;

/** What a score MEANS, fixed before any round is read.
 *
 *  Bands drawn after seeing a number are bands fitted to it. These are the boundaries every
 *  report prints beside its own score, so a reader can check the label against the figure
 *  rather than take it. */
const BANDS = [
  { at: 8, label: "working well" },
  { at: 6, label: "working, with a defect worth fixing" },
  { at: 4, label: "underperforming, improvement available" },
  { at: 0, label: "not effective" },
] as const;

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
  verdict: string;
}

const band = (score: number): string =>
  BANDS.find((b) => score >= b.at)?.label ?? BANDS[BANDS.length - 1].label;

/** The effectiveness score, from figures the round already carries.
 *
 *  `qualMean` is on the platform's 1-5 scale and is rescaled, so a ruler whose dimensions all
 *  sit at 1 scores 0 rather than 2 — the floor of the scale is not a fifth of the way to good.
 */
export function effectiveness(
  qualMean: number | null, thresholdsMet: number, thresholdsTotal: number, gap: number | null,
): Effectiveness {
  if (gap !== null && gap < COLLAPSE_GAP) {
    return {
      score: null, band: "not measurable", qualitative: null, quantitative: null,
      basis: `the judge-on-trial gap is ${gap}, below the ${COLLAPSE_GAP} line — the ruler could ` +
             "not tell this plugin's work from another's, so every qualitative mean in this " +
             "round is noise and no score is computed from them",
    };
  }
  const qual = qualMean === null ? null : Math.round(((qualMean - 1) / 4) * 1000) / 100;
  const quant = thresholdsTotal ? Math.round((thresholdsMet / thresholdsTotal) * 1000) / 100 : null;
  // EITHER HALF ALONE IS THE WHOLE SCORE. A ruler of purely qualitative dimensions has no
  // thresholds to read, and one of purely quantitative dimensions is marked by no judge. Both
  // are legal rulers, and re-weighting a missing half to zero would score them as failures.
  const score = qual !== null && quant !== null
    ? Math.round((QUALITATIVE_WEIGHT * qual + QUANTITATIVE_WEIGHT * quant) * 100) / 100
    : qual ?? quant;
  if (score === null) {
    return { score: null, band: "not measurable", qualitative: null, quantitative: null,
             basis: "the round produced neither a qualitative mark nor a threshold" };
  }
  const parts = [
    qual !== null ? `qualitative ${qual} (mean ${qualMean} of 5)` : null,
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
 *  AN UNMET THRESHOLD AND A GENERIC FINDING ARE THE TWO KINDS OF NAMED CHANGE this platform
 *  holds. A threshold names a figure and the line it missed; a generic finding names a change
 *  and what it should move, because `finding_record` refuses one that proposes nothing. Anything
 *  else a reader might call an improvement is an opinion, and this counts evidence.
 *
 *  THE DISTINCTION THAT MATTERS IS BELOW THE CEILING WITH NOTHING NAMED. A plugin two points
 *  short with two changes waiting is ordinary work. A plugin two points short with nothing
 *  identified is not a plugin to fix — it is a measurement nobody has explained, and the next
 *  move is to find out why rather than to change anything. */
export function headroom(score: number | null, unmetThresholds: number, genericFindings: number): Headroom {
  const named = unmetThresholds + genericFindings;
  if (score === null) {
    return { points: null, named_changes: named,
             verdict: "no score, so no distance from one — the round could not measure this plugin" };
  }
  const points = Math.round((10 - score) * 100) / 100;
  // AT THE CEILING IS A REAL ANSWER. Zero actions is the correct outcome for a plugin that is
  // working, and a flow that cannot say so pads its own report.
  if (points <= 1 && named === 0) {
    return { points, named_changes: 0, verdict: "at the ceiling — nothing identified to improve" };
  }
  if (named === 0) {
    return {
      points, named_changes: 0,
      verdict: `${points} points below the ceiling and NOTHING IDENTIFIED — this is not a ` +
               "plugin to change, it is a measurement nobody has explained. The next move is " +
               "to find out where those points went, not to fix something",
    };
  }
  return {
    points, named_changes: named,
    verdict: `${points} points below the ceiling, with ${named} named change` +
             `${named === 1 ? "" : "s"} available (${unmetThresholds} unmet threshold` +
             `${unmetThresholds === 1 ? "" : "s"}, ${genericFindings} recorded finding` +
             `${genericFindings === 1 ? "" : "s"})`,
  };
}
