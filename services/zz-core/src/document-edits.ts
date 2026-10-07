/**
 * The edit primitive: an exact batch of find/replace edits applied to one body, or the reason it
 * cannot be. Pure — no store, no envelope, no clock — so the rules live in one place and a check
 * can run them without a database.
 *
 * Every `find` is located in the ONE original body, never in a body an earlier edit produced, so
 * a replacement can never become a later edit's target. Each must occur exactly once, counting
 * overlapping occurrences ("aa" occurs three times in "aaaa"); the spans must not overlap; the
 * splices run last to first so earlier offsets stay valid. All or nothing: a refusal carries no
 * body, and names EVERY edit that cannot apply — each is judged against the one original body, so
 * one failing edit says nothing about another. No fuzzy matching, whitespace folding or Unicode
 * normalisation — the bytes either match or they do not.
 *
 * A repeated `find` is counted exactly, and the lines of its first KEPT_MATCHES occurrences are
 * kept: a short `find` on a long body occurs once per character, and holding every line ran the
 * one process every team shares out of heap.
 */

export interface Edit { find: string; replace: string }

export type EditRefusal = {
  code: "NO_MATCH" | "MULTIPLE_MATCHES" | "OVERLAPPING_EDITS" | "EDIT_COUNT" | "INVALID_EDIT";
  edit_index?: number;
  /** Every occurrence, exactly. */
  match_count?: number;
  /** One 1-based line per occurrence of the first KEPT_MATCHES, in order, duplicates kept. */
  lines?: number[];
};

/** The most edits one batch may carry. COUPLED: the tool's description says the same number. */
export const MAX_EDITS = 128;

/** The most occurrences of one `find` whose lines a refusal keeps. The stakeholder's cap
 *  (2026-10-07): the count stays exact, and the detail says how many it omitted. */
const KEPT_MATCHES = 1000;

/** Every occurrence of `find`, overlapping ones included, counted, and the start offsets of the
 *  first `keep`. One pass: `indexOf` finds the next occurrence while no partial match is open, and
 *  Knuth–Morris–Pratt carries one on from where an occurrence's border leaves it — restarting
 *  `indexOf` one character after each occurrence compares the whole `find` again at every position
 *  of a self-overlapping run, O(body × find). */
function occurrences(body: string, find: string, keep: number): { count: number; at: number[] } {
  const k = find.length;
  // border[i]: the longest proper prefix of find[0..i] that is also its suffix.
  const border = new Int32Array(k);
  for (let i = 1, j = 0; i < k; i++) {
    while (j > 0 && find.charCodeAt(i) !== find.charCodeAt(j)) j = border[j - 1];
    if (find.charCodeAt(i) === find.charCodeAt(j)) j++;
    border[i] = j;
  }
  const at: number[] = [];
  let count = 0;
  const found = (start: number) => { count++; if (at.length < keep) at.push(start); };
  for (let i = 0, j = 0; i < body.length; i++) {
    if (j === 0) {
      // No occurrence is open, so none can start before the next one indexOf finds.
      const next = body.indexOf(find, i);
      if (next < 0) break;
      found(next);
      j = border[k - 1];
      i = next + k - 1;
      continue;
    }
    const c = body.charCodeAt(i);
    while (j > 0 && c !== find.charCodeAt(j)) j = border[j - 1];
    if (c === find.charCodeAt(j) && ++j === k) { found(i - k + 1); j = border[k - 1]; }
  }
  return { count, at };
}

/** 1-based line of each ascending offset, counted by `\n` — a CRLF body counts the same way. One
 *  forward pass: recounting from offset 0 per occurrence is quadratic on a short repeated `find`. */
function linesOf(body: string, offsets: number[]): number[] {
  const out: number[] = [];
  let n = 1;
  let nl = body.indexOf("\n");
  for (const o of offsets) {
    for (; nl >= 0 && nl < o; nl = body.indexOf("\n", nl + 1)) n++;
    out.push(n);
  }
  return out;
}

export function applyEdits(body: string, edits: Edit[]): { body: string; changed: number } | { refusals: EditRefusal[] } {
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > MAX_EDITS) {
    return { refusals: [{ code: "EDIT_COUNT" }] };
  }
  const spans: { start: number; end: number; replace: string }[] = [];
  const refusals: EditRefusal[] = [];
  // In index order, every edit judged: the refusals come back in the order the edits were sent.
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i];
    if (!e || typeof e.find !== "string" || typeof e.replace !== "string" || e.find === "") {
      refusals.push({ code: "INVALID_EDIT", edit_index: i });
      continue;
    }
    const { count, at } = occurrences(body, e.find, KEPT_MATCHES);
    if (count === 0) { refusals.push({ code: "NO_MATCH", edit_index: i, match_count: 0 }); continue; }
    if (count > 1) {
      refusals.push({ code: "MULTIPLE_MATCHES", edit_index: i, match_count: count, lines: linesOf(body, at) });
      continue;
    }
    const span = { start: at[0], end: at[0] + e.find.length, replace: e.replace };
    // Identical edits land on the same span, so they overlap and are refused here too.
    if (spans.some((s) => span.start < s.end && s.start < span.end)) {
      refusals.push({ code: "OVERLAPPING_EDITS", edit_index: i });
      continue;
    }
    spans.push(span);
  }
  if (refusals.length) return { refusals };
  let out = body;
  for (const s of [...spans].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, s.start) + s.replace + out.slice(s.end);
  }
  return { body: out, changed: edits.length };
}
