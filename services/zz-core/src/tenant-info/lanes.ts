/**
 * The four lane SQL builders, the graph traversal and the orchestrator that runs them.
 * `retrieval.ts` keeps the fusion primitives — `budgets`, `resultKey`, `rrf`,
 * `collapseBeforeCap` — which are pure arithmetic over positions.
 *
 * DELIBERATE: every lane builder binds `descriptor.owner_id` as an explicit `= $n` conjunct
 * in the statement it returns, rather than relying on `resolveCorpora` having already
 * authorized the descriptor. A partial index's `where` clause is an optimisation, not a
 * permission filter, and selecting owner_id is not a filtering predicate. Once per lane, not
 * once for all four.
 *
 * The lexical lane's BM25 index is per corpus partition, created by `ensureCorpus`
 * (`packages/indexing`'s tenant-projections.ts). The fuzzy lane's GiST trigram index,
 * `artifact_identifier_trgm`, is in the schema.
 */
import type {
  CorpusDescriptor, FusedResult, LaneBudgets, LaneKeyList, RankedRow, ResultIdentity, RetrievalClient,
} from "./retrieval.js";
import { budgets, collapseBeforeCap, resultKey, rrf, scopeTable } from "./retrieval.js";

// Shared query-building plumbing

export interface LaneQuery {
  readonly text: string;
  readonly params: readonly unknown[];
}

/** The analyzed-query shape this file consumes; `parseQuery` produces the real one.
 *
 *  DELIBERATE: `fuzzyCandidate` is singular, not a list. The GiST lane is a distance-ordered
 *  top-k over one term (`normalized_text <-> term`), and a multi-term scan would not use that
 *  index the same way. Picking the best identifier-shaped token is the query parser's job. */
export interface AnalyzedQuery {
  readonly exactCandidates: readonly string[];
  readonly fuzzyCandidate: string | null;
  readonly lexicalQuery: string;
}

/** Filters and exclusions every lane pushes down where the schema has the column for it.
 *  `initiative`/`flow` from the query grammar have no column in
 *  `zz.search_current/evidence/history`, so only `type`/`tags`/exclusion appear here. Tags are
 *  a filter here and the tie-break signal `search`'s final sort reads — never a recall lane. */
export interface HardPredicates {
  readonly type?: string;
  readonly tags?: readonly string[];
  readonly excludeArtifactIds?: readonly string[];
}

const LEXICAL_FUZZY_INSPECTION_LIMIT = 10000;
const GRAPH_EDGE_INSPECTION_LIMIT = 5000;
const REQUEST_DEADLINE_MS = 1800;
const FUZZY_MIN_LENGTH = 4;
const FUZZY_MAX_LENGTH = 256;
const FUZZY_SIMILARITY_THRESHOLD = 0.30;
/** The relation order the graph lane sorts by. */
const EDGE_KIND_ORDER = ["derived_from", "supersedes", "revision_of", "cites"] as const;

/** Appends `s.type =`/`s.tags &&`/`s.artifact_id <> all` conjuncts for whichever fields
 *  `predicates` actually carries — shared by every lane that joins to a scope table aliased
 *  `s`, so the three pushdown predicates are written once rather than four times. */
function pushHardPredicates(
  conjuncts: string[], bind: (v: unknown) => string, predicates: HardPredicates,
): void {
  if (predicates.type !== undefined) conjuncts.push(`s.type = ${bind(predicates.type)}`);
  if (predicates.tags && predicates.tags.length > 0) {
    conjuncts.push(`s.tags && ${bind(predicates.tags)}::text[]`);
  }
  if (predicates.excludeArtifactIds && predicates.excludeArtifactIds.length > 0) {
    conjuncts.push(`s.artifact_id <> all(${bind(predicates.excludeArtifactIds)}::uuid[])`);
  }
}

interface LaneRow {
  readonly owner_id: string;
  readonly artifact_id: string;
  readonly revision: number;
  readonly content_hash: string;
  readonly tags: readonly string[] | null;
}

