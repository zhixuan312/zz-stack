/**
 * `planSearch` — the scope-restriction plan a native retrieval call would follow, worked out without
 * touching a database.
 *
 * An initiative, flow or tag restriction is applied server-side to every lane, neighbour expansion,
 * broadening pass, count and dereference, before ranking and caps. Where the mapping is not
 * implemented the call refuses with a typed `unsupported_filter`: a scope restriction is never
 * dropped to make a call succeed.
 *
 * A plan, not a query. `lanesFor` (`tenant-projections.ts`) is the routing decision a real retrieval
 * call would make before it queries anything, and this is the next step in that same planning
 * phase. `services/zz-core/src/tenant-info/search.ts` is the database-bound composition. Nothing
 * here issues a statement, and nothing here is evidence that scoped native retrieval works end to
 * end.
 *
 * `initiative` and `flow` refuse today because `zz.search_current`/`evidence`/
 * `history` — the tables every lane in `lanes.ts` queries — carry `type` and `tags` but no
 * `initiative` or `flow` column. `zz.doc_artifact` carries `initiative` and no native table carries
 * `flow`, and nothing in the lane, neighbour, broadening or count stages joins to it. COUPLED:
 * `searchTenantInformation`'s `hardPredicatesFrom` makes the same call for the live path.
 */
import { parseQuery, type QueryClause } from "./query-grammar.js";
import { lanesFor } from "./tenant-projections.js";

interface PlanFilters {
  readonly initiative?: string;
  readonly flow?: string;
  readonly tag?: string;
}

interface StagePlan {
  readonly name: string;
  /** Which of the caller's scope restrictions this stage applies server-side, before ranking and
   *  caps. `tag` is the only member because `tag` is the only scope filter with a native mapping;
   *  `initiative` and `flow` are refused outright above, so a stage reporting them applied would be
   *  reporting work no stage had done. `false` means the caller did not restrict by tag, not that a
   *  restriction was dropped. */
  readonly appliedFilters: { readonly tag: boolean };
  /** Always `false` here: this planning layer has no ranking and no cap to filter a pool after, so
   *  nothing in this module has a code path that could set it otherwise. */
  readonly filteredAfterCap: false;
}

interface PlanSearchResult {
  /** Set only on the honest refusal below: a requested filter this call cannot map
   *  server-side today. Absent on every other return. */
  readonly status?: "unsupported_filter";
  readonly reason?: string;
  /** Never populated here: this is a plan, not a query. */
  readonly items?: readonly never[];
  readonly lanes: readonly StagePlan[];
  readonly neighbours: readonly StagePlan[];
  readonly rescues: readonly StagePlan[];
  readonly counts: readonly StagePlan[];
  /** Reported from this function's own, trusted knowledge of what it just planned — never a
   *  caller-supplied flag echoed back. `source: "server"` is the one word a caller checks to
   *  tell the two apart. */
  readonly effective_filters?: {
    readonly source: "server";
    readonly initiative: string | null;
    readonly flow: string | null;
    readonly tag: string | null;
  };
}

/** The two scope filters that have no server-side mapping onto the native lane/neighbour/
 *  broadening/count stages yet, and why — reasons a refusal can quote verbatim rather than a
 *  caller having to go find `hardPredicatesFrom` itself. Kept as a lookup rather than a list so
 *  a filter added here without a reason is a type error, not an oversight. */
const UNMAPPED_SCOPE_FILTER_REASONS: Record<"initiative" | "flow", string> = {
  initiative:
    "zz.search_current/evidence/history carry no initiative column for a lane to filter on, " +
    "and zz.doc_artifact's own initiative column is not joined into any lane, neighbour, " +
    "broadening or count/dereference pass this call plans — answering as if it had been " +
    "applied would return another initiative's documents inside a scoped search",
  flow:
    "zz.search_current/evidence/history carry no flow column for a lane to filter on, and no " +
    "native table this call plans over carries one at all — not even zz.doc_artifact, which " +
    "was never given one — so there is nothing server-side to map this filter onto",
};

function unmappedScopeFilter(filters: PlanFilters): "initiative" | "flow" | undefined {
  if (filters.initiative !== undefined) return "initiative";
  if (filters.flow !== undefined) return "flow";
  return undefined;
}

/** An unquoted positive term — the one clause kind the legacy broadening pass
 *  (`services/zz-core/src/tools/knowledge-search.ts`'s `mayRelax`) ever relaxes. A quoted phrase, an
 *  exclusion and an explicit `OR` alternation all stay mandatory whether or not broadening was
 *  asked for. */
function hasRelaxableClause(clauses: readonly QueryClause[]): boolean {
  return clauses.some((c) => c.kind === "term");
}

const NO_STAGES: readonly StagePlan[] = [];

/**
 * Plans the scope restriction for one query: which native lanes it reaches (`lanesFor`), whether a
 * neighbour-expansion or broadening pass would run over them, and whether the caller's `filters`
 * can be honoured server-side at every one of those stages plus the count and dereference pass that
 * follows. It never ranks or caps anything.
 *
 * Refuses whole, never partially: if any requested filter has no server-side mapping today, the
 * entire call returns `status: "unsupported_filter"` with no stages and no items.
 *
 * A query no lane reaches gets an empty `lanes` array and empty `neighbours`/`counts` arrays beside
 * it — recorded as not applicable, never as zero results — rather than a stage fabricated for a
 * pass that would never run.
 */
export function planSearch(input: {
  readonly query: string;
  readonly filters?: PlanFilters;
  readonly broadened?: boolean;
}): PlanSearchResult {
  const filters = input.filters ?? {};
  const unmapped = unmappedScopeFilter(filters);
  if (unmapped) {
    return {
      status: "unsupported_filter",
      reason: `the ${unmapped} filter cannot be honoured server-side: ${UNMAPPED_SCOPE_FILTER_REASONS[unmapped]}`,
      lanes: NO_STAGES, neighbours: NO_STAGES, rescues: NO_STAGES, counts: NO_STAGES,
    };
  }

  const lanes = lanesFor(input.query);
  // Every filter reaching this point was already confirmed mappable above, so it is carried into
  // every stage below without exception. What a stage reports is what the caller asked for: a call
  // that restricted nothing reports nothing applied rather than claiming a restriction it was never
  // given.
  const appliedFilters = { tag: filters.tag !== undefined } as const;
  const stage = (name: string): StagePlan => ({ name, appliedFilters, filteredAfterCap: false });

  const laneStages = lanes.map((l) => stage(l.name));
  const hasLanes = laneStages.length > 0;
  const neighbourStages = hasLanes ? [stage("neighbours")] : NO_STAGES;
  const canBroaden = input.broadened === true
    && lanes.some((l) => l.name === "bm25")
    && hasRelaxableClause(parseQuery(input.query).clauses);
  const rescueStages = canBroaden ? [stage("lexical-broadened")] : NO_STAGES;
  const countStages = hasLanes ? [stage("candidate-count"), stage("dereference")] : NO_STAGES;

  return {
    lanes: laneStages, neighbours: neighbourStages, rescues: rescueStages, counts: countStages,
    effective_filters: {
      source: "server",
      initiative: filters.initiative ?? null,
      flow: filters.flow ?? null,
      tag: filters.tag ?? null,
    },
  };
}
