/**
 * A document too long for one tool result, read in parts.
 *
 * A client caps what one tool result may carry — a 130k-character review.md could not be read at
 * all — so `document_read` and `document_present` take a part: a `section` by heading, and/or an
 * `offset` and `limit` in characters. Every part says the total size and which characters it is,
 * so a reader always knows what it has not seen.
 *
 * What is here is the SLICING: which characters of a body a caller asked for, and the line that
 * says what the part is. Nothing here reads a store — a part is cut from bytes the caller
 * already holds, and the bytes come from `doc_revision` through `versions.ts`.
 */

/** The size above which a present comes back in parts unasked. Characters, not tokens: a client's
 *  cap is in tokens, and 60k characters stays under the common 25k-token result cap even for
 *  markdown dense with tables and code. */
export const PART_LIMIT = 60_000;

/** What a caller asked a present for: a heading, an offset, a cap, or none of them. */
export type PartAsk = { section?: string; offset?: number; limit?: number };
type Part = { text: string; start: number; end: number; total: number };
type Heading = { level: number; title: string; at: number };

/** Did the caller ask for a part at all? */
export const asksPart = (ask: PartAsk): boolean =>
  ask.section !== undefined || ask.offset !== undefined || ask.limit !== undefined;

/** Every markdown heading with the character it starts at. Lines inside ``` or ~~~ fences are
 *  code, not headings — a plan quoting a shell comment would otherwise grow a section. */
function headings(text: string): Heading[] {
  const out: Heading[] = [];
  let fence: string | null = null;
  let at = 0;
  for (const line of text.split("\n")) {
    const f = /^\s*(```|~~~)/.exec(line);
    if (f) fence = fence === null ? f[1] : fence === f[1] ? null : fence;
    else if (fence === null) {
      const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (h) out.push({ level: h[1].length, title: h[2].trim(), at });
    }
    at += line.length + 1;
  }
  return out;
}

const listed = (hs: Heading[]): string =>
  hs.slice(0, 40).map((h) => `${"#".repeat(h.level)} ${h.title} (offset ${h.at})`).join("; ") +
  (hs.length > 40 ? `; … ${hs.length - 40} more` : "");

/** The part of `text` a caller asked for, or a refusal saying why there is none.
 *
 * `section` narrows to one heading and everything under it, up to the next heading of the same
 * or a higher level. `offset` is absolute — the number a previous part's "next" line gave — and
 * `limit` caps the length, PART_LIMIT when unset. A cut that is not the end of the range backs up
 * to the last line break in its second half, and never splits a surrogate pair. */
export function slicePart(text: string, ask: PartAsk): Part | string {
  const total = text.length;
  let lo = 0, hi = total;
  if (ask.section !== undefined) {
    const want = ask.section.replace(/^#+\s*/, "").trim().toLowerCase();
    const all = headings(text);
    const hits = all.filter((h) => h.title.toLowerCase() === want);
    if (!hits.length) {
      return `ERROR: no heading "${ask.section}" in this document. Its headings: ` +
             (all.length ? listed(all) : "none") + ".";
    }
    if (hits.length > 1) {
      return `ERROR: ${hits.length} headings read "${ask.section}": ${listed(hits)}. Ask for one ` +
             "by `offset` instead.";
    }
    const h = hits[0];
    lo = h.at;
    hi = all.find((n) => n.at > h.at && n.level <= h.level)?.at ?? total;
  }
  const limit = ask.limit ?? PART_LIMIT;
  if (limit <= 0) return "ERROR: `limit` must be a positive number of characters.";
  let start = ask.offset ?? lo;
  if (start < lo || start > hi || (start === hi && hi > lo)) {
    return `ERROR: offset ${start} is outside ${ask.section ? `section "${ask.section}", characters ` : "the document, characters "}` +
           `${lo}–${hi} of ${total}.`;
  }
  if (/[\uDC00-\uDFFF]/.test(text[start] ?? "")) start += 1;
  let end = Math.min(hi, start + limit);
  if (end < hi) {
    const nl = text.lastIndexOf("\n", end - 1);
    if (nl >= start + limit / 2) end = nl + 1;
    if (/[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end -= 1;
  }
  if (end <= start && start < hi) return `ERROR: a limit of ${limit} cannot hold the character at offset ${start}.`;
  return { text: text.slice(start, end), start, end, total };
}

/** The line that says what a part is and how to get the rest. `of` names what the offsets count
 *  over, because a read counts the whole file and a present counts only the body. */
export function partHeader(rel: string, part: Part, of: string, text: string): string {
  const whole = part.start === 0 && part.end === part.total;
  const lines = [`Part of ${rel}: characters ${part.start}–${part.end} of ${part.total} ` +
                 `(${of}; offsets count UTF-16 characters)${whole ? " — the whole of it" : ""}.`];
  if (part.end < part.total) lines.push(`Next: offset ${part.end}.`);
  if (!whole) {
    const hs = headings(text);
    if (hs.length) lines.push(`Sections: ${listed(hs)}.`);
  }
  return lines.join("\n");
}
