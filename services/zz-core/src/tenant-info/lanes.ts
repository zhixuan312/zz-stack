/**
 * lanes.ts — I-17's own file, split out of `retrieval.ts` with the plan owner's sign-off once
 * `retrieval.ts` was going to exceed the 700-line ceiling with I-18 still to land after it.
 * The seam: `retrieval.ts` keeps the fusion PRIMITIVES the frozen check imports and I-18 will
 * also need — `budgets`, `resultKey`, `rrf`, `collapseBeforeCap` — pure arithmetic over
 * positions. This file holds the four lane SQL builders, the graph traversal and the
 * orchestrator that RUNS them: SQL against a real schema, which fails differently and is read
 * by different people than the arithmetic does.
 *
 * EVERY LANE BUILDER BINDS `descriptor.owner_id` AS AN EXPLICIT `= $n` CONJUNCT IN THE
 * STATEMENT IT RETURNS — never only relying on `resolveCorpora` having already authorized the
 * descriptor. I-16's own header explains why the earlier gate does not excuse the later
 * predicate: a partial index's `where` clause is an optimisation, not a permission filter, and
 * "selecting owner_id in SQL is not accepted as proof of a filtering predicate." The same rule
 * applies here, once per lane, not once for all four.
 *
 * A NAMED GAP, CARRIED FORWARD FROM I-5/I-13, NOT INVENTED HERE. Migration 070 (I-13) created
 * no `bm25` index and no GiST `gist_trgm_ops` index — I-5's own dependency suite explicitly
 * declined to invent `pg_textsearch`'s real DDL, which exists nowhere in this checkout. Spec
 * line 767 DOES name the query-time call: "uses explicit `to_bm25query(query,index_name)` for
 * concrete corpus indexes." `buildLexicalLaneQuery` below uses exactly that function, and
 * nothing else pg_textsearch-specific — the match operator `@@` is extrapolated from
 * `to_bm25query` mirroring PostgreSQL's own `to_tsquery`/`@@` convention, not independently
 * named by spec or this checkout, and is flagged again on that function. The extension's own
 * relevance/score expression for `order by` is not named ANYWHERE in this checkout, so this
 * builder does not invent one — it orders lexical candidates by stable identity alone until an
 * operator resolves and verifies the real DDL (I-5/I-21's boundary), which under-serves "BM25
 * ranks before candidate selection" for ORDER alone; the match predicate and every owner/hard
 * predicate are still real and correct SQL regardless. The fuzzy lane has no such gap: `pg_trgm`
 * and its `<->`/`similarity()` operators are documented, shipped PostgreSQL, not a placeholder.
 */
import type {
  CorpusDescriptor, FusedResult, LaneBudgets, LaneKeyList, RankedRow, ResultIdentity, RetrievalClient,
} from "./retrieval.js";
import { budgets, collapseBeforeCap, resultKey, rrf, scopeTable } from "./retrieval.js";

// ── shared query-building plumbing ──────────────────────────────────────────────────────────

export interface LaneQuery {
  readonly text: string;
  readonly params: readonly unknown[];
}

/** The analyzed-query shape this file consumes — I-18's `parseQuery` produces the real one;
 *  this is the minimal contract it must satisfy. `fuzzyCandidate` is singular, not a list: the
 *  spec's GiST lane is a distance-ordered top-k over ONE term (`normalized_text <-> term`),
 *  and a multi-term index scan would not use that index the same way — picking the single best
 *  identifier-shaped token is the query parser's job, not this file's. */
export interface AnalyzedQuery {
  readonly exactCandidates: readonly string[];
  readonly fuzzyCandidate: string | null;
  readonly lexicalQuery: string;
}

/** Filters/exclusions every lane pushes down where the schema actually has the column for it.
 *  `initiative`/`flow` from the query grammar have no column in `zz.search_current/evidence/
 *  history` (migration 070) to push into — a real, named, inherited gap, not this file's to
 *  close — so only `type`/`tags`/exclusion are represented here. Tags are a filter here AND
 *  the tie-break signal `search`'s final sort reads — never a fifth recall lane (D10). */
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
/** derived_from, supersedes, revision_of, cites — the spec's own relation order, verbatim. */
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

// ── exact lane: equality over extracted identifiers ─────────────────────────────────────────

