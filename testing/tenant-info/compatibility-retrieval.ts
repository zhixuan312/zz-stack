/**
 * The "wiring" and "registry" case groups: the one path a request travels from a tool's entry
 * to `search()` and back, and the corpus registry that path is authorized against.
 *
 * A fake store, not a database: a fixture connects to nothing. The client below evaluates the
 * predicates each statement's own text carries rather than grepping for a column name, so a
 * lane that selected `owner_id` and filtered on nothing fails these cases.
 *
 * Not proven here: that the SQL is accepted by PostgreSQL 17, that `to_bm25query` ranks
 * anything, or that the registry aggregate returns these counts against real partitions. Those
 * need the pinned image and the benchmark. What is proven is every decision this repository's
 * own code makes between the caller's words and the wire response.
 */
import assert from "node:assert/strict";

import { SearchResponseSchema } from "../../packages/contracts/dist/index.js";
import { loadCorpusRegistry } from "../../services/zz-core/dist/tenant-info/corpus-registry.js";
import { decodeCursor } from "../../services/zz-core/dist/tenant-info/pinned-read.js";
import { resolveCorpora } from "../../services/zz-core/dist/tenant-info/retrieval.js";
import {
  analyzeForLanes, searchTenantInformation, type TenantSearchContext, type TenantSearchRequest,
} from "../../services/zz-core/dist/tenant-info/search.js";

const OWNER_A = "11111111-1111-4111-8111-111111111111";   // the authenticated caller
const OWNER_B = "22222222-2222-4222-8222-222222222222";   // another tenant, never readable
const OWNER_S = "33333333-3333-4333-8333-333333333333";   // a published shared shelf
const ART_1 = "aaaaaaaa-0000-4000-8000-000000000001";
const ART_2 = "aaaaaaaa-0000-4000-8000-000000000002";
const ART_3 = "aaaaaaaa-0000-4000-8000-000000000003";
const ART_S = "cccccccc-0000-4000-8000-000000000001";
const ART_B = "bbbbbbbb-0000-4000-8000-000000000001";
const HASH = (c: string): string => c.repeat(64);

const CONTEXT: TenantSearchContext = {
  owner_id: OWNER_A, shared_allowed: true,
  caller_id: "someone@example.test", index_generation: "g-2026-09-20", cursor_key: "fixture-cursor-key",
};

// The predicate-evaluating fake store

type Row = Record<string, unknown>;

/** `col = $n`, `col = any($n::t[])`, `col && $n::t[]` and `col <> all($n::t[])` — the four
 *  shapes every statement in this path binds with. The column name is captured without its
 *  alias (`\w+` stops at the dot), so `s.owner_id = $2` and `ai.owner_id = $2` both read as a
 *  filter on `owner_id`, which is how the fixture rows are keyed. */
function conjunctsOf(text: string): { kind: string; col: string; at: number }[] {
  const out: { kind: string; col: string; at: number }[] = [];
  for (const m of text.matchAll(/(\w+)\s*=\s*\$(\d+)\b(?!::)/g)) out.push({ kind: "eq", col: m[1], at: Number(m[2]) });
  for (const m of text.matchAll(/(\w+)\s*=\s*any\(\$(\d+)::\w+\[\]\)/g)) out.push({ kind: "any", col: m[1], at: Number(m[2]) });
  for (const m of text.matchAll(/(\w+)\s*&&\s*\$(\d+)::\w+\[\]/g)) out.push({ kind: "overlap", col: m[1], at: Number(m[2]) });
  for (const m of text.matchAll(/(\w+)\s*<>\s*all\(\$(\d+)::\w+\[\]\)/g)) out.push({ kind: "excludeAll", col: m[1], at: Number(m[2]) });
  return out;
}

function satisfies(row: Row, text: string, params: readonly unknown[]): boolean {
  return conjunctsOf(text).every((c) => {
    const want = params[c.at - 1];
    const have = row[c.col];
    if (c.kind === "eq") return have === want;
    if (c.kind === "any") return Array.isArray(want) && want.includes(have);
    if (c.kind === "overlap") return Array.isArray(want) && Array.isArray(have) && (have as unknown[]).some((v) => want.includes(v));
    return !(Array.isArray(want) && want.includes(have));
  });
}

