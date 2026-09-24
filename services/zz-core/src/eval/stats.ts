/**
 * `pairedDecision` (Task I-19, AC-40.1, AC-41.1): the pure statistics `candidate_validate` (and
 * this file's own `checks/eval-paired-stats.ts`) turn one candidate's paired per-case deltas
 * into a three-way verdict. No database, no clock, no model call — the same `deltas`, `mme` and
 * `opts` always produce the same interval, so a candidate's own verdict can be recomputed by
 * anyone reading the stored statistics rather than trusted blind.
 *
 * A percentile bootstrap of the mean, not a normal-theory interval: `deltas` is one value per
 * matched validation case (candidate mean repeats − baseline mean repeats, `candidates.ts`'s own
 * job to build), usually few enough cases that a normal approximation is a worse bet than
 * resampling the cases themselves. `resamples`/`confidence` are the protocol's own
 * `SearchPolicy` numbers (`@zz/contracts`), never fixed here.
 *
 * Seeded (`seed`: the first 8 hex of `sha256(seed)`, fed to `mulberry32`) so two calls against
 * the same inputs produce byte-identical output — AC-41.1's own "seeded, reproducible" clause,
 * and what lets `candidate_validate` re-run the same statistics on a retry without drawing a new
 * random sample each time.
 */
import { createHash } from "node:crypto";

interface PairedDecisionOpts {
  readonly resamples: number;
  readonly seed: string;
  readonly confidence: number;
}

export interface PairedDecisionResult {
  readonly mean: number;
  readonly lower: number;
  readonly upper: number;
  readonly verdict: "improves" | "not_improved" | "unresolved";
}

/** mulberry32: a small, fast, deterministic PRNG — good enough for a bootstrap resample (no
 *  cryptographic property is needed here, only "the same seed always draws the same sequence"). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** AC-41.1's own seeding rule: the first 8 hex characters of `sha256(seed)`, read as a 32-bit
 *  integer — never the raw seed string, so two callers naming the same seed always draw the same
 *  sequence regardless of how `seed` itself was chosen (a run id, a fixed string, anything). */
function seedFrom(seed: string): number {
  const hex = createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 8);
  return parseInt(hex, 16);
}

function mean(xs: readonly number[]): number {
  return xs.reduce((sum, x) => sum + x, 0) / xs.length;
}

/** One percentile-bootstrap interval of the mean of `deltas`, and the verdict it implies against
 *  `mme` (the protocol's own minimum meaningful effect): `improves` when even the interval's
 *  lower bound clears `mme`, `not_improved` when even the upper bound falls short of it,
 *  `unresolved` when the interval straddles `mme` — more evidence (more repeats, more cases)
 *  would be needed to tell the two apart. Never a two-sided "did it move" test: the whole point
 *  of `mme` is that a real but trivial improvement is not worth the complexity/risk a release
 *  costs (spec's own framing of the improvement search). */
export function pairedDecision(
  deltas: readonly number[], mme: number, opts: PairedDecisionOpts,
): PairedDecisionResult {
  const n = deltas.length;
  const draw = mulberry32(seedFrom(opts.seed));
  const bootstrapMeans: number[] = [];
  for (let i = 0; i < opts.resamples; i += 1) {
    const sample: number[] = [];
    for (let j = 0; j < n; j += 1) sample.push(deltas[Math.floor(draw() * n)]);
    bootstrapMeans.push(mean(sample));
  }
  bootstrapMeans.sort((a, b) => a - b);

  const alpha = 1 - opts.confidence;
  const lowerIdx = Math.min(Math.max(Math.floor((alpha / 2) * opts.resamples), 0), opts.resamples - 1);
  const upperIdx = Math.min(Math.max(Math.ceil((1 - alpha / 2) * opts.resamples) - 1, 0), opts.resamples - 1);
  const lower = bootstrapMeans[lowerIdx];
  const upper = bootstrapMeans[upperIdx];

  const verdict: PairedDecisionResult["verdict"] =
    lower > mme ? "improves" : upper < mme ? "not_improved" : "unresolved";

  return { mean: mean(deltas), lower, upper, verdict };
}
