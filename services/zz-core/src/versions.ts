/**
 * A document's history, in the database the tools answer from: `doc` is a document's identity and
 * its status, `doc_revision` is which revisions exist and the content each one retained, and
 * `doc_link` records what a revision cited. This module reads them; every write goes through
 * `saveDocument` in `document-save.ts`, which imports the shared pieces from here.
 *
 * A revision is a snapshot and `revision` is its id, the number every pin names. The number a
 * reader is shown is the snapshot's PUBLIC `version`: several snapshots can share one, when a
 * change with no new cause lands on a row somebody was shown or signed.
 *
 * There is no second half. The team's file store and its git history are retired — phase 6
 * made the rows the record — so a document that exists is a row and a document that does not is
 * a refusal, never a file that failed to be read.
 *
 * DELIBERATE: `doc_revision.body` is the BODY. The schema gives a revision `title`, `body` and
 * `tags` as separate columns, so an envelope living inside `body` would put `title` and `tags`
 * in two homes at once; every writer here writes `documentBody(bytes)`. A read therefore
 * COMPOSES the envelope: the columns, plus the revision's own open payload.
 *
 * DELIBERATE, and this is the whole of `doc_revision.fields`: `envelopePayload` (document-save.ts) is
 * `parseEnvelope(text)` minus `ENVELOPE_COLUMN_KEYS`, so a key a column already carries never
 * enters the payload, and `documentText` filters through the same list before composing so the
 * columns win over the payload on read. A key neither rule can name — `stakeholder`, a flow's own
 * fields such as sdlc's `blocks` and zz-plugin-eval's `eval_run_id`, a source's
 * `stage`/`audits_version` — is what the payload is for. `doc`'s projection deliberately does not
 * carry it: a reader that needs an envelope field goes to the revision. The full disposition, and
 * which keys a flow declares, are in `schema-target/documents.ts` and `004_envelope_fields.sql`.
 *
 * WHERE THE RETIRED COLUMNS WENT, since a reader of this file is the person who needs it: a
 * document's `initiative` and its `flow` are `zz.initiative.slug` and `zz.initiative.flow`; its
 * `outcome` and `closed_by` are keys of the current revision's `fields` payload, which is where
 * `initiative_close` writes them; `approved_by`/`approved_at` are `zz.doc_revision` columns; a
 * document's `evidence` is a key of that payload; and a source's `supports` is a `doc_link` row of
 * kind `supports`, which is the only home that relation has.
 */
import { createHash } from "node:crypto";

import type pg from "pg";

import { renderEnvelope } from "./document-rules.js";
import { DOCUMENT_EVENT_PREFIX } from "./attest.js";
import { platformEvent } from "./indexing.js";
import { db as platformDb } from "./platform-db.js";

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * The revision store: `doc`, `doc_revision` and `doc_link`.
 *
 * The database is the authority. `doc` carries a document's identity and its status; a
 * revision's bytes live in `doc_revision`, one row per revision, and `content_state` says
 * whether they were retained at all — a legacy row whose bytes the store never held says
 * `missing_legacy`, and a read of its body is refused BY NAME rather than answered with an
 * empty string, because "the bytes are gone" and "the document is empty" are different facts.
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

/** A row of `zz.doc`, as the tools read it: the document's own columns, and the two facts that
 *  live on the initiative it is filed under. */
interface DocIdentity {
  id: string;
  initiative: string;
  path: string;
  flow: string;
  type: string;
  status: string;
  /** The close's verdict, on the document that carried it — a key of the current revision's
   *  `fields` payload. The guards read it to know the initiative already closed. */
  outcome: string | null;
  current_revision: number | null;
  approved_revision: number | null;
  /** The public version of the current revision, null exactly when `current_revision` is. */
  current_version: number | null;
  /** How many times the body or editable metadata changed; what `content_revision` binds. `pg`
   *  hands a `bigint` back as text, so it is read as text and counted as a number. */
  content_generation: string;
  updated_at: string | null;
}

/** One row of `zz.doc_revision`, with the two addresses joined from `zz.principal` — the
 *  columns carry an id and a document states an address. */
