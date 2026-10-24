#!/usr/bin/env node
/**
 * checks/console-searches-agree.ts — searches with results is one query function both callers use (AC-6.1).
 *
 *   node checks/console-searches-agree.ts   # needs Docker and a built tree (npm run build)
 *
 * It starts a throwaway PostgreSQL migrated by the real runner (`withThrowawayDb`), seeds one team's
 * real-work knowledge.search rows across three local weeks, and calls the gateway's own built
 * `searchesWithResults` (services/gateway/dist/console/work-figures.js) and `searchesMeasure`
 * (platform-measures.js). What it establishes:
 *
 *   - `searchesWithResults` answers the same numerator, denominator and share per week that the seed
 *     wrote, cut on the reporting timezone's weeks and counted per period;
 *   - `searchesMeasure`, the one statement both callers now reduce, answers the same weeks: identical
 *     numerator and denominator wherever the row set is the team's, and one more of each in the one
 *     week holding the search whose team did not resolve, which is Status's platform-wide figure's
 *     alone;
 *   - that team-less search is in neither of the team's weeks: deleting it leaves `searchesWithResults`
 *     exactly as it was and takes one search and one found result off Status's week;
 *   - a search that carries no `detail.returned` is in neither denominator;
 *   - a period with no completed search stays { value: null, why: "no_data" } with 0 of 0, never a zero;
 *   - the same rows at month grain are one period of the window's own searches.
 *
 * DELIBERATE: the reporting timezone is Asia/Singapore, eight hours ahead of UTC. The searches at 00:30
 * and 00:10 on a Monday locally are 16:30 and 16:10 on the Sunday before in UTC, and the ones at 23:30
 * and 23:59 on a Sunday locally are the same week's: a week cut on UTC's calendar moves four of the ten.
 *
 * The only database it touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import { withThrowawayDb } from "../scripts/schema/throwaway.ts";

const NAME = "console-searches-agree";
const DONE = "console-searches-agree: searches with results and the searches measure reduce one statement, answering " +
  "the same weeks, with the search whose team did not resolve in Status's platform-wide figure alone and in no team " +
  "figure, a search carrying no returned in neither denominator, and a week with none a no-data point: ok";

const TEAM = "searches-agree";
const TIMEZONE = "Asia/Singapore";
/** The cutoff the reads are made at: 12:00 on a Thursday locally, in the running week's fourth day. */
const AS_OF = "2026-08-20T04:00:00Z";

type Span = { from: string; to: string };
type Window = { from: string; to: string; observedFrom: string | null; observedThrough: string | null; complete: boolean };
type PF = { window: Window; figure: { value: number | null; why: string | null }; numerator: number | null; denominator: number | null };
type Grid = { asOfMs: number; coverageMs: number | null; coverageDay: string; weeks: { fromMs: number; toMs: number }[] };
type Reads = {
  searchesWithResults: (team: string, window: Span, asOf: string, grain: string) => Promise<PF[]>;
  searchesMeasure: (db: pg.Pool, grid: Grid) => Promise<{ weeks: PF[]; widened: PF[]; failed: number[] }>;
};

/** The instant a local day and time begins in the reporting timezone. */
const sgt = (at: string): number => Date.parse(`${at}:00+08:00`);
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** The three local weeks the seed fills, Monday to Monday: the two whole ones and the running one. */
const WEEKS = [
  { fromMs: sgt("2026-08-03T00:00"), toMs: sgt("2026-08-10T00:00") },
  { fromMs: sgt("2026-08-10T00:00"), toMs: sgt("2026-08-17T00:00") },
  { fromMs: sgt("2026-08-17T00:00"), toMs: sgt("2026-08-24T00:00") },
];
const WINDOW: Span = { from: iso(WEEKS[0].fromMs), to: AS_OF };
/** The status read's grid over those three weeks, built here rather than from `readGrid`, which cuts its
 *  weeks from the first real-work call and this record holds none. */
const GRID: Grid = { asOfMs: Date.parse(AS_OF), coverageMs: WEEKS[0].fromMs, coverageDay: "2026-08-03", weeks: WEEKS };

/** [local day and time, whose the search is, detail] — the team's own search, or one whose team did not
 *  resolve (null on the row) and which is therefore in no team's figure. */
