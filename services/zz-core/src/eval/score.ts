/**
 * `scoreRun` (Task I-12, AC-19.1–AC-23.1): the pure arithmetic that turns one run's per-measure
 * evidence into a run score. No database, no model call, no clock — the same input always
 * produces the same output, so every caller (round scoring, a replay, a check) gets an answer it
 * can recompute rather than one it has to trust.
 *
 * Two re-normalising sums, nested, each reporting how much of what it was asked to cover it
 * actually covered:
 *   - inside a dimension, over its measures — a measure with no value (required or not) is
 *     dropped and the remaining weights re-normalised to 1. The dimension reports `coverage`:
 *     scored measure weight over declared measure weight. One excluded measure never nulls a
 *     dimension whose other measures were scored; it lowers that dimension's coverage, and the
 *     run's status reads the coverage;
 *   - across dimensions, over the ones that are both `applicable` (a `false` one names why in
 *     `not_applicable_reason` and carries no weight here — see Dimension's own superRefine in
 *     `@zz/contracts`) and scored (at least one measure) — the same drop-and-re-normalise shape,
 *     one level up, with the run's `coverage` the dimension-weighted mean of the applicable
 *     dimensions' coverage. A missing dimension is not a zero: a zero would pull the average
 *     down for a gap in coverage, not in the plugin's own performance.
 *
 * `overall` is null ONLY when no dimension scored anything. `status` and `guardrail_status` are
 * read off the same input, never off `overall`: `established` needs every required measure of
 * every *required, applicable* dimension scored AND `coverage_met` AND `qualification_met` —
 * unqualified evidence, however complete, cannot establish; `provisional` needs a number, a
 * run coverage at or above `PROVISIONAL_COVERAGE_FLOOR`, AND `coverage_met` — the protocol's own
 * evidence floor. Below that floor a number is still reported, never labelled provisional: zz-access,
 * on 10 calls and no run, read "provisional 8.0" beside a reliability of 1.0 over 2 refusals.
 * Anything else is `not_established`,
 * which may still carry the number it has, so a reader sees what was measured beside how little
 * of the protocol that was. A guardrail failure changes `guardrail_status` only; AC-23.1 is
 * explicit that the number must not move for it, because a report that quietly re-averages the
 * score away also throws away the reason a guardrail firing needs to be looked at as its own
 * thing.
 */

/** The run coverage below which a number is reported but not called even provisional: under
 *  half the protocol's declared weight scored is a reading of a different, smaller protocol.
 *  Echoed on every output so a reader knows which floor was applied. */
export const PROVISIONAL_COVERAGE_FLOOR = 0.5;

/** One weighted component of a dimension. A measure with no `value` is dropped from that
 *  dimension's sum and lowers its coverage; `required: true` with no `value` also withholds
 *  `established` — see the module doc. */
interface Measure {
  weight: number;
  required: boolean;
  value: number | null;
}

/** One canonical scoring dimension as this run measured it. `applicable: false` excludes the
 *  dimension from both sums below; `not_applicable_reason` is carried through to the output
 *  unchanged so a reader never has to ask why a dimension went quiet. */
interface DimensionInput {
  key: string;
  canonical_kind: string;
  weight: number;
  required: boolean;
  applicable: boolean;
  not_applicable_reason: string | null;
  measures: Measure[];
}

interface ScoreRunInput {
  dimensions: DimensionInput[];
  coverage_met: boolean;
  qualification_met: boolean;
  guardrails: ("pass" | "fail" | "not_established")[];
}

interface DimensionOutput {
  key: string;
  canonical_kind: string;
  /** Rounded to 4 decimals; `null` when not applicable or when no measure scored. */
  score: number | null;
  applicable: boolean;
  /** Scored measure weight over declared measure weight, 4 decimals; `null` when not applicable. */
  coverage: number | null;
}

interface ScoreRunOutput {
  /** Rounded to 2 decimals; `null` exactly when no dimension scored. */
  overall: number | null;
  /** Dimension-weighted mean of the applicable dimensions' coverage, 4 decimals; `null` when no
   *  dimension is applicable. */
  coverage: number | null;
  /** `PROVISIONAL_COVERAGE_FLOOR`, echoed. */
  coverage_floor: number;
  status: "established" | "provisional" | "not_established";
  dimensions: DimensionOutput[];
  guardrail_status: "pass" | "fail" | "not_established";
}

const round = (v: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(v * factor) / factor;
};

