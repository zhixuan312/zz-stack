/**
 * The one rule for a revision waiting for approval, which Status, Teams, Home and Approvals count:
 * the current revision of a document its flow gates, covered by a presentation (`presented_at` set)
 * and not approved, in an initiative that is not closed. Each revision is one row, however many times
 * it was presented or whoever looks at it, and it has waited since it was presented.
 *
 * DELIBERATE: rows, not a SQL fragment, for the reason `realReports` gives in console/platform-bugs.ts:
 * every console query is one literal statement check:sql can PREPARE. Whether a flow gates a document
 * is its manifest's answer (`flowShape`), not a column, so that half of the rule is applied here to
 * the rows the statement returns.
 */
import { platformDb } from "../db.js";
import { shared } from "./imports.js";
import { flowShape } from "./shared.js";

/** One revision waiting for approval. `teamId` and `team` are for a reader allowed to see which team
 *  it waits in; a projection for anybody else leaves both out. */
export type PendingRevision = {
  teamId: string; team: string; initiative: string; path: string; revision: number;
  /** When it was presented, an instant in milliseconds: the time it has waited since. */
  presentedMs: number;
};

/** A row either statement below returns, before the manifest's half of the rule is applied. */
type Row = {
  team_id: string; team: string; initiative: string; flow: string | null; path: string; revision: number; presented_ms: number;
};

/** The manifest's half of the rule: only a document its flow gates waits for approval. */
const gated = (rows: Row[]): PendingRevision[] => rows
  .filter((r) => flowShape(r.flow).get(r.path)?.gate === true)
  .map((r) => ({
    teamId: r.team_id, team: r.team, initiative: r.initiative, path: r.path, revision: r.revision, presentedMs: r.presented_ms,
  }));

/**
 * Every revision waiting for approval at `asOf`, the longest waiting first, then by team, initiative
 * and path. A revision presented after `asOf` is not yet waiting. For a reader of every team; one
 * team's reader asks `teamPendingRevisions`.
 */
export async function pendingRevisions(asOf: string): Promise<PendingRevision[]> {
  const { rows } = await platformDb().query<Row>(
    `select t.id::text as team_id, t.slug as team, i.slug as initiative, i.flow, d.path, r.revision,
            (extract(epoch from r.presented_at) * 1000)::float8 as presented_ms
       from zz.doc d
       join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision
       join zz.initiative i on i.id = d.initiative_id
       join zz.team t on t.id = i.team_id
      where i.closed_at is null and r.presented_at is not null and r.presented_at <= $1::timestamptz
        and r.approved_at is null
      order by r.presented_at, t.slug, i.slug, d.path`, [asOf]);
  return gated(rows);
}

/**
 * `pendingRevisions`' rows of one team, or of one initiative of it when `initiative` is given, read
 * with that predicate rather than filtered out of every team's: a Work read is one team's, and paying
 * for the whole platform's queue to answer it is a scan nobody asked for. Two statements, not one with
 * a null standing in for "every initiative": a console query never falls back to a wider scope.
 *
 * Read once for every part of one read asking about one team at one cutoff: Home counts what waits and
 * draws its open work from the list of initiatives, which counts the same queue again.
 *
 * COUPLED: the same rule and order as `pendingRevisions`, with the team and initiative added.
 */
export function teamPendingRevisions(team: string, asOf: string, initiative?: string): Promise<PendingRevision[]> {
  return shared(`pending revisions ${team} ${asOf} ${initiative ?? ""}`, () => readTeamPendingRevisions(team, asOf, initiative));
}

async function readTeamPendingRevisions(team: string, asOf: string, initiative?: string): Promise<PendingRevision[]> {
  const { rows } = initiative === undefined
    ? await platformDb().query<Row>(
      `select t.id::text as team_id, t.slug as team, i.slug as initiative, i.flow, d.path, r.revision,
              (extract(epoch from r.presented_at) * 1000)::float8 as presented_ms
         from zz.doc d
         join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision
         join zz.initiative i on i.id = d.initiative_id
         join zz.team t on t.id = i.team_id
        where t.slug = $1
          and i.closed_at is null and r.presented_at is not null and r.presented_at <= $2::timestamptz
          and r.approved_at is null
        order by r.presented_at, i.slug, d.path`, [team, asOf])
    : await platformDb().query<Row>(
      `select t.id::text as team_id, t.slug as team, i.slug as initiative, i.flow, d.path, r.revision,
              (extract(epoch from r.presented_at) * 1000)::float8 as presented_ms
         from zz.doc d
         join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision
         join zz.initiative i on i.id = d.initiative_id
         join zz.team t on t.id = i.team_id
        where t.slug = $1 and i.slug = $3
          and i.closed_at is null and r.presented_at is not null and r.presented_at <= $2::timestamptz
          and r.approved_at is null
        order by r.presented_at, d.path`, [team, asOf, initiative]);
  return gated(rows);
}
