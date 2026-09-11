/**
 * Prove that a hostile document cannot become script in a reader's browser.
 *
 *   npm run check:markdown      # exits non-zero on failure, like every engine here
 *
 * The knowledge web app injects rendered markdown with innerHTML while the reader's platform
 * token sits in localStorage, so a mistake in the renderer reads that token out of a
 * colleague's browser. Two holes have been found there, both real, both against the live
 * deployment: raw HTML passed straight through, because marked dropped its `sanitize` option
 * years ago; and after tags were escaped, `[click](javascript:alert(1))` still came back as a
 * live anchor, because marked dropped URL sanitising along with it.
 *
 * Both were fixed by reading the code. Neither was ever run. This runs them, against the REAL
 * renderer rather than a copy of its rules — a safety property nothing exercises is one
 * nobody will notice regressing.
 *
 * It checks BOTH directions. An "escape everything" renderer passes every hostile case and is
 * useless, and that failure would look exactly like success, so the ordinary documents are
 * cases too.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderMarkdown } from "./markdown.js";

interface Spec {
  allowed_tags: string[];
  allowed_attributes: string[];
  allowed_url_schemes: string[];
  cases: { name: string; source: string }[];
  must_still_render: { name: string; source: string; expect: string }[];
}

const spec = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "markdown-cases.json"), "utf8"),
) as Spec;

const TAGS = new Set(spec.allowed_tags);
const ATTRS = new Set(spec.allowed_attributes);
const SCHEMES = new Set(spec.allowed_url_schemes);

/**
 * An attribute value AS A BROWSER WOULD SEE IT.
 *
 * The browser decodes HTML entities in an attribute before it parses a scheme, and this
 * checker did not — so `href="&#106;avascript:alert(1)"` did not start with a scheme as far
 * as it was concerned, and it reported the document safe.
 *
 * That is not hypothetical. The renderer is safe today only because escapeHtml turns `&` into
 * `&amp;`; remove that one replace — the obvious change if double-escaping ever looks like a
 * bug — and the same document comes back as live script, with this corpus still reporting
 * every case passing. A safety net that cannot see the browser's own decoding is judging a
 * different document from the one the reader opens.
 */
function asBrowserSees(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&(amp|lt|gt|quot|apos|colon|Tab|NewLine);/gi, (whole, name: string) => {
      const named: Record<string, string> = {
        amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", colon: ":", tab: "\t", newline: "\n",
      };
      return named[name.toLowerCase()] ?? whole;
    });
}

/**
 * What is wrong with this HTML, judged on the tags that actually SURVIVED into it.
 *
 * An allowlist of what our renderer can emit, not a blocklist of what an attacker might
 * write. The first version of this check searched the whole output for `on[a-z]+=` and
 * called six safe documents dangerous, because `&lt;img src=x onerror=…&gt;` contains that
 * text and is inert — a check that cries wolf on its own correct output is one somebody
 * eventually silences.
 *
 * Escaped author text has no real tags in it at all, so scanning tags is exactly the
 * question: did anything the author wrote become markup?
 */
function unsafe(html: string): string[] {
  const found: string[] = [];
  for (const m of html.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s=>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g)) {
    const tag = m[1].toLowerCase();
    if (!TAGS.has(tag)) { found.push(`<${tag}> is not a tag this renderer emits`); continue; }
    for (const a of m[2].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      const name = a[1].toLowerCase();
      const value = a[2] ?? a[3] ?? a[4] ?? "";
      if (!ATTRS.has(name)) { found.push(`<${tag} ${name}=…> is not an attribute this renderer emits`); continue; }
      if (name !== "href" && name !== "src") continue;
      // Decoded first, then stripped of the characters a browser ignores in a scheme. An
      // entity can hide the colon as readily as the letters: `&#106;avascript&colon;x`.
      const seen = asBrowserSees(value).replace(/[\u0000-\u0020]/g, "");
      const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(seen);
      if (scheme && !SCHEMES.has(scheme[1].toLowerCase())) {
        found.push(`<${tag} ${name}="${scheme[1]}:…"> is not a scheme this renderer allows`);
      }
    }
  }
  return found;
}

let bad = 0;

for (const c of spec.cases) {
  const out = renderMarkdown(c.source);
  const problems = unsafe(out);
  if (problems.length) bad++;
  console.log(`  ${problems.length ? "FAIL" : "ok  "} refuses ${c.name}`);
  if (problems.length) console.log(`         ${problems.join("; ")}\n         ${out.trim().slice(0, 140)}`);
}

for (const c of spec.must_still_render) {
  const out = renderMarkdown(c.source);
  const ok = out.includes(c.expect);
  if (!ok) bad++;
  console.log(`  ${ok ? "ok  " : "FAIL"} still renders ${c.name}`);
  if (!ok) console.log(`         wanted ${c.expect} in ${out.trim().slice(0, 140)}`);
}

const total = spec.cases.length + spec.must_still_render.length;
console.log(`\n  ${total - bad}/${total} documents rendered as they must`);
process.exit(bad ? 1 : 0);