/**
 * "Exact full-ID/path equality has priority. Use equality/hash-assisted exact and B-tree
 * prefix lookup ... over canonical identifier entries" (spec). `candidates` are the query
 * parser's own normalized identifier/path/title candidates — this function does no
 * normalization of its own. Joins `zz.artifact_identifier` back to the scope table for
 * `content_hash`/`tags`/authorization columns; `ai.owner_id = $n` is the owner predicate this
 * lane carries in its own text, independent of `resolveCorpora` having already authorized
 * `descriptor`.
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

// ── lexical lane: pg_textsearch BM25 over the whole-artifact projection ────────────────────



/**
 * THE CONCRETE PARTITION A CORPUS LIVES IN, and the BM25 index built on it.
 *
 * `scopeTable` names the PARENT partitioned table, which is right for every lane that filters
 * rows: `corpus_key = $n` prunes to one partition and the parent is the natural relation to
 * name. It is wrong for the lexical lane, and only a real PostgreSQL 17 said so:
 *
 *     ERROR: index "search_current_default_bm25" is not on column "raw_body"
 *     HINT:  ... or omit the index name to use automatic index resolution.
 *
 * `to_bm25query(query, index_name)` requires the named index to be on the relation being
 * scanned. Naming a partition's index while scanning the parent is refused, and the HINT's
 * alternative — omit the index and let the planner resolve one — is precisely the
 * statistics-sharing the isolation property forbids: the IDF would come from whichever index
 * the planner picked, across whatever rows it covers.
 *
 * So the specification's own sentence turns out to be load-bearing rather than stylistic:
 * "separate PostgreSQL list partitions ... with BM25 indexes on concrete partitions, not a
 * statistics-sharing parent index." The lexical lane scans the partition.
 *
 * HERE RATHER THAN BESIDE `scopeTable`, which is where it belongs by subject: `retrieval.ts`
 * measured 701 lines with it against a ceiling of 700. The frozen checks decide which half
 * moves, as they have for every split in this delivery — they pin `budgets`, `resultKey`,
 * `rrf`, `parseQuery`, `serializeResults` and `resolveCorpora` to that module BY NAME and a
 * frozen check's bytes cannot be edited to follow a symbol elsewhere. Nothing pins these
 * two, and the lexical lane below is their only caller.
 *
 * SPELLED THE WAY `ensureCorpus` SPELLS THEM (tenant-projections.ts), because these two must
 * agree and nothing would notice if they drifted: the partition is `<parent>_<key>` and an
 * index on it is that name with dots flattened, plus a suffix.
 */
export function corpusPartition(scope: string, corpusKey: string): string {
  return `${scopeTable(scope)}_${corpusKey}`;
}

export function corpusBm25Index(scope: string, corpusKey: string): string {
  return `${corpusPartition(scope, corpusKey).replace(".", "_")}_bm25`;
}

/**
 * THE MATCH OPERATOR WAS EXTRAPOLATED AND THE EXTRAPOLATION WAS WRONG. This built
 * `raw_body @@ to_bm25query(...)`, reasoning from PostgreSQL's own `to_tsquery`/`@@`
 * convention, and said so rather than claiming verification. Resolved against the real
 * upstream (github.com/timescale/pg_textsearch, v1.4.0): `@@` takes a `tsquery` and does
 * boolean filtering; a `bm25query` is consumed by `<@>` in ORDER BY, which returns a NEGATIVE
 * score so an ascending scan is a descending relevance ranking. The old form would have been
 * refused by the extension the first time it ran — the operator does not exist for that pair.
 *
 * SO THERE IS NO TEXT PREDICATE IN THE WHERE CLAUSE, and that is the design rather than a
 * relaxation. `<@>` + LIMIT against a `USING bm25` index IS the top-k scan — the extension's
 * Block-Max WAND optimisation is what makes it stop early — and adding a boolean filter
 * beside it would ask the planner for a different, slower plan. The tenant predicates stay
 * exactly where they were: `corpus_key` and `owner_id` are the authorization boundary and are
 * not negotiable for a ranking convenience.
 *
 * `descriptor.index_name` is the registry's own field (never caller text), matching "explicit-
 * index prepared queries" and `resolveCorpora`'s rule that identifiers come from the registry
 * while values remain bound parameters.
 */
