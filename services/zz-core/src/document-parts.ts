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
 *
 * A section is also what `document_edit` replaces and what its receipt names as changed, so the
 * one reading of "a section" — and of which heading a selector picks — lives here for both.
 */
import { parseEnvelope } from "@zz/contracts";


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

/** Headings as a counted list — `headings (<total>): <preview>` — at most 40 shown, and a cut
 *  list ends in `…`, so a reader is never shown part of the list as the whole of it. */
const listed = (hs: Heading[]): string =>
  `headings (${hs.length}): ` + (hs.length ? hs.slice(0, 40).map((h) => `${"#".repeat(h.level)} ${h.title} (offset ${h.at})`).join("; ") +
  (hs.length > 40 ? "; …" : "") : "none");

/** Which of several same-named headings a caller means: its level (1–4), then its 1-based
 *  occurrence among the headings that are left. Both optional; neither narrows nothing. */
type SectionPick = { level?: number; occurrence?: number };

/** A heading a selector could have meant, with the selectors that pick it alone: its level, and
 *  its occurrence among the headings of that text AND that level. */
type Candidate = { title: string; level: number; occurrence: number; line: number };

/** Where a section is, or why there is none: no heading matches (`all` lists every heading), or
 *  more than one still does after the selectors (`candidates`). */
type Located =
  | { lo: number; hi: number }
  | { missing: true; all: Heading[] }
  | { ambiguous: Candidate[]; hits: Heading[] };

/** The section a heading text and the optional selectors name. Text is matched without its `#`s
 *  and case-insensitively; a heading inside a code fence is not one. */
export function locateSection(text: string, section: string, pick: SectionPick = {}): Located {
  const want = section.replace(/^#+\s*/, "").trim().toLowerCase();
  const all = headings(text);
  const named = all.filter((h) => h.title.toLowerCase() === want);
  const levelled = pick.level === undefined ? named : named.filter((h) => h.level === pick.level);
  const hits = pick.occurrence === undefined
    ? levelled
    : levelled.slice(pick.occurrence - 1, pick.occurrence);
  if (!hits.length || (pick.occurrence !== undefined && pick.occurrence < 1)) return { missing: true, all };
  if (hits.length > 1) {
    return { hits, ambiguous: hits.map((h) => ({
      title: h.title, level: h.level,
      occurrence: named.filter((n) => n.level === h.level && n.at <= h.at).length,
      line: text.slice(0, h.at).split("\n").length,
    })) };
  }
  const h = hits[0];
  return { lo: h.at, hi: all.find((n) => n.at > h.at && n.level <= h.level)?.at ?? text.length };
}

/** Where one heading's section is: from the heading line to the next heading of the same or a
 *  higher level, or the end. The one reading of "a section" — `slicePart` reads by it and
 *  `replaceSection` writes by it, so what a caller read is exactly what a change replaces.
 *
 *  The refusals are the READ path's: a reader pages by `offset`, so an ambiguous heading sends
 *  it there. `document_edit` words its own from `locateSection`. */
export function sectionRange(text: string, section: string, pick: SectionPick = {}):
    { lo: number; hi: number } | string {
  const found = locateSection(text, section, pick);
  if ("missing" in found) {
    return `ERROR: no heading "${section}" in this document. Its ${listed(found.all)}.`;
  }
  if ("ambiguous" in found) {
    return `ERROR: ${found.hits.length} headings read "${section}" — ${listed(found.hits)}. Ask for one ` +
           "by `offset` instead.";
  }
  return found;
}

/** `body` with one section replaced by `content`, which carries the section's heading line — or a
 *  refusal. Everything outside the section is kept byte for byte, which is the point: a large
 *  approved document is changed by sending the part that changed, not the whole of it (bug
 *  87fce795). The replacement is followed by one blank line when anything comes after it. */
export function replaceSection(body: string, section: string, content: string, pick: SectionPick = {}):
    { body: string } | { refusal: string } {
  const range = sectionRange(body, section, pick);
  if (typeof range === "string") return { refusal: range };
  if (!/^#{1,6}\s/.test(content.trimStart())) {
    return { refusal: "ERROR: with `section`, `content` replaces the heading and everything under " +
             "it — start it with that heading line, as `document_read` with the same `section` returns it." };
  }
  const tail = body.slice(range.hi);
  // The body's own line ending, so a section edit never leaves a CRLF document with LF joins.
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  return { body: body.slice(0, range.lo) + content.trimStart().replace(/\s*$/, "") +
                 (tail ? eol + eol : eol) + tail };
}

/** What a change did to a body, section by section, for its receipt: every section whose bytes
 *  differ or that is new, in the order the new body has them, then `(removed: <heading>)` for each
 *  one that is gone. Text before the first heading is `(preamble)`. A section here runs to the next
 *  heading of ANY level, so a changed subsection names itself and not its parent too; a repeated
 *  heading is told apart by its occurrence, `Notes (2)`. */
export function changedSections(before: string, after: string): string[] {
  const split = (text: string): Map<string, string> => {
    const hs = headings(text);
    const out = new Map<string, string>([["(preamble)", text.slice(0, hs[0]?.at ?? text.length)]]);
    const seen = new Map<string, number>();
    hs.forEach((h, i) => {
      const n = (seen.get(h.title) ?? 0) + 1;
      seen.set(h.title, n);
      out.set(n > 1 ? `${h.title} (${n})` : h.title, text.slice(h.at, hs[i + 1]?.at ?? text.length));
    });
    return out;
  };
  const was = split(before);
  const now = split(after);
  return [...[...now].filter(([k, v]) => was.get(k) !== v).map(([k]) => k),
          ...[...was.keys()].filter((k) => !now.has(k)).map((k) => `(removed: ${k})`)];
}

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
    const range = sectionRange(text, ask.section);
    if (typeof range === "string") return range;
    ({ lo, hi } = range);
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
  // The token a change sends as `base`, so a reader of one part can change the document without
  // reading it whole. Read off the envelope the text carries, which states it on the current
  // snapshot alone: a body with no envelope, or an older version, states none.
  const current = parseEnvelope(text).content_revision;
  if (current) lines.push(`content revision: ${current} (the document as it is now)`);
  /* A hosted client keeps the tool list it read when the connector was added: ChatGPT's copy from
   * before 0.79.3 had no `offset`, and a model holding it re-asked for part one until it filed a
   * bug. The fix is on the person's side, so the line says what it is. */
  if (part.end < part.total) {
    lines.push(`Next: offset ${part.end}. If this tool shows you no \`offset\` argument, your ` +
               "client holds an old copy of the tool list — ask the person to refresh or reconnect " +
               "this connector, then continue.");
  }
  if (!whole) {
    const hs = headings(text);
    if (hs.length) lines.push(`Sections — ${listed(hs)}.`);
  }
  return lines.join("\n");
}
