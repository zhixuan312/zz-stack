/**
 * The one rule for a revision waiting for approval, which Status counts now and Teams, Home and
 * Approvals count when their phases come: the current revision of a document its flow gates,
 * covered by a presentation (`presented_at` set) and not approved, in an initiative that is not
 * closed. Each revision is one row, however many times it was presented or whoever looks at it,
 * and it has waited since it was presented.
 *
 * The console's `?waiting=1` (console/initiatives.ts) keeps its own rule, written and not approved,
 * until the pages that read it are rebuilt on this one.
 *
 * DELIBERATE: rows, not a SQL fragment, for the reason `realReports` gives in console/platform-bugs.ts:
 * every console query is one literal statement check:sql can PREPARE. Whether a flow gates a document
 * is its manifest's answer (`flowShape`), not a column, so that half of the rule is applied here to
 * the rows the statement returns.
 */
import { platformDb } from "../db.js";
import { flowShape } from "./shared.js";

/** One revision waiting for approval. `teamId` and `team` are for a reader allowed to see which team
 *  it waits in; a projection for anybody else leaves both out. */
export type PendingRevision = {
  teamId: string; team: string; initiative: string; path: string; revision: number;
  /** When it was presented, an instant in milliseconds: the time it has waited since. */
  presentedMs: number;
};

/**
 * Every revision waiting for approval at `asOf`, the longest waiting first, then by team, initiative
 * and path. A revision presented after `asOf` is not yet waiting.
 */
export async function pendingRevisions(asOf: string): Promise<PendingRevision[]> {
  const { rows } = await platformDb().query<{
    team_id: string; team: string; initiative: string; flow: string | null; path: string; revision: number; presented_ms: number;
  }>(
    `select t.id::text as team_id, t.slug as team, i.slug as initiative, i.flow, d.path, r.revision,
            (extract(epoch from r.presented_at) * 1000)::float8 as presented_ms
       from zz.doc d
       join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision
       join zz.initiative i on i.id = d.initiative_id
       join zz.team t on t.id = i.team_id
      where i.closed_at is null and r.presented_at is not null and r.presented_at <= $1::timestamptz
        and r.approved_at is null
      order by r.presented_at, t.slug, i.slug, d.path`, [asOf]);
  return rows
    .filter((r) => flowShape(r.flow).get(r.path)?.gate === true)
    .map((r) => ({
      teamId: r.team_id, team: r.team, initiative: r.initiative, path: r.path, revision: r.revision, presentedMs: r.presented_ms,
    }));
}
