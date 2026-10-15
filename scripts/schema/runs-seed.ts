/**
 * The agent runs a team's observed runs are read from, seeded into a throwaway database as
 * `zz.skill_run` rows, and the values a reader must find over them: `checks/console-runs-observed.ts`
 * calls the gateway's own `runsIn` and `observedRuns` over them, and `checks/console-work-runs.ts` the
 * Runs read.
 *
 * Every instant is fixed, so nothing depends on the day the check runs. The reporting timezone is
 * Asia/Singapore, eight hours ahead of UTC: day 0 is Monday 7 September 2026, local midnight, and an
 * instant is written as a local day and time from it. Runs, team one's unless said otherwise (the
 * skills are `runs-explore`, `runs-spec`, `runs-plan` and `runs-review`; the initiatives
 * `2026-09-01-alpha` to `-delta`, or none), each with its calls, refused calls and observed output in
 * bytes, four calls, none refused and 2,048 bytes where none are given:
 *
 *   r1   explore  alpha  day -1 23:00 to day 0 01:00   begins before the week, an hour inside it; 1,000 B
 *   r2   spec     alpha  day 1 07:30 to 08:30           Tuesday locally, Monday 23:30 in UTC; 6 calls, 1
 *                                                      refused, nothing measured
 *   r3   plan     alpha  day 2 10:00 to 12:00           r3, r4 and r5 overlap: three open at 11:30,
 *   r4   spec     beta   day 2 11:00 to 13:00           their union three hours, their sum 4h15; r3 10
 *   r5   spec     none   day 2 11:30 to 11:45           calls, 2 refused, 40,000 B, the largest; r4 8
 *                                                      calls, 12,000 B
 *   r6   explore  alpha  day 3 09:00 to 10:00           r6 ends as r7 begins: never open together; r6 5
 *   r7   plan     beta   day 3 10:00 to 10:30           calls, 1 refused, 6,000 B; r7 3 calls, 9,000 B
 *   r8   explore  alpha  day 4 14:00, one call          no length; 500 B
 *   r9   plan     gamma  day 6 23:30 to day 7 00:30     begins inside the week, half an hour inside it;
 *                                                      7,000 B
 *   r10  spec     alpha  day 7 09:00 to 09:30           after the week; 2 calls, 1 refused, 4,000 B
 *   r11  review   none   day 7 15:00, one call          nothing measured
 *   a1   explore  beta   day 8 11:00 to 11:55:00       five minutes before LATE: active; 3,000 B
 *   a2   spec     gamma  day 8 11:30 to 11:54:00       six minutes before LATE: not; 2,000 B
 *   a3   plan     alpha  day 8 11:50 to 11:58:00       active at LATE, the last run at QUIET; 1,952 B
 *   c1   plan     alpha  day 9 14:58:00 to 14:59:00    six runs in the five minutes before BUSY,
 *   c2   spec     alpha  day 9 14:30:00 to 14:56:00    five initiatives among them; four of them
 *   c3   explore  beta   day 9 14:57:50 to 14:58:00    (c2, c4, c5, c6) in the five minutes before
 *   c4   spec     gamma  day 9 14:40:00 to 14:57:00    FOUR, before which c1 and c3 had not begun
 *   c5   plan     none   day 9 14:45:00 to 14:57:30
 *   c6   explore  delta  day 9 14:20:00 to 14:55:30
 *
 * and team two's, with the same skills and an initiative of the same slug, each placed where a read
 * blind to the team would change an answer: o1 overlaps r3 to r5 and has more observed output than
 * any of team one's, o2 adds a day, o3 ends two minutes before QUIET, o4 is the latest call before BUSY.
 *
 * `EXPECTED` is what a reader must find, written out by hand from the table above and not computed
 * from it.
 *
 * A helper, not a check: every `.ts` under `checks/` is a check the gate runs.
 */
import { createHash } from "node:crypto";

import type pg from "pg";

export const TIMEZONE = "Asia/Singapore";
export const TEAM = "runs-one";
export const OTHER = "runs-two";

const HOUR = 3_600_000;
const MINUTE = 60_000;

/** Local `time` (`HH:MM` or `HH:MM:SS`) on day `day` from Monday 7 September 2026, as an instant. */
function at(day: number, time: string): string {
  const [h, m, s = 0] = time.split(":").map(Number);
  return new Date(Date.UTC(2026, 8, 7 + day, h, m, s) - 8 * HOUR).toISOString();
}

