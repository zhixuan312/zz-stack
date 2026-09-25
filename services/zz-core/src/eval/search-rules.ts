/**
 * Two rules every IMPROVE tool reads the same way, pure so `checks/eval-search-rules.ts` can
 * prove them on values alone.
 *
 * `parseSearchPolicy`: an improvement_run's own `search_policy` snapshot, or a refusal. There is
 * no fallback policy. A protocol's `improvement.search` is a required part of its schema, and
 * `improvement_start` refuses to open a run without a valid one, so a run carrying a malformed or
 * empty policy is a defect to name. It is not a run to validate with `minMeaningfulEffect: 0`,
 * which would read any positive delta as an improvement.
 *
 * `searchGeneration`: what "generation" means for `maxGenerations` and
 * `maxCandidatesPerGeneration`. It is the search's own round, and composition depth does not
 * count. Generation G is the run's highest recorded generation (0 before any candidate). It is
 * SETTLED once every candidate in it has a validation verdict or was rejected before one
 * (`rejected_precheck`/`invalid`). `candidate_record`, and `candidate_search`'s own composed
 * child, record into G while it is unsettled and into G + 1 once it settles. The cap counts the
 * candidates already in the generation a new one would join. A search has used up
 * `maxGenerations` once that many generations hold a validated candidate and the newest one has
 * settled. Selection then runs over settled evidence, never while candidates are still being
 * validated.
 */
import { SearchPolicy } from "@zz/contracts";

export function parseSearchPolicy(raw: unknown, improvementRunId: string): SearchPolicy | { error: string } {
  const parsed = SearchPolicy.safeParse(raw);
  if (parsed.success) return parsed.data;
  return {
    error: `ERROR: improvement_run ${improvementRunId} carries no valid search_policy ` +
      `(${parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ")}) — its protocol ` +
      "version's improvement.search must be recorded in full; open a fresh improvement_start " +
      "against a protocol that declares one",
  };
}

export interface GenerationMember {
  readonly generation: number;
  /** A stored validation verdict. */
  readonly validated: boolean;
  /** Rejected before validation could ever produce one. */
  readonly rejected: boolean;
}

export interface GenerationState {
  /** The generation a newly recorded candidate joins. */
  readonly next: number;
  /** How many candidates that generation already holds. */
  readonly nextCount: number;
  /** Generations holding at least one validated candidate. */
  readonly validatedGenerations: number;
  /** Every candidate in the highest generation has a verdict or was rejected. */
  readonly settled: boolean;
  readonly current: number;
}

export function searchGeneration(members: readonly GenerationMember[]): GenerationState {
  if (!members.length) return { next: 0, nextCount: 0, validatedGenerations: 0, settled: true, current: 0 };
  const current = Math.max(...members.map((m) => m.generation));
  const inCurrent = members.filter((m) => m.generation === current);
  const settled = inCurrent.every((m) => m.validated || m.rejected);
  const validatedGenerations = new Set(members.filter((m) => m.validated).map((m) => m.generation)).size;
  return settled
    ? { next: current + 1, nextCount: 0, validatedGenerations, settled, current }
    : { next: current, nextCount: inCurrent.length, validatedGenerations, settled, current };
}

/** Null when one more candidate fits the generation it would join; otherwise the refusal. */
export function generationCapRefusal(state: GenerationState, policy: SearchPolicy): string | null {
  if (state.settled && state.validatedGenerations >= policy.maxGenerations) {
    return `ERROR: this search has used all ${policy.maxGenerations} generations — call ` +
      "candidate_search to select from what was validated";
  }
  if (state.nextCount >= policy.maxCandidatesPerGeneration) {
    return `ERROR: generation ${state.next} already holds ${state.nextCount} candidates, the ` +
      `protocol's maxCandidatesPerGeneration — validate them (candidate_validate) before recording more`;
  }
  return null;
}
