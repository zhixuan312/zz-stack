/**
 * The versioned text analyzer for the tenant-information corpus. `ANALYZER_NAME` below is the
 * answer to "which version is this build"; prose here is not, and goes stale silently.
 *
 * Three pure functions: string in, no filesystem path and no database row, so every property
 * is testable without a Postgres or a corpus on disk.
 *
 *   passagesOf            bounded overlapping passages over a body of any length, so a unique
 *                         term in the tail of a megabyte document is still retrievable.
 *   identifierTokens      an identifier keeps its exact unsplit spelling AND contributes
 *                         lowercased parts split at `.` `_` `/` `-` `:`, camelCase, acronym
 *                         and letter-digit boundaries.
 *   derivationFingerprint hash over record format, parser, analyzer, passage shape, projection
 *                         shape and the source content hash. Changing `analyzer` alone, source
 *                         bytes untouched, changes it — which is how a rebuild tells "this
 *                         row's derivation is stale" from "this row's source changed".
 *
 * COUPLED: `index.ts` writes `zz.doc` with a fixed 200,000-character cutoff and is the live
 * indexing path. Two corpora, two write paths; this file's passages feed the derived tables
 * migration 070 created. Do not unify the cutoffs.
 *
 * DELIBERATE: `identifierTokens` has no operator syntax. The query lexer reads quotes, OR and
 * exclusions before this analyzer sees the text, so a `/` or `-` inside a path cannot trip it.
 *
 * DELIBERATE: passage `start`/`end` are UTF-8 BYTE offsets — `Buffer.byteLength`, never
 * `.length` or `[...text].length`. The two agree only for pure ASCII; one CJK character (3
 * bytes) or one emoji (4) diverges them, and a character offset stored under a byte-offset name
 * corrupts every consumer that seeks into raw bytes, silently, because it is still a valid
 * integer. This corpus is 20% Chinese and 20% mixed.
 */
import { createHash } from "node:crypto";

// ── the analyzer's own version, and the size the kernel is contracted to refuse ─────────────

/** Named so an incompatible analyzer is a NEW name rather than a silent behaviour change under
 *  the old one. Callers pass it into `derivationFingerprint` as `analyzer`.
 *
 *  v1 -> v2: `analyze`'s Han unigram/bigram segmentation. v2 -> v3: `bodyTsvParams` builds the
 *  Latin half of `body_tsv` from the row's RAW text rather than this analyzer's split words
 *  (see `RowVector.raw`). `analyze` itself is unchanged and the name still moved, because the
 *  column records which derivation wrote a row's vector and a v2 vector is not interchangeable.
 *
 *  COUPLED: the rederivation walker rewrites a row only when
 *  `analyzer_version !== request.analyzer`. Bumping this name is what makes rows written under
 *  a broken construction repairable; leaving it and adding a `--force` is the transitional
 *  toggle this repository does not keep. */
export const ANALYZER_NAME = "zz-lexical-v3";
export const CURRENT_ANALYZER_VERSION = 3;

/** 8 MiB. New artifact text above this is refused by the kernel BEFORE commit — cheaply,
 *  before any passage or identifier work runs on bytes that were never going to be stored.
 *  Legacy content already larger than this, committed before the limit existed, is preserved
 *  and indexed under the migration exception (`imported: true` below), never truncated. */
export const MAX_INPUT_BYTES = 8 * 1024 * 1024;

/** Thrown by `assertWithinInputLimit`. Carries the actual and allowed sizes as fields, not
 *  only in the message, so a caller building a structured refusal (the shape every other
 *  refusal in `tenant-kernel-codes.ts`'s table takes) does not have to parse English back out
 *  of an Error to get the two numbers the contract requires it to report. */
export class InputTooLargeError extends Error {
  constructor(public readonly actualBytes: number, public readonly allowedBytes: number) {
    super(`input is ${actualBytes} bytes, which is over the ${allowedBytes}-byte limit`);
    this.name = "InputTooLargeError";
  }
}