type Skill = "runs-explore" | "runs-spec" | "runs-plan" | "runs-review";
type Initiative = "alpha" | "beta" | "gamma" | "delta" | null;
interface Run {
  key: string; team: typeof TEAM | typeof OTHER; skill: Skill; initiative: Initiative;
  started: string; ended: string; calls: number; refusals: number; bytes: number | null;
}

const run = (key: string, skill: Skill, initiative: Initiative, started: string, ended: string, over: Partial<Run> = {}): Run =>
  ({ key, team: TEAM, skill, initiative, started, ended, calls: 4, refusals: 0, bytes: 2_048, ...over });

const RUNS: readonly Run[] = [
  run("r1", "runs-explore", "alpha", at(-1, "23:00"), at(0, "01:00"), { bytes: 1_000 }),
  run("r2", "runs-spec", "alpha", at(1, "07:30"), at(1, "08:30"), { calls: 6, refusals: 1, bytes: null }),
  run("r3", "runs-plan", "alpha", at(2, "10:00"), at(2, "12:00"), { calls: 10, refusals: 2, bytes: 40_000 }),
  run("r4", "runs-spec", "beta", at(2, "11:00"), at(2, "13:00"), { calls: 8, bytes: 12_000 }),
  run("r5", "runs-spec", null, at(2, "11:30"), at(2, "11:45")),
  run("r6", "runs-explore", "alpha", at(3, "09:00"), at(3, "10:00"), { calls: 5, refusals: 1, bytes: 6_000 }),
  run("r7", "runs-plan", "beta", at(3, "10:00"), at(3, "10:30"), { calls: 3, bytes: 9_000 }),
  run("r8", "runs-explore", "alpha", at(4, "14:00"), at(4, "14:00"), { calls: 1, bytes: 500 }),
  run("r9", "runs-plan", "gamma", at(6, "23:30"), at(7, "00:30"), { bytes: 7_000 }),
  run("r10", "runs-spec", "alpha", at(7, "09:00"), at(7, "09:30"), { calls: 2, refusals: 1, bytes: 4_000 }),
  run("r11", "runs-review", null, at(7, "15:00"), at(7, "15:00"), { calls: 1, bytes: null }),
  run("a1", "runs-explore", "beta", at(8, "11:00"), at(8, "11:55:00"), { bytes: 3_000 }),
  run("a2", "runs-spec", "gamma", at(8, "11:30"), at(8, "11:54:00"), { bytes: 2_000 }),
  run("a3", "runs-plan", "alpha", at(8, "11:50"), at(8, "11:58:00"), { bytes: 1_952 }),
  run("c1", "runs-plan", "alpha", at(9, "14:58:00"), at(9, "14:59:00")),
  run("c2", "runs-spec", "alpha", at(9, "14:30:00"), at(9, "14:56:00")),
  run("c3", "runs-explore", "beta", at(9, "14:57:50"), at(9, "14:58:00")),
  run("c4", "runs-spec", "gamma", at(9, "14:40:00"), at(9, "14:57:00")),
  run("c5", "runs-plan", null, at(9, "14:45:00"), at(9, "14:57:30")),
  run("c6", "runs-explore", "delta", at(9, "14:20:00"), at(9, "14:55:30")),

  run("o1", "runs-spec", "alpha", at(2, "10:30"), at(2, "14:00"), { team: OTHER, bytes: 900_000 }),
  run("o2", "runs-explore", null, at(5, "08:00"), at(5, "09:00"), { team: OTHER }),
  run("o3", "runs-plan", "alpha", at(8, "12:00"), at(8, "12:08:00"), { team: OTHER }),
  run("o4", "runs-spec", null, at(9, "14:59:00"), at(9, "14:59:30"), { team: OTHER }),
];

