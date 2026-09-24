/**
 * retrieval-lanes.ts — the "lanes" case group.
 * COUPLED: `scripts/tenant-info/suites.ts` reserves the suite name "retrieval" at `retrieval.ts`,
 * so this file's `LANE_CASES` is imported and merged into that file's `CASE_GROUPS` rather than
 * registering a suite of its own.
 *
 * A fake store, not a database: no fixture here connects to one. Every case drives the real query
 * builders (`buildExactLaneQuery`, `buildLexicalLaneQuery`, `buildFuzzyLaneQuery`,
 * `buildGraphNeighborQuery`, `search`) against an in-memory client that evaluates the predicates
 * each query's text actually carries — `col = $n`, `col = any($n::t[])`, `col && $n::t[]`,
 * `col <> all($n::t[])` and the graph lane's `exists (select 1 from unnest(...) as seed(...))`
 * seed-pair match. Grepping the query text for "owner_id" would pass on a predicate that selects
 * the column and filters on nothing; this evaluator does not.
 *
 * The fuzzy mock does not compute trigram similarity. `pg_trgm`'s `similarity()`/`<->` are real
 * PostgreSQL, and reimplementing the algorithm in a double would be a second unverified guess
 * about behaviour this checkout cannot run. The fuzzy fake returns fixture rows filtered by the
 * same owner/corpus/scope conjuncts every lane carries, in the order the fixture declares them —
 * enough to prove owner separation, dedup-before-cap and cross-lane fusion. GiST ranking quality
 * against a real corpus is not a property a mock can honestly assert.
 */
import assert from "node:assert/strict";

import {
  buildExactLaneQuery, buildFuzzyLaneQuery, buildGraphNeighborQuery, buildLexicalLaneQuery, search,
} from "../../services/zz-core/dist/tenant-info/lanes.js";
import type {
  AnalyzedQuery, HardPredicates, IncompleteReason, LaneQuery, SearchCandidate, SearchOutcome,
} from "../../services/zz-core/dist/tenant-info/lanes.js";

const OWNER_P = "77777777-7777-4777-8777-777777777777";
const OWNER_Q = "88888888-8888-4888-8888-888888888888";
const ARTIFACT_A = "99999999-9999-4999-8999-999999999999";
const ARTIFACT_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const DESCRIPTOR_P = { corpus_key: "p-current", owner_id: OWNER_P, scope: "current", audience: "private", index_name: "p_idx" };

// The extended predicate evaluator

type Conjunct =
  | { readonly kind: "eq"; readonly col: string; readonly paramIndex: number }
  | { readonly kind: "any"; readonly col: string; readonly paramIndex: number }
  | { readonly kind: "overlap"; readonly col: string; readonly paramIndex: number }
  | { readonly kind: "excludeAll"; readonly col: string; readonly paramIndex: number };

function parseConjuncts(text: string): Conjunct[] {
  const out: Conjunct[] = [];
  for (const m of text.matchAll(/(\w+)\s*=\s*\$(\d+)\b(?!::)/g)) out.push({ kind: "eq", col: m[1], paramIndex: Number(m[2]) });
  for (const m of text.matchAll(/(\w+)\s*=\s*any\(\$(\d+)::\w+\[\]\)/g)) out.push({ kind: "any", col: m[1], paramIndex: Number(m[2]) });
  for (const m of text.matchAll(/(\w+)\s*&&\s*\$(\d+)::\w+\[\]/g)) out.push({ kind: "overlap", col: m[1], paramIndex: Number(m[2]) });
  for (const m of text.matchAll(/(\w+)\s*<>\s*all\(\$(\d+)::\w+\[\]\)/g)) out.push({ kind: "excludeAll", col: m[1], paramIndex: Number(m[2]) });
  return out;
}

