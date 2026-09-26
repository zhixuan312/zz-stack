/**
 * Which version of a plugin is released now: `currentVersion` fed from the database and the
 * running catalog. The one reader plugin_locate's head (eval/subject.ts), release_apply's
 * baseline (eval/release-apply.ts, which release_record's rollback check reuses) and knowledge's
 * subject stamp (platform-db.ts) all call, so none of them can name a different version for one
 * plugin.
 *
 * A plugin in the running catalog is at `PLATFORM_VERSION`; one whose declared version has no
 * `zz.plugin_version` row is refused by name rather than answered with some other row. Every
 * other plugin is at its newest version by semver, retracted versions left out.
 *
 * DELIBERATE: on the core side, not in eval/. Knowledge's subject stamp is a core-door write, and
 * checks/eval-tools-moved.ts keeps the core side from importing the evaluation modules. Which
 * version is current is platform state both doors read; the evaluation side imports it from here.
 *
 * Sequential queries: `runner` may be one PoolClient, which runs one query at a time.
 */
import { catalogEntries, pluginName } from "@zz/catalog";
import type pg from "pg";

import { PLATFORM_VERSION } from "./platform-version.js";
import { Refusal } from "./refusal.js";

interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

/** Semver precedence (semver.org section 11): numeric core first, then a pre-release below its
 *  own release, then the pre-release identifiers one by one — numeric ones numerically, numeric
 *  below alphanumeric, alphanumeric as ASCII text, and a shorter run of equal identifiers below a
 *  longer one. Build metadata (`+...`) is ignored. Never a text sort: text puts 0.9.0 above
 *  0.43.0, and rc.10 below rc.9. A version with no leading numeric core — `v1.0.0` included —
 *  sorts below every version that has one. `currentVersion` below reduces a plugin that is not
 *  in the catalog through `newestVersion`, rather than trusting any SQL order. */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string): { core: number[] | null; pre: string[] } => {
    const m = /^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?/.exec(v.trim());
    return m ? { core: m[1].split(".").map(Number), pre: m[2] ? m[2].split(".") : [] } : { core: null, pre: [] };
  };
  const x = parse(a), y = parse(b);
  if (!x.core || !y.core) return (x.core ? 1 : 0) - (y.core ? 1 : 0);
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i += 1) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (!x.pre.length || !y.pre.length) return (x.pre.length ? -1 : 0) + (y.pre.length ? 1 : 0);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return Math.sign(Number(p) - Number(q));
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** The newest version by `compareSemver`, or null for none. First wins a tie. */
export function newestVersion(versions: readonly string[]): string | null {
  let best: string | null = null;
  for (const v of versions) if (best === null || compareSemver(v, best) > 0) best = v;
  return best;
}

/** The version a plugin is released at now, from its registered `zz.plugin_version` rows — the
 *  one rule both "what is released now" readers apply, plugin_locate's head (subject.ts) and
 *  release_apply's baseline (release-apply.ts), through `currentVersionOf` below.
 *
 *  A catalog plugin (`declared` non-null) is at the version the running deployment's catalog
 *  declares, or null when no row registers it. Never the semver max of every row: the table keeps
 *  every version ever registered, including an earlier independent numbering (zz-access's 2.3.0)
 *  that sorts above every platform release. `retracted` does not apply to it — a rollback of a
 *  catalog plugin is a redeploy of the prior release, so the running deployment already says
 *  which version is current, and one still declaring a retracted version is still running it.
 *
 *  Any other plugin is at its newest registered version by semver, leaving out every version a
 *  rollback retracted, so the prior version is current again. Null for none. */
export function currentVersion(
  versions: readonly string[], retracted: readonly string[], declared: string | null,
): string | null {
  if (declared !== null) return versions.includes(declared) ? declared : null;
  return newestVersion(versions.filter((v) => !retracted.includes(v)));
}

/** The versions of a plugin a rollback retracted (FR-50): every `declared_version` a
 *  `rolled_back` release attempt had released. A rollback of a plugin outside the catalog makes
 *  the prior version current again without deleting the `zz.plugin_version` row the retracted
 *  release registered. A catalog plugin is at whatever the running deployment declares. That row
 *  stays: an exact-version locate still resolves it, because verifying and explaining the
 *  rolled-back release needs it. */
export async function retractedVersions(runner: Queryable, pluginId: string): Promise<string[]> {
  return (await runner.query<{ declared_version: string }>(`
    select distinct sv.declared_version
      from zz.release_attempt ra
      join zz.eval_subject_version sv on sv.id = ra.released_subject_version_id
     where ra.plugin_id = $1::uuid and ra.status = 'rolled_back'`, [pluginId])).rows
    .map((r) => r.declared_version);
}

/** The current version of the plugin `pluginId`, or null when it has no registered version. */
export async function currentVersionOf(runner: Queryable, pluginId: string): Promise<string | null> {
  const plugin = (await runner.query<{ name: string }>(
    "select name from zz.plugin where id = $1::uuid", [pluginId])).rows[0]?.name;
  if (plugin === undefined) return null;
  const declared = catalogEntries().some((e) => pluginName(e.flow) === plugin) ? PLATFORM_VERSION : null;
  const versions = (await runner.query<{ version: string }>(
    "select pv.version from zz.plugin_version pv where pv.plugin_id = $1::uuid", [pluginId])).rows
    .map((r) => r.version);
  const retracted = declared === null ? await retractedVersions(runner, pluginId) : [];
  const version = currentVersion(versions, retracted, declared);
  if (declared !== null && version === null) {
    throw new Refusal(
      `ERROR: ${plugin} ${declared} is not registered — the running deployment's catalog declares ` +
      "that version and zz.plugin_version has no row for it: the release's register-plugins step " +
      "did not run");
  }
  return version;
}
