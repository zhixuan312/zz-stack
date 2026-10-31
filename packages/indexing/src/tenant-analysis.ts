/**
 * The versioned text analyzer for the tenant-information corpus. `ANALYZER_NAME` is which
 * version this build is.
 *
 * COUPLED: every analyzed body goes through `buildRowVector` below — a document write
 * (`document-save.ts`), a journal node (`index.ts`'s `indexNode`), a team reindex and the
 * rederivation pass. No writer cuts a body: `MAX_INPUT_BYTES` is the only bound, and a body past it
 * is refused, never shortened.
 */
import { UPLOAD_MAX_BYTES } from "@zz/contracts";

// The analyzer's own version, and the size the kernel is contracted to refuse

/** Named so an incompatible analyzer is a new name rather than a silent behaviour change under
 *  the old one.
 *
 *  COUPLED: the rederivation walk (`index.ts`'s `rederiveRows`) rewrites a row only when its
 *  `analyzer_version` is distinct from this name, unless forced, so bumping this name is what
 *  makes rows written under a broken construction repairable. */
export const ANALYZER_NAME = "zz-lexical-v4";

/** The most a stored body may be, in UTF-8 bytes: the upload limit's own figure, so a file one
 *  upload may carry is a body a write accepts. A body above it is refused where it is analyzed
 *  (`buildRowVector`, which every write path goes through) and never truncated to fit. */
export const MAX_INPUT_BYTES = UPLOAD_MAX_BYTES;

/** Thrown by `assertWithinInputLimit`. Carries the actual and allowed sizes as fields, not only
 *  in the message, so a caller building a structured refusal does not parse them back out of an
 *  Error. */
class InputTooLargeError extends Error {
  constructor(public readonly actualBytes: number, public readonly allowedBytes: number) {
    super(`input is ${actualBytes} bytes, which is over the ${allowedBytes}-byte limit`);
    this.name = "InputTooLargeError";
  }
}

/** The size gate, in bytes rather than characters. Called from `buildRowVector` below, which is
 *  where every analyzed byte enters. */
function assertWithinInputLimit(bytes: number): void {
  if (bytes > MAX_INPUT_BYTES) throw new InputTooLargeError(bytes, MAX_INPUT_BYTES);
}

/** The refusal a write returns when `buildRowVector` threw `InputTooLargeError`, or null for any
 *  other error, which the caller rethrows. One sentence for every write path, so a document and a
 *  knowledge node over the limit are refused in the same words, naming the size and the limit. */
export function inputLimitRefusal(what: string, err: unknown): string | null {
  if (!(err instanceof InputTooLargeError)) return null;
  const mib = (n: number) => (n / 1024 / 1024).toFixed(1);
  return `ERROR: SIZE_LIMIT — ${what} is ${mib(err.actualBytes)} MiB, over the ${mib(err.allowedBytes)} MiB a ` +
    "stored body may be — nothing was written. Split it into documents that cite each other.";
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
   *  `body_tsv` is built from this and never from `terms` — this text, then its number-like
   *  hyphenated words with the hyphens read as spaces (`latinText`); the Han half comes from
   *  `terms` through `simple`, since those unigrams are what PostgreSQL's parser cannot produce.
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
 *  tags `B`, body `C` — and refuses a body past `MAX_INPUT_BYTES`.
 *
 *  COUPLED: both callers import this export rather than composing a vector of their own — the
 *  write path (`index.ts`, by way of `indexNode`) and the rederivation pass
 *  (`rederivation.ts`'s `rebuildRowVector`), which must agree or a rebuilt row stops matching the
 *  one the writer would store.
 *
 *  DELIBERATE: the limit is enforced here and only here. Every analyzed byte in the platform goes
 *  through this function — a document write (`document-save.ts`'s `saveDocument`), a journal node
 *  (`indexNode`), a team reindex and the rederivation pass — so one call is the whole write path,
 *  and it is the only bound on a stored body. It bounds the body alone, which is what an upload
 *  becomes: a title and tags beside a file that fits do not push it over. */
export function buildRowVector(input: {
  readonly title: string;
  readonly tags: readonly string[];
  readonly body: string;
}): RowVector {
  const tags = input.tags.join(" ");
  assertWithinInputLimit(Buffer.byteLength(input.body, "utf8"));
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

/** A hyphenated word: two or more letter-or-digit parts joined by single hyphens, a part keeping
 *  its inner dots so a version such as `0.96.0` stays whole. */
const HYPHENATED_WORD = /(?<![\p{L}\p{N}])[\p{L}\p{N}]+(?:\.[\p{L}\p{N}]+)*(?:-[\p{L}\p{N}]+(?:\.[\p{L}\p{N}]+)*)+/gu;

/** The text one weight's Latin half is parsed from: the field's own text, then each of its
 *  hyphenated words that has an ASCII digit in it, with the hyphens read as spaces.
 *
 *  PostgreSQL's parser reads `ticket-1234` as `ticket` plus the signed integer `-1234`, and the
 *  `3e5a91` of `run-3e5a91` as one part where alone it is a float plus a word, so a person typing
 *  `1234` or `3e5a91` asks for lexemes the field's own text never yields. The copy is parsed the
 *  way the query is, so it yields them.
 *
 *  DELIBERATE: the field's own text comes first and whole, so every compound the parser emits from
 *  it is still stored (see `RowVector.raw`). A field with no such word binds exactly that text, so
 *  its vector, and its rank for every query, is what it was before the copy existed — a word
 *  without a digit is parsed the same inside a compound as alone, and needs no copy. */
function latinText(raw: string): string {
  const parts = (raw.match(HYPHENATED_WORD) ?? [])
    .filter((word) => /[0-9]/.test(word))
    .map((word) => word.replace(/-/g, " "));
  return parts.length ? `${raw}\n${parts.join("\n")}` : raw;
}

/** The eight values `bodyTsvSql` binds, in its order. */
export function bodyTsvParams(vector: RowVector): string[] {
  return [
    TEXT_SEARCH_CONFIG.latin, TEXT_SEARCH_CONFIG.han,
    latinText(vector.raw.A), termsByWeight(vector, "A", "han"),
    latinText(vector.raw.B), termsByWeight(vector, "B", "han"),
    latinText(vector.raw.C), termsByWeight(vector, "C", "han"),
  ];
}
