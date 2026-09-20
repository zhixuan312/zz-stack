/**
 * retrieval-query.ts — I-18's "query" case group: `parseQuery`, `serializeResults` and
 * `matchesArtifact`. `retrieval.ts` (`testing/tenant-info/`) reserves the suite name
 * "retrieval" at exactly that file — this module's `QUERY_CASES` is merged into that file's
 * `CASE_GROUPS`, the same pattern `retrieval-lanes.ts` (I-17) already established.
 */
import assert from "node:assert/strict";

import { parseQuery, serializeResults } from "../../services/zz-core/dist/tenant-info/retrieval.js";
import type { QueryAst, QueryMode, ResultEnvelope } from "../../services/zz-core/dist/tenant-info/retrieval.js";
import { matchesArtifact } from "../../services/zz-core/dist/tenant-info/pinned-read.js";
import { SearchResponseSchema } from "../../packages/contracts/dist/index.js";

/** Typed over `QueryMode` explicitly, rather than letting every call site infer it from a
 *  string literal — every case below goes through this one signature. */
function parse(text: string, mode: QueryMode): QueryAst {
  return parseQuery(text, mode);
}

// ── grammar recognition precedes identifier normalization ──────────────────────────────────

/** THE CASE THE WHOLE LEXER-ORDERING CLAIM RESTS ON. `plugin-judge`'s internal hyphen and
 *  `zz.eval_finding`'s dot must survive as ONE unsplit term each — a lexer that ran
 *  `zz-lexical-v1`-style identifier splitting (dot/underscore/slash/hyphen/colon boundaries)
 *  before recognizing quotes/OR/exclusions would fragment both into multiple pieces and
 *  would misread `-draft`'s hyphen no differently than `plugin-judge`'s own internal one.
 *  Mutation-tested by hand: normalizing (`.toLowerCase().split(/[-._]/)`-shaped) this same raw
 *  text BEFORE recognizing operators turns `plugin`, `judge`, `zz`, `eval_finding` into four
 *  separate tokens and no longer isolates `-draft` from a mid-string hyphen the same way —
 *  exactly the fault this case exists to catch, run once directly against `retrieval.ts` (with
 *  the real ordering swapped, observed red on the assertions below, then reverted from a
 *  scratch copy — never `git checkout` — per this task's own report). */
async function caseLexerOrderingPreservesUnsplitIdentifiers(): Promise<void> {
  const ast: QueryAst = parse("plugin-judge OR zz.eval_finding -draft", "natural");
  assert.deepEqual(ast.exclusions, ["draft"]);
  assert.equal(ast.clauses.length, 1, "the OR group is the query's only top-level clause");
  const [group] = ast.clauses;
  assert.equal(group!.kind, "or");
  const values = group!.kind === "or" ? group.alternatives.map((a) => (a.kind === "term" ? a.value : "")) : [];
  assert.deepEqual(values, ["plugin-judge", "zz.eval_finding"],
    "a hyphen inside plugin-judge and a dot inside zz.eval_finding must never split the token");
}

/** A relative path is a single word, unsplit and unmarked — no leading `-`, no quote, no
 *  embedded `OR`. The frozen check already proves `original_text`/`exclusions`; this proves
 *  the path also survives as exactly one term clause, never fragmented on its own slashes. */
async function casePathIsOneUnsplitTerm(): Promise<void> {
  const ast = parse("services/zz-core/src/tenant-info/retrieval.ts", "natural");
  assert.equal(ast.clauses.length, 1);
  assert.deepEqual(ast.clauses[0], { kind: "term", value: "services/zz-core/src/tenant-info/retrieval.ts", required: false });
}

// ── natural vs websearch: quotes, OR case, length limits ───────────────────────────────────

async function caseUnterminatedQuoteNamesItsOwnPosition(): Promise<void> {
  assert.throws(
    () => parse('alpha "beta gamma', "natural"),
    (e: unknown) => e instanceof Error && "code" in e && (e as { code: unknown }).code === "INVALID_INPUT"
      && e.message.includes("6"),
    "the opening quote sits at scalar offset 6 and the refusal must name it",
  );
}

