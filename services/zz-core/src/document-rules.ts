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
import { ENVELOPE_BLOCK, Envelope } from "@zz/contracts";

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

/** AN INITIATIVE IS NAMED <YYYY-MM-DD>-<slug>, and the platform is what makes that true.
 *
 * Every flow's own text stated the shape and none of it was enforced, so an agent wrote
 * `27-08-2026-sample-intake-2` on 27 August and the platform took it. Forty initiatives on
 * this deployment do not match. The cost is not tidiness: the date IS the sort key everywhere
 * work is listed, so a day-first name sorts under "2" and files itself between two September
 * entries in the console, in initiative_status, and in every report built by ordering on it.
 *
 * WHAT REPLACED THE GUARD. `initiativeNameShape` was here — a refusal read against a name a
 * model had already composed, on the write path, once per document. The name is not the
 * caller's to compose any more: `initiative_open` takes a SLUG and the two functions below
 * build the name from it and the platform's own clock, so a malformed name is not refused,
 * it is unreachable. A rule the caller cannot break beats a rule the caller is told about,
 * and the sentence that told them — "session_whoami carries today's date, use that" — was an
 * instruction to do by hand the one thing that had already gone wrong by hand.
 *
 * `initiativeNameFor` composes the name and lives in initiative-record.ts, beside the clock:
 * this file cannot import write-guards.ts, which imports this one.
 *
 * This stays ON CREATION ONLY, which was the old guard's whole design and still is. Put in
 * safeName they would guard every call that NAMES an initiative — source_add, close,
 * initiative_status — and the forty that already exist could then never be closed, which is
 * the shape of bug this file has now fixed twice. A name is checked when it is chosen;
 * afterwards it is simply the name. */
export function slugRefusal(slug: string): string | null {
  const v = slug.trim();
  if (!v) return "ERROR: slug is required — a few words in the stakeholder's own language, hyphenated.";
  if (v.includes("/") || v.includes("\\") || v === "." || v === "..") {
    return `ERROR: a slug is a single name, not a path — "${v}" contains a separator.`;
  }
  if (v.startsWith(".")) {
    return "ERROR: a slug cannot begin with a dot — the store skips dot-entries, so the " +
           "initiative would be created and then invisible to every listing and to search.";
  }
  // THE HELPFUL CALLER'S MISTAKE. Somebody who knows initiatives are named
  // `<YYYY-MM-DD>-<slug>` types the whole thing, the platform prepends today's date on top of
  // it, and the folder is `2026-09-14-2026-09-13-payment-retries`. That still sorts, which is
  // why nothing downstream would ever report it — the same property that made the old
  // day-first names survive forty times over.
  if (/^\d{4}-\d{2}-\d{2}([-_]|$)/.test(v)) {
    return (
      `ERROR: "${v}" already begins with a date, and the platform prepends today's — this ` +
      "initiative would carry two. Send the slug alone, in the stakeholder's own words: " +
      "`payment-retries`, not the dated folder name."
    );
  }
  return null;
}

/** A flow field this document may not carry, or null.
 *
 * TWO WAYS A FIELD FAILS, and only one of them used to be said out loud. A name the envelope
 * owns was refused here, with a sentence explaining why. A name that is merely malformed —
 * `buildingBlock` where the skill said `building_block`, or a key with a space in it — was
 * dropped, silently, by an identical `FIELD_NAME` test duplicated inside envelopeFor AND
 * inside document_revise. Both paths returned `written: <path> (N chars)`, and the document
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
 * from an explicit act: document_approve(), initiative_close(), document_revise. There is no third source, and
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
    "from document_approve() and initiative_close(); anything else the document needs — `stakeholder`, `tags`, " +
    "`title` — is a named argument to this call, so it is recorded as something you were told " +
    "rather than something you composed."
  );
}

/** A patch that reaches the envelope, or null.
 *
 * The counterpart to frontmatterRefusal, for the write path that edits text in place. That
 * one refuses content which OPENS with frontmatter; document_patch has no content to inspect —
 * it has a `find` and a `replace`, and `find: "flow: ops-flow"` lands in the envelope as
 * readily as in a section.
 *
 * Compared as a BLOCK, before and after, rather than field by field. ownershipCheck already
 * compares the five fields the platform owns and it is not enough here: `flow` is not one of
 * them, and it is the field that decides which gates, which required documents and which
 * closing rule govern the initiative. `version` is the same shape — document_revise owns it,
 * stampEnvelope adds it only when absent, so a patched one stands and desynchronises the
 * document from its own snapshots in _versions/.
 *
 * This closes a route document_patch's own comment used to contemplate — a patch that adds a
 * missing `flow:` line to repair an ungoverned initiative. There is now no repair to reach
 * for: the flow is declared to `initiative_open` and CANNOT be adopted afterwards (FR-30), so
 * an initiative governing nothing is governing nothing on purpose. This docstring used to send
 * the reader to "pass `flow` as an argument to document_write", citing flowDeclarationCheck;
 * both are gone. Every skill that teaches document_patch teaches it for body content: filling
 * a `<!-- brief: -->` marker, one section at a time. */
export function envelopeEditRefusal(before: string, after: string): string | null {
  const was = ENVELOPE_BLOCK.exec(before)?.[0] ?? "";
  const now = ENVELOPE_BLOCK.exec(after)?.[0] ?? "";
  if (was === now) return null;
  return (
    "ERROR: document_patch edits the document's BODY — this patch changes its frontmatter, which " +
    "the platform writes. A gate is recorded by document_approve(); an outcome by initiative_close(); the flow, " +
    "the title, the stakeholder and the tags are named arguments to document_write and " +
    "document_revise, so they arrive as something you were told rather than something you " +
    "composed. The FLOW is not among them: it is declared to initiative_open and cannot be " +
    "adopted afterwards, so an initiative that declares none declares none deliberately and " +
    "there is nothing here to repair."
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
 * it INSERTS a field. document_revise passed a user-supplied `sources` entry in raw, and a
 * probe used it to write `status: approved` and `approved_by:` two lines under the
 * `status: draft` the same call had just set. initiative_status then reported the gate as
 * passed and named the fabricated approver. Rendering is now incapable of emitting it,
 * whatever a future field turns out to hold. */
export function renderEnvelope(env: Record<string, string>, order: string[]): string {
  const keys = [...order.filter((k) => env[k] !== undefined),
                ...Object.keys(env).filter((k) => !order.includes(k))];
  return "---\n" + keys.map((k) => `${k}: ${oneLine(env[k])}`).join("\n") + "\n---\n";
}
