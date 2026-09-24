/**
 * The rules a row is derived by, as pure functions of their input.
 *
 * Every one takes a string and returns a string, a boolean or a row — no database, no
 * filesystem, no clock. Being pure is what makes them the only part of the index that can be
 * exercised without a Postgres: `checks/document-rules.ts` calls every one of them with the
 * shape that would be wrong in the flattering direction.
 */
import { verdictFromProse } from "@zz/contracts";

export interface DecisionRow {
  key: string; verdict: string; qualifier: string; detail: string; checker: string;
}

/** What a claim's key looks like, in one place.
 *
 * Any numbered identifier: ops-flow's `AC-1.1`, sdlc-flow's `AC-2` and `FR-3`. Keyed to one
 * flow's convention this would be triggered by role and match nothing, which looks connected
 * and is not.
 *
 * `role` is declared in flow.json and is the platform's, so filtering on it is generic, and a
 * key shape every numbered identifier satisfies is generic too. What each key means stays the
 * flow's business and this does not ask. */
const CLAIM_KEY = "([A-Z]{1,4}-\\d+(?:\\.\\d+)*)";

/** Whether a file belongs in the searchable corpus.
 *
 * COUPLED: the write path and the rebuild, both in `packages/indexing/src/index.ts`, call
 * this and have to agree. The rebuild
 * decides which rows are stale by which files it saw, so a file the writer skips but the
 * walker counts as present keeps its row forever.
 *
 * _knowledge/index.md and _knowledge/log.md are derived from the nodes. Indexing them puts a
 * row in the corpus that matches almost any query while being the row least able to answer
 * one. */
export function indexable(relPath: string): boolean {
  const parts = relPath.replace(/^\/+/, "").split("/");
  if (parts.length < 2 || !relPath.endsWith(".md")) return false;
  return !(parts[0] === "_knowledge" && parts.length === 2);
}

/** A frontmatter date as an ISO date, whichever way the flow wrote it.
 *
 * DELIBERATE: DD-MM-YYYY is still accepted. No flow writes `approved_at` any more —
 * document_approve() stamps the field with isoToday() — but the store holds documents dated
 * DD-MM-YYYY from before the platform owned the field, and narrowing this to ISO would drop
 * their approval dates out of the searchable record. */