/** Weighted mean over whatever survives dropping, re-normalised so the survivors' weights sum
 *  to 1 — the one shape both the measure sum and the dimension sum share. `null` in means
 *  "excluded here", never "counts as zero". */
function weightedMean(items: { weight: number; value: number }[]): number | null {
  const totalWeight = items.reduce((sum, i) => sum + i.weight, 0);
  // `<= 0`, not `=== 0`: the protocol schema refuses a non-positive weight, but a total at or
  // below zero reaching here would divide into a sign-flipped or infinite mean rather than none.
  if (items.length === 0 || !(totalWeight > 0) || !Number.isFinite(totalWeight)) return null;
  return items.reduce((sum, i) => sum + (i.weight / totalWeight) * i.value, 0);
}

/** A dimension's score over whichever of its measures have a value, re-normalised (AC-21.1),
 *  and its coverage: the scored share of its declared measure weight. */
function dimensionScore(dim: DimensionInput): { score: number | null; coverage: number } {
  const usable = dim.measures.filter((m): m is Measure & { value: number } => m.value !== null);
  const mean = weightedMean(usable.map((m) => ({ weight: m.weight, value: m.value })));
  const declared = dim.measures.reduce((sum, m) => sum + m.weight, 0);
  const scored = usable.reduce((sum, m) => sum + m.weight, 0);
  return {
    score: mean === null ? null : round(mean, 4),
    coverage: declared > 0 ? round(scored / declared, 4) : 0,
  };
}

function guardrailStatus(guardrails: ScoreRunInput["guardrails"]): ScoreRunOutput["guardrail_status"] {
  if (guardrails.includes("fail")) return "fail";
  if (guardrails.includes("not_established")) return "not_established";
  return "pass";
}

/** Pure and deterministic (AC-19.1–AC-23.1's shared invariant): same input, same output, every
 *  time. Throws `RangeError` on a measure value outside [0,1] or not finite — the one input this cannot make
 *  sense of rather than merely score badly. */
export function scoreRun(input: ScoreRunInput): ScoreRunOutput {
  for (const dim of input.dimensions) {
    for (const m of dim.measures) {
      // `!Number.isFinite` first: NaN compares false against both bounds and would otherwise
      // pass straight into the mean and come out as an overall of NaN.
      if (m.value !== null && (!Number.isFinite(m.value) || m.value < 0 || m.value > 1)) {
        throw new RangeError(`measure value ${m.value} in dimension "${dim.key}" is outside [0, 1]`);
      }
    }
  }

  const dimensions: DimensionOutput[] = input.dimensions.map((dim) => {
    const scored = dim.applicable ? dimensionScore(dim) : null;
    return {
      key: dim.key, canonical_kind: dim.canonical_kind,
      score: scored?.score ?? null, applicable: dim.applicable, coverage: scored?.coverage ?? null,
    };
  });

  // Applicable and scored — the same pair of exclusions the overall mean and the "is this
  // dimension present" check both apply, so status and overall never disagree about what counts.
  const applicable = input.dimensions.filter((dim) => dim.applicable);
  const outByKey = new Map(dimensions.map((d) => [d.key, d]));
  const present = applicable.filter((dim) => outByKey.get(dim.key)?.score !== null);

  const overallMean = weightedMean(
    present.map((dim) => ({ weight: dim.weight, value: outByKey.get(dim.key)!.score as number })),
  );
  const overall = overallMean === null ? null : round(overallMean * 10, 2);
  const coverageMean = weightedMean(
    applicable.map((dim) => ({ weight: dim.weight, value: outByKey.get(dim.key)!.coverage ?? 0 })),
  );
  const coverage = coverageMean === null ? null : round(coverageMean, 4);

  const requiredApplicable = applicable.filter((dim) => dim.required);
  const requiredComplete = requiredApplicable.length > 0
    && requiredApplicable.every((dim) => dim.measures.every((m) => !m.required || m.value !== null)
      && outByKey.get(dim.key)?.score !== null);

  const status: ScoreRunOutput["status"] = requiredComplete && input.coverage_met && input.qualification_met
    ? "established"
    : overall !== null && coverage !== null && coverage >= PROVISIONAL_COVERAGE_FLOOR && input.coverage_met
      ? "provisional"
      : "not_established";

  return {
    overall, coverage, coverage_floor: PROVISIONAL_COVERAGE_FLOOR, status, dimensions,
    guardrail_status: guardrailStatus(input.guardrails),
  };
}