/** The week, Monday to Monday locally, and the cutoffs the reads are made at. */
export const WEEK = { from: at(0, "00:00"), to: at(7, "00:00") };
/** Thursday alone, where r6 and r7 only touch. */
export const THURSDAY = { from: at(3, "00:00"), to: at(4, "00:00") };
export const CUTOFFS = {
  /** Five minutes after a1's last call and two after a3's. */
  late: at(8, "12:00:00"),
  /** Twelve minutes after the last of team one's runs before it. */
  quiet: at(8, "12:10:00"),
  /** Every c-run within the five minutes before it. */
  busy: at(9, "15:00:00"),
  /** Four c-runs within the five minutes before it. */
  four: at(9, "14:57:45"),
  /** Inside the week, half an hour into r6, before r7 began. */
  cut: at(3, "09:30:00"),
  /** The week's first instant: nothing inside the window yet. */
  start: at(0, "00:00"),
} as const;

/** Every cell of weekday by hour, Monday 0, zero but those named. */
const cells = (named: [day: number, hour: number, runs: number][]): number[][] => {
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  for (const [d, h, n] of named) grid[d][h] = n;
  return grid;
};

/** What the reads must answer, written out from the table above. */
export const EXPECTED = {
  /** Team one over the week at LATE. */
  week: {
    rows: ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9"],
    runs: 8, zeroLength: 1,
    // r1's clipped hour, r2's hour, r3 to r5's three hours, r6 and r7's ninety minutes, r9's clipped half hour.
    coverageMs: 420 * MINUTE,
    // 60 + 60 + 120 + 120 + 15 + 60 + 30 + 0 + 30 minutes.
    summedMs: 495 * MINUTE,
    peak: 3,
    bySkill: [{ skill: "runs-plan", runs: 3 }, { skill: "runs-spec", runs: 3 }, { skill: "runs-explore", runs: 2 }],
    skillsUsed: 3,
    weekdayHour: cells([[1, 7, 1], [2, 10, 1], [2, 11, 2], [3, 9, 1], [3, 10, 1], [4, 14, 1], [6, 23, 1]]),
    days: [
      { day: "2026-09-07", runs: 0 }, { day: "2026-09-08", runs: 1 }, { day: "2026-09-09", runs: 3 },
      { day: "2026-09-10", runs: 2 }, { day: "2026-09-11", runs: 1 }, { day: "2026-09-12", runs: 0 },
      { day: "2026-09-13", runs: 1 },
    ],
    active: [
      { initiative: "2026-09-01-alpha", runs: [{ skill: "runs-plan", startedAt: "2026-09-15T03:50:00Z", lastAt: "2026-09-15T03:58:00Z" }] },
      { initiative: "2026-09-01-beta", runs: [{ skill: "runs-explore", startedAt: "2026-09-15T03:00:00Z", lastAt: "2026-09-15T03:55:00Z" }] },
    ],
    activeMore: 0,
    lastRunAt: "2026-09-15T03:58:00Z",
  },
  /** r1 as runsIn answers it: as recorded, not clipped. */
  r1: { initiative: "2026-09-01-alpha", skill: "runs-explore", startedAt: "2026-09-06T15:00:00Z", endedAt: "2026-09-06T17:00:00Z", calls: 4, refusals: 0, bytes: 1_000 },
  /** r5 as runsIn answers it: no initiative. r2 has no bytes measured, and six calls, one refused. */
  r5: { initiative: null, skill: "runs-spec", startedAt: "2026-09-09T03:30:00Z", endedAt: "2026-09-09T03:45:00Z", calls: 4, refusals: 0, bytes: 2_048 },
  /** Team one over the week at CUT: r6 clipped at the cutoff, r7 not begun. */
  cut: {
    rows: ["r1", "r2", "r3", "r4", "r5", "r6"],
    runs: 5, zeroLength: 0, coverageMs: 330 * MINUTE, summedMs: 405 * MINUTE, peak: 3,
    days: [
      { day: "2026-09-07", runs: 0 }, { day: "2026-09-08", runs: 1 }, { day: "2026-09-09", runs: 3 },
      { day: "2026-09-10", runs: 1 },
    ],
  },
  /** Team one over Thursday at LATE: r6 and r7 touch, so the peak is one. */
  thursday: {
    rows: ["r6", "r7"], runs: 2, coverageMs: 90 * MINUTE, summedMs: 90 * MINUTE, peak: 1,
    days: [{ day: "2026-09-10", runs: 2 }],
  },
  /** At QUIET nothing is active, and the last run is a3. */
  quiet: { lastRunAt: "2026-09-15T03:58:00Z" },
  /** At BUSY six runs in five initiatives: four groups, the latest call first, and one run more. */
  busy: {
    active: [
      { initiative: "2026-09-01-alpha", runs: [
        { skill: "runs-plan", startedAt: "2026-09-16T06:58:00Z", lastAt: "2026-09-16T06:59:00Z" },
        { skill: "runs-spec", startedAt: "2026-09-16T06:30:00Z", lastAt: "2026-09-16T06:56:00Z" },
      ] },
      { initiative: "2026-09-01-beta", runs: [{ skill: "runs-explore", startedAt: "2026-09-16T06:57:50Z", lastAt: "2026-09-16T06:58:00Z" }] },
      { initiative: null, runs: [{ skill: "runs-plan", startedAt: "2026-09-16T06:45:00Z", lastAt: "2026-09-16T06:57:30Z" }] },
      { initiative: "2026-09-01-gamma", runs: [{ skill: "runs-spec", startedAt: "2026-09-16T06:40:00Z", lastAt: "2026-09-16T06:57:00Z" }] },
    ],
    activeMore: 1,
    lastRunAt: "2026-09-16T06:59:00Z",
  },
  /** At FOUR four runs, one group each, the latest call first. */
  four: {
    active: [
      { initiative: null, runs: [{ skill: "runs-plan", startedAt: "2026-09-16T06:45:00Z", lastAt: "2026-09-16T06:57:30Z" }] },
      { initiative: "2026-09-01-gamma", runs: [{ skill: "runs-spec", startedAt: "2026-09-16T06:40:00Z", lastAt: "2026-09-16T06:57:00Z" }] },
      { initiative: "2026-09-01-alpha", runs: [{ skill: "runs-spec", startedAt: "2026-09-16T06:30:00Z", lastAt: "2026-09-16T06:56:00Z" }] },
      { initiative: "2026-09-01-delta", runs: [{ skill: "runs-explore", startedAt: "2026-09-16T06:20:00Z", lastAt: "2026-09-16T06:55:30Z" }] },
    ],
    activeMore: 0,
    lastRunAt: "2026-09-16T06:57:30Z",
  },
  /** Team two over the week at LATE: o1 and o2. */
  other: { rows: ["o1", "o2"], runs: 2, coverageMs: 270 * MINUTE, peak: 1 },
} as const;