/** The hydration statement's own tuple filter: `unnest($a::text[], $b::uuid[][, $c::int[]]) as
 *  want(corpus_key, artifact_id[, revision])`. Evaluated as the tuple it is, at whatever arity
 *  the statement declares — a row whose corpus matches one entry and whose artifact matches
 *  another does not satisfy it, and at history scope neither does a row whose revision is a
 *  different one of the same artifact's. The arity is read off the statement rather than fixed,
 *  so a fixture cannot pass by being evaluated under the looser of the two shapes. */
function satisfiesWantedPairs(row: Row, text: string, params: readonly unknown[]): boolean {
  const m = text.match(/unnest\(((?:\$\d+::\w+\[\](?:, )?)+)\) as want\(([^)]+)\)/);
  if (!m) return true;
  const indexes = [...m[1].matchAll(/\$(\d+)::/g)].map((p) => Number(p[1]) - 1);
  const columns = m[2].split(",").map((c) => c.trim());
  const rowColumn: Readonly<Record<string, string>> = { corpus_key: "corpus_key", artifact_id: "artifact_id", revision: "revision" };
  const lists = indexes.map((i) => params[i] as readonly unknown[]);
  return lists[0].some((_, entry) => columns.every((col, c) => lists[c][entry] === row[rowColumn[col]]));
}

interface Fixtures {
  registry?: readonly Row[];
  identifiers?: readonly Row[];
  lexical?: readonly Row[];
  projections?: readonly Row[];
  edges?: readonly Row[];
  watermarks?: readonly Row[];
}

function fakeStore(fixtures: Fixtures) {
  const seen: { text: string; params: readonly unknown[] }[] = [];
  const client = {
    query: async <T>(text: string, params: readonly unknown[] = []) => {
      seen.push({ text, params });
      const pick = (rows: readonly Row[] | undefined) =>
        ({ rows: (rows ?? []).filter((r) => satisfies(r, text, params) && satisfiesWantedPairs(r, text, params)) as unknown as T[] });
      if (text.includes("published_artifacts")) return { rows: (fixtures.registry ?? []) as unknown as T[] };
      if (text.includes("artifact_projection_watermark")) return pick(fixtures.watermarks);
      if (text.includes("head_event_sequence")) return pick(fixtures.projections);
      if (text.includes("zz.artifact_edge")) {
        // The graph lane and the source-ref read are both edge queries; only the lane carries
        // the seed-pair clause, and only the source-ref read filters on `kind = 'cites'`.
        const isLane = text.includes("as seed(owner_id, artifact_id)");
        return { rows: (fixtures.edges ?? []).filter((r) => satisfies(r, text, params) && (isLane ? false : r.kind === "cites")) as unknown as T[] };
      }
      if (text.includes("to_bm25query")) return pick(fixtures.lexical);
      return pick(fixtures.identifiers);           // the exact and fuzzy lanes' identifier join
    },
  };
  return { seen, client };
}

// The wiring fixture: one caller, one shelf it may read, one tenant it may not

const REGISTRY_ROWS: Row[] = [
  { corpus_key: "team_a", owner_id: OWNER_A, scope: "current", artifacts: 3, published_artifacts: 0 },
  { corpus_key: "team_b", owner_id: OWNER_B, scope: "current", artifacts: 1, published_artifacts: 0 },
  { corpus_key: "shelf", owner_id: OWNER_S, scope: "current", artifacts: 1, published_artifacts: 1 },
  { corpus_key: "mixed", owner_id: OWNER_S, scope: "current", artifacts: 2, published_artifacts: 1 },
];

