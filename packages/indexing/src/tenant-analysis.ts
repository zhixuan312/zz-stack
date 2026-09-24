/**
 * The versioned text analyzer for the tenant-information corpus. `ANALYZER_NAME` is which
 * version this build is.
 *
 * Three pure functions, no filesystem or database access: `passagesOf` (bounded overlapping
 * passages over a body of any length), `identifierTokens` (an identifier's exact spelling plus
 * its lowercased split parts), `derivationFingerprint` (hash over record format, parser,
 * analyzer, passage shape, projection shape and source content hash — changing `analyzer`
 * alone changes it, which is how a rebuild tells a stale derivation from a changed source).
 *
 * COUPLED: `index.ts` writes `zz.doc` with a fixed 200,000-character cutoff and is the live
 * indexing path; this file's passages feed the derived search tables. Do not unify the
 * cutoffs.
 *
 * DELIBERATE: `identifierTokens` has no operator syntax. The query lexer strips quotes, OR and
 * exclusions first, so a `/` or `-` inside a path cannot trip it.
 *
 * DELIBERATE: passage `start`/`end` are UTF-8 byte offsets (`Buffer.byteLength`, never
 * `.length`). They agree with character offsets only for pure ASCII, and a character offset
 * stored under a byte-offset name is still a valid integer, so it corrupts silently.
 */
import { createHash } from "node:crypto";

// The analyzer's own version, and the size the kernel is contracted to refuse

/** Named so an incompatible analyzer is a new name rather than a silent behaviour change under
 *  the old one. Callers pass it into `derivationFingerprint` as `analyzer`.
 *
 *  COUPLED: the rederivation walker rewrites a row only when
 *  `analyzer_version !== request.analyzer`, so bumping this name is what makes rows written
 *  under a broken construction repairable. */
export const ANALYZER_NAME = "zz-lexical-v3";
export const CURRENT_ANALYZER_VERSION = 3;

/** 8 MiB. New artifact text above this is refused by the kernel before commit. Legacy content
 *  already larger, committed before the limit existed, is preserved and indexed under the
 *  migration exception (`imported: true` below), never truncated. */
export const MAX_INPUT_BYTES = 8 * 1024 * 1024;

/** Thrown by `assertWithinInputLimit`. Carries the actual and allowed sizes as fields, not only
 *  in the message, so a caller building a structured refusal does not parse them back out of an
 *  Error. */
export class InputTooLargeError extends Error {
  constructor(public readonly actualBytes: number, public readonly allowedBytes: number) {
    super(`input is ${actualBytes} bytes, which is over the ${allowedBytes}-byte limit`);
    this.name = "InputTooLargeError";
  }
}

/** The kernel's size gate. `imported` is the one escape hatch: content already durable from
 *  before this limit existed is indexed as-is, never refused and never truncated. Everything
 *  else is measured in bytes, not characters.
 *
 *  Not yet called from a commit path; `services/zz-core/src/tenant-info/record.ts` would. */
export function assertWithinInputLimit(bytes: number, opts: { readonly imported?: boolean } = {}): void {
  if (opts.imported) return;
  if (bytes > MAX_INPUT_BYTES) throw new InputTooLargeError(bytes, MAX_INPUT_BYTES);
}

// Passages

export interface Passage {
  /** UTF-8 byte offset, inclusive. */
  readonly start: number;
  /** UTF-8 byte offset, exclusive. */
  readonly end: number;
  readonly text: string;
}

/** A passage holds at most this many Unicode scalar values — `[...text].length`, which counts
 *  an astral character as one, not the two UTF-16 code units `.length` would count. */
export const PASSAGE_MAX_SCALARS = 8192;

/** How far a passage backs up into the one before it, in scalar values, so any phrase shorter
 *  than this survives a split it would otherwise be cut by. */
export const PASSAGE_OVERLAP_SCALARS = 512;

/** How far back from a forced boundary this looks for a whitespace scalar before giving up. A
 *  run with no whitespace in the whole window splits at exactly `PASSAGE_MAX_SCALARS`, never at
 *  a point that depends on the rest of the document. */