/**
 * What the Runs read must answer at LATE, written out from the table above: team one's runs since its
 * first, r1, to LATE, which are r1 to r11 and a1 to a3. A row is named by its key and its state; the
 * largest run is written whole, its id left out.
 */
export const RUNS_READ = {
  all: {
    since: "2026-09-06T15:00:00Z",
    // Fourteen runs, r2 and r11 unmeasured; the other twelve's output is 88,500 bytes.
    runs: 14, outputPerRun: 7_375, unmeasured: 2,
    largest: {
      skill: "runs-plan", initiative: "2026-09-01-alpha", startedAt: "2026-09-09T02:00:00Z", lastCallAt: "2026-09-09T04:00:00Z",
      calls: 10, refusals: 2, bytes: 40_000, lengthMs: 120 * MINUTE, state: "last_call",
    },
    coverage: {
      // r1 2 h, r2 1 h, r3 to r5's union 3 h, r6 and r7's 90 minutes, r9 1 h, r10 30 minutes, a1 to a3's
      // union 58 minutes.
      coverageMs: 598 * MINUTE,
      // 120 + 60 + 120 + 120 + 15 + 60 + 30 + 0 + 60 + 30 + 0 + 55 + 24 + 8 minutes.
      summedMs: 702 * MINUTE,
      peak: 3, oneCall: 2,
    },
    bySkill: [
      // r3, r7, r9, a3: 21 calls, 2 refused, 57,952 bytes; lengths 120, 30, 60 and 8 minutes.
      { skill: "runs-plan", runs: 4, callsPerRun: 21 / 4, shareRefused: 2 / 21, outputPerRun: 14_488, typicalMs: 45 * MINUTE, timed: 4 },
      // r2, r4, r5, r10, a2: 24 calls, 2 refused, r2 unmeasured and 20,048 bytes over the rest; lengths 60, 120,
      // 15, 30 and 24 minutes.
      { skill: "runs-spec", runs: 5, callsPerRun: 24 / 5, shareRefused: 2 / 24, outputPerRun: 5_012, typicalMs: 30 * MINUTE, timed: 5 },
      // r1, r6, r8, a1: 14 calls, 1 refused, 10,500 bytes; r8 is one call, so 120, 60 and 55 minutes.
      { skill: "runs-explore", runs: 4, callsPerRun: 14 / 4, shareRefused: 1 / 14, outputPerRun: 2_625, typicalMs: 60 * MINUTE, timed: 3 },
      // r11, one call, nothing measured: last.
      { skill: "runs-review", runs: 1, callsPerRun: 1, shareRefused: 0, outputPerRun: null, typicalMs: null, timed: 0 },
    ],
    /** Newest first by the last call: a3 two minutes back and a1 five are active, a2 six minutes back is not. */
    recent: [
      ["a3", "active"], ["a1", "active"], ["a2", "last_call"], ["r11", "one_call"], ["r10", "last_call"],
      ["r9", "last_call"], ["r8", "one_call"], ["r7", "last_call"], ["r6", "last_call"], ["r4", "last_call"],
      ["r3", "last_call"], ["r5", "last_call"], ["r2", "last_call"], ["r1", "last_call"],
    ],
  },
  /** Narrowed to runs-spec: r2, r4, r5, r10 and a2. */
  spec: {
    since: "2026-09-07T23:30:00Z",
    runs: 5, outputPerRun: 5_012, unmeasured: 1,
    largest: {
      skill: "runs-spec", initiative: "2026-09-01-beta", startedAt: "2026-09-09T03:00:00Z", lastCallAt: "2026-09-09T05:00:00Z",
      calls: 8, refusals: 0, bytes: 12_000, lengthMs: 120 * MINUTE, state: "last_call",
    },
    // r2 1 h, r4's 2 h holding r5, r10 30 minutes, a2 24 minutes; summed with r5's 15 minutes.
    coverage: { coverageMs: 234 * MINUTE, summedMs: 249 * MINUTE, peak: 2, oneCall: 0 },
    recent: ["a2", "r10", "r4", "r5", "r2"],
  },
  /** Team two's runs at LATE: o3 begins at LATE, so o1 and o2. */
  other: { runs: 2, recent: ["o2", "o1"] },
} as const;

