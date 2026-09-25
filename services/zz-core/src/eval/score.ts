/**
 * `scoreRun` (Task I-12, AC-19.1–AC-23.1): the pure arithmetic that turns one run's per-measure
 * evidence into a run score. No database, no model call, no clock — the same input always
 * produces the same output, so every caller (round scoring, a replay, a check) gets an answer it
 * can recompute rather than one it has to trust.
 *
 * Two re-normalising sums, nested:
 *   - inside a dimension, over its measures — an optional measure with no value is dropped and
 *     the remaining weights re-normalised to 1; a *required* measure with no value makes the
 *     whole dimension's score `null` rather than silently shrinking the sum around the gap;
 *   - across dimensions, over the ones that are both `applicable` (a `false` one names why in
 *     `not_applicable_reason` and carries no weight here — see Dimension's own superRefine in
 *     `@zz/contracts`) and scored (not `null`) — the same drop-and-re-normalise shape, one level
 *     up. A missing dimension is not a zero: a zero would pull the average down for a gap in
 *     coverage, not in the plugin's own performance.
 *
 * `status` and `guardrail_status` are read off the same input, never off `overall`:
 * `established` needs every *required, applicable* dimension present AND `coverage_met` AND
 * `qualification_met` — unqualified evidence, however complete, cannot establish. A guardrail
 * failure changes `guardrail_status` only; AC-23.1 is explicit that the number must not move for
 * it, because a report that quietly re-averages the score away also throws away the reason a
 * guardrail firing needs to be looked at as its own thing.
 */

/** One weighted component of a dimension. `required: false` on a measure with no `value` is
 *  simply dropped from that dimension's sum; `required: true` with no `value` makes the whole
 *  dimension unscored — see the module doc for why a dimension is never partially covered. */
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
  /** Rounded to 4 decimals; `null` when not applicable or when a required measure is missing. */
  score: number | null;
  applicable: boolean;
}

interface ScoreRunOutput {
  /** Rounded to 2 decimals; `null` exactly when no dimension scored (`status === "not_established"`). */
  overall: number | null;
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

/** A required measure with no value makes the dimension `null` outright (AC-19.1); otherwise an
 *  optional missing measure is dropped and the rest re-normalised (AC-21.1). */
function dimensionScore(dim: DimensionInput): number | null {
  if (dim.measures.some((m) => m.required && m.value === null)) return null;
  const usable = dim.measures.filter((m): m is Measure & { value: number } => m.value !== null);
  const mean = weightedMean(usable.map((m) => ({ weight: m.weight, value: m.value })));
  return mean === null ? null : round(mean, 4);
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

  const dimensions: DimensionOutput[] = input.dimensions.map((dim) => ({
    key: dim.key,
    canonical_kind: dim.canonical_kind,
    score: dim.applicable ? dimensionScore(dim) : null,
    applicable: dim.applicable,
  }));

  // Applicable and scored — the same pair of exclusions the overall mean and the "is this
  // dimension present" check both apply, so status and overall never disagree about what counts.
  const applicable = input.dimensions.filter((dim) => dim.applicable);
  const scoredByKey = new Map(dimensions.map((d) => [d.key, d.score]));
  const present = applicable.filter((dim) => scoredByKey.get(dim.key) !== null);

  const overallMean = weightedMean(
    present.map((dim) => ({ weight: dim.weight, value: scoredByKey.get(dim.key) as number })),
  );
  const overall = overallMean === null ? null : round(overallMean * 10, 2);

  const requiredApplicable = applicable.filter((dim) => dim.required);
  const allRequiredPresent = requiredApplicable.length > 0
    && requiredApplicable.every((dim) => scoredByKey.get(dim.key) !== null);

  const status: ScoreRunOutput["status"] = allRequiredPresent && input.coverage_met && input.qualification_met
    ? "established"
    : present.length > 0
      ? "provisional"
      : "not_established";

  return { overall, status, dimensions, guardrail_status: guardrailStatus(input.guardrails) };
}
