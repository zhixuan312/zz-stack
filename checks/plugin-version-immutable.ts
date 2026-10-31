/**
 * checks/plugin-version-immutable.ts — no statement in the write trees updates `zz.plugin_version`.
 *
 * `plugin_version` is immutable history (FR-24, AC-6.2). A release has ONE identity, its `digest`
 * is written once at insert — by `register-plugins.ts` at a release, by `plugin_register` at a
 * third-party capture — and every later fact about that release is a new version rather than an
 * update. The table carries no lifecycle column for the same reason: there is no state for a
 * `set` to move. `plugin_locate` is what used to violate this, recomputing a whole-plugin content
 * digest and upserting a second row per released thing (`zz.eval_subject_version`, folded onto
 * this table by the phase-3 migration); it resolves the row now and writes nothing to it.
 *
 * Why a check and not a constraint: nothing enforces "this table's rows never change" — a `set`
 * on it compiles, runs, and silently rewrites the digest every earlier evaluation of that release
 * was judged against. The failure is invisible until two evaluations of one version disagree
 * about what they scored. This is the static half of that.
 *
 * Read, not run. A statement is the text of a string or template literal — adjacent literals that
 * a `+` joins read as one, so an insert list spread across four of them is still a single
 * statement — with the text after a `--` on each of its lines stripped, the way
 * `checks/sql-scan.ts`'s `withoutSqlComments` does it; or, in a shell script, one line. A
 * `${callee(…)}` the statement interpolates is replaced by the literals that callee returns before
 * the statement is read, so a `set` a caller cannot see is one this reads.
 *
 * Four write shapes are reported, and they are the same fact spelled four ways:
 *
 *   `update zz.plugin_version … set …`       — a row rewritten.
 *   `delete from zz.plugin_version …`        — a release erased, which no rollback does: a
 *                                              rollback retracts a version, it never deletes the
 *                                              row an exact-version locate still resolves.
 *   `insert into zz.plugin_version … on conflict … do update set …` — the "upsert" spelling of an
 *                                              update. `on conflict … do nothing` is the shape
 *                                              that keeps the promise and is not reported.
 *   `alter table zz.plugin_version …`        — the row gaining a lifecycle column, which is the
 *                                              thing the clause forbids: it is immutable history,
 *                                              so there is nothing about a release to move.
 *
 * DELIBERATE: a `zz.plugin_version` only READ inside another table's statement (`update zz.candidate
 * set … = (select … from zz.plugin_version …)`) is not a finding. The verb has to be the table's
 * own for the statement to be one that writes it.
 *
 * EXEMPT, each with the reason it is:
 *
 *   `services/gateway/migrations/` — an applied migration is history. `001_init.sql` declares this
 *   table, the phase-3 migration that gave it its shape having folded back into it; the file
 *   that writes its DDL is exactly the file that must still spell it. `checks/dropped-columns.ts` and
 *   `checks/catalog-eval-columns.ts` carry this exemption for the same reason.
 *
 *   `checks/` — deliberately not a scan root, for the reason `checks/catalog-eval-columns.ts`
 *   gives: this file spells `update zz.plugin_version` to explain the rule it applies, and read as
 *   a call site that is a finding that reads nothing.
 *
 * DELIBERATE: the roots are relative to `process.cwd()`, not to this file's own location, so the
 * check can be pointed at a scratch tree that plants a violation. Run it from the repository root
 * and it reads the repository.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { homeOf, readsStatements, withoutSqlComments, writeShape } from "./sql-scan.ts";

// The statement reader, once — `packages/tools/src/lib/sql-statements.ts`.
const { sourceFiles, regions, statementsOf, foldInterpolations } =
  await import(pathToFileURL(join(process.cwd(), "packages/tools/dist/lib/sql-statements.js")).href);
const HOME = homeOf(regions);

/** The trees that write to a database, the same four `checks/catalog-eval-columns.ts` scans. */
const ROOTS = ["services", "packages", "scripts", "deploy"];

const fail: string[] = [];
let scanned = 0;
const files = new Set<string>();

for (const { path, src } of ROOTS.flatMap((r) => (existsSync(r) ? sourceFiles(r, readsStatements) : []))) {
  const rs = regions(src);
  for (const statement of statementsOf(path, src)) {
    const sql = withoutSqlComments(foldInterpolations(statement.sql, src, rs, path, HOME));
    scanned++;
    files.add(path);
    const shape = writeShape(sql, "plugin_version");
    if (shape) {
      fail.push(`FAIL: ${statement.path}:${statement.line} — this statement ${shape} zz.plugin_version, ` +
                "which is immutable history: its digest is written once at insert and every later " +
                "fact about a release is a new version, never an update");
    }
  }
}

if (fail.length) {
  console.error(fail.join("\n"));
  process.exit(1);
}
console.log(`plugin_version is immutable: ${scanned} statement(s) in ${files.size} file(s) under ` +
            `${ROOTS.join(", ")} never update it — an insert is the only write.`);