/**
 * Seeds a person, both teams, their initiatives, the three skills and every run above into `db`, and
 * answers each run's id by its key. The database must hold no other run.
 */
export async function seedRuns(db: pg.ClientBase | pg.Pool): Promise<Map<string, string>> {
  const one = async (sql: string, args: unknown[]): Promise<string> => (await db.query<{ id: string }>(sql, args)).rows[0].id;
  const person = await one("insert into zz.principal (email, display_name, role) values ('runs@example.test', 'runs', 'member') returning id", []);
  const teams = new Map<string, string>();
  const initiatives = new Map<string, string>();
  for (const slug of [TEAM, OTHER]) {
    const team = await one("insert into zz.team (slug, name, created_by) values ($1, $1, $2) returning id", [slug, person]);
    teams.set(slug, team);
    for (const name of ["alpha", "beta", "gamma", "delta"]) {
      initiatives.set(`${slug}/${name}`, await one(
        "insert into zz.initiative (team_id, slug, opened_by, opened_at) values ($1, $2, $3, '2026-09-01T00:00:00Z') returning id",
        [team, `2026-09-01-${name}`, person]));
    }
  }
  const versions = new Map<string, string>();
  for (const name of ["runs-explore", "runs-spec", "runs-plan", "runs-review"]) {
    const skill = await one("insert into zz.skill (name) values ($1) returning id", [name]);
    versions.set(name, await one("insert into zz.skill_version (skill_id, version, content_hash) values ($1, '1.0.0', $2) returning id",
                                 [skill, createHash("sha256").update(name).digest("hex")]));
  }
  const ids = new Map<string, string>();
  for (const r of RUNS) {
    ids.set(r.key, await one(
      `insert into zz.skill_run (team_id, initiative_id, skill_version_id, session, calls, refusals, bytes_total, started_at, ended_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [teams.get(r.team), r.initiative ? initiatives.get(`${r.team}/${r.initiative}`) : null, versions.get(r.skill),
       `session-${r.key}`, r.calls, r.refusals, r.bytes, r.started, r.ended]));
  }
  return ids;
}
