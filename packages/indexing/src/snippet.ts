/**
 * `snippetFor` — cut a snippet out of a document's original bytes, addressed by a byte range
 * that never lands mid-character.
 *
 * DELIBERATE: this only ever slices `body`'s own UTF-8 bytes and never touches the analyzer's
 * output. `tenant-analysis.ts`'s `analyze` encodes a body into search terms, `zh`+hex bigrams
 * among them, so returning one as a citation would show a reader `zh4e2d56fd` instead of their
 * own text.
 *
 * Byte offsets are widened outward, never inward. A match's byte range can start or end in the
 * middle of a multi-byte UTF-8 sequence, and slicing there produces a truncated sequence that
 * decodes as U+FFFD. Each offset walks outward until it lands on a lead byte, using the
 * continuation-byte test rather than building a scalar array over the whole body: a document
 * can be up to `MAX_INPUT_BYTES`, so widening costs O(range), not O(document).
 *
 * The returned range is the widened one. `text` is always exactly what
 * `Buffer.from(body, "utf8").subarray(range.start, range.end).toString("utf8")` reconstructs,
 * the same guarantee `passagesOf` makes for passages; storing the original narrow range beside
 * a widened `text` would give a citation that no longer round-trips.
 *
 * `body`'s own start and end are the field boundary. Widening clips there rather than
 * throwing, so a range already at the edge comes back field-clipped.
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
  // steps per side, the longest a UTF-8 sequence runs, so this is O(1) per call.
  while (start > 0 && isContinuationByte(bytes[start])) start--;
  while (end < total && isContinuationByte(bytes[end])) end++;

  return { text: bytes.subarray(start, end).toString("utf8"), range: { start, end } };
}
