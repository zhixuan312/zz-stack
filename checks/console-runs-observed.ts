#!/usr/bin/env node
/**
 * checks/console-runs-observed.ts — a team's observed agent runs: their coverage, their peak overlap,
 * what ran lately, and when and which skills ran (AC-5.2, AC-5.3).
 *
 *   node checks/console-runs-observed.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL migrated by the real runner, seeds the runs
 * `scripts/schema/runs-seed.ts` declares, and calls the gateway's own built `runsIn` and `observedRuns`
 * (`services/gateway/dist/console/runs-observed.js`) over them. What it establishes, against the seed's
 * written values:
 *
 *   - overlapping runs count their shared time once in coverage and once per run in the summed
 *     duration, and the peak overlap is the most runs open at one instant; two runs that only touch
 *     are not open together;
 *   - runs are clipped to the window and to the cutoff: a run begun before the window adds the part
 *     inside it and is not counted, one running past the window's end adds the part inside it, one
 *     not yet begun at the cutoff is not read, and runsIn answers each run as recorded;
 *   - a run of one call adds no time and no overlap, and zeroLength counts it;
 *   - a run whose last call is five minutes before the cutoff is active and one six minutes back is
 *     not; with four or fewer active each is its own group, the latest call first; above four they are
 *     grouped by initiative, none being a group too, at most four groups, with the runs left out
 *     counted; with none active the last run's time is answered, and none when there is no run;
 *   - runs by skill, skills used, weekday by hour and every day of the window count each run once, at
 *     its first call, in the reporting timezone;
 *   - another team's runs change nothing: every answer is the same with them deleted, and that team
 *     reads its own;
 *   - a statement that fails fails each function rather than answering nothing.
 *
 * DELIBERATE: the reporting timezone is Asia/Singapore, eight hours ahead of UTC, and r2 begins at
 * 07:30 on a Tuesday locally, 23:30 on the Monday in UTC: a day or an hour cut on UTC's calendar
 * moves it.
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
import { CUTOFFS, EXPECTED, OTHER, TEAM, THURSDAY, TIMEZONE, WEEK, seedRuns } from "../scripts/schema/runs-seed.ts";
import { withThrowawayDb } from "../scripts/schema/throwaway.ts";

const NAME = "console-runs-observed";
const DONE = "console-runs-observed: a team's runs cover their union once and their sum apart, peak at the most open at " +
  "one instant, are clipped to the window and the cutoff, count a run of one call apart, are active within five minutes " +
  "of the cutoff and grouped by initiative above four, and are counted once by skill, weekday, hour and day in the " +
  "reporting timezone, another team's changing nothing: ok";

type Span = { from: string; to: string };
type RunRow = {
  id: string; initiative: string | null; skill: string; startedAt: string; endedAt: string;
  calls: number; refusals: number; bytes: number | null;
};
type ActiveGroup = { initiative: string | null; runs: { skill: string; startedAt: string; lastAt: string }[] };
type Observed = {
  runs: number; zeroLength: number; coverageMs: number; summedMs: number; peak: number;
  active: ActiveGroup[]; activeMore: number; lastRunAt: string | null;
  bySkill: { skill: string; runs: number }[]; skillsUsed: number; weekdayHour: number[][];
  days: { day: string; runs: number }[];
};
type Reads = {
  runsIn: (team: string, window: Span, asOf: string) => Promise<RunRow[]>;
  observedRuns: (team: string, window: Span, asOf: string) => Promise<Observed>;
};

class CaseFailure extends Error {}
function fail(step: string, detail: string): never {
  throw new CaseFailure(`${NAME}: FAILED at "${step}": ${detail}`);
}
const pass = (line: string): void => console.log(`  ok  ${line}`);
const show = (v: unknown): string => JSON.stringify(v).slice(0, 600);

/** Each field named, as found against as written. */
function expect(step: string, found: Record<string, unknown>, want: Record<string, unknown>): void {
  const wrong = Object.keys(want).filter((k) => !isDeepStrictEqual(found[k], want[k]));
  if (wrong.length) fail(step, wrong.map((k) => `${k} read ${show(found[k])}, expected ${show(want[k])}`).join("; "));
}