async function caseWebsearchUnterminatedQuoteRunsToEndOfInput(): Promise<void> {
  const ast = parse('alpha "beta gamma', "websearch");
  assert.equal(ast.mode, "websearch");
  assert.ok(ast.phrases.includes("beta gamma"), "an unterminated quote in websearch mode reads to end of input, never refuses");
}

async function caseNaturalOrIsCaseSensitiveUppercase(): Promise<void> {
  const ast = parse("alpha or beta", "natural");
  assert.equal(ast.clauses.length, 3, "a lowercase 'or' is an ordinary word in natural mode, not the alternatives operator — 'alpha', 'or' and 'beta' are three separate terms");
}

async function caseThreeWayOrFoldsIntoOneGroup(): Promise<void> {
  const ast = parse("alpha OR beta OR gamma", "natural");
  assert.equal(ast.clauses.length, 1);
  const [group] = ast.clauses;
  assert.equal(group!.kind, "or");
  assert.equal(group!.kind === "or" ? group.alternatives.length : 0, 3, "three OR-joined operands fold into one three-way group, not nested pairs");
}

async function caseDanglingOrIsDroppedNotGuessed(): Promise<void> {
  const leading = parse("OR alpha", "natural");
  assert.equal(leading.clauses.length, 1);
  assert.equal(leading.clauses[0]!.kind, "term");
  const trailing = parse("alpha OR", "natural");
  assert.equal(trailing.clauses.length, 1);
  assert.equal(trailing.clauses[0]!.kind, "term");
}

async function caseExcludedPhraseEntersExclusionsNotClauses(): Promise<void> {
  const ast = parse('alpha -"exact phrase"', "natural");
  assert.deepEqual(ast.exclusions, ["exact phrase"]);
  assert.equal(ast.clauses.length, 1, "an excluded phrase never becomes a hard AND clause of its own");
}

async function caseQueryLengthLimitRefusesOversizedInput(): Promise<void> {
  const oversized = "a".repeat(2049);
  assert.throws(() => parse(oversized, "natural"),
    (e: unknown) => e instanceof Error && "code" in e && (e as { code: unknown }).code === "INVALID_INPUT");
  assert.doesNotThrow(() => parse("a".repeat(2048), "natural"));
}

async function casePhraseLengthLimitRefusesOversizedPhrase(): Promise<void> {
  const oversizedPhrase = `"${"a".repeat(257)}"`;
  assert.throws(() => parse(oversizedPhrase, "natural"),
    (e: unknown) => e instanceof Error && "code" in e && (e as { code: unknown }).code === "INVALID_INPUT");
}

/** Emoji and CJK are counted as Unicode SCALAR values, not UTF-16 code units — an astral
 *  emoji is two code units but one scalar, so a query built from 2048 emoji scalars must be
 *  accepted and 2049 refused, never the code-unit count (4096/4098) sneaking through. */
async function caseLengthLimitCountsScalarsNotCodeUnits(): Promise<void> {
  assert.doesNotThrow(() => parse("😀".repeat(2048), "natural"));
  assert.throws(() => parse("😀".repeat(2049), "natural"),
    (e: unknown) => e instanceof Error && "code" in e && (e as { code: unknown }).code === "INVALID_INPUT");
}

async function caseEmptyAndWhitespaceOnlyQueriesBrowse(): Promise<void> {
  assert.equal(parse("", "natural").browse, true);
  assert.equal(parse("   ", "natural").browse, true);
  assert.equal(parse("alpha", "natural").browse, false);
}

// ── matchesArtifact: artifact-level AND/OR/NOT across passages/fields ──────────────────────

async function caseMatchesArtifactEvaluatesAndOrNotAcrossPassages(): Promise<void> {
  // "alpha" required-AND-satisfiable only by joining terms from TWO SEPARATE passages of the
  // same field — "terms can occur in different passages of the same artifact" (spec).
  const ast = parse('alpha "beta gamma" -delta', "websearch");
  const fieldsMatch = { body: ["alpha appears in the first passage", "an unrelated second passage naming beta gamma together"] };
  assert.equal(matchesArtifact(ast, fieldsMatch), true);
  const fieldsMissingPhrase = { body: ["alpha here", "beta appears", "gamma appears separately, never contiguous with beta"] };
  assert.equal(matchesArtifact(ast, fieldsMissingPhrase), false, "a phrase must be contiguous within one passage, not assembled across two");
  const fieldsExcluded = { body: ["alpha appears", "beta gamma together", "and this passage names delta too"] };
  assert.equal(matchesArtifact(ast, fieldsExcluded), false, "an excluded term anywhere in any field refuses the whole artifact");
}

