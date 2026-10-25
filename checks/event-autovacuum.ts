#!/usr/bin/env node
/**
 * checks/event-autovacuum.ts — `zz.event` carries per-table autovacuum settings tighter than the
 * defaults, and the heap fetches its index-only scans pay fall once the vacuum they schedule runs.
 *
 *   node checks/event-autovacuum.ts   # needs Docker; exit 2 without it
 *
 * `zz.event` is the one table every console figure reduces, and the covering index
 * `event_work_agg (ts) INCLUDE (…) WHERE kind = 'tool_call' AND origin = 'work'` exists so those
 * reductions can be answered from the index alone. An index-only scan is only index-only where the
 * visibility map says a page is all-visible: a page with one recently written tuple sends the scan
 * to the heap for every tuple on it. The table's autovacuum scale factors decide how much churn
 * happens between two vacuums, so they decide that ratio — and the per-table values are the only
 * lever, because the global ones are the whole database's.
 *
 * Two arms, and only the first can be red before Task I-24. That asymmetry is the plan's, and it is
 * honest: settings are what make autovacuum run sooner, and whether a vacuum was run cannot be
 * asserted by a check that runs it itself.
 *
 *   (1) THE SETTINGS ARE THERE AND ARE TIGHTER THAN THE DEFAULTS. Read from `pg_class.reloptions` on
 *   a throwaway migrated by the real runner — from the database, not from a file, because
 *   `TableTarget` (`scripts/schema/types.ts:26`) has no `reloptions` field and the migration is the
 *   only place they exist. Both scale factors must be present AND below PostgreSQL's defaults (0.2
 *   vacuum, 0.1 analyze): a migration that writes the default value explicitly changes nothing and
 *   would otherwise satisfy "the settings are what the migration wrote", which is the shape of
 *   green-by-restatement this arm exists to refuse.
 *
 *   (2) THE RATIO MOVES UNDER A NAMED LOAD. The load is stated here rather than described: 40,000
 *   real-work events and 15,000 others, ONE VACUUM standing in for the last autovacuum, then 1,500
 *   inserted and 1,000 updated since it — the state a ratio is interesting in, because everything
 *   the first vacuum covered is all-visible and the churn is not. The reduction is read with
 *   `EXPLAIN (ANALYZE, BUFFERS)` there, the vacuum autovacuum would have run is run by hand, and the
 *   same statement is read again on the same table. Both ratios are printed and the second must be
 *   lower.
 *
 * DELIBERATE: the ratio is `Heap Fetches` over the rows the Index Only Scan returned, both read off
 * the same plan node — not a wall-clock comparison, which flutters with the cache, and not a claim
 * that the ratio is zero. Any insert or update clears a visibility-map bit, so zero is a test
 * state and never a production invariant; what the AC asks for is a ratio under a named load.
 *
 * DELIBERATE: the vacuum is run by this check and not waited for. Autovacuum is asynchronous, so a
 * check that slept for it would fail on a busy machine and pass on an idle one for reasons unrelated
 * to the settings. Arm 2 is therefore a post-condition of the vacuum, and arm 1 is what holds the
 * thing that decides when autovacuum takes it.
 *
 * Exit 0: both arms held. Exit 1: an arm failed, quoting what it read. Exit 2: Docker is not
 * available, so neither arm could run — not a pass, and not a failure either.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();

/** PostgreSQL's own defaults, from `pg_settings`. A per-table value at or above these is a value
 *  that changed nothing, and the AC is about settings that LOWER the ratio. */
const DEFAULTS = { autovacuum_vacuum_scale_factor: 0.2, autovacuum_analyze_scale_factor: 0.1 };
const REQUIRED = Object.keys(DEFAULTS);

/** The load, stated rather than described. A first batch and some non-real-work rows build a table
 *  the partial index is worth reading; ONE VACUUM THEN STANDS IN FOR the last autovacuum; and the
 *  churn below is what has been written since it, which is the state a ratio is interesting in. */
const SEEDED = 40_000;
const OTHER = 15_000;
const CHURN_INSERTED = 1_500;
const CHURN_UPDATED = 1_000;

/** The reduction the ratio is read from: the register's own population — real-work tool calls —
 *  over a `ts` window, answered from `event_work_agg`'s key and its INCLUDE columns, so the plan is
 *  an Index Only Scan and the `Heap Fetches` line is the one an operator would read. */
const REDUCTION = `select count(*) as calls, count(*) filter (where ok) as ok, sum(duration_ms) as ms
                     from zz.event
                    where kind = 'tool_call' and origin = 'work' and ts >= $1 and ts < $2`;

interface Ratio { rows: number; heapFetches: number; buffers: number; node: string; plan: string[] }

