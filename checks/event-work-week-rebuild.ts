#!/usr/bin/env node
/**
 * checks/event-work-week-rebuild.ts — the read model's rebuild reproduces it on its business keys,
 * and the build metadata it writes besides is present, newer than the build, and a revision of the
 * source rather than a clock (AC-18.1).
 *
 *   node checks/event-work-week-rebuild.ts   # needs Docker and a built tree (`npm run build`)
 *
 * `zz.event_work_week` is `class=projection`: everything it holds is derived from `zz.event`, and
 * `WEEK_BACKFILL` is the one statement that derives it. AC-18.1 asks a check to prove that running
 * that rebuild over a damaged table puts the table back, so this seeds a throwaway, builds the
 * model, damages it the three ways it can be damaged, and holds the rebuild to each in turn:
 *
 *   - a count that is too high, which the update arm must REPLACE rather than add to;
 *   - a bucket deleted, which the insert arm must put back with its counts and its durations;
 *   - an `ms` array emptied, the field a comparison of counts alone cannot see. A rebuild that
 *     reproduced the calls and lost the durations is the failure this case exists for.
 *
 * `built_at` is NOT part of that comparison: a rebuild is a new build, so its instant is meant to
 * move. It is asserted separately and in the other direction — present on every row, and later
 * than the instant the rebuild started, which a rebuild that never ran fails.
 *
 * `source_revision` is `max(id)::text` over the events a bucket absorbed. A count would pass a
 * presence test and a clock would pass a numeric one, so each row's revision is resolved back to
 * its own `zz.event` row and held to it: the event exists, it is a real-work tool call, and its
 * team, week, tool and owner are that bucket's. The week in it is cut outside PostgreSQL, in
 * `Intl`, so the check cannot agree with a wrong cut by computing it with the same expression.
 *
 * `--check` is the driver's read-only mode and the only thing here that drives it: on a model that
 * matches its source it must exit zero and say so, on each of the three damaged tables it must
 * exit non-zero naming that bucket and the field that disagrees, and either way it must leave the
 * table exactly as it found it — asserted, not assumed. The driver's dry run and its `--write` are
 * driven too, so the mode that only reports is proven not to have changed the mode that repairs.
 *
 * Exit 0: every case held — one line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import { withThrowawayDb } from "../scripts/schema/throwaway.ts";

/** The gateway's own built module, loaded the way every route check loads it: the artifact the
 *  gateway serves, not a second copy of the source. */
const load = (rel: string): Promise<unknown> => import(pathToFileURL(join(root, rel)).href);

type Model = { WEEK_BACKFILL: string };

/** One row of the model at its grain: the four key columns and the four values that are what the
 *  source says. The two pieces of build metadata are held separately, because they are asserted
 *  rather than compared. */
type Grain = {
  team_slug: string; week_start: string; tool_key: string; refusal_owner: string;
  calls: number; refusals: number; failed: number; ms: number[];
};
type Stored = Grain & { built_at: Date; source_revision: string };

/** A `zz.event` row a bucket's `source_revision` names, with its team resolved to a slug — the
 *  same resolution `WEEK_BACKFILL` does, read independently of it. */
type Revision = {
  id: string; kind: string; origin: string; ts: Date;
  tool_key: string | null; refusal_owner: string | null; team_slug: string | null;
};

const AUTHOR = "00000000-0000-0000-0000-0000000000a1";
const ALPHA = "00000000-0000-0000-0000-0000000000b1";

/** The grain, as a predicate: the key an operator names a bucket by. */
const KEY = "team_slug = $1 and week_start = $2::date and tool_key = $3 and refusal_owner = $4";

function fail(step: string, detail: string): never {
  throw new Error(`event-work-week-rebuild: FAILED at "${step}": ${detail}`);
}
const ok = (step: string): void => console.log(`  ${step}: ok`);

/** A call the model should hold: `origin` and `kind` are parameters so the two events it must
 *  IGNORE are spelled the same way the ones it must count are. */