const projection = (corpus: string, owner: string, artifact: string, over: Row = {}): Row => ({
  corpus_key: corpus, owner_id: owner, artifact_id: artifact, revision: 1, content_hash: HASH("a"),
  title: "Widget notes", type: "spec", tags: ["alpha"], path: `${artifact}.md`,
  gate_status: "approved", knowledge_status: null, raw_body: "a widget, alpha.beta, nothing else",
  artifact_class: "work_document", profile: "native", head_event_sequence: 7, ...over,
});

const identifier = (corpus: string, owner: string, artifact: string, text: string): Row => ({
  corpus_key: corpus, owner_id: owner, artifact_id: artifact, scope: "current",
  normalized_text: text, identifier_text: text, revision: 1, content_hash: HASH("a"), tags: ["alpha"],
  type: "spec",
});

const lexical = (corpus: string, owner: string, artifact: string, over: Row = {}): Row => ({
  corpus_key: corpus, owner_id: owner, artifact_id: artifact, revision: 1,
  content_hash: HASH("a"), tags: ["alpha"], type: "spec", ...over,
});

function wiringFixtures(): Fixtures {
  return {
    registry: REGISTRY_ROWS,
    identifiers: [identifier("team_a", OWNER_A, ART_1, "alpha.beta")],
    lexical: [
      lexical("team_a", OWNER_A, ART_1), lexical("team_a", OWNER_A, ART_2),
      lexical("team_a", OWNER_A, ART_3), lexical("team_b", OWNER_B, ART_B),
      lexical("shelf", OWNER_S, ART_S),
    ],
    edges: [
      // A `cites` edge makes ART_1's provenance real; it is also what the graph lane would
      // traverse, so the same fixture serves both readers of zz.artifact_edge.
      { source_owner_id: OWNER_A, source_artifact_id: ART_1, source_revision: 1, kind: "cites",
        target_owner_id: OWNER_A, target_artifact_id: ART_2, target_revision: 1,
        target_hash: HASH("b"), retracted_event_id: null },
    ],
    projections: [
      projection("team_a", OWNER_A, ART_1),
      projection("team_a", OWNER_A, ART_2, { path: `${ART_2}.md` }),
      // The one an exclusion must remove: it matches the lexical lane and its body carries the
      // word the caller asked not to see.
      projection("team_a", OWNER_A, ART_3, { path: `${ART_3}.md`, raw_body: "a widget, deprecated last year" }),
      projection("shelf", OWNER_S, ART_S, { path: `${ART_S}.md`, raw_body: "a widget on the shared shelf" }),
      projection("team_b", OWNER_B, ART_B, { path: `${ART_B}.md`, raw_body: "another tenant's widget" }),
    ],
    watermarks: [
      { owner_id: OWNER_A, head_sequence: 41 }, { owner_id: OWNER_S, head_sequence: 9 },
      { owner_id: OWNER_B, head_sequence: 99 },
    ],
  };
}

/** The response is read back through the published schema, never asserted into a local shape.
 *  `SearchResponseSchema.parse` narrows and validates in the same step, so every case below
 *  reads a value the contract has already accepted rather than one a cast promised. */
const wireResponse = (wire: string) => SearchResponseSchema.parse(JSON.parse(wire));

/**
 * One call, tool entry to `search()` and back, validated as the spec's own `SearchResponse`.
 *
 * Asserts that a response comes back at all, that it is the wire shape the contract publishes,
 * and that a candidate found by two lanes carries both of them in `via`.
 */