/** The kernel's own size gate, factored out so it runs identically wherever a commit path
 *  calls it. `imported` is the ONE escape hatch the contract names: content already durable
 *  from before this limit existed is preserved and indexed as-is, never refused and never
 *  truncated to fit. Everything else — every new write — is measured in bytes, not characters,
 *  because `MAX_INPUT_BYTES` is a byte ceiling and a character count under-reports it for any
 *  non-ASCII text.
 *
 *  NOT YET CALLED FROM A COMMIT PATH. `services/zz-core/src/tenant-info/record.ts` is the
 *  kernel that would call this before it commits new artifact text, and it is outside this
 *  package — wiring it in is for whichever task owns that file's edit surface. This function
 *  exists so that wiring is a one-line call, not a second implementation of the limit. */
export function assertWithinInputLimit(bytes: number, opts: { readonly imported?: boolean } = {}): void {
  if (opts.imported) return;
  if (bytes > MAX_INPUT_BYTES) throw new InputTooLargeError(bytes, MAX_INPUT_BYTES);
}

// ── passages ─────────────────────────────────────────────────────────────────────────────

export interface Passage {
  /** UTF-8 byte offset, inclusive. */
  readonly start: number;
  /** UTF-8 byte offset, exclusive. */
  readonly end: number;
  readonly text: string;
}

/** A passage holds at most this many Unicode SCALAR VALUES — `[...text].length`, which counts
 *  an astral character (an emoji outside the BMP) as one, not the two UTF-16 code units
 *  `.length` would count it as. A scalar-value ceiling is what "at most 8192" can mean without
 *  quietly admitting a bigger passage for text with more astral characters in it. */
export const PASSAGE_MAX_SCALARS = 8192;

/** How far a passage backs up into the one before it, in scalar values, so a phrase that would
 *  otherwise fall across a passage boundary still lands whole inside at least one passage —
 *  any phrase shorter than this survives the split it would otherwise be cut by. */
export const PASSAGE_OVERLAP_SCALARS = 512;

/** How far back from a forced boundary this looks for a whitespace scalar to prefer, before
 *  giving up and forcing the split at the scalar ceiling itself. A run with no whitespace in
 *  this whole window — one very long uninterrupted token — is the "oversized uninterrupted
 *  run" the contract calls out: it gets a forced split at exactly `PASSAGE_MAX_SCALARS`,
 *  diagnosably (this comment is the diagnosis; the split point is deterministic and always the
 *  scalar ceiling, never a value that depends on what else is in the document). */
const BOUNDARY_SEARCH_WINDOW = 512;

const isWhitespaceScalar = (s: string): boolean => /\s/.test(s);

/** Bounded, overlapping, byte-offset passages over `body`, covering every byte with no
 *  truncation at any size — the property the prior fixed 200,000-character cutoff violated.
 *
 *  Works in three passes over the same per-scalar bookkeeping:
 *   1. split `body` into Unicode scalar values (`Array.from`, which is surrogate-pair aware —
 *      an astral emoji is one entry, never two lone surrogates);
 *   2. a running UTF-8 byte offset per scalar boundary, so a scalar index converts to a byte
 *      offset in O(1) and a passage's `start`/`end` always falls on a scalar boundary and
 *      therefore always falls on a valid UTF-8 byte boundary too — `text` is exactly what
 *      `buf.subarray(start, end).toString('utf8')` reconstructs, by construction rather than
 *      by rechecking it after the fact;
 *   3. walk scalar indices forward, each passage at most `PASSAGE_MAX_SCALARS` long, preferring
 *      to end on whitespace within `BOUNDARY_SEARCH_WINDOW` scalars of the ceiling, and start
 *      `PASSAGE_OVERLAP_SCALARS` scalars before the previous passage's end wherever a previous
 *      passage exists.
 *
 *  An empty body produces no passages — there is no content for one to cover. */
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

// ── identifier analysis ─────────────────────────────────────────────────────────────────────

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

