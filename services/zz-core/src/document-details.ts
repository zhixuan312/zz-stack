/**
 * Counted receipts, complete errors and detail pages: how a reply that carries a list says how
 * long the list is, shows as much of it as fits, and names where the rest is.
 *
 * Every list a receipt or a refusal carries is one line, `<label> (<total>): <preview>`. The whole
 * reply fits REPLY_BUDGET (16 KiB of UTF-8): when it would not, the previews shrink — to empty if
 * they must, and a refusal's later lines go after them — and the totals never do. What a reply
 * leaves out is never presented as complete: the line ``details: `dr_…` — <k> entries not shown
 * above`` says how much is missing — an entry cut short, ending in `…`, counts among them — and
 * names the complete detail, one entry per line, which
 * `document_read(path, details_ref, cursor?)` returns in pages of at most PAGE_BYTES.
 *
 * A receipt is ALWAYS backed by its detail — ``details: `dr_…` (complete)`` when nothing was cut —
 * and the row carrying it is the change's own act row, written in the change's transaction
 * (`saveDocument`, `change.receipt`). A refusal is backed by one only when its list was cut: the
 * detail waits here, keyed by the ref the text names, until the tool that answers with it writes a
 * `document.refused` row (`settleRefusal`), awaited, before the reply goes back — so no printed
 * ref names a row that is not there.
 *
 * DELIBERATE: one list is bounded where it is built, not only in the reply — a repeated `find`'s
 * match lines, the first 1,000 per edit (document-edits.ts), by the stakeholder's decision of
 * 2026-10-07. Its count stays exact, and what it omitted is said, never silent: the line says
 * `details_complete: false` with the omitted count, and the stored row carries both.
 *
 * COUPLED: the ref sits in backticks, which the gateway's refusal redaction collapses, so a refusal
 * class does not split by the ref it names.
 */
import { randomBytes } from "node:crypto";

import { base32, unbase32 } from "@zz/contracts";
import type pg from "pg";

import { type EditRefusal, MAX_EDITS } from "./document-edits.js";
import { oneLine } from "./document-rules.js";
import { insertEvent } from "./indexing.js";

/** The most a receipt or a refusal may carry, in UTF-8 bytes. */
const REPLY_BUDGET = 16 * 1024;
/** The most one detail page carries, in UTF-8 bytes. */
export const PAGE_BYTES = 12_000;
/** The longest one entry of a preview that had to shrink; the detail keeps it whole. */
const ENTRY_CAP = 120;

/** A details reference: `dr_` and 26 base32 characters of 128 random bits. Opaque. */
export const mintRef = (): string => `dr_${base32(randomBytes(16))}`;
const REF = /^dr_[a-z2-7]{26}$/;

/** A counted list: `<lead><label> (<total>): <preview><tail>`. `cap` bounds the preview even
 *  when the whole list would fit — a list nobody reads past its first lines. `total` is the list's
 *  length when `items` holds only its first entries; the rest are in no reply and no detail. */
interface Listed { label: string; items: string[]; total?: number; lead?: string; tail?: string; sep?: string; cap?: number }
export type Line = string | Listed;

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");
const totalOf = (l: Listed): number => l.total ?? l.items.length;
const countOf = (l: Line): number => (typeof l === "string" ? 1 : totalOf(l));

/** One line as shown, with `k` entries per list at most (null: every entry, whole). */
function shown(l: Line, k: number | null): { text: string; hidden: number } {
  if (typeof l === "string") return { text: l, hidden: 0 };
  const total = totalOf(l);
  const sep = l.sep ?? ", ";
  const limit = Math.min(l.cap ?? Infinity, k ?? Infinity);
  const entries = l.items.slice(0, limit).map((x) => (k === null ? oneLine(x) : oneLine(x, ENTRY_CAP)));
  const cutShort = k === null ? 0 : l.items.slice(0, limit).filter((x, i) => entries[i] !== oneLine(x)).length;
  const preview = !total ? "none"
    : entries.join(sep) + (entries.length < total ? `${entries.length ? sep : ""}…` : "");
  return { text: `${l.lead ?? ""}${l.label} (${total}): ${preview}${l.tail ?? ""}`,
           hidden: total - entries.length + cutShort };
}

