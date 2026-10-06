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
 */

export interface Edit { find: string; replace: string }

export type EditRefusal = {
  code: "NO_MATCH" | "MULTIPLE_MATCHES" | "OVERLAPPING_EDITS" | "EDIT_COUNT" | "INVALID_EDIT";
  edit_index?: number;
  match_count?: number;
  /** One 1-based line per occurrence, in order, duplicates kept. */
  lines?: number[];
};

/** The most edits one batch may carry. COUPLED: the tool's description says the same number. */
export const MAX_EDITS = 128;

/** Start offsets of every occurrence of `find`, overlapping ones included. */
function occurrences(body: string, find: string): number[] {
  const at: number[] = [];
  for (let i = body.indexOf(find); i >= 0; i = body.indexOf(find, i + 1)) at.push(i);
  return at;
}

/** 1-based line of an offset, counted by `\n` — a CRLF body counts the same way. */
function lineOf(body: string, offset: number): number {
  let n = 1;
  for (let i = body.indexOf("\n"); i >= 0 && i < offset; i = body.indexOf("\n", i + 1)) n++;
  return n;
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
    const at = occurrences(body, e.find);
    if (at.length === 0) { refusals.push({ code: "NO_MATCH", edit_index: i, match_count: 0 }); continue; }
    if (at.length > 1) {
      refusals.push({ code: "MULTIPLE_MATCHES", edit_index: i, match_count: at.length,
                      lines: at.map((o) => lineOf(body, o)) });
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
