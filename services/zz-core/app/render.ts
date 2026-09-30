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
  /** Each second-level section's heading and plain text, in order: what two versions are compared by. */
  sections: { id: string; title: string; text: string }[];
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

export function renderMarkdown(body: string): Rendered {
  const raw = micromark(body.replace(/\r\n/g, "\n"), { extensions: [gfm()], htmlExtensions: [gfmHtml()] });
  const slug = slugger();
  const outline: OutlineEntry[] = [];
  let title: string | null = null;
  const html = raw
    .replace(/<h([1-4])>([\s\S]*?)<\/h\1>/g, (_m, level: string, inner: string) => {
      const text = plain(inner);
      const id = slug(text);
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
  const tops = [...html.matchAll(/<h2 id="([^"]+)">([\s\S]*?)<\/h2>/g)];
  const sections = tops.map((m, i) => ({ id: m[1]!, title: plain(m[2]!),
    text: plain(html.slice(m.index, tops[i + 1]?.index ?? html.length)) }));
  const wrapped = !tops.length ? html : html.slice(0, tops[0]!.index) + tops.map((m, i) =>
    `<section class="sec" data-sec="${m[1]}">${html.slice(m.index, tops[i + 1]?.index ?? html.length)}</section>`).join("");
  return { html: wrapped, title, outline, words: count(html), sections };
}

/** How each section of `now` stands against `before`, by heading: changed, new, or — absent from
 *  the map — the same. Headings `before` had and `now` does not are listed as removed. */
export function compareSections(now: Rendered, before: Rendered):
    { marks: Map<string, "changed" | "new">; removed: string[] } {
  const was = new Map(before.sections.map((x) => [x.title, x.text]));
  const marks = new Map<string, "changed" | "new">();
  for (const x of now.sections) {
    const old = was.get(x.title);
    if (old === undefined) marks.set(x.id, "new");
    else if (old.replace(/\s+/g, " ") !== x.text.replace(/\s+/g, " ")) marks.set(x.id, "changed");
  }
  const titles = new Set(now.sections.map((x) => x.title));
  return { marks, removed: before.sections.map((x) => x.title).filter((t) => !titles.has(t)) };
}
