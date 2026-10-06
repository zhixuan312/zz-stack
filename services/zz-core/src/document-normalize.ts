/**
 * Normalisation: input the platform can read exactly one way is taken that way and reported, and
 * input it cannot is refused by name — never guessed at, never dropped.
 *
 * Three kinds of input arrive in a shape a caller did not mean to be significant:
 *
 *   - content that opens with a frontmatter envelope — often a document read back and sent whole.
 *     Content's envelope never becomes the stored envelope: its editable keys and a flow's own
 *     fields are taken as the named arguments they stand for, unless a named argument says
 *     otherwise; every key the platform writes or renders is ignored; any other key is refused.
 *     Only the platform renders the envelope.
 *   - tags in another case — lower-cased, then held to the tag rule (`tagRefusal`, paths.ts).
 *   - a reference to a document of the same initiative spelled with `./`, the initiative's own
 *     prefix, or no extension — the canonical spelling taken; one that leaves the initiative refused.
 *
 * DELIBERATE: an envelope is RECOGNISED only when, after any leading blank lines, the content
 * matches the platform's own `ENVELOPE_BLOCK` (LF or CRLF) and every line inside it is a
 * `key: value` line. Anything else that starts with `---` — a Markdown thematic break, a YAML
 * document that is not a key block, SQL — is the body, byte for byte: guessing that a rule or a
 * query was metadata would lose content.
 *
 * Every normalisation is one line of the receipt, so a caller is told what was done with what it
 * sent. Pure: no database, no clock; `checks/document-normalize-rules.ts` holds its table.
 */
import { ENVELOPE_BLOCK, parseEnvelope } from "@zz/contracts";

import { FIELD_NAME, RESERVED_ENVELOPE } from "./document-rules.js";

/** The metadata a write names: the editable envelope keys and a flow's own fields. */
export interface Metadata { title?: string; tags?: string[]; stakeholder?: string; fields?: Record<string, string> }

/** The body to store, the metadata to apply, and one line per normalisation — or every refusal. */
type Normalised = { body: string; metadata: Metadata; normalised: string[] } | { refusals: string[] };

/** The envelope keys a caller may set, each also a named argument of both write tools. */
const EDITABLE = new Set(["title", "tags", "stakeholder"]);

/** A line inside an envelope, keyed as `parseEnvelope` keys one. */
const KEY_LINE = /^[A-Za-z0-9_-]+:/;

/** Blank lines: before an envelope, and between it and the body. */
const BLANK_LINES = /^(?:[ \t]*\r?\n)*/;

/** A same-initiative or other-initiative folder: `<YYYY-MM-DD>-<slug>`. */
const INITIATIVE_SEGMENT = /^\d{4}-\d{2}-\d{2}-/;

/** The envelope content opens with, read as the platform reads one, and the body after it; null
 *  when the content does not open with a recognised envelope.
 *
 *  DELIBERATE: matched on an LF copy, so `ENVELOPE_BLOCK` stays the one spelling of a block, and
 *  cut from the content as sent, so a CRLF body keeps its CRLF. A closing fence must end its line:
 *  `----` is not a fence, and `ENVELOPE_BLOCK`'s optional final newline alone would read it as one. */
function recognise(content: string): { env: Record<string, string>; keys: string[]; body: string } | null {
  const rest = content.slice((BLANK_LINES.exec(content)?.[0] ?? "").length);
  const lf = rest.replace(/\r\n/g, "\n");
  const m = ENVELOPE_BLOCK.exec(lf);
  if (!m || !(m[0].endsWith("\n") || m[0].length === lf.length)) return null;
  const lines = m[1].split("\n");
  if (!lines.every((l) => KEY_LINE.test(l))) return null;
  let at = rest.length;
  if (m[0].endsWith("\n")) {
    at = 0;
    for (let n = (m[0].match(/\n/g) ?? []).length; n > 0; n--) at = rest.indexOf("\n", at) + 1;
  }
  return {
    env: parseEnvelope(m[0]),
    keys: [...new Set(lines.map((l) => l.slice(0, l.indexOf(":"))))],
    body: rest.slice(at).replace(BLANK_LINES, ""),
  };
}

/** Tags in the one case a tag is stored in, each change one line. Trimmed, as every write trims
 *  them; whether what is left is a tag at all is `tagRefusal`'s question. */
export function normalizeTags(tags: string[] | undefined): { tags: string[] | undefined; normalised: string[] } {
  if (tags === undefined) return { tags, normalised: [] };
  const normalised: string[] = [];
  const out = tags.map((t) => {
    const sent = t.trim();
    const lower = sent.toLowerCase();
    if (lower !== sent) normalised.push(`tag "${sent}" lower-cased to "${lower}"`);
    return lower;
  });
  return { tags: out, normalised };
}

/** A body that would open with a recognised envelope, refused; null otherwise. The edit path asks
 *  it of the body an `edits` batch or a `section` makes, and `normalizeContent` of what is left once
 *  the first envelope is taken off: stored, such a body would read back as a second envelope. */
export function bodyEnvelopeRefusal(body: string): string | null {
  if (!recognise(body)) return null;
  return "ERROR: UNSUPPORTED_METADATA — this body would open with a frontmatter envelope (`---`, " +
    "`key: value` lines, `---`), and only the platform writes one. Send `title`, `tags`, " +
    "`stakeholder` and `fields` as named arguments, and the body from its first heading. A " +
    "thematic break — `---` with a blank line after it — is markdown and stays as it is.";
}

/** Content as a write receives it: its envelope separated from its body and read into the
 *  metadata it stands for, every key reported; or every conflicting and unknown key, refused. */