type Call = {
  readonly ts: string; readonly ok?: boolean; readonly team?: string | null; readonly tool?: string;
  readonly ms?: number | null; readonly batched?: boolean; readonly owner?: string;
  readonly kind?: string; readonly origin?: string;
};

async function append(client: pg.Client, c: Call): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into zz.event (ts, kind, origin, ok, team_id, tool_key, duration_ms, batched, refusal_owner, subject)
     values ($1::timestamptz, $2::text, $3::text, $4::boolean, $5::uuid, $6::text, $7::integer, $8::boolean,
             $9::text, '')
     returning id::text`,
    [c.ts, c.kind ?? "tool_call", c.origin ?? "work", c.ok ?? true, c.team === undefined ? ALPHA : c.team,
      c.tool ?? "core:a", c.ms ?? null, c.batched ?? false, c.owner ?? null]);
  return rows[0]!.id;
}

/** Every row the model holds: the grain, the values, and the build metadata a `--check` comparison
 *  deliberately leaves out. `week_start` is formatted in SQL, because a `date` arrives from the
 *  driver as a JS Date in the reading process's own zone. */
async function stored(client: pg.Client): Promise<Stored[]> {
  const { rows } = await client.query<Stored>(
    `select team_slug, to_char(week_start, 'YYYY-MM-DD') as week_start, tool_key, refusal_owner,
            calls, refusals, failed, ms, built_at, source_revision
       from zz.event_work_week
      order by week_start, team_slug, tool_key, refusal_owner`);
  return rows;
}

const keyOf = (r: Grain): string => JSON.stringify([r.team_slug, r.week_start, r.tool_key, r.refusal_owner]);
const label = (r: Grain): string =>
  `${r.week_start} ${r.team_slug || "(no team)"} / ${r.tool_key || "(no tool)"} / ${r.refusal_owner || "(no owner)"}`;

/** What the source says about a row, without its build metadata: `built_at` moves on every rebuild
 *  and is not allowed into this comparison. */
const business = (r: Stored): string => JSON.stringify([r.calls, r.refusals, r.failed, r.ms]);

/** Every way `have` differs from `want` on a business key, one line each. */
function diff(want: readonly Stored[], have: readonly Stored[]): string[] {
  const byKey = (rows: readonly Stored[]): Map<string, Stored> => new Map(rows.map((r) => [keyOf(r), r]));
  const [said, held] = [byKey(want), byKey(have)];
  const lines: string[] = [];
  for (const [k, row] of said) {
    const got = held.get(k);
    if (!got) lines.push(`${label(row)} is missing from the model`);
    else if (business(got) !== business(row)) lines.push(`${label(row)} reads ${business(got)}, the source says ${business(row)}`);
  }
  for (const [k, row] of held) if (!said.has(k)) lines.push(`${label(row)} is in the model and not in the source`);
  return lines;
}

/** A Monday in `zone`, from an instant — what the week cut SHOULD say, computed outside PostgreSQL
 *  so the check does not agree with a wrong zone by using the same expression twice. */
function mondayInZone(instant: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(instant);
  const at = (type: string): string => parts.find((p) => p.type === type)!.value;
  const local = new Date(`${at("year")}-${at("month")}-${at("day")}T00:00:00Z`);
  local.setUTCDate(local.getUTCDate() - ((local.getUTCDay() + 6) % 7));
  return local.toISOString().slice(0, 10);
}

type Ran = { status: number | null; out: string };

/** `node scripts/rebuild-event-work-week.ts <args>` against the throwaway this check started, with
 *  the URL handed to it as the environment variable the script reads. The connection is passed to
 *  the child and never set in this process, which is the one thing `withThrowawayDb` refuses. */
function driver(url: string, args: readonly string[]): Ran {
  const r = spawnSync(process.execPath, [join(root, "scripts/rebuild-event-work-week.ts"), ...args], {
    cwd: root, encoding: "utf8", env: { ...process.env, PLATFORM_DB_URL: url },
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const say = (r: Ran): string => (r.status === null ? "was killed by a signal" : `exited ${r.status}`);

async function run(client: pg.Client, url: string): Promise<void> {
  const week = (await load("services/gateway/dist/console/event-work-week.js")) as Model;
  const { ZZ_TZ: zone } = (await load("services/gateway/dist/console/shared.js")) as { ZZ_TZ: string };

  await client.query("insert into zz.principal (id, email) values ($1::uuid, 'check@example.test')", [AUTHOR]);
  await client.query(
    "insert into zz.team (id, slug, name, created_by) values ($1::uuid, 'alpha', 'Alpha', $2::uuid)",
    [ALPHA, AUTHOR]);

  // The frozen input: a bucket whose team did not resolve; a bucket of three calls, two with
  // durations and one batched, whose `ms` is what an emptied array is measured against; a call
  // near midnight that a UTC cut would file a week early; two refusals owned by two owners; and two
  // events the model must ignore.
  await append(client, { ts: "2026-10-12T01:00:00Z", team: null, ms: 33 });
  await append(client, { ts: "2026-10-13T02:00:00Z", ms: 11 });
  await append(client, { ts: "2026-10-13T03:00:00Z", ms: 22 });
  await append(client, { ts: "2026-10-14T04:00:00Z", ms: 999, batched: true });
  await append(client, { ts: "2026-10-18T23:30:00Z", tool: "core:z", ms: 7 });
  await append(client, { ts: "2026-10-20T01:00:00Z", tool: "core:b", ok: false, owner: "theirs" });
  await append(client, { ts: "2026-10-21T01:00:00Z", tool: "core:b", ok: false, owner: "other" });
  await append(client, { ts: "2026-10-21T03:00:00Z", kind: "page_view" });
  await append(client, { ts: "2026-10-21T04:00:00Z", origin: "platform" });

  let step = "the rebuild puts the source into an empty model";
  const empty = await stored(client);
  if (empty.length !== 0) fail(step, `the migrated table holds ${empty.length} row(s) before anything was seeded`);
  await client.query(week.WEEK_BACKFILL, [zone]);
  const truth = await stored(client);
  ok(`${step}: ${truth.length} bucket(s)`);

  // The three damages below each need a different bucket, and the case that empties an `ms` array
  // needs one that has durations in it. An input that cannot tell them apart proves nothing.
  step = "the seed distinguishes the three damages";
  const counted = truth.find((r) => r.team_slug === "alpha" && r.tool_key === "core:a");
  const deleted = truth.find((r) => r.team_slug === "alpha" && r.tool_key === "core:z");
  const emptied = truth.find((r) => r.team_slug === "" && r.tool_key === "core:a");
  if (!counted || counted.calls !== 3) fail(step, `the counted bucket reads ${JSON.stringify(counted?.calls)}, not 3 calls`);
  if (!deleted) fail(step, `no bucket keyed by core:z, so a deleted bucket cannot be told from an absent one`);
  if (!emptied || emptied.ms.length === 0) fail(step, `the bucket whose durations are emptied holds ${JSON.stringify(emptied?.ms)}`);
  if (counted.week_start !== mondayInZone(new Date("2026-10-13T02:00:00Z"), zone)) {
    fail(step, `the counted bucket is filed under ${counted.week_start}, not the week its calls fall in`);
  }
  ok(`${step}: ${truth.length} buckets, the count bucket with 3 calls, durations to empty and a bucket to delete`);

  /** Damage the table, hold `--check` to naming it, then hold the rebuild to repairing it. */
  async function damaged(what: string, sql: string, args: unknown[], names: readonly string[]): Promise<void> {
    await client.query(sql, args);
    const drift = await stored(client);
    const startedAt = (await client.query<{ t: Date }>("select now() as t")).rows[0]!.t;

    const said = driver(url, ["--check"]);
    if (said.status !== 1) {
      fail(what, `--check ${say(said)} on a damaged model, and it must exit 1 so an operator sees drift:\n${said.out}`);
    }
    for (const name of names) {
      if (!said.out.includes(name)) {
        fail(what, `--check exited 1 but its report does not name ${JSON.stringify(name)}:\n${said.out}`);
      }
    }
    const untouched = await stored(client);
    if (JSON.stringify(untouched) !== JSON.stringify(drift)) {
      fail(what, "--check changed the model, and that mode may only read:\n" +
        `  before ${JSON.stringify(drift)}\n  after  ${JSON.stringify(untouched)}`);
    }

    await client.query(week.WEEK_BACKFILL, [zone]);
    const repaired = await stored(client);
    const wrong = diff(truth, repaired);
    if (wrong.length) fail(what, `the rebuild did not put the table back:\n  ${wrong.join("\n  ")}`);
    const metadata = await buildMetadata(client, repaired, startedAt, zone);
    if (metadata.length) fail(what, `the rebuild wrote ${metadata.length} row(s) of build metadata it should not have:\n  ${metadata.join("\n  ")}`);
    ok(`${what}: --check named ${names.join(" and ")}, wrote nothing, and the rebuild restored the bucket`);
  }

  await damaged("a count that is too high is replaced, not added to",
    `update zz.event_work_week set calls = calls + 5 where ${KEY}`, bucket(counted),
    [label(counted), "calls"]);

  await damaged("a bucket the source has is put back with its counts and its durations",
    `delete from zz.event_work_week where ${KEY}`, bucket(deleted),
    [label(deleted), "missing"]);

  await damaged("a bucket whose durations were emptied is rebuilt with them",
    `update zz.event_work_week set ms = '{}'::integer[] where ${KEY}`, bucket(emptied),
    [label(emptied), "ms"]);

  step = "--check says a model that matches its source needs no repair";
  const clean = driver(url, ["--check"]);
  if (clean.status !== 0) fail(step, `--check ${say(clean)} on a model the rebuild just wrote:\n${clean.out}`);
  if (!clean.out.includes("the model is what the source says")) {
    fail(step, `--check exited 0 without saying the model is what the source says:\n${clean.out}`);
  }
  ok(`${step}: ${clean.out.trim().split("\n").pop()}`);

  step = "a second rebuild on an unchanged source changes no business value";
  const before = await stored(client);
  await client.query(week.WEEK_BACKFILL, [zone]);
  const twice = await stored(client);
  const moved = diff(before, twice);
  if (moved.length) fail(step, `the second rebuild changed the model:\n  ${moved.join("\n  ")}`);
  ok(`${step}: ${twice.length} bucket(s), the same counts, durations and keys`);

  step = "the dry run still rolls its rebuild back and writes nothing";
  const dry = driver(url, []);
  if (dry.status !== 0) fail(step, `the dry run ${say(dry)}:\n${dry.out}`);
  if (!dry.out.includes("nothing written — pass --write to apply.")) {
    fail(step, `the dry run no longer says it wrote nothing:\n${dry.out}`);
  }
  const afterDry = await stored(client);
  if (JSON.stringify(afterDry) !== JSON.stringify(twice)) fail(step, "the dry run changed the model");

  step = "--write still commits the rebuild, and the table is what the source says afterwards";
  await client.query(`update zz.event_work_week set calls = calls + 5, ms = '{}'::integer[] where ${KEY}`,
    bucket(counted));
  const wrote = driver(url, ["--write"]);
  if (wrote.status !== 0) fail(step, `--write ${say(wrote)}:\n${wrote.out}`);
  if (!wrote.out.includes("committed")) fail(step, `--write no longer reports that it committed:\n${wrote.out}`);
  const applied = diff(truth, await stored(client));
  if (applied.length) fail(step, `--write committed a table that is not what the source says:\n  ${applied.join("\n  ")}`);
  ok(`${step}: it repaired the drifted bucket and committed`);

  step = "--check and --write together are refused rather than silently doing one of them";
  const both = await stored(client);
  const mixed = driver(url, ["--check", "--write"]);
  if (mixed.status !== 1) fail(step, `passing both ${say(mixed)}, and it must exit 1:\n${mixed.out}`);
  if (JSON.stringify(await stored(client)) !== JSON.stringify(both)) fail(step, "it changed the model anyway");
  ok(`${step}: it exited 1 and touched nothing`);
}

/** The key columns of a bucket, as the parameters `KEY` binds. */
const bucket = (r: Grain): string[] => [r.team_slug, r.week_start, r.tool_key, r.refusal_owner];

/**
 * What the build metadata must be, for every row the rebuild wrote: `built_at` present and later
 * than `startedAt` — a rebuild that never ran leaves the old instant — and `source_revision` an
 * id of a real-work tool call no newer than the newest the rebuild read, whose own key is the
 * bucket it sits on. A clock passes a numeric test and a count can pass a presence one; resolving
 * the id back to the event it names is what tells them apart.
 */
async function buildMetadata(client: pg.Client, rows: readonly Stored[], startedAt: Date, zone: string): Promise<string[]> {
  const newest = (await client.query<{ n: string }>(
    `select coalesce(max(id), 0)::text as n from zz.event
      where kind = 'tool_call' and origin = 'work'`)).rows[0]!.n;
  const ids = [...new Set(rows.map((r) => r.source_revision))].filter((id) => /^\d+$/.test(id));
  const { rows: named } = await client.query<Revision>(
    `select e.id::text as id, e.kind, e.origin, e.ts, e.tool_key, e.refusal_owner, t.slug as team_slug
       from zz.event e
       left join zz.team t on t.id = e.team_id
      where e.id = any($1::bigint[])`, [ids.length ? ids : ["0"]]);
  const byId = new Map(named.map((e) => [e.id, e]));

  const problems: string[] = [];
  for (const r of rows) {
    const at = label(r);
    if (!(r.built_at instanceof Date) || Number.isNaN(r.built_at.getTime())) {
      problems.push(`${at} — built_at is ${JSON.stringify(r.built_at)}, and every row carries one`);
      continue;
    }
    if (!(r.built_at.getTime() > startedAt.getTime())) {
      problems.push(`${at} — built_at ${r.built_at.toISOString()} did not move past ${startedAt.toISOString()}, ` +
        "which is a rebuild that did not run");
    }
    if (r.source_revision === null || r.source_revision === "") {
      problems.push(`${at} — source_revision is empty, and every row carries one`);
      continue;
    }
    if (!/^\d+$/.test(r.source_revision)) {
      problems.push(`${at} — source_revision ${JSON.stringify(r.source_revision)} is not a zz.event id`);
      continue;
    }
    if (Number(r.source_revision) > Number(newest)) {
      problems.push(`${at} — source_revision ${r.source_revision} is newer than ${newest}, the newest event the rebuild read`);
    }
    const e = byId.get(r.source_revision);
    if (!e) {
      problems.push(`${at} — source_revision ${r.source_revision} names no zz.event row`);
      continue;
    }
    if (e.kind !== "tool_call" || e.origin !== "work") {
      problems.push(`${at} — source_revision ${r.source_revision} names a ${e.kind}/${e.origin} event, not a real-work call`);
    }
    const own = JSON.stringify([e.team_slug ?? "", mondayInZone(e.ts, zone), e.tool_key ?? "", e.refusal_owner ?? ""]);
    if (own !== keyOf(r)) {
      problems.push(`${at} — source_revision ${r.source_revision} names an event of ${own}, not of this bucket`);
    }
  }
  return problems;
}

function dockerUnavailable(err: unknown): boolean {
  return err instanceof Error && /Docker is not running/.test(err.message);
}

async function main(): Promise<number> {
  let url = "";
  try {
    await withThrowawayDb((client) => run(client, url), async (minted) => { url = minted; });
  } catch (err) {
    if (dockerUnavailable(err)) {
      console.error("event-work-week-rebuild: Docker is not available — the check could not run, and that is not a pass");
      return 2;
    }
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    return 1;
  }
  console.log("event-work-week-rebuild: the rebuild puts every business key and value back from the source, "
    + "leaves built_at to move and source_revision naming the event it counted, and --check sees each of the "
    + "three damages without writing anything");
  return 0;
}

process.exitCode = await main();
