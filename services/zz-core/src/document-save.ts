/**
 * The write path: every row a document write leaves, in one transaction. Every tool that writes a
 * document goes through `saveDocument` below, so a tool never composes an insert of its own and
 * `doc.title`/`.body`/`.tags`/`.content_hash` — a declared projection of the current revision —
 * cannot be left disagreeing with the revision they project. The reads are `versions.ts`.
 *
 * DELIBERATE: every write takes the per-document lock first — `pg_advisory_xact_lock` on the
 * team and the canonical path — an approval, a close and a create included, so writers to one
 * document serialise and an approval shares the boundary a change commits on. A create takes it
 * before it checks the path is absent, which is what makes "absent" mean anything.
 *
 * A write carrying `change` is the change service's: it commits only onto the state it was
 * computed from (`expect`), decides a new row or an in-place rewrite by the pin rule, and commits
 * its captured source, its cause links and its request record with the document. A write without
 * it behaves as it always has (`create`, `append`, `rewrite`), apart from the lock and the two new
 * counters every write keeps true: `current_version` follows `current_revision`, and
 * `content_generation` moves whenever the content identity does.
 *
 * Every write records its act — the `document.<act>` row of `zz.event`. A change carrying
 * `details` writes its row in its own transaction, last, with the complete details its receipt
 * names, and a captured source's row is written there too: the record and what it records commit
 * or roll back together, so a failed insert of either FAILS THE WRITE. Every other write — an
 * approval, a close, an evaluation document — records its act after its commit (`recordAct`). The
 * link, cause and request rows are `document-links.ts`.
 */
import { createHash } from "node:crypto";

import type pg from "pg";

import { documentBody, parseEnvelope } from "@zz/contracts";
import { bodyTsvParams, bodyTsvSql, buildRowVector, inputLimitRefusal } from "@zz/indexing";

import { DOCUMENT_EVENT_PREFIX } from "./attest.js";
import { chainFor } from "./chain.js";
import {
  type Cause, insertCauses, insertLinks, recordRequest, REQUEST_ID_CONFLICT, type RequestRecord, storedRequest,
} from "./document-links.js";
import { RESERVED_ENVELOPE } from "./document-rules.js";
import { insertEvent } from "./indexing.js";
import { stampEnvelope } from "./write-guards.js";
import { db as platformDb } from "./platform-db.js";
import { ENVELOPE_COLUMN_KEYS, NO_DB, contentRevision, principalId, recordAct, splitStorePath } from "./versions.js";

/** What a change service adds to a write: the state it computed from, and what commits with it. */
interface DocumentChange {
  /** A new public version: a cause new to the current version was named, captured or owed. */
  nextVersion: boolean;
  /** The state the change was computed from, as `documentState` read it. Absent only on a create,
   *  which has no state to compare: a change naming none never lands on an existing document. */
  expect?: DocumentState;
  /** The content generation the caller's `base` token named, when it sent one. */
  base?: number;
  /** A source captured from the caller's words, filed as its own document first, under the first
   *  free name of its path's stem (`reserveName`); a cause naming `relPath` names the one filed. */
  captured?: { relPath: string; text: string };
  /** The causes this change records: `cites` links from the resulting row, with their origin. */
  causes?: Cause[];
  /** The caller's request key, recorded with the change so a retry replays the receipt. */
  request?: RequestRecord;
  /** The change's complete details, carried on its own event row as `detail.details_ref` and
   *  `detail.details`: what a receipt names when its lists were cut. */
  details?: { ref: string; text: string };
}