function rowSatisfiesConjuncts(row: Record<string, unknown>, conjuncts: readonly Conjunct[], params: readonly unknown[]): boolean {
  return conjuncts.every((c) => {
    const want = params[c.paramIndex - 1];
    const have = row[c.col];
    if (c.kind === "eq") return have === want;
    if (c.kind === "any") return Array.isArray(want) && want.includes(have);
    if (c.kind === "overlap") return Array.isArray(want) && Array.isArray(have) && (have as unknown[]).some((v) => want.includes(v));
    return !(Array.isArray(want) && want.includes(have));
  });
}

interface SeedClause {
  readonly ownerParamIndex: number;
  readonly artifactParamIndex: number;
  readonly otherOwnerCol: string;
  readonly otherArtifactCol: string;
}

function parseSeedClause(text: string): SeedClause | null {
  const m = text.match(
    /exists \(select 1 from unnest\(\$(\d+)::uuid\[\], \$(\d+)::uuid\[\]\) as seed\(owner_id, artifact_id\) where seed\.owner_id = (\w+) and seed\.artifact_id = (\w+)\)/,
  );
  return m ? { ownerParamIndex: Number(m[1]), artifactParamIndex: Number(m[2]), otherOwnerCol: m[3], otherArtifactCol: m[4] } : null;
}

interface Recorded { readonly text: string; readonly params: readonly unknown[] }

/** One in-memory store backing every lane a `search()` call issues, dispatching on markers
 *  each query's own text carries — "<->" (fuzzy), "to_bm25query" (lexical), "zz.artifact_edge"
 *  (graph), else the identifier join (exact). Four fixture arrays, one per logical table. */
function fakeStore(fixtures: {
  identifierRows?: readonly Record<string, unknown>[];
  fuzzyRows?: readonly Record<string, unknown>[];
  lexicalRows?: readonly Record<string, unknown>[];
  edgeRows?: readonly Record<string, unknown>[];
}) {
  const seen: Recorded[] = [];
  const client = {
    query: async <T>(text: string, params: readonly unknown[] = []) => {
      seen.push({ text, params });
      const conjuncts = parseConjuncts(text);
      if (text.includes("zz.artifact_edge")) {
        const seedClause = parseSeedClause(text);
        const rows = (fixtures.edgeRows ?? []).filter((row) => {
          if (row.retracted_event_id != null) return false;
          if (!rowSatisfiesConjuncts(row, conjuncts, params)) return false;
          if (seedClause) {
            const owners = params[seedClause.ownerParamIndex - 1] as readonly string[];
            const artifacts = params[seedClause.artifactParamIndex - 1] as readonly string[];
            const otherOwner = row[seedClause.otherOwnerCol];
            const otherArtifact = row[seedClause.otherArtifactCol];
            if (!owners.some((o, i) => o === otherOwner && artifacts[i] === otherArtifact)) return false;
          }
          return true;
        });
        return { rows: rows as unknown as T[] };
      }
      if (text.includes("<->")) {
        return { rows: (fixtures.fuzzyRows ?? []).filter((r) => rowSatisfiesConjuncts(r, conjuncts, params)) as unknown as T[] };
      }
      if (text.includes("to_bm25query")) {
        return { rows: (fixtures.lexicalRows ?? []).filter((r) => rowSatisfiesConjuncts(r, conjuncts, params)) as unknown as T[] };
      }
      return { rows: (fixtures.identifierRows ?? []).filter((r) => rowSatisfiesConjuncts(r, conjuncts, params)) as unknown as T[] };
    },
  };
  return { seen, client };
}

const EMPTY_PREDICATES: HardPredicates = {};

// Per-lane owner-predicate cases: one collision fixture per builder

/** The owner-collision pattern, applied once per lane. Two rows share every identifying field except
 *  owner; only a real `owner_id = $n` conjunct in the executed text keeps them apart. */
