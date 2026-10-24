#!/usr/bin/env node
/**
 * checks/event-work-week-reads.ts — Usage's two week-grain reductions are answered from
 * `zz.event_work_week`, they answer what the whole-history statement answered, and they cost what
 * `ARCHITECTURE.md` says they may.
 *
 *   node checks/event-work-week-reads.ts   # needs Docker and a built tree (`npm run build`)
 *
 * `zz.event_work_week` exists so a whole-history reduction stops reading every call. Task I-17 built
 * the model; Task I-19 is the one that moves anything onto it. Three things can each be false without
 * the table being wrong, so this check has one arm for each:
 *
 *   1. SHAPE. A statement this check writes ITSELF over `zz.event_work_week` — not the gateway's — is
 *      compared field by field with the raw statement over `zz.event` on a frozen input: calls and
 *      refusals by week and team, calls, `timed` and the median by tool and week, and the refusals of
 *      each owner in each team's week. Then the two reductions the plan moves, `teamWeeks` and
 *      `toolWeeks`, are compared with those same raw rows — a reduction that reads the right table and
 *      reduces it wrongly fails here, which arm 2 alone would not catch.
 *
 *   2. THE REDUCTION WAS ACTUALLY MOVED. Each reduction is called with a recording stand-in in place of
 *      its database, which forwards every statement it is handed to the real client, and every one is
 *      held to a rule: a statement that reads `zz.event` must read `zz.event_work_week` too. A version
 *      that still reduces `zz.event` from its first row issues exactly such a statement and fails here —
 *      which is what makes this arm red on the tree before the task, when the model already exists.
 *
 *   3. BUDGET. The two numbers are read out of `ARCHITECTURE.md` § "The budget of each answer class",
 *      and the real-work call count it records beside them; the database is seeded to that count and
 *      then to ten times it, each in ONE set-based insert, and the model's own backfill builds the
 *      table. `EXPLAIN (ANALYZE, BUFFERS)` of the statement `teamWeeks` actually issues is held to the
 *      budget at ten times the traffic, and its buffers are printed. A register with no number on that
 *      line reports this arm NOT RUN rather than passing.
 *
 * DELIBERATE: the frozen input is seeded through `zz.event` and the model is built by `WEEK_BACKFILL`,
 * never by the gateway's write path. The model is a projection of that table, and a check that filled
 * both from one write would agree with itself about a grain neither had proved.
 *
 * DELIBERATE: the reporting zone is Pacific/Auckland, a day ahead of UTC for most of the morning, so
 * the Sunday-night instant below is a different week in the two cuts. The zone is set in the
 * environment before any gateway module is imported, because `ZZ_TZ` is read once at load.
 *
 * Exit 0: every arm held — one line per case, then the final line.
 * Exit 1: an arm failed — what was found, and the measurement that failed it.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import { withThrowawayDb } from "../scripts/schema/throwaway.ts";

const NAME = "event-work-week-reads";
const ZONE = "Pacific/Auckland";
const ALPHA = "00000000-0000-0000-0000-0000000000c1";
const BETA = "00000000-0000-0000-0000-0000000000c2";
const AUTHOR = "00000000-0000-0000-0000-0000000000a2";

/** The row a model bucket holds, as the gateway's `weekBuckets` answers it. */
type Bucket = {
  team_slug: string; week_start: string; tool_key: string; refusal_owner: string;
  calls: number; refusals: number; failed: number; ms: number[];
};

/** A week of the read's grid; only the instants matter to this check. */
type Week = { fromMs: number; toMs: number };
type Grid = { asOfMs: number; coverageMs: number | null; weeks: Week[] };

type TeamWeek = { from_ms: number; slug: string | null; calls: number; refusals?: number };
type ToolWeek = { tool: string | null; from_ms: number; calls: number; timed: number; median_ms: number | null };
type ToolCounts = { tool: string | null; from_ms: number; calls: number; timed: number };
type ToolMedian = { tool: string | null; from_ms: number; median_ms: number | null };
type OwnerWeek = { from_ms: number; slug: string | null; owner: string; refusals: number };

type Model = {
  WEEK_BACKFILL: string;
  weekBuckets: (db: pg.Pool, zone: string) => Promise<Bucket[]>;
};
type Figures = {
  teamWeeks: (db: pg.Pool, grid: Grid) => Promise<{ from_ms: number; slug: string | null; calls: number }[]>;
  toolWeeks: (db: pg.Pool, grid: Grid) => Promise<ToolWeek[]>;
};
type Measures = { readGrid: (db: pg.Pool, asOfMs?: number) => Promise<Grid> };

