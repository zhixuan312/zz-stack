#!/usr/bin/env node
/**
 * checks/release-record-db.ts — a release is recorded once, a disagreement is reported and changes
 * nothing, and the backfill reconciles the tags it was given, on a real database (AC-3.3).
 *
 *   node checks/release-record-db.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL migrated by the real runner (`withThrowawayDb`) and drives
 * `recordReleases` against it, with `run` answering as the deployment's `psql -tA` would: one line a
 * row, its fields joined by `|`, a null as nothing. What it establishes:
 *
 *   - the migrations create `zz.release` and leave it empty;
 *   - recording one tag twice leaves one row with the first call's `released_at`, and the second
 *     call reports the version `already` there and nothing recorded or in conflict;
 *   - recording that version again from another changelog text reports it in `conflicts` and leaves
 *     the row exactly as it was;
 *   - a call over three tags writes three rows and reports `tags 3, rows 3`, and the tag with no
 *     section is stored as `No changelog entry` with its client action unknown;
 *   - every tag of this checkout but `v0.31.1` reads, from this repository's own `CHANGELOG.md`, as
 *     a summary other than `No changelog entry` holding no `**`, no backtick and no `](`, and every
 *     section with upgrade notes names a client action.
 *
 * The only database it touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type pg from "pg";

import { NO_CHANGELOG, UNKNOWN_ACTION, recordReleases, releaseFromChangelog } from "../scripts/release-record.ts";
import { root } from "../scripts/deployment.ts";
import { withThrowawayDb } from "../scripts/schema/throwaway.ts";

class CaseFailure extends Error {}
function fail(step: string, detail: string): never {
  throw new CaseFailure(`release-record-db: FAILED at "${step}": ${detail}`);
}
const ok = (step: string): void => console.log(`  ${step}: ok`);

const LOG = [
  "# Changelog", "",
  "## [9.0.2] — 2026-10-14 · console 1.2.0", "",
  "The platform's record of itself. It is written once.", "",
  "### Upgrade notes", "",
  "- **Re-pull the plugins.** Every client takes the new text.", "",
  "## [9.0.0] — 2026-10-12", "",
  "### Fixed", "",
  "- **A search widens once.** It used to return nothing.", "",
].join("\n");
/** The same version's section, edited after it was recorded. */
const EDITED = LOG.replace("A search widens once.", "A search widens twice.");

const FIRST = "2026-10-12T10:00:00+08:00";
const LATER = "2026-10-13T09:00:00+08:00";

/** What `regSql` answers for a statement, from a throwaway client instead of the deployment's psql. */
const runOn = (db: pg.Client) => async (sql: string): Promise<string> =>
  (await db.query<unknown[]>({ text: sql, rowMode: "array" })).rows
    .map((r) => r.map((v) => (v === null ? "" : String(v))).join("|")).join("\n");

const rowOf = async (db: pg.Client, version: string): Promise<Record<string, unknown> | null> =>
  (await db.query<{ r: Record<string, unknown> }>("select row_to_json(t) as r from zz.release t where t.version = $1", [version])).rows[0]?.r ?? null;

function changelogCases(): void {
  const step = "every tag of this checkout reads from the repository's own changelog";
  const log = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  const tags = execFileSync("git", ["for-each-ref", "--format=%(refname:short)", "refs/tags/v*"], { cwd: root, encoding: "utf8" })
    .split("\n").filter(Boolean);
  if (tags.length === 0) fail(step, "this checkout holds no v* tag");
  const bad: string[] = [];
  for (const tag of tags) {
    const r = releaseFromChangelog(log, tag.slice(1));
    if (tag === "v0.31.1") {
      if (r.summary !== NO_CHANGELOG || r.clientAction !== UNKNOWN_ACTION) bad.push(`${tag} has a section: ${JSON.stringify(r.summary)}`);
      continue;
    }
    if (r.summary === NO_CHANGELOG) bad.push(`${tag} has no section`);
    else if (/\*\*|`|\]\(|\n/.test(r.summary)) bad.push(`${tag} summary keeps Markdown or a line break: ${JSON.stringify(r.summary)}`);
    if (r.upgradeNotes !== null && r.clientAction === null) bad.push(`${tag} has upgrade notes and no client action`);
    if (r.clientAction !== null && /\*\*|`|\]\(|\n/.test(r.clientAction)) bad.push(`${tag} client action keeps Markdown: ${JSON.stringify(r.clientAction)}`);
  }
  if (bad.length) fail(step, bad.join("; "));
  ok(`${step}: ${tags.length} tags, a summary for each but v0.31.1 and a client action wherever there are upgrade notes`);
}