async function caseExactLaneOwnerPredicateSeparatesCollidingRows(): Promise<void> {
  const rowP = { owner_id: OWNER_P, artifact_id: ARTIFACT_A, revision: 1, content_hash: "p".repeat(64), tags: [], corpus_key: DESCRIPTOR_P.corpus_key, scope: "current", normalized_text: "widget" };
  const rowQ = { owner_id: OWNER_Q, artifact_id: ARTIFACT_A, revision: 1, content_hash: "q".repeat(64), tags: [], corpus_key: DESCRIPTOR_P.corpus_key, scope: "current", normalized_text: "widget" };
  const { seen, client } = fakeStore({ identifierRows: [rowP, rowQ] });
  const q: LaneQuery = buildExactLaneQuery(DESCRIPTOR_P, ["widget"], EMPTY_PREDICATES, 10);
  const { rows } = await client.query<{ content_hash: string }>(q.text, q.params);
  assert.match(seen[0]!.text, /owner_id = \$/, "the owner predicate must be in the statement that runs");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.content_hash, "p".repeat(64), "a request for one owner's artifact must never return another owner's bytes");
}

async function caseLexicalLaneOwnerPredicateSeparatesCollidingRows(): Promise<void> {
  const rowP = { owner_id: OWNER_P, artifact_id: ARTIFACT_A, revision: 1, content_hash: "p".repeat(64), tags: [], corpus_key: DESCRIPTOR_P.corpus_key };
  const rowQ = { owner_id: OWNER_Q, artifact_id: ARTIFACT_A, revision: 1, content_hash: "q".repeat(64), tags: [], corpus_key: DESCRIPTOR_P.corpus_key };
  const { seen, client } = fakeStore({ lexicalRows: [rowP, rowQ] });
  const q = buildLexicalLaneQuery(DESCRIPTOR_P, "widget", EMPTY_PREDICATES, 10);
  const { rows } = await client.query<{ content_hash: string }>(q.text, q.params);
  assert.match(seen[0]!.text, /owner_id = \$/);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.content_hash, "p".repeat(64));
}

async function caseFuzzyLaneOwnerPredicateSeparatesCollidingRows(): Promise<void> {
  const rowP = { owner_id: OWNER_P, artifact_id: ARTIFACT_A, revision: 1, content_hash: "p".repeat(64), tags: [], corpus_key: DESCRIPTOR_P.corpus_key, scope: "current", normalized_text: "widgett" };
  const rowQ = { owner_id: OWNER_Q, artifact_id: ARTIFACT_A, revision: 1, content_hash: "q".repeat(64), tags: [], corpus_key: DESCRIPTOR_P.corpus_key, scope: "current", normalized_text: "widgett" };
  const { seen, client } = fakeStore({ fuzzyRows: [rowP, rowQ] });
  const q = buildFuzzyLaneQuery(DESCRIPTOR_P, "widget", EMPTY_PREDICATES, 10);
  const { rows } = await client.query<{ content_hash: string }>(q.text, q.params);
  assert.match(seen[0]!.text, /owner_id = \$/);
  assert.match(seen[0]!.text, /similarity\(ai\.normalized_text, \$\d+\) >= \$\d+/, "a typo-tolerant candidate must still carry the spec's similarity threshold");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.content_hash, "p".repeat(64));
}

async function caseGraphLaneOwnerPredicateSeparatesCollidingRows(): Promise<void> {
  const seeds = [{ owner_id: OWNER_Q, artifact_id: ARTIFACT_B }];
  const edgeToP = {
    source_owner_id: OWNER_Q, source_artifact_id: ARTIFACT_B, source_revision: 1, kind: "cites",
    target_owner_id: OWNER_P, target_artifact_id: ARTIFACT_A, target_revision: 1, target_hash: "p".repeat(64), retracted_event_id: null,
  };
  // Same seed, same target artifact id, but the owner on the target side is Q, not P — a
  // partial index or an artifact_id-only join would let this through; the owner predicate
  // in the query text must not.
  const edgeToQ = { ...edgeToP, target_owner_id: OWNER_Q, target_hash: "q".repeat(64) };
  const { seen, client } = fakeStore({ edgeRows: [edgeToP, edgeToQ] });
  const q = buildGraphNeighborQuery(DESCRIPTOR_P, "as_target", seeds, 100);
  const { rows } = await client.query<{ target_hash: string }>(q.text, q.params);
  assert.match(seen[0]!.text, /target_owner_id = \$/);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.target_hash, "p".repeat(64));
}