async function caseMatchesArtifactOrSatisfiedByEitherAlternative(): Promise<void> {
  const ast = parse("alpha OR beta", "natural");
  assert.equal(matchesArtifact(ast, { title: ["only alpha is here"] }), true);
  assert.equal(matchesArtifact(ast, { title: ["only beta is here"] }), true);
  assert.equal(matchesArtifact(ast, { title: ["neither term is here"] }), false);
}

async function caseNaturalUnquotedWordsAreRankingHintsNotHardConditions(): Promise<void> {
  // Natural mode: a plain unquoted word never fails the artifact-level match on its own.
  const ast = parse("alpha", "natural");
  assert.equal(matchesArtifact(ast, { title: ["nothing matches here"] }), true,
    "an unquoted natural-mode word is a ranking hint, not a hard AND condition");
}

// ── serializeResults: byte-budget truncation, exact key set, no mid-record cut ─────────────

const OWNER = "11111111-1111-4111-8111-111111111111";

function fixtureRow(i: number, bodyBytes: number) {
  const snippet = "x".repeat(bodyBytes);
  return {
    ref: { owner_id: OWNER, artifact_id: `33333333-3333-4333-8333-${String(i).padStart(12, "0")}`, revision: 1, content_hash: "a".repeat(64) },
    record_digest: "b".repeat(64), etag: "1:1", path: `f-${i}.md`, title: `Fixture ${i}`,
    artifact_class: "work_document", type: "ground", scope: "current", shelf: "team",
    gate_status: null, knowledge_status: null, profile: "native",
    source_refs: [], source_refs_truncated: false, source_refs_cursor: null,
    snippet, snippet_byte_start: 0, snippet_byte_end: Buffer.byteLength(snippet),
    via: ["lexical"], corpora: ["team-fixture"], score: 1 / (61 + i),
  };
}

const ENVELOPE: ResultEnvelope = {
  index_generation: "fixture-generation", indexed_through: { [OWNER]: 1 },
  candidate_total: 0, mode_used: "natural", incomplete: false, reasons: [],
};

/** No helper-only bounded/omitted wrapper — the emitted top-level key set is EXACTLY
 *  `SearchResponseSchema`'s own, no more and no fewer, so a stray internal field could never
 *  silently ride along past `safeParse`'s own non-strict tolerance. */
async function caseWireKeysAreExactlyThePublicSchema(): Promise<void> {
  const rows = Array.from({ length: 3 }, (_, i) => fixtureRow(i, 20));
  const wire = serializeResults(rows, { ...ENVELOPE, candidate_total: 3 });
  // Read the RAW parsed keys, never `SearchResponseSchema.parse`'s own output — a non-strict
  // zod object silently strips unknown keys on `.parse`, which would hide exactly the
  // helper-only-field leak this case exists to catch.
  const parsed: unknown = JSON.parse(wire);
  assert.ok(parsed !== null && typeof parsed === "object");
  const actualKeys = Object.keys(parsed as Record<string, unknown>).sort();
  const expectedKeys = Object.keys(SearchResponseSchema.shape).sort();
  assert.deepEqual(actualKeys, expectedKeys);
}

/** Every emitted result is one of `candidateResults`' own elements, byte-for-byte — truncation
 *  never stops mid-record. Sized so the byte budget lands strictly between 0 and the full
 *  count, and each surviving result deep-equals its source row exactly. */
async function caseTruncationNeverStopsMidRecordAndDisclosesOmission(): Promise<void> {
  const rows = Array.from({ length: 40 }, (_, i) => fixtureRow(i, 1000));
  const wire = serializeResults(rows, { ...ENVELOPE, candidate_total: 40 });
  assert.ok(Buffer.byteLength(wire, "utf8") <= 24000);
  const response = JSON.parse(wire) as { results: unknown[]; returned: number; withheld_candidates: number; incomplete: boolean; reasons: string[] };
  assert.ok(response.results.length > 0 && response.results.length < 40);
  for (let i = 0; i < response.results.length; i++) assert.deepEqual(response.results[i], rows[i]);
  assert.equal(response.withheld_candidates, 40 - response.results.length);
  assert.equal(response.incomplete, true);
  assert.ok(response.reasons.includes("response_budget"));
}

