/**
 * A document's history, in the database the tools answer from: `doc` is a document's identity and
 * its status, `doc_revision` is which revisions exist and the content each one retained, and
 * `doc_link` records what a revision cited. Every write path the tools have goes through
 * `saveDocument` below, so a tool never composes an insert of its own and
 * `doc.title`/`.body`/`.tags`/`.content_hash` — a declared projection of the current revision —
 * cannot be left disagreeing with the revision they project. The other half of a document's
 * history, the `_versions/` copies on disk, is `document-versions.ts`.
 *
 * DELIBERATE: `doc_revision.body` is the BODY. The schema gives a revision `title`, `body` and
 * `tags` as separate columns, so an envelope living inside `body` would put `title` and `tags`
 * in two homes at once; the carry writes `documentBody(bytes)` and so does every writer here. A
 * read therefore COMPOSES the envelope: the columns, plus the revision's own open payload.
 *
 * DELIBERATE, and this is the whole of `doc_revision.fields`: `envelopePayload` below is
 * `parseEnvelope(text)` minus `ENVELOPE_COLUMN_KEYS`, so a key a column already carries never
 * enters the payload, and `documentText` filters through the same list before composing so the
 * columns win over the payload on read. A key neither rule can name — `stakeholder`, a flow's own
 * fields such as sdlc's `blocks` and zz-plugin-eval's `eval_run_id`, a source's
 * `stage`/`audits_version` — is what the payload is for. `doc`'s projection deliberately does not
 * carry it: a reader that needs an envelope field goes to the revision. The full disposition, and
 * which keys a flow declares, are in `schema-target/documents.ts` and `004_envelope_fields.sql`.
 *
 * NOT lost, and not this module's to carry: `outcome`, `closed_by`, `accepted_by` and
 * `no_signoff_reason` are the initiative's own columns (`zz.initiative`, and FR-10 puts them
 * there), and `evidence`/`supports`/`superseded_by` are what the `doc_link` rows record. A
 * revision's envelope is composed from these columns plus the document's.
 *
 * DELIBERATE, and this is I-39's whole residue in `checks/store-unreached.ts`: three call sites
 * in this module and two in `document-parts.ts` still reach the store layer (`persistDocument`
 * and `logActivity`), and they are the bridge, not a second authority. The rows above are what
 * the tools answer from; the mirror keeps the bytes where the readers this task does not own
 * still open them — `review-rounds.ts:139` and `spec-gate.ts:126` read
 * `<initiative>/sources/*.md`, `attest.ts:35` reads `activity.jsonl`, and the guards, the chain
 * and `initiative_status` read documents from disk until Task I-40 moves them. Removing the
 * mirror or the journal append here does not move a reader; it makes those readers answer
 * "nothing" — and it reddens `checks/document-parts.ts:83,100` and
 * `checks/approve-needs-present.ts:39-44`, which assert the journal rows this module writes.
 * Task I-41 retires the layer, and these calls go with it.
 *
 * The FILE half moved to `document-versions.ts` when the envelope's payload took this file past
 * the repository's 700-line ceiling, and this file's subject is now the rows alone. The store on
 * disk is still what the rest of the platform reads — the review and audit rounds, the guards and
 * the activity journal — so `saveDocument` mirrors the bytes it just wrote into the store as well,
 * through the one writer the platform has.
 *
 * COUPLED: writing a snapshot is `persist.ts`'s — snapshotOnApproval copies the approved content
 * to `<initiative>/_versions/<doc>.v<N>.md` the moment status flips. Reading one is
 * `document-versions.ts`'s.
 */