export function isoDate(v: string | undefined): string | null {
  const d = (v ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;                        // already ISO
  if (/^\d{2}-\d{2}-\d{4}$/.test(d)) return d.split("-").reverse().join("-");  // DD-MM-YYYY
  return null;
}

/** The claims a stage document makes, as rows, from text the stage already wrote.
 *
 * Two shapes, because two stages state a commitment two ways and both are already on disk:
 *
 *   selection.md   | AC-1.2 web-form channel ready | **Achievable - blocked on credential** | ... |
 *   spec.md        **AC-1.1** `[you]` - An email to the pilot's inbox appears as a case.
 *
 * Parsed rather than asked for: what a stage writes for a reader is what gets indexed, so a
 * stage that stops writing it stops producing rows.
 *
 * The verdict is normalised to the four the method names, and whatever it was hedged with is
 * kept verbatim beside it: "Achievable - blocked on credential" is an Achievable that did not
 * come free. */
export function decisionRows(body: string): DecisionRow[] {
  const rows = new Map<string, DecisionRow>();
  const cap = (s: string): string => s.trim().replace(/\s+/g, " ").slice(0, 400);

  // A fit ledger row: the first cell opens with the criterion's key, then labels it.
  for (const line of body.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1);
    if (cells.length < 3) continue;
    const key = new RegExp(`^\\s*\\*{0,2}${CLAIM_KEY}`, "i").exec(cells[0])?.[1];
    if (!key) continue;
    const said = cells[1].replace(/\*\*/g, "").trim();
    // The vocabulary comes from @zz/contracts, not a regex spelled here, so a database
    // constraint can agree with the same list.
    const verdict = verdictFromProse(said);
    if (!verdict) continue;
    rows.set(key, {
      key,
      verdict,
      qualifier: cap(said.slice(verdict.length).replace(/^[\s\u2014\u2013-]+/, "")),
      detail: cap(cells[2]),
      checker: "",
    });
  }

  // The same ledger written as prose, which is what the earlier initiatives on this store
  // carry: `**AC-1.1 — An email enquiry creates a case.** *Native.* An email case source...`
  //
  // DELIBERATE: both shapes are read. Reading only the newest would index one selection
  // document out of ten and report the other nine as having made no claims.
  //
  // The verdict carries a parenthetical in this shape — `*Native (BookIt).*`,
  // `*Achievable (RuleMill -> CaseBox).*` — and it names the product per row, where the
  // document's frontmatter only names them for the whole choice.
  for (const m of body.matchAll(new RegExp(
    `^\\*\\*${CLAIM_KEY}[^*]*?\\*\\*\\s*\\*(Native|Achievable|Workaround|Not possible)([^*]*)\\*\\s*(.*)$`,
    "gim"))) {
    if (rows.has(m[1])) continue;
    rows.set(m[1], { key: m[1], verdict: m[2].toLowerCase().replace(" ", "_"),
                     qualifier: cap(m[3].replace(/^[\s.]+|[\s.]+$/g, "")),
                     detail: cap(m[4]), checker: "" });
  }

  // A plan's task, and the criteria it discharges. A plan states its claims as
  // `### Task I-1: <what it does> (← AC-8)` — neither a table cell nor a bolded line, so the
  // three readers above skip it.
  //
  // The arrow is the point: "which task covers AC-5", and its inverse "which criterion has no
  // task at all", are the questions a plan audit asks. The traceability table an author is
  // asked to write by hand is this, derived.
  for (const m of body.matchAll(new RegExp(
    `^#{2,4}\\s*Task\\s+${CLAIM_KEY}\\s*[:\u2014\u2013-]\\s*(.*)$`, "gm"))) {
    if (rows.has(m[1])) continue;
    const title = m[2];
    const covers = [...title.matchAll(new RegExp(CLAIM_KEY, "g"))].map((c) => c[1]);
    rows.set(m[1], {
      key: m[1],
      verdict: "",
      // The criteria this task claims to discharge, in the document's own order. Empty is a
      // real answer and the one worth querying: a task tracing to nothing.
      qualifier: covers.join(" "),
      detail: cap(title.replace(/\s*\(\s*\u2190[^)]*\)\s*$/, "")),
      checker: "",
    });
  }

  // A checklist item is the same claim: ops-flow writes `**AC-1.1** …` at line start,
  // sdlc-flow writes `- [ ] **AC-6.1** …`. Without the second shape a spec's requirements,
  // which do open with a bold key, are indexed as its criteria while its actual criteria are
  // indexed nowhere.
  //
  // The prefix is the only widening. An optional list marker, an optional
  // tick box, and the bold key must still open the claim: a key mentioned mid-sentence is a
  // reference to a claim, not a statement of one, and admitting those would index every
  // traceability table in the corpus as though it made the claims it points at.
  //
  // DELIBERATE: both new groups are non-capturing. A capturing group here shifts m[2] and m[3]
  // by one and silently moves the checker into the detail for every row this reader produces.
  //
  // The inner whitespace is `[ \t]` rather than `\s`: `\s` matches a newline, so a stray
  // bullet on its own line would reach across it and claim the line below.
  //
  // An acceptance criterion as the spec states it, with who verifies it.
  for (const m of body.matchAll(new RegExp(
    `^(?:[-*][ \t]*)?(?:\\[[ x]\\][ \t]*)?\\*\\*${CLAIM_KEY}\\*\\*\\s*(?:\`\\[([^\\]]+)\\]\`)?\\s*[\u2014\u2013-]?\\s*(.*)$`, "gm"))) {
    if (rows.has(m[1])) continue;              // a ledger row already said more about it
    rows.set(m[1], { key: m[1], verdict: "", qualifier: "",
                     detail: cap(m[3]), checker: (m[2] ?? "").trim() });
  }
  return [...rows.values()];
}