/** One write, as the tools compose it. */
interface DocumentWrite {
  team: string;
  /** The document's address — `<initiative>/<document>.md`, or `<initiative>/sources/<name>.md`. */
  relPath: string;
  initiative: string;
  /** The stamped document: what the revision's hash is taken over, what its title and tags are
   *  read off, and what the current revision retains. */
  text: string;
  /** Who wrote it, by address. */
  by: string;
  /** The `flow` and `type` the row carries when the envelope states neither — a source, which
   *  no manifest declares. */
  flow?: string;
  type?: string;
  note?: string | null;
  /** What this write is, as the platform records it: the `kind` of the event row the write
   *  leaves behind. A log in which an approval and a typo fix both read "write" cannot answer
   *  what happened between the approval and the close. */
  act?: string;
  /** The approval sealed onto the revision in this same write, when this write IS the
   *  approval or a revision of a closed initiative. */
  seal?: { by: string; at: string } | null;
  /** The revisions this one cites: `doc_link` rows of kind `cites`. */
  cites?: { path: string; revision: number }[];
  /**
   * The documents this revision bears on: `doc_link` rows of kind `supports`, pinned to this
   * revision at one end and to the target document's IDENTITY at the other — `to_revision` is null
   * by the table's own CHECK.
   *
   * DELIBERATE, and the pair is two facts rather than one spelled twice: a citation names an exact
   * revision this one read, and a support names a document the source was written for, which
   * outlives every revision of it.
   */
  supports?: string[];
  /** Whether this write is a new revision of an existing document, or the current one being
   *  rewritten in place (a draft being filled in). Without `change` the version follows the mode:
   *  `create` stores version 1, `append` the current version + 1, and `rewrite` keeps the row's
   *  version. With `change`, only `create` is read: the rest is decided by `nextVersion` and the
   *  pin rule. */
  mode: "create" | "rewrite" | "append";
  /** For a write without `change` — an approval, a close — the state its caller read. A write
   *  whose document moved since is refused with `ERROR: STATE_CHANGED`, so an act decided on what
   *  a person was shown never lands on an edit committed after it. */
  expect?: DocumentState;
  change?: DocumentChange;
  /** The id a create files the document under, chosen by its caller so the receipt it records can
   *  name the document's content revision before the commit. */
  id?: string;
  /** The close this write records on the initiative's anchor row, in the document's own
   *  transaction: after the lock and the state compare, so a moved document, a refused write or a
   *  concurrent close commits neither the row nor the document. */
  closeAnchor?: CloseAnchor;
  /** A create only: file the document under the first free name of its path's stem —
   *  `<stem>.md`, `<stem>-2.md`, … — chosen under the lock, rather than refusing a taken name. */
  reserveName?: boolean;
}

/** What `initiative_close` records on `zz.initiative`. */
interface CloseAnchor {
  outcome: string;
  /** The closer, by address; a principal that is not active records no `closed_by`. */
  closedBy: string;
  acceptedBy: string | null;
  noSignoffReason: string | null;
}

/** The refusal a write answers when its `expect` no longer holds; `document_approve` and
 *  `initiative_close` recognise it by this prefix. */
export const STATE_CHANGED = "ERROR: STATE_CHANGED";

/** A create on a path that already names a document. */
export const targetExists = (relPath: string): string =>
  `ERROR: TARGET_EXISTS — ${relPath} exists; change it with document_edit`;

/** The three facts every write moves at least one of: an edit moves the generation, and every
 *  write — an approval and a close included — files a new row or stamps `written_at`. */
interface DocumentState { generation: number; revision: number; writtenAt: string }

interface Saved {
  id: string; revision: number; version: number; generation: number;
  newVersion: boolean; newRow: boolean;
  /** The path a `reserveName` create was filed under. */
  reserved?: string;
  /** The path a change's captured source was filed under. */
  capturedPath?: string;
}

/** A write sent back because the state moved and no stale `base` makes it a conflict. */
interface Retry { retry: true }
interface Replayed { replayed: Record<string, unknown> }

/** The pool, or null — a deployment with no database is an ordinary answer everywhere here. */
function pool(): pg.Pool | null {
  return platformDb();
}

/** The sha256 of the exact bytes a revision was written from — the same claim the carry makes
 *  of a legacy revision, so one hash describes both. */
function hashBytes(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The document with the platform's own fields stamped onto it. `stampEnvelope` is idempotent,
 *  so a caller that already composed an envelope keeps it.
 *
 *  The chain comes from the bytes' own `flow:` and, failing that, from the initiative's row —
 *  which is the window a first document is written in. */
async function stampedText(
  p: pg.Pool, team: string, relPath: string, text: string,
): Promise<string> {
  return stampEnvelope(await chainFor(p, team, relPath, text), relPath, text);
}

/** The residual: what `parseEnvelope` found that no column of `doc_revision` or `doc` can hold,
 *  or null when the document carries nothing extra. Null rather than `{}`: null says "this
 *  revision carries no field outside the columns", and an empty object would be a second spelling
 *  of the same fact. The columns win over it on read (`documentText`, versions.ts). */
function envelopePayload(env: Record<string, string>): Record<string, string> | null {
  const payload: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!ENVELOPE_COLUMN_KEYS.includes(key)) payload[key] = value;
  }
  return Object.keys(payload).length ? payload : null;
}

