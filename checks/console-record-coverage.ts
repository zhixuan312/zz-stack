#!/usr/bin/env node
/**
 * checks/console-record-coverage.ts — Record counts nothing before the team's first record, in any period:
 * a quarter or a year that begins before the team's first initiative counts its runs and its searches
 * from that initiative, as all does (AC-2.8).
 *
 *   node checks/console-record-coverage.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL migrated by the real runner and writes, as rows, a team whose skill
 * runs and knowledge searches begin before its first initiative opens, and a second team with runs and a
 * search and no initiative at all. It calls the gateway's own built `recordOf`
 * (`services/gateway/dist/console/record.js`), the body of `GET /api/console/record`, for the quarter, the
 * year and all. What it establishes:
 *
 *   - the quarter and the year begin before the first initiative, so each holds the run and the search
 *     made before it: the case is real;
 *   - Your agents' runs, coverage, summed duration, skills, days, weekday by hour and by skill, and the
 *     Knowledge slice's searches, their results and searches with results by period, count nothing before
 *     `coverageFrom`, so the year's and the quarter's counts never exceed all's;
 *   - the Knowledge slice's periods are the period's own, at its grain, the same windows as the
 *     cumulative words, those before `coverageFrom` holding no search;
 *   - `meta.period` is the period's start to the cutoff and `coverageFrom` the first initiative, as before;
 *   - a team with no initiative counts no run and no search in any period, as all already did.
 *
 * DELIBERATE: the read is called at a fixed cutoff, a Thursday in August 2026, so the quarter (from 1 July)
 * and the year (from 1 January) begin before the first initiative (3 August) whatever day the check runs;
 * the mounted route reads at the moment it is called, which a calendar would move.
 *
 * DELIBERATE: the reporting timezone is Asia/Singapore, eight hours ahead of UTC with no daylight saving;
 * every seeded instant is local daytime, so no day or hour sits on an edge.
 *
 * The only database it touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import { withThrowawayDb } from "../scripts/schema/throwaway.ts";

const NAME = "console-record-coverage";
const DONE = "console-record-coverage: Record's runs and searches are counted from the later of the period's start and the " +
  "team's first record, in every period, so a quarter or a year never counts more than all, the period and coverageFrom " +
  "as before: ok";

const TIMEZONE = "Asia/Singapore";
const HOUR = 3_600_000;
const TEAM = "coverage";
const NONE = "coverage-none";
const EMAIL = "coverage@example.test";
/** The cutoff every read is made at, and where each period starts in the reporting timezone. */
const AS_OF = "2026-08-20T04:00:00Z";
const STARTS = { quarter: "2026-06-30T16:00:00Z", year: "2025-12-31T16:00:00Z" } as const;
/** The team's first initiative: its first record, 10:00 local on Monday 3 August. */
const FIRST = "2026-08-03T02:00:00Z";
const INITIATIVE = "2026-08-03-cover";
/** The runs: one before the first record, of another skill, and one after it, 14:00 local on a Wednesday. */
const RUNS = [
  { skill: "early-skill", started: "2026-07-14T02:00:00Z", ended: "2026-07-14T02:30:00Z" },
  { skill: "late-skill", started: "2026-08-05T06:00:00Z", ended: "2026-08-05T07:00:00Z" },
];
/** The completed searches, before the first record and after it, each with what it returned. */
const SEARCHES = [
  { ts: "2026-07-15T03:00:00Z", returned: ["team:_knowledge/nodes/1-early.md"] },
  { ts: "2026-08-06T03:00:00Z", returned: [`team:${INITIATIVE}/spec.md`, "platform:_knowledge/nodes/2-shared.md"] },
];
const PERIODS = ["quarter", "year", "all"] as const;
type Period = (typeof PERIODS)[number];

type Obj = Record<string, unknown>;
type Win = { from: string; to: string };
type PF = { window: Win; figure: { value: number | null; why: string | null }; numerator: number | null; denominator: number | null };
type Part = { state: string; data?: Obj };
type Agents = {
  coverageMs: { value: number | null }; summedMs: { value: number | null }; peak: { value: number | null }; runs: { value: number | null };
  zeroLength: number; skillsUsed: { value: number | null }; weekdayHour: number[][];
  days: { day: string; runs: number }[]; bySkill: { skill: string; runs: number }[];
};
type Knowledge = {
  ownReturned: { value: number | null }; meanResults: { value: number | null; why: string | null }; sharedResults: { value: number | null };
  searchesWithResults: PF[]; returnedByKind: { kind: string; results: number }[];
};
type Read = { meta: { period: Win; coverageFrom: string | null }; cumulative: PF[]; knowledge: Part; agents: Part };
type RecordOf = (team: string, caller: string, period: Period, page: { limit: number; offset: number }, asOf: string) => Promise<Read>;

class CaseFailure extends Error {}
function fail(step: string, detail: string): never {
  throw new CaseFailure(`${NAME}: FAILED at "${step}": ${detail}`);
}
const pass = (line: string): void => console.log(`  ok  ${line}`);
const show = (v: unknown): string => JSON.stringify(v).slice(0, 700);