import { closeSync, mkdirSync, openSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

import type pg from "pg";

import { documentBody, parseEnvelope } from "@zz/contracts";

import { chainFor } from "./chain.js";
import { renderEnvelope } from "./document-rules.js";
import { safePath, userRoot } from "./paths.js";
import { logActivity, persistDocument } from "./persist.js";
import { stampEnvelope } from "./write-guards.js";
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

/** A row of `zz.doc`, as the tools read it. */
interface DocIdentity {
  id: string;
  initiative: string;
  path: string;
  flow: string;
  type: string;
  status: string;
  /** The close's verdict, on the document that carried it. A live column until it is retired;
   *  `document_revise` reads it to know the initiative already closed. */
  outcome: string | null;
  current_revision: number | null;
  approved_revision: number | null;
  updated_at: string | null;
}

/** One row of `zz.doc_revision`, with the two addresses joined from `zz.principal` — the
 *  columns carry an id and a document states an address. */
interface RevisionRecord {
  revision: number;
  content_state: string;
  title: string | null;
  body: string | null;
  tags: string[] | null;
  content_hash: string | null;
  revision_note: string | null;
  /** The envelope's open payload — `stakeholder` and every field a flow declares — and null when
   *  this revision carries none. `pg` hands a `jsonb` column back as the parsed value, so this is
   *  the map itself rather than text. See this module's header for the two rules around it. */
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

/** One write, as the tools compose it. Both halves of the store are addressed by it: the rows
 *  below, and the bytes mirrored into the team's store.
 *
 * DELIBERATE: the row's content columns are DERIVED here from `text`, never passed beside it.
 * `doc.title`, `.body`, `.tags` and `.content_hash` are a declared projection of the current
 * revision, and the only way a writer can be sure the two never disagree is for one function to
 * read the other. */
interface DocumentWrite {
  team: string;
  /** The store path — `<initiative>/<document>.md`, or `<initiative>/sources/<name>.md`. */
  relPath: string;
  initiative: string;
  /** The stamped document: what the revision's hash is taken over, what its title and tags are
   *  read off, and what is mirrored into the store. */
  text: string;
  /** Who wrote it, by address. */
  by: string;
  /** The `flow` and `type` the row carries when the envelope states neither — a source, which
   *  no manifest declares. */
  flow?: string;
  type?: string;
  note?: string | null;
  /** What this write is, as the team's own repository records it. It becomes the commit
   *  message there, and a log in which an approval and a typo fix both read "write" cannot
   *  answer what happened between the approval and the close. */
  act?: string;
  /** The approval sealed onto the revision in this same write, when this write IS the
   *  approval or a revision of a closed initiative. */
  seal?: { by: string; at: string } | null;
  /** The revisions this one cites: `doc_link` rows of kind `cites`. */
  cites?: { path: string; revision: number }[];
  /** Whether this write is a new revision of an existing document, or the current one being
   *  rewritten in place (a draft being filled in). */
  mode: "create" | "rewrite" | "append";
}

const TZ = (process.env.ZZ_TZ ?? "").trim() || "Asia/Singapore";

/** The day a timestamp falls on, in the deployment's own timezone. */
export const dayOf = (ts: string | null): string =>
  ts ? new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(ts)) : "";

/** The pool, or null — a deployment with no database is an ordinary answer everywhere here. */
function pool(): pg.Pool | null {
  return platformDb();
}

const NO_DB = "ERROR: no platform database — the store is the database now, so there is " +
  "nowhere to write this document.";

/** Every revision of a document, oldest first, each with the addresses its id columns name. */
export async function revisionsOf(p: Pick<pg.Pool, "query">, docId: string): Promise<RevisionRecord[]> {
  const { rows } = await p.query<RevisionRecord>(
    `select r.revision, r.content_state, r.title, r.body, r.tags, r.content_hash, r.fields,
            r.revision_note, w.email as written_by, r.written_at::text as written_at,
            a.email as approved_by, r.approved_at::text as approved_at
       from zz.doc_revision r
       left join zz.principal w on w.id = r.written_by
       left join zz.principal a on a.id = r.approved_by
      where r.doc_id = $1::uuid
      order by r.revision`, [docId]);
  return rows;
}

/** The `doc` row a store path names, or null.
 *
 * COUPLED: `zz.doc.path` is the path INSIDE the initiative — `spec.md`, `sources/…` — and the
 * initiative is its own column; the store path a tool is handed (`<initiative>/spec.md`) is
 * the two read together. The carry writes it that way and every reader of the row splits it
 * the same way, so a row written with the whole store path is a row nothing can find.
 *
 * A path is not unique on its own — the key is the row's id — so the newest row for it is the
 * one answered with. */
export async function documentAt(
  p: Pick<pg.Pool, "query">, team: string, relPath: string,
): Promise<DocIdentity | null> {
  const { initiative, name } = splitStorePath(relPath);
  const { rows } = await p.query<DocIdentity>(
    `select d.id::text as id, d.initiative, d.path, d.flow, d.type, d.status, d.outcome,
            d.current_revision, d.approved_revision, d.updated_at::text as updated_at
       from zz.doc d
      where d.team_slug = $1 and d.initiative = $2 and d.path = $3
      order by d.updated_at desc
      limit 1`, [team, initiative, name]);
  return rows[0] ?? null;
}

/** A store path split into the initiative it is under and the name inside it. */
function splitStorePath(relPath: string): { initiative: string; name: string } {
  const parts = relPath.replace(/^\/+/, "").split("/");
  return { initiative: parts[0] ?? "", name: parts.slice(1).join("/") };
}

/** The envelope keys `doc` and `doc_revision` already carry, which is the list both halves of the
 *  payload rule are computed against — `envelopePayload` subtracts them, `documentText` filters
 *  through them. It is the reader's own keyed set below, which is what makes the two agree by
 *  construction rather than by a comment: `flow`/`type` are `doc`'s, `title`/`tags`/`version`/
 *  `updated_at`/`status`/`approved_by`/`approved_at`/`revision_note` are the revision's columns
 *  rendered back, and `sources` is joined from the `cites` links.
 *
 *  `content_hash`, `doc_id`, `content_state` and `written_by` are columns too and are deliberately
 *  absent: an envelope carries no such key, so listing them would subtract nothing. */
const ENVELOPE_COLUMN_KEYS: readonly string[] = [
  "flow", "type", "status", "title", "tags", "version",
  "updated_at", "approved_by", "approved_at", "revision_note", "sources",
];

/** The residual: what `parseEnvelope` found that no column of `doc_revision` or `doc` can hold,
 *  or null when the document carries nothing extra. Never a list of FIELDS — the keys a flow
 *  declares are unbounded, which is why the column is a map.
 *
 *  Null rather than `{}` for the empty case: null says "this revision carries no field outside the
 *  columns", and an empty object would be a second spelling of it, which is how a backfill stops
 *  being able to tell "nothing to carry" from "the carry has not run". */
export function envelopePayload(env: Record<string, string>): Record<string, string> | null {
  const payload: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!ENVELOPE_COLUMN_KEYS.includes(key)) payload[key] = value;
  }
  return Object.keys(payload).length ? payload : null;
}