interface RevisionRecord {
  revision: number;
  /** The public version this snapshot belongs to. */
  version: number;
  content_state: string;
  title: string | null;
  body: string | null;
  tags: string[] | null;
  content_hash: string | null;
  revision_note: string | null;
  /** The envelope's open payload — `stakeholder`, `outcome`, `closed_by` and every field a flow
   *  declares — and null when this revision carries none. `pg` hands a `jsonb` column back as
   *  the parsed value, so this is the map itself rather than text. See this module's header for
   *  the two rules around it. */
  fields: Record<string, string> | null;
  written_by: string | null;
  written_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
}

/** What a read answers with: the document, the revision it read, its text, and the history. */
type Loaded =
  | { ok: true; doc: DocIdentity; rev: RevisionRecord; text: string; history: RevisionRecord[] }
  | { ok: false; why: "no_database" | "missing" | "no_version" | "missing_legacy"; refusal: string };

const TZ = (process.env.ZZ_TZ ?? "").trim() || "Asia/Singapore";

/** The day a timestamp falls on, in the deployment's own timezone. */
export const dayOf = (ts: string | null): string =>
  ts ? new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(ts)) : "";

/** The pool, or null — a deployment with no database is an ordinary answer everywhere here. */
function pool(): pg.Pool | null {
  return platformDb();
}

/** A deployment with no database has no store left: the columns are where a document lives, and
 *  there is no file to fall back to. Said once, for every reader and writer that would otherwise
 *  reach a pool that is not there. */
export const NO_DB = "ERROR: no platform database — the store is the database now, so there is " +
  "nowhere to read or write this document.";

/** Every revision of a document, oldest first, each with the addresses its id columns name. `bodyOf`
 * is the one revision whose TEXT the caller will read: `body` is stored out of line and Postgres
 * detoasts a tuple to return it, so a whole history was detoasted to answer about one.
 * `bodyOfVersion` names it by public version instead, as `snapshotOf` picks one.
 *
 * COUPLED: the subquery's order is `snapshotOf`'s rule — the version's last sealed row, else its
 * last row — so the one body detoasted is the one the reader answers with. */
export async function revisionsOf(
  p: Pick<pg.Pool, "query">, docId: string, bodyOf?: number | null, bodyOfVersion?: number | null,
): Promise<RevisionRecord[]> {
  const { rows } = await p.query<RevisionRecord>(
    `select r.revision, r.version, r.content_state, r.title, r.tags, r.content_hash, r.fields,
            case when r.revision = coalesce($2::int, (
                   select x.revision from zz.doc_revision x
                    where x.doc_id = $1::uuid and x.version = $3::int
                    order by (x.approved_by is not null) desc, x.revision desc limit 1))
                 then r.body end as body,
            r.revision_note, w.email as written_by, r.written_at::text as written_at,
            a.email as approved_by, r.approved_at::text as approved_at
       from zz.doc_revision r
       left join zz.principal w on w.id = r.written_by
       left join zz.principal a on a.id = r.approved_by
      where r.doc_id = $1::uuid
      order by r.revision`, [docId, bodyOf ?? null, bodyOfVersion ?? null]);
  return rows;
}

/** The snapshot a public version is read as: its last approved one when it has one — the bytes a
 *  person signed — else its last. Null when the document has no such version. */
function snapshotOf<R extends { revision: number; version: number; approved_by: string | null }>(
  history: R[], version: number,
): R | null {
  const rows = history.filter((r) => r.version === version);
  return rows.filter((r) => r.approved_by).pop() ?? rows.pop() ?? null;
}

