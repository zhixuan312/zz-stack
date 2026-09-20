/**
 * The versioned text analyzer for the tenant-information corpus: `zz-lexical-v1`.
 *
 * Three pure functions, all byte-offset-safe and language-agnostic in the same way: they take
 * a string and never a filesystem path or a database row, so every property below is testable
 * without a Postgres and without a corpus on disk.
 *
 *   passagesOf           bounded overlapping passages over a body of any length, so a unique
 *                         term in the tail of a megabyte-sized document is still retrievable —
 *                         the prior indexer's fixed 200,000-character cutoff (`index.ts`'s
 *                         `documentBody(content).slice(0, 200_000)`) does not apply here and
 *                         is not touched by this file. Two different corpora, two different
 *                         write paths: `index.ts` still writes `zz.doc` today, unchanged, and
 *                         is the LIVE indexing path this repository runs in production.
 *                         Passages are a projection input for the derived tables migration 070
 *                         created (`tenant-projections.ts`'s header names exactly this gap),
 *                         wired in by whichever task populates `zz.artifact_passage`.
 *
 *   identifierTokens     `zz-lexical-v1`'s identifier analysis: an identifier keeps its exact,
 *                         unsplit spelling in the vocabulary AND contributes lowercased derived
 *                         parts split at `.`, `_`, `/`, `-`, `:`, camelCase and acronym
 *                         boundaries, and letter-digit boundaries. Operates on text a QUERY
 *                         LEXER has already read for quotes/OR/exclusions — that recognition
 *                         happens in the query path, before this analyzer ever sees the text,
 *                         which is why this function has no operator syntax of its own to trip
 *                         over a `/` or a `-` inside a path.
 *
 *   derivationFingerprint a hash over the exact set of versions that produced a derived row —
 *                         record format, parser, analyzer, passage shape, projection shape —
 *                         plus the source content hash. Changing ANY one of those, including
 *                         `analyzer` alone with the source bytes untouched, changes the
 *                         fingerprint, which is what lets a rebuild decide "this row's
 *                         derivation is stale" independently of "this row's source changed".
 *
 * BYTE OFFSETS, NOT CHARACTER OFFSETS. `start`/`end` on a passage are UTF-8 byte positions —
 * `Buffer.byteLength`, not `.length` and not `[...text].length`. A character offset and a byte
 * offset agree only for pure ASCII; the moment a passage's prefix holds one CJK character (3
 * bytes) or one emoji (4 bytes), the two numbers diverge, and code that stores a character
 * offset under a name that promises a byte offset corrupts every downstream consumer that
 * seeks into the raw bytes with it — silently, because the number is still a valid integer.
 * This corpus is reported at 20% Chinese and 20% mixed, which is exactly where that mistake
 * stops being a rounding error and starts being wrong on every affected document.
 */
import { createHash } from "node:crypto";

// ── the analyzer's own version, and the size the kernel is contracted to refuse ─────────────

/** `zz-lexical-v1` — named so a later incompatible analyzer is `zz-lexical-v2` rather than a
 *  silent behavior change under the same name. Passed by callers into `derivationFingerprint`
 *  as the `analyzer` field; kept here, once, so "which version is this build" has one answer. */
export const ANALYZER_NAME = "zz-lexical-v1";
export const CURRENT_ANALYZER_VERSION = 1;

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