const SEARCHES: [string, "team" | "none", Record<string, unknown>][] = [
  ["2026-08-03T09:00", "team", { returned: ["team:searches-agree/_knowledge/nodes/0001-a.md"] }],
  ["2026-08-05T10:00", "team", { returned: [] }],
  ["2026-08-07T11:00", "team", { returned: ["a", "b"] }],
  ["2026-08-10T00:30", "team", { returned: [] }],
  ["2026-08-12T23:30", "team", { returned: ["x"] }],
  ["2026-08-14T09:00", "team", { returned: [] }],
  ["2026-08-16T23:59", "team", { returned: [] }],
  ["2026-08-13T09:00", "none", { returned: ["z"] }],
  ["2026-08-15T09:00", "team", { query: "no results were recorded" }],
  ["2026-08-17T00:10", "team", { returned: ["q"] }],
  ["2026-08-19T09:00", "team", { returned: ["r", "s"] }],
];

/** The team's own weeks, [numerator, denominator]: two of three found, one of four, two of two. */
const TEAM_WEEKS: [number, number][] = [[2, 3], [1, 4], [2, 2]];
/** The same weeks as Status counts them, the search with no team adding one of each to the second. */
const PLATFORM_WEEKS: [number, number][] = [[2, 3], [2, 5], [2, 2]];

class CaseFailure extends Error {}
function fail(step: string, detail: string): never {
  throw new CaseFailure(`${NAME}: FAILED at "${step}": ${detail}`);
}
const pass = (line: string): void => console.log(`  ok  ${line}`);
const show = (v: unknown): string => JSON.stringify(v).slice(0, 900);
const same = (step: string, found: unknown, want: unknown): void => {
  if (!isDeepStrictEqual(found, want)) fail(step, `found ${show(found)}, expected ${show(want)}`);
};

/** One team's knowledge.search rows as zz-core writes them, the team's own and one with no team at all. */
async function seed(db: pg.Client): Promise<void> {
  const { rows: [owner] } = await db.query<{ id: string }>(
    "insert into zz.principal (email, display_name) values ('searches@agree.example.test', 'searches') returning id::text as id");
  await db.query("insert into zz.team (slug, name, created_by) values ($1, 'Searches agree', $2)", [TEAM, owner.id]);
  const { rows: [team] } = await db.query<{ id: string }>("select id::text as id from zz.team where slug = $1", [TEAM]);
  for (const [at, whose, detail] of SEARCHES) {
    await db.query(
      `insert into zz.event (ts, kind, subject, detail, origin, team_id, session)
       values ($1, 'knowledge.search', $2, $3::jsonb, 'work', $4, 'searches-session')`,
      [new Date(sgt(at)).toISOString(), `${whose === "none" ? "no team" : TEAM} question ${at}`, JSON.stringify(detail),
       whose === "none" ? null : team.id]);
  }
}

/** The weeks of a set of answers as [numerator, denominator], the share beside them. */
const counted = (weeks: PF[]): [number, number][] =>
  weeks.map((w) => [w.numerator ?? 0, w.denominator ?? 0]);

