/**
 * The versions of a plugin a rollback retracted (FR-50): every `declared_version` a
 * `rolled_back` release attempt had released. The ONE rule both "what is released now" readers
 * apply — `release_apply`'s compare-and-swap baseline (`release-apply.ts`) and `plugin_locate`'s
 * head (`subject.ts`) — so a rollback makes the prior version current again without deleting the
 * `zz.plugin_version` row the retracted release registered. That row stays: an exact-version
 * locate still resolves it, because verifying and explaining the rolled-back release needs it.
 */
import type pg from "pg";

interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

export async function retractedVersions(runner: Queryable, pluginId: string): Promise<string[]> {
  return (await runner.query<{ declared_version: string }>(`
    select distinct sv.declared_version
      from zz.release_attempt ra
      join zz.eval_subject_version sv on sv.id = ra.released_subject_version_id
     where ra.plugin_id = $1::uuid and ra.status = 'rolled_back'`, [pluginId])).rows
    .map((r) => r.declared_version);
}
