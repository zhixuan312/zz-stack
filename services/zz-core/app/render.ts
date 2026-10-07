/**
 * A document's markdown, as the panel renders it: pure, no DOM, so a check can run it in Node.
 *
 * micromark with GFM, the parser underneath the console's react-markdown and remark-gfm, so a
 * document reads the same in both places. Its defaults are the safety policy: raw HTML is escaped,
 * not rendered, and a link to a scheme it does not trust (`javascript:`, `data:`) loses its href.
 *
 * Two rules on top, both the console's (`safe-markdown.ts`):
 *   - an image is a fetch the reader never agreed to, so none is fetched — a picture's alt text
 *     stands in its place, which says what the author meant rather than showing a broken icon;
 *   - a heading gets an id, so the outline can take a reader to it.
 */
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";

import type { Change } from "./state.ts";

/** A heading the outline lists. `words` is how much the section under it holds, up to the next
 *  heading of any level the outline lists — what a reader weighs before deciding to go there. */
interface OutlineEntry { level: 2 | 3; text: string; id: string; words: number }

export interface Rendered {
  /** The body as HTML, safe to assign to `innerHTML`. */
  html: string;
  /** The document's own first-level heading, which the panel shows as its title. */
  title: string | null;
  outline: OutlineEntry[];
  /** Words in the whole body — the reading time is `minutesOf(words)`. */
  words: number;
  /** Each second-level section's heading and plain text, in order. */
  sections: { id: string; title: string; text: string }[];
  /** Every heading the change set counts, in its order — the heading markdown renders on that line,
   *  or null where it renders none: what a change record's position names. */
  heads: ({ level: number; id: string } | null)[];
}

/** Reading time at 220 words a minute, never under one. */
export const minutesOf = (words: number): number => Math.max(1, Math.round(words / 220));

