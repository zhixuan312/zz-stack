#!/usr/bin/env node
/**
 * checks/event-work-week.ts — the gate's guard that `zz.event_work_week` answers what the statement it
 * replaces answers, and that the model and the raw table compose without a gap or an overlap.
 *
 *   node checks/event-work-week.ts   # migrates a throwaway container, seeds a frozen input, compares
 *
 * The model exists so a whole-history reduction stops reading every call. That trade is only sound if
 * two things hold, and neither is visible from a type: every event contributes to exactly ONE row, and
 * a read that unions the model with the raw tail counts every call once — no call dropped between the
 * halves, none counted in both.
 *
 * The comparison is at the model's own grain, `(team_slug, week_start, tool_key, refusal_owner)`,
 * against ONE raw statement over `zz.event`. Rolling the grain up would hide a wrong key behind a
 * right total, so the three roll-ups the plan names (calls by week and team, calls by tool and week
 * with their median, calls by refusal owner) are derived from rows already proven equal, not instead
 * of proving them.
 *
 * Exit 0: every case agrees — one summary line.
 * Exit 1: one or more disagreements — one line each, then a non-zero exit.
 * Exit 2: Docker is not available — the throwaway path cannot run, and that is not a pass.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import { withThrowawayDb } from "../scripts/schema/throwaway.ts";

/** The gateway's own built module, loaded the way every route check loads it: the artifact the gateway
 *  serves, not a second copy of the source. */
const load = (rel: string): Promise<unknown> => import(pathToFileURL(join(root, rel)).href);

type Model = {
  WEEK_BACKFILL: string;
  WEEK_RECORD: string;
  weekBuckets: (db: pg.Client, zone: string) => Promise<Bucket[]>;
};

type Bucket = {
  team_slug: string; week_start: string; tool_key: string; refusal_owner: string;
  calls: number; refusals: number; failed: number; ms: number[];
};

/** One row of the model's grain, as either statement renders it. `ms` is ascending on both sides, so
 *  comparing the arrays compares the exact population both medians are taken over. */
type Grain = {
  team_slug: string; week_start: string; tool_key: string; refusal_owner: string;
  calls: number; refusals: number; failed: number; ms: number[];
};

const ALPHA = "00000000-0000-0000-0000-0000000000b1";
const AUTHOR = "00000000-0000-0000-0000-0000000000a1";

/** A call the model should hold: `origin` and `kind` are parameters so the two events it must IGNORE
 *  are spelled the same way the ones it must count are. */
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

/** The raw statement the model replaces, at the model's grain. DELIBERATE: one statement rather than
 *  three, because the three roll-ups are consequences of this one and a wrong key hides behind a right
 *  total the moment they are the only comparison. */
async function raw(client: pg.Client, zone: string): Promise<Grain[]> {
  const { rows } = await client.query<Grain>(
    `select coalesce(t.slug, '') as team_slug,
            to_char((date_trunc('week', e.ts at time zone $1::text))::date, 'YYYY-MM-DD') as week_start,
            coalesce(e.tool_key, '') as tool_key,
            coalesce(e.refusal_owner, '') as refusal_owner,
            count(*)::int as calls,
            (count(*) filter (where e.refusal_owner is not null))::int as refusals,
            (count(*) filter (where e.ok is false))::int as failed,
            coalesce(array_agg(e.duration_ms order by e.duration_ms)
                     filter (where e.batched = false and e.duration_ms is not null), '{}'::integer[]) as ms
       from zz.event e
       left join zz.team t on t.id = e.team_id
      where e.kind = 'tool_call' and e.origin = 'work'
      group by 1, 2, 3, 4
      order by 1, 2, 3, 4`, [zone]);
  return rows;
}

/** The model as the same shape. A `date` arrives from the driver as a JS Date in the reading process's
 *  own zone, so it is formatted in SQL — the same reason `weekBuckets` does. */
async function model(client: pg.Client): Promise<Grain[]> {
  const { rows } = await client.query<Grain>(
    `select team_slug, to_char(week_start, 'YYYY-MM-DD') as week_start, tool_key, refusal_owner,
            calls, refusals, failed, ms
       from zz.event_work_week
      order by 1, 2, 3, 4`);
  return rows;
}

