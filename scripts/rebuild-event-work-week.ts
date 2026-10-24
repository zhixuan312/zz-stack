#!/usr/bin/env node
/**
 * Rebuild `zz.event_work_week` from `zz.event`.
 *
 * The read model is maintained by the event write path, which increments a bucket per call. That
 * makes the table repairable only from its source: this script runs the ONE `insert … select` the
 * migration backfilled with — imported from `services/gateway/src/console/event-work-week.ts`
 * rather than retyped, so the rebuild and the backfill cannot come to disagree about the grain —
 * inside one transaction, and it upserts each bucket with what the source says rather than adding
 * to it. A second run on an unchanged source is therefore a no-op, and a run over a drifted table
 * is a repair.
 *
 * Dry run is the default and writes nothing: the backfill runs inside a transaction and is rolled
 * back, after which the model and the raw calls are read as one answer through the same union a
 * console read uses. `--write` is the only path that commits.
 *
 * `--check` answers what neither of those can: whether the model is WRONG, without repairing it.
 * It runs the same rebuild inside a transaction that is always rolled back, compares every bucket
 * the table holds against what the rebuild makes of that source, prints each bucket that disagrees
 * with the field it disagrees on, and exits non-zero when there is one. The comparison is on the
 * four grain columns and the four values the source decides — `calls`, `refusals`, `failed`, `ms`.
 * `built_at` is not one of them: a rebuild is a new build, so its instant is meant to move, and
 * asserting it equal would fail every honest rebuild. A bucket the source has and the table does
 * not is reported as missing, which is the damage `--write` puts back.
 *
 * DELIBERATE: `--check` reads the model through a rebuild it undoes, rather than through a second,
 * read-only copy of the grain written here. The grain is one expression in one place, and a
 * comparison that restated it would pass while the two copies disagreed — which is the drift this
 * mode exists to find.
 *
 * DELIBERATE: only the direction the rebuild can repair is compared. The statement inserts and
 * updates and never removes, so a bucket the source no longer has — its calls deleted — stays in
 * the table and reads identical before and after. Reporting it would name a repair `--write`
 * cannot make.
 *
 * The reporting zone is `ZZ_TZ`, the same variable the gateway cuts weeks by, defaulting to
 * `Asia/Singapore` exactly as `console/shared.ts` does. A deployment that sets it runs this once
 * after the migration, so the backfilled buckets and the ones the live write path makes agree.
 *
 * A real rebuild is an operational act: it writes a table in the deployment's database. This
 * script reads its connection from the environment and never assumes which database that is.
 *
 *   node scripts/rebuild-event-work-week.ts            # runs the statement, rolls it back
 *   node scripts/rebuild-event-work-week.ts --write    # commits it
 *   node scripts/rebuild-event-work-week.ts --check    # says whether the model drifted, writes nothing
 */
import pg from "pg";

import { WEEK_BACKFILL, weekBuckets, type WorkWeekBucket } from "../services/gateway/src/console/event-work-week.ts";

const WRITE = process.argv.includes("--write");
const CHECK = process.argv.includes("--check");
const ZONE = (process.env.ZZ_TZ ?? "").trim() || "Asia/Singapore";
const url = process.env.PLATFORM_DB_URL || process.env.TEAM_DB_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("no PLATFORM_DB_URL / TEAM_DB_URL / DATABASE_URL in the environment");
  process.exit(1);
}
if (WRITE && CHECK) {
  // One of the two modes writes and the other promises not to. Doing either silently would be an
  // operator's `--check` committing a rebuild.
  console.error("pass --check or --write, not both — nothing was done");
  process.exit(1);
}

/** The model and the raw calls as one answer, in the units an operator can check. */
async function census(client: pg.Client): Promise<string> {
  const buckets: WorkWeekBucket[] = await weekBuckets(client, ZONE);
  const calls = buckets.reduce((n, b) => n + b.calls, 0);
  return `${buckets.length} bucket(s) answering ${calls} real-work call(s)`;
}

/** One row of the model at its grain — the four key columns and the four values that are what the
 *  source says. The build metadata is absent on purpose: `built_at` moves on every rebuild, and
 *  `source_revision` names an event rather than counting one, so neither belongs in a comparison
 *  of what the model says about the calls. */
type ModelRow = {
  team_slug: string; week_start: string; tool_key: string; refusal_owner: string;
  calls: number; refusals: number; failed: number; ms: number[];
};

/** Every row the table holds, at that grain. `week_start` is formatted in SQL, because a `date`
 *  arrives from the driver as a JS Date in the reading process's own zone. */