// Hard exclusion, carried into every lane's own text

async function caseHardExclusionAppliesToEveryLane(): Promise<void> {
  const predicates: HardPredicates = { excludeArtifactIds: [ARTIFACT_B] };
  const exactText = buildExactLaneQuery(DESCRIPTOR_P, ["widget"], predicates, 10).text;
  const lexicalText = buildLexicalLaneQuery(DESCRIPTOR_P, "widget", predicates, 10).text;
  const fuzzyText = buildFuzzyLaneQuery(DESCRIPTOR_P, "widget", predicates, 10).text;
  for (const text of [exactText, lexicalText, fuzzyText]) {
    assert.match(text, /artifact_id <> all\(\$\d+::uuid\[\]\)/, "a hard exclusion must reach every lane's own predicate");
  }
}

// Search(): dedup-before-cap, tag tie-break and disclosure, through the real pipeline

/** Three aliases of the same artifact plus two other artifacts, run through the exact lane of
 *  a real `search()` call: the final candidate list has four distinct keys, not five rows and
 *  not the first three (which would all be the same artifact if capped before collapse). */
async function caseSearchDedupsPassagesBeforeTheExactCap(): Promise<void> {
  const alias = (n: string) => ({ owner_id: OWNER_P, artifact_id: ARTIFACT_A, revision: 1, content_hash: "a".repeat(64), tags: [], corpus_key: DESCRIPTOR_P.corpus_key, scope: "current", normalized_text: n });
  const other = (id: string) => ({ owner_id: OWNER_P, artifact_id: id, revision: 1, content_hash: "b".repeat(64), tags: [], corpus_key: DESCRIPTOR_P.corpus_key, scope: "current", normalized_text: id });
  const artifactC = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const { client } = fakeStore({
    identifierRows: [alias("a-heading"), alias("a-path"), alias("a-title"), other(ARTIFACT_B), other(artifactC)],
  });
  const query: AnalyzedQuery = { exactCandidates: ["a-heading", "a-path", "a-title", ARTIFACT_B, artifactC], fuzzyCandidate: null, lexicalQuery: "" };
  const outcome: SearchOutcome = await search(client, [DESCRIPTOR_P], query, EMPTY_PREDICATES, 15);
  const distinct = new Set(outcome.candidates.map((c: SearchCandidate) => c.key));
  assert.equal(distinct.size, 3, "one artifact with three aliases plus two others is three distinct candidates");
  assert.equal(outcome.candidates.length, 3);
}

/** Two artifacts tied on fused score — exact ranks A first and B second, fuzzy ranks them the
 *  other way round, so their summed RRF contributions are equal. `predicates.tags` is a
 *  filter ("&&", at least one shared tag) AND the tie-break signal, so both A and B must
 *  overlap it to survive at all: A shares both query tags, B shares only one. "Equal scores
 *  use explicit tag overlap ... descending" (contract): A, the fuller overlap, must precede B. */