async function cases(db: pg.Client, read: Reads, keyOf: Map<string, string>): Promise<Map<string, Observed>> {
  const keys = (rows: RunRow[]): string[] => rows.map((r) => keyOf.get(r.id) ?? `unknown ${r.id}`);
  const answers = new Map<string, Observed>();
  const observe = async (label: string, team: string, window: Span, asOf: string): Promise<Observed> => {
    const o = await read.observedRuns(team, window, asOf);
    answers.set(label, o);
    return o;
  };

  let step = "the week's runs as recorded";
  const rows = await read.runsIn(TEAM, WEEK, CUTOFFS.late);
  if (!isDeepStrictEqual(keys(rows), [...EXPECTED.week.rows])) fail(step, `runsIn answered ${keys(rows).join(", ")}`);
  const byKey = new Map(rows.map((r) => [keyOf.get(r.id), r]));
  const { id: _r1, ...r1 } = byKey.get("r1")!;
  const { id: _r5, ...r5 } = byKey.get("r5")!;
  expect(step, { r1, r5, r2bytes: byKey.get("r2")!.bytes }, { r1: EXPECTED.r1, r5: EXPECTED.r5, r2bytes: null });
  pass("runsIn answers the runs touching the week before the cutoff, the earliest first, each as recorded with its calls and refusals: r1 unclipped, r5 with no initiative, r2 with no bytes measured, r10 after the week and the other team's left out");

  step = "overlap, coverage and the summed duration over the week";
  const week = await observe("week", TEAM, WEEK, CUTOFFS.late);
  expect(step, week, { coverageMs: EXPECTED.week.coverageMs, summedMs: EXPECTED.week.summedMs, peak: EXPECTED.week.peak });
  pass("r3, r4 and r5 count their shared time once in coverage (7 h over the week) and once each in the summed 8 h 15, and three open at 11:30 is the peak");

  step = "a run of one call";
  expect(step, week, { runs: EXPECTED.week.runs, zeroLength: EXPECTED.week.zeroLength });
  pass("r8, one call, adds no time to either figure and is counted among the eight runs and apart as the one of no length");

  step = "runs clipped to the cutoff";
  const cutRows = await read.runsIn(TEAM, WEEK, CUTOFFS.cut);
  if (!isDeepStrictEqual(keys(cutRows), [...EXPECTED.cut.rows])) fail(step, `runsIn answered ${keys(cutRows).join(", ")}`);
  const { rows: _cutRows, ...cutWant } = EXPECTED.cut;
  expect(step, await observe("cut", TEAM, WEEK, CUTOFFS.cut), cutWant);
  pass("r1 adds its hour inside the week and is not counted, r9 its half hour before the week's end; read at Thursday 09:30, r6 adds its first half hour, r7 is not read, and the days stop at the cutoff's");

  step = "runs that only touch";
  const thuRows = await read.runsIn(TEAM, THURSDAY, CUTOFFS.late);
  if (!isDeepStrictEqual(keys(thuRows), [...EXPECTED.thursday.rows])) fail(step, `runsIn answered ${keys(thuRows).join(", ")}`);
  const { rows: _thuRows, ...thuWant } = EXPECTED.thursday;
  expect(step, await observe("thursday", TEAM, THURSDAY, CUTOFFS.late), thuWant);
  pass("over Thursday r6 ends as r7 begins: ninety minutes covered and summed, and a peak of one");

  step = "active within five minutes of the cutoff";
  expect(step, week, { active: EXPECTED.week.active, activeMore: EXPECTED.week.activeMore, lastRunAt: EXPECTED.week.lastRunAt });
  pass("at 12:00, a3 (two minutes back) and a1 (five minutes back) are active, each its own group, the latest first; a2, six minutes back, is not, and the week's window does not limit them");

  step = "above four active runs";
  const busy = await observe("busy", TEAM, WEEK, CUTOFFS.busy);
  expect(step, busy, EXPECTED.busy);
  pass("six active runs in five initiatives answer four groups, alpha's two runs together, the run with no initiative a group of its own, and one run more");

  step = "four active runs";
  expect(step, await observe("four", TEAM, WEEK, CUTOFFS.four), EXPECTED.four);
  pass("four active runs answer four groups of one, the latest call first, none more; c1 and c3 had not begun");

  step = "none active";
  const quiet = await observe("quiet", TEAM, WEEK, CUTOFFS.quiet);
  expect(step, quiet, { active: [], activeMore: 0, lastRunAt: EXPECTED.quiet.lastRunAt });
  const start = await observe("start", TEAM, WEEK, CUTOFFS.start);
  expect(step, start, { active: [], activeMore: 0, lastRunAt: null, runs: 0, zeroLength: 0, coverageMs: 0, summedMs: 0, peak: 0, bySkill: [], skillsUsed: 0, days: [] });
  pass("with none active the last run's time is answered, a3's; before any run the answer is none, and a window holding nothing before its cutoff counts nothing");

  step = "by skill, weekday by hour and every day";
  expect(step, week, { bySkill: EXPECTED.week.bySkill, skillsUsed: EXPECTED.week.skillsUsed, weekdayHour: EXPECTED.week.weekdayHour, days: EXPECTED.week.days });
  pass("each run counted once at its first call: plan 3, spec 3, explore 2 over three skills; r2 on Tuesday at 07 and on 8 September, as Asia/Singapore reads it; all seven days of the week, the empty ones as zero");

  step = "the other team reads its own";
  const otherRows = await read.runsIn(OTHER, WEEK, CUTOFFS.late);
  if (!isDeepStrictEqual(keys(otherRows), [...EXPECTED.other.rows])) fail(step, `runsIn answered ${keys(otherRows).join(", ")}`);
  const { rows: _otherRows, ...otherWant } = EXPECTED.other;
  expect(step, await read.observedRuns(OTHER, WEEK, CUTOFFS.late), otherWant);
  pass("the other team's runs are its own: o1 and o2 over the week, four and a half hours, a peak of one");

  step = "a statement that fails";
  await db.query("alter table zz.skill_run rename to skill_run_hidden");
  try {
    for (const [name, call] of [["runsIn", () => read.runsIn(TEAM, WEEK, CUTOFFS.late)], ["observedRuns", () => read.observedRuns(TEAM, WEEK, CUTOFFS.late)]] as const) {
      const outcome = await (call() as Promise<unknown>).then(() => "answered", () => "threw");
      if (outcome !== "threw") fail(step, `${name} answered with its table gone`);
    }
  } finally {
    await db.query("alter table zz.skill_run_hidden rename to skill_run");
  }
  pass("with the runs unreadable runsIn and observedRuns each throw rather than answering nothing");

  return answers;
}