/** What the register declares for Usage's calls-by-week class, and the traffic it is declared at. */
type Budget = { rows: number; ms: number; calls: number };

/** A work call of the frozen input; `kind` and `origin` are parameters so the two events the model must
 *  IGNORE are spelled the same way the ones it must count are. */
type Call = {
  readonly ts: string; readonly ok?: boolean; readonly team?: string | null; readonly tool?: string;
  readonly ms?: number | null; readonly batched?: boolean; readonly owner?: string;
  readonly kind?: string; readonly origin?: string;
};

class CaseFailure extends Error {}
function fail(step: string, detail: string): never {
  throw new CaseFailure(`${NAME}: FAILED at "${step}": ${detail}`);
}
const pass = (line: string): void => console.log(`  ok  ${line}`);

const load = (rel: string): Promise<unknown> => import(pathToFileURL(join(root, rel)).href);

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

/** Rows keyed, and one line for every key the two sides disagree on, naming each field that differs —
 *  so a failure says which figure is wrong, never only that the answers are not equal. */
function disagreements<A, B>(
  left: A[], right: B[], key: (r: A | B) => string, fields: readonly string[],
): string[] {
  const l = new Map(left.map((r) => [key(r), r as unknown as Record<string, unknown>]));
  const r = new Map(right.map((row) => [key(row), row as unknown as Record<string, unknown>]));
  const out: string[] = [];
  for (const k of new Set([...l.keys(), ...r.keys()])) {
    const a = l.get(k), b = r.get(k);
    if (a === undefined || b === undefined) {
      out.push(`${k}: ${a === undefined ? "the model has it and the raw statement does not" : "the raw table has it and the model does not"}`);
      continue;
    }
    const bad = fields.filter((f) => JSON.stringify(a[f]) !== JSON.stringify(b[f]));
    if (bad.length) out.push(`${k}: ${bad.map((f) => `${f} ${JSON.stringify(a[f])} vs ${JSON.stringify(b[f])}`).join(", ")}`);
  }
  return out;
}

/** `EXPLAIN (ANALYZE, BUFFERS)` of one statement, reduced to the two numbers the budget names: the
 *  tuples the plan read out of a relation, and the milliseconds it took, with the buffers beside them. */
type PlanNode = {
  "Relation Name"?: string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  "Temp Read Blocks"?: number;
  "Temp Written Blocks"?: number;
  Plans?: PlanNode[];
};
type Explained = { Plan: PlanNode; "Execution Time": number };

type Measured = { rows: number; returned: number; ms: number; buffers: string };

function walk(node: PlanNode, visit: (n: PlanNode) => void): void {
  visit(node);
  for (const child of node.Plans ?? []) walk(child, visit);
}

async function measure(client: pg.Client, text: string, values: unknown[]): Promise<Measured> {
  const { rows } = await client.query<{ "QUERY PLAN": Explained[] }>(
    `explain (analyze, buffers, format json) ${text}`, values);
  const plan = rows[0]!["QUERY PLAN"][0]!;
  let tuples = 0;
  walk(plan.Plan, (n) => {
    if (n["Relation Name"] !== undefined) tuples += (n["Actual Rows"] ?? 0) * (n["Actual Loops"] ?? 1);
  });
  const top = plan.Plan;
  return {
    rows: Math.round(tuples),
    returned: Math.round(top["Actual Rows"] ?? 0),
    ms: plan["Execution Time"],
    buffers: `shared hit ${top["Shared Hit Blocks"] ?? 0}, read ${top["Shared Read Blocks"] ?? 0}` +
      `; temp read ${top["Temp Read Blocks"] ?? 0}, written ${top["Temp Written Blocks"] ?? 0}`,
  };
}