function render(lines: Line[], k: number | null, keep: number): { text: string; hidden: number } {
  const parts = lines.slice(0, keep).map((l) => shown(l, k));
  return { text: parts.map((x) => x.text).join("\n"),
           hidden: parts.reduce((n, x) => n + x.hidden, 0) + lines.slice(keep).reduce((n, l) => n + countOf(l), 0) };
}

/** The lines as they fit `budget`: whole if they do; otherwise every preview cut to the most
 *  entries that fit, and — when even empty previews do not — the later lines left out. The first
 *  line always stays: it says what the reply is. */
function fitted(lines: Line[], budget: number): { text: string; hidden: number } {
  const whole = render(lines, null, lines.length);
  if (bytes(whole.text) <= budget) return whole;
  const longest = Math.max(0, ...lines.map((l) => (typeof l === "string" ? 0 : l.items.length)));
  let lo = 0, hi = longest;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (bytes(render(lines, mid, lines.length).text) <= budget) lo = mid; else hi = mid - 1;
  }
  for (let keep = lines.length; keep >= 1; keep--) {
    const out = render(lines, lo, keep);
    if (bytes(out.text) <= budget) return out;
  }
  // One line that alone exceeds the budget — a sentence naming hundreds of keys — is cut on a code
  // point and counted among what was left out; the detail keeps it whole.
  const one = render(lines, 0, 1);
  const cut = Buffer.from(one.text, "utf8").subarray(0, budget - 3).toString("utf8").replace(/\uFFFD$/, "");
  return { text: `${cut}…`, hidden: one.hidden + 1 };
}

/** The complete detail: every line, and every entry a list kept on a line of its own. */
function detailsText(lines: Line[]): string {
  return lines.map((l) => typeof l === "string" ? l
    : [`${l.lead ?? ""}${l.label} (${totalOf(l)})${l.tail ?? ""}`, ...l.items.map((x) => `- ${oneLine(x)}`)].join("\n"))
    .join("\n");
}

/** How many entries the lists counted and kept in no reply and no detail. */
const omittedOf = (lines: Line[]): number =>
  lines.reduce((n, l) => n + (typeof l === "string" ? 0 : totalOf(l) - l.items.length), 0);

/** The line naming a reply's detail, and how much of it the reply left out. */
const detailsLine = (ref: string, hidden: number): string => hidden
  ? `details: \`${ref}\` — ${hidden} ${hidden === 1 ? "entry" : "entries"} not shown above`
  : `details: \`${ref}\` (complete)`;
/** The details line at its longest, with the line break before it: a count of ten digits — a
 *  repeated `find`'s total is exact, and 128 of them on an 8 MiB body run past a billion. */
const LONGEST_DETAILS_LINE = 1 + bytes(detailsLine(`dr_${"a".repeat(26)}`, 9_999_999_999));

/** A receipt as one change answers it, and as its request stores it. */
export interface Composed { text: string; details: { ref: string; text: string }; nextMove: string }

/** The receipt of a change: its lines fitted to the budget, the details line, and the next move
 *  it is answered with. The budget leaves room for what follows the receipt in a reply — the
 *  acceptance line, and on a replay this next move and the current one. */
export function composeReceipt(lines: Line[], ref: string, nextMove: string): Composed {
  const move = nextMove.trim();
  const fit = fitted(lines, REPLY_BUDGET - 1024 - 2 * bytes(move) - LONGEST_DETAILS_LINE);
  return { text: `${fit.text}\n${detailsLine(ref, fit.hidden)}`, details: { ref, text: detailsText(lines) }, nextMove: move };
}

/** What a reply prints for a composed receipt: the receipt, anything the tool adds, the next move. */
export const receiptReply = (c: Composed, extra = ""): string =>
  c.text + extra + (c.nextMove ? `\n\n${c.nextMove}` : "");

/** The receipt a committed request returns again: its first line marked as a replay, then the
 *  next move the first call was answered with, labelled as of then, and the one there is now. A
 *  receipt stored before next moves were (Phase 1) has none, and only the current one is said. */