async function run(db: pg.Client, url: string): Promise<void> {
  const ids = await seedRuns(db);
  const keyOf = new Map([...ids].map(([key, id]) => [id, key]));

  // DELIBERATE: set before the gateway's modules load, which read both once.
  process.env.TEAM_DB_URL = url;
  process.env.ZZ_TZ = TIMEZONE;
  const load = (p: string) => import(pathToFileURL(join(root, "services/gateway/dist", p)).href);
  const dbModule = (await load("db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await dbModule.initPlatformDb();
  const read = (await load("console/runs-observed.js")) as Reads;

  try {
    const answers = await cases(db, read, keyOf);

    const step = "another team's runs change nothing";
    await db.query("delete from zz.skill_run r using zz.team t where t.id = r.team_id and t.slug = $1", [OTHER]);
    const reads: [string, Span, string][] = [
      ["week", WEEK, CUTOFFS.late], ["cut", WEEK, CUTOFFS.cut], ["thursday", THURSDAY, CUTOFFS.late],
      ["busy", WEEK, CUTOFFS.busy], ["four", WEEK, CUTOFFS.four], ["quiet", WEEK, CUTOFFS.quiet], ["start", WEEK, CUTOFFS.start],
    ];
    for (const [label, window, asOf] of reads) {
      const again = await read.observedRuns(TEAM, window, asOf);
      if (!isDeepStrictEqual(again, answers.get(label))) fail(step, `the ${label} read changed: ${show(again)}`);
    }
    pass("with the other team's runs deleted every read answers as before: its overlap at Wednesday 11:30, its run two minutes before 12:10 and its call before 15:00 counted for nobody else");
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