/** The body of `### <heading>`, down to the next heading of any level. */
function sectionOf(md: string, heading: string): string | null {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => /^#{2,4}\s/.test(l) && l.replace(/^#{2,4}\s+/, "").trim() === heading);
  if (start < 0) return null;
  const level = (lines[start].match(/^#+/) ?? [""])[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+)\s/);
    if (m && m[1]!.length <= level) { end = i; break; }
  }
  return lines.slice(start + 1, end).join("\n");
}

/** What `ARCHITECTURE.md` declares: Usage's two budget numbers, and the real-work call count the
 *  ten-times population is seeded to. Both are parsed, never hard-coded — the register is the document
 *  that decided, and a stale number in it is the defect this arm exists for. */
function budgetOf(md: string): Budget | string {
  const section = sectionOf(md, "The budget of each answer class");
  if (section === null) return "`ARCHITECTURE.md` has no `### The budget of each answer class` section";
  const line = section.split("\n").find((l) => /Usage's calls by week/i.test(l));
  if (line === undefined) return "no line in that section names Usage's calls by week and team";
  if (/unmeasured/i.test(line)) return "the register states Usage's calls-by-week budget as unmeasured";
  const m = line.match(/rows\s*(?:≤|<=)\s*([\d,]+)\s*,\s*ms\s*(?:≤|<=)\s*([\d,]+)/i);
  if (!m) return `the register's Usage line carries no \`rows ≤ N, ms ≤ M\` — it reads: ${line.trim()}`;
  const calls = md.match(/([\d,]+)\s+real-work calls/);
  if (!calls) return "`ARCHITECTURE.md` records no real-work call count to seed ten times";
  return {
    rows: Number(m[1]!.replace(/,/g, "")),
    ms: Number(m[2]!.replace(/,/g, "")),
    calls: Number(calls[1]!.replace(/,/g, "")),
  };
}

/** The number of real-work calls this database holds — the population the register's count is about. */
async function workCalls(client: pg.Client): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    "select count(*)::int as n from zz.event e where e.kind = 'tool_call' and e.origin = 'work'");
  return rows[0]!.n;
}

/**
 * One set-based insert of `n` real-work calls over seven COMPLETE local weeks, across five teams (a tenth
 * of them in no team), 13 registered tools and three refusal owners on two of those tools. That shape is
 * what makes the bucket count bounded by the GRAIN rather than by the traffic: at ten times the calls
 * the buckets are the same ones holding more rows.
 *
 * DELIBERATE: the seed is RAGGED on purpose, and a uniform one would make arm 3 pass for the wrong
 * reason. On this deployment 470 of 645 buckets (73%) end an average of 41.6 hours before their week
 * does, and that is exactly what a per-bucket tail reads: its range `(through_ts, week_end)` then spans
 * other keys' calls and discards them — 1,057,133 rows across 645 probes, 482 ms. A seed that spreads
 * every key evenly ends each bucket at its week's end, empties that range, and would report a statement
 * costing half a second as if it cost a millisecond. So each BUCKET KEY gets a cutoff hour in its week:
 * 27% of keys run to the week's end and 73% stop at a uniform point in [54, 167), which puts this
 * population at 71% and a 42-hour average. `shapeOf` below reports both, and arm 3 fails if the seed
 * lost that shape.
 *
 * DELIBERATE: the cutoff is hashed off the KEY — team, tool and refusal owner — and not off the row
 * index. `i % 390` was the obvious hash and it is wrong: several residues name the same bucket key, so
 * one bucket drew several cutoffs and kept the largest, which is its last call. That seed measured 89%
 * early at 18 hours, not the deployment's shape.
 */
async function seedCalls(client: pg.Client, teams: string[], n: number): Promise<void> {
  if (n <= 0) return;
  await client.query(
    `insert into zz.event (ts, kind, origin, ok, team_id, tool_key, duration_ms, batched, refusal_owner, subject)
     select ((date_trunc('week', now() at time zone $3::text)
              - (((g.w + 1) * 7) || ' days')::interval
              + (least(floor(g.h * g.cut / 168.0), g.cut - 1)::int || ' hours')::interval) at time zone $3::text),
            'tool_call', 'work',
            case when (g.i % 13) in (0, 1) then false else (g.i % 17) <> 0 end,
            case when g.i % 10 = 0 then null else ($2::uuid[])[1 + (g.i % 5)] end,
            'core:t' || lpad(((g.i % 13))::text, 2, '0'),
            case when g.i % 97 = 0 then null else 200 + (g.i * 37) % 3000 end,
            (g.i % 11) = 0,
            case when (g.i % 13) in (0, 1) then (array['ours', 'theirs', 'other'])[1 + (g.i % 3)] end,
            ''
       from (select i, w, h,
                    case when (k * 23) % 100 < 27 then 168
                         else 54 + (k * 17) % 114 end as cut
               from (select i,
                            i % 7 as w,
                            floor((i / 7) * 168.0 / ($1::int / 7.0))::int as h,
                            (case when i % 10 = 0 then 0 else 1 + (i % 5) end) * 26
                              + (i % 13) * 2
                              + (case when (i % 13) < 2 then i % 3 else 0 end) as k
                       from generate_series(1, $1::int) as s(i)) b) g`, [n, teams, ZONE]);
}