/** One entry per public version, oldest first, each the snapshot `snapshotOf` reads it as. */
export function publicVersions<R extends { revision: number; version: number; approved_by: string | null }>(
  history: R[],
): R[] {
  return [...new Set(history.map((r) => r.version))].sort((a, b) => a - b)
    .map((v) => snapshotOf(history, v)!);
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** The opaque token naming a document's content as it is now: `cr_` and the first 26 characters
 *  of the RFC 4648 lowercase base32, unpadded, of sha256(doc id + ":" + content generation). It
 *  binds the document and the generation, never a row number, so A -> B -> A does not hand A's
 *  old token back. Callers compare it for equality and never parse it. */
export function contentRevision(docId: string, generation: number): string {
  const bytes = createHash("sha256").update(`${docId}:${generation}`, "utf8").digest();
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return `cr_${out.slice(0, 26)}`;
}

/** The `doc` row a store path names, or null.
 *
 * COUPLED: `zz.doc.path` is the path INSIDE the initiative — `spec.md`, `sources/…` — and the
 * initiative is the row it is filed under; the path a tool is handed (`<initiative>/spec.md`)
 * is the two read together. The carry writes it that way and every reader of the row splits it
 * the same way, so a row written with the whole store path is a row nothing can find.
 *
 * A path is not unique on its own — the key is the row's id — so the newest row for it is the
 * one answered with. */
export async function documentAt(
  p: Pick<pg.Pool, "query">, team: string, relPath: string,
): Promise<DocIdentity | null> {
  const { initiative, name } = splitStorePath(relPath);
  const { rows } = await p.query<DocIdentity>(
    `select d.id::text as id, i.slug as initiative, d.path, coalesce(i.flow, '') as flow,
            d.type, d.status, r.fields->>'outcome' as outcome,
            d.current_revision, d.approved_revision, d.current_version,
            d.content_generation::text as content_generation, d.updated_at::text as updated_at
       from zz.doc d
       join zz.initiative i on i.id = d.initiative_id
       join zz.team t on t.id = i.team_id
       left join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision
      where t.slug = $1 and i.slug = $2 and d.path = $3
      order by d.updated_at desc
      limit 1`, [team, initiative, name]);
  return rows[0] ?? null;
}

/** A store path split into the initiative it is under and the name inside it. */
export function splitStorePath(relPath: string): { initiative: string; name: string } {
  const parts = relPath.replace(/^\/+/, "").split("/");
  return { initiative: parts[0] ?? "", name: parts.slice(1).join("/") };
}

/** The envelope keys `doc` and `doc_revision` already carry, which is the list both halves of the
 *  payload rule are computed against — `envelopePayload` subtracts them, `documentText` filters
 *  through them. It is the reader's own keyed set below, which is what makes the two agree by
 *  construction rather than by a comment: `flow`/`type` are the document's (the flow through the
 *  initiative it is filed under), `title`/`tags`/`version`/`updated_at`/`status`/`approved_by`/
 *  `approved_at`/`revision_note` are `doc`'s and the revision's columns rendered back,
 *  `content_revision` is rendered from `doc.content_generation`, and `sources` is joined from the
 *  `cites` links. A key rendered on read and written back by a caller that read it must never
 *  land in the payload, where it would answer stale.
 *
 *  `content_hash`, `doc_id`, `content_state` and `written_by` are columns too and are deliberately
 *  absent: an envelope carries no such key, so listing them would subtract nothing. */
export const ENVELOPE_COLUMN_KEYS: readonly string[] = [
  "flow", "type", "status", "title", "tags", "version", "content_revision",
  "updated_at", "approved_by", "approved_at", "revision_note", "sources",
];

/** The document's text: the body the revision retained, with its envelope composed from the
 *  columns and the revision's own payload.
 *
 * COUPLED: `doc_revision` gives a revision a `title`, a `body` and a `tags` as separate columns
 * (the spec's Data model item 14), and `body` is the BODY — every writer here writes
 * `documentBody(bytes)`. An envelope that also lived inside `body` would put `title` and `tags`
 * in two homes at once, which is the one thing the schema's first goal forbids.
 *
 * THE COLUMNS WIN OVER THE PAYLOAD. The payload is read first and its keys are filtered through
 * `ENVELOPE_COLUMN_KEYS` before anything else is assigned, and the columns are assigned after it —
 * so a payload key that names a column is never read, and a column that carries a value answers
 * over one that does not. Doing it in this order is what makes the guarantee hold for a row the
 * writer never touched: the backfill, a legacy `missing_legacy` neighbour or a hand-edited row
 * cannot put a keyed field into the payload's place. */
function documentText(doc: DocIdentity, rev: RevisionRecord, cites: string[] = []): string {
  const carried = rev.body ?? "";
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(rev.fields ?? {})) {
    if (!ENVELOPE_COLUMN_KEYS.includes(key)) env[key] = value;
  }
  if (doc.flow) env.flow = doc.flow;
  if (doc.type) env.type = doc.type;
  if (rev.title) env.title = rev.title;
  if (rev.tags?.length) env.tags = rev.tags.join(", ");
  env.version = String(rev.version);
  // The current content's token, on the current snapshot alone: an earlier snapshot's own
  // generation is not recorded, and handing it the current one would let a reader of old bytes
  // pass them off as a base for a change to the new ones.
  if (rev.revision === doc.current_revision) {
    env.content_revision = contentRevision(doc.id, Number(doc.content_generation));
  }
  if (rev.written_at) env.updated_at = dayOf(rev.written_at);
  // The status a revision carries: a seal on the revision IS its approval, and the document's
  // own status is the answer for the current revision alone. A revision superseded after an
  // approval reads `approved` because it was; a document revised since reads `draft` although
  // its last approved revision is still filed beside it.
  const status = rev.approved_by
    ? "approved"
    : (rev.revision === doc.current_revision ? doc.status : "draft");
  if (status) env.status = status;
  if (rev.approved_by) env.approved_by = rev.approved_by;
  if (rev.approved_at) env.approved_at = dayOf(rev.approved_at);
  if (rev.revision_note) env.revision_note = rev.revision_note;
  if (cites.length) env.sources = cites.join(", ");
  return `${renderEnvelope(env, ["flow", "type", "title", "tags", "version", "content_revision", "updated_at",
                                 "status", "approved_by", "approved_at", "revision_note"])}\n` +
    carried;
}