// Exact lane: equality over extracted identifiers

/**
 * Equality over canonical identifier entries. `candidates` are the query parser's own
 * normalized identifier/path/title candidates; this function does no normalization. Joins
 * `zz.artifact_identifier` back to the scope table for `content_hash`/`tags`/authorization
 * columns, and carries `ai.owner_id = $n` in its own text.
 */
export function buildExactLaneQuery(
  descriptor: CorpusDescriptor, candidates: readonly string[], predicates: HardPredicates, cap: number,
): LaneQuery {
  const table = scopeTable(descriptor.scope);
  const params: unknown[] = [];
  const bind = (v: unknown): string => `$${params.push(v)}`;
  const conjuncts = [
    `ai.corpus_key = ${bind(descriptor.corpus_key)}`,
    `ai.owner_id = ${bind(descriptor.owner_id)}`,
    `ai.scope = ${bind(descriptor.scope)}`,
    `ai.normalized_text = any(${bind(candidates)}::text[])`,
  ];
  pushHardPredicates(conjuncts, bind, predicates);
  const revisionJoin = descriptor.scope === "history" ? " and s.revision = ai.revision" : "";
  const limitParam = bind(cap);
  return {
    text: "select s.owner_id, s.artifact_id, s.revision, s.content_hash, s.tags, ai.identifier_text "
      + `from zz.artifact_identifier ai join ${table} s `
      + `on s.corpus_key = ai.corpus_key and s.owner_id = ai.owner_id and s.artifact_id = ai.artifact_id${revisionJoin} `
      + `where ${conjuncts.join(" and ")} `
      + `order by ai.identifier_text, s.artifact_id, s.revision `
      + `limit ${limitParam}`,
    params,
  };
}

// Lexical lane: pg_textsearch BM25 over the whole-artifact projection



/**
 * The concrete partition a corpus lives in, and the BM25 index built on it.
 *
 * DELIBERATE: the lexical lane scans the partition, not the parent table `scopeTable` names.
 * `to_bm25query(query, index_name)` requires the named index to be on the relation being
 * scanned, and PostgreSQL refuses a partition's index against the parent:
 *
 *     ERROR: index "search_current_default_bm25" is not on column "raw_body"
 *     HINT:  ... or omit the index name to use automatic index resolution.
 *
 * Taking that hint would let the planner resolve an index of its choosing, so the IDF would
 * come from whatever rows that index covers — the statistics sharing corpus isolation
 * forbids. Every other lane filters rows, where `corpus_key = $n` prunes to one partition and
 * the parent is the right relation to name.
 *
 * COUPLED: `ensureCorpus` in tenant-projections.ts spells these names too. The partition is
 * `<parent>_<key>` and an index on it is that name with dots flattened, plus a suffix.
 */
export function corpusPartition(scope: string, corpusKey: string): string {
  return `${scopeTable(scope)}_${corpusKey}`;
}

export function corpusBm25Index(scope: string, corpusKey: string): string {
  return `${corpusPartition(scope, corpusKey).replace(".", "_")}_bm25`;
}

/**
 * A `bm25query` is consumed by `<@>` in ORDER BY (pg_textsearch v1.4.0), which returns a
 * negative score, so an ascending scan is a descending relevance ranking. `@@` takes a
 * `tsquery` and does boolean filtering; the operator does not exist for a `bm25query`.
 *
 * DELIBERATE: there is no text predicate in the where clause. `<@>` plus LIMIT against a
 * `USING bm25` index is the top-k scan, and the extension's Block-Max WAND optimisation is
 * what makes it stop early; a boolean filter beside it asks the planner for a different,
 * slower plan. `corpus_key` and `owner_id` stay — they are the authorization boundary.
 *
 * `descriptor.index_name` is the registry's own field, never caller text: identifiers come
 * from the registry while values remain bound parameters.
 */
