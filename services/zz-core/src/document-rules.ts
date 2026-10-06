/**
 * The document rules that are pure functions of their input.
 *
 * Every one of them takes a string or an object and returns a string, a boolean or a row — no
 * database, no filesystem, no clock beyond a stated timezone.
 *
 * What does not belong here: anything that reads the store, queries Postgres, or decides policy
 * about a caller. Those stay in `server.ts` with the tool that owns them.
 */
import { ENVELOPE_BLOCK, Envelope } from "@zz/contracts";

/** The shape a frontmatter key has to have. YAML is not this strict; the store is, because a
 * key is read by eye out of a file a team keeps and by `parseEnvelope` out of one the platform
 * indexes, and neither admits two spellings of one field. */
export const FIELD_NAME = /^[a-z][a-z0-9_]*$/;

/** Names a flow may not claim: the platform reads these, so a flow setting one would be
 * answering a question the platform already answers, differently.
 *
 * Derived from the Envelope schema in @zz/contracts, never a second list beside it. */
export const RESERVED_ENVELOPE = new Set<string>(Object.keys(Envelope.shape));

/** An initiative is named `<YYYY-MM-DD>-<slug>`, and the platform composes that name.
 *
 * The date is the sort key everywhere work is listed, so a day-first name sorts under its first
 * digit and files itself among entries from another month.
 *
 * `initiative_open` takes a slug, and the two functions below build the name from it and the
 * platform's own clock, so a malformed name is unreachable rather than refused.
 * `initiativeNameFor` composes the name and lives in initiative-record.ts, beside the clock:
 * this file cannot import write-guards.ts, which imports this one.
 *
 * DELIBERATE: this runs on creation only. In safeName it would guard every call that names an
 * initiative — source_add, close, initiative_status — and the existing names that do not match
 * the shape could then never be closed. A name is checked when it is chosen; afterwards it is
 * simply the name. */
export function slugRefusal(slug: string): string | null {
  const v = slug.trim();
  if (!v) return "ERROR: slug is required — a few words in the stakeholder's own language, hyphenated.";
  if (v.includes("/") || v.includes("\\") || v === "." || v === "..") {
    return `ERROR: a slug is a single name, not a path — "${v}" contains a separator.`;
  }
  if (v.startsWith(".")) {
    return "ERROR: a slug cannot begin with a dot — a dot-prefixed name is the platform's own " +
           "bookkeeping, never an initiative's, and one would be created and then invisible to " +
           "every listing and to search.";
  }
  // The helpful caller's mistake: somebody who knows initiatives are named
  // `<YYYY-MM-DD>-<slug>` types the whole thing, the platform prepends today's date, and the
  // folder is `2026-09-14-2026-09-13-payment-retries`. That still sorts, so nothing downstream
  // would report it.
  if (/^\d{4}-\d{2}-\d{2}([-_]|$)/.test(v)) {
    return (
      `ERROR: "${v}" already begins with a date, and the platform prepends today's — this ` +
      "initiative would carry two. Send the slug alone, in the stakeholder's own words: " +
      "`payment-retries`, not the dated folder name."
    );
  }
  return null;
}

/** A slug as the store will hold it: lowercase, words joined by single hyphens, nothing else.
 *
 * The platform owns this name: it prepends today's date from its own clock and hands the
 * composed name back, and `zz-platform` tells every agent to use what it returns.
 *
 * DELIBERATE: it shapes rather than refuses. `slugRefusal` above still rejects what is
 * genuinely ambiguous — a path separator, a leading dot, a second date — because only the
 * caller can answer those. A sentence with spaces and a comma is not ambiguous; it is a slug
 * typed in prose, and the store can hold it correctly without asking. */