/** Each field named, as found against as written. */
function expect(step: string, found: Obj, want: Obj): void {
  const wrong = Object.keys(want).filter((k) => !isDeepStrictEqual(found[k], want[k]));
  if (wrong.length) fail(step, wrong.map((k) => `${k} read ${show(found[k])}, expected ${show(want[k])}`).join("; "));
}

/** A part's data, or the case fails. */
function ok<T>(step: string, part: Part): T {
  if (part.state !== "ok") fail(step, `the part answered ${show(part)}`);
  return part.data as T;
}

/** The weekday-by-hour grid holding one run at `weekday` (Monday 0) and `hour`, or none. */
function grid(at?: [number, number]): number[][] {
  const g = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  if (at) g[at[0]][at[1]] = 1;
  return g;
}
const searched = (k: Knowledge): number => k.searchesWithResults.reduce((n, p) => n + (p.denominator ?? 0), 0);

/** Seeds the person, both teams, the first initiative of one, the two skills and every run and search above. */
async function seed(db: pg.Client): Promise<void> {
  const one = async (sql: string, args: unknown[]): Promise<string> => (await db.query<{ id: string }>(sql, args)).rows[0].id;
  const person = await one("insert into zz.principal (email, display_name, role) values ($1, 'Coverage', 'member') returning id", [EMAIL]);
  const teams = new Map<string, string>();
  for (const slug of [TEAM, NONE]) {
    const team = await one("insert into zz.team (slug, name, created_by) values ($1, $1, $2) returning id", [slug, person]);
    await db.query("insert into zz.membership (team_id, principal_id, role, added_by, created_at) values ($1, $2, 'admin', $2, '2025-06-01T00:00:00Z')",
      [team, person]);
    teams.set(slug, team);
  }
  await db.query("insert into zz.initiative (team_id, slug, opened_by, opened_at) values ($1, $2, $3, $4)", [teams.get(TEAM), INITIATIVE, person, FIRST]);
  const versions = new Map<string, string>();
  for (const name of RUNS.map((r) => r.skill)) {
    const skill = await one("insert into zz.skill (name) values ($1) returning id", [name]);
    versions.set(name, await one("insert into zz.skill_version (skill_id, version, content_hash) values ($1, '1.0.0', $2) returning id",
                                 [skill, createHash("sha256").update(name).digest("hex")]));
  }
  for (const team of teams.values()) {
    for (const [i, r] of RUNS.entries()) {
      await db.query(
        `insert into zz.skill_run (team_id, initiative_id, skill_version_id, session, calls, bytes_total, started_at, ended_at)
         values ($1, null, $2, $3, 3, 100, $4, $5)`, [team, versions.get(r.skill), `coverage-${i}`, r.started, r.ended]);
    }
    for (const s of SEARCHES) {
      await db.query(
        `insert into zz.event (ts, kind, subject, detail, origin, team_id) values ($1, 'knowledge.search', 'seeded query', $2::jsonb, 'work', $3)`,
        [s.ts, JSON.stringify({ returned: s.returned }), team]);
    }
  }
}