const ENTITY: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#x27;": "'" };
/** The text of an HTML fragment micromark wrote: its tags dropped, its entities decoded. */
const plain = (fragment: string): string =>
  fragment.replace(/<[^>]*>/g, "").replace(/&(amp|lt|gt|quot|#x27);/g, (e) => ENTITY[e] ?? e).trim();

/** A heading's id: lowercase words joined by `-`, unique within the document. */
function slugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text) => {
    const base = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "section";
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
}

/** The lines, from 1, of the headings a change record counts: a `#` heading at the start of a line,
 *  outside a fence. COUPLED: `headings` in src/document-parts.ts, the scan `deltaOf` numbers its
 *  positions by — markdown also renders a heading quoted, listed, indented or underlined, which that
 *  scan does not count, so the panel numbers by the same scan rather than by what it renders. */
function countedLines(text: string): number[] {
  const out: number[] = [];
  let fence: string | null = null;
  text.split("\n").forEach((line, i) => {
    const f = /^\s*(```|~~~)/.exec(line);
    if (f) fence = fence === null ? f[1]! : fence === f[1] ? null : fence;
    else if (fence === null && /^(#{1,6})\s+(.+?)\s*#*\s*$/.test(line)) out.push(i + 1);
  });
  return out;
}

/** Each heading's source line, written as a comment — the post-pass reads it and strips it. An ATX
 *  heading's goes just before its `<hN>`, written when the heading starts, which a heading with no
 *  text (`## ##`) has too; a setext heading's goes where its text starts, since micromark writes its
 *  `<hN>` only once the underline gives its level. DELIBERATE: carried by the heading itself, not
 *  paired by order: GFM moves footnote definitions, and any heading inside one, to the end of the
 *  page. Nothing else writes `<!--`: raw HTML in a document is escaped. */
const LINE = /<!--line:(\d+)-->/;
function markLine(this: { raw(s: string): void }, token: { start: { line: number } }): undefined {
  this.raw(`<!--line:${token.start.line}-->`);
  return undefined;
}
const lineMarks = { enter: { atxHeading: markLine, setextHeadingText: markLine } };

export function renderMarkdown(body: string): Rendered {
  const src = body.replace(/\r\n/g, "\n");
  const raw = micromark(src, { extensions: [gfm()], htmlExtensions: [gfmHtml(), lineMarks] });
  const slug = slugger();
  const outline: OutlineEntry[] = [];
  const rendered: { level: number; id: string; line: number }[] = [];
  let title: string | null = null;
  const html = raw
    // An ATX mark is followed by the line ending micromark writes before the `<hN>`; both go.
    .replace(/(?:<!--line:(\d+)-->\n?)?<h([1-6])>([\s\S]*?)<\/h\2>/g,
             (_m, atx: string | undefined, level: string, marked: string) => {
      const line = Number(atx ?? LINE.exec(marked)?.[1] ?? 0);
      const inner = marked.replace(LINE, "");
      const text = plain(inner);
      const id = slug(text);
      rendered.push({ level: Number(level), id, line });
      if (level === "1" && title === null) title = text;
      if (level === "2" || level === "3") outline.push({ level: Number(level) as 2 | 3, text, id, words: 0 });
      return `<h${level} id="${id}">${inner}</h${level}>`;
    })
    // micromark writes `<img src="…" alt="…" />`; the alt is already escaped where it stands.
    .replace(/<img src="[^"]*" alt="([^"]*)"[^>]*\/?>/g,
             (_m, alt: string) => `<em class="dropped">${alt || "image not shown"}</em>`);
  const count = (fragment: string): number => plain(fragment).split(/\s+/).filter(Boolean).length;
  // Each listed heading's section is the HTML from it to the next listed heading.
  const cuts = [...html.matchAll(/<h[23] id="([^"]+)">/g)];
  cuts.forEach((m, i) => {
    const entry = outline.find((o) => o.id === m[1]);
    if (entry) entry.words = count(html.slice(m.index, cuts[i + 1]?.index ?? html.length));
  });
  // Every second-level section wrapped in its own element, so one can be marked as changed, or
  // hidden when the reader asks for the changes alone. What comes before the first stays as it is.
  // Only a heading of the document's own is a section: one quoted, listed or in a footnote belongs
  // to the section it sits in, and cutting there would close the section inside its container.
  const tops: { index: number; id: string; title: string }[] = [];
  let depth = 0;
  for (const m of html.matchAll(/<(\/?)(?:blockquote|li|section)\b[^>]*>|<h2 id="([^"]+)">([\s\S]*?)<\/h2>/g)) {
    if (m[2] === undefined) depth += m[1] ? -1 : 1;
    else if (depth === 0) tops.push({ index: m.index, id: m[2], title: m[3]! });
  }
  const sections = tops.map((m, i) => ({ id: m.id, title: plain(m.title),
    text: plain(html.slice(m.index, tops[i + 1]?.index ?? html.length)) }));
  const wrapped = !tops.length ? html : html.slice(0, tops[0]!.index) + tops.map((m, i) =>
    `<section class="sec" data-sec="${m.id}">${html.slice(m.index, tops[i + 1]?.index ?? html.length)}</section>`).join("");
  const heads = countedLines(src).map((line) => {
    const h = rendered.find((r) => r.line === line);
    return h ? { level: h.level, id: h.id } : null;
  });
  return { html: wrapped, title, outline, words: count(html), sections, heads };
}

/** The sections the change set marks, by heading id: a record names a heading by its position among
 *  the headings the change set's scan counts, and its level; `heads` is numbered by that scan. A
 *  second- or third-level heading is marked itself, and any deeper change marks the second-level
 *  section it sits in, which is what "changes only" shows or hides. The document's first `#`
 *  heading is its title, and a change under it is the opening; a later `#` part is named. A record
 *  whose position lands on no rendered heading of its own level is not marked.
 *
 *  `removed` lists the headings gone, and `other` what changed outside the sections. */
export function marksOf(view: Rendered, changes: readonly Change[]):
    { marks: Map<string, "changed" | "new">; removed: string[]; other: string[] } {
  const marks = new Map<string, "changed" | "new">();
  const removed: string[] = [];
  const other: string[] = [];
  const name = (heading: string) => heading.replace(/^#+\s*/, "").replace(/\s+#*\s*$/, "");
  const mark = (heading: string, at: number, how: "changed" | "new") => {
    const h = view.heads[at - 1];
    if (!h || h.level !== (/^#+/.exec(heading)?.[0].length ?? 0)) return;
    if (h.level === 1) {
      const what = view.heads.find((x) => x?.level === 1) === h ? "the opening" : name(heading);
      if (!other.includes(what)) other.push(what);
      return;
    }
    if (h.level === 2 || h.level === 3) { if (marks.get(h.id) !== "new") marks.set(h.id, how); }
    if (h.level === 2) return;
    // The second-level section it sits in: the last one before it.
    const parent = view.heads.slice(0, at - 1).reverse().find((x) => x?.level === 2);
    if (parent && !marks.has(parent.id)) marks.set(parent.id, "changed");
  };
  for (const c of changes) {
    switch (c.kind) {
      case "added": mark(c.heading, c.at, "new"); break;
      case "edited": mark(c.heading, c.at, "changed"); break;
      case "renamed": mark(c.to, c.at, "changed"); break;
      case "moved": mark(c.heading, c.to, "changed"); break;
      case "removed": removed.push(name(c.heading)); break;
      case "preamble": if (!other.includes("the opening")) other.push("the opening"); break;
      case "trailing": other.push("the trailing text"); break;
      case "metadata": other.push(c.field); break;
    }
  }
  return { marks, removed, other };
}
