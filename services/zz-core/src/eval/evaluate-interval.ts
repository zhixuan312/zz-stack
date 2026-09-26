/**
 * `evaluation_score`'s interval: "percentile bootstrap over subjects per the protocol's
 * `UncertaintyPolicy`" (Task I-13's own contract). Pure — no database, no clock, no `Math.random`
 * — so a replay of the same per-subject scores reproduces the same interval bit for bit, the
 * same determinism `score.ts` itself is built around.
 *
 * `UncertaintyPolicy` is `FreeformRecord` (spec v8 fixes no shape for it): `seed` (string,
 * defaults to the eval_run's own id — see `evaluate.ts`'s caller), `iterations` (defaults 1000)
 * and `level` (defaults 0.95) are the three keys this file reads, defaulted rather than required,
 * the same posture `qualify-ladder.ts`'s `resolveThresholds` takes toward a freeform policy
 * object.
 */

/** mulberry32 — a small, seeded, deterministic PRNG. Not cryptographic; a bootstrap resample
 *  needs reproducibility, not unpredictability. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A string seed reduced to mulberry32's 32-bit integer seed — deterministic and collision-cheap
 *  enough for a bootstrap resample, never used for anything security-sensitive. */
function seedFrom(text: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

interface UncertaintySettings {
  readonly seed: string;
  readonly iterations: number;
  readonly level: number;
}

/** `UncertaintyPolicy`'s three keys, defaulted key by key — never a silent 0 or a thrown error
 *  over a malformed or absent policy object. */
export function resolveUncertainty(
  raw: Readonly<Record<string, unknown>> | undefined, runId: string,
): UncertaintySettings {
  const seed = typeof raw?.seed === "string" && raw.seed.trim() ? raw.seed : runId;
  const iterations = typeof raw?.iterations === "number" && raw.iterations > 0 ? Math.floor(raw.iterations) : 1000;
  const level = typeof raw?.level === "number" && raw.level > 0 && raw.level < 1 ? raw.level : 0.95;
  return { seed, iterations, level };
}

interface ScoreInterval {
  readonly lower: number | null;
  readonly upper: number | null;
  readonly level: number;
  readonly iterations: number;
  readonly n_subjects: number;
  readonly degenerate: boolean;
  readonly note: string | null;
}

/** Percentile bootstrap of the run's OWN statistic: resample the subjects with replacement and
 *  recompute the overall from each resample, exactly as the run's overall is computed from all of
 *  them. The earlier form bootstrapped the mean of each subject's own overall — a different
 *  estimator, since a document subject scored on document measures alone and a run subject on run
 *  measures alone — and its interval (8.61-8.78) did not contain the overall it described (8.26).
 *  Fewer than two subjects makes a resample meaningless, so that case is named `degenerate`
 *  rather than silently narrowed to a zero-width interval. A resample the statistic cannot score
 *  is left out of the percentiles and counted in the note. */
export function bootstrapInterval(
  nSubjects: number, statistic: (indices: readonly number[]) => number | null,
  settings: UncertaintySettings,
): ScoreInterval {
  const all = Array.from({ length: nSubjects }, (_, i) => i);
  if (nSubjects === 0) {
    return { lower: null, upper: null, level: settings.level, iterations: settings.iterations,
              n_subjects: 0, degenerate: true, note: "no subject was scored" };
  }
  if (nSubjects === 1) {
    const only = statistic(all);
    return { lower: only, upper: only, level: settings.level, iterations: settings.iterations,
              n_subjects: 1, degenerate: true,
              note: "one subject scored — a bootstrap over a single value has nothing to resample" };
  }
  const rand = mulberry32(seedFrom(settings.seed));
  const values: number[] = [];
  for (let it = 0; it < settings.iterations; it++) {
    const pick = all.map(() => Math.floor(rand() * nSubjects));
    const v = statistic(pick);
    if (v !== null) values.push(v);
  }
  if (values.length < 2) {
    return { lower: null, upper: null, level: settings.level, iterations: settings.iterations,
              n_subjects: nSubjects, degenerate: true, note: "no resample of the subjects could be scored" };
  }
  values.sort((a, b) => a - b);
  const tail = (1 - settings.level) / 2;
  const at = (q: number) => values[Math.min(values.length - 1, Math.max(0, Math.floor(q * values.length)))];
  const unscored = settings.iterations - values.length;
  return {
    lower: at(tail), upper: at(1 - tail), level: settings.level, iterations: settings.iterations,
    n_subjects: nSubjects, degenerate: false,
    note: unscored ? `${unscored} resample(s) scored nothing and are left out` : null,
  };
}