export function buildLexicalLaneQuery(
  descriptor: CorpusDescriptor, query: string, predicates: HardPredicates, cap: number,
): LaneQuery {
  // The concrete partition, not the parent — see `corpusPartition` above.
  const table = corpusPartition(descriptor.scope, descriptor.corpus_key);
  const params: unknown[] = [];
  const bind = (v: unknown): string => `$${params.push(v)}`;
  const corpusKey = bind(descriptor.corpus_key);
  const ownerId = bind(descriptor.owner_id);
  const conjuncts = [`s.corpus_key = ${corpusKey}`, `s.owner_id = ${ownerId}`];
  pushHardPredicates(conjuncts, bind, predicates);
  const scoreExpr = `s.raw_body <@> to_bm25query(${bind(query)}, ${bind(descriptor.index_name)})`;
  const limitParam = bind(cap);
  return {
    text: "select s.owner_id, s.artifact_id, s.revision, s.content_hash, s.tags "
      + `from ${table} s `
      + `where ${conjuncts.join(" and ")} `
      // DELIBERATE: ascending. `<@>` returns a negative BM25 score, so the most relevant row
      // is the most negative one. Descending returns the corpus's worst matches, and a test
      // that asserts on which rows come back rather than on the sign still passes.
      + `order by ${scoreExpr} `
      + `limit ${limitParam}`,
    params,
  };
}

// Fuzzy lane: GiST distance-ordered top-k over identifiers

/**
 * GiST distance-ordered top-k over canonical identifier entries, through `pg_trgm`'s
 * `<->`/`similarity()`. Fuzzy eligibility is 4–256 Unicode scalar values with similarity at
 * least 0.30. `term` is a single candidate; see `AnalyzedQuery.fuzzyCandidate`.
 */
export function buildFuzzyLaneQuery(
  descriptor: CorpusDescriptor, term: string, predicates: HardPredicates, cap: number,
): LaneQuery {
  const table = scopeTable(descriptor.scope);
  const params: unknown[] = [];
  const bind = (v: unknown): string => `$${params.push(v)}`;
  const termParam = bind(term);
  const conjuncts = [
    `ai.corpus_key = ${bind(descriptor.corpus_key)}`,
    `ai.owner_id = ${bind(descriptor.owner_id)}`,
    `ai.scope = ${bind(descriptor.scope)}`,
    `char_length(ai.normalized_text) between ${bind(FUZZY_MIN_LENGTH)} and ${bind(FUZZY_MAX_LENGTH)}`,
    `similarity(ai.normalized_text, ${termParam}) >= ${bind(FUZZY_SIMILARITY_THRESHOLD)}`,
  ];
  pushHardPredicates(conjuncts, bind, predicates);
  const revisionJoin = descriptor.scope === "history" ? " and s.revision = ai.revision" : "";
  const limitParam = bind(cap);
  return {
    text: "select s.owner_id, s.artifact_id, s.revision, s.content_hash, s.tags, ai.identifier_text "
      + `from zz.artifact_identifier ai join ${table} s `
      + `on s.corpus_key = ai.corpus_key and s.owner_id = ai.owner_id and s.artifact_id = ai.artifact_id${revisionJoin} `
      + `where ${conjuncts.join(" and ")} `
      + `order by ai.normalized_text <-> ${termParam} `
      + `limit ${limitParam}`,
    params,
  };
}

// Graph lane: one hop of typed, authorized edges

interface GraphEdgeRow {
  readonly source_owner_id: string;
  readonly source_artifact_id: string;
  readonly source_revision: number | null;
  readonly kind: "derived_from" | "cites" | "revision_of" | "supersedes";
  readonly target_owner_id: string;
  readonly target_artifact_id: string;
  readonly target_revision: number | null;
  readonly target_hash: string;
}

const KIND_CASE = `case kind ${EDGE_KIND_ORDER.map((k, i) => `when '${k}' then ${i + 1}`).join(" ")} else ${EDGE_KIND_ORDER.length + 1} end`;