/** `zz-lexical-v1`'s identifier analysis. Returns the identifier's own unsplit spelling —
 *  verbatim, exact case, exact punctuation, so a search for the literal identifier still
 *  matches it directly — PLUS every lowercased part `.`/`_`/`/`/`-`/`:`, camelCase, acronym
 *  and letter-digit splitting derives from it. Order does not matter to the caller: this
 *  returns a flat, deduplicated list rather than the two tiers as separate arrays, because
 *  every consumer named in the contract (a vocabulary, a set of terms a query can hit) wants
 *  membership, not provenance.
 *
 *  Called on text a query lexer has already recognised quotes/OR/leading-exclusion syntax in
 *  and stripped — this function has no operator syntax of its own, by design, so punctuation
 *  legitimately inside an identifier (a path's `/`, a version's `:`) is never mistaken for one. */
export function identifierTokens(raw: string): string[] {
  const tokens = new Set<string>();
  tokens.add(raw);
  for (const part of raw.split(DELIMITER_RUN)) {
    if (!part) continue;
    for (const sub of splitLatinBoundaries(part)) tokens.add(sub.toLowerCase());
  }
  return [...tokens];
}

// ── zz-lexical-v2: Han unigram and adjacent-bigram analysis ────────────────────────────────

/** Which kind of scalar run a base term came from. Not a query concept — `identifierTokens`
 *  and the boolean/phrase matcher in `pinned-read.ts` already work over raw field text and are
 *  untouched by this — this is carried on the term itself so a consumer of `analyze`'s output
 *  can tell a single Han character from a Latin word without re-classifying it. */
export type AnalysisField = "han" | "latin";