/** A revision that retained no bytes refuses a read of its body by name. */
const missingLegacy = (relPath: string, version: number): string =>
  `ERROR: ${relPath} v${version} retained no bytes — the store this came from never held ` +
  "them (`missing_legacy`), so there is nothing to read. That is not an empty document: the " +
  "revision exists and its content is gone. Read the current revision, or another version.";

/** One document as a tool reads it: the row, the snapshot — the current one, or the one public
 *  `version` is read as (`snapshotOf`: its approved snapshot, else its last) — its text, and the
 *  whole history for the caller to state. */
export async function loadDocument(
  team: string, relPath: string, version?: number,
): Promise<Loaded> {
  const p = pool();
  if (!p) return { ok: false, why: "no_database", refusal: NO_DB };
  const doc = await documentAt(p, team, relPath);
  if (!doc) {
    return { ok: false, why: "missing",
             refusal: `ERROR: ${relPath} does not exist` };
  }
  const history = version === undefined
    ? await revisionsOf(p, doc.id, doc.current_revision)
    : await revisionsOf(p, doc.id, null, version);
  const rev = version === undefined
    ? history.find((r) => r.revision === doc.current_revision) ?? null
    : snapshotOf(history, version);
  if (!rev) {
    const filed = [...new Set(history.map((r) => r.version))].map((v) => `v${v}`);
    return { ok: false, why: "no_version",
             refusal: version === undefined
               ? `ERROR: ${relPath} has no current revision recorded.`
               : (filed.length
                   ? `ERROR: \`${relPath}\` has no version ${version}. Filed: ` +
                     `${filed.join(", ")} — ask for one of those, or omit \`version\` for the ` +
                     "current document."
                   : `ERROR: \`${relPath}\` has no version ${version} — no revision of it is ` +
                     "recorded at all.") };
  }
  if (rev.content_state !== "retained") {
    return { ok: false, why: "missing_legacy", refusal: missingLegacy(relPath, rev.version) };
  }
  return { ok: true, doc, rev,
           text: documentText(doc, rev, await citationsOf(p, doc.id, rev.revision)), history };
}

/** Every DOCUMENT the team's store holds, under a folder prefix — `document_list`.
 *
 * Documents, not every row the store addresses: a journal node is a `zz.knowledge_node` row on
 * its own shelf, read by `knowledge_search`, and listing one as a document is what the two
 * subjects were split apart to stop. */
