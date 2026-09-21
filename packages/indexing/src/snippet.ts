/**
 * `snippetFor` — cut a snippet out of a document's ORIGINAL bytes, addressed by a byte range
 * that never lands mid-character.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE ANALYZER. `tenant-analysis.ts`'s `analyze` turns a body
 * into encoded search terms — `zh`+hex bigrams among them — so a search HIT is a match on
 * encoded text, not on anything a person should ever read back. A citation is the opposite
 * direction: given a byte range a hit points at, return what the document actually says
 * there, in its own words. Handing an encoded bigram back as a citation would show the reader
 * a token like `zh4e2d56fd` instead of their own text — this function's job is exactly to
 * never do that, by construction: it only ever slices `body`'s own UTF-8 bytes and never
 * touches the analyzer's output.
 *
 * BYTE OFFSETS, WIDENED OUTWARD, NEVER INWARD. A match's byte range can start or end in the
 * middle of a multi-byte UTF-8 sequence — a CJK character (3 bytes) or an emoji scalar (4
 * bytes, and a ZWJ emoji sequence like a family emoji is several scalars joined by U+200D, each
 * one still a complete multi-byte sequence in its own right). Slicing at such an offset
 * produces a truncated sequence that decodes as U+FFFD. So every offset is walked outward —
 * `start` moved down, `end` moved up — until it lands on a UTF-8 lead byte, using the
 * continuation-byte test (`10xxxxxx`, i.e. `(byte & 0xC0) === 0x80`) rather than building a
 * scalar array over the whole body: a document can be up to `MAX_INPUT_BYTES` (8 MiB), and a
 * snippet only ever touches the few bytes around its own range, so widening must cost O(range),
 * not O(document).
 *
 * THE RETURNED RANGE IS THE WIDENED ONE, NOT THE INPUT ONE. `text` is always exactly what
 * `Buffer.from(body, "utf8").subarray(range.start, range.end).toString("utf8")` reconstructs —
 * by construction, the same guarantee `passagesOf` makes for passages. A caller that stored the
 * original narrow range next to a widened `text` would have a citation that no longer
 * round-trips.
 *
 * `body` IS THE ONLY FIELD THIS FUNCTION KNOWS ABOUT — its own start (byte 0) and end (its
 * UTF-8 byte length) ARE the field boundary the contract requires a widen to stop at. Widening
 * clips there rather than throwing: a range whose boundary already sits at the very edge of
 * `body` is returned as the field-clipped snippet, never as a range that reaches past the
 * bytes that exist.
 */

export interface Snippet {
  readonly text: string;
  readonly range: { readonly start: number; readonly end: number };
}

/** A UTF-8 continuation byte: the 2nd/3rd/4th byte of a multi-byte sequence, `10xxxxxx`.
 *  A byte that fails this test is either ASCII or a sequence's own lead byte — either way, a
 *  valid place for a widened boundary to land. */
function isContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

/** Cut `body[range.start, range.end)` — UTF-8 byte offsets into `body` as written, e.g. a
 *  matched term's byte range — widened outward to the nearest UTF-8 character boundary on
 *  each side, and clipped to `body`'s own bytes at either end (its field boundary). Returns
 *  the widened range alongside the text it names, so the two always round-trip against
 *  `body`'s original bytes. */
export function snippetFor(body: string, range: { readonly start: number; readonly end: number }): Snippet {
  const bytes = Buffer.from(body, "utf8");
  const total = bytes.length;

  // Clip to the field boundary first — body's own byte range — before widening ever looks
  // at a byte outside it.
  let start = Math.max(0, Math.min(range.start, total));
  let end = Math.max(start, Math.min(range.end, total));

  // Widen outward (start down, end up) until each boundary lands on a lead byte. At most three
  // steps per side — the longest a UTF-8 sequence runs — so this is O(1) per call, not O(body).
  while (start > 0 && isContinuationByte(bytes[start])) start--;
  while (end < total && isContinuationByte(bytes[end])) end++;

  return { text: bytes.subarray(start, end).toString("utf8"), range: { start, end } };
}
