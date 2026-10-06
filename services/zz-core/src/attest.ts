/** Facts about the record that a script decides, so no model has to.
 *
 * A skill is prose, and prose read by a model can be followed, half-followed or reasoned
 * around with nothing downstream able to tell which. Anything settleable by running a function
 * is settled here, and the tool reports the answer. The model chooses which function to call.
 *
 * This module holds no policy: it answers questions, `server.ts` decides what to say about the
 * answers, and nothing here refuses anything.
 *
 * COUPLED: the record it reads is a COLUMN. `doc_revision.presented_at` is set when a presentation
 * completes the current snapshot's coverage in its review context (`commitPresentation`,
 * review-context.ts), and `presented_at > written_at` is the whole of the question below. It used to
 * be a line in `<initiative>/activity.jsonl` — permanent and per-initiative — and an event table is
 * unbounded and ephemeral unless it declares its retention; `zz.event` keeps `document.*` rows
 * indefinitely now, and the coverage a review context computes is read from them.
 *
 * DELIBERATE: until approval reads a review context's coverage of the exact snapshot it signs, this
 * column stays what the old approval check reads, and the pin rule reads it after that.
 */
import type pg from "pg";

/** The `kind` every document act is recorded under: `document.<action>`. Exported because
 *  `recordAct` (versions.ts) is the writer and this module is the reader of the two acts they
 *  share — the `shown` projection and the part-coverage rows below — and a prefix spelled twice
 *  is one that drifts. */
export const DOCUMENT_EVENT_PREFIX = "document.";

/** The document's address split the way every reader splits it: the initiative, and the name
 *  inside it. `null` for a path that is not `<initiative>/<document>` — a bare name, or a
 *  document under a folder of its own. */
export function splitDocPath(relPath: string): { initiative: string; path: string } | null {
  const parts = relPath.replace(/^\/+/, "").split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { initiative: parts[0], path: parts[1] };
}

/** Was this document fetched back since the last time its content changed?
 *
 * Returns a fact; `document_approve` refuses on `false` — "present it first" — and approves on
 * `true` or `null`.
 *
 * Since the last content change, not "at this version". A `document_edit` of a draft does not bump
 * `version`, so a document can be shown at v1, edited eight times and approved while a
 * version-comparison would still call it fetched. Filling a scaffold is exactly that shape. The
 * column makes the same distinction for free: an edit of an unshown draft rewrites the current
 * revision in place, so its `written_at` moves forward while `presented_at` stays where the
 * present left it.
 *
 * Returns null when the question cannot be answered — no such document, no current revision, a
 * path that is not `<initiative>/<document>`, or a caller this deployment cannot place. A warning
 * invented from a missing record teaches the reader that this line does not mean anything. */
export async function shownSinceLastChange(
  p: Pick<pg.Pool, "query">, team: string | null, relPath: string,
): Promise<boolean | null> {
  const at = splitDocPath(relPath);
  if (!at || !team) return null;
  try {
    const { rows } = await p.query<{ presented_at: string | null; written_at: string | null }>(
      `select r.presented_at::text as presented_at, r.written_at::text as written_at
         from zz.doc d
         join zz.initiative i on i.id = d.initiative_id
         join zz.team t on t.id = i.team_id
         join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision
        where t.slug = $1 and i.slug = $2 and d.path = $3`,
      [team, at.initiative, at.path]);
    const row = rows[0];
    if (!row?.written_at) return null;
    // STRICTLY later. The journal version compared positions, and a present that is not after the
    // write it is meant to attest is no attestation — `>=` would let the same instant count.
    return row.presented_at !== null && Date.parse(row.presented_at) > Date.parse(row.written_at);
  } catch {
    return null;
  }
}

/** Record that the current snapshot's coverage was completed — on the row a presentation pinned.
 *
 * Called by `commitPresentation` (review-context.ts) alone, inside the presentation's transaction
 * and on its client, so the column is written exactly when the row recording the completing page
 * commits; a failure fails that transaction. Through Phase 3 the old approval check
 * (`shownSinceLastChange`) and the pin rule both read it. */
export async function recordPresented(
  c: Pick<pg.Pool, "query">, docId: string, revision: number,
): Promise<void> {
  await c.query(
    "update zz.doc_revision r set presented_at = now() where r.doc_id = $1::uuid and r.revision = $2",
    [docId, revision]);
}