const BOUNDARY_SEARCH_WINDOW = 512;

const isWhitespaceScalar = (s: string): boolean => /\s/.test(s);

/** Bounded, overlapping, byte-offset passages over `body`, covering every byte with no
 *  truncation at any size. Splits into Unicode scalar values (`Array.from`, surrogate-pair
 *  aware), keeps a running UTF-8 byte offset per scalar boundary so `start`/`end` always fall on
 *  a valid UTF-8 boundary, then walks forward: each passage at most `PASSAGE_MAX_SCALARS` long,
 *  preferring to end on whitespace within `BOUNDARY_SEARCH_WINDOW` scalars of the ceiling, and
 *  starting `PASSAGE_OVERLAP_SCALARS` scalars before the previous passage's end. `text` is
 *  exactly what `buf.subarray(start, end).toString('utf8')` reconstructs.
 *
 *  An empty body produces no passages. */
export function passagesOf(body: string): Passage[] {
  const scalars = Array.from(body);
  const n = scalars.length;
  if (n === 0) return [];

  const byteOffsetAt = new Array<number>(n + 1);
  byteOffsetAt[0] = 0;
  for (let i = 0; i < n; i++) byteOffsetAt[i + 1] = byteOffsetAt[i] + Buffer.byteLength(scalars[i], "utf8");

  const passages: Passage[] = [];
  let startIdx = 0;
  let previousEndIdx = -1;
  while (startIdx < n) {
    let endIdx = Math.min(startIdx + PASSAGE_MAX_SCALARS, n);
    if (endIdx < n) {
      const floor = Math.max(startIdx + 1, endIdx - BOUNDARY_SEARCH_WINDOW);
      let boundary = -1;
      for (let i = endIdx; i > floor; i--) {
        if (isWhitespaceScalar(scalars[i - 1])) { boundary = i; break; }
      }
      // No whitespace anywhere in the window: an oversized uninterrupted run, forced to split
      // at the scalar ceiling rather than growing past it looking for one that never comes.
      if (boundary !== -1) endIdx = boundary;
    }
    // Forward progress past whatever the last passage already covered — required so the
    // overlap this passage starts with can never make it end before the previous one did.
    if (previousEndIdx !== -1 && endIdx <= previousEndIdx) endIdx = Math.min(n, previousEndIdx + 1);

    passages.push({ start: byteOffsetAt[startIdx], end: byteOffsetAt[endIdx], text: scalars.slice(startIdx, endIdx).join("") });
    previousEndIdx = endIdx;
    if (endIdx >= n) break;

    const overlapStart = endIdx - PASSAGE_OVERLAP_SCALARS;
    startIdx = overlapStart > startIdx ? overlapStart : startIdx + 1;
  }
  return passages;
}

// Identifier analysis

const DELIMITER_RUN = /[._/:-]+/;
// Boundaries inserted with a NUL marker and split on it at the end, applied in this order:
//   lower/digit → Upper   ("fooBar" → "foo\0Bar", "v2Config" → "v2\0Config")
//   an acronym run followed by a Capitalized word ("HTTPServer" → "HTTP\0Server")
//   letter → digit and digit → letter, either direction ("v2" → "v\02", "2v" → "2\0v")
const LOWER_OR_DIGIT_TO_UPPER = /([a-z0-9])([A-Z])/g;
const ACRONYM_TO_WORD = /([A-Z]+)([A-Z][a-z])/g;
const LETTER_TO_DIGIT = /([A-Za-z])(\d)/g;
const DIGIT_TO_LETTER = /(\d)([A-Za-z])/g;

/** camelCase, acronym and letter-digit boundaries within one delimiter-free part, as lowercase
 *  derived tokens. `"plugin"` stays `["plugin"]`; `"v2"` becomes `["v", "2"]`; `"HTTPServer2"`
 *  becomes `["http", "server", "2"]`. */