async function caseARequestTravelsToSearchAndBack(): Promise<void> {
  const { client, seen } = fakeStore(wiringFixtures());
  const request: TenantSearchRequest = { query: "widget alpha.beta", limit: 10 };
  const wire = await searchTenantInformation(client, CONTEXT, request);
  const parsed = SearchResponseSchema.safeParse(JSON.parse(wire));
  assert.equal(parsed.success, true, `the composed path must emit the published SearchResponse: ${JSON.stringify(parsed.error?.issues)}`);
  const body = wireResponse(wire);
  assert.ok(body.results.length > 0, "a request that reaches the lanes must be able to return a result");
  assert.equal(body.schema_version, 2);
  assert.equal(body.mode_used, "natural");
  const first = body.results.find((r) => r.ref.artifact_id === ART_1);
  assert.ok(first, "the artifact both the exact and the lexical lane returned must be in the response");
  assert.deepEqual([...first.via].sort(), ["exact", "fuzzy", "lexical"],
    "every lane that contributed a candidate must travel with it to the caller");
  assert.equal(first.record_digest, first.record_digest.toLowerCase());
  assert.equal(first.etag, "1:7", "the etag is the kernel's own revision:head-sequence, not a second spelling");
  assert.equal(first.shelf, "team");
  assert.equal((first.source_refs as unknown[]).length, 1, "a cites edge is the result's provenance");
  assert.deepEqual(body.indexed_through, { [OWNER_A]: 41, [OWNER_S]: 9 },
    "freshness is reported for the corpora this caller resolved, and for no others");
  assert.ok(seen.some((s) => s.text.includes("to_bm25query")), "the lexical lane must actually have been issued");
}

/**
 * Another tenant's corpus is never queried — not filtered out of the results, never asked
 * about. `team_b` is private and owned by somebody else; `mixed` belongs to a shelf owner but
 * holds one artifact that is not published, so the all-not-any rule makes it private too. Both
 * have fixture rows that would come back, which is what makes the absence meaningful.
 */
async function caseUnauthorizedCorporaNeverReachALane(): Promise<void> {
  const { client, seen } = fakeStore(wiringFixtures());
  const wire = await searchTenantInformation(client, CONTEXT, { query: "widget", limit: 10 });
  const body = wireResponse(wire);
  for (const result of body.results) {
    assert.notEqual(result.ref.owner_id, OWNER_B,
      "another tenant's artifact must never appear in a result");
  }
  for (const { params } of seen) {
    const flat = JSON.stringify(params);
    assert.ok(!flat.includes("team_b"), `no statement may name an unauthorized corpus: ${flat}`);
    assert.ok(!flat.includes("mixed"), `a corpus with one unpublished artifact is private: ${flat}`);
  }
  assert.ok(body.results.some((r) => r.shelf === "platform"),
    "the published shelf this caller may share IS readable — the case would pass vacuously if nothing were");
}

/**
 * The exclusion the lanes cannot push down is still enforced: no lane's predicate carries a
 * phrase, an OR group or a NOT, so without `matchesArtifact` a candidate whose body holds the
 * excluded word is ranked and returned. The assertion is on the excluded artifact's absence and
 * on the others' presence, so removing the call fails it for that reason rather than because
 * the page got shorter.
 */
async function caseAnExclusionSurvivesRanking(): Promise<void> {
  const { client } = fakeStore(wiringFixtures());
  const wire = await searchTenantInformation(client, CONTEXT, { query: "widget -deprecated", limit: 10 });
  const body = wireResponse(wire);
  const ids = body.results.map((r) => r.ref.artifact_id);
  assert.ok(ids.includes(ART_1) && ids.includes(ART_2), "an exclusion must not empty the page");
  assert.ok(!ids.includes(ART_3),
    "an artifact whose body carries the excluded term must not be returned — no lane predicate can refuse it, so the artifact-level matcher has to");
}

/** A filter the schema has a column for is pushed into every lane's own statement; a filter it
 *  has no column for is refused by name rather than silently dropped. */
async function caseFiltersArePushedDownOrRefused(): Promise<void> {
  const { client, seen } = fakeStore(wiringFixtures());
  await searchTenantInformation(client, CONTEXT, { query: "widget alpha.beta", filters: { type: "spec", tags: ["alpha"] } });
  const laneStatements = seen.filter((s) => /to_bm25query|zz\.artifact_identifier/.test(s.text));
  assert.ok(laneStatements.length >= 2, "at least the exact and lexical lanes must have run");
  for (const statement of laneStatements) {
    assert.match(statement.text, /s\.type = \$/, "a type filter belongs in the lane's own predicate");
    assert.match(statement.text, /s\.tags && \$/, "a tag filter belongs in the lane's own predicate");
  }
  for (const name of ["initiative", "flow"]) {
    await assert.rejects(
      () => searchTenantInformation(fakeStore(wiringFixtures()).client, CONTEXT, { query: "widget", filters: { [name]: "I-1" } }),
      (err: Error) => err.message.includes(name) && err.message.includes("no"),
      `a ${name} filter has no column to push into and must be refused, never ignored`,
    );
  }
}