export interface AnalysisTerm {
  readonly term: string;
  readonly field: AnalysisField;
  /** Sequential index into the base sequence alone — ranking bigrams are a SEPARATE list and
   *  never consume a position, which is the property the Contract calls out by name: "inserted
   *  bigrams must never inflate positions". Boolean and phrase verification over the base
   *  sequence can therefore treat `position` as "how many base terms came before this one" with
   *  no bigram-shaped gaps to account for. */
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
/** A scalar that belongs to a Latin "word" run: any letter or number in any non-Han script,
 *  underscore included so `foo_bar` still reads as one run the way `identifierTokens` already
 *  treats a delimiter-free part. Stemming itself is NOT done here: `analyze` hands the backend
 *  raw, unstemmed word text, exactly as `identifierTokens` hands raw identifier text — the
 *  backend's own pinned `TEXT_SEARCH_CONFIG.latin` `to_tsvector` configuration is where
 *  stemming happens, once, so this analyzer does not grow a second stemmer that could disagree
 *  with it. That is a claim about where these terms are STORED, which is why `bodyTsvSql`
 *  below routes a `"latin"` term through that configuration and not through the `simple` one
 *  the Han half needs: a Latin word stored unstemmed cannot be found by the stemmed query the
 *  read path sends, and this comment was briefly untrue of the write path for exactly that
 *  reason. */
const LATIN_WORD_SCALAR = /[\p{L}\p{N}_]/u;

/** `zh` + each of two adjacent Han scalars as six lowercase zero-padded hex digits — exactly
 *  fourteen ASCII characters. `String.fromCodePoint`/`codePointAt` throughout this file (never
 *  `.charCodeAt`, never a UTF-16 code unit) so a supplementary-plane Han character encodes as
 *  one scalar's six hex digits, not two surrogates' worth. */
function encodeHanBigram(a: string, b: string): string {
  const hex = (scalar: string) => scalar.codePointAt(0)!.toString(16).padStart(6, "0");
  return `zh${hex(a)}${hex(b)}`;
}

/** `zz-lexical-v2`'s own analysis: Han unigrams, overlapping adjacent Han bigrams, and Latin
 *  words, over Unicode SCALAR VALUES (`Array.from`, surrogate-pair aware — never UTF-16 code
 *  units, so a supplementary-plane Han pair analyses to two base terms, not four) with every
 *  term's `start`/`end` mapped back to UTF-8 byte offsets into the original string, the same
 *  scalar-to-byte bookkeeping `passagesOf` above uses.
 *
 *  Each Han scalar is one base term AND, when the immediately preceding scalar was also Han
 *  (positionally adjacent in the source text, not merely in the same run), forms one ranking
 *  bigram with it — "adjacent" means the two scalars sit back to back with nothing between
 *  them, so `迁,移` inside `这个迁移会` produces `zh<迁><移>` but a Han character on either side
 *  of a Latin word never pairs across it. A run of Latin/digit/underscore scalars becomes one
 *  base term, keeping its exact original spelling (unstemmed, per this analyzer's own
 *  contract) rather than being split at internal boundaries the way `identifierTokens` splits
 *  a query-time identifier — those are two different consumers of two different token shapes.
 *  Whitespace and punctuation are boundaries only; they produce no term of their own. */
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

// ── row vectors: title/tags/body → weighted analyzer terms ─────────────────────────────────

/** The three fields `buildRowVector` weights a row by — title strongest, tags next, body
 *  widest. A private organizing type for this file and its callers' own bookkeeping only;
 *  `RowVectorTerm.weight` below is `string`, not this, on the PUBLIC shape — see that field's
 *  own comment for why. */
export type RowVectorWeight = "A" | "B" | "C";

export interface RowVectorTerm {
  readonly term: string;
  // `string`, not `RowVectorWeight`: a caller outside this file (the write-path-analysis gate
  // check among them) has no reason to know this is a closed set of three literals, and a
  // caller that groups terms by an arbitrary weight it read off a literal array — `["A", "B",
  // "C"]`, widened to `string[]` with no `as const` — must be able to compare it against this
  // field without narrowing it first.
  readonly weight: string;
  /** Which of the two text-search configurations in `TEXT_SEARCH_CONFIG` this term must be
   *  stored through. Carried per TERM and not per field, because one field's text produces
   *  both kinds: a Han unigram or ranking bigram (`"han"`) has to reach the index unaltered,
   *  and a Latin word (`"latin"`) has to reach it stemmed, because a stemmed query is what
   *  the read path sends. Splitting one field's terms by this is what keeps both true at
   *  once — see `bodyTsvSql` below. */
  readonly field: AnalysisField;
}

export interface RowVector {
  /** One entry per analyzer-emitted term, each carrying the weight of the field it came
   *  from — not grouped by weight; `termsByWeight` below does that for a caller that wants
   *  `to_tsvector('simple', …)`'s three space-joined strings. */
  readonly terms: readonly RowVectorTerm[];
  /** The RAW text of each weighted field, exactly as the row holds it. The Latin half of
   *  `body_tsv` is built from this and NEVER from `terms`.
   *
   *  DELIBERATE: the Latin half must be tokenized by the same engine as the query, which is
   *  PostgreSQL's parser over unsplit text. Pre-splitting destroys every compound the parser
   *  would emit — `sdlc-deck` becomes `sdlc` + `deck`, and the adjacency
   *  `websearch_to_tsquery` asks for is gone — so the match is false while the vector looks
   *  full and the row looks indexed.
   *
   *  Measured on a copy of this deployment: 1002 of 1010 rows written before this analyzer
   *  retrieved themselves by their own title, 0 of the 23 written by it did, and rederiving
   *  under the pre-split construction took self-retrieval 1002 -> 255. This corpus is made of
   *  `sdlc-flow`, `zz-core`, `plan-audit` and dated filenames.
   *
   *  DELIBERATE: it lives on the vector rather than in a second argument to `bodyTsvParams`,
   *  so no call site can build the two halves of one row from different text.
   *
   *  The Han half still comes from `terms` through `simple`: those unigrams are exactly what
   *  PostgreSQL's parser cannot produce. */
  readonly raw: Readonly<Record<RowVectorWeight, string>>;
  readonly analyzer: string;
}

/** One field's analyzer-emitted terms, tagged with the weight the FIELD owns — not the kind
 *  of term. A Han unigram, a Latin word and a Han ranking bigram from `analyze` all carry the
 *  same weight when they came from the same field, exactly as a plain word did under the old
 *  `setweight(to_tsvector(english_config, field), weight)`. */
function fieldTerms(text: string, weight: RowVectorWeight): RowVectorTerm[] {
  const { base, ranking } = analyze(text);
  return [
    ...base.map((t) => ({ term: t.term, weight, field: t.field })),
    // A ranking bigram is derived from a Han pair and is just as opaque as the unigrams it
    // pairs, so it travels the Han half: `zh008fc10079fb` must be stored exactly, never stemmed.
    ...ranking.map((term) => ({ term, weight, field: "han" as const })),
  ];
}

/** The `body_tsv` a row gets, built from the `zz-lexical-v2` analyzer — Task I-38. Before this
 *  task the write path built the vector in SQL, straight off the raw prose, with the english
 *  text-search configuration: it tokenizes on whitespace and punctuation, so an unspaced Han
 *  run went in as one opaque word and out as nothing a query could ever hit. `analyze` already
 *  segments that text into individually retrievable terms (Task I-8 proved they survive
 *  `to_tsvector('simple', …)` — no stemming, no dictionary, no re-parsing — byte-identical);
 *  this function is what turns title/tags/body into the flat, weighted term list a caller then
 *  groups by weight and hands to `to_tsvector('simple', …)` in its place.
 *
 *  Weighting is exactly what this package has always written and nothing new: title `A`, tags
 *  `B`, body `C`. LIVES HERE, not in `index.ts` where Task I-38 first wrote it, because Task
 *  I-13's rederivation pass (`tenant-rebuild.ts`'s `rebuildRowVector`) needs the identical
 *  function too, and `index.ts` is this package's re-export DOOR — a write-path-only file, per
 *  its own header — not where a function two independent callers share belongs. Shared by
 *  construction rather than by convention: the write path (`indexDoc`, `index.ts`) and the
 *  rederivation pass both import THIS export, so "two indexers that agree until the day one of
 *  them is edited" (this package's own stated failure mode) cannot happen here. */
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

/** One weight's terms for ONE configuration, space-joined — the shape each `to_tsvector` call
 *  in `bodyTsvSql` below takes. A grouping step over `buildRowVector`'s own output, not a
 *  second weighting rule: the weighting already happened, above, inside `buildRowVector`
 *  itself, and the `field` split is the analyzer's own, decided per scalar run in `analyze`. */
export function termsByWeight(vector: RowVector, weight: RowVectorWeight, field: AnalysisField): string {
  return vector.terms
    .filter((t) => t.weight === weight && t.field === field)
    .map((t) => t.term)
    .join(" ");
}

// ── the one place a text-search configuration name is written ───────────────────────────────

/** The two PostgreSQL text-search configurations one row's `body_tsv` is built from, and the
 *  ONLY place either name appears in this repository — the write path (`index.ts`), the
 *  rederivation pass (`rederivation.ts`) and the read path
 *  (`services/zz-core/src/tools/knowledge-search.ts`) all read it from here.
 *
 *  WHY TWO, AND WHY THIS IS NOT A PREFERENCE. Task I-38's first form stored the whole vector
 *  through `simple`, because the analyzer's Han unigrams and ranking bigrams must not be
 *  re-parsed or stemmed by the backend — `simple` is what Task I-8's fixture proves leaves an
 *  analyzer term byte-identical. But the read path queries the SAME column with
 *  `websearch_to_tsquery(latin, …)`, which stems: `english` turns a query for `migrating` —
 *  and for the bare word `migration` itself — into the lexeme `migrat`, which does not match a
 *  `simple`-built vector holding the literal `migration`. Measured on the pinned cluster:
 *  `to_tsvector('simple','This migration replaces the old schema') @@
 *  websearch_to_tsquery('english','migration')` is FALSE where the pre-change,
 *  `english`-built vector was true. Every English word whose stem differs from its surface
 *  form stops matching — silently, with no error and nothing to see in the row.
 *
 *  So the two halves of one row go through the two configurations that suit them: Latin words
 *  through the same configuration the query side uses, so stemming happens once on both sides
 *  and agrees; Han unigrams and bigrams through `simple`, so nothing rewrites them. They are
 *  concatenated into one `body_tsv`, one `setweight` per half per weight. */
export const TEXT_SEARCH_CONFIG: Readonly<Record<AnalysisField, string>> = {
  latin: "english",
  han: "simple",
};

/** The `body_tsv` expression itself, parameterised — the single construction every writer of
 *  this column uses, so a configuration cannot drift between the live write path and the
 *  rederivation pass the way it drifted between write and read.
 *
 *  Consumes EIGHT bind parameters starting at `first`, in the order `bodyTsvParams` returns
 *  them: two `regconfig` names, then six space-joined term strings (A/B/C x latin/han). The
 *  caller places them at `first`..`first + 7` and numbers its own remaining parameters after
 *  that. Passing the configuration as a bind parameter rather than interpolating its name is
 *  what keeps this function's output free of any SQL text derived from a string. */
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

// ── derivation fingerprint ───────────────────────────────────────────────────────────────────

/** Every version that decided the shape of one derived row, plus the hash of the source bytes
 *  those derivations ran over. `content_hash` changing means the SOURCE changed; any other
 *  field changing means a DERIVATION changed while the source did not — a passage shape
 *  rework, say, or `analyzer` moving from `zz-lexical-v1` to a `v2` that splits differently.
 *  Both are real reasons to rebuild a row, and a rebuild that can only see "did the content
 *  hash change" cannot tell the second one happened at all. */
export interface DerivationVersions {
  readonly content_hash: string;
  readonly record_format: number;
  readonly parser: number;
  readonly analyzer: number;
  readonly passage: number;
  readonly projection: number;
}

/** A stable hash over exactly the fields above, in one fixed field order — an explicit object
 *  literal rather than a generic key-sort, matching `tenant-projections.ts`'s
 *  `semanticProjectionHash`, whose header explains the same choice: fixing the shape by
 *  TYPE means there is no field this could accidentally hash that the type does not name, the
 *  way a rebuild's wall-clock duration cannot leak into `semanticProjectionHash` because its
 *  input type has no field for one. Consumed by a rebuild/projection cache to decide staleness
 *  independently of whether the source bytes changed. */
export function derivationFingerprint(v: DerivationVersions): string {
  return createHash("sha256").update(JSON.stringify({
    content_hash: v.content_hash, record_format: v.record_format, parser: v.parser,
    analyzer: v.analyzer, passage: v.passage, projection: v.projection,
  })).digest("hex");
}

// ── analyzer opacity: the fixed case list a live PostgreSQL proves this analyzer's terms
//    survive text analysis unaltered ─────────────────────────────────────────────────────────

/** Four raw seed strings, one per shape Task I-8's Contract names: Han, Latin, mixed (Han and
 *  Latin interleaved in one string, so a bigram never pairs across a Latin run) and identifier
 *  (camelCase/acronym/delimiter/digit boundaries, exercising `identifierTokens`). Deliberately
 *  lowercase in the Han/Latin/mixed seeds: a case-preserving base term run head-on into a
 *  case-FOLDING text-search dictionary (`simple`, in `analyzer-opacity-run.ts`) would report a
 *  "mangled" term for a reason that has nothing to do with opacity — this fixture isolates the
 *  property the AC states (does the database's tokenizer split/stem/drop these terms) from
 *  that orthogonal, already-understood behavior. The identifier seed keeps mixed case and a
 *  `_`/`-`/`.` mix ON PURPOSE, because `emittedTermsFor` below never submits it verbatim — only
 *  `identifierTokens`'s own already-lowercased, already-delimiter-free derived parts. */
const OPACITY_SEED_TEXT = {
  han: "这是一段测试用的中文文本",
  latin: "schema migration reader",
  mixed: "这次 migration 会 rebuild 索引 schema",
  identifier: "httpServer2_config-reader.v2",
} as const;

/** The seeds above, in one fixed, ordered list — what the Contract calls "a fixed case list
 *  covering Han, Latin, mixed and identifier shapes." Exported so `analyzer-opacity-run.ts`
 *  and anything auditing this fixture can see exactly what was fed to the analyzer, separately
 *  from the terms that analysis produced. */
export const OPACITY_SEEDS: readonly string[] = Object.values(OPACITY_SEED_TEXT);

/** Every term ONE seed contributes to `OPACITY_CASES`.
 *
 *  The Han/Latin/mixed seeds run through `analyze` alone: its base terms and ranking bigrams
 *  are already atomic (no internal delimiter, and — because the seed text above is plain
 *  lowercase prose — no case variation this fixture does not control either), which is exactly
 *  what makes them a fair test of the database's tokenizer rather than of this fixture's own
 *  seed choices.
 *
 *  The identifier seed runs through `identifierTokens` instead, and ONLY ITS DERIVED LOWERCASE
 *  PARTS are kept — never `identifierTokens`'s own verbatim compound spelling
 *  (`tokens.add(raw)` in `identifierTokens` itself). Two independent reasons, not one: that
 *  verbatim spelling is looked up through a different, exact-string path
 *  (`zz.artifact_identifier.identifier_text`/`normalized_text`, migration 070's GiST trigram
 *  lane), never through `to_tsvector`, so testing it here would test the wrong mechanism; and
 *  submitting a real PostgreSQL `simple` tokenizer a compound string that still carries `_`/`-`
 *  would test PostgreSQL's OWN delimiter handling of ordinary punctuation, not this analyzer's
 *  opacity claim — measured directly, the stock tokenizer splits `httpServer2_config` at the
 *  underscore on its own, independent of anything this analyzer does. The derived parts
 *  (`http`, `server2`, `config`, `reader`, `v2`) are each already split at every
 *  delimiter/camelCase/acronym/letter-digit boundary `identifierTokens` knows, so — like the
 *  other three seeds' terms — none carries an internal delimiter or mixed case of its own. */
function emittedTermsFor(seed: string): string[] {
  if (seed === OPACITY_SEED_TEXT.identifier) {
    return identifierTokens(seed).filter((token) => token !== seed);
  }
  const { base, ranking } = analyze(seed);
  return [...base.map((t) => t.term), ...ranking];
}

/** Every term the CURRENT analyzer emits for `OPACITY_SEEDS`, flattened across all four seeds
 *  and de-duplicated in first-seen order.
 *
 *  WHAT THIS FIXTURE PROVES, AND WHAT IT DOES NOT. Every case here is submitted to a live
 *  pinned PostgreSQL through `to_tsvector('simple', …)` — the configuration
 *  `TEXT_SEARCH_CONFIG.han` pins — and is required to come back byte-identical. That is the
 *  opacity property the Han half of every row depends on: a unigram or a `zh…` ranking bigram
 *  must not be split, stemmed or dropped on its way into the index. It is NOT a claim about
 *  the Latin half. A `"latin"` term is deliberately stored through `TEXT_SEARCH_CONFIG.latin`,
 *  where `migration` becomes `migrat` and `the` disappears entirely, because the read path
 *  stems its query the same way; byte-identity there would be a defect, not a guarantee. The
 *  Latin and identifier seeds stay in this list as controls on the tokenizer's SPLITTING
 *  behaviour, which is configuration-independent, and not as evidence about stemming. This is the actual case list `analyzer-opacity-run.ts`
 *  submits to a live pinned PostgreSQL, one term at a time, and it is what the gate's frozen
 *  check (`scripts/gate/checks/analyzer-opacity-fixture.ts`) re-derives to catch staleness:
 *  because it is computed by CALLING `analyze`/`identifierTokens` rather than typed out by
 *  hand, any change to what the analyzer emits for `OPACITY_SEEDS` — including a change that
 *  adds, removes or reorders a term — changes this list, and therefore changes
 *  `analyzerDigestFor`'s result, with no second copy of the analyzer's output to keep in sync
 *  by hand. */
export const OPACITY_CASES: readonly string[] = [...new Set(OPACITY_SEEDS.flatMap(emittedTermsFor))];

/** A stable SHA-256 over the exact ordered term list `cases`, as JSON. Order-sensitive and
 *  content-sensitive: recomputing it against the CURRENT analyzer's `OPACITY_CASES` and
 *  comparing to a fixture's recorded `provenance.analyzer_digest` is how the gate check tells a
 *  fixture generated before an analyzer change apart from one generated after — the property
 *  Task I-8's Contract calls "the fixture matches the analyzer as it is today." */
export function analyzerDigestFor(cases: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(cases)).digest("hex");
}
