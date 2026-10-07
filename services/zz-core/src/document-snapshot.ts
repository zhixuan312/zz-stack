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
import { contentRevision } from "@zz/contracts";
import type pg from "pg";

import { splitStorePath } from "./versions.js";

/** The per-document lock, held to the end of the transaction. */
export async function lockPath(c: Pick<pg.Pool, "query">, team: string, relPath: string): Promise<void> {
  await c.query("select pg_advisory_xact_lock(hashtext($1))", [`doc:${team}/${relPath}`]);
}

/** The document's current row and both generations: the document's, and the row's own — null on a
 *  row written before generations were recorded per row — and when the row was written. What a
 *  presentation confirms it showed, what a change is computed from, and whether a name is taken;
 *  no pin rule, which only the write itself reads (`currentRow`). */
export async function rowHeld(
  c: Pick<pg.Pool, "query">, team: string, relPath: string,
): Promise<{ id: string; current_revision: number; content_generation: string; own_generation: string | null;
             written_at: string | null } | null> {
  const { initiative, name } = splitStorePath(relPath);
  const { rows } = await c.query(
    `select d.id::text as id, d.current_revision, d.content_generation::text as content_generation,
            r.content_generation::text as own_generation, r.written_at::text as written_at
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
    if (await rowHeld(c, team, rel)) continue;
    await lockPath(c, team, rel);
    if (!(await rowHeld(c, team, rel))) return rel;
  }
}

interface CurrentRow {
  id: string; status: string; current_revision: number | null; approved_revision: number | null;
  /** The document's content generation, `zz.doc.content_generation`, as text. */
  generation: string; version: number | null; written_at: string | null;
  title: string | null; body: string | null; tags: string[] | null; fields: Record<string, string> | null;
  pinned: boolean;
}

/** The document a store path names and its current row, with the pin rule's answer.
 *
 * PINNED: a row somebody was shown, signed or closed on. Shown means `presented_at` set, or a
 * `document.shown`/`document.shown_part` event for this document naming the row's own content
 * revision as its `target`, or one naming no target at or after the row's write; signed means
 * sealed, or the document's approved revision — a seal whose person resolved to no principal
 * leaves the row's columns null and the approval stands; closed on means it is the first row
 * carrying an `outcome`, the snapshot the close stamped. A correction carries the outcome forward
 * (`closeCheck`), so the outcome alone would pin every correction row and copy its body at each
 * edit; one is pinned when somebody was shown or signed it, like any other row.
 *
 * DELIBERATE: the shown event is matched by the generation it showed, not by time. An
 * identity-keeping rewrite — a close stamping its outcome — moves `written_at` past a partial
 * presentation's `ts`, and `ts` is its transaction's start, which can precede a `written_at`
 * committed while the presentation waited on the lock; either way the time test alone let the
 * next change rewrite a presented row in place. And a continuing presentation shows an older
 * snapshot after this row was written, so the time test would pin a row nobody saw. It stays only
 * for rows shown before events named their target. Only `saveDocument` reads this, under the
 * document's lock: every other reader of the current row takes `rowHeld`. */
export async function currentRow(
  p: Pick<pg.Pool, "query">, team: string, relPath: string,
): Promise<CurrentRow | null> {
  const { initiative, name } = splitStorePath(relPath);
  const { rows } = await p.query<CurrentRow & { initiative_id: string; own: string | null }>(
    `select d.id::text as id, d.initiative_id::text as initiative_id, d.status, d.current_revision,
            d.approved_revision, d.content_generation::text as generation, r.content_generation::text as own,
            r.version, r.written_at::text as written_at, r.title, r.body, r.tags, r.fields,
            (r.approved_by is not null or d.approved_revision = d.current_revision
             or r.presented_at is not null
             or (r.fields->>'outcome' is not null
                 and not exists (select 1 from zz.doc_revision y
                                  where y.doc_id = r.doc_id and y.revision < r.revision and y.fields->>'outcome' is not null))
             or exists (select 1 from zz.event e
                         where e.initiative_id = d.initiative_id and e.subject = $4
                           and e.kind in ('document.shown', 'document.shown_part')
                           and e.detail->>'target' is null and e.ts >= r.written_at)) as pinned
       from zz.doc d
       join zz.initiative i on i.id = d.initiative_id
       join zz.team t on t.id = i.team_id
       left join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision
      where t.slug = $1 and i.slug = $2 and d.path = $3
      order by d.updated_at desc
      limit 1`, [team, initiative, name, relPath]);
  const row = rows[0];
  if (!row) return null;
  const { initiative_id, own, ...cur } = row;
  if (cur.pinned) return cur;
  const target = contentRevision(cur.id, Number(own ?? cur.generation));
  const { rows: shown } = await p.query(
    `select 1 from zz.event e
      where e.initiative_id = $1::uuid and e.subject = $2 and e.kind in ('document.shown', 'document.shown_part')
        and e.detail->>'target' = $3
      limit 1`, [initiative_id, relPath, target]);
  return { ...cur, pinned: shown.length > 0 };
}

/** Where a write to an existing document lands: a new public version when it opens one (a change
 *  with a new cause, or an `append`), a new row in the same version when it changes a pinned row's
 *  content identity — a change and a write without one alike — and the current row in place
 *  otherwise. */
export function landing(append: boolean, sameIdentity: boolean, pinned: boolean): "append" | "pinned" | "rewrite" {
  if (append) return "append";
  return !sameIdentity && pinned ? "pinned" : "rewrite";
}