export function replayText(receipt: Record<string, unknown>, now: string): string {
  const lines = String(receipt.text ?? "").split("\n");
  lines[0] = `${lines[0]} (replayed)`;
  const then = typeof receipt.next_move === "string" ? receipt.next_move.trim() : "";
  const moves = [then.replace(/^Next move:/, "Next move (as of the first call):"),
                 now.trim().replace(/^Next move:/, "Next move (now):")].filter(Boolean);
  return lines.join("\n") + (moves.length ? `\n\n${moves.join("\n")}` : "");
}

/** Refusal details waiting for the tool that answers with them to record them, by ref. Bounded:
 *  a refusal computed and never answered (a check calling a guard directly) is forgotten. */
const pending = new Map<string, { details: string; omitted: number }>();

/** A refusal's text: every line whole when it fits — no details line — and otherwise counted
 *  previews with the details line, its complete detail waiting for `settleRefusal`.
 *
 *  COUPLED: a cut refusal names a ref no row carries until `settleRefusal` writes it, so every
 *  tool answering one settles it first: document_write, document_edit, document_approve,
 *  initiative_close and source_add. A list that can be cut reaches no other answer —
 *  `closeCheck`'s lists only on a close, since `ownershipCheck` refuses a hand-typed outcome. */
export function refusalText(lines: Line[]): string {
  const fit = fitted(lines, REPLY_BUDGET - LONGEST_DETAILS_LINE);
  if (!fit.hidden) return fit.text;
  const ref = mintRef();
  pending.set(ref, { details: detailsText(lines), omitted: omittedOf(lines) });
  while (pending.size > 64) pending.delete(pending.keys().next().value!);
  return `${fit.text}\n${detailsLine(ref, fit.hidden)}`;
}

/** A refusal as it is answered: each cut list's detail recorded first, as a `document.refused` row
 *  on `path`, awaited. A row that could not be written takes its ref out of the reply, which says
 *  so — the entries are still counted, and still said to be missing. */
export async function settleRefusal(
  p: Pick<pg.Pool, "query">, at: { who: string; team: string; path: string }, reply: string,
): Promise<string> {
  let out = reply;
  for (const m of reply.matchAll(/`(dr_[a-z2-7]{26})`/g)) {
    const held = pending.get(m[1]);
    if (held === undefined) continue;
    pending.delete(m[1]);
    const { details, omitted } = held;
    const recorded = await insertEvent(p, {
      actor: at.who, team: at.team, initiative: at.path.split("/")[0] || null, kind: "document.refused",
      subject: at.path, detail: { user: at.who, path: at.path, details_ref: m[1], details,
                                  ...(omitted ? { details_complete: false, details_omitted: omitted } : {}) } });
    // A function replacement: the error's own text is never read as a pattern.
    if (!recorded.ok) out = out.replace(`\`${m[1]}\``, () => `not recorded (${oneLine(recorded.error, 200)})`);
  }
  return out;
}

/** The refusal the edit primitive gave for one edit, in the platform's `ERROR: <CODE> — <what to
 *  send>` form. A repeated `find` names its lines counted, at most 40 of them in the reply, and says
 *  how many of them the edit did not keep. */
export function batchRefusal(path: string, r: EditRefusal): Line {
  const at = r.edit_index === undefined ? "" : `edit ${r.edit_index} (0-based): `;
  switch (r.code) {
    case "EDIT_COUNT":
      return `ERROR: EDIT_COUNT — send between 1 and ${MAX_EDITS} edits in one call.`;
    case "INVALID_EDIT":
      return `ERROR: INVALID_EDIT — ${at}\`find\` must be a non-empty string and \`replace\` a string ` +
        "(an empty `replace` deletes).";
    case "NO_MATCH":
      return `ERROR: NO_MATCH — ${at}\`find\` does not occur in ${path}. Matching is exact, with no ` +
        "whitespace folding: read the document and copy the text as it is.";
    case "MULTIPLE_MATCHES": {
      const kept = r.lines ?? [];
      const total = r.match_count ?? kept.length;
      return { lead: `ERROR: MULTIPLE_MATCHES — ${at}\`find\` occurs ${total} times in the body, on `,
               label: "lines", items: kept.map(String), total, cap: 40,
               tail: (total > kept.length
                 ? `; the first ${kept.length} are kept and ${total - kept.length} omitted (details_complete: false)` : "") +
                 ". Send a longer `find` that includes enough surrounding text to occur exactly once." };
    }
    case "OVERLAPPING_EDITS":
      return `ERROR: OVERLAPPING_EDITS — ${at}this edit covers text another edit in the batch also ` +
        "covers (identical edits included). Merge them into one edit, or make their `find` text disjoint.";
  }
}

