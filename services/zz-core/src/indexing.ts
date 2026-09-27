/**
 * What zz-core records beside a document, and the seam a guard reads one through.
 *
 * COUPLED: the row a document IS — `zz.doc` + `zz.doc_revision` — is written by `saveDocument`
 * in `versions.ts`, the ONE insert path into that shape. Nothing here writes a second one: two
 * writers for one row shape drift, and this platform's two already had (the path column, the
 * revision numbering, what a revision's `body` holds). The store's own file, its `_versions/`
 * snapshot, its `_ledger.md` row and its git commit live there too, until Task I-41 retires
 * them with the layer.
 *
 * What is here is zz-core's alone: `platformEvent` writes `zz.event` and is the one call a
 * mutating tool makes to record that it did; `journalLog` is the knowledge tools' spelling of
 * the same act; `docRow`/`docRows` are the one seam `documentGuards` answers from; `sealOf` is
 * the approval a write carries forward into `saveDocument`; and `sourceDocument` is the envelope
 * shape the knowledge tools produce.
 */
import { parseEnvelope } from "@zz/contracts";
import type pg from "pg";

import { renderEnvelope } from "./document-rules.js";
import { db, teamFor } from "./platform-db.js";

/** The knowledge base's own log, in the platform's event table, which the console reads.
 *
 * `_knowledge/log.md` used to be appended beside it; the store is the database now, so there is
 * no file and this is the whole of the record. `journalLog` below keeps the knowledge tools'
 * spelling of the same act.
 *
 * DELIBERATE: not a `tool_call` row. A tool_call carries no actor because it measures a
 * skill; a journal entry names who recorded or read what.
 *
 * DELIBERATE: searches are entries too. `knowledge_add` and `knowledge_supersede` each leave
 * three records and a search would otherwise leave none, so "which nodes does anyone read"
 * would have no answer.
 *
 * COUPLED: the actor and the team are written as ids resolved in the statement that writes the row
 * — `zz.event` carries no slug and no address. A journal entry by somebody this platform does not
 * know, or under a team slug nothing matches, is written with that column null rather than refused:
 * a record of a search is worth more than a refusal to make one.
 *
 * The actor is folded in the statement. tool-report and watch-results both group on this
 * column, and one person spelled two ways breaks both.
 *
 * Fire and forget, catching everything: a journal entry that failed to write must never make
 * a node the person already minted report failure. */
export function platformEvent(e: {
  /** The actor, by address. */
  actor: string;
  /** The act, as the `<noun>.<verb>` a `zz.event.kind` is checked against. */
  kind: string;
  /** What the row is about, which is the `subject` column it lands in: the node id for an
   *  add or a supersede, the query itself for a search, the bug id for a resolve, an
   *  initiative's own record for an open. Absent means the initiative. */
  subject?: string;
  /** The caller's team slug, when it already knows one.
   *
   *  DELIBERATE: OMITTED and null are different answers. Omitted means "resolve it from the
   *  actor's own membership", which is what every tool wants and none of them should have to do
   *  — the resolution is a query, and a tool that forgot it would write an unattributed row.
   *  Null means "this row names no team", which is what a journal entry by nobody is and what
   *  every caller that already resolved one passes deliberately. */
  team?: string | null;
  /** The initiative this act belongs to, when the caller had one. Resolved to `initiative_id`
   *  in the same statement that writes the row, from the same team slug it already binds — the
   *  id has to come from the statement that writes the row, not a second round trip that can
   *  disagree with it. */
  initiative?: string | null;
  /** Everything else the act carries, as one bag. `activity` used to take it as the rest of the
   *  object; one entry shape rather than two is why it is a named field now. */
  detail?: Record<string, unknown>;
} & Record<string, unknown>): void {
  const { actor, kind, subject, team, initiative = null, detail, ...rest } = e;
  // DELIBERATE: no refusal for an actor this platform does not know. A journal entry by nobody —
  // `journalLog` writes one — has that column null, and a row that is a record of an act is
  // worth more than a refusal to make one. The statement resolves the id, so an address nothing
  // matches lands as null rather than as an error.
  const write = (slug: string | null): void => {
    const p = db();
    if (!p) return;
    void p.query(
      `insert into zz.event (actor_id, team_id, initiative_id, kind, subject, detail)
       values ((select id from zz.principal where email = lower($1)),
               (select id from zz.team where slug = $2),
               (select i.id from zz.initiative i join zz.team t on t.id = i.team_id
                 where t.slug = $2 and i.slug = $3),
               $4, $5, $6)`,
      [actor, slug, initiative, kind, subject ?? initiative ?? "", JSON.stringify({ ...rest, ...(detail ?? {}) })],
    // Logged: a row dropped here leaves no trace anywhere, so a database refusing every
    // insert would look identical to one recording them all.
    ).catch((err) => console.error("platform journal insert failed:", err));
  };
  if (team !== undefined) return write(team);
  // No team named, so it is resolved from the actor's own membership — the query every tool
  // would otherwise have to make itself, and the one a tool that forgot it would get wrong.
  if (!actor) return write(null);
  void teamFor(actor).then(write)
    .catch((err) => console.error("journal insert failed:", err));
}
/** The journal's human-readable log. It named `_knowledge/log.md`; the store is the database
 * now, so the entry lands in `zz.event` like every other act and there is no file to append to.
 *
 * The signature is the knowledge tools' own (`root` is no longer read), so its callers keep
 * working unchanged. */
