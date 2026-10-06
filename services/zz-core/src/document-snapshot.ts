/**
 * Which snapshot a write lands on: the per-document lock, the current row with the pin rule's
 * answer, where a write goes on it, and the first free name of a path's stem. `saveDocument`
 * (`document-save.ts`) calls them inside its transaction; a presentation (`commitPresentation`,
 * review-context.ts) takes the same lock, reads the row it pins and stamps its generation.
 *
 * A snapshot somebody was shown or signed is immutable for every writer. A write that changes its
 * content identity files a new row in the same public version; a write that keeps the identity —
 * an approval sealing it, a close stamping its outcome — stays in place, because what was shown is
 * still what the row says.
 */
import type pg from "pg";

import { splitStorePath } from "./versions.js";

/** The per-document lock, held to the end of the transaction. */
export async function lockPath(c: Pick<pg.Pool, "query">, team: string, relPath: string): Promise<void> {
  await c.query("select pg_advisory_xact_lock(hashtext($1))", [`doc:${team}/${relPath}`]);
}

/** The document's current row and both generations: the document's, and the row's own — null on a
 *  row written before generations were recorded per row. What a presentation confirms it showed. */
export async function rowHeld(
  c: Pick<pg.Pool, "query">, team: string, relPath: string,
): Promise<{ id: string; current_revision: number; content_generation: string; own_generation: string | null } | null> {
  const { initiative, name } = splitStorePath(relPath);
  const { rows } = await c.query(
    `select d.id::text as id, d.current_revision, d.content_generation::text as content_generation,
            r.content_generation::text as own_generation
       from zz.doc d
       join zz.initiative i on i.id = d.initiative_id
       join zz.team t on t.id = i.team_id
       left join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision
      where t.slug = $1 and i.slug = $2 and d.path = $3
      order by d.updated_at desc
      limit 1`, [team, initiative, name]);
  return rows[0] ?? null;
}

/** Stamp a current row written before generations were recorded per row with the document's own,
 *  at the first act that pins it: the value describes the same content, so the snapshot keeps its
 *  identity once it is superseded. A row that has one keeps it. COUPLED: `saveDocument` stamps a row
 *  it supersedes with the same rule, in its own statement. */
export async function stampGeneration(c: Pick<pg.Pool, "query">, docId: string, revision: number): Promise<void> {
  await c.query(
    `update zz.doc_revision r set content_generation = d.content_generation
       from zz.doc d
      where d.id = r.doc_id and r.doc_id = $1::uuid and r.revision = $2 and r.content_generation is null`,
    [docId, revision]);
}

/** The first free name of a path's stem — `<stem>.md`, `<stem>-2.md`, … — with its lock held.
 *
 *  DELIBERATE: the stem's lock first, so two reservations of one stem serialise and the second
 *  sees the first's row; then the chosen path's, which a create of that exact name also takes, and
 *  the name is looked at again under it. A probe outside the lock let two writers pick one name. */
export async function reservePath(c: Pick<pg.Pool, "query">, team: string, relPath: string): Promise<string> {
  const stem = relPath.replace(/\.md$/, "");
  await lockPath(c, team, stem);
  for (let n = 1; ; n++) {
    const rel = n === 1 ? `${stem}.md` : `${stem}-${n}.md`;
    if (await currentRow(c, team, rel)) continue;
    await lockPath(c, team, rel);
    if (!(await currentRow(c, team, rel))) return rel;
  }
}

export interface CurrentRow {
  id: string; status: string; current_revision: number | null; approved_revision: number | null;
  /** The document's content generation, `zz.doc.content_generation`, as text. */
  generation: string; version: number | null; written_at: string | null;
  title: string | null; body: string | null; tags: string[] | null; fields: Record<string, string> | null;
  pinned: boolean;
}

/** The document a store path names and its current row, with the pin rule's answer.
 *
 * PINNED: a row somebody was shown or signed. Shown means `presented_at` set, or a
 * `document.shown`/`document.shown_part` event for this document at or after the row's write;
 * signed means sealed, or the document's approved revision — a seal whose person resolved to no
 * principal leaves the row's columns null and the approval stands. */
export async function currentRow(
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

/** Where a write to an existing document lands: a new public version when it opens one (a change
 *  with a new cause, or an `append`), a new row in the same version when it changes a pinned row's
 *  content identity — a change and a write without one alike — and the current row in place
 *  otherwise. */
export function landing(append: boolean, sameIdentity: boolean, pinned: boolean): "append" | "pinned" | "rewrite" {
  if (append) return "append";
  return !sameIdentity && pinned ? "pinned" : "rewrite";
}
