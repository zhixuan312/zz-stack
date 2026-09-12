/**
 * The document rules that are pure functions of their input.
 *
 * WHY THESE ARE A MODULE. Every one of them takes a string or an object and returns a string,
 * a boolean or a row — no database, no filesystem, no clock beyond a stated timezone. They are
 * the most testable code on this platform and, until this file existed, the least reachable:
 * they sat inside a 6,114-line `server.ts` where nothing could import them, so nothing could
 * exercise them, so every claim about them was a claim about how the source reads.
 *
 * That is the argument for the split, and it is not readability. `attest.ts` made the same
 * move in 0.25.0 and the check that now guards it could not have been written the day before.
 *
 * WHAT DOES NOT BELONG HERE: anything that reads the store, queries Postgres, or decides
 * policy about a caller. Those stay in `server.ts` with the tool that owns them. A rule that
 * needs the world is not a rule this file can hold.
 */
import { ENVELOPE_BLOCK, Envelope, verdictFromProse } from "@zz/contracts";

interface DecisionRow {
  key: string; verdict: string; qualifier: string; detail: string; checker: string;
}

/** The shape a frontmatter key has to have. YAML is not this strict; the store is, because a
 * key is read by eye out of a file a team keeps and by `parseEnvelope` out of one the platform
 * indexes, and neither wants two spellings of one field. */
export const FIELD_NAME = /^[a-z][a-z0-9_]*$/;

/** Names a flow may not claim: the platform reads these, so a flow setting one would be
 * answering a question the platform already answers, differently.
 *
 * FROM THE SCHEMA, not a second list beside it. This was eleven names spelled out next to
 * `...PLATFORM_OWNED`, and it had already drifted from the Envelope it mirrors: `date` and
 * `added_at` are envelope fields the platform writes onto sources and were claimable by a
 * flow, and `contributed_by` was in neither list. Two definitions of one vocabulary is the
 * exact shape @zz/contracts exists to end, and the check that refuses second copies did not
 * cover the field NAMES — only the statuses, the outcomes and the owned fields. */
export const RESERVED_ENVELOPE = new Set<string>(Object.keys(Envelope.shape));

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

/** AN INITIATIVE IS NAMED <YYYY-MM-DD>-<slug>, and until now nothing said so but prose.
 *
 * Every flow's own text states the shape and none of it was enforced, so an agent wrote
 * `27-08-2026-sample-intake-2` on 27 August and the platform took it. Forty initiatives on
 * this deployment do not match. The cost is not tidiness: the date IS the sort key everywhere
 * work is listed, so a day-first name sorts under "2" and files itself between two September
 * entries in the console, in initiative_status, and in every report built by ordering on it.
 *
 * ON CREATION ONLY, and that is the whole of the design. Put in safeName it would have guarded
 * every call that names an initiative — add_source, close, initiative_status — and the forty
 * that already exist could then never be closed, which is the shape of bug this file has now
 * fixed twice. A name is checked when it is chosen; afterwards it is simply the name. */
export function initiativeNameShape(name: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}-/.test(name)) return null;
  return (
    `ERROR: an initiative is named <YYYY-MM-DD>-<slug> and "${name}" does not begin with a ` +
    "date in that order. The date is what every listing sorts on, so a day-first or undated " +
    "name files itself in the wrong place for good. get_my_info carries today's date in this " +
    "deployment's own timezone — use that, then a short slug in the stakeholder's words."
  );
}

/** A flow field this document may not carry, or null.
 *
 * TWO WAYS A FIELD FAILS, and only one of them used to be said out loud. A name the envelope
 * owns was refused here, with a sentence explaining why. A name that is merely malformed —
 * `buildingBlock` where the skill said `building_block`, or a key with a space in it — was
 * dropped, silently, by an identical `FIELD_NAME` test duplicated inside envelopeFor AND
 * inside revise_document. Both paths returned `written: <path> (N chars)`, and the document
 * came back without the pointer the flow's own skill had just told the agent to write.
 *
 * A silent drop is the worse of the two failures. A refusal costs one round trip and names
 * the fix; a drop costs whatever is later read out of a document that looks complete. So the
 * rule moved to the one place both write paths already call, and the two copies of it went:
 * a predicate repeated at the call site is a predicate one call site can disagree about. */
export function fieldRefusal(fields: Record<string, unknown> | undefined): string | null {
  const names = Object.keys(fields ?? {}).map((k) => k.trim());
  const clash = names.filter((k) => RESERVED_ENVELOPE.has(k));
  if (clash.length) {
    return `ERROR: ${clash.join(", ")} ${clash.length > 1 ? "are" : "is"} written by the platform — ` +
      "pass it as its own argument where one exists, and otherwise leave it out: a flow field " +
      "with the same name would be a second answer to a question the envelope already answers.";
  }
  const malformed = names.filter((k) => !FIELD_NAME.test(k));
  if (malformed.length) {
    return `ERROR: ${malformed.map((k) => JSON.stringify(k)).join(", ")} ` +
      `${malformed.length > 1 ? "are not frontmatter names" : "is not a frontmatter name"} — ` +
      "a field is lowercase, starts with a letter, and joins words with underscores " +
      "(`building_block`, not `buildingBlock` and not `Building Block`). Rename it and send " +
      "the call again; it is refused rather than dropped because a document written without " +
      "the field it was told to carry looks finished.";
  }
  return null;
}