/**
 * One hop of `zz.artifact_edge`, one direction per call. `direction: "as_target"` finds
 * neighbors that are `descriptor`'s own artifacts reached via an edge whose source is one of
 * `seeds` (any owner); `"as_source"` is the mirror.
 *
 * DELIBERATE: two single-direction, all-AND queries rather than one with a top-level OR.
 * `retracted_event_id is null` and the owner predicate stay plain `= $n` conjuncts that way,
 * the shape every other lane's owner predicate takes. This function reads `zz.artifact_edge`
 * and nothing else, so sharing an initiative creates no edge.
 */
export function buildGraphNeighborQuery(
  descriptor: CorpusDescriptor,
  direction: "as_target" | "as_source",
  seeds: readonly { readonly owner_id: string; readonly artifact_id: string }[],
  cap: number,
): LaneQuery {
  const params: unknown[] = [];
  const bind = (v: unknown): string => `$${params.push(v)}`;
  const ownerId = bind(descriptor.owner_id);
  const seedOwners = bind(seeds.map((s) => s.owner_id));
  const seedArtifacts = bind(seeds.map((s) => s.artifact_id));
  const ownColumn = direction === "as_target" ? "target_owner_id" : "source_owner_id";
  const otherOwnerColumn = direction === "as_target" ? "source_owner_id" : "target_owner_id";
  const otherArtifactColumn = direction === "as_target" ? "source_artifact_id" : "target_artifact_id";
  const conjuncts = [
    "retracted_event_id is null",
    `${ownColumn} = ${ownerId}`,
    `exists (select 1 from unnest(${seedOwners}::uuid[], ${seedArtifacts}::uuid[]) as seed(owner_id, artifact_id) `
      + `where seed.owner_id = ${otherOwnerColumn} and seed.artifact_id = ${otherArtifactColumn})`,
  ];
  const limitParam = bind(cap);
  return {
    text: "select source_owner_id, source_artifact_id, source_revision, kind, "
      + "target_owner_id, target_artifact_id, target_revision, target_hash "
      + "from zz.artifact_edge "
      + `where ${conjuncts.join(" and ")} `
      + `order by ${KIND_CASE}, target_owner_id, target_artifact_id `
      + `limit ${limitParam}`,
    params,
  };
}

/** The neighbor side of a graph row is `descriptor`'s own artifact — for `"as_target"` the
 *  edge's target fields, for `"as_source"` the source fields. `target_hash` is the hash
 *  asserted at that edge, which is what history identity needs: the cited revision, not the
 *  artifact's current head. No join back to the scope table is required. */
function neighborIdentity(row: GraphEdgeRow, direction: "as_target" | "as_source", scope: string): ResultIdentity {
  return direction === "as_target"
    ? { owner_id: row.target_owner_id, artifact_id: row.target_artifact_id, revision: row.target_revision ?? 0, content_hash: row.target_hash, scope }
    // DELIBERATE: empty, not guessed. An edge freezes the target's cited hash and carries no
    // `source_hash`, so an "as_source" neighbor's hash is not available from this row.
    // `resultKey` ignores it for every scope but `history`.
    : { owner_id: row.source_owner_id, artifact_id: row.source_artifact_id, revision: row.source_revision ?? 0, content_hash: "", scope };
}

// The orchestrator: run every lane, dedup-before-cap, fuse, tie-break

export interface SearchCandidate {
  readonly key: string;
  readonly identity: ResultIdentity;
  readonly score: number;
  readonly exact: boolean;
  readonly via: readonly string[];
  readonly corpora: readonly string[];
  readonly tags: readonly string[];
}

export type IncompleteReason = "inspection_budget" | "deadline";

export interface SearchOutcome {
  readonly candidates: readonly SearchCandidate[];
  readonly incomplete: boolean;
  readonly reasons: readonly IncompleteReason[];
}

