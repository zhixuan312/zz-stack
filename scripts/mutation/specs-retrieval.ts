/**
 * Defects planted in `@zz/indexing` and in the retrieval evidence on disk.
 *
 * These reach their checks the same way the kernel ones do — through `npm run -s build`, the
 * gate's first check — so the same type-validity rule applies to every source mutation here.
 * The two fixture mutations are different in kind and not in rigour: `analyzer-opacity` and
 * the judged corpus are evidence files, and a check that rests on evidence is checked by
 * corrupting the evidence rather than the code that reads it.
 */
import type { MutationSpec } from "./plant.ts";

export const RETRIEVAL_SPECS: readonly MutationSpec[] = [
  {
    check: "scripts/gate/checks/analyzer-opacity-fixture.ts",
    target: "the analyzer-opacity fixture records a real run of the CURRENT analyzer",
    subject: "testing/tenant-info/analyzer-opacity.golden.json",
    find: '"analyzer_digest"',
    replace: '"analyzer_digest_was"',
    all: true,
    planted: "the fixture no longer carries the analyzer digest it was generated from, so a " +
      "hand-written file is indistinguishable from a recorded run",
  },
  {
    check: "scripts/gate/checks/han-analysis.ts",
    target: "an unspaced Han run is analysed into the terms a reader would search for",
    subject: "packages/indexing/src/tenant-analysis.ts",
    find: 'export const ANALYZER_NAME = "zz-lexical-v2";',
    replace: 'export const ANALYZER_NAME = "zz-lexical-v1";',
    planted: "the analyzer identity is rolled back to the previous generation, so every row " +
      "derived under the new analysis still reads as current",
  },
  {
    check: "scripts/gate/checks/native-lane-applicability.ts",
    target: "native lanes keep their own applicability and grow no tag lane",
    subject: "packages/indexing/src/tenant-projections.ts",
    find: "  const hasAnalyzableTerm = leaves.some((c) => analyze(c.text).base.length > 0);",
    replace: "  const hasAnalyzableTerm = leaves.some((c) => analyze(c.text).base.length > 99);",
    planted: "prose stops counting as analyzable, so an unspaced Han query never reaches the " +
      "ranking lane that can match inside it",
  },
  {
    check: "scripts/gate/checks/query-grammar.ts",
    target: "query grammar survives a Chinese query with a phrase and an exclusion",
    subject: "packages/indexing/src/query-grammar.ts",
    find: '      ? { kind: "exclude", text: tok.text }',
    replace: '      ? { kind: "term", text: tok.text }',
    planted: "a `-`-prefixed token is emitted as an ordinary term, so an exclusion silently " +
      "stops excluding anything and quietly widens the search instead",
  },
  {
    check: "scripts/gate/checks/rederivation-generation.ts",
    target: "rederivation covers old rows and refuses to mix analyzer generations",
    subject: "packages/indexing/src/rederivation.ts",
    find: "  return { corpora: [...REDERIVABLE_CORPORA], skipUnchangedContentHash: false, resumable: true };",
    replace: "  return { corpora: [...REDERIVABLE_CORPORA], skipUnchangedContentHash: true, resumable: true };",
    planted: "the rebuild skips every row whose content hash is unchanged — but the analyzer " +
      "changed and the hash did not, so the old corpus is never rederived",
  },
  {
    check: "scripts/gate/checks/scope-filters-survive-lanes.ts",
    target: "an unmappable scope restriction is refused rather than silently dropped",
    subject: "packages/indexing/src/search-plan.ts",
    find: "  const unmapped = unmappedScopeFilter(filters);",
    replace: "  const unmapped = unmappedScopeFilter({});",
    planted: "the unmappable-filter test is run against an empty filter set instead of the " +
      "caller's, so a restriction no native table carries is silently dropped rather than refused",
  },
  {
    // THE SECOND CHECK IN THIS FILE. Rows are per registered check, not per file: its sibling
    // above only ever exercises an UNMAPPABLE filter, which returns before a stage is planned,
    // so a mutation aimed at this one cannot be satisfied by tripping that one.
    check: "scripts/gate/checks/scope-filters-survive-lanes.ts",
    target: "a tag restriction reaches every lane, rescue and page",
    subject: "packages/indexing/src/search-plan.ts",
    find: "  const appliedFilters = { tag: filters.tag !== undefined } as const;",
    replace: "  const appliedFilters = { tag: false } as const;",
    planted: "every planned stage reports that it applied no tag restriction, so a caller's " +
      "narrowing is carried nowhere and nothing downstream can tell that it was dropped",
  },
  {
    check: "scripts/gate/checks/text-search-config-agreement.ts",
    target: "the native-projection index is still the only text-search configuration outside the agreement",
    subject: "packages/indexing/src/tenant-projections.ts",
    find: "using gin (to_tsvector('english', raw_body))",
    replace: "using gin (to_tsvector('english', body))",
    planted: "the one site excluded from the body_tsv agreement stops being the raw-prose " +
      "index it was excused for and points at the column the agreement governs, which is the " +
      "move that would silently put a second configuration in charge of body_tsv",
  },
  {
    check: "scripts/gate/checks/text-search-config-agreement.ts",
    target: "no file names a text-search configuration except the one constant that defines them",
    subject: "packages/indexing/src/index.ts",
    find: "${bodyTsvSql(19)})",
    replace: "to_tsvector('simple', $19))",
    planted: "a write path spells its own text-search configuration inline instead of taking " +
      "it from the one constant, which is how the read and write halves drifted apart before",
  },
  {
    check: "scripts/gate/checks/text-search-config-agreement.ts",
    target: "the read path queries with the configuration the write path stored a latin term through",
    subject: "services/zz-core/src/tools/knowledge-search.ts",
    find: "const QUERY_CONFIG = sqlLiteral(TEXT_SEARCH_CONFIG.latin);",
    // THE OTHER HALF OF THE SAME CONSTANT, not a bare literal. Writing `"simple"` here left
    // `TEXT_SEARCH_CONFIG` imported and unused, so the build went red beside the row and a
    // red build means a row cannot be taken at face value — this planted defect is the read
    // path reaching for the Han configuration, which is a thing the code could plausibly do.
    replace: "const QUERY_CONFIG = sqlLiteral(TEXT_SEARCH_CONFIG.han);",
    planted: "the read path parses an ascii query through a non-stemming configuration while " +
      "the write path stored the word stemmed, so an English word whose stem differs from its " +
      "surface form stops being findable with no error and nothing in the row to see",
  },
  {
    check: "scripts/gate/checks/snippet-byte-ranges.ts",
    target: "a snippet addresses original bytes and never splits a CJK character or an emoji",
    subject: "packages/indexing/src/snippet.ts",
    find: "  while (start > 0 && isContinuationByte(bytes[start])) start--;",
    replace: "  while (start < 0 && isContinuationByte(bytes[start])) start--;",
    planted: "a snippet's start is no longer widened onto a lead byte, so a citation that " +
      "begins mid-character comes back with a replacement character in it",
  },
  {
    check: "scripts/gate/checks/text-search-config-agreement.ts",
    target: "the analyzer's opaque terms and its stemmable words are stored through different configurations",
    subject: "packages/indexing/src/tenant-analysis.ts",
    find: '  han: "simple",',
    replace: '  han: "english",',
    planted: "the opaque half of the analyzer is stored through a stemming configuration, " +
      "which rewrites a ranking bigram on its way in and leaves no trace that it did",
  },
  {
    check: "scripts/gate/checks/write-path-analysis.ts",
    target: "new writes are analysed by the analyzer, not by a prose text-search configuration",
    subject: "packages/indexing/src/index.ts",
    // THE CALL IS REPLACED, NOT DECORATED. A first attempt appended `::tsvector` after the
    // interpolation, which leaves `${bodyTsvSql(12)}` intact — and that expression IS what the
    // check counts. It survived because nothing it measures had changed.
    find: "${bodyTsvSql(12)})",
    replace: "to_tsvector($12))",
    planted: "one INSERT stops building its index vector from the shared construction, so a " +
      "newly written document is indexed by something other than the analyzer",
  },
  {
    check: "scripts/gate/checks/judged-corpus-census.ts",
    target: "the judged corpus still has the census every retrieval target is measured against",
    subject: "testing/tenant-info/queries.jsonl",
    find: '{"id":"Q0001",',
    replace: '{"id":"Q0002",',
    planted: "two judged queries share one id, so the census counts six hundred rows and " +
      "fewer than six hundred distinct cases",
  },
  {
    check: "scripts/gate/checks/legacy-han-retrieval.ts",
    target: "the legacy handler builds a predicate that can match a term inside an unspaced Han run",
    subject: "services/zz-core/src/tools/knowledge-search.ts",
    // THE PREDICATE IS REMOVED, NOT WEAKENED. A first attempt put `true or` in front of it,
    // which defeats the restriction at runtime and still leaves the words `team_slug` in the
    // statement — and the check tests that the SQL CONTAINS them. It survived, correctly:
    // what that clause asks is whether the scope predicate is still being built at all.
    find: "  const cond = [`team_slug = any(",
    replace: "  const cond = [`true = any(",
    planted: "the scope predicate loses the column it restricts on, so the statement no longer " +
      "narrows a knowledge query to the caller's own shelves",
  },
  {
    check: "scripts/gate/checks/benchmark-report-slices.ts",
    target: "a benchmark report proves each language slice separately or leaves its target blocked",
    subject: "scripts/tenant-info/benchmark.ts",
    find: "  return { passed: failed.length === 0 && blocked.length === 0, failed, blocked, outcomes };",
    replace: "  return { passed: failed.length === 0, failed, blocked, outcomes };",
    planted: "a target nobody measured stops holding the verdict back, so a run with no " +
      "observations at all evaluates to a pass — absence read as zero",
    caveat: "only the FIRST assertion of this check is reachable in a gate run — see the " +
      "unreachable-region finding recorded against it",
  },
];