async function modelRows(client: pg.Client): Promise<ModelRow[]> {
  const { rows } = await client.query<ModelRow>(`
    select team_slug,
           to_char(week_start, 'YYYY-MM-DD') as week_start,
           tool_key, refusal_owner, calls, refusals, failed, ms
      from zz.event_work_week
     order by week_start, team_slug, tool_key, refusal_owner`);
  return rows;
}

/** The four values the source decides, each rendered so a difference can be printed as it stands.
 *  `ms` is compared as the whole ascending array, because a rebuild that reproduced the counts and
 *  lost the durations is exactly the failure a comparison of calls alone cannot see. */
const FIELDS: ReadonlyArray<readonly [string, (r: ModelRow) => string]> = [
  ["calls", (r) => String(r.calls)],
  ["refusals", (r) => String(r.refusals)],
  ["failed", (r) => String(r.failed)],
  ["ms", (r) => JSON.stringify(r.ms)],
];

const keyOf = (r: ModelRow): string => JSON.stringify([r.team_slug, r.week_start, r.tool_key, r.refusal_owner]);

/** The bucket as an operator names it: the week, then the three keys. The empty string is the
 *  model's "nothing resolved, no tool, no refusal", so it is spelled out rather than left blank. */
const label = (r: ModelRow): string =>
  `${r.week_start} ${r.team_slug || "(no team)"} / ${r.tool_key || "(no tool)"} / ${r.refusal_owner || "(no owner)"}`;

/** The model as `WEEK_BACKFILL` makes it, read inside a transaction that is always rolled back —
 *  so nothing this function runs survives it, whatever happened. */
async function rebuilt(client: pg.Client): Promise<ModelRow[]> {
  await client.query("begin");
  try {
    await client.query(WEEK_BACKFILL, [ZONE]);
    return await modelRows(client);
  } finally {
    await client.query("rollback").catch(() => { /* the transaction is already gone */ });
  }
}

/** `--check`: print every bucket that disagrees with the source, and answer whether any did. */
async function check(client: pg.Client): Promise<boolean> {
  const held = await modelRows(client);
  const said = await rebuilt(client);
  const have = new Map(held.map((r) => [keyOf(r), r]));
  const wrong: string[] = [];
  // One direction only, and it is not an oversight: `rebuilt` reads the table back after the
  // upsert and the statement removes nothing, so every bucket `held` carries is a bucket `said`
  // carries — with the source's values where the source has calls for it, and untouched where it
  // does not. What this direction finds is a bucket the source has and the table lost, which is
  // the damage `--write` puts back and which comparing the table against itself cannot see.
  for (const want of said) {
    const got = have.get(keyOf(want));
    if (!got) {
      wrong.push(`${label(want)} — missing: the source says ${want.calls} call(s) here and the model holds no row`);
      continue;
    }
    for (const [field, read] of FIELDS) {
      if (read(got) !== read(want)) {
        wrong.push(`${label(want)} — ${field}: the model holds ${read(got)}, the source says ${read(want)}`);
      }
    }
  }
  for (const line of wrong) console.log(line);
  if (wrong.length === 0) {
    console.log(`check: ${said.length} bucket(s) — the model is what the source says, nothing to repair.`);
    return true;
  }
  console.log(`check: ${wrong.length} disagreement(s) in ${said.length} bucket(s) — run with --write to replace them with what the source says.`);
  return false;
}

/** The default: run the rebuild, read the model and the raw calls together, then roll it back
 *  unless `--write`. */
async function rebuild(client: pg.Client): Promise<void> {
  console.log(`before: ${await census(client)}`);
  await client.query("begin");
  await client.query(WEEK_BACKFILL, [ZONE]);
  const stored = (await client.query<{ n: number }>(
    "select count(*)::int as n from zz.event_work_week")).rows[0];
  console.log(`rebuilt: ${stored?.n ?? 0} row(s) in zz.event_work_week, ${await census(client)}`);
  if (WRITE) {
    await client.query("commit");
    console.log("committed — the table is now what the source says.");
  } else {
    await client.query("rollback");
    console.log("nothing written — pass --write to apply.");
  }
}

// One dedicated connection, not a pool: the backfill and the census that follows it must see the
// same transaction, the dry run's rollback must undo exactly what it ran, and `--check`'s rollback
// must leave the table exactly as it found it.
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  console.log(`zone ${ZONE}`);
  if (CHECK) process.exitCode = (await check(client)) ? 0 : 1;
  else await rebuild(client);
} catch (err) {
  await client.query("rollback").catch(() => { /* the transaction is already gone */ });
  throw err;
} finally {
  await client.end();
}