/** The envelope is the platform's; the body is yours.
 *
 * Every envelope field comes either from a fact the platform already holds — which flow
 * governs this initiative, what role the manifest gives this document, what day it is — or
 * from an explicit act: approve(), close(), revise_document. There is no third source, and
 * "the model typed it into some YAML" was the third source.
 *
 * The cost of that was countable rather than theoretical. Of 93 approved documents on this
 * deployment, four carried no `approved_at` and two no `approved_by`; two consecutive smoke
 * runs signed a gate as `team_one`, which is a team slug and not a person; the first
 * live run closed an initiative `accepted` when the scripted stakeholder had accepted
 * nothing. The platform grew an ANONYMOUS blocklist to catch the worst of it, whose own
 * comment admits there is no way to test whether a string is a person — and that list exists
 * for exactly one reason, which is that the field was typed by a model.
 *
 * So the frontmatter is refused on the way in rather than audited after the fact. What a
 * document says is the model's work and nobody else can do it; what a document IS is a set
 * of facts the platform can fill without asking. */
export function frontmatterRefusal(content: string, tool: string): string | null {
  if (!/^\s*---[ \t]*\r?\n/.test(content)) return null;
  return (
    `ERROR: ${tool} takes the document's BODY — the frontmatter is written by the platform, ` +
    "not by hand, and this content opens with one. Send the markdown starting at its first " +
    "heading. `flow`, `type`, `status`, `version` and `updated_at` are stamped from what the " +
    "platform already knows; `approved_by`, `approved_at`, `outcome` and `closed_by` come " +
    "from approve() and close(); anything else the document needs — `stakeholder`, `tags`, " +
    "`title` — is a named argument to this call, so it is recorded as something you were told " +
    "rather than something you composed."
  );
}

/** A patch that reaches the envelope, or null.
 *
 * The counterpart to frontmatterRefusal, for the write path that edits text in place. That
 * one refuses content which OPENS with frontmatter; patch_file has no content to inspect —
 * it has a `find` and a `replace`, and `find: "flow: ops-flow"` lands in the envelope as
 * readily as in a section.
 *
 * Compared as a BLOCK, before and after, rather than field by field. ownershipCheck already
 * compares the five fields the platform owns and it is not enough here: `flow` is not one of
 * them, and it is the field that decides which gates, which required documents and which
 * closing rule govern the initiative. `version` is the same shape — revise_document owns it,
 * stampEnvelope adds it only when absent, so a patched one stands and desynchronises the
 * document from its own snapshots in _versions/.
 *
 * This closes a route patch_file's own comment used to contemplate — a patch that adds a missing
 * `flow:` line to repair an ungoverned initiative — and that nothing recommends:
 * flowDeclarationCheck and initiative_status both answer that case with "pass
 * `flow: \"<name>\"` as an argument to write_file", which still works and is stamped rather
 * than typed. Every skill that teaches patch_file teaches it for body content: filling a
 * `<!-- brief: -->` marker, one section at a time. */
export function envelopeEditRefusal(before: string, after: string): string | null {
  const was = ENVELOPE_BLOCK.exec(before)?.[0] ?? "";
  const now = ENVELOPE_BLOCK.exec(after)?.[0] ?? "";
  if (was === now) return null;
  return (
    "ERROR: patch_file edits the document's BODY — this patch changes its frontmatter, which " +
    "the platform writes. A gate is recorded by approve(); an outcome by close(); the flow, " +
    "the title, the stakeholder and the tags are named arguments to write_file and " +
    "revise_document, so they arrive as something you were told rather than something you " +
    "composed. If this initiative declares no flow, write its first document again with " +
    '`flow: "<name>"` as an argument — that is the repair, and the platform stamps it.'
  );
}

/** Anything written into a line-structured file — a frontmatter value, a markdown table
 * cell, a numbered line the tool re-parses later — must not be able to end that line.
 * Every corruption found in this file so far was a value that could. */
export const oneLine = (v: string) => String(v).replace(/[\r\n]+/g, " ").trim();

/** A markdown table cell: `|` ends a column the way a newline ends a row. */
const tableCell = (v: string) => oneLine(v).replace(/\|/g, "/");

/** One markdown table row, every cell escaped.
 *
 * Three tables are appended by this file — the outcome ledger, the journal log and the
 * journal index — and each assembled its own row. Two escaped their variable fields and the
 * ledger did not, so an initiative folder named `a|b`, which safePath permits, produced a row
 * every parser reads as initiative "a" and outcome "b". The ledger is what the smoke suite's
 * verdict rests on.
 *
 * A row is built here so a fourth table cannot repeat it: a caller passes cells, not a row. */
export const tableRow = (...cells: (string | number)[]): string =>
  `| ${cells.map((c) => tableCell(String(c))).join(" | ")} |\n`;

/** The one place an envelope is rendered, and the reason every value goes through it.
 *
 * The readers are line-based, so a value carrying a newline does not corrupt a document —
 * it INSERTS a field. revise_document passed a user-supplied `sources` entry in raw, and a
 * probe used it to write `status: approved` and `approved_by:` two lines under the
 * `status: draft` the same call had just set. initiative_status then reported the gate as
 * passed and named the fabricated approver. Rendering is now incapable of emitting it,
 * whatever a future field turns out to hold. */
export function renderEnvelope(env: Record<string, string>, order: string[]): string {
  const keys = [...order.filter((k) => env[k] !== undefined),
                ...Object.keys(env).filter((k) => !order.includes(k))];
  return "---\n" + keys.map((k) => `${k}: ${oneLine(env[k])}`).join("\n") + "\n---\n";
}

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
 * with frontmatter is refused outright, and approve() stamps the field with isoToday(), so
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