export function slugify(slug: string): string {
  return slug.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** A flow field this document may not carry, or null.
 *
 * Two ways a field fails, and both are refused here rather than dropped: a name the envelope
 * owns, and a name that is merely malformed (`dueDate` where the skill said
 * `due_date`, or a key with a space in it). A dropped field returns a successful write
 * and a document missing the pointer the flow's skill asked for. Both classes are said at once,
 * one line each: neither depends on the other, and a caller fixing one should not meet the second.
 *
 * COUPLED: this is the one rule every write path calls — document_write and document_edit. */
export function fieldRefusal(fields: Record<string, unknown> | undefined): string | null {
  const names = Object.keys(fields ?? {}).map((k) => k.trim());
  const clash = names.filter((k) => RESERVED_ENVELOPE.has(k));
  const malformed = names.filter((k) => !RESERVED_ENVELOPE.has(k) && !FIELD_NAME.test(k));
  const said = [
    ...(clash.length ? [`ERROR: ${clash.join(", ")} ${clash.length > 1 ? "are" : "is"} written by the platform — ` +
      "pass it as its own argument where one exists, and otherwise leave it out: a flow field " +
      "with the same name would be a second answer to a question the envelope already answers."] : []),
    ...(malformed.length ? [`ERROR: ${malformed.map((k) => JSON.stringify(k)).join(", ")} ` +
      `${malformed.length > 1 ? "are not frontmatter names" : "is not a frontmatter name"} — ` +
      "a field is lowercase, starts with a letter, and joins words with underscores " +
      "(`due_date`, not `dueDate` and not `Due Date`). Rename it and send " +
      "the call again; it is refused rather than dropped because a document written without " +
      "the field it was told to carry looks finished."] : []),
  ];
  return said.length ? said.join("\n") : null;
}

/** Anything written into a line-structured file — a frontmatter value, a markdown table cell,
 * a numbered line the tool re-parses later — must not be able to end that line.
 *
 * `max` is optional: without it nothing is dropped, which is what a title or a stakeholder
 * wants. With it, the cut lands on a word boundary and carries an ellipsis, so a truncated
 * value cannot read as a whole one. */
export const oneLine = (v: string, max?: number) => {
  const s = String(v).replace(/[\r\n]+/g, " ").trim();
  if (max === undefined || s.length <= max) return s;
  // Reserve the ellipsis, then fall back to the hard cut when there is no space to break on —
  // a single unbroken token longer than `max` has no word boundary to find.
  const room = Math.max(0, max - 1);
  const cut = s.slice(0, room);
  const space = cut.lastIndexOf(" ");
  return `${(space > room * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
};

/** The one place an envelope is rendered, and the reason every value goes through it.
 *
 * The readers are line-based, so a value carrying a newline does not corrupt a document — it
 * inserts a field. A user-supplied value passed in raw can write `status: approved` and an
 * `approved_by:` line under the `status: draft` the same call just set. Rendering here is
 * incapable of emitting one, whatever a future field turns out to hold. */
export function renderEnvelope(env: Record<string, string>, order: string[]): string {
  const keys = [...order.filter((k) => env[k] !== undefined),
                ...Object.keys(env).filter((k) => !order.includes(k))];
  return "---\n" + keys.map((k) => `${k}: ${oneLine(env[k])}`).join("\n") + "\n---\n";
}

/** Replace a field's line inside the frontmatter, leaving the body alone.
 *
 * A bare `doc.replace(/^status: .*$/m, …)` is applied to the whole document and rewrites
 * whichever line comes first, and a journal node has body lines that begin with a word and a
 * colon.
 *
 * COUPLED: pure — no database, no store — which is why it lives here rather than beside the
 * write path it was born in. `initiative_close` passes the model's `accepted_by` through
 * `putEnvelopeField` below. */
function setEnvelopeField(doc: string, field: string, value: string): string {
  const m = doc.match(ENVELOPE_BLOCK);
  if (!m) return doc;
  const line = new RegExp(`^${field}:.*$`, "m");
  if (!line.test(m[1])) return doc;
  // Function replacements, both of them: a string replacement interprets $$, $&, $` and $',
  // and `value` is not always the platform's own — initiative_close() passes the model's
  // `accepted_by` through putEnvelopeField below, so `$'` in a name duplicates the rest of the
  // document into its envelope.
  //
  // oneLine() for the other half: a newline in a value adds a field rather than corrupting
  // one, and parseEnvelope takes the last value of a repeated key, so `"Dana Reyes\nflow:
  // other"` sets a flow the platform never chose. Applied here rather than at the four call
  // sites. ownershipCheck cannot catch it: approve and close pass `via`, and that check returns
  // null on `via`.
  return doc.replace(m[0], () => m[0].replace(line, () => `${field}: ${oneLine(value)}`));
}
/** Set an envelope field, adding it when it is not already there.
 *
 * setEnvelopeField only replaces: it returns the document untouched when the field is absent,
 * and the governance fields are stamped onto documents that have never carried them. The
 * insert goes at the end of the frontmatter block, so `flow` and `type` stay at the top where
 * a reader scans for them. */
export function putEnvelopeField(doc: string, field: string, value: string): string {
  const m = doc.match(ENVELOPE_BLOCK);
  if (!m) return doc;
  if (new RegExp(`^${field}:.*$`, "m").test(m[1])) return setEnvelopeField(doc, field, value);
  const block = m[0].replace(/\n---[ \t]*\n?$/, () => `\n${field}: ${oneLine(value)}\n---\n`);
  return doc.replace(m[0], () => block);
}