/** What the seeded population looks like: the buckets it made, how many end before their week does and
 *  by how much, the calls a watermark-bounded tail reads, and the calls a per-bucket probe would read.
 *  The last two are the same number only when every bucket ends at its week's end, which is the input
 *  that hid this defect.
 *
 *  DELIBERATE: "ends before its week" carries a six-hour margin. A bucket's last call lands a few hours
 *  short of its cutoff, because its calls are spread through the window rather than placed at its top,
 *  so an instant threshold would count a bucket that runs to the week's end as ending early. */
type Shape = { buckets: number; early: number; share: number; avgHours: number; tail: number; perBucket: number };

async function shapeOf(client: pg.Client, withPerBucket: boolean): Promise<Shape> {
  const { rows } = await client.query<{ buckets: number; early: number; avg_hours: number | null; tail: number }>(
    `with w as (
       select w.team_slug, w.week_start, w.tool_key, w.refusal_owner, w.through_ts,
              ((w.week_start + 7)::timestamp at time zone $1::text) as week_end
         from zz.event_work_week w
     )
     select count(*)::int as buckets,
            (count(*) filter (where w.week_end - w.through_ts > interval '6 hours'))::int as early,
            (avg(extract(epoch from (w.week_end - w.through_ts)) / 3600.0)
               filter (where w.week_end - w.through_ts > interval '6 hours'))::float8 as avg_hours,
            (select count(*)::int from zz.event e
              where e.kind = 'tool_call' and e.origin = 'work'
                and e.ts > (select max(m.through_ts) from zz.event_work_week m)) as tail
       from w`, [ZONE]);
  const at = rows[0]!;
  const perBucket = withPerBucket ? (await client.query<{ n: string }>(
    `select coalesce(sum(s.n), 0)::text as n from (
       select (select count(*) from zz.event e
                 left join zz.team t on t.id = e.team_id
                where e.kind = 'tool_call' and e.origin = 'work'
                  and coalesce(t.slug, '') = w.team_slug
                  and e.tool_key is not distinct from nullif(w.tool_key, '')
                  and e.refusal_owner is not distinct from nullif(w.refusal_owner, '')
                  and e.ts > w.through_ts
                  and e.ts >= (w.week_start::timestamp at time zone $1::text)
                  and e.ts < ((w.week_start + 7)::timestamp at time zone $1::text)) as n
         from zz.event_work_week w) s`, [ZONE])).rows[0]!.n : "0";
  return {
    buckets: at.buckets, early: at.early, share: at.buckets === 0 ? 0 : at.early / at.buckets,
    avgHours: at.avg_hours ?? 0, tail: at.tail, perBucket: Number(perBucket),
  };
}