/** THE MUTATION THIS CASE NAMES: slicing the already-stringified JSON at the byte budget,
 *  instead of dropping whole candidates and re-measuring, breaks the document. Proven directly
 *  — the naive slice on the SAME oversized wire this file's real `serializeResults` call
 *  produces is not itself valid JSON, which is exactly the defect never reaching a real caller. */
async function caseNaiveByteSliceWouldBreakTheDocument(): Promise<void> {
  const rows = Array.from({ length: 40 }, (_, i) => fixtureRow(i, 1000));
  const full = JSON.stringify({ schema_version: 2, results: rows, ...ENVELOPE, returned: 40, withheld_candidates: 0 });
  assert.ok(Buffer.byteLength(full, "utf8") > 24000, "fixture must actually overflow for this comparison to mean anything");
  const naiveSlice = Buffer.from(full, "utf8").subarray(0, 24000).toString("utf8");
  assert.throws(() => JSON.parse(naiveSlice), "a byte-boundary slice of the full document is not valid JSON — the fault this function avoids");
  const real = serializeResults(rows, { ...ENVELOPE, candidate_total: 40 });
  assert.doesNotThrow(() => JSON.parse(real), "the real serializer's output always parses, even at the same byte budget");
}

async function caseUntruncatedResponseOmitsResponseBudgetReason(): Promise<void> {
  const rows = Array.from({ length: 2 }, (_, i) => fixtureRow(i, 10));
  const wire = serializeResults(rows, { ...ENVELOPE, candidate_total: 2 });
  const response = JSON.parse(wire) as { returned: number; incomplete: boolean; reasons: string[]; withheld_candidates: number };
  assert.equal(response.returned, 2);
  assert.equal(response.withheld_candidates, 0);
  assert.equal(response.incomplete, false);
  assert.ok(!response.reasons.includes("response_budget"));
}

export const QUERY_CASES: Readonly<Record<string, () => Promise<void>>> = {
  lexer_ordering_preserves_unsplit_identifiers: caseLexerOrderingPreservesUnsplitIdentifiers,
  path_is_one_unsplit_term: casePathIsOneUnsplitTerm,
  unterminated_quote_names_its_own_position: caseUnterminatedQuoteNamesItsOwnPosition,
  websearch_unterminated_quote_runs_to_end_of_input: caseWebsearchUnterminatedQuoteRunsToEndOfInput,
  natural_or_is_case_sensitive_uppercase: caseNaturalOrIsCaseSensitiveUppercase,
  three_way_or_folds_into_one_group: caseThreeWayOrFoldsIntoOneGroup,
  dangling_or_is_dropped_not_guessed: caseDanglingOrIsDroppedNotGuessed,
  excluded_phrase_enters_exclusions_not_clauses: caseExcludedPhraseEntersExclusionsNotClauses,
  query_length_limit_refuses_oversized_input: caseQueryLengthLimitRefusesOversizedInput,
  phrase_length_limit_refuses_oversized_phrase: casePhraseLengthLimitRefusesOversizedPhrase,
  length_limit_counts_scalars_not_code_units: caseLengthLimitCountsScalarsNotCodeUnits,
  empty_and_whitespace_only_queries_browse: caseEmptyAndWhitespaceOnlyQueriesBrowse,
  matches_artifact_evaluates_and_or_not_across_passages: caseMatchesArtifactEvaluatesAndOrNotAcrossPassages,
  matches_artifact_or_satisfied_by_either_alternative: caseMatchesArtifactOrSatisfiedByEitherAlternative,
  natural_unquoted_words_are_ranking_hints_not_hard_conditions: caseNaturalUnquotedWordsAreRankingHintsNotHardConditions,
  wire_keys_are_exactly_the_public_schema: caseWireKeysAreExactlyThePublicSchema,
  truncation_never_stops_mid_record_and_discloses_omission: caseTruncationNeverStopsMidRecordAndDisclosesOmission,
  naive_byte_slice_would_break_the_document: caseNaiveByteSliceWouldBreakTheDocument,
  untruncated_response_omits_response_budget_reason: caseUntruncatedResponseOmitsResponseBudgetReason,
};