async function cases(db: pg.Client, read: Reads, status: pg.Pool): Promise<void> {
  const teamWeeks = () => read.searchesWithResults(TEAM, WINDOW, AS_OF, "week");

  let step = "searches with results, by the week each search's own local date falls in";
  const weeks = await teamWeeks();
  same(step, counted(weeks), TEAM_WEEKS);
  for (const [i, p] of weeks.entries()) {
    const [n, d] = TEAM_WEEKS[i];
    same(step, [p.window.from, p.window.to], [iso(WEEKS[i].fromMs), iso(WEEKS[i].toMs)]);
    same(step, [p.window.complete, p.figure.why, p.figure.value], [i < 2, null, (100 * n) / d]);
  }
  pass("3 of 3 weeks: 2 of 3 found, 1 of 4, 2 of 2 — each cut on the local Monday to Monday, the running week not complete, " +
    "the 00:30 and 00:10 Monday searches and the 23:30 and 23:59 Sunday ones each in their own local week");

  step = "the searches measure, the statement both callers reduce, answers the same weeks";
  const measure = await read.searchesMeasure(status, GRID);
  same(step, counted(measure.weeks), PLATFORM_WEEKS);
  for (const [i, p] of measure.weeks.entries()) {
    const [n, d] = TEAM_WEEKS[i];
    // The team's row set, then the one search whose team did not resolve, which Status counts and a team does not.
    const extra = PLATFORM_WEEKS[i][0] - n;
    same(step, [(p.numerator ?? 0) - extra, (p.denominator ?? 0) - extra], [n, d]);
  }
  pass("the two agree week by week on the team's searches; the second week holds one search more of each in Status's " +
    "platform-wide figure alone, the one whose team did not resolve");

  step = "a search carrying no returned is in neither denominator";
  const teamRows = SEARCHES.filter(([, whose]) => whose === "team");
  const teamReturned = teamRows.filter(([, , detail]) => "returned" in detail);
  same(step, [teamRows.length, teamReturned.length, weeks.reduce((n, w) => n + w.denominator!, 0)], [10, 9, 9]);
  pass("the team wrote ten searches and nine of them recorded their results; the weeks sum to nine, so the one that " +
    "recorded none is in no denominator");

  step = "the search with no team is in neither of the team's weeks";
  const before = await teamWeeks();
  await db.query("delete from zz.event e where e.kind = 'knowledge.search' and e.team_id is null");
  same(step, await teamWeeks(), before);
  same(step, counted((await read.searchesMeasure(status, GRID)).weeks), [[2, 3], [1, 4], [2, 2]]);
  pass("deleting it leaves the team's three weeks exactly as they were and takes one search and one found result off " +
    "Status's second week: it is Status's and no team's");

  step = "a period with no completed search has no data, never a zero";
  const earlier = await read.searchesWithResults(TEAM, { from: iso(WEEKS[0].fromMs - 7 * 86_400_000), to: AS_OF }, AS_OF, "week");
  same(step, [earlier.length, earlier[0].figure, earlier[0].numerator, earlier[0].denominator], [4, { value: null, why: "no_data" }, 0, 0]);
  same(step, counted(earlier.slice(1)), TEAM_WEEKS);
  pass("the week before the team's first search is no data with 0 of 0, and the three beside it the same as before");

  step = "the same rows at month grain are one period of the window's own searches";
  const month = await read.searchesWithResults(TEAM, WINDOW, AS_OF, "month");
  same(step, counted(month), [[5, 9]]);
  same(step, [month[0].window.from, month[0].window.complete], [iso(sgt("2026-08-01T00:00")), false]);
  pass("one August period, 5 of 9 found, which is the three weeks' numerators and denominators added: the 1 August " +
    "to 3 August the window does not hold is in no count");
}

async function run(db: pg.Client, url: string): Promise<void> {
  await seed(db);
  // DELIBERATE: set before the gateway's modules load, which read both once.
  process.env.TEAM_DB_URL = url;
  process.env.ZZ_TZ = TIMEZONE;
  const load = (p: string) => import(pathToFileURL(join(root, "services/gateway/dist", p)).href);
  const dbModule = (await load("db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await dbModule.initPlatformDb();
  try {
    const read = {
      ...((await load("console/work-figures.js")) as Pick<Reads, "searchesWithResults">),
      ...((await load("console/platform-measures.js")) as Pick<Reads, "searchesMeasure">),
    };
    await cases(db, read, dbModule.platformDb());
  } finally {
    await dbModule.platformDb().end().catch(() => undefined);
    delete process.env.TEAM_DB_URL;
    delete process.env.ZZ_TZ;
  }
}

async function main(): Promise<number> {
  let dbUrl = "";
  try {
    await withThrowawayDb((db) => run(db, dbUrl), async (u) => { dbUrl = u; });
  } catch (err) {
    if (err instanceof Error && /Docker is not running/.test(err.message)) {
      console.error(`${NAME}: Docker is not available — the check could not run, which is not a pass`);
      return 2;
    }
    console.error(err instanceof CaseFailure ? err.message : `${NAME}: ${String((err as Error)?.stack ?? err)}`);
    return 1;
  }
  console.log(DONE);
  return 0;
}

process.exitCode = await main();