async function run(client: pg.Client): Promise<void> {
  // DELIBERATE: before any gateway module is imported — `ZZ_TZ` is read once, at load.
  process.env.ZZ_TZ = ZONE;
  const model = (await load("services/gateway/dist/console/event-work-week.js")) as Model;
  const figures = (await load("services/gateway/dist/console/usage-figures.js")) as Figures;
  const measures = (await load("services/gateway/dist/console/platform-measures.js")) as Measures;

  const say = (ok: boolean, what: string, detail: string): void => {
    if (!ok) fail(what, detail);
  };

  // ---- The frozen input -------------------------------------------------------------------------
  await client.query("insert into zz.principal (id, email) values ($1::uuid, 'reads@example.test')", [AUTHOR]);
  await client.query("insert into zz.team (id, slug, name, created_by) values ($1::uuid, 'alpha', 'Alpha', $2::uuid)",
    [ALPHA, AUTHOR]);
  await client.query("insert into zz.team (id, slug, name, created_by) values ($1::uuid, 'beta', 'Beta', $2::uuid)",
    [BETA, AUTHOR]);
  // The vocabulary: `core:a` and `core:b` are served by a door, `core:unlisted` is not — so a call to it
  // must come out as a null tool and no caller's tool name may leave.
  await client.query(
    `with p as (insert into zz.plugin (name, origin) values ('zz-reads', 'platform') returning id),
          v as (insert into zz.plugin_version (plugin_id, version, digest)
                select id, '1.0.0', 'sha256:reads' from p returning id)
     insert into zz.plugin_tool (plugin_version_id, name, door)
     select v.id, n, 'core' from v, unnest(array['a', 'b']) as n`);

  // Week one, local Mondays 2026-10-05 and 2026-10-12 in Pacific/Auckland.
  await append(client, { ts: "2026-10-05T00:30:00Z", tool: "core:a", ms: 10 });
  await append(client, { ts: "2026-10-06T01:00:00Z", tool: "core:a", ms: 20 });
  await append(client, { ts: "2026-10-06T02:00:00Z", tool: "core:a", ms: 30 });
  await append(client, { ts: "2026-10-07T03:00:00Z", tool: "core:a", ms: 999, batched: true });   // a batch's latency
  await append(client, { ts: "2026-10-07T04:00:00Z", tool: "core:a", ms: null });                 // a call with no duration
  // Week two.
  await append(client, { ts: "2026-10-12T00:10:00Z", team: BETA, tool: "core:b", ms: 100 });
  await append(client, { ts: "2026-10-12T00:20:00Z", team: BETA, tool: "core:b", ms: 200 });
  await append(client, { ts: "2026-10-13T01:00:00Z", team: null, tool: "core:a", ms: 40 });       // no team resolved
  await append(client, { ts: "2026-10-13T02:00:00Z", tool: "core:unlisted", owner: "theirs", ok: false, ms: 50 });
  await append(client, { ts: "2026-10-14T03:00:00Z", tool: "core:a", owner: "other", ok: false });
  await append(client, { ts: "2026-10-14T04:00:00Z", team: BETA, tool: "core:b", owner: "other", ok: false });
  await append(client, { ts: "2026-10-14T05:00:00Z", tool: "core:a", owner: "other", ok: false });
  // Sunday 12:30 UTC is Monday morning in the reporting zone: a UTC cut would file it a week early, and
  // this bucket's call is what proves the model and the reduction cut in the same zone.
  await append(client, { ts: "2026-10-11T12:30:00Z", team: BETA, tool: "core:b", ms: 60 });
  // Two events the model and the raw statement must both ignore.
  await append(client, { ts: "2026-10-14T06:00:00Z", kind: "page_view", origin: "work" });
  await append(client, { ts: "2026-10-14T07:00:00Z", origin: "platform" });

  await client.query(model.WEEK_BACKFILL, [ZONE]);

  const asOfMs = Math.floor(Date.now() / 1000) * 1000;
  const grid = await measures.readGrid(client as unknown as pg.Pool, asOfMs);
  const asOf = new Date(asOfMs).toISOString();
  const from = new Date(grid.weeks[0]!.fromMs).toISOString();

  // The frozen input lies wholly inside the grid's window, so the raw statement bounded by that window
  // and the model's whole record are the same input. If they were not, an equality below would be a
  // statement about two different populations.
  const inside = (await client.query<{ n: number }>(
    `select count(*)::int as n from zz.event e
      where e.kind = 'tool_call' and e.origin = 'work'
        and (e.ts < $1::timestamptz or e.ts >= $2::timestamptz)`, [from, asOf])).rows[0]!.n;
  say(inside === 0, "the frozen input lies inside the grid's window",
    `${inside} real-work call(s) fall outside [${from}, ${asOf}), so the two statements below answer different inputs`);

  // ---- Arm 1: shape -----------------------------------------------------------------------------
  const rawTeam = (await client.query<TeamWeek>(
    `select (extract(epoch from (date_trunc('week', e.ts at time zone $1::text) at time zone $1::text)) * 1000)::float8 as from_ms,
            t.slug, count(*)::int as calls,
            (count(*) filter (where e.refusal_owner is not null))::int as refusals
       from zz.event e left join zz.team t on t.id = e.team_id
      where e.kind = 'tool_call' and e.origin = 'work' and e.ts < $2::timestamptz
      group by 1, 2`, [ZONE, asOf])).rows;
  const modelTeam = (await client.query<TeamWeek>(
    `select (extract(epoch from (w.week_start::timestamp at time zone $1::text)) * 1000)::float8 as from_ms,
            nullif(w.team_slug, '') as slug,
            sum(w.calls)::int as calls,
            sum(w.refusals)::int as refusals
       from zz.event_work_week w
      group by 1, 2`, [ZONE])).rows;
  const teamKey = (r: TeamWeek): string => `${r.from_ms}/${r.slug ?? ""}`;
  const teamDiff = disagreements(modelTeam, rawTeam, teamKey, ["slug", "calls", "refusals"]);
  say(teamDiff.length === 0, "the model answers the raw statement's calls and refusals by week and team",
    teamDiff.join("; "));
  pass(`the model's calls and refusals by week and team equal the raw statement over ${rawTeam.length} bucket(s)`);

  const rawTool = (await client.query<ToolWeek>(
    `with vocabulary as (select distinct pt.door || ':' || pt.name as tool from zz.plugin_tool pt)
     select v.tool,
            (extract(epoch from (date_trunc('week', e.ts at time zone $1::text) at time zone $1::text)) * 1000)::float8 as from_ms,
            count(*)::int as calls,
            (count(e.duration_ms) filter (where e.batched = false))::int as timed,
            round(percentile_cont(0.5) within group (order by e.duration_ms) filter (where e.batched = false))::float8 as median_ms
       from zz.event e left join vocabulary v on v.tool = e.tool_key
      where e.kind = 'tool_call' and e.origin = 'work' and e.ts < $2::timestamptz
      group by 1, 2`, [ZONE, asOf])).rows;
  const modelToolCounts = (await client.query<ToolCounts>(
    `with vocabulary as (select distinct pt.door || ':' || pt.name as tool from zz.plugin_tool pt)
     select v.tool,
            (extract(epoch from (w.week_start::timestamp at time zone $1::text)) * 1000)::float8 as from_ms,
            sum(w.calls)::int as calls,
            coalesce(sum(cardinality(w.ms)), 0)::int as timed
       from zz.event_work_week w left join vocabulary v on v.tool = w.tool_key
      group by 1, 2`, [ZONE])).rows;
  // The median is the merge of the buckets' arrays, taken here by unnesting every array of the key —
  // the same population `toolWeeks` merges in TypeScript, computed a different way on purpose.
  const modelToolMedian = (await client.query<ToolMedian>(
    `with vocabulary as (select distinct pt.door || ':' || pt.name as tool from zz.plugin_tool pt)
     select v.tool,
            (extract(epoch from (w.week_start::timestamp at time zone $1::text)) * 1000)::float8 as from_ms,
            round(percentile_cont(0.5) within group (order by d.x))::float8 as median_ms
       from zz.event_work_week w
       left join vocabulary v on v.tool = w.tool_key
       cross join lateral unnest(w.ms) as d(x)
      group by 1, 2`, [ZONE])).rows;
  const toolKey = (r: { from_ms: number; tool: string | null }): string => `${r.from_ms}/${r.tool ?? ""}`;
  const medians = new Map(modelToolMedian.map((r) => [toolKey(r), r.median_ms]));
  const modelTool: ToolWeek[] = modelToolCounts.map((r) => ({ ...r, median_ms: medians.get(toolKey(r)) ?? null }));
  const toolDiff = disagreements(modelTool, rawTool, toolKey, ["tool", "calls", "timed", "median_ms"]);
  say(toolDiff.length === 0, "the model answers the raw statement's calls, timed and median by tool and week",
    toolDiff.join("; "));
  pass(`the model's calls, timed and median by tool and week equal the raw statement over ${rawTool.length} bucket(s)`);

  const rawOwner = (await client.query<OwnerWeek>(
    `select (extract(epoch from (date_trunc('week', e.ts at time zone $1::text) at time zone $1::text)) * 1000)::float8 as from_ms,
            t.slug, e.refusal_owner as owner, count(*)::int as refusals
       from zz.event e left join zz.team t on t.id = e.team_id
      where e.kind = 'tool_call' and e.origin = 'work' and e.refusal_owner is not null and e.ts < $2::timestamptz
      group by 1, 2, 3`, [ZONE, asOf])).rows;
  const modelOwner = (await client.query<OwnerWeek>(
    `select (extract(epoch from (w.week_start::timestamp at time zone $1::text)) * 1000)::float8 as from_ms,
            nullif(w.team_slug, '') as slug, w.refusal_owner as owner, sum(w.refusals)::int as refusals
       from zz.event_work_week w
      where w.refusal_owner <> ''
      group by 1, 2, 3`, [ZONE])).rows;
  const ownerKey = (r: OwnerWeek): string => `${r.from_ms}/${r.slug ?? ""}/${r.owner}`;
  const ownerDiff = disagreements(modelOwner, rawOwner, ownerKey, ["refusals"]);
  say(ownerDiff.length === 0, "the model answers the raw statement's refusals by owner, team and week",
    ownerDiff.join("; "));
  pass(`the model's refusals by owner, team and week equal the raw statement over ${rawOwner.length} bucket(s)`);

  // The frozen input must exercise the cases the arms are about, or an equality between two empty
  // answers would read as a pass.
  say(rawTeam.some((r) => r.slug === null), "the frozen input holds a call in no team", "every call resolved a team");
  say(rawTool.some((r) => r.tool === null), "the frozen input holds a call to a tool no door registers",
    "every call named a registered tool");
  say(rawOwner.length >= 3, "the frozen input holds refusals of more than one owner",
    `it holds ${rawOwner.length} owner bucket(s)`);

  // Then the reductions themselves against the same raw rows: a reduction that reads the right table
  // and reduces it wrongly fails here, which arm 2 cannot see.
  const reducedTeam = await figures.teamWeeks(client as unknown as pg.Pool, grid);
  const reducedTeamDiff = disagreements(reducedTeam, rawTeam, teamKey, ["slug", "calls"]);
  say(reducedTeamDiff.length === 0, "teamWeeks answers the raw statement's calls by week and team",
    reducedTeamDiff.join("; "));
  pass(`teamWeeks equals the raw statement over ${reducedTeam.length} week(s) and team(s)`);

  const reducedTool = await figures.toolWeeks(client as unknown as pg.Pool, grid);
  const reducedToolDiff = disagreements(reducedTool, rawTool, toolKey, ["tool", "calls", "timed", "median_ms"]);
  say(reducedToolDiff.length === 0, "toolWeeks answers the raw statement's calls, timed and median by tool and week",
    reducedToolDiff.join("; "));
  pass(`toolWeeks equals the raw statement over ${reducedTool.length} week(s) and tool(s), its null tool included`);

  // ---- Arm 2: the reduction was actually moved --------------------------------------------------
  const issued: string[] = [];
  const recorder = {
    query: async (text: string, values?: unknown[]) => {
      issued.push(text);
      return client.query(text, values as unknown[]);
    },
  } as unknown as pg.Pool;
  const moved = (what: string): string => {
    const named = issued.filter((t) => /zz\.event_work_week/.test(t));
    const rawOnly = issued.filter((t) => /zz\.event\b/.test(t) && !/zz\.event_work_week/.test(t));
    if (named.length === 0) {
      return `${what} issued no statement naming zz.event_work_week — the statement it issues is ` +
        `${issued.map((t) => t.replace(/\s+/g, " ").trim().slice(0, 120)).join(" | ")}`;
    }
    if (rawOnly.length > 0) {
      return `${what} still reduces zz.event from its first row: ${rawOnly.map((t) => t.replace(/\s+/g, " ").trim().slice(0, 200)).join(" | ")}`;
    }
    return "";
  };

  issued.length = 0;
  await figures.teamWeeks(recorder, grid);
  const notMovedTeam = moved("teamWeeks");
  say(notMovedTeam === "", "teamWeeks was actually moved onto the read model", notMovedTeam);
  const teamStatement = issued.find((t) => /zz\.event_work_week/.test(t))!;
  pass("teamWeeks issues a statement over zz.event_work_week, and no statement over zz.event alone");

  issued.length = 0;
  await figures.toolWeeks(recorder, grid);
  const notMovedTool = moved("toolWeeks");
  say(notMovedTool === "", "toolWeeks was actually moved onto the read model", notMovedTool);
  pass("toolWeeks issues a statement over zz.event_work_week, and no statement over zz.event alone");

  // ---- Arm 3: the budget ------------------------------------------------------------------------
  const budget = budgetOf(readFileSync(join(root, "ARCHITECTURE.md"), "utf8"));
  if (typeof budget === "string") {
    fail("the register declares a budget with two numbers",
      `${budget} — arm 3 reports itself NOT RUN rather than passing`);
  }
  pass(`the register declares rows ≤ ${budget.rows}, ms ≤ ${budget.ms} at ${budget.calls.toLocaleString("en-US")} real-work calls`);

  const teams = [ALPHA, BETA];
  for (const slug of ["gamma", "delta", "epsilon"]) {
    const { rows } = await client.query<{ id: string }>(
      "insert into zz.team (slug, name, created_by) values ($1, $1, $2::uuid) returning id", [slug, AUTHOR]);
    teams.push(rows[0]!.id);
  }
  // The tool names the ten-times population calls, all served by a door: a registered tool is the only
  // kind that leaves as itself, so the budget is measured over the shape a real week has.
  await client.query(
    `insert into zz.plugin_tool (plugin_version_id, name, door)
     select v.id, 't' || lpad(g.i::text, 2, '0'), 'core'
       from (select id from zz.plugin_version where digest = 'sha256:reads') v, generate_series(0, 12) as g(i)`);
  const seededAt = Date.now();
  await seedCalls(client, teams, budget.calls - await workCalls(client));
  await client.query(model.WEEK_BACKFILL, [ZONE]);
  const oneShape = await shapeOf(client, true);
  const one = await measure(client, teamStatement, [ZONE]);
  const seedOneMs = Date.now() - seededAt;
  say(oneShape.share >= 0.6 && oneShape.avgHours >= 24, "the seed measures the population the budget is about",
    `only ${oneShape.early} of ${oneShape.buckets} bucket(s) end before their week does ` +
    `(${(oneShape.share * 100).toFixed(0)}%, ${oneShape.avgHours.toFixed(1)} h on average), so a per-bucket tail would find ` +
    `an empty range here and this arm would pass for the wrong reason`);
  pass(`the seed is ragged the way this deployment is: ${oneShape.early} of ${oneShape.buckets} bucket(s) ` +
    `(${(oneShape.share * 100).toFixed(0)}%) end an average of ${oneShape.avgHours.toFixed(1)} h before their week, so a ` +
    `per-bucket tail would read ${oneShape.perBucket.toLocaleString("en-US")} call(s) and discard them, where the ` +
    `watermark-bounded tail reads ${oneShape.tail}`);
  pass(`at ${(await workCalls(client)).toLocaleString("en-US")} real-work calls the model statement reads ` +
    `${one.rows} row(s), returns ${one.returned}, and takes ${one.ms.toFixed(1)} ms (${one.buffers}); seeded in ${seedOneMs} ms`);

  const tenAt = Date.now();
  await seedCalls(client, teams, budget.calls * 10 - await workCalls(client));
  await client.query(model.WEEK_BACKFILL, [ZONE]);
  const tenShape = await shapeOf(client, false);
  const ten = await measure(client, teamStatement, [ZONE]);
  const seedTenMs = Date.now() - tenAt;
  const calls = await workCalls(client);
  pass(`at ${calls.toLocaleString("en-US")} real-work calls (ten times the register's) the model statement reads ` +
    `${ten.rows} row(s), returns ${ten.returned}, and takes ${ten.ms.toFixed(1)} ms (${ten.buffers}); seeded in ${seedTenMs} ms, ` +
    `with ${tenShape.early} of ${tenShape.buckets} bucket(s) ending early and a tail of ${tenShape.tail} call(s)`);

  // Where that cost sits, printed beside it: the model alone reduced to the class's own counts is what
  // the register's budget was measured on. When the composed statement misses, this line says whether
  // the model row is the cost or the raw tail joined to it is.
  const bare = await measure(client,
    `select nullif(w.team_slug, '') as slug, sum(w.calls)::int as calls, sum(w.refusals)::int as refusals
       from zz.event_work_week w group by 1`, []);
  pass(`the model alone answers the class's counts in ${bare.ms.toFixed(1)} ms over ${bare.rows} row(s) ` +
    `(${bare.buffers}), against the composed statement's ${ten.ms.toFixed(1)} ms — the difference is the raw tail`);

  say(ten.rows <= budget.rows, "the model statement reads inside its declared row budget",
    `it read ${ten.rows} row(s) at ${calls.toLocaleString("en-US")} real-work calls, and the register allows ${budget.rows}` +
    `; the model alone is ${bare.rows} row(s) in ${bare.ms.toFixed(1)} ms, so the excess is the tail joined to it`);
  say(ten.ms <= budget.ms, "the model statement runs inside its declared millisecond budget",
    `it took ${ten.ms.toFixed(1)} ms at ${calls.toLocaleString("en-US")} real-work calls, and the register allows ${budget.ms} ms ` +
    `(buffers: ${ten.buffers}); the model alone is ${bare.ms.toFixed(1)} ms, so ${(ten.ms - bare.ms).toFixed(1)} ms is the tail joined to it`);
  pass(`the model statement is inside the register's budget at ten times the traffic: ` +
    `${ten.rows}/${budget.rows} rows, ${ten.ms.toFixed(1)}/${budget.ms} ms`);
}

function dockerUnavailable(err: unknown): boolean {
  return err instanceof Error && /Docker is not running/.test(err.message);
}

async function main(): Promise<void> {
  try {
    await withThrowawayDb(run);
  } catch (err) {
    if (dockerUnavailable(err)) {
      console.error(`${NAME}: Docker is not available — the gate requires Docker to run this check`);
      process.exit(2);
    }
    throw err;
  }
  console.log(`${NAME}: the two week-grain reductions read zz.event_work_week, answer the whole-history statement ` +
    "field for field, and stay inside the budget the register declared: ok");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
}