export function buildLexicalLaneQuery(
  descriptor: CorpusDescriptor, query: string, predicates: HardPredicates, cap: number,
): LaneQuery {
  // THE CONCRETE PARTITION, not the parent — see `corpusPartition` (retrieval.ts) for the
  // refusal a real PostgreSQL 17 returns when an explicit BM25 index is named while the parent
  // is scanned, and for why the alternative it suggests is the statistics leak this delivery
  // exists to prevent.
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
      // ASCENDING, because `<@>` returns a negative BM25 score: the most relevant row is the
      // most negative one. Ordering descending here would return the corpus's worst matches
      // and every test above this would still pass, because they assert on which rows come
      // back rather than on the sign of a number the extension produces.
      + `order by ${scoreExpr} `
      + `limit ${limitParam}`,
    params,
  };
}

// ── fuzzy lane: GiST distance-ordered top-k over identifiers ────────────────────────────────

/**
 * "GiST `gist_trgm_ops(siglen=32)` distance-ordered top-k over canonical identifier entries.
 * Fuzzy eligibility is 4–256 Unicode scalar values with similarity at least 0.30" (spec) —
 * `pg_trgm`'s own `<->`/`similarity()`, real and documented, not a placeholder. `term` is a
 * SINGLE candidate; see `AnalyzedQuery.fuzzyCandidate`'s own comment for why.
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

// ── graph lane: one hop of typed, authorized edges ──────────────────────────────────────────

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
 * One hop of `zz.artifact_edge`, ONE direction per call — `direction: "as_target"` finds
 * neighbors that are `descriptor`'s own artifacts reached via an edge whose SOURCE is one of
 * `seeds` (any owner); `"as_source"` is the mirror. Two single-direction, all-AND queries
 * rather than one query with a top-level OR: `retracted_event_id is null` and the owner
 * predicate are both plain `= $n` conjuncts this way, matching the shape every other lane's
 * owner predicate takes, and "sharing an initiative alone creates no edge" holds by
 * construction — this function only ever reads `zz.artifact_edge`, nothing else.
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

/** The neighbor side of a graph row IS `descriptor`'s own artifact — for `"as_target"` that is
 *  the edge's target fields, for `"as_source"` the source fields. `target_hash`/`source_hash`
 *  is the hash asserted AT THAT EDGE, which is exactly what history identity needs (the cited
 *  revision, not whatever the artifact's current head happens to be) — no extra join back to
 *  the scope table required. */
function neighborIdentity(row: GraphEdgeRow, direction: "as_target" | "as_source", scope: string): ResultIdentity {
  return direction === "as_target"
    ? { owner_id: row.target_owner_id, artifact_id: row.target_artifact_id, revision: row.target_revision ?? 0, content_hash: row.target_hash, scope }
    // `source_hash` does not exist on this edge (only `target_hash` does — an edge freezes the
    // TARGET's cited hash, not the source's own, which the source's own revision row already
    // has); an "as_source" neighbor's hash is therefore not carried by the edge and is left
    // empty here rather than guessed. `resultKey` ignores it for every scope but `history`,
    // and a history-scope "as_source" neighbor genuinely cannot get its hash from this row
    // alone — a real gap, not silently papered over.
    : { owner_id: row.source_owner_id, artifact_id: row.source_artifact_id, revision: row.source_revision ?? 0, content_hash: "", scope };
}

// ── the orchestrator: run every lane, dedup-before-cap, fuse, tie-break ─────────────────────

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

/** Deterministic final tie-break for equal fused scores: explicit query-tag overlap
 *  descending, then owner UUID ascending, artifact UUID ascending, revision descending — the
 *  retrieval contract's own words, applied at the record level `rrf` never sees. Exact-lane
 *  results are placed before every other candidate first ("exact resolved refs precede
 *  ranking"), and only then does this comparator apply within each of those two blocks. */
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
 * passages/aliases to owner-qualified identity BEFORE each lane's own cap (`collapseBeforeCap`,
 * never after), fuses lane positions with `rrf` (never raw per-lane scores), and returns
 * unique ranked candidates carrying which lanes and which authorized corpora contributed.
 *
 * The graph lane's seeds are the first ten qualifying UNIQUE results from each of exact/
 * lexical/fuzzy, pooled across every authorized corpus those three lanes touched — "unique"
 * meaning collapsed by `resultKey`, matching "qualifying" to authorized, already-deduplicated
 * candidates rather than raw rows.
 *
 * Inspection/deadline exhaustion is disclosed, never silently swallowed into an empty list —
 * "a budget-exhausted empty result is not a complete negative answer." Response-budget
 * disclosure (byte-size truncation) is I-18's, at serialization; this function's `reasons` are
 * only the ones it can see for itself: `inspection_budget` and `deadline`.
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