/** The values a revision stores, read off its text: one read, one set of values. */
function projection(text: string, relPath: string) {
  const env = parseEnvelope(text);
  const title = (env.title ?? "").trim()
    || (relPath.split("/").pop() ?? "").replace(/\.md$/, "");
  const tags = (env.tags ?? "").replace(/^\[|\]$/g, "").split(",")
    .map((t) => t.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  // DELIBERATE: the whole body, never a prefix (checks/document-body-whole.ts). The one bound is
  // `buildRowVector`'s, and it refuses rather than shortens.
  return { env, title, tags, body: documentBody(text), fields: envelopePayload(env) };
}

/** The content identity of stored values: the body and the editable metadata — title, tags,
 *  `stakeholder` and every field a flow declares — and nothing the platform stamps. An approval,
 *  a close or a re-stamp of `updated_at` leaves it, which is what keeps them from moving the
 *  content generation. */
function identityOf(c: { body: string; title: string; tags: string[]; fields: Record<string, string> | null }): string {
  const f = c.fields ?? {};
  const open = Object.keys(f).filter((k) => !RESERVED_ENVELOPE.has(k)).sort();
  return hashBytes([c.body, c.title, [...c.tags].sort().join(","), f.stakeholder ?? "",
                    JSON.stringify(Object.fromEntries(open.map((k) => [k, f[k]])))].join("\u0000"));
}

/** The content identity of a document's text, by the same rule `saveDocument` compares stored
 *  values with: what a change service asks to tell a change from `no_change` before it writes. */
export function contentIdentity(text: string, relPath: string): string {
  return identityOf(projection(text, relPath));
}

/** A write, prepared outside the transaction: the stamped text and every value its rows take. */
type Prepared = ReturnType<typeof projection> & {
  text: string; type: string; hash: string; status: string; identity: string;
  analyzer: string; tsv: unknown[];
};

async function prepare(p: pg.Pool, w: DocumentWrite): Promise<Prepared | { refusal: string }> {
  // `status`, `version`, `updated_at` and the flow's own `flow`/`type` are the platform's to
  // write — a tool never composes them. The rows hold these bytes.
  const text = await stampedText(p, w.team, w.relPath, w.text);
  const v = projection(text, w.relPath);
  let vector: ReturnType<typeof buildRowVector>;
  try {
    vector = buildRowVector({ title: v.title, tags: v.tags, body: v.body });
  } catch (err) {
    const refusal = inputLimitRefusal(w.relPath, err);
    if (refusal) return { refusal };
    throw err;
  }
  return { ...v, text, type: v.env.type ?? w.type ?? "", hash: hashBytes(text),
           status: v.env.status ?? "", identity: identityOf(v), analyzer: vector.analyzer,
           tsv: bodyTsvParams(vector) };
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

/** The per-document lock, held to the end of the transaction. */
async function lockPath(c: Pick<pg.Pool, "query">, team: string, relPath: string): Promise<void> {
  await c.query("select pg_advisory_xact_lock(hashtext($1))", [`doc:${team}/${relPath}`]);
}

/** The first free name of a path's stem — `<stem>.md`, `<stem>-2.md`, … — with its lock held.
 *
 *  DELIBERATE: the stem's lock first, so two reservations of one stem serialise and the second
 *  sees the first's row; then the chosen path's, which a create of that exact name also takes, and
 *  the name is looked at again under it. A probe outside the lock let two writers pick one name. */
async function reservePath(c: Pick<pg.Pool, "query">, team: string, relPath: string): Promise<string> {
  const stem = relPath.replace(/\.md$/, "");
  await lockPath(c, team, stem);
  for (let n = 1; ; n++) {
    const rel = n === 1 ? `${stem}.md` : `${stem}-${n}.md`;
    if (await currentRow(c, team, rel)) continue;
    await lockPath(c, team, rel);
    if (!(await currentRow(c, team, rel))) return rel;
  }
}

/** The document's state, as a change service reads it before computing, and as `saveDocument`
 *  compares it under the lock. Null when the document does not exist. */
export async function documentState(
  p: Pick<pg.Pool, "query">, team: string, relPath: string,
): Promise<DocumentState | null> {
  const cur = await currentRow(p, team, relPath);
  return cur ? stateOf(cur) : null;
}

interface CurrentRow {
  id: string; status: string; current_revision: number | null; approved_revision: number | null;
  generation: string; version: number | null; written_at: string | null;
  title: string | null; body: string | null; tags: string[] | null; fields: Record<string, string> | null;
  pinned: boolean;
}

const stateOf = (c: CurrentRow): DocumentState =>
  ({ generation: Number(c.generation), revision: c.current_revision ?? 0, writtenAt: c.written_at ?? "" });

/** The document a store path names and its current row, with the pin rule's answer.
 *
 * PINNED is the rule a change obeys: a row somebody was shown or signed is never rewritten. Shown
 * means `presented_at` set, or a `document.shown`/`document.shown_part` event for this document at
 * or after the row's write; signed means sealed, or the document's approved revision — a seal whose
 * person resolved to no principal leaves the row's columns null and the approval stands. */
async function currentRow(
  p: Pick<pg.Pool, "query">, team: string, relPath: string,
): Promise<CurrentRow | null> {
  const { initiative, name } = splitStorePath(relPath);
  const { rows } = await p.query<CurrentRow>(
    `select d.id::text as id, d.status, d.current_revision, d.approved_revision,
            d.content_generation::text as generation, r.version, r.written_at::text as written_at,
            r.title, r.body, r.tags, r.fields,
            (r.approved_by is not null or d.approved_revision = d.current_revision
             or r.presented_at is not null
             or exists (select 1 from zz.event e
                         where e.initiative_id = d.initiative_id and e.subject = $4
                           and e.kind in ('document.shown', 'document.shown_part')
                           and e.ts >= r.written_at)) as pinned
       from zz.doc d
       join zz.initiative i on i.id = d.initiative_id
       join zz.team t on t.id = i.team_id
       left join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision
      where t.slug = $1 and i.slug = $2 and d.path = $3
      order by d.updated_at desc
      limit 1`, [team, initiative, name, relPath]);
  return rows[0] ?? null;
}

/** What a write answers: the rows it left, a refusal, or — only for a write carrying `change` —
 *  a retry or a replayed receipt. */
type SaveAnswer = Saved | { refusal: string } | Retry | Replayed;

/** A document written: its rows in one transaction. See the module header.
 *
 * COUPLED: the signature names its return type by alias. `scripts/gate/checks/data-telemetry.ts`
 * lifts this body by brace-matching from `function saveDocument(`, and an inline object type in
 * the signature (or an overload) is a brace it would take for the body. */
export async function saveDocument(w: DocumentWrite): Promise<SaveAnswer> {
  const p = pool();
  if (!p) return { refusal: NO_DB };
  const initiativeId = await initiativeIdIn(p, w.team, w.initiative);
  if (!initiativeId) {
    return { refusal:
      `ERROR: there is no initiative "${w.initiative}" in this team's store, so a document ` +
      "cannot be filed under it. `initiative_open` opens one." };
  }
  const change = w.change;
  const writer = await principalId(p, w.by);
  // DELIBERATE: resolved as a PAIR with `approved_at`, never on its own.
  // `doc_revision_approval_paired` holds that `approved_by` is null exactly when `approved_at` is,
  // and a seal whose person resolves to no principal is a real case — `document_approve`'s
  // `on_behalf_of` names a person in words. A seal lands only when BOTH halves resolved; otherwise
  // the approval is recorded by the envelope and by `approved_revision`, never half-stamped.
  const sealAt = w.seal ? (w.seal.at && w.seal.at.length > 0 ? w.seal.at : null) : null;
  const sealBy = w.seal ? await principalId(p, w.seal.by) : null;
  const seal = sealBy && sealAt ? { by: sealBy, at: sealAt } : null;
  const asker = change?.request ? await principalId(p, change.request.principalEmail) : null;
  if (change?.request && !asker) {
    return { refusal: `ERROR: ${change.request.principalEmail} is no principal this platform knows, ` +
                      "so a request_id cannot be recorded for it." };
  }
  let prep = await prepare(p, w);
  if ("refusal" in prep) return prep;
  let capturedWrite: DocumentWrite | null = change?.captured ? capturedSource(w, change.captured.relPath, change.captured.text) : null;
  let cap = capturedWrite ? await prepare(p, capturedWrite) : null;
  if (cap && "refusal" in cap) return cap;
  let causes = change?.causes ?? [];

  const client = await p.connect();
  const bail = async <T>(answer: T): Promise<T> => {
    await client.query("rollback").catch(() => undefined);
    return answer;
  };
  try {
    await client.query("begin");
    const reserve = w.reserveName === true && w.mode === "create";
    if (reserve) {
      const rel = await reservePath(client, w.team, w.relPath);
      if (rel !== w.relPath) {
        // The bytes are stamped for the name they are filed under.
        w = { ...w, relPath: rel };
        prep = await prepare(p, w);
        if ("refusal" in prep) return await bail(prep);
      }
    } else {
      await lockPath(client, w.team, w.relPath);
    }
    if (change?.request) {
      const stored = await storedRequest(client, w.team, asker!, change.request);
      if (stored) return await bail(stored);
    }
    const existing = await currentRow(client, w.team, w.relPath);
    let id = existing?.id ?? "";
    let revision = 1;
    let version = 1;
    let generation = existing ? Number(existing.generation) : 0;
    let mode: "create" | "rewrite" | "append" | "pinned" = "create";
    if (existing && w.mode !== "create") {
      // The compare-and-swap: a write commits only onto the state it was computed from.
      const now = stateOf(existing);
      const moved = (e: DocumentState): boolean =>
        now.generation !== e.generation || now.revision !== e.revision || now.writtenAt !== e.writtenAt;
      if (!change && w.expect && moved(w.expect)) {
        return await bail({ refusal:
          `${STATE_CHANGED} — ${w.relPath} changed after it was read (now revision ` +
          `${now.revision}, content revision ${contentRevision(existing.id, now.generation)}); read ` +
          "it again and decide on what it says now." });
      }
      if (change) {
        if (!change.expect || moved(change.expect)) {
          if (change.base !== undefined && change.base !== now.generation) {
            return await bail({ refusal:
              `ERROR: BASE_CONFLICT — ${w.relPath} is at content revision ` +
              `${contentRevision(existing.id, now.generation)} now, not the one \`base\` names; read it ` +
              "again and apply the change to what it says now." });
          }
          return await bail({ retry: true as const });
        }
      }
      const same = prep.identity === identityOf({ body: existing.body ?? "", title: existing.title ?? "",
                                                   tags: existing.tags ?? [], fields: existing.fields });
      revision = existing.current_revision ?? 1;
      version = existing.version ?? revision;
      if (change && same) {
        // A keyed no-change: nothing about the document moves, and the request is what is kept —
        // with the act row its receipt's `details_ref` names, when it carries details.
        if (change.request) await recordRequest(client, w.team, asker!, id, change.request);
        if (change.details) {
          const action = w.act ?? "write";
          const recorded = await insertEvent(client, {
            actor: w.by, team: w.team, initiative: splitStorePath(w.relPath).initiative || null,
            kind: `${DOCUMENT_EVENT_PREFIX}${action}`, subject: w.relPath,
            detail: { user: w.by, action, path: w.relPath, details_ref: change.details.ref, details: change.details.text } });
          if (!recorded.ok) return await bail({ refusal: `ERROR: ${w.relPath} could not be written: ${recorded.error}` });
        }
        await client.query("commit");
        return { id, revision, version, generation, newVersion: false, newRow: false };
      }
      if (!same) generation += 1;
      mode = change
        ? (change.nextVersion ? "append" : existing.pinned ? "pinned" : "rewrite")
        : (w.mode === "append" ? "append" : "rewrite");
    } else if (existing) {
      // A source is immutable and has no change to send instead; every other document has one.
      return await bail({ refusal: w.act === "source" ? `ERROR: ${w.relPath} already exists`
                                                      : targetExists(w.relPath) });
    }

    // The close, on the anchor row, once the document it is recorded on is known not to have
    // moved. Guarded on `closed_at is null`: the row, not the caller's earlier read, is what a
    // second concurrent close is refused by, and the refusal rolls the document back with it.
    if (w.closeAnchor) {
      const a = w.closeAnchor;
      const { rowCount } = await client.query(
        `update zz.initiative set closed_at = now(), outcome = $2,
                closed_by = (select id from zz.principal where email = $3 and status = 'active'),
                accepted_by = $4, no_signoff_reason = $5
          where id = $1::uuid and closed_at is null`,
        [initiativeId, a.outcome, a.closedBy, a.acceptedBy, a.noSignoffReason]);
      if (!rowCount) {
        return await bail({ refusal:
          `ERROR: ${w.initiative} was closed on its own anchor row by a concurrent call — the ` +
          "document was not written. Call initiative_status to see how it closed." });
      }
    }

    // A captured source is filed first, as its own document under its own lock, so the target's
    // cause link — and, on a create, the waiting-supports insert below — find it.
    if (capturedWrite && cap && !("refusal" in cap)) {
      const asked = capturedWrite.relPath;
      const rel = await reservePath(client, w.team, asked);
      if (rel !== asked) {
        capturedWrite = { ...capturedWrite, relPath: rel };
        cap = await prepare(p, capturedWrite);
        if ("refusal" in cap) return await bail(cap);
        causes = causes.map((k) => (k.path === asked ? { ...k, path: rel } : k));
      }
      const capturedId = await createRows(client, capturedWrite, cap, initiativeId, writer, null);
      if (!capturedId) return await bail({ refusal: `ERROR: ${capturedWrite.relPath} could not be written — no row came back` });
      await insertLinks(client, w.team, capturedId, 1, capturedWrite);
    }

    if (mode === "create") {
      id = await createRows(client, w, prep, initiativeId, writer, seal);
      if (!id) return await bail({ refusal: `ERROR: ${w.relPath} could not be written — no row came back` });
    } else if (mode === "append" || mode === "pinned") {
      const from = revision;
      revision += 1;
      if (mode === "append") version += 1;
      // A document changed after an approval is draft again while its last approved revision
      // stays recorded: `approved_revision` moves only when THIS revision is the sealed one.
      const sealed = prep.status === "approved" ? revision : existing!.approved_revision;
      await insertRevision(client, id, revision, version, w, prep, writer, seal);
      await client.query(
        `update zz.doc set current_revision = $2, status = $3, approved_revision = $4,
                            type = $5, updated_at = now(), body = $6, title = $7,
                            tags = $8::text[], content_hash = $9, analyzer_version = $10,
                            body_tsv = ${bodyTsvSql(11)}, current_version = $19,
                            content_generation = $20
          where id = $1::uuid`,
        [id, revision, prep.status, sealed, prep.type, prep.body, prep.title, prep.tags, prep.hash,
         prep.analyzer, ...prep.tsv, version, generation]);
      // The same version's causes go with it to the new snapshot: a cause is attributed to a
      // public version, not to the row that happened to carry it.
      if (mode === "pinned") {
        await client.query(
          `insert into zz.doc_link (from_doc_id, from_revision, to_doc_id, to_revision, kind, linked_by)
           select l.from_doc_id, $2, l.to_doc_id, l.to_revision, l.kind, l.linked_by
             from zz.doc_link l
            where l.from_doc_id = $1::uuid and l.from_revision = $3 and l.kind = 'cites'
           on conflict do nothing`, [id, revision, from]);
      }
    } else {
      // The current revision is rewritten in place: a draft being filled in has no second
      // revision to file, and `document_approve` is the only thing that seals one.
      //
      // DELIBERATE: a sealed revision is not rewritten. `doc_current_revision_required` has no
      // state for "approved at this revision, draft now", and an approver's name stands on the
      // bytes they read. A change never reaches here with one: the pin rule files a new row.
      if (existing!.approved_revision === revision && prep.status !== "approved") {
        return await bail({ refusal:
          `ERROR: ${w.relPath} v${version} is approved — an approved revision is not ` +
          "rewritten. Change it with document_edit, which files the change beside it and keeps " +
          "the text the person signed." });
      }
      const approved = prep.status === "approved" ? revision : null;
      await client.query(
        // COUPLED: `coalesce`, so a rewrite that carries no seal cannot clear one.
        //
        // DELIBERATE: `fields` is ASSIGNED, not coalesced, like the body beside it. Every rewrite
        // reads the document it replaces, so a field the rewrite dropped is a field the document
        // no longer carries.
        `update zz.doc_revision set title = $3, body = $4, tags = $5::text[], content_hash = $6,
                                    revision_note = $7, written_by = $8::uuid, written_at = now(),
                                    approved_by = coalesce($9::uuid, approved_by),
                                    approved_at = coalesce($10::timestamptz, approved_at),
                                    fields = $11::jsonb
          where doc_id = $1::uuid and revision = $2`,
        [id, revision, prep.title, prep.body, prep.tags, prep.hash, w.note ?? null, writer,
         seal?.by ?? null, seal?.at ?? null, prep.fields]);
      await client.query(
        // COUPLED: `coalesce` here too. The last approved revision stays recorded when this
        // write is not the one sealing it.
        `update zz.doc set status = $2, approved_revision = coalesce($3, approved_revision),
                            type = $4, updated_at = now(), body = $5, title = $6,
                            tags = $7::text[], content_hash = $8, analyzer_version = $9,
                            body_tsv = ${bodyTsvSql(10)}, content_generation = $18
          where id = $1::uuid`,
        [id, prep.status, approved, prep.type, prep.body, prep.title, prep.tags, prep.hash,
         prep.analyzer, ...prep.tsv, generation]);
    }
    await insertLinks(client, w.team, id, revision, w);
    if (causes.length) {
      const missing = await insertCauses(client, w.team, id, revision, causes);
      if (missing) {
        return await bail({ refusal:
          `ERROR: ${missing} is not a document in this team's store, so it cannot be recorded as a ` +
          `cause of ${w.relPath}; nothing was written.` });
      }
    }
    if (change?.request && !(await recordRequest(client, w.team, asker!, id, change.request))) {
      // The key was taken between the lookup and here — by a request on another path's lock.
      await bail(null);
      return (await storedRequest(p, w.team, asker!, change.request)) ?? { refusal: REQUEST_ID_CONFLICT };
    }
    // The acts recorded in the transaction, last: a captured source's, and the document's own when
    // the change carries details — the row its receipt's `details_ref` names, which must be there
    // the moment the receipt is. DELIBERATE: a failed insert refuses the write; a details reference
    // to a row that never landed is the dangling receipt this exists to prevent.
    const action = w.act ?? (mode === "append" ? "revise" : "write");
    const details = change?.details;
    const acts = [...(capturedWrite ? [{ path: capturedWrite.relPath, action: "source", extra: {} }] : []),
                  ...(details ? [{ path: w.relPath, action, extra: { details_ref: details.ref, details: details.text } }] : [])];
    for (const a of acts) {
      const recorded = await insertEvent(client, {
        actor: w.by, team: w.team, initiative: splitStorePath(a.path).initiative || null,
        kind: `${DOCUMENT_EVENT_PREFIX}${a.action}`, subject: a.path,
        detail: { user: w.by, action: a.action, path: a.path, ...a.extra } });
      if (!recorded.ok) return await bail({ refusal: `ERROR: ${w.relPath} could not be written: ${recorded.error}` });
    }
    await client.query("commit");
    // Every other write's act, after its commit.
    if (!details) recordAct(w.relPath, { user: w.by, action, path: w.relPath });
    return { id, revision, version, generation, newVersion: mode === "create" || mode === "append",
             newRow: mode !== "rewrite", ...(reserve ? { reserved: w.relPath } : {}),
             ...(capturedWrite ? { capturedPath: capturedWrite.relPath } : {}) };
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    return { refusal: `ERROR: ${w.relPath} could not be written: ` +
      `${err instanceof Error ? err.message : String(err)}` };
  } finally {
    client.release();
  }
}

/** The write a captured source is filed with: a source in the target's initiative, typed by the
 *  stage it records when it names one, supporting what its envelope declares. */
function capturedSource(w: DocumentWrite, relPath: string, text: string): DocumentWrite {
  const env = parseEnvelope(text);
  const initiative = splitStorePath(relPath).initiative;
  const supports = (env.supports ?? "").split(",").map((s) => s.trim()).filter(Boolean)
    .map((name) => `${initiative}/${name}`);
  return { team: w.team, relPath, initiative, text, by: w.by, flow: "", type: env.stage ?? "source",
           supports, mode: "create", act: "source" };
}

/** A new document: its `doc` row and revision 1, version 1, and the supports that were waiting. */
async function createRows(
  client: Pick<pg.Pool, "query">, w: DocumentWrite, prep: Prepared, initiativeId: string,
  writer: string | null, seal: { by: string; at: string } | null,
): Promise<string> {
  // DELIBERATE: the condition is the APPROVAL, not the resolved principal: `status: approved` is
  // true exactly when `approved_revision` is the current revision.
  const approved = prep.status === "approved" ? 1 : null;
  // DELIBERATE: no `on conflict`. `doc`'s key is its id, and the path is not unique on its own.
  const ins = await client.query<{ id: string }>(
    `insert into zz.doc (initiative_id, path, type, status, updated_at, body, title, tags,
                         content_hash, analyzer_version, body_tsv, current_revision,
                         approved_revision, current_version, id)
     values ($1::uuid, $2, $3, $4, now(), $5, $6, $7::text[], $8, $9,
             ${bodyTsvSql(10)}, 1, $18, 1, coalesce($19::uuid, gen_random_uuid()))
     returning id::text as id`,
    [initiativeId, splitStorePath(w.relPath).name, prep.type, prep.status, prep.body, prep.title,
     prep.tags, prep.hash, prep.analyzer, ...prep.tsv, approved, w.id ?? null]);
  const id = ins.rows[0]?.id ?? "";
  if (!id) return "";
  await insertRevision(client, id, 1, 1, w, prep, writer, seal);
  // The supports that were waiting for this document. A source that named it before it existed
  // filed no link — `doc_link` needs a row to point at — and kept the name in its envelope's
  // `supports`; the link lands now, the moment there is a row.
  await client.query(
    `insert into zz.doc_link (from_doc_id, from_revision, to_doc_id, to_revision, kind)
     select s.id, s.current_revision, $1::uuid, null, 'supports'
       from zz.doc s
       join zz.doc_revision r on r.doc_id = s.id and r.revision = s.current_revision
      where s.initiative_id = $2::uuid and s.id <> $1::uuid and s.path like 'sources/%'
        and $3 = any(string_to_array(replace(coalesce(r.fields->>'supports', ''), ' ', ''), ','))
     on conflict do nothing`,
    [id, initiativeId, splitStorePath(w.relPath).name]);
  return id;
}

/** One revision row. `content_state` is always `retained` here: a write that has the bytes is
 *  the one case where they are, and `missing_legacy` is a fact only a legacy store can state.
 *  `fields` is the residual `prepare` computed from the same envelope the row's projection came
 *  off; `pg` writes SQL NULL for null. */
async function insertRevision(
  p: Pick<pg.Pool, "query">, docId: string, revision: number, version: number, w: DocumentWrite,
  prep: Prepared, writer: string | null, seal: { by: string; at: string } | null,
): Promise<void> {
  await p.query(
    `insert into zz.doc_revision
       (doc_id, revision, content_state, title, body, tags, content_hash, revision_note,
        written_by, written_at, approved_by, approved_at, fields, version)
     values ($1::uuid, $2, 'retained', $3, $4, $5::text[], $6, $7, $8::uuid, now(),
             $9::uuid, $10::timestamptz, $11::jsonb, $12)`,
    [docId, revision, prep.title, prep.body, prep.tags, prep.hash, w.note ?? null, writer,
     seal?.by ?? null, seal?.at ?? null, prep.fields, version]);
}