function splitLatinBoundaries(part: string): string[] {
  const marked = part
    .replace(LOWER_OR_DIGIT_TO_UPPER, "$1\u0000$2")
    .replace(ACRONYM_TO_WORD, "$1\u0000$2")
    .replace(LETTER_TO_DIGIT, "$1\u0000$2")
    .replace(DIGIT_TO_LETTER, "$1\u0000$2");
  return marked.split("\u0000").filter((s) => s.length > 0);
}

/** The identifier's own unsplit spelling — verbatim, exact case and punctuation — plus every
 *  lowercased part `.`/`_`/`/`/`-`/`:`, camelCase, acronym and letter-digit splitting derives
 *  from it. Flat and deduplicated; order carries no meaning.
 *
 *  Called on text whose query operators a lexer has already stripped; this function has none. */
export function identifierTokens(raw: string): string[] {
  const tokens = new Set<string>();
  tokens.add(raw);
  for (const part of raw.split(DELIMITER_RUN)) {
    if (!part) continue;
    for (const sub of splitLatinBoundaries(part)) tokens.add(sub.toLowerCase());
  }
  return [...tokens];
}

// Zz-lexical-v2: Han unigram and adjacent-bigram analysis

/** Which kind of scalar run a base term came from, carried on the term so a consumer of
 *  `analyze`'s output can tell a single Han character from a Latin word without re-classifying
 *  it. */
export type AnalysisField = "han" | "latin";

export interface AnalysisTerm {
  readonly term: string;
  readonly field: AnalysisField;
  /** Sequential index into the base sequence alone; ranking bigrams are a separate list and
   *  never consume a position. Boolean and phrase verification can read `position` as "how many
   *  base terms came before this one" with no gaps. */
  readonly position: number;
  /** UTF-8 byte offset into the original string, inclusive. */
  readonly start: number;
  /** UTF-8 byte offset into the original string, exclusive. */
  readonly end: number;
}

export interface AnalysisResult {
  /** Han unigrams and Latin words, in original order, each carrying its own byte range. The
   *  sequence boolean/phrase verification runs over. */
  readonly base: readonly AnalysisTerm[];
  /** Adjacent Han-scalar-pair ranking terms, encoded by `encodeHanBigram` below. A ranking
   *  hint only — never part of `base`, never assigned a `position`, never touched by boolean
   *  or phrase verification. */
  readonly ranking: readonly string[];
}

const HAN_SCALAR = /\p{Script=Han}/u;
/** A scalar that belongs to a Latin word run: any letter or number in any non-Han script,
 *  underscore included. `analyze` hands the backend raw, unstemmed word text.
 *
 *  COUPLED: stemming happens in the backend's `TEXT_SEARCH_CONFIG.latin` configuration, which
 *  `bodyTsvSql` routes `"latin"` terms through. A Latin word stored unstemmed cannot be found by
 *  the stemmed query the read path sends. */
const LATIN_WORD_SCALAR = /[\p{L}\p{N}_]/u;

/** `zh` + each of two adjacent Han scalars as six lowercase zero-padded hex digits — exactly
 *  fourteen ASCII characters. `String.fromCodePoint`/`codePointAt` throughout this file (never
 *  `.charCodeAt`, never a UTF-16 code unit) so a supplementary-plane Han character encodes as
 *  one scalar's six hex digits, not two surrogates' worth. */
function encodeHanBigram(a: string, b: string): string {
  const hex = (scalar: string) => scalar.codePointAt(0)!.toString(16).padStart(6, "0");
  return `zh${hex(a)}${hex(b)}`;
}

/** Han unigrams, overlapping adjacent Han bigrams, and Latin words, over Unicode scalar values
 *  (`Array.from`, surrogate-pair aware), each term's `start`/`end` mapped back to UTF-8 byte
 *  offsets.
 *
 *  Each Han scalar is one base term and, when the immediately preceding scalar was also Han,
 *  forms one ranking bigram with it — so a Han scalar on either side of a Latin word never pairs
 *  across it. A run of Latin/digit/underscore scalars becomes one base term keeping its exact
 *  spelling, unstemmed and unsplit. Whitespace and punctuation produce no term. */
