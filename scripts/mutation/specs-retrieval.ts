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
    check: "scripts/gate/checks/han-analysis.ts",
    target: "an unspaced Han run is analysed into the terms a reader would search for",
    subject: "packages/indexing/src/tenant-analysis.ts",
    find: 'export const ANALYZER_NAME = "zz-lexical-v3";',
    replace: 'export const ANALYZER_NAME = "zz-lexical-v1";',
    planted: "the analyzer identity is rolled back to the previous generation, so every row " +
      "derived under the new analysis still reads as current",
  },
  {
    check: "scripts/gate/checks/write-path-analysis.ts",
    target: "new writes carry the analyzer's han terms and the row's own latin text, each to its own half",
    subject: "packages/indexing/src/tenant-analysis.ts",
    find: '    vector.raw.A, termsByWeight(vector, "A", "han"),',
    replace: '    termsByWeight(vector, "A", "latin"), termsByWeight(vector, "A", "han"),',
    planted: "the latin half of body_tsv goes back to the analyzer's already-split words, so " +
      "every compound token PostgreSQL's parser would emit is lost while the read path's " +
      "websearch_to_tsquery goes on asking for it — the defect that cost 778 of 1033 " +
      "documents their own title on a faithful copy of this deployment",
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
    check: "scripts/gate/checks/text-search-config-agreement.ts",
    target: "no file names a text-search configuration except the one constant that defines them",
    subject: "packages/indexing/src/index.ts",
    find: "             ${bodyTsvSql(12)})",
    replace: "             to_tsvector('simple', $12))",
    planted: "a write path spells its own text-search configuration inline instead of taking " +
      "it from the one constant, which is how the read and write halves drifted apart before",
  },
  {
    check: "scripts/gate/checks/text-search-config-agreement.ts",
    target: "the read path queries with the configuration the write path stored a latin term through",
    subject: "services/zz-core/src/tools/search-predicate.ts",
    find: "const QUERY_CONFIG = sqlLiteral(TEXT_SEARCH_CONFIG.latin);",
    // The other half of the same constant, not a bare literal. `"simple"` here would leave
    // `TEXT_SEARCH_CONFIG` imported and unused and turn the build red beside the row, and a red
    // build means the row cannot be taken at face value. The planted defect is the read path
    // reaching for the Han configuration.
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
    target: "new writes carry the analyzer's han terms and the row's own latin text, each to its own half",
    subject: "packages/indexing/src/index.ts",
    // The call is replaced, not decorated. Appending `::tsvector` after the interpolation leaves
    // `${bodyTsvSql(12)}` intact, and that expression is what the check counts.
    find: "${bodyTsvSql(12)})",
    replace: "to_tsvector($12))",
    planted: "one INSERT stops building its index vector from the shared construction, so a " +
      "newly written document is indexed by something other than the analyzer",
  },
  {
    check: "scripts/gate/checks/legacy-han-retrieval.ts",
    target: "the legacy handler builds a predicate that can match a term inside an unspaced Han run",
    subject: "services/zz-core/src/tools/search-predicate.ts",
    // The predicate is removed, not weakened. Putting `true or` in front of it defeats the
    // restriction at runtime and still leaves the words `team_slug` in the statement, which is
    // what the check tests for — and what that clause asks is whether the scope predicate is
    // still being built at all.
    find: "  const cond = [`team_slug = any(",
    replace: "  const cond = [`true = any(",
    planted: "the scope predicate loses the column it restricts on, so the statement no longer " +
      "narrows a knowledge query to the caller's own shelves",
  },
];