async function caseSearchBreaksTiesByExplicitTagOverlap(): Promise<void> {
  const rowA = { owner_id: OWNER_P, artifact_id: ARTIFACT_A, revision: 1, content_hash: "a".repeat(64), tags: ["urgent", "security"], corpus_key: DESCRIPTOR_P.corpus_key, scope: "current" };
  const rowB = { owner_id: OWNER_P, artifact_id: ARTIFACT_B, revision: 1, content_hash: "b".repeat(64), tags: ["urgent"], corpus_key: DESCRIPTOR_P.corpus_key, scope: "current" };
  const identifierRowA = { ...rowA, normalized_text: "alpha" };
  const identifierRowB = { ...rowB, normalized_text: "beta" };
  const { client } = fakeStore({
    // exact: alphabetical identifier_text order puts A ("alpha") before B ("beta").
    identifierRows: [identifierRowA, identifierRowB],
    // fuzzy: fixture order puts B before A (the mock returns matches in declared order).
    fuzzyRows: [rowB, rowA],
  });
  const query: AnalyzedQuery = { exactCandidates: ["alpha", "beta"], fuzzyCandidate: "alpa", lexicalQuery: "" };
  const predicates: HardPredicates = { tags: ["urgent", "security"] };
  const outcome = await search(client, [DESCRIPTOR_P], query, predicates, 15);
  assert.equal(outcome.candidates.length, 2, "both A and B share at least one query tag and must survive the tags filter");
  const [first, second] = outcome.candidates;
  assert.equal(first!.identity.artifact_id, ARTIFACT_A, "the tied candidate with the fuller query-tag overlap must sort first");
  assert.equal(second!.identity.artifact_id, ARTIFACT_B);
  assert.equal(first!.score, second!.score, "the two candidates must actually be tied, not merely ordered");
}

/** A lexical/fuzzy scan that returns exactly the 10000-row inspection cap discloses
 *  `inspection_budget` — "exhaustion discloses incomplete search rather than absence of
 *  remaining matches" (spec). An empty `incomplete: false` result would silently claim there
 *  was nothing left to find. */
async function caseSearchDisclosesInspectionBudgetExhaustion(): Promise<void> {
  const saturating = Array.from({ length: 10000 }, (_, i) => ({
    owner_id: OWNER_P, artifact_id: `cccccccc-cccc-4ccc-8ccc-${String(i).padStart(12, "0")}`,
    revision: 1, content_hash: "c".repeat(64), tags: [], corpus_key: DESCRIPTOR_P.corpus_key,
  }));
  const { client } = fakeStore({ lexicalRows: saturating });
  const query: AnalyzedQuery = { exactCandidates: [], fuzzyCandidate: null, lexicalQuery: "widget" };
  const outcome = await search(client, [DESCRIPTOR_P], query, EMPTY_PREDICATES, 15);
  assert.equal(outcome.incomplete, true);
  assert.ok((outcome.reasons as readonly IncompleteReason[]).includes("inspection_budget"));
}

/**
 * The consequence RRF exists for, asserted in the composed function rather than in the arithmetic.
 * `checks/tenant-fusion-arithmetic.ts` proves `rrf()` computes reciprocal-rank sums over lane
 * lists it is handed directly; the other cases prove `search()` issues the lane queries. Between
 * them sits the join: that `search()` hands the lane lists to `rrf()` in a way that preserves which
 * lane found what. Label every list with the same lane name, or build one list per corpus instead
 * of per lane, and the arithmetic is still correct and the queries still issued while multi-lane
 * agreement stops counting for anything.
 *
 * So: B is the top result of the lexical lane and is found by nothing else. A is second in that
 * same lane, and is also found by exact and by fuzzy. A must outrank B — three lanes at middling
 * rank beat one lane at rank 1, which is the trade RRF is chosen to make.
 *
 * `via` is asserted too, because the score alone could come out right by accident while the
 * provenance a caller reads is wrong.
 */