export function analyze(text: string): AnalysisResult {
  const scalars = Array.from(text);
  const n = scalars.length;

  const byteOffsetAt = new Array<number>(n + 1);
  byteOffsetAt[0] = 0;
  for (let i = 0; i < n; i++) byteOffsetAt[i + 1] = byteOffsetAt[i] + Buffer.byteLength(scalars[i], "utf8");

  const base: AnalysisTerm[] = [];
  const ranking: string[] = [];
  let position = 0;
  let wordStart = -1;
  let previousHan: string | null = null;

  const flushWord = (endIdx: number): void => {
    if (wordStart === -1) return;
    base.push({
      term: scalars.slice(wordStart, endIdx).join(""), field: "latin", position: position++,
      start: byteOffsetAt[wordStart], end: byteOffsetAt[endIdx],
    });
    wordStart = -1;
  };

  for (let i = 0; i < n; i++) {
    const scalar = scalars[i];
    if (HAN_SCALAR.test(scalar)) {
      flushWord(i);
      base.push({ term: scalar, field: "han", position: position++, start: byteOffsetAt[i], end: byteOffsetAt[i + 1] });
      if (previousHan !== null) ranking.push(encodeHanBigram(previousHan, scalar));
      previousHan = scalar;
      continue;
    }
    previousHan = null;
    if (LATIN_WORD_SCALAR.test(scalar)) {
      if (wordStart === -1) wordStart = i;
      continue;
    }
    flushWord(i);
  }
  flushWord(n);

  return { base, ranking };
}

// Row vectors: title/tags/body → weighted analyzer terms

/** The three fields `buildRowVector` weights a row by: title strongest, tags next, body widest.
 *  A private organizing type; `RowVectorTerm.weight` on the public shape is `string`, not this. */
export type RowVectorWeight = "A" | "B" | "C";

export interface RowVectorTerm {
  readonly term: string;
  // DELIBERATE: `string`, not `RowVectorWeight`. A caller that groups terms by a weight read off
  // a literal array widened to `string[]` must be able to compare it against this field without
  // narrowing it first.
  readonly weight: string;
  /** Which of the two configurations in `TEXT_SEARCH_CONFIG` this term is stored through.
   *  Carried per term, not per field, because one field's text produces both kinds: a Han unigram
   *  or ranking bigram (`"han"`) must reach the index unaltered, a Latin word (`"latin"`) must
   *  reach it stemmed. See `bodyTsvSql` below. */
  readonly field: AnalysisField;
}

export interface RowVector {
  /** One entry per analyzer-emitted term, each carrying the weight of the field it came
   *  from — not grouped by weight; `termsByWeight` below does that for a caller that wants
   *  `to_tsvector('simple', …)`'s three space-joined strings. */
  readonly terms: readonly RowVectorTerm[];
  /** The raw text of each weighted field, exactly as the row holds it. The Latin half of
   *  `body_tsv` is built from this and never from `terms`; the Han half comes from `terms`
   *  through `simple`, since those unigrams are what PostgreSQL's parser cannot produce.
   *
   *  DELIBERATE: the Latin half must be tokenized by the same engine as the query, PostgreSQL's
   *  parser over unsplit text. Pre-splitting destroys every compound the parser would emit —
   *  `sdlc-deck` becomes `sdlc` + `deck` — so the adjacency `websearch_to_tsquery` asks for is
   *  gone and the match is false while the row looks indexed.
   *
   *  DELIBERATE: it lives on the vector rather than in a second argument to `bodyTsvParams`, so
   *  no call site can build the two halves of one row from different text. */
  readonly raw: Readonly<Record<RowVectorWeight, string>>;
  readonly analyzer: string;
}

/** One field's analyzer-emitted terms, tagged with the weight the field owns, not the kind of
 *  term. A Han unigram, a Latin word and a Han ranking bigram from the same field all carry the
 *  same weight. */