/** A query with nothing to rank or require would issue no statement at all, so an empty answer
 *  would be indistinguishable from a complete one. Refused by name until a browse lane exists. */
async function caseBrowseIsRefusedRatherThanAnsweredEmpty(): Promise<void> {
  const { client, seen } = fakeStore(wiringFixtures());
  await assert.rejects(
    () => searchTenantInformation(client, CONTEXT, { query: "   " }),
    /metadata browsing/,
    "a term-less query must refuse rather than report an unasked question as an empty result",
  );
  assert.equal(seen.length, 0, "and it must refuse before issuing a statement");
}

/** The query grammar's AST is not the lanes' input, and the adapter between them is the piece
 *  that decides what each lane gets to look for. One fuzzy candidate, never a list; never an
 *  excluded term; identifier-shaped rather than the longest word. */
async function caseTheQueryAdapterFeedsEachLaneItsOwnTerms(): Promise<void> {
  const { parseQuery } = await import("../../services/zz-core/dist/tenant-info/retrieval.js");
  const analyzed = analyzeForLanes(parseQuery('"exact phrase" alpha.beta describing -deprecated.thing', "natural"));
  assert.equal(analyzed.fuzzyCandidate, "alpha.beta",
    "the fuzzy lane takes one identifier-shaped term, and never one the caller excluded");
  assert.ok(analyzed.exactCandidates.includes("exact phrase"), "a quoted phrase is an exact candidate");
  assert.ok(!analyzed.exactCandidates.includes("deprecated.thing"), "an exclusion is not a thing to go and find");
  assert.equal(analyzed.lexicalQuery.includes("alpha.beta"), true, "BM25 does its own analysis on the caller's own words");
}

/**
 * The cursor this path emits is one the pinned reader accepts. `source_refs_cursor` is minted
 * by `encodeCursor` inside the composed response and redeemed by `decodeCursor` in a later
 * pinned read. This reads it back with the pinned reader's own decoder and checks the six fields
 * the contract says a cursor pins, against the row the response was built from.
 */
async function casePinnedReadsStayCompatibleWithTheEmittedCursor(): Promise<void> {
  const fixtures = wiringFixtures();
  // DELIBERATE: the cap is written here as a number rather than imported — importing it would
  // make this case adapt to whatever the cap became, and the disclosure under test is the one a
  // reader was promised at twenty.
  const SOURCE_REF_CAP = 20;
  const many = Array.from({ length: SOURCE_REF_CAP + 1 }, (_, i) => ({
    source_owner_id: OWNER_A, source_artifact_id: ART_1, source_revision: 1, kind: "cites",
    target_owner_id: OWNER_A, target_artifact_id: `dddddddd-0000-4000-8000-${String(i).padStart(12, "0")}`,
    target_revision: 1, target_hash: HASH("d"), retracted_event_id: null,
  }));
  const { client } = fakeStore({ ...fixtures, edges: many });
  const body = wireResponse(await searchTenantInformation(client, CONTEXT, { query: "widget alpha.beta", limit: 10 }));
  const result = body.results.find((r) => r.ref.artifact_id === ART_1);
  assert.ok(result, "the artifact carrying the provenance must be in the response");
  assert.equal(result.source_refs.length, SOURCE_REF_CAP, "provenance is capped, not silently complete");
  assert.equal(result.source_refs_truncated, true, "and the truncation is disclosed");
  assert.ok(result.source_refs_cursor, "a truncated provenance list must hand back a cursor");
  const payload = decodeCursor(CONTEXT.cursor_key, result.source_refs_cursor);
  assert.equal(payload.caller_id, CONTEXT.caller_id);
  assert.equal(payload.owner_id, OWNER_A);
  assert.equal(payload.artifact_id, ART_1);
  assert.equal(payload.revision, 1);
  assert.equal(payload.sequence, 7, "the cursor pins the effective provenance sequence, not the revision twice");
  assert.equal(payload.record_digest, result.record_digest, "and the digest the result itself reports");
  assert.throws(() => decodeCursor("a-different-deployment-key", result.source_refs_cursor!), /authentication/,
    "a cursor minted here is not redeemable anywhere else");
}