/** The document's text: the body the revision retained, with its envelope composed from the
 *  columns and the revision's own payload.
 *
 * COUPLED: `doc_revision` gives a revision a `title`, a `body` and a `tags` as separate columns
 * (the spec's Data model item 14), and `body` is the BODY — the carry writes `documentBody(bytes)`
 * (`scripts/store-migration.ts:405`) and so does every writer here. An envelope that also lived
 * inside `body` would put `title` and `tags` in two homes at once, which is the one thing the
 * schema's first goal forbids.
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
  env.version = String(rev.revision);
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
  return `${renderEnvelope(env, ["flow", "type", "title", "tags", "version", "updated_at",
                                 "status", "approved_by", "approved_at", "revision_note"])}\n` +
    carried;
}

/** A revision that retained no bytes refuses a read of its body by name. */
const missingLegacy = (relPath: string, revision: number): string =>
  `ERROR: ${relPath} v${revision} retained no bytes — the store this came from never held ` +
  "them (`missing_legacy`), so there is nothing to read. That is not an empty document: the " +
  "revision exists and its content is gone. Read the current revision, or another version.";

/** One document as a tool reads it: the row, the revision — the one asked for, or the current
 *  one — its text, and the whole history for the caller to state.
 *
 * `body: false` reads only the facts, which is what `document_present` needs when what it shows
 * comes from the store on disk. */