export function normalizeContent(content: string, named: Metadata): Normalised {
  const tagged = normalizeTags(named.tags);
  const metadata: Metadata = {
    ...(named.title !== undefined ? { title: named.title } : {}),
    ...(tagged.tags !== undefined ? { tags: tagged.tags } : {}),
    ...(named.stakeholder !== undefined ? { stakeholder: named.stakeholder } : {}),
    ...(named.fields !== undefined ? { fields: { ...named.fields } } : {}),
  };
  const normalised = [...tagged.normalised];
  const found = recognise(content);
  if (!found) return { body: content, metadata, normalised };

  const refusals: string[] = [];
  const unknown: string[] = [];
  const from = "from the content's envelope";
  for (const key of found.keys) {
    const value = (found.env[key] ?? "").trim();
    const editable = EDITABLE.has(key);
    if (!editable && RESERVED_ENVELOPE.has(key)) {
      normalised.push(`ignored ${key} ${from} — the platform writes it`);
      continue;
    }
    if (!editable && !FIELD_NAME.test(key)) { unknown.push(key); continue; }
    if (!value) { normalised.push(`ignored ${key} ${from} — it is empty`); continue; }
    // The value the named argument gives, the one the envelope gives, and whether they agree.
    let mine: string[] | string;
    let theirs: string[] | string | undefined;
    let arg: string;
    if (key === "tags") {
      const listed = normalizeTags(value.split(",").map((t) => t.trim()).filter(Boolean));
      mine = listed.tags ?? [];
      theirs = tagged.tags;
      arg = "tags";
      if (theirs === undefined) normalised.push(...listed.normalised);
    } else {
      mine = value;
      const fieldKey = editable ? undefined : Object.keys(named.fields ?? {}).find((k) => k.trim() === key);
      theirs = editable ? (named[key as "title" | "stakeholder"]) : fieldKey === undefined ? undefined : named.fields?.[fieldKey];
      arg = editable ? key : `fields.${key}`;
    }
    const spelt = (v: string[] | string): string => (Array.isArray(v) ? v.join(", ") : v.trim());
    const agree = Array.isArray(mine) && Array.isArray(theirs)
      ? mine.length === theirs.length && mine.every((t) => (theirs as string[]).includes(t))
      : theirs !== undefined && spelt(mine) === spelt(theirs);
    if (theirs === undefined) {
      if (key === "tags") metadata.tags = mine as string[];
      else if (editable) metadata[key as "title" | "stakeholder"] = mine as string;
      else metadata.fields = { ...(metadata.fields ?? {}), [key]: mine as string };
      normalised.push(`took ${key} ${from}`);
    } else if (agree) {
      normalised.push(`${key} ${from} agrees with the named argument`);
    } else {
      refusals.push(`ERROR: METADATA_CONFLICT — ${key} is "${spelt(mine)}" in the content's envelope and ` +
        `"${spelt(theirs)}" as the named argument \`${arg}\`. Send one value: the named argument, with ` +
        "the envelope left out of the content.");
    }
  }
  if (unknown.length) {
    refusals.push(`ERROR: UNSUPPORTED_METADATA — the content's envelope carries ` +
      `${unknown.map((k) => JSON.stringify(k)).join(", ")}, which no document records. A flow's own ` +
      "field is lowercase with underscores (`due_date`, not `dueDate`) and is sent in `fields`; send " +
      "the content without the envelope, and each value as the argument it belongs to.");
  }
  const second = bodyEnvelopeRefusal(found.body);
  if (second) refusals.push(second);
  return refusals.length ? { refusals } : { body: found.body, metadata, normalised };
}

/** References to documents of `initiative` — `supports` names, `sources` paths — in their canonical
 *  spelling: no leading `./`, no leading `<initiative>/`, and `.md` when the name has no extension.
 *  Each entry changed is one line. An entry that leaves the initiative — another initiative's
 *  prefix, a `..`, an absolute path — is refused, every one of them at once, `label` naming what
 *  the entry is to the caller: a `sources` entry, or `source_add`'s `supports` entry. */
export function normalizeRefs(
  entries: string[] | undefined, initiative: string, label = "source",
): { refs: string[]; normalised: string[] } | { refusals: string[] } {
  const refs: string[] = [];
  const normalised: string[] = [];
  const refusals: string[] = [];
  const inside = `name a document inside ${initiative}, e.g. \`spec.md\` or \`sources/2026-10-06-call.md\`.`;
  const outside = (sent: string, why: string): string =>
    `ERROR: INVALID_MODE — ${label} "${sent}" must be a path inside the initiative: ${why}; ${inside}`;
  for (const raw of entries ?? []) {
    const sent = raw.trim();
    let ref = sent;
    while (ref.startsWith("./")) ref = ref.slice(2);
    if (ref.startsWith(`${initiative}/`)) ref = ref.slice(initiative.length + 1);
    const segments = ref.split(/[/\\]/);
    if (/^(?:[/\\~]|[A-Za-z]:)/.test(ref)) {
      refusals.push(outside(sent, "it is an absolute path"));
    } else if (segments.includes("..")) {
      refusals.push(outside(sent, "it climbs out with `..`"));
    } else if (segments.length > 1 && INITIATIVE_SEGMENT.test(segments[0])) {
      refusals.push(outside(sent, `it names a document of another initiative, ${segments[0]} — a document ` +
        "cites, and a source supports, its own initiative's documents only"));
    } else {
      if (ref && !/\.[A-Za-z0-9]+$/.test(segments[segments.length - 1])) ref = `${ref}.md`;
      if (ref !== sent) normalised.push(`"${sent}" read as "${ref}"`);
      refs.push(ref);
    }
  }
  return refusals.length ? { refusals } : { refs, normalised };
}