/** The Index Only Scan's own line, and the figures on it. `rows=` on that node is what the scan
 *  returned; `Heap Fetches` is how many of those it had to go to the heap for. */
function ratioOf(plan: string[]): Ratio | null {
  const at = plan.findIndex((l) => /Index Only Scan/.test(l));
  if (at < 0) return null;
  const line = plan[at];
  const rows = Number(line.match(/rows=(\d+)/)?.[1] ?? "-1");
  const heap = plan.slice(at).find((l) => /Heap Fetches:/.test(l));
  const heapFetches = Number(heap?.match(/Heap Fetches:\s*(\d+)/)?.[1] ?? "-1");
  const buffers = plan.slice(at).find((l) => /Buffers:/.test(l));
  let total = 0;
  for (const [, key, n] of (buffers ?? "").matchAll(/(\w+)=(\d+)/g)) {
    if (key === "hit" || key === "read") total += Number(n);
  }
  return { rows, heapFetches, buffers: total, node: line.trim(), plan };
}

const show = (r: Ratio): string =>
  `${r.heapFetches} heap fetches over ${r.rows} rows (${r.rows > 0 ? ((r.heapFetches / r.rows) * 100).toFixed(1) : "n/a"}%), ` +
  `${r.buffers} buffers`;

async function main(): Promise<number> {
  type Throwaway = typeof import("../scripts/schema/throwaway.ts");
  const { withThrowawayDb }: Throwaway =
    await import(pathToFileURL(join(root, "scripts/schema/throwaway.ts")).href) as Throwaway;

  const fail: string[] = [];

  await withThrowawayDb(async (client) => {
    await client.query("set search_path = zz, public");

    // ── (1) the settings, read from the catalog.
    const { rows } = await client.query<{ reloptions: string[] | null }>(
      `select reloptions from pg_class
        where relname = 'event' and relnamespace = 'zz'::regnamespace`,
    );
    const options = rows[0]?.reloptions ?? null;
    if (options === null) {
      fail.push("FAILED at \"the settings are there and are tighter than the defaults\": " +
        "zz.event carries no reloptions on a database migrated from this tree — the per-table " +
        "settings are the task's whole deliverable and no migration applies them");
      return;
    }
    const got = new Map(options.map((o) => { const [k, v] = o.split("="); return [k, Number(v)]; }));
    for (const key of REQUIRED) {
      const value = got.get(key);
      if (value === undefined) {
        fail.push(`FAILED at "the settings are there and are tighter than the defaults": ` +
          `zz.event's reloptions do not carry ${key} — got {${options.join(", ")}}`);
      } else if (!(value < (DEFAULTS as Record<string, number>)[key])) {
        fail.push(`FAILED at "the settings are there and are tighter than the defaults": ` +
          `zz.event sets ${key}=${value}, and PostgreSQL's default is already ` +
          `${(DEFAULTS as Record<string, number>)[key]} — a setting written at the default value ` +
          `changes nothing, and the criterion is a ratio that falls`);
      }
    }
    if (fail.length > 0) return;
    const insertThreshold = got.get("autovacuum_vacuum_insert_threshold");
    console.log(`ok  zz.event carries ${options.join(", ")}` +
      `${insertThreshold === undefined ? " (no insert threshold, and the measurement did not ask for one)" : ""}` +
      `, each tighter than the default`);

    // ── (2) the ratio, under the stated load.
    //
    // The daemon is switched off for the measurement and only for it. Arm 1 has already read the
    // settings the migration wrote, and 10,000 updates on a table with a tight scale factor is
    // exactly what autovacuum would wake for — a `before` measured after it had fired would already
    // be clean, and `after < before` would then fail on a busy machine for no reason but timing.
    // The key is removed again at the end, so what the catalog holds is what the migration wrote.
    await client.query("alter table zz.event set (autovacuum_enabled = false)");
    const base = new Date("2026-01-05T00:00:00.000Z");
    // The payload is padded and incompressible on purpose. `zz.event.detail` carries real jsonb on
    // this deployment, and a narrow synthetic row makes the heap small enough that a sequential
    // scan wins on a throwaway whatever the visibility map says — which would measure PostgreSQL's
    // cost model on a toy table and never reach an index-only plan at all.
    // Each batch starts where the last one ended, so every row has its own second and the window
    // below covers all of them — an offset that overlapped would put churn rows inside the seed's
    // timestamps and leave the scan's row count disagreeing with the load it claims to describe.
    const insert = (count: number, kind: string, atSecond: number): Promise<unknown> => client.query(
      `insert into zz.event (ts, kind, origin, ok, subject, detail, session, tool_key, duration_ms, batched)
       select $1::timestamptz + (($3 + n) || ' seconds')::interval, $4, 'work',
              (n % 10) <> 0, 'seed', jsonb_build_object('pad', repeat(md5((n + $3)::text), 40)),
              'seed-' || (n % 40), 'tool-' || (n % 7), 40 + (n % 400), (n % 5) = 0
         from generate_series(1, $2::int) as n`,
      [base.toISOString(), count, atSecond, kind],
    );
    await insert(SEEDED, "tool_call", 0);
    // Rows the partial index does not carry, so the index is a smaller thing to read than the heap
    // — which is the condition under which an index-only scan is chosen at all.
    await insert(OTHER, "document.shown", SEEDED);
    await client.query("vacuum (analyze) zz.event");

    // The churn since that vacuum: the rows whose visibility-map bits are not set.
    await insert(CHURN_INSERTED, "tool_call", SEEDED + OTHER);
    await client.query(
      `update zz.event set ok = not ok
        where kind = 'tool_call' and id in (select id from zz.event where kind = 'tool_call'
                                             order by id limit $1)`,
      [CHURN_UPDATED],
    );
    // Statistics, not visibility: `ANALYZE` sets no visibility-map bit, so both plans below are
    // costed on the same distribution and the only thing that differs is what the scan must fetch.
    await client.query("analyze zz.event");

    const from = base.toISOString();
    const to = new Date(base.getTime() + (SEEDED + OTHER + CHURN_INSERTED + 10) * 1000).toISOString();

    const explain = async (): Promise<Ratio | null> =>
      ratioOf((await client.query(`explain (analyze, buffers) ${REDUCTION}`, [from, to])).rows
        .map((r: Record<string, string>) => r["QUERY PLAN"]));

    const before = await explain();
    if (before === null) {
      fail.push("FAILED at \"the ratio moves under a named load\": the reduction is not answered " +
        "by an Index Only Scan on this tree, so there is no heap-fetch ratio to read — " +
        "`event_work_agg` is the index that makes it one");
      return;
    }

    await client.query("vacuum (analyze) zz.event");
    await client.query("alter table zz.event reset (autovacuum_enabled)");

    const after = await explain();
    if (after === null) {
      fail.push("FAILED at \"the ratio moves under a named load\": after the vacuum the reduction " +
        "stopped being an Index Only Scan — the plan changed under the same statement");
      return;
    }

    console.log(`  the load: ${SEEDED.toLocaleString("en-US")} real-work events and ` +
      `${OTHER.toLocaleString("en-US")} others, one vacuum, then ` +
      `${CHURN_INSERTED.toLocaleString("en-US")} inserted and ` +
      `${CHURN_UPDATED.toLocaleString("en-US")} updated since it`);
    console.log(`  before the vacuum: ${show(before)}`);
    console.log(`  after it:          ${show(after)}`);
    if (!(after.heapFetches < before.heapFetches)) {
      fail.push(`FAILED at "the ratio moves under a named load": the scan paid ` +
        `${before.heapFetches} heap fetches before the vacuum and ${after.heapFetches} after it — ` +
        `a vacuum that does not move the ratio means the scan is not reading the visibility map ` +
        `at all, and no setting will change what it costs`);
      return;
    }
    console.log(`ok  the vacuum the settings schedule takes the ratio from ` +
      `${((before.heapFetches / Math.max(before.rows, 1)) * 100).toFixed(1)}% to ` +
      `${((after.heapFetches / Math.max(after.rows, 1)) * 100).toFixed(1)}%`);
    // And what the two arms mean together: autovacuum vacuums once dead tuples reach the threshold
    // plus the scale factor times the rows, so a tight scale factor is what keeps the churn above
    // small — which is the ratio arm 2 measured falling.
    const total = SEEDED + OTHER + CHURN_INSERTED;
    const due = (scale: number): number => Math.ceil(50 + scale * total);
    const vacuumFactor = got.get("autovacuum_vacuum_scale_factor") as number;
    console.log(`  these settings make it due at ${due(vacuumFactor).toLocaleString("en-US")} dead ` +
      `tuples on a table this size, where the default ${DEFAULTS.autovacuum_vacuum_scale_factor} ` +
      `waits for ${due(DEFAULTS.autovacuum_vacuum_scale_factor).toLocaleString("en-US")}`);
  });

  if (fail.length > 0) { console.error(fail.join("\n")); return 1; }
  console.log("event autovacuum: zz.event's per-table settings are tighter than the defaults, and " +
    "the heap fetches its index-only scan pays fall once the vacuum they schedule has run.");
  return 0;
}

try {
  process.exitCode = await main();
} catch (err) {
  if (err instanceof Error && /Docker is not running/.test(err.message)) {
    console.error("event-autovacuum: Docker is not available — the gate requires Docker to run this check");
    process.exit(2);
  }
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
}