export async function loadDocument(
  team: string, relPath: string, revision?: number,
): Promise<Loaded> {
  const p = pool();
  if (!p) return { ok: false, why: "no_database", refusal: NO_DB };
  const doc = await documentAt(p, team, relPath);
  if (!doc) {
    return { ok: false, why: "missing",
             refusal: `ERROR: ${relPath} does not exist` };
  }
  const history = await revisionsOf(p, doc.id);
  const want = revision ?? doc.current_revision;
  const rev = history.find((r) => r.revision === want) ?? null;
  if (!rev) {
    const filed = history.map((r) => `v${r.revision}`);
    return { ok: false, why: "no_version",
             refusal: revision === undefined
               ? `ERROR: ${relPath} has no current revision recorded.`
               : (filed.length
                   ? `ERROR: \`${relPath}\` has no version ${revision}. Filed: ` +
                     `${filed.join(", ")} — ask for one of those, or omit \`version\` for the ` +
                     "current document."
                   : `ERROR: \`${relPath}\` has no version ${revision} — no revision of it is ` +
                     "recorded at all.") };
  }
  if (rev.content_state !== "retained") {
    return { ok: false, why: "missing_legacy", refusal: missingLegacy(relPath, rev.revision) };
  }
  return { ok: true, doc, rev,
           text: documentText(doc, rev, await citationsOf(p, doc.id, rev.revision)), history };
}

/** Every DOCUMENT the team's store holds, under a folder prefix — `document_list`.
 *
 * Documents, not every file the store's layout addresses: a journal node is a
 * `zz.knowledge_node` row on its own shelf, read by `knowledge_search`, and listing one as a
 * document is what the two subjects were split apart to stop. */
export async function documentPaths(team: string, prefix?: string): Promise<string[]> {
  const p = pool();
  if (!p) return [];
  const { rows } = await p.query<{ initiative: string; path: string }>(
    // The prefix is a store path, and a store path is the initiative and the name inside it read
    // together: `2026-01-01-x` names a whole initiative, `2026-01-01-x/sources` a folder in one.
    // Neither is a prefix of the row's own `path` column, so the two are joined here and matched
    // as the caller wrote them.
    `select d.initiative, d.path from zz.doc d
      where d.team_slug = $1
        and ($2::text is null
             or d.initiative = $2
             or d.initiative || '/' || d.path = $2
             or d.initiative || '/' || d.path like $2 || '/%')
      order by d.initiative, d.path`,
    [team, prefix ? prefix.replace(/\/+$/, "") : null]);
  return [...new Set(rows.map((r) => `${r.initiative}/${r.path}`))];
}

/** The documents one revision cites, by the path each one is addressed by — the `cites` links
 *  a source's `supports` list became. */
export async function citationsOf(
  p: Pick<pg.Pool, "query">, docId: string, revision: number,
): Promise<string[]> {
  const { rows } = await p.query<{ initiative: string; path: string }>(
    `select t.initiative, t.path from zz.doc_link l join zz.doc t on t.id = l.to_doc_id
      where l.from_doc_id = $1::uuid and l.from_revision = $2 and l.kind = 'cites'
      order by t.initiative, t.path`, [docId, revision]);
  return [...new Set(rows.map((r) => `${r.initiative}/${r.path}`))];
}

/** The initiative id a slug names inside a team, or null. Resolved THROUGH the team, never by
 *  the slug alone: two teams' initiatives may share a slug. */
async function initiativeIdIn(
  p: Pick<pg.Pool, "query">, team: string, initiative: string,
): Promise<string | null> {
  const { rows } = await p.query<{ id: string }>(
    `select i.id::text as id from zz.initiative i join zz.team t on t.id = i.team_id
      where t.slug = $1 and i.slug = $2`, [team, initiative]);
  return rows[0]?.id ?? null;
}

/** The principal id an address names, or null. `written_by` and `approved_by` are principal
 *  ids, so an address is resolved here rather than handed to Postgres to fail on a type. */
async function principalId(
  p: Pick<pg.Pool, "query">, email: string,
): Promise<string | null> {
  const { rows } = await p.query<{ id: string }>(
    "select id::text as id from zz.principal where lower(email) = lower($1)", [email]);
  return rows[0]?.id ?? null;
}

/** The sha256 of the exact bytes a revision was written from — the same claim the carry makes
 *  of a legacy revision, so one hash describes both. */
