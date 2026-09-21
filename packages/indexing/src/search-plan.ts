/**
 * `planSearch` — the scope-restriction plan a native retrieval call would follow, worked out
 * without touching a database.
 *
 * TASK I-12'S CONTRACT (← AC-8.4): an initiative, flow or tag restriction is applied
 * server-side to EVERY lane, neighbour expansion, broadening pass, count and dereference,
 * before ranking and caps — and where the mapping is not implemented, the call refuses with a
 * typed `unsupported_filter` rather than answering with the restriction silently dropped. "A
 * scope restriction is never dropped to make a call succeed" is the Contract's own line, twice.
 *
 * WHY THIS IS A PLAN AND NOT A QUERY. `lanesFor` (`tenant-projections.ts`, I-11) is, by its own
 * header, "the routing decision a real retrieval call would make BEFORE it queries anything" —
 * pure, synchronous, no `ProjectionClient` involved. This function is the next step in that
 * same planning phase, not a live retrieval path: `services/zz-core/src/tenant-info/search.ts`
 * (`searchTenantInformation`) is the actual database-bound composition, and its own header
 * records why nothing calls it yet — migration 070's tables exist on this deployment and hold
 * zero rows, and `applyCommit`/`rebuildGeneration` have no production callers. This function
 * plans what a live call SHOULD do with a caller's scope filters, stage by stage; it issues no
 * statement, and nothing here is evidence that scoped native retrieval works end to end.
 *
 * WHY `initiative` AND `flow` REFUSE TODAY. `searchTenantInformation`'s own `hardPredicatesFrom`
 * already made this exact call for the live path and documented it: migration 070's
 * `zz.search_current`/`evidence`/`history` — the tables every lane in `lanes.ts` queries — carry
 * `type` and `tags` columns but no `initiative` or `flow` column for a lane to filter on.
 * `zz.doc_artifact` carries `initiative` (never `flow` — no native table does), but nothing in
 * the lane, neighbour, broadening or count/dereference stages this task scopes joins to it, and
 * there is no live-wiring task this one depends on that does either. Inventing that join here —
 * in a pure, synchronous function with no database client to run it against — would be exactly
 * the kind of unmapped filter this Contract forbids answering as if it had been applied. So both
 * refuse, the same way, until a mapping genuinely exists: honoured server-side or not at all.
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
  /** Which of the caller's scope restrictions this stage applies server-side, BEFORE ranking
   *  and caps. `tag` is the only member because `tag` is the only scope filter with a native
   *  mapping: `initiative` and `flow` are refused outright above, so a stage that reported
   *  them "applied" would be reporting work no stage had done — this field said exactly that,
   *  unconditionally and for both, on every stage it ever built. `false` means the caller did
   *  not restrict by tag, not that a restriction was dropped. */
  readonly appliedFilters: { readonly tag: boolean };
  /** Always `false` here: this planning layer has no ranking and no cap to filter a pool
   *  after — see this file's own header. A stage that ever set this `true` would be reporting
   *  exactly the shape of defect the Contract names by name ("never filters a truncated
   *  pool"), so nothing in this module has a code path that could set it otherwise. */
  readonly filteredAfterCap: false;
}

interface PlanSearchResult {
  /** Set only on the honest refusal below: a requested filter this call cannot map
   *  server-side today. Absent on every other return. */
  readonly status?: "unsupported_filter";
  readonly reason?: string;
  /** Never populated by this task — "final deliverable content is not in this plan" is this
   *  task's own boundary. Present in the shape so a later, database-bound caller has somewhere
   *  to put real results without this function's return shape changing under it. */
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
 *  (`services/zz-core/src/tools/knowledge-search.ts`'s own `mayRelax`) ever relaxes. A quoted
 *  phrase, an exclusion and an explicit `OR` alternation all stay mandatory whether or not
 *  broadening was asked for, exactly as that Contract already reads — this applies the same
 *  rule to the AST `lanesFor` itself already parses, rather than re-deriving it. */
function hasRelaxableClause(clauses: readonly QueryClause[]): boolean {
  return clauses.some((c) => c.kind === "term");
}

const NO_STAGES: readonly StagePlan[] = [];

/**
 * Plans the scope restriction for one query: which native lanes it reaches (`lanesFor`, I-11),
 * whether a neighbour-expansion or broadening pass would run over them, and whether the
 * caller's `filters` can be honoured server-side at every one of those stages plus the count
 * and dereference pass that follows — all before this function is ever asked to rank or cap
 * anything, because it never does either.
 *
 * REFUSES WHOLE, NEVER PARTIALLY. If ANY requested filter has no server-side mapping today,
 * the entire call returns `status: "unsupported_filter"` with no stages and no items — never a
 * result with that one restriction quietly missing from some of them. See this file's own
 * header for which filters that is today, and why.
 *
 * "RECORDED AS NOT APPLICABLE, NEVER AS ZERO RESULTS" — `lanesFor`'s own rule, inherited here:
 * a query no lane reaches gets an empty `lanes` array and empty `neighbours`/`counts` arrays
 * beside it (nothing to expand or count when nothing was found to expand or count from),
 * rather than a stage fabricated for a pass that would never run.
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
  // Every filter reaching this point was already confirmed mappable above, so it is carried
  // into every stage below without exception. What a stage reports is what the CALLER asked
  // for: a tag restriction reaches every lane, neighbour expansion, broadening pass and count
  // alike, and a call that restricted nothing reports nothing applied rather than claiming a
  // restriction it was never given.
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