export function journalLog(_root: string, action: string, id: string, detail: string): void {
  // Written with an explicit null team rather than through the resolving arm: this entry carries
  // no actor, and `platformEvent` refuses a row it cannot attribute rather than writing an
  // unattributed one with a team guessed from nobody.
  platformEvent({
    actor: "", kind: `knowledge.${action}`, subject: id, team: null,
    detail: { node: id, detail },
  });
}
/** One row of the knowledge base as retrieval reads it. */
export interface KbRow {
  initiative: string; path: string; flow: string; type: string; status: string;
  outcome: string | null; approved_by: string | null; approved_at: string | null;
  updated_at: string; title: string; tags: string[] | null; evidence: string[] | null;
  superseded_by: string | null; rank: number; snippet: string;
  /** Which shelf the row is on. A knowledge search deliberately spans the caller's team AND
   * the platform's journal, and dropping this made the two indistinguishable in the answer —
   * so a path that came back could not be read back. */
  team_slug: string;
}
/** One document, as the guards and the evaluation family read it: the `zz.doc` row's own
 *  columns, plus the body of the revision the row currently points at.
 *
 *  DELIBERATE: `body` comes from `doc_revision`, not from `zz.doc.body`. `zz.doc.body` is the
 *  denormalised copy the file indexer used to keep in step; the revision table is the one that
 *  holds a document's bytes, and a reader that answered from the copy while the revision moved
 *  would be reading a stale document.
 *
 *  DELIBERATE: `path` is the document's path INSIDE its initiative — `notes.md`, or
 *  `sources/x.md` — never `<initiative>/notes.md`. `initiative` is its own column, and every
 *  reader that joins the two does it as `${initiative}/${path}` (`scripts/store-migration.ts`,
 *  `knowledge-search.ts`, a document subject's ref in `evaluate-run.ts`). A row written with the
 *  whole path in one column is one no reader can join back to a file. */
export interface DocRow {
  id: string; path: string; initiative: string; flow: string; type: string; status: string;
  outcome: string | null; approved_by: string | null; approved_at: string | null;
  closed_by: string | null; updated_at: string; title: string; body: string; tags: string[];
  current_revision: number | null; approved_revision: number | null;
}
/** One document by the path the store addresses it by: the initiative and the name inside it. */
export async function docRow(
  p: pg.Pool, team: string | null, initiative: string, docPath: string,
): Promise<DocRow | null> {
  const row = (await p.query<DocRow>(`
    select d.id::text as id, d.path, d.initiative, d.flow, d.type, d.status, d.outcome,
           d.approved_by, d.approved_at::text as approved_at, d.closed_by,
           d.updated_at::text as updated_at, d.title, coalesce(r.body, d.body) as body,
           coalesce(d.tags, '{}'::text[]) as tags,
           d.current_revision, d.approved_revision
      from zz.doc d
      left join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision
     where d.initiative = $1 and d.path = $2
       and ($3::text is null or d.team_slug = $3)
     order by d.updated_at desc limit 1`, [initiative, docPath, team])).rows[0];
  return row ?? null;
}
/** Every document of one initiative — the folder listing the store used to answer with
 *  `readdirSync`, read from the rows that replaced it. Keyed by the same `path` a caller looks
 *  a document up by, so the two agree about which document a flow's declaration names. */
export async function docRows(p: pg.Pool, team: string | null, initiative: string): Promise<DocRow[]> {
  return (await p.query<DocRow>(`
    select d.id::text as id, d.path, d.initiative, d.flow, d.type, d.status, d.outcome,
           d.approved_by, d.approved_at::text as approved_at, d.closed_by,
           d.updated_at::text as updated_at, d.title, coalesce(r.body, d.body) as body,
           coalesce(d.tags, '{}'::text[]) as tags,
           d.current_revision, d.approved_revision
      from zz.doc d
      left join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision
     where d.initiative = $1 and ($2::text is null or d.team_slug = $2)
     order by d.path`, [initiative, team])).rows;
}
/** The approval a write carries forward, as `saveDocument` takes it.
 *
 *  `document_approve` and `document_revise` seal the revision they write, and a close rewrites
 *  the current revision of a document that is usually approved — a rewrite of a sealed revision
 *  without its seal is refused by `zz.doc_revision`'s own check, and rightly, because a
 *  signature has to cover the bytes it signed. A document carrying no approval returns null, and
 *  `saveDocument` then simply writes none. */
export function sealOf(stamped: string): { by: string; at: string } | null {
  const env = parseEnvelope(stamped);
  const at = env.approved_at && /^\d{4}-\d{2}-\d{2}/.test(env.approved_at) ? env.approved_at : null;
  return env.status === "approved" && env.approved_by && at ? { by: env.approved_by, at } : null;
}
/** A source document, written by source_add and by document_revise — same `type: source`,
 * same fields, same readers, so one builder rather than two hand-built envelopes.
 *
 * Through renderEnvelope, so every value is folded to one line whatever a caller sends. A
 * title carrying a newline otherwise adds fields to the envelope: `supports` decides which
 * approved documents initiative_status flags, and `type` is what knowledge_search filters on.
 *
 * COUPLED: `supports` stays comma-joined because that is how its readers split it. */
export function sourceDocument(
  opts: { title: string; by: string; day: string; supports: string; content: string;
          /** The flow stage this source is the output of — an audit round names its audit stage. */
          stage?: string;
          /** For an audit round: the version of the supported document the round read. */
          audits_version?: string },
): string {
  const env: Record<string, string> = {
    type: "source", title: opts.title, contributed_by: opts.by, date: opts.day,
    added_at: new Date().toISOString(), supports: opts.supports };
  if (opts.stage) env.stage = opts.stage;
  if (opts.audits_version) env.audits_version = opts.audits_version;
  return renderEnvelope(
    env, ["type", "title", "contributed_by", "date", "added_at", "supports", "stage", "audits_version"],
  ) + `\n${opts.content}\n`;
}