export async function documentPaths(team: string, prefix?: string): Promise<string[]> {
  const p = pool();
  if (!p) return [];
  const { rows } = await p.query<{ initiative: string; path: string }>(
    // The prefix is a store path, and a store path is the initiative and the name inside it read
    // together: `2026-01-01-x` names a whole initiative, `2026-01-01-x/sources` a folder in one.
    // Neither is a prefix of the row's own `path` column, so the two are joined here and matched
    // as the caller wrote them.
    `select i.slug as initiative, d.path from zz.doc d
       join zz.initiative i on i.id = d.initiative_id
       join zz.team t on t.id = i.team_id
      where t.slug = $1
        and ($2::text is null
             or i.slug = $2
             or i.slug || '/' || d.path = $2
             or i.slug || '/' || d.path like $2 || '/%')
      order by i.slug, d.path`,
    [team, prefix ? prefix.replace(/\/+$/, "") : null]);
  return [...new Set(rows.map((r) => `${r.initiative}/${r.path}`))];
}

/** The documents one revision cites, by the path each one is addressed by — the `cites` links
 * a source's `supports` list became. */
async function citationsOf(
  p: Pick<pg.Pool, "query">, docId: string, revision: number,
): Promise<string[]> {
  const { rows } = await p.query<{ initiative: string; path: string }>(
    `select i.slug as initiative, t.path from zz.doc_link l
       join zz.doc t on t.id = l.to_doc_id
       join zz.initiative i on i.id = t.initiative_id
      where l.from_doc_id = $1::uuid and l.from_revision = $2 and l.kind = 'cites'
      order by i.slug, t.path`, [docId, revision]);
  return [...new Set(rows.map((r) => `${r.initiative}/${r.path}`))];
}

/** The principal a seal names, by email or by the name a person carries.
 *
 *  `written_by` and `approved_by` are principal ids, so a name is resolved here rather than handed
 *  to Postgres to fail on a type. `document_approve`'s `on_behalf_of` is a person in words — "the
 *  person whose decision this is, when that is not the caller" — and an approver who writes a
 *  colleague's name rather than their address would otherwise seal nothing. Email first, because it
 *  is the identifier the platform stores; the display name is the fallback for exactly that case. */
export async function principalId(
  p: Pick<pg.Pool, "query">, email: string,
): Promise<string | null> {
  const { rows } = await p.query<{ id: string }>(
    "select id::text as id from zz.principal where lower(email) = lower($1) order by id limit 1",
    [email]);
  if (rows[0]?.id) return rows[0].id;
  const named = await p.query<{ id: string }>(
    "select id::text as id from zz.principal where lower(display_name) = lower($1) order by id limit 1",
    [email]);
  return named.rows[0]?.id ?? null;
}

/** The platform's record of one act, as a `zz.event` row.
 *
 * The activity journal WAS a file beside each initiative's documents; the store is gone, so the
 * entry lands in `zz.event` — the same table `platformEvent` writes and the console reads.
 *
 * DELIBERATE: the store root this used to take is gone from the signature. It addressed the file
 * the entry was appended to, and there is no file; the initiative and the team are resolved from
 * the path and the actor instead.
 *
 * COUPLED: the `kind` is `DOCUMENT_EVENT_PREFIX` + the act, imported from `attest.ts` rather
 * than spelled here — the writer and the reader of this record must agree on it by construction,
 * because `document_approve` is refused by what the reader finds.
 *
 * `document_write`/`document_edit` and the acts name what they did, so a reader asking "what
 * changed this document" reads the tool's own name. */
export function recordAct(relPath: string | null, entry: Record<string, unknown>): void {
  const initiative = relPath?.replace(/^\/+/, "").split("/")[0] || null;
  platformEvent({
    actor: typeof entry.user === "string" ? entry.user : "",
    kind: `${DOCUMENT_EVENT_PREFIX}${typeof entry.action === "string" ? entry.action : "act"}`,
    subject: relPath ?? undefined,
    initiative,
    detail: entry,
  });
}