/** A detail page's continuation: `dc_` and the base32 of `<details_ref>:<byte offset>`. */
const cursorOf = (ref: string, offset: number): string => `dc_${base32(Buffer.from(`${ref}:${offset}`, "utf8"))}`;

/** The byte offset a cursor continues `ref` at, or null when it is no cursor of that ref. */
function cursorOffset(ref: string, cursor: string): number | null {
  const raw = /^dc_([a-z2-7]+)$/.exec(cursor) ? unbase32(cursor.slice(3))?.toString("utf8") ?? "" : "";
  const cut = raw.lastIndexOf(":");
  if (cut < 0 || raw.slice(0, cut) !== ref || !/^\d+$/.test(raw.slice(cut + 1))) return null;
  return Number(raw.slice(cut + 1));
}

/** One page of a stored detail from a byte offset: at most PAGE_BYTES, cut on a code point —
 *  at a line break in the page's second half when there is one. */
export function detailPage(text: string, offset: number): { text: string; end: number; total: number } {
  const buf = Buffer.from(text, "utf8");
  let end = Math.min(buf.length, offset + PAGE_BYTES);
  if (end < buf.length) {
    const nl = buf.lastIndexOf(0x0a, end - 1);
    if (nl >= offset + PAGE_BYTES / 2) end = nl + 1;
    while (end > offset && (buf[end] & 0xc0) === 0x80) end--;
  }
  return { text: buf.subarray(offset, end).toString("utf8"), end, total: buf.length };
}

const detailsMissing = (ref: string, path: string): string =>
  `ERROR: DETAILS_MISSING — ${ref} is not a detail of ${path}`;

/** A details read: the page of the detail `ref` names on `path`, for the caller's team. Every page
 *  is read from the one stored row, so a cursor never moves to a newer document. The reply is a
 *  line saying which bytes of how many it is, the page's text, and `Next: cursor dc_…` or
 *  `complete` on the last line. */
export async function readDetails(
  p: Pick<pg.Pool, "query">, team: string, path: string, ref: string, cursor: string | undefined,
): Promise<string> {
  if (!REF.test(ref)) return detailsMissing(ref, path);
  const offset = cursor === undefined ? 0 : cursorOffset(ref, cursor);
  if (offset === null) {
    return `ERROR: INVALID_MODE — cursor ${cursor} does not continue ${ref}; send the cursor the last page of ` +
      "this details_ref named, or none for its first page.";
  }
  const { rows } = await p.query<{ details: string | null }>(
    `select e.detail->>'details' as details
       from zz.event e join zz.team t on t.id = e.team_id
      where t.slug = $1 and e.subject = $2 and e.detail ? 'details_ref' and e.detail->>'details_ref' = $3
      limit 1`, [team, path, ref]);
  const stored = rows[0]?.details;
  if (typeof stored !== "string") return detailsMissing(ref, path);
  const buf = Buffer.from(stored, "utf8");
  if (offset > buf.length || (offset === buf.length && offset > 0) || (buf[offset] & 0xc0) === 0x80) {
    return `ERROR: INVALID_MODE — cursor ${cursor} is outside ${ref}, which is ${buf.length} bytes.`;
  }
  const page = detailPage(stored, offset);
  return `details \`${ref}\` of ${path} — bytes ${offset}–${page.end} of ${page.total}\n${page.text}\n` +
    (page.end < page.total ? `Next: cursor ${cursorOf(ref, page.end)}` : "complete");
}