interface CollectedEntry {
  identity: ResultIdentity;
  tags: string[];
  exact: boolean;
  via: Set<string>;
  corpora: Set<string>;
}

function toRankedRows(rows: readonly LaneRow[], scope: string): RankedRow<LaneRow>[] {
  return rows.map((row) => ({
    identity: {
      owner_id: row.owner_id, artifact_id: row.artifact_id, revision: row.revision,
      content_hash: row.content_hash, scope,
    },
    row,
  }));
}

/** Deterministic final tie-break for equal fused scores: query-tag overlap descending, then
 *  owner UUID ascending, artifact UUID ascending, revision descending — at the record level
 *  `rrf` never sees. Exact-lane results are placed before every other candidate first, and
 *  this comparator applies within each of those two blocks. */
function compareCandidates(a: CollectedEntry, aScore: number, b: CollectedEntry, bScore: number, queryTags: readonly string[]): number {
  if (a.exact !== b.exact) return a.exact ? -1 : 1;
  if (aScore !== bScore) return bScore - aScore;
  const overlap = (tags: readonly string[]) => tags.filter((t) => queryTags.includes(t)).length;
  const tagDelta = overlap(b.tags) - overlap(a.tags);
  if (tagDelta !== 0) return tagDelta;
  if (a.identity.owner_id !== b.identity.owner_id) return a.identity.owner_id < b.identity.owner_id ? -1 : 1;
  if (a.identity.artifact_id !== b.identity.artifact_id) return a.identity.artifact_id < b.identity.artifact_id ? -1 : 1;
  return b.identity.revision - a.identity.revision;
}

/**
 * Runs exact/lexical/fuzzy/graph against every authorized corpus in `descriptors`, collapses
 * passages and aliases to owner-qualified identity before each lane's own cap
 * (`collapseBeforeCap`, never after), fuses lane positions with `rrf` rather than raw
 * per-lane scores, and returns unique ranked candidates carrying which lanes and which
 * authorized corpora contributed.
 *
 * The graph lane's seeds are the first ten unique results from each of exact/lexical/fuzzy,
 * pooled across every corpus those three lanes touched — unique meaning collapsed by
 * `resultKey`, so seeds are deduplicated candidates rather than raw rows.
 *
 * Inspection and deadline exhaustion are disclosed rather than swallowed into an empty list:
 * a budget-exhausted empty result is not a complete negative answer. `reasons` carries only
 * what this function can see — `inspection_budget` and `deadline`; byte-size truncation is
 * disclosed at serialization.
 */
