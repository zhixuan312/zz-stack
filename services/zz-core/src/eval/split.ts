/**
 * The three-way split (Task I-14, FR-27, FR-57, AC-24.1–AC-27.1): pure, offline, no database —
 * `checks/eval-replay-split.ts` (plan-authored) drives this file directly against fixed cases.
 *
 * `assignSplits` is the whole rule: order every REPLAYABLE case by `sha256(seed + case_digest)`
 * ascending (a lexical sort over the hex digest, never a numeric one — two digests never tie in
 * practice, and a tie is broken by leaving the input order alone, which is what `Array.sort`'s
 * own stability already gives for equal comparator results), take the first `floor(evolve*n)` for
 * `evolve`, the next `floor(validation*n)` for `validation`, and everything left over for `proof`
 * — never a third `floor`, so rounding error always lands on `proof` rather than vanishing or
 * double-counting. A `not_replayable` case (FR-60 rule 7) gets `null`: it is recorded, but it
 * belongs to no split and to none of `minimumsMet`'s counts (FR-27's own words).
 *
 * Deterministic in `seed` alone: the same `(cases, seed, policy)` triple produces the same `Map`,
 * key for key and in the same insertion order, every time — `replay_case_set_build` (this task's
 * mutator) relies on that to make a case-set version's split reproducible from what it already
 * stored (`split_seed`), never from anything computed only once and then forgotten.
 */
import { createHash } from "node:crypto";

/** One case going into the split, reduced to what the split itself needs. `case_digest` is
 *  `zz.replay_case.case_digest` (FR-60's own formula, computed in `replay-derive.ts`); `replayable`
 *  is `status === "replayable"`, computed the same place. */
export interface SplitCase {
  readonly case_digest: string;
  readonly replayable: boolean;
}

/** The FR-57 `splitPolicy` shape (`packages/contracts/src/eval-protocol.ts`'s
 *  `ThreeWaySplitPolicy`), read straight off a protocol version's `replay_policy` column — this
 *  file never invents a default weighting or a default minimum of its own. */
export interface SplitPolicy {
  readonly evolve: number;
  readonly validation: number;
  readonly proof: number;
  readonly min: {
    readonly evolve: number;
    readonly validation: number;
    readonly proof: number;
  };
}

type SplitAssignment = "evolve" | "validation" | "proof";

/** `sha256(seed + case_digest)`, hex — string concatenation, exactly as the plan-authored check
 *  computes its own expected order, so the two never disagree about what "ascending" sorts on. */
function orderingKey(seed: string, caseDigest: string): string {
  return createHash("sha256").update(seed + caseDigest).digest("hex");
}

/** FR-27's split, computed once over every case in a case-set version. Every `case_digest` in
 *  `cases` is a key of the returned map — a `not_replayable` one maps to `null`, never omitted,
 *  so `map.get(x) === undefined` always means "not a case in this set" rather than "not split". */
export function assignSplits(
  cases: readonly SplitCase[], seed: string, policy: SplitPolicy,
): Map<string, SplitAssignment | null> {
  const out = new Map<string, SplitAssignment | null>();

  const replayable = cases.filter((c) => c.replayable);
  const ordered = [...replayable].sort((a, b) => {
    const ka = orderingKey(seed, a.case_digest);
    const kb = orderingKey(seed, b.case_digest);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  const n = ordered.length;
  const evolveCount = Math.floor(policy.evolve * n);
  const validationCount = Math.floor(policy.validation * n);
  ordered.forEach((c, i) => {
    out.set(c.case_digest, i < evolveCount ? "evolve" : i < evolveCount + validationCount ? "validation" : "proof");
  });

  // Not-replayable cases are recorded after the split, never sorted into it — FR-60 rule 7's
  // "never assigned to any split" holds by construction, not by a later filter.
  for (const c of cases) {
    if (!c.replayable) out.set(c.case_digest, null);
  }
  return out;
}

/** FR-27/FR-57's floor: whether each pool cleared the protocol's own minimum count. Pure
 *  comparison — no `total` recomputation, because `counts` already excludes `not_replayable`
 *  cases (they were never in a split to begin with). */
export function minimumsMet(
  counts: { readonly evolve: number; readonly validation: number; readonly proof: number },
  policy: SplitPolicy,
): boolean {
  return counts.evolve >= policy.min.evolve
    && counts.validation >= policy.min.validation
    && counts.proof >= policy.min.proof;
}