async function run(db: pg.Client): Promise<void> {
  const sql = runOn(db);

  let step = "the migrations create zz.release empty";
  const exists = (await db.query<{ t: string | null }>("select to_regclass('zz.release')::text as t")).rows[0].t;
  if (exists !== "zz.release") fail(step, "no table zz.release after the migrations");
  const empty = (await db.query<{ n: number }>("select count(*)::int as n from zz.release")).rows[0].n;
  if (empty !== 0) fail(step, `it holds ${empty} row(s)`);
  ok(step);

  step = "recording one tag twice leaves one row with its first time";
  const first = await recordReleases(LOG, [{ version: "9.0.0", taggedAt: FIRST }], "9.0.0", sql);
  if (first.recorded.join() !== "9.0.0" || first.already.length || first.conflicts.length) fail(step, `first call reported ${JSON.stringify(first)}`);
  const again = await recordReleases(LOG, [{ version: "9.0.0", taggedAt: LATER }], "9.0.0", sql);
  if (again.recorded.length || again.already.join() !== "9.0.0" || again.conflicts.length) fail(step, `second call reported ${JSON.stringify(again)}`);
  const kept = await db.query<{ n: number; same: boolean }>(
    "select count(*)::int as n, bool_and(released_at = $1::timestamptz) as same from zz.release", [FIRST]);
  if (kept.rows[0].n !== 1 || !kept.rows[0].same) fail(step, `${kept.rows[0].n} row(s), first time kept: ${kept.rows[0].same}`);
  if (again.tags !== 1 || again.rows !== 1) fail(step, `reported tags ${again.tags}, rows ${again.rows}`);
  ok(step);

  step = "a record from another changelog text is a conflict and changes nothing";
  const before = await rowOf(db, "9.0.0");
  const edited = await recordReleases(EDITED, [{ version: "9.0.0", taggedAt: FIRST }], "9.0.0", sql);
  if (edited.conflicts.join() !== "9.0.0" || edited.recorded.length) fail(step, `reported ${JSON.stringify(edited)}`);
  const after = await rowOf(db, "9.0.0");
  if (JSON.stringify(after) !== JSON.stringify(before)) fail(step, `the row moved from ${JSON.stringify(before)} to ${JSON.stringify(after)}`);
  ok(step);

  step = "a call over three tags writes three rows";
  await db.query("delete from zz.release");
  const three = await recordReleases(LOG, [
    { version: "9.0.0", taggedAt: FIRST },
    { version: "9.0.1", taggedAt: LATER },
    { version: "9.0.2", taggedAt: "2026-10-14T08:00:00+08:00" },
  ], "9.0.2", sql);
  if (three.tags !== 3 || three.rows !== 3 || three.recorded.length !== 3 || three.conflicts.length) fail(step, `reported ${JSON.stringify(three)}`);
  const missing = await rowOf(db, "9.0.1");
  if (missing?.summary !== NO_CHANGELOG || missing?.changelog !== NO_CHANGELOG || missing?.client_action !== UNKNOWN_ACTION || missing?.upgrade_notes !== null) {
    fail(step, `the tag with no section was stored as ${JSON.stringify(missing)}`);
  }
  const current = await rowOf(db, "9.0.2");
  if (current?.console_version !== "1.2.0" || current?.client_action !== "Re-pull the plugins." || current?.summary !== "The platform's record of itself.") {
    fail(step, `the current release was stored as ${JSON.stringify(current)}`);
  }
  ok(`${step}: tags ${three.tags}, rows ${three.rows}`);
}

async function main(): Promise<number> {
  try {
    changelogCases();
    await withThrowawayDb(run);
  } catch (err) {
    if (err instanceof Error && /Docker is not running/.test(err.message)) {
      console.error("release-record-db: Docker is not available — the check could not run, which is not a pass");
      return 2;
    }
    console.error(err instanceof CaseFailure ? err.message : `release-record-db: ${String((err as Error)?.stack ?? err)}`);
    return 1;
  }
  console.log("release-record-db: recorded once at its first time, a conflict reported and left as it is, the tags reconciled, " +
              "and every tagged section of this changelog read as a summary: ok");
  return 0;
}

process.exitCode = await main();