/**
 * The page is bounded by what the caller asked for. `budgets(limit)` caps each lane, not the
 * union of them, so `search()` hands back everything every lane in every authorized corpus
 * contributed, and `serializeResults` cuts on bytes — 24000 of them. Without a bound on the
 * requested limit, a `limit: 3` request over small documents returns every candidate that fits
 * and `withheld_candidates` reports nothing withheld.
 */
async function caseAPageIsBoundedByTheRequestedLimit(): Promise<void> {
  const ids = Array.from({ length: 9 }, (_, i) => `eeeeeeee-0000-4000-8000-${String(i).padStart(12, "0")}`);
  const { client } = fakeStore({
    registry: [{ corpus_key: "team_a", owner_id: OWNER_A, scope: "current", artifacts: ids.length, published_artifacts: 0 }],
    lexical: ids.map((id) => lexical("team_a", OWNER_A, id)),
    projections: ids.map((id) => projection("team_a", OWNER_A, id, { path: `${id}.md` })),
    watermarks: [{ owner_id: OWNER_A, head_sequence: 41 }],
  });
  const unbounded = wireResponse(await searchTenantInformation(client, CONTEXT, { query: "widget", limit: 50 }));
  assert.equal(unbounded.returned, ids.length, "the fixture must have more candidates than the limit below, or this proves nothing");
  const body = wireResponse(await searchTenantInformation(fakeStore({
    registry: [{ corpus_key: "team_a", owner_id: OWNER_A, scope: "current", artifacts: ids.length, published_artifacts: 0 }],
    lexical: ids.map((id) => lexical("team_a", OWNER_A, id)),
    projections: ids.map((id) => projection("team_a", OWNER_A, id, { path: `${id}.md` })),
    watermarks: [{ owner_id: OWNER_A, head_sequence: 41 }],
  }).client, CONTEXT, { query: "widget", limit: 3 }));
  assert.equal(body.returned, 3, "a page is as long as the caller asked, whatever the byte budget allows");
  assert.equal(body.results.length, 3);
  assert.equal(body.candidate_total, ids.length, "and what ranking considered is still disclosed");
}

/**
 * A history result carries the revision that was ranked. `zz.search_history` holds one row per
 * revision and `resultKey` gives history identity its revision; hydration matching on corpus and
 * artifact alone returns every revision of the artifact, and the last row to arrive describes
 * the result — a candidate ranked at revision 2 returned with revision 7's body, content hash,
 * etag and record digest.
 */