function fieldTerms(text: string, weight: RowVectorWeight): RowVectorTerm[] {
  const { base, ranking } = analyze(text);
  return [
    ...base.map((t) => ({ term: t.term, weight, field: t.field })),
    // A ranking bigram is derived from a Han pair and is just as opaque as the unigrams it
    // pairs, so it travels the Han half: `zh008fc10079fb` must be stored exactly, never stemmed.
    ...ranking.map((term) => ({ term, weight, field: "han" as const })),
  ];
}

/** Turns title/tags/body into the flat, weighted term list `body_tsv` is built from: title `A`,
 *  tags `B`, body `C`.
 *
 *  COUPLED: the write path (`indexDoc` in `index.ts`) and the rederivation pass
 *  (`rebuildRowVector` in `tenant-rebuild.ts`) both import this export. */
export function buildRowVector(input: {
  readonly title: string;
  readonly tags: readonly string[];
  readonly body: string;
}): RowVector {
  const tags = input.tags.join(" ");
  return {
    terms: [
      ...fieldTerms(input.title, "A"),
      ...fieldTerms(tags, "B"),
      ...fieldTerms(input.body, "C"),
    ],
    raw: { A: input.title, B: tags, C: input.body },
    analyzer: ANALYZER_NAME,
  };
}

/** One weight's terms for one configuration, space-joined — the shape each `to_tsvector` call in
 *  `bodyTsvSql` takes. A grouping step over `buildRowVector`'s output; the weighting and the
 *  `field` split already happened there and in `analyze`. */
export function termsByWeight(vector: RowVector, weight: RowVectorWeight, field: AnalysisField): string {
  return vector.terms
    .filter((t) => t.weight === weight && t.field === field)
    .map((t) => t.term)
    .join(" ");
}

// The one place a text-search configuration name is written

/** The two PostgreSQL text-search configurations one row's `body_tsv` is built from. Latin words
 *  go through the configuration the query side uses, so stemming happens once on both sides and
 *  agrees; Han unigrams and bigrams go through `simple`, so nothing rewrites them. The halves
 *  are concatenated into one `body_tsv`, one `setweight` per half per weight.
 *
 *  COUPLED: this is the only place either name appears. `index.ts`, `rederivation.ts` and
 *  `services/zz-core/src/tools/knowledge-search.ts` all read it from here. */
export const TEXT_SEARCH_CONFIG: Readonly<Record<AnalysisField, string>> = {
  latin: "english",
  han: "simple",
};

/** The `body_tsv` expression, parameterised — the single construction every writer of this
 *  column uses. Consumes eight bind parameters starting at `first`, in the order `bodyTsvParams`
 *  returns them: two `regconfig` names, then six space-joined term strings (A/B/C x latin/han).
 *  The caller numbers its own remaining parameters after `first + 7`. The configuration is
 *  bound, never interpolated, so the output carries no SQL text derived from a string. */
export function bodyTsvSql(first: number): string {
  const p = (n: number): string => `$${first + n}`;
  const half = (field: 0 | 1, termIndex: number, weight: RowVectorWeight): string =>
    `setweight(to_tsvector(${p(field)}::regconfig, ${p(termIndex)}::text), '${weight}')`;
  return [
    half(0, 2, "A"), half(1, 3, "A"),
    half(0, 4, "B"), half(1, 5, "B"),
    half(0, 6, "C"), half(1, 7, "C"),
  ].join(" || ");
}

/** The eight values `bodyTsvSql` binds, in its order. */
export function bodyTsvParams(vector: RowVector): string[] {
  return [
    TEXT_SEARCH_CONFIG.latin, TEXT_SEARCH_CONFIG.han,
    vector.raw.A, termsByWeight(vector, "A", "han"),
    vector.raw.B, termsByWeight(vector, "B", "han"),
    vector.raw.C, termsByWeight(vector, "C", "han"),
  ];
}

// Derivation fingerprint

/** Every version that decided the shape of one derived row, plus the hash of the source bytes
 *  those derivations ran over. `content_hash` changing means the source changed; any other field
 *  changing means a derivation changed while the source did not. Both are reasons to rebuild. */
