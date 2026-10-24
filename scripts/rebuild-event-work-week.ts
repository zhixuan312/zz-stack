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
 * The reporting zone is `ZZ_TZ`, the same variable the gateway cuts weeks by, defaulting to
 * `Asia/Singapore` exactly as `console/shared.ts` does. A deployment that sets it runs this once
 * after the migration, so the backfilled buckets and the ones the live write path makes agree.
 *
 * A real rebuild is an operational act: it writes a table in the deployment's database. This
 * script reads its connection from the environment and never assumes which database that is.
 *
 *   node scripts/rebuild-event-work-week.ts            # runs the statement, rolls it back
 *   node scripts/rebuild-event-work-week.ts --write    # commits it
 */
import pg from "pg";

import { WEEK_BACKFILL, weekBuckets, type WorkWeekBucket } from "../services/gateway/src/console/event-work-week.ts";

const WRITE = process.argv.includes("--write");
const ZONE = (process.env.ZZ_TZ ?? "").trim() || "Asia/Singapore";
const url = process.env.PLATFORM_DB_URL || process.env.TEAM_DB_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("no PLATFORM_DB_URL / TEAM_DB_URL / DATABASE_URL in the environment");
  process.exit(1);
}

/** The model and the raw calls as one answer, in the units an operator can check. */
async function census(client: pg.Client): Promise<string> {
  const buckets: WorkWeekBucket[] = await weekBuckets(client, ZONE);
  const calls = buckets.reduce((n, b) => n + b.calls, 0);
  return `${buckets.length} bucket(s) answering ${calls} real-work call(s)`;
}

// One dedicated connection, not a pool: the backfill and the census that follows it must see the
// same transaction, and the dry run's rollback must undo exactly what it ran.
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  console.log(`zone ${ZONE}`);
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
} catch (err) {
  await client.query("rollback").catch(() => { /* the transaction is already gone */ });
  throw err;
} finally {
  await client.end();
}
