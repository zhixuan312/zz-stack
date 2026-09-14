/**
 * The rules a row is derived BY, as pure functions of their input.
 *
 * Every one of them takes a string and returns a string, a boolean or a row — no database,
 * no filesystem, no clock. They came out of zz-core's `document-rules.ts` at Task I-38, with
 * the indexer that is their only caller: they are the derivation, and a package holding the
 * derivation while a service holds the rules it derives by is a package that cannot be built
 * without the service.
 *
 * A FILE OF THEIR OWN, and not the package's door, because being pure is what makes them the
 * only part of the index that can be exercised without a Postgres — `checks/document-rules.ts`
 * calls every one of them with the shape that would be wrong in the flattering direction.
 */
import { verdictFromProse } from "@zz/contracts";

export interface DecisionRow {
  key: string; verdict: string; qualifier: string; detail: string; checker: string;
}

/** What a claim's key looks like, in one place.
 *
 * `AC-1.1` is ops-flow's convention, written in its skills' prose. Keyed to that literally,
 * this reads ops-flow and silently returns nothing for sdlc-flow, whose criteria are `AC-2`
 * and whose requirements are `FR-3` — triggered by role, matching nothing, which is worse
 * than not running at all because it looks connected.
 *
 * The probe belongs on the platform's side of the line: `role` is declared in flow.json and
 * is the platform's, so filtering on it is generic; a key SHAPE that every numbered
 * identifier satisfies is generic too. What each key MEANS stays the flow's business, and
 * this deliberately does not ask. */
const CLAIM_KEY = "([A-Z]{1,4}-\\d+(?:\\.\\d+)*)";

/** Whether a file belongs in the searchable corpus.
 *
 * Used by BOTH the write path and the rebuild, because they have to agree: the rebuild
 * decides which rows are stale by which files it saw, so a file the writer skips but the
 * walker counts as present keeps its row forever.
 *
 * _knowledge/index.md is a table of every node's title and _knowledge/log.md is the
 * append-only audit trail. Both are derived from the nodes. Indexing them puts a row in the
 * corpus that matches almost any query — it contains almost every title — while being the
 * row least able to answer one. */
export function indexable(relPath: string): boolean {
  const parts = relPath.replace(/^\/+/, "").split("/");
  if (parts.length < 2 || !relPath.endsWith(".md")) return false;
  return !(parts[0] === "_knowledge" && parts.length === 2);
}

/** A frontmatter date as an ISO date, whichever way the flow wrote it.
 *
 * This accepted DD-MM-YYYY only, and returned null for anything else — so a document
 * dated the ISO way indexed with NO approval date at all. On the live store that was 78
 * rows carrying approved_by against 65 carrying approved_at: thirteen approvals whose
 * WHEN had quietly gone missing from the searchable record.
 *
 * A derived index has no business discarding provenance over a format it did not expect.
 *
 * NOT because a flow may choose. No flow writes `approved_at` at all now — content opening
 * with frontmatter is refused outright, and document_approve() stamps the field with isoToday(), so
 * everything written from here on is ISO. What this tolerates is the STORE AS IT IS: the
 * production store holds 66 documents dated DD-MM-YYYY against 10 in ISO, all written before
 * the platform owned the field. Narrowing this to ISO would drop sixty-six approval dates
 * out of the searchable record to tidy up a format nothing writes any more. */
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
 * Parsed rather than asked for. A new frontmatter field would be a second place for the same
 * fact to drift from, and the fit ledger is already the thing a person reads to understand
 * the choice. What a stage writes for a reader is what gets indexed, so a stage that stops
 * writing it stops producing rows — visibly, rather than by filling a field with nothing.
 *
 * The verdict is normalised to the four the method names, and whatever it was hedged with is
 * kept verbatim beside it: "Achievable - blocked on credential" is an Achievable that did not
 * come free, and either half alone loses what is worth knowing a quarter later. */
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
    // The vocabulary comes from @zz/contracts, not a regex spelled here. It was four literals
    // in this line and a sentence in a migration comment — two spellings of one rule, with no
    // way for a database constraint to agree with either.
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
  // Two shapes in the corpus is a fact about the corpus, not a thing to wish away. Reading
  // only the newest one would have indexed one selection document out of ten and reported
  // the other nine as having made no claims — a quarter of history erased by a regex. The
  // skill can be tightened to one shape later; the rows already written cannot.
  //
  // The verdict carries a parenthetical in this shape — `*Native (BookIt).*`,
  // `*Achievable (RuleMill -> CaseBox).*` — and it is the most useful half: it names the
  // block PER ROW, where the document's frontmatter only names them for the whole choice.
  // A first regex demanded a bare `*Native.*` and matched one selection document out of six.
  for (const m of body.matchAll(new RegExp(
    `^\\*\\*${CLAIM_KEY}[^*]*?\\*\\*\\s*\\*(Native|Achievable|Workaround|Not possible)([^*]*)\\*\\s*(.*)$`,
    "gim"))) {
    if (rows.has(m[1])) continue;
    rows.set(m[1], { key: m[1], verdict: m[2].toLowerCase().replace(" ", "_"),
                     qualifier: cap(m[3].replace(/^[\s.]+|[\s.]+$/g, "")),
                     detail: cap(m[4]), checker: "" });
  }

  // A PLAN's task, and the criteria it discharges. `plan` has been in the claim-bearing
  // roles from the start and produced zero rows from every plan ever written, because a plan
  // states its claims as `### Task I-1: <what it does> (← AC-8)` — neither a table cell nor a
  // bolded line, so all three readers above skipped it in silence.
  //
  // The arrow is the whole point. "Which task covers AC-5", and its more useful inverse
  // "which criterion has no task at all", are the questions a plan audit actually asks, and
  // this initiative's own plan dispatched four of the spec's five agent-review criteria — a
  // miscount found by a person reading the document twice, which a single query would have
  // returned. The traceability table an author is asked to write by hand is this, derived.
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

  // A CHECKLIST ITEM IS THE SAME CLAIM, and until now it was not a claim at all. ops-flow
  // writes `**AC-1.1** …` at line start and is read; sdlc-flow writes `- [ ] **AC-6.1** …` and
  // was not. So a spec's REQUIREMENTS, which do open with a bold key, were indexed as its
  // criteria while its actual criteria were indexed nowhere — and the console then displayed
  // the result under the heading "acceptance criteria".
  //
  // THE PREFIX IS THE ONLY WIDENING (spec R-12, FR-15). An optional list marker, an optional
  // tick box, and the bold key must still OPEN the claim: a key mentioned mid-sentence is a
  // reference to a claim, not a statement of one, and admitting those would index every
  // traceability table in the corpus as though it made the claims it points at.
  //
  // Both new groups are NON-CAPTURING, which is load-bearing. A capturing group here shifts
  // m[2] and m[3] by one and silently moves the checker into the detail for every row this
  // reader has ever produced — a corruption with no error attached to it.
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