export interface DerivationVersions {
  readonly content_hash: string;
  readonly record_format: number;
  readonly parser: number;
  readonly analyzer: number;
  readonly passage: number;
  readonly projection: number;
}

/** A stable hash over exactly the fields above, in one fixed field order — an explicit object
 *  literal rather than a generic key-sort, so there is no field this can hash that the type does
 *  not name. Consumed by a rebuild/projection cache to decide staleness independently of whether
 *  the source bytes changed. */
export function derivationFingerprint(v: DerivationVersions): string {
  return createHash("sha256").update(JSON.stringify({
    content_hash: v.content_hash, record_format: v.record_format, parser: v.parser,
    analyzer: v.analyzer, passage: v.passage, projection: v.projection,
  })).digest("hex");
}

// Analyzer opacity: the fixed case list a live PostgreSQL proves this analyzer's terms
// Survive text analysis unaltered

/** Four raw seed strings, one per shape: Han, Latin, mixed (interleaved, so a bigram never pairs
 *  across a Latin run) and identifier.
 *
 *  DELIBERATE: the Han/Latin/mixed seeds are lowercase, so a case-folding dictionary cannot
 *  report a mangled term for a reason unrelated to opacity. The identifier seed keeps mixed case
 *  and a `_`/`-`/`.` mix, because `emittedTermsFor` below never submits it verbatim. */
const OPACITY_SEED_TEXT = {
  han: "这是一段测试用的中文文本",
  latin: "schema migration reader",
  mixed: "这次 migration 会 rebuild 索引 schema",
  identifier: "httpServer2_config-reader.v2",
} as const;

/** The seeds above in one fixed, ordered list. Exported so `analyzer-opacity-run.ts` and
 *  anything auditing this fixture can see what was fed to the analyzer, separately from the
 *  terms analysis produced. */
export const OPACITY_SEEDS: readonly string[] = Object.values(OPACITY_SEED_TEXT);

/** Every term one seed contributes to `OPACITY_CASES`. The Han/Latin/mixed seeds run through
 *  `analyze` alone.
 *
 *  DELIBERATE: the identifier seed runs through `identifierTokens` and only its derived lowercase
 *  parts are kept, never the verbatim compound spelling `tokens.add(raw)` also emits. That
 *  spelling is looked up through an exact-string path
 *  (`zz.artifact_identifier.identifier_text`/`normalized_text`), never `to_tsvector`, and a
 *  compound still carrying `_`/`-` would test PostgreSQL's delimiter handling instead. */
function emittedTermsFor(seed: string): string[] {
  if (seed === OPACITY_SEED_TEXT.identifier) {
    return identifierTokens(seed).filter((token) => token !== seed);
  }
  const { base, ranking } = analyze(seed);
  return [...base.map((t) => t.term), ...ranking];
}

/** Every term the current analyzer emits for `OPACITY_SEEDS`, flattened and de-duplicated in
 *  first-seen order. `analyzer-opacity-run.ts` submits each to a live pinned PostgreSQL through
 *  `to_tsvector('simple', …)` and requires it back byte-identical. That is a claim about the Han
 *  half only: a `"latin"` term is stored through `TEXT_SEARCH_CONFIG.latin`, which stems, so
 *  byte-identity there would be a defect. The Latin and identifier seeds are controls on the
 *  tokenizer's splitting behaviour.
 *
 *  COUPLED: `scripts/gate/checks/analyzer-opacity-fixture.ts` re-derives this list, so any change
 *  to what the analyzer emits changes `analyzerDigestFor`'s result. */
export const OPACITY_CASES: readonly string[] = [...new Set(OPACITY_SEEDS.flatMap(emittedTermsFor))];

/** A stable SHA-256 over the exact ordered term list `cases`, as JSON. Order- and
 *  content-sensitive: recomputing it against the current `OPACITY_CASES` and comparing to a
 *  fixture's recorded `provenance.analyzer_digest` is how the gate tells a stale fixture from a
 *  current one. */
export function analyzerDigestFor(cases: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(cases)).digest("hex");
}