const keyOf = (g: Grain): string => `${g.week_start}/${g.team_slug}/${g.tool_key}/${g.refusal_owner}`;

/** A Monday in `zone`, from an instant — what the week cut SHOULD say, computed outside PostgreSQL so
 *  the check does not agree with a wrong zone by using the same expression twice. */
function mondayInZone(instant: string, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(instant));
  const at = (type: string): string => parts.find((p) => p.type === type)!.value;
  const local = new Date(`${at("year")}-${at("month")}-${at("day")}T00:00:00Z`);
  local.setUTCDate(local.getUTCDate() - ((local.getUTCDay() + 6) % 7));
  return local.toISOString().slice(0, 10);
}

/** `percentile_cont(0.5)` over an ascending array, interpolated exactly as PostgreSQL interpolates it,
 *  rounded the same way — so a median computed from merged model arrays is comparable with a median
 *  computed by the raw statement. */
function median(ms: readonly number[]): number | null {
  if (ms.length === 0) return null;
  const rank = 0.5 * (ms.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return Math.round(ms[lo]! + (rank - lo) * (ms[hi]! - ms[lo]!));
}

function merge(into: number[], add: readonly number[]): number[] {
  return [...into, ...add].sort((a, b) => a - b);
}

async function run(client: pg.Client): Promise<string[]> {
  const week = (await load("services/gateway/dist/console/event-work-week.js")) as Model;
  const { ZZ_TZ: zone } = (await load("services/gateway/dist/console/shared.js")) as { ZZ_TZ: string };
  const problems: string[] = [];
  const say = (ok: boolean, what: string, detail: string): void => {
    if (!ok) problems.push(`${what} — ${detail}`);
  };

  await client.query("insert into zz.principal (id, email) values ($1::uuid, 'check@example.test')", [AUTHOR]);
  await client.query(
    "insert into zz.team (id, slug, name, created_by) values ($1::uuid, 'alpha', 'Alpha', $2::uuid)",
    [ALPHA, AUTHOR]);

  // The frozen input: a call whose team did not resolve, two calls in one week with durations, one
  // batched call, one refusal owned by each of two owners, and two calls the model must ignore.
  await append(client, { ts: "2026-10-12T01:00:00Z", team: null, ms: 11 });          // no team resolved
  await append(client, { ts: "2026-10-13T02:00:00Z", ms: 22 });
  await append(client, { ts: "2026-10-13T03:00:00Z", ms: 33 });
  await append(client, { ts: "2026-10-14T04:00:00Z", ms: 999, batched: true });       // a batch's duration
  await append(client, { ts: "2026-10-20T01:00:00Z", tool: "core:b", ok: false, owner: "theirs" });
  await append(client, { ts: "2026-10-21T01:00:00Z", tool: "core:b", ok: false, owner: "other" });
  await append(client, { ts: "2026-10-21T02:00:00Z", tool: "core:b", ok: false, owner: "other" });
  await append(client, { ts: "2026-10-21T03:00:00Z", kind: "page_view", origin: "work" });  // a page view
  await append(client, { ts: "2026-10-21T04:00:00Z", origin: "platform" });                 // maintenance
  // A Sunday-night instant that is Monday morning in the deployment's zone: a UTC cut files it a week
  // early, which is the whole reason the model is cut in `ZZ_TZ`.
  const across = "2026-10-18T23:30:00Z";
  await append(client, { ts: across, tool: "core:z", ms: 7 });

  // AC-16.3, first case: one call at t, another at t+100 s. The model absorbs the first only, and a
  // read must still answer 2 — the raw tail is what covers the second.
  const first = await append(client, { ts: "2026-10-22T02:00:00Z", tool: "core:c", ms: 5 });
  await append(client, { ts: "2026-10-22T02:01:40Z", tool: "core:c", ms: 7 });
  await client.query(week.WEEK_RECORD, [first, zone]);
  const afterFirst = (await week.weekBuckets(client, zone)).find((b) => b.tool_key === "core:c");
  say(afterFirst?.calls === 2, "a call the model has not absorbed is answered by the raw tail",
    `expected 2 for core:c, read ${afterFirst?.calls ?? "no row"}`);
  say(JSON.stringify(afterFirst?.ms) === "[5,7]", "the tail's duration merges into the ascending array",
    `expected [5,7], read ${JSON.stringify(afterFirst?.ms)}`);

  // AC-16.3, second case: steady traffic every 30 s never turns a bucket old, and the whole week still
  // answers — the boundary is the watermark, not the bucket's age.
  const steady: string[] = [];
  for (let i = 0; i < 10; i++) {
    steady.push(await append(client, {
      ts: new Date(Date.parse("2026-10-23T00:00:00Z") + i * 30_000).toISOString(), tool: "core:d", ms: 100 + i,
    }));
  }
  for (const id of steady) await client.query(week.WEEK_RECORD, [id, zone]);
  const steadyRead = (await week.weekBuckets(client, zone)).find((b) => b.tool_key === "core:d");
  say(steadyRead?.calls === 10, "a bucket receiving traffic every 30 s answers its whole week",
    `expected 10 for core:d, read ${steadyRead?.calls ?? "no row"}`);

  // The backfill absorbs everything, so the comparison below is the model's own statement against the
  // raw one — and the two write-path cases above are re-read through it rather than trusted.
  await client.query(week.WEEK_BACKFILL, [zone]);

  const rawRows = await raw(client, zone);
  const modelRows = await model(client);
  const rawBy = new Map(rawRows.map((r) => [keyOf(r), r]));
  const modelBy = new Map(modelRows.map((r) => [keyOf(r), r]));
  const onlyRaw = [...rawBy.keys()].filter((k) => !modelBy.has(k));
  const onlyModel = [...modelBy.keys()].filter((k) => !rawBy.has(k));
  say(onlyRaw.length === 0, "every key the raw table has, the model has", `missing ${onlyRaw.join(", ")}`);
  say(onlyModel.length === 0, "every key the model has, the raw table has", `extra ${onlyModel.join(", ")}`);
  for (const [k, r] of rawBy) {
    const m = modelBy.get(k);
    if (!m) continue;
    say(m.calls === r.calls && m.refusals === r.refusals && m.failed === r.failed && m.team_slug === r.team_slug
      && m.week_start === r.week_start && m.tool_key === r.tool_key && m.refusal_owner === r.refusal_owner,
      `the model's counts equal the raw statement for ${k}`,
      `raw ${r.calls}/${r.refusals}/${r.failed}, model ${m.calls}/${m.refusals}/${m.failed}`);
    say(JSON.stringify(m.ms) === JSON.stringify(r.ms), `the model's durations equal the raw statement for ${k}`,
      `raw ${JSON.stringify(r.ms)}, model ${JSON.stringify(m.ms)}`);
  }

  // Each event contributes to exactly one row: the calls over the whole model are the real-work calls.
  const { rows: total } = await client.query<{ calls: number; raw: number }>(
    `select (select coalesce(sum(calls), 0)::int from zz.event_work_week) as calls,
            (select count(*)::int from zz.event e where e.kind = 'tool_call' and e.origin = 'work') as raw`);
  say(total[0]!.calls === total[0]!.raw, "each event contributes to exactly one row",
    `the model sums to ${total[0]!.calls}, the raw table holds ${total[0]!.raw}`);

  // The three roll-ups the plan names, each derived from rows already proven equal.
  const byTeamWeek = new Map<string, number>();
  const byToolWeek = new Map<string, { calls: number; ms: number[] }>();
  const byOwner = new Map<string, number>();
  for (const r of modelRows) {
    const tw = `${r.week_start}/${r.team_slug}`;
    byTeamWeek.set(tw, (byTeamWeek.get(tw) ?? 0) + r.calls);
    const wo = `${r.week_start}/${r.tool_key}`;
    const at = byToolWeek.get(wo) ?? { calls: 0, ms: [] };
    byToolWeek.set(wo, { calls: at.calls + r.calls, ms: merge(at.ms, r.ms) });
    if (r.refusal_owner !== "") byOwner.set(r.refusal_owner, (byOwner.get(r.refusal_owner) ?? 0) + r.refusals);
  }
  const rawTeamWeek = new Map<string, number>();
  const rawToolWeek = new Map<string, { calls: number; ms: number[] }>();
  const rawOwner = new Map<string, number>();
  for (const r of rawRows) {
    const tw = `${r.week_start}/${r.team_slug}`;
    rawTeamWeek.set(tw, (rawTeamWeek.get(tw) ?? 0) + r.calls);
    const wo = `${r.week_start}/${r.tool_key}`;
    const at = rawToolWeek.get(wo) ?? { calls: 0, ms: [] };
    rawToolWeek.set(wo, { calls: at.calls + r.calls, ms: merge(at.ms, r.ms) });
    if (r.refusal_owner !== "") rawOwner.set(r.refusal_owner, (rawOwner.get(r.refusal_owner) ?? 0) + r.refusals);
  }
  say(JSON.stringify([...byTeamWeek].sort()) === JSON.stringify([...rawTeamWeek].sort()),
    "calls by week and team agree with the raw statement",
    `model ${JSON.stringify([...byTeamWeek].sort())}, raw ${JSON.stringify([...rawTeamWeek].sort())}`);
  const toolShape = (rows: Map<string, { calls: number; ms: number[] }>): string =>
    JSON.stringify([...rows].sort().map(([k, v]) => [k, v.calls, median(v.ms)]));
  say(toolShape(byToolWeek) === toolShape(rawToolWeek),
    "calls by tool and week, with their median, agree with the raw statement",
    `model ${toolShape(byToolWeek)}, raw ${toolShape(rawToolWeek)}`);
  say(JSON.stringify([...byOwner].sort()) === JSON.stringify([...rawOwner].sort()),
    "calls by refusal owner agree with the raw statement",
    `model ${JSON.stringify([...byOwner].sort())}, raw ${JSON.stringify([...rawOwner].sort())}`);

  // The zone cut, stated against a cut computed outside PostgreSQL: this instant is Sunday 23:30 UTC
  // and Monday morning in Asia/Singapore, so a UTC cut would file it in the week before.
  const acrossRow = modelRows.find((r) => r.tool_key === "core:z");
  say(acrossRow?.week_start === mondayInZone(across, zone), "a call near midnight is cut in the deployment's zone",
    `expected ${mondayInZone(across, zone)}, model says ${acrossRow?.week_start ?? "no row"}`);
  say(mondayInZone(across, zone) !== mondayInZone(across, "UTC"),
    "the zone cut is distinguishable from a UTC cut on this input",
    `both cuts give ${mondayInZone(across, zone)} for ${across}, so the case proves nothing`);

  // The migration carries the backfill a second time, because a migration file is handed no
  // parameters — so the two copies are one statement that can drift, and a drift would be invisible:
  // the migration fills a table the live write path then adds to, and only a rebuilt deployment would
  // ever notice the grain had moved. Compared as text, modulo whitespace and the zone literal.
  const squash = (sql: string): string => sql.replace(/\s+/g, " ").replace(/;\s*$/, "").trim();
  const migrated = squash(readFileSync(join(root, "services/gateway/migrations/011_event_work_week.sql"), "utf8"));
  const backfill = squash(week.WEEK_BACKFILL).replace("$1::text", "'Asia/Singapore'");
  say(migrated.includes(backfill), "the migration backfills with the module's own statement",
    "011_event_work_week.sql no longer carries the body of WEEK_BACKFILL, so the two ways of filling "
    + "this table disagree");

  return problems;
}

function dockerUnavailable(err: unknown): boolean {
  return err instanceof Error && /Docker is not running/.test(err.message);
}

async function main(): Promise<void> {
  let problems: string[];
  try {
    problems = await withThrowawayDb(run);
  } catch (err) {
    if (dockerUnavailable(err)) {
      console.error("event work week: Docker is not available — the gate requires Docker to run this check");
      process.exit(2);
    }
    throw err;
  }

  if (problems.length === 0) {
    console.log("event work week: the model equals the raw statement at its own grain, and the two halves "
      + "compose without a gap or an overlap");
    process.exit(0);
  }

  for (const line of problems) console.error(line);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
}
