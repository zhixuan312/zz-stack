/**
 * Rendering a team's documents for the browser, safely.
 *
 * Its own module because it is a security boundary and nothing else here is: the page injects
 * this output with innerHTML while the reader's platform token sits in localStorage, so a
 * mistake in these thirty lines reads that token out of a colleague's browser. Separated so
 * it can be PROVEN — the gate renders a corpus of hostile documents through this exact
 * function and fails the release if any of them comes back live.
 *
 * Two holes have been found here, both real, both against the live deployment:
 *
 *   marked passes raw HTML through untouched — it dropped its `sanitize` option years ago
 *   and points at DOMPurify instead — so a document containing `<img src=x onerror=…>` ran
 *   in the browser of whoever opened it. Documents are drafted from what stakeholders write,
 *   so the payload does not even need an attacker inside the platform.
 *
 *   Escaping tags closed that half and left the other open. marked emits
 *   `[click](javascript:alert(1))` as a live anchor, having dropped URL sanitising along with
 *   `sanitize`. Verified before the fix: href="javascript:alert(3)" came back rendered.
 */
import { Marked, type RendererThis, type Tokens } from "marked";

/** HTML-escape, for anything of the author's that lands in markup.
 *
 * THE QUOTES MATTER AS MUCH AS THE ANGLE BRACKETS. Three of the four uses below put author
 * text inside a double-quoted attribute, and without `"` in this list a link destination
 * closes the attribute and opens another: `[click](/foo"onmouseover="alert(1))` rendered as
 * `<a href="/foo"onmouseover="alert(1)">`, which is a live event handler in the page that
 * keeps the reader's platform token in localStorage. marked escapes a link's title and an
 * image's alt text before we see them, and does NOT escape the destination — so escaping
 * tags and refusing schemes had closed the doors either side of this one and left it open,
 * for the third time in this file.
 */
export const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
   .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * A URL safe to put in href or src, or null.
 *
 * An allowlist, because a blocklist of schemes is a game nobody wins: `javascript:` has
 * `JaVaScRiPt:`, tab and newline separators, and `&#106;avascript:` behind an HTML entity
 * decode. Anything relative, anchored, http(s) or mailto passes; everything else does not.
 */
function safeUrl(href: string): string | null {
  const raw = (href ?? "").trim();
  // Strip characters a browser ignores when it parses a scheme, so they cannot hide one.
  const probe = raw.replace(/[\u0000- ]/g, "").toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:/.test(probe)) {
    return /^(https?|mailto):/.test(probe) ? raw : null;
  }
  return raw; // relative, root-relative, or a #fragment
}

const md = new Marked({ async: false });
md.use({
  renderer: {
    // Raw HTML is rendered as its own visible text rather than dropped: a document that used
    // a tag shows the tag, which is honest about what the author wrote, where silence would
    // look like content going missing. Code blocks and tables are untouched — they are
    // markdown, not HTML in the source.
    html(token: { raw?: string; text?: string }) {
      return escapeHtml(token.raw ?? token.text ?? "");
    },
    // A refused URL renders as its own visible text, for the same reason a refused tag does:
    // the reader sees what the author wrote instead of a link that silently went missing.
    //
    // THE BODY GOES BACK THROUGH THE PARSER. `token.text` is the link's RAW SOURCE — not, as
    // this file previously claimed, something already rendered — so inserting it built a live
    // tag out of author text: `[<img src=x onerror=…>](https://ok.example)` came back as an
    // anchor wrapping a working payload, inside the page that keeps the reader's platform
    // token in localStorage. Escaping tags and refusing schemes had closed the two doors
    // either side of this one and left it open, and reading the code is what missed it: the
    // claim sounded right, and the test that would have disproved it did not exist.
    //
    // parseInline routes the body through this same renderer, so the raw HTML meets `html`
    // above and is escaped — and `[**bold** link](…)` renders as bold, which plain escaping
    // would have destroyed. Both directions from one call.
    link(this: RendererThis, token: Tokens.Link) {
      const href = safeUrl(token.href);
      const body = this.parser.parseInline(token.tokens);
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
      return href === null
        ? `${body} (${escapeHtml(token.href)})`
        : `<a href="${escapeHtml(href)}"${title}>${body}</a>`;
    },
    image(token: { href: string; title?: string | null; text: string }) {
      const href = safeUrl(token.href);
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
      return href === null
        ? `${escapeHtml(token.text)} (${escapeHtml(token.href)})`
        : `<img src="${escapeHtml(href)}" alt="${escapeHtml(token.text)}"${title}>`;
    },
  },
});

/** One document, as HTML the browser may inject. */
export const renderMarkdown = (source: string): string => md.parse(source) as string;