async function caseAHistoryResultCarriesTheRankedRevision(): Promise<void> {
  const historyRegistry = [{ corpus_key: "team_a", owner_id: OWNER_A, scope: "history", artifacts: 1, published_artifacts: 0 }];
  const { client, seen } = fakeStore({
    registry: historyRegistry,
    lexical: [lexical("team_a", OWNER_A, ART_1, { revision: 2, content_hash: HASH("2") })],
    projections: [
      projection("team_a", OWNER_A, ART_1, { revision: 2, content_hash: HASH("2"), raw_body: "the widget as it was", head_event_sequence: 4 }),
      projection("team_a", OWNER_A, ART_1, { revision: 7, content_hash: HASH("7"), raw_body: "the widget today", head_event_sequence: 9 }),
    ],
    watermarks: [{ owner_id: OWNER_A, head_sequence: 41 }],
  });
  const body = wireResponse(await searchTenantInformation(client, CONTEXT, { query: "widget", scopes: ["history"], limit: 10 }));
  assert.equal(body.results.length, 1, "one ranked candidate is one result, not one per stored revision");
  const [result] = body.results;
  assert.equal(result.ref.revision, 2, "the revision the lane ranked is the revision the caller is handed");
  assert.equal(result.ref.content_hash, HASH("2"));
  assert.equal(result.etag, "2:4", "and its etag describes that revision, not the artifact's head");
  assert.match(result.snippet, /as it was/, "and the body is that revision's own text");
  // The statement too, because the two halves of this rule mask each other: binding the
  // revision keeps the extra rows from being fetched, and keying the map by it keeps them from
  // collapsing onto each other. Either alone makes the assertions above pass, so this one fails
  // if history hydration stops asking for the revision it ranked, whatever the map then does.
  const hydration = seen.find((s) => s.text.includes("head_event_sequence"));
  assert.ok(hydration, "the result must have been hydrated from somewhere");
  assert.match(hydration.text, /want\.revision = s\.revision/,
    "history hydration must bind the ranked revision, not fetch every revision of the artifact");
  assert.ok(hydration.params.some((p) => Array.isArray(p) && p.includes(2)),
    "and bind it as a value, not as text");
}

export const WIRING_CASES: Readonly<Record<string, () => Promise<void>>> = {
  a_page_is_bounded_by_the_requested_limit: caseAPageIsBoundedByTheRequestedLimit,
  a_history_result_carries_the_ranked_revision: caseAHistoryResultCarriesTheRankedRevision,
  pinned_reads_stay_compatible_with_the_emitted_cursor: casePinnedReadsStayCompatibleWithTheEmittedCursor,
  a_request_travels_from_tool_entry_to_search_and_back: caseARequestTravelsToSearchAndBack,
  unauthorized_corpora_never_reach_a_lane: caseUnauthorizedCorporaNeverReachALane,
  an_exclusion_survives_ranking: caseAnExclusionSurvivesRanking,
  filters_are_pushed_down_or_refused: caseFiltersArePushedDownOrRefused,
  browse_is_refused_rather_than_answered_empty: caseBrowseIsRefusedRatherThanAnsweredEmpty,
  the_query_adapter_feeds_each_lane_its_own_terms: caseTheQueryAdapterFeedsEachLaneItsOwnTerms,
};

// The registry group: where an entry comes from, and what makes it published

/**
 * Audience is all, not any, and fail-closed. `search()` authorizes once per corpus and never
 * rechecks one artifact's publication state, so a corpus published because one of its artifacts
 * is would disclose every unpublished neighbour to a shared reader. Three shapes, one rule: all
 * published → published; one not → private; none → private.
 */
async function caseAudienceIsPublishedOnlyWhenEveryArtifactIs(): Promise<void> {
  const { client } = fakeStore({
    registry: [
      { corpus_key: "all_published", owner_id: OWNER_S, scope: "current", artifacts: 3, published_artifacts: 3 },
      { corpus_key: "one_withdrawn", owner_id: OWNER_S, scope: "evidence", artifacts: 3, published_artifacts: 2 },
      { corpus_key: "never_published", owner_id: OWNER_A, scope: "current", artifacts: 4, published_artifacts: 0 },
      { corpus_key: "empty", owner_id: OWNER_A, scope: "history", artifacts: 0, published_artifacts: 0 },
    ],
  });
  const byKey = new Map((await loadCorpusRegistry(client)).map((e) => [e.corpus_key, e]));
  assert.equal(byKey.get("all_published")?.audience, "published");
  assert.equal(byKey.get("one_withdrawn")?.audience, "private",
    "one artifact whose latest transition is unpublished makes the whole corpus private");
  assert.equal(byKey.get("never_published")?.audience, "private");
  assert.equal(byKey.get("empty")?.audience, "private", "an empty grant is not a grant");
  assert.equal(byKey.get("all_published")?.index_name, "zz_search_current_all_published_bm25",
    "index_name is the BM25 INDEX ensureCorpus builds on that corpus's partition — not the partition itself, which is what this asserted until a real PostgreSQL 17 refused the pair: `to_bm25query`'s second argument names an index, and the partition name is a different object");
  assert.equal(byKey.get("one_withdrawn")?.index_name, "zz_search_evidence_one_withdrawn_bm25");
}