function hashBytes(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A document written: its rows in one transaction, and the bytes mirrored into the store.
 *
 * One entry point for every write path the tools have, which is what keeps `doc`'s four
 * projected columns equal to the revision they project: they are written from the same values,
 * in the same statement.
 *
 * DELIBERATE: the rows first, the mirror after. The mirror goes through `persistDocument`, and
 * a store that refused the write (a git failure, a directory that cannot be made) must not cost
 * the row that is now the authority. */
export async function saveDocument(
  w: DocumentWrite,
): Promise<{ id: string; revision: number } | { refusal: string }> {
  const p = pool();
  if (!p) return { refusal: NO_DB };
  const initiativeId = await initiativeIdIn(p, w.team, w.initiative);
  if (!initiativeId) {
    return { refusal:
      `ERROR: there is no initiative "${w.initiative}" in this team's store, so a document ` +
      "cannot be filed under it. `initiative_open` opens one." };
  }
  const writer = await principalId(p, w.by);
  const sealer = w.seal ? await principalId(p, w.seal.by) : null;
  // The document as the platform stamps it. `status`, `version`, `updated_at` and the flow's
  // own `flow`/`type` are the platform's to write — a tool never composes them, and they are
  // what every reader of the store has always seen. The rows hold these bytes, the mirror
  // writes these bytes, and the two are the same bytes.
  const text = await stampedText(w.relPath, w.text);

  // The row's projection, read off the bytes it projects. One read, one set of values: nothing
  // downstream can be handed a title the text does not carry.
  const env = parseEnvelope(text);
  const title = (env.title ?? "").trim()
    || (w.relPath.split("/").pop() ?? "").replace(/\.md$/, "");
  const tags = (env.tags ?? "").replace(/^\[|\]$/g, "").split(",")
    .map((t) => t.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  const flow = env.flow ?? w.flow ?? "";
  const type = env.type ?? w.type ?? "";
  // COUPLED: `doc_revision.body` is the BODY, not the document — the carry writes
  // `documentBody(bytes)` and the schema gives the revision a `title` and a `tags` beside it, so
  // an envelope inside the body would give two of those columns a second home. `zz.doc.body`
  // projects the same value, which is what `body_tsv` is derived from.
  const body = documentBody(text).slice(0, 200_000);
  const hash = hashBytes(text);
  const status = env.status ?? "";
  // THE RESIDUAL, computed here and nowhere else. This is the one write path every tool goes
  // through, so a document written from here on needs no backfill: the payload is stored with the
  // revision it belongs to, from the same parsed envelope the row's projection is read off. See
  // `envelopePayload` for why it is null rather than `{}` when the document carries nothing extra.
  const fields = envelopePayload(env);

  const client = await p.connect();
  const bail = async (refusal: string): Promise<{ refusal: string }> => {
    await client.query("rollback").catch(() => undefined);
    return { refusal };
  };
  try {
    await client.query("begin");
    const existing = await documentAt(client, w.team, w.relPath);
    let id = existing?.id ?? "";
    let revision = 1;
    // The status and the revision agree by construction: `status: approved` is written only
    // with the revision that carries the seal, and `doc_current_revision_required` is what
    // holds the two together.
    const approved = status === "approved" && sealer ? (existing?.current_revision ?? 1) : null;
    if (!existing || w.mode === "create") {
      if (existing) return await bail(`ERROR: ${w.relPath} already exists`);
      // DELIBERATE: no `on conflict`. `doc`'s key is its id, and the three columns the store
      // addressed a document by are no longer unique, so a conflict clause naming them would
      // refuse to prepare at all.
      const ins = await client.query<{ id: string }>(
        `insert into zz.doc (team_slug, initiative, initiative_id, path, flow, type, status,
                             updated_at, body, title, tags, content_hash, current_revision,
                             approved_revision)
         values ($1, $2, $3::uuid, $4, $5, $6, $7, now(), $8, $9, $10::text[], $11, 1, $12)
         returning id::text as id`,
        [w.team, w.initiative, initiativeId, splitStorePath(w.relPath).name, flow, type, status,
         body, title, tags, hash, approved]);
      id = ins.rows[0]?.id ?? "";
      if (!id) return await bail(`ERROR: ${w.relPath} could not be written — no row came back`);
      await insertRevision(client, id, 1, w, title, body, tags, hash, fields, writer, sealer);
    } else if (w.mode === "append") {
      revision = (existing.current_revision ?? 0) + 1;
      // A document revised after an approval is draft again while its last approved revision
      // stays recorded: `approved_revision` moves only when THIS revision is the sealed one.
      const sealed = status === "approved" && sealer ? revision : existing.approved_revision;
      await insertRevision(client, id, revision, w, title, body, tags, hash, fields, writer, sealer);
      await client.query(
        `update zz.doc set current_revision = $2, status = $3, approved_revision = $4,
                            flow = $5, type = $6, updated_at = now(),
                            body = $7, title = $8, tags = $9::text[], content_hash = $10
          where id = $1::uuid`,
        [id, revision, status, sealed, flow, type, body, title, tags, hash]);
    } else {
      // The current revision is rewritten in place: a draft being filled in has no second
      // revision to file, and `document_approve` is the only thing that seals one.
      revision = existing.current_revision ?? 1;
      // DELIBERATE: a sealed revision is not rewritten. `doc_current_revision_required` has no
      // state for "approved at this revision, draft now", and there should not be one — an
      // approver's name stands on the bytes they read. A revision that is sealed is changed by
      // `document_revise`, which files a new revision beside it.
      if (existing.approved_revision === revision && status !== "approved") {
        return await bail(
          `ERROR: ${w.relPath} v${revision} is approved — an approved revision is not ` +
          "rewritten. Call document_revise to file a new revision beside it, which keeps the " +
          "text the person signed.");
      }
      await client.query(
        // COUPLED: `coalesce`, so a rewrite that carries no seal cannot clear one. A revision
        // the platform has sealed is not unsealed by a later write to the bytes beside it.
        //
        // DELIBERATE: `fields` is ASSIGNED, not coalesced, like the body beside it. A rewrite is
        // this revision's new content, and every rewrite reads the document it replaces (whose
        // text carries the payload back out) — so a field the rewrite dropped is a field the
        // document no longer carries, and coalescing would leave it answering from a payload
        // nothing in the bytes backs.
        `update zz.doc_revision set title = $3, body = $4, tags = $5::text[], content_hash = $6,
                                    revision_note = $7, written_by = $8::uuid, written_at = now(),
                                    approved_by = coalesce($9::uuid, approved_by),
                                    approved_at = coalesce($10::timestamptz, approved_at),
                                    fields = $11::jsonb
          where doc_id = $1::uuid and revision = $2`,
        [id, revision, title, body, tags, hash, w.note ?? null, writer,
         sealer, w.seal?.at ?? null, fields]);
      await client.query(
        // COUPLED: `coalesce` here too. The last approved revision stays recorded when this
        // write is not the one sealing it — the state the spec fixes for a document revised
        // after an approval, which is draft again with its approval still on the record.
        `update zz.doc set status = $2, approved_revision = coalesce($3, approved_revision),
                            flow = $4, type = $5, updated_at = now(), body = $6, title = $7,
                            tags = $8::text[], content_hash = $9
          where id = $1::uuid`,
        [id, status, approved, flow, type, body, title, tags, hash]);
    }
    for (const cite of w.cites ?? []) {
      const target = await documentAt(client, w.team, cite.path);
      if (!target) continue;
      // DELIBERATE: `on conflict do nothing`. `doc_link_unique` is NULLS NOT DISTINCT, so a
      // citation recorded twice is one row; re-citing what a revision already cites is not a
      // second fact.
      await client.query(
        `insert into zz.doc_link (from_doc_id, from_revision, to_doc_id, to_revision, kind)
         values ($1::uuid, $2, $3::uuid, $4, 'cites')
         on conflict do nothing`,
        [id, revision, target.id, cite.revision]);
    }
    await client.query("commit");
    await mirrorToStore(w.relPath, text, w.act ?? (w.mode === "append" ? "revise" : "write"));
    return { id, revision };
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    return { refusal: `ERROR: ${w.relPath} could not be written: ` +
      `${err instanceof Error ? err.message : String(err)}` };
  } finally {
    client.release();
  }
}

/** One revision row. `content_state` is always `retained` here: a write that has the bytes is
 *  the one case where they are, and `missing_legacy` is a fact only a legacy store can state.
 *
 *  `fields` is the residual `saveDocument` computed from the same envelope the row's projection
 *  came off — the envelope's open payload, or null when the document carries nothing the columns
 *  do not. `pg` serialises the map to `jsonb` and writes SQL NULL for null. */
async function insertRevision(
  p: Pick<pg.Pool, "query">, docId: string, revision: number, w: DocumentWrite,
  title: string, body: string, tags: string[], hash: string,
  fields: Record<string, string> | null, writer: string | null, sealer: string | null,
): Promise<void> {
  await p.query(
    `insert into zz.doc_revision
       (doc_id, revision, content_state, title, body, tags, content_hash, revision_note,
        written_by, written_at, approved_by, approved_at, fields)
     values ($1::uuid, $2, 'retained', $3, $4, $5::text[], $6, $7, $8::uuid, now(),
             $9::uuid, $10::timestamptz, $11::jsonb)`,
    [docId, revision, title, body, tags, hash, w.note ?? null, writer,
     sealer, w.seal?.at ?? null, fields]);
}

/** The document with the platform's own fields stamped onto it, or the bytes unchanged when the
 *  store is not there to resolve a chain from. `stampEnvelope` is idempotent, so a caller that
 *  already composed an envelope keeps it. */
async function stampedText(relPath: string, text: string): Promise<string> {
  try {
    const root = await userRoot();
    return stampEnvelope(chainFor(root, relPath, text), relPath, text);
  } catch {
    return text;
  }
}

/** The bytes, into the team's store, and the activity entry that says a write happened.
 *
 * COUPLED: this is the last caller of the file store's write path among the tools, and it is
 * here rather than in them for one reason — the rest of the platform still reads documents from
 * disk. The guards, the review and audit rounds, the close checks and `attest.ts` all open the
 * file; a revision written only as rows would be invisible to every one of them. Task I-41
 * removes the layer once those readers have moved, and this function goes with it. */
async function mirrorToStore(relPath: string, text: string, act: string): Promise<void> {
  try {
    const root = await userRoot();
    const target = await safePath(relPath);
    const chain = chainFor(root, relPath, text);
    persistDocument(chain, root, relPath, target, text, act);
  } catch (err) {
    // The rows are the authority; a store that could not be written is reported and does not
    // undo them.
    console.error("store mirror failed:", err);
  }
}

/** Bytes into the team's store that are NOT a document: a journal node, whose row the indexer
 *  derives from the file, and the journal's own log. `claim` makes the filesystem the arbiter —
 *  the node id allocator depends on it — and a path already taken answers `false` rather than
 *  overwriting somebody else's node.
 *
 * COUPLED: like `mirrorToStore`, this is a caller of the file store that exists because the
 * platform's knowledge reader still walks the shelf. Task I-41 removes it with the layer. */
export async function writeStoreFile(
  relPath: string, text: string, act: string, claim = false,
): Promise<boolean> {
  const target = await safePath(relPath);
  mkdirSync(resolve(target, ".."), { recursive: true });
  if (claim) {
    // `wx` through open(), not write: the claim is the filesystem's and it has to happen
    // before the bytes, or a second caller's write lands under the first caller's id.
    try { closeSync(openSync(target, "wx")); } catch { return false; }
  }
  await mirrorToStore(relPath, text, act);
  return true;
}

/** The activity journal's entry for one act, so `attest.ts` can still answer whether a document
 *  was fetched back since it last changed. Kept beside the mirror for the same reason. */
export function recordAct(root: string, relPath: string | null, entry: Record<string, unknown>): void {
  // The same bridge as the mirror below: the tools' acts are recorded where the journal still
  // is. `zz.event` carries them too — every tool also calls `platformEvent` or its successor —
  // so nothing is lost when I-41 takes this away.
  logActivity(root, relPath, entry);
}