export async function search(
  client: RetrievalClient,
  descriptors: readonly CorpusDescriptor[],
  query: AnalyzedQuery,
  predicates: HardPredicates,
  limit: number,
): Promise<SearchOutcome> {
  const cap: LaneBudgets = budgets(limit);
  const startedAt = Date.now();
  const reasons = new Set<IncompleteReason>();
  const deadlineExceeded = (): boolean => Date.now() - startedAt > REQUEST_DEADLINE_MS;

  const laneLists: LaneKeyList[] = [];
  const byKey = new Map<string, CollectedEntry>();
  const seedPool: { exact: RankedRow<LaneRow>[]; lexical: RankedRow<LaneRow>[]; fuzzy: RankedRow<LaneRow>[] } = {
    exact: [], lexical: [], fuzzy: [],
  };

  const absorb = (
    lane: string, corpus: string, rows: readonly RankedRow<{ readonly tags: readonly string[] | null }>[], exact: boolean,
  ): void => {
    laneLists.push({ lane, corpus, keys: rows.map((r) => resultKey(r.identity)) });
    for (const r of rows) {
      const key = resultKey(r.identity);
      let entry = byKey.get(key);
      if (!entry) {
        entry = { identity: r.identity, tags: [], exact: false, via: new Set(), corpora: new Set() };
        byKey.set(key, entry);
      }
      entry.exact = entry.exact || exact;
      if (r.row.tags && r.row.tags.length > 0) entry.tags = [...new Set([...entry.tags, ...r.row.tags])];
      entry.via.add(lane);
      entry.corpora.add(corpus);
    }
  };

  for (const descriptor of descriptors) {
    if (deadlineExceeded()) { reasons.add("deadline"); break; }
    if (query.exactCandidates.length > 0) {
      const q = buildExactLaneQuery(descriptor, query.exactCandidates, predicates, cap.exact);
      const { rows } = await client.query<LaneRow>(q.text, q.params);
      const ranked = collapseBeforeCap(toRankedRows(rows, descriptor.scope), cap.exact);
      absorb("exact", descriptor.corpus_key, ranked, true);
      seedPool.exact.push(...ranked);
    }
    if (query.lexicalQuery.trim().length > 0) {
      const q = buildLexicalLaneQuery(descriptor, query.lexicalQuery, predicates, cap.lexical);
      const { rows } = await client.query<LaneRow>(q.text, q.params);
      if (rows.length >= LEXICAL_FUZZY_INSPECTION_LIMIT) reasons.add("inspection_budget");
      const ranked = collapseBeforeCap(toRankedRows(rows, descriptor.scope), cap.lexical);
      absorb("lexical", descriptor.corpus_key, ranked, false);
      seedPool.lexical.push(...ranked);
    }
    if (query.fuzzyCandidate) {
      const q = buildFuzzyLaneQuery(descriptor, query.fuzzyCandidate, predicates, cap.fuzzy);
      const { rows } = await client.query<LaneRow>(q.text, q.params);
      if (rows.length >= LEXICAL_FUZZY_INSPECTION_LIMIT) reasons.add("inspection_budget");
      const ranked = collapseBeforeCap(toRankedRows(rows, descriptor.scope), cap.fuzzy);
      absorb("fuzzy", descriptor.corpus_key, ranked, false);
      seedPool.fuzzy.push(...ranked);
    }
  }

  const seeds = (["exact", "lexical", "fuzzy"] as const)
    .flatMap((lane) => collapseBeforeCap(seedPool[lane], 10))
    .map((r) => ({ owner_id: r.identity.owner_id, artifact_id: r.identity.artifact_id }));

  if (seeds.length > 0) {
    for (const descriptor of descriptors) {
      if (deadlineExceeded()) { reasons.add("deadline"); break; }
      const rankedNeighbors: RankedRow<{ tags: null }>[] = [];
      for (const direction of ["as_target", "as_source"] as const) {
        const q = buildGraphNeighborQuery(descriptor, direction, seeds, GRAPH_EDGE_INSPECTION_LIMIT);
        const { rows } = await client.query<GraphEdgeRow>(q.text, q.params);
        if (rows.length >= GRAPH_EDGE_INSPECTION_LIMIT) reasons.add("inspection_budget");
        for (const row of rows) rankedNeighbors.push({ identity: neighborIdentity(row, direction, descriptor.scope), row: { tags: null } });
      }
      const collapsed = collapseBeforeCap(rankedNeighbors, cap.graph);
      absorb("graph", descriptor.corpus_key, collapsed, false);
    }
  }

  const fused: FusedResult[] = rrf(laneLists);
  const scoreOf = new Map(fused.map((f) => [f.key, f.score]));
  const candidates: SearchCandidate[] = fused
    .map((f) => {
      const entry = byKey.get(f.key);
      if (!entry) throw new Error(`rrf produced key ${f.key} absent from the collected candidate map — unreachable`);
      return { key: f.key, identity: entry.identity, score: f.score, exact: entry.exact, via: [...entry.via].sort(), corpora: [...entry.corpora].sort(), tags: entry.tags };
    })
    .sort((a, b) => compareCandidates(byKey.get(a.key)!, scoreOf.get(a.key)!, byKey.get(b.key)!, scoreOf.get(b.key)!, predicates.tags ?? []));

  return { candidates, incomplete: reasons.size > 0, reasons: [...reasons] };
}
