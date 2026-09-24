/**
 * `paretoFrontier` and `selectFinal` (Task I-20, AC-38.1, AC-39.1, AC-42.1, AC-44.1, FR-57's own
 * frozen selection policy): the two pure functions `candidate_search` (`candidate-search.ts`)
 * reduces its own DB rows through, and the exact pair `checks/eval-selection.ts` imports off
 * `dist/eval/selection.js`. No I/O, no clock, no randomness — the same input always returns the
 * same frontier and the same winner, which is what "one frontier always yields one winner"
 * (this task's own technical AC) means in practice: two callers handed the same candidate set
 * never disagree about which one search selected.
 *
 * Kept apart from `candidate-search.ts`, the same split `stats.ts` keeps from
 * `candidate-validate.ts`: the decision rule is reasoned about and checked on its own, and the
 * database rows that feed it live in the file that actually queries them.
 */

// -------------------------------------------------------------------------------------------
// paretoFrontier (AC-38.1, AC-39.1): the non-dominated set over (per-case pass vector, cost).
// FR-39's own words — "may preserve a Pareto frontier" — never collapsed to one number before
// this runs; `selectFinal` below is what a protocol reduces the frontier to a single winner with.

export interface FrontierCandidate {
  readonly id: string;
  /** One entry per validation case, in the SAME case order for every candidate compared —
   *  `candidate-search.ts`'s own job to guarantee, never checked here (a length mismatch is
   *  simply never `>=` on every axis, so a caller who gets the order wrong loses candidates
   *  silently rather than crashing; that tradeoff belongs to the caller building this array). */
  readonly pass_vector: readonly number[];
  readonly cost: number;
}

/** `a` dominates `b` when it is at least as good on every pass-vector case AND at least as cheap,
 *  with a strict improvement somewhere — the standard multi-objective dominance rule, applied to
 *  "more passing cases, less cost" as the two axes this task's own contract names. */
function dominates(a: FrontierCandidate, b: FrontierCandidate): boolean {
  if (a.pass_vector.length !== b.pass_vector.length) return false;
  let strictlyBetter = false;
  for (let i = 0; i < a.pass_vector.length; i += 1) {
    if (a.pass_vector[i] < b.pass_vector[i]) return false;
    if (a.pass_vector[i] > b.pass_vector[i]) strictlyBetter = true;
  }
  if (a.cost > b.cost) return false;
  if (a.cost < b.cost) strictlyBetter = true;
  return strictlyBetter;
}

/** Every candidate no other candidate in the same set dominates — O(n^2), fine at this task's
 *  own liveness bound (FR-57: at most 8 candidates per generation, 5 generations). Returns a
 *  `Set`, not an array: frontier membership is the only question a caller asks of this, and a
 *  `Set` makes "is this id on the frontier" an O(1) lookup for `selectFinal`'s own callers. */
export function paretoFrontier(cands: readonly FrontierCandidate[]): ReadonlySet<string> {
  const kept = new Set<string>();
  for (const c of cands) {
    const dominated = cands.some((other) => other.id !== c.id && dominates(other, c));
    if (!dominated) kept.add(c.id);
  }
  return kept;
}

// -------------------------------------------------------------------------------------------
// selectFinal (AC-42.1, AC-44.1, FR-57's own frozen tie-break order): exactly one candidate out
// of a validation frontier, or null when nothing clears the guardrail floor — never a second,
// unwritten judgement call, because FR-42's own words are "the runner never chooses by ad-hoc
// judgement."

export interface SelectionCandidate {
  readonly id: string;
  readonly guardrails_pass: boolean;
  /** The lower bound of the paired-bootstrap interval of overall-score improvement
   *  (`stats.ts`'s `pairedDecision().lower`) — FR-57's own "maximize the lower bound", never the
   *  mean, so a candidate whose interval is wide is never preferred merely because its point
   *  estimate looks better than a tighter, more certain one. */
  readonly lower_bound: number;
  readonly complexity_delta: number;
  readonly latency_delta: number;
  readonly cost_delta: number;
}

/** FR-57's own selection policy, word for word: "among validation candidates whose required
 *  guardrails pass, maximize the lower bound of overall-score improvement; candidates within
 *  [band] points are treated as equivalent, then prefer lower complexity delta, lower latency
 *  delta, lower cost delta and finally stable candidate id." `band` is the protocol's own
 *  `equivalenceBand` (`SearchPolicy`, `@zz/contracts`) — 0.1 for the bootstrap zz-core protocol,
 *  never hard-coded here so a different protocol's own value is honoured without a second
 *  function.
 *
 *  A guardrail failure excludes a candidate from consideration OUTRIGHT (FR-23's own
 *  non-compensation), whatever its lower_bound reads — never merely penalised, because a failing
 *  guardrail is not a quality axis to trade off against the others. */
export function selectFinal(cands: readonly SelectionCandidate[], band: number): string | null {
  const passing = cands.filter((c) => c.guardrails_pass);
  if (!passing.length) return null;

  const maxLower = Math.max(...passing.map((c) => c.lower_bound));
  const equivalent = passing.filter((c) => maxLower - c.lower_bound <= band);

  equivalent.sort((a, b) =>
    a.complexity_delta - b.complexity_delta ||
    a.latency_delta - b.latency_delta ||
    a.cost_delta - b.cost_delta ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return equivalent[0].id;
}