/** The statement itself is read for the one thing a fixture cannot prove: that the audience
 *  comes from the lifecycle events `policies.ts` writes, rather than from `zz.artifact.audience`
 *  — a column that exists, that nothing writes, and that is null on every row, so a loader
 *  reading it would hand `resolveCorpora` a value which is structurally always absent. */
async function caseAudienceComesFromLifecycleEventsNotTheNullColumn(): Promise<void> {
  const { client, seen } = fakeStore({ registry: [] });
  await loadCorpusRegistry(client);
  assert.equal(seen.length, 1);
  const sql = seen[0].text;
  assert.match(sql, /zz\.artifact_event/, "audience is derived from the event log");
  assert.match(sql, /kind in \('published', 'unpublished'\)/, "from exactly the two transitions policies.ts writes");
  assert.match(sql, /order by e\.sequence desc/, "and from the LATEST of them, not from any of them");
  assert.ok(!/a\.audience|artifact\.audience/.test(sql),
    "never from zz.artifact.audience, which is null on every row this schema has ever held");
}

/**
 * Two owners in one corpus are refused at load, naming both. `resolveCorpora` refuses it too —
 * `assertOneOwnerPerIndex` runs on every call — but cannot say which corpus_key is
 * misconfigured, because by then the rows that prove it are gone. Two owners sharing one
 * partition share its term and document frequencies, so each one's writes move the other's bm25
 * scores while every returned row stays correct.
 */
async function caseTwoOwnersInOneCorpusAreRefusedAtLoad(): Promise<void> {
  const { client } = fakeStore({
    registry: [
      { corpus_key: "shared_index", owner_id: OWNER_A, scope: "current", artifacts: 1, published_artifacts: 1 },
      { corpus_key: "shared_index", owner_id: OWNER_B, scope: "current", artifacts: 1, published_artifacts: 1 },
    ],
  });
  await assert.rejects(
    () => loadCorpusRegistry(client),
    (err: Error & { code?: string }) => err.code === "REGISTRY_MISCONFIGURED"
      && err.message.includes(OWNER_A) && err.message.includes(OWNER_B) && err.message.includes("shared_index"),
    "a corpus holding two owners' documents must be refused at load, naming both owners and the corpus",
  );
}

/** What the loader produces is what `resolveCorpora` accepts: the same call that enforces
 *  `assertOneOwnerPerIndex` on every request, run on a real loader output. */
async function caseALoadedRegistrySatisfiesOneOwnerPerIndex(): Promise<void> {
  const { client } = fakeStore({ registry: REGISTRY_ROWS });
  const registry = await loadCorpusRegistry(client);
  const indexes = new Map<string, string>();
  for (const entry of registry) {
    const seen = indexes.get(entry.index_name);
    assert.ok(seen === undefined || seen === entry.owner_id, `${entry.index_name} carries two owners`);
    indexes.set(entry.index_name, entry.owner_id);
  }
  const resolved = resolveCorpora({ owner_id: OWNER_A, shared_allowed: true }, {}, registry);
  assert.deepEqual(resolved.map((d: { corpus_key: string }) => d.corpus_key).sort(), ["shelf", "team_a"],
    "the caller's own private corpus and the fully published shelf, and nothing else");
}

export const REGISTRY_CASES: Readonly<Record<string, () => Promise<void>>> = {
  audience_is_published_only_when_every_artifact_is: caseAudienceIsPublishedOnlyWhenEveryArtifactIs,
  audience_comes_from_lifecycle_events_not_the_null_column: caseAudienceComesFromLifecycleEventsNotTheNullColumn,
  two_owners_in_one_corpus_are_refused_at_load: caseTwoOwnersInOneCorpusAreRefusedAtLoad,
  a_loaded_registry_satisfies_one_owner_per_index: caseALoadedRegistrySatisfiesOneOwnerPerIndex,
};
