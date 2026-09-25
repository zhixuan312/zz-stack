/**
 * A document too long for one tool result, read and presented in parts.
 *
 * A client caps what one tool result may carry — a 130k-character review.md could not be read at
 * all — so `document_read` and `document_present` take a part: a `section` by heading, and/or an
 * `offset` and `limit` in characters. Every part says the total size and which characters it is,
 * so a reader always knows what it has not seen.
 *
 * Presenting in parts keeps the approval rule honest. A part records a `shown_part` row, which
 * attest.ts shownSinceLastChange does not count. Once the parts presented since the content last
 * changed cover every character of the current body, one `shown` row is appended — the same row a
 * whole present writes — and only then does the document count as presented.
 *
 * Everything takes `root` explicitly and touches no request, so checks/document-parts.ts drives
 * the real functions over a fixture store.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { documentBody, parseEnvelope } from "@zz/contracts";

import { logActivity } from "./persist.js";
import { documentVersions, versionRefusal } from "./versions.js";

/** The size above which a present comes back in parts unasked. Characters, not tokens: a client's
 *  cap is in tokens, and 60k characters stays under the common 25k-token result cap even for
 *  markdown dense with tables and code. */
export const PART_LIMIT = 60_000;

type PartAsk = { section?: string; offset?: number; limit?: number };
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

/** Actions that change a document's bytes. COUPLED: attest.ts CHANGED holds the same three —
 *  coverage is counted since the same moment shownSinceLastChange counts from. */
const CHANGED = new Set(["document_write", "document_patch", "document_revise"]);

/** How much of the current body has been presented since its content last changed: `shown`
 * when a whole present (or an earlier completed set of parts) already stands, `covered` when the
 * parts alone reach every character, `partial` otherwise.
 *
 * Parts are compared on `total`: a part cut from a body of another length is a part of other
 * bytes. `shown` is told apart from `covered` so a completed set of parts appends its `shown`
 * row once, never a second time. */
function partsCover(root: string, relPath: string, total: number): "shown" | "covered" | "partial" {
  const log = join(root, relPath.replace(/^\/+/, "").split("/")[0], "activity.jsonl");
  if (!existsSync(log)) return "partial";
  let spans: [number, number][] = [];
  let whole = false;
  for (const line of readFileSync(log, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e: { action?: string; path?: string; start?: number; end?: number; total?: number };
    try { e = JSON.parse(line) as typeof e; } catch { continue; }
    if (e.path !== relPath) continue;
    if (CHANGED.has(e.action ?? "")) { spans = []; whole = false; }
    else if (e.action === "shown") whole = true;
    else if (e.action === "shown_part" && e.total === total &&
             typeof e.start === "number" && typeof e.end === "number") spans.push([e.start, e.end]);
  }
  if (whole) return "shown";
  let reached = 0;
  for (const [s, e] of spans.sort((a, b) => a[0] - b[0])) {
    if (s > reached) break;
    reached = Math.max(reached, e);
  }
  return reached >= total ? "covered" : "partial";
}

/** One part of a document presented, and the record of it.
 *
 * The same resolution as versions.ts presentDocument — `version: N` reads the frozen copy and
 * records against that copy's path — and the same body: frontmatter excluded, trimmed, so the
 * offsets a part states are offsets into what the person is shown. */
export function presentPart(
  root: string, relPath: string, version: number | undefined, user: string, ask: PartAsk,
): string {
  const rows = documentVersions(root, relPath);
  let readRel = relPath;
  if (version !== undefined) {
    const hit = rows.find((v) => v.version === version);
    if (!hit) return versionRefusal(root, relPath, version) ?? `ERROR: \`${relPath}\` has no version ${version}.`;
    readRel = hit.rel;
  }
  const content = readFileSync(join(root, readRel), "utf8");
  const env = parseEnvelope(content);
  const body = documentBody(content).trim();
  const part = slicePart(body, ask);
  if (typeof part === "string") return part;
  const facts = [`This is ${readRel}`];
  if (env.version) facts.push(`version ${env.version}`);
  if (env.status) facts.push(`status ${env.status}`);
  const signed = env.approved_by
    ? ` Approved by ${env.approved_by}${env.approved_at ? ` on ${env.approved_at}` : ""}.` : "";
  logActivity(root, readRel, { user, action: "shown_part", path: readRel, version: env.version ?? "",
                               start: part.start, end: part.end, total: part.total });
  const covered = partsCover(root, readRel, part.total);
  if (covered === "covered") {
    logActivity(root, readRel, { user, action: "shown", path: readRel, version: env.version ?? "", via: "parts" });
  }
  const standing = covered !== "partial"
    ? "Every character of the current body has now been presented, in parts — it counts as presented."
    : "Presented in part. It does NOT yet count as presented: present the remaining characters " +
      "(every part since the last change counts) before the document is approved.";
  return `${facts.join(", ")}.${signed}\n${partHeader(readRel, part, "the body, frontmatter excluded", body)}\n` +
         `${standing}\n\n${part.text}\n`;
}