async function cases(recordOf: RecordOf): Promise<void> {
  const read = async (team: string, p: Period): Promise<Read> => recordOf(team, EMAIL, p, { limit: 10, offset: 0 }, AS_OF);
  const R = { quarter: await read(TEAM, "quarter"), year: await read(TEAM, "year"), all: await read(TEAM, "all") };

  let step = "the period and coverageFrom are as before";
  const starts: Record<Period, string> = { ...STARTS, all: FIRST };
  for (const p of PERIODS) expect(`${step} (${p})`, R[p].meta, { period: { from: starts[p], to: AS_OF }, coverageFrom: FIRST });
  pass(`the quarter from ${STARTS.quarter}, the year from ${STARTS.year} and all from ${FIRST}, each to ${AS_OF}, coverageFrom ${FIRST} in every one`);

  step = "the case is real: the quarter and the year begin before the first initiative, after a run and a search made before it";
  for (const p of ["quarter", "year"] as const) {
    if (!(starts[p] < RUNS[0].started && starts[p] < SEARCHES[0].ts && RUNS[0].ended < FIRST && SEARCHES[0].ts < FIRST)) {
      fail(step, `${p} begins at ${starts[p]}, the early run at ${RUNS[0].started}, the early search at ${SEARCHES[0].ts}, the first initiative at ${FIRST}`);
    }
  }
  pass("the quarter and the year each hold the run of 14 July and the search of 15 July, both before the first initiative of 3 August");

  const agents = {} as Record<Period, Agents>, knowledge = {} as Record<Period, Knowledge>;
  for (const p of PERIODS) {
    agents[p] = ok<Agents>(`Your agents (${p})`, R[p].agents);
    knowledge[p] = ok<Knowledge>(`Knowledge (${p})`, R[p].knowledge);
  }

  for (const p of PERIODS) {
    step = `Your agents counts nothing before coverageFrom (${p})`;
    const a = agents[p];
    expect(step, a as unknown as Obj, {
      runs: { value: 1, why: null }, zeroLength: 0, coverageMs: { value: HOUR, why: null }, summedMs: { value: HOUR, why: null },
      peak: { value: 1, why: null }, skillsUsed: { value: 1, why: null }, bySkill: [{ skill: "late-skill", runs: 1 }], weekdayHour: grid([2, 14]),
    });
    const early = a.days.filter((d) => d.day < "2026-08-03");
    const ran = a.days.filter((d) => d.runs > 0);
    if (early.length || a.days[0]?.day !== "2026-08-03" || a.days.at(-1)?.day !== "2026-08-20" || !isDeepStrictEqual(ran, [{ day: "2026-08-05", runs: 1 }])) {
      fail(step, `the days read ${show({ first: a.days[0], last: a.days.at(-1), before: early.length, ran })}`);
    }
    pass(`${step}: the run of 5 August alone, one hour covered and summed, late-skill on Wednesday at 14:00, every day from 3 August`);

    step = `the Knowledge slice's searches count nothing before coverageFrom, at the period's own periods (${p})`;
    const k = knowledge[p];
    const windows = R[p].cumulative.map((x) => x.window);
    if (!isDeepStrictEqual(k.searchesWithResults.map((x) => x.window), windows)) {
      fail(step, `searches with results is cut at ${show(k.searchesWithResults.map((x) => x.window.from))}, the cumulative words at ${show(windows.map((w) => w.from))}`);
    }
    const before = k.searchesWithResults.filter((x) => x.window.to <= FIRST);
    if (before.some((x) => x.denominator !== 0 || x.numerator !== 0 || x.figure.value !== null || x.figure.why !== "no_data")) {
      fail(step, `a period before coverageFrom read ${show(before.find((x) => x.denominator !== 0 || x.figure.value !== null))}`);
    }
    expect(step, { ...(k as unknown as Obj), searched: searched(k), found: k.searchesWithResults.reduce((n, x) => n + (x.numerator ?? 0), 0) }, {
      searched: 1, found: 1, ownReturned: { value: 0, why: null }, meanResults: { value: 2, why: null }, sharedResults: { value: 1, why: null },
      returnedByKind: [{ kind: "document", results: 1 }, { kind: "lesson", results: 1 }],
    });
    pass(`${step}: the search of 6 August alone, two results, one shared, over ${windows.length} periods, ${before.length} of them before the record begins and empty`);
  }

  step = "the year's and the quarter's counts never exceed all's";
  for (const p of ["quarter", "year"] as const) {
    const over = [
      ["runs", agents[p].runs.value!, agents.all.runs.value!], ["summed", agents[p].summedMs.value!, agents.all.summedMs.value!],
      ["days run", agents[p].days.reduce((n, d) => n + d.runs, 0), agents.all.days.reduce((n, d) => n + d.runs, 0)],
      ["searches", searched(knowledge[p]), searched(knowledge.all)],
    ].filter(([, here, all]) => (here as number) > (all as number));
    if (over.length) fail(step, `${p} counts more than all: ${show(over)}`);
  }
  pass(`${step}: one run and one search in each`);

  step = "a team with no initiative counts no run and no search in any period";
  for (const p of PERIODS) {
    const r = await read(NONE, p);
    expect(`${step} (${p})`, r.meta, { period: { from: p === "all" ? AS_OF : STARTS[p], to: AS_OF }, coverageFrom: null });
    const a = ok<Agents>(step, r.agents), k = ok<Knowledge>(step, r.knowledge);
    expect(`${step} (${p})`, { ...(a as unknown as Obj), searched: searched(k), meanResults: k.meanResults, returnedByKind: k.returnedByKind }, {
      runs: { value: 0, why: null }, coverageMs: { value: 0, why: null }, summedMs: { value: 0, why: null }, skillsUsed: { value: 0, why: null },
      bySkill: [], days: [], weekdayHour: grid(), searched: 0, meanResults: { value: null, why: "no_data" }, returnedByKind: [],
    });
  }
  pass(`${step}: both runs and both searches of ${NONE} are left out of the quarter and the year, as all leaves them`);
}

async function run(url: string): Promise<void> {
  // DELIBERATE: set before the gateway's modules load, which read both once.
  process.env.TEAM_DB_URL = url;
  process.env.ZZ_TZ = TIMEZONE;
  const load = (p: string) => import(pathToFileURL(join(root, "services/gateway/dist", p)).href);
  const dbModule = (await load("db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await dbModule.initPlatformDb();
  try {
    await cases(((await load("console/record.js")) as { recordOf: RecordOf }).recordOf);
  } finally {
    await dbModule.platformDb().end().catch(() => undefined);
    delete process.env.TEAM_DB_URL;
    delete process.env.ZZ_TZ;
  }
}

async function main(): Promise<number> {
  let dbUrl = "";
  try {
    await withThrowawayDb(async (db) => { await seed(db); await run(dbUrl); }, async (u) => { dbUrl = u; });
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