async function caseSearchRanksMultiLaneAgreementAboveOneLaneTopHit(): Promise<void> {
  const common = { revision: 1, corpus_key: DESCRIPTOR_P.corpus_key, scope: "current", tags: [] };
  const rowA = { ...common, owner_id: OWNER_P, artifact_id: ARTIFACT_A, content_hash: "a".repeat(64) };
  const rowB = { ...common, owner_id: OWNER_P, artifact_id: ARTIFACT_B, content_hash: "b".repeat(64) };
  const { client } = fakeStore({
    // lexical returns B first, A second — B is the single-lane leader.
    lexicalRows: [rowB, rowA],
    // A alone is reachable by the exact lane and by the fuzzy lane.
    identifierRows: [{ ...rowA, normalized_text: "alpha" }],
    fuzzyRows: [rowA],
  });
  const query: AnalyzedQuery = { exactCandidates: ["alpha"], fuzzyCandidate: "alpa", lexicalQuery: "widget" };
  const outcome = await search(client, [DESCRIPTOR_P], query, EMPTY_PREDICATES, 15);

  assert.equal(outcome.candidates.length, 2, "both artifacts must survive — this is about order, not filtering");
  const [first, second] = outcome.candidates;
  assert.equal(first!.identity.artifact_id, ARTIFACT_A,
    "an artifact three lanes agree on must outrank the single-lane leader — otherwise the lane " +
    "lists are reaching rrf() without their lane identity and the four lanes are one lane");
  assert.equal(second!.identity.artifact_id, ARTIFACT_B);
  assert.ok(first!.score > second!.score,
    `the ordering must come from the fused score, not from a stable sort: ${first!.score} vs ${second!.score}`);
  assert.deepEqual([...first!.via].sort(), ["exact", "fuzzy", "lexical"],
    "the winner's provenance must name all three lanes that found it");
  assert.deepEqual([...second!.via], ["lexical"]);
}

/**
 * The lexical lane uses the operator the extension actually has.
 *
 * In pg_textsearch v1.4.0 `@@` takes a `tsquery`, and a `bm25query` is consumed by `<@>` in ORDER
 * BY. Every other case in this suite asserts on which rows come back from a fake store rather than
 * on the SQL the lane emits, so a wrong operator passes all of them.
 *
 * So this one asserts the emitted text. It is the only thing standing between a future edit and a
 * lane that cannot execute — this offline suite has no PostgreSQL 17 to refuse it.
 */
async function caseLexicalLaneUsesTheBm25RankingOperator(): Promise<void> {
  const q: LaneQuery = buildLexicalLaneQuery(DESCRIPTOR_P, "widget", EMPTY_PREDICATES, 10);
  assert.match(q.text, /order by s\.raw_body <@> to_bm25query\(\$\d+, \$\d+\)/,
    "the bm25 score must be the ORDER BY expression — `<@>` is what consumes a bm25query");
  assert.doesNotMatch(q.text, /@@/,
    "`@@` takes a tsquery, not a bm25query; pairing them is an operator the extension does not have");
  assert.doesNotMatch(q.text, /order by[\s\S]*\bdesc\b/i,
    "`<@>` returns a NEGATIVE score, so ascending IS descending relevance — a desc here would " +
    "return the corpus's worst matches and every row-level assertion would still pass");
  // The tenant boundary is not traded away for a ranking plan.
  assert.match(q.text, /s\.corpus_key = \$\d+/);
  assert.match(q.text, /s\.owner_id = \$\d+/);
}

export const LANE_CASES: Readonly<Record<string, () => Promise<void>>> = {
  lexical_lane_uses_the_bm25_ranking_operator: caseLexicalLaneUsesTheBm25RankingOperator,
  search_ranks_multi_lane_agreement_above_one_lane_top_hit: caseSearchRanksMultiLaneAgreementAboveOneLaneTopHit,
  exact_lane_owner_predicate_separates_colliding_rows: caseExactLaneOwnerPredicateSeparatesCollidingRows,
  lexical_lane_owner_predicate_separates_colliding_rows: caseLexicalLaneOwnerPredicateSeparatesCollidingRows,
  fuzzy_lane_owner_predicate_separates_colliding_rows: caseFuzzyLaneOwnerPredicateSeparatesCollidingRows,
  graph_lane_owner_predicate_separates_colliding_rows: caseGraphLaneOwnerPredicateSeparatesCollidingRows,
  hard_exclusion_applies_to_every_lane: caseHardExclusionAppliesToEveryLane,
  search_dedups_passages_before_the_exact_cap: caseSearchDedupsPassagesBeforeTheExactCap,
  search_breaks_ties_by_explicit_tag_overlap: caseSearchBreaksTiesByExplicitTagOverlap,
  search_discloses_inspection_budget_exhaustion: caseSearchDisclosesInspectionBudgetExhaustion,
};
