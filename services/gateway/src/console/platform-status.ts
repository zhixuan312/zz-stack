/**
 * /api/console/platform/status — the platform's own health, answered alike to everybody the console
 * lets in, the reader's own team's share of it, and what needs attention, worded for the reader.
 *
 * The parts:
 *
 *   needs     what needs attention (console/platform-needs.ts): the superadmin's rows, or a member's
 *             projection of the same instances, cut to five rows with the rest counted by kind
 *   measures  the eight measures, in the spec's order, each counted week by week in
 *             console/platform-measures.ts and named by `summarise`
 *   doors     each door's real-work tool calls by local day, from where the record begins (at most
 *             365 days) through today, which is not complete; its totals, its run of days under 1%
 *             tool failures and the finding said of them (`runOf`, `runFinding`). A fault day is a
 *             day's recorded tool failures at 1% of its calls or more, red from 5%, and is never a
 *             statement about whether the door could be reached; a malformed call never marks one
 *   records   over every real-work call by local day, through the latest complete day: the days in a
 *             row with a call, the days under 1% tool failures, and the longest run of those
 *   running   the gateway's own version and what `zz.release` recorded of it and of the release
 *             before it, and the migrations `zz.schema_migration` holds; `unrecorded` when no row
 *             names the running version
 *   own       the reader's active team's malformed calls, refusals put right and sessions, counted by
 *             the same functions narrowed to that team with no sample minimum, and its real bug
 *             reports by how they stand
 *
 * A measure whose statement fails is answered with every week unavailable, and the others stand; a
 * part whose statement fails is `unavailable`, and a need whose check fails is named unavailable; a
 * failure to read the cutoff and the weeks themselves is the whole response's.
 *
 * Public by route: it is mounted through `platformPublic`, takes no team and no scope, and reads
 * neither from the request. No measure names a team; `own` is the caller's active team as the
 * identity resolved it, and `unavailable` with `no_team` for a person in none; only the superadmin's
 * needs name a team.
 *
 * COUPLED: the console's `PlatformStatus` in src/lib/platform-shapes.ts, and its fake answer in
 * ../zz-stack-dashboard/scripts/fake-gateway/platform-status.ts, which `checks/console-platform-status.ts` compares this
 * route's answer with, key set by key set.
 */
import type { Express } from "express";
import type pg from "pg";

import { PLATFORM_VERSION } from "../client-package.js";
import { platformDb } from "../db.js";
import type { MeasureKey, Part, PeriodFigure, ReadMeta } from "./figures.js";
import { runFinding, runOf, type Finding } from "./findings.js";
import { pendingRevisions } from "./pending.js";
import { realReports } from "./platform-bugs.js";
import {
  bugsMeasure, finishedMeasure, followupMeasure, latencyMeasures, malformedMeasure, ownBugs, readGrid, searchesMeasure,
  sessionsMeasure, unavailableMeasure, type Grid, type StatusMeasure,
} from "./platform-measures.js";
import { evaluationWaiting, needsOf, type DoorToday, type Needs } from "./platform-needs.js";
import { platformPublic, ZZ_TZ } from "./shared.js";

/** What the measures count, as `meta.population` says it. */
const POPULATION = "real-work tool calls and searches, real bug reports, and closed initiatives";

const DOORS = ["core", "manage", "eval"] as const;
/** How many days, today's included, a door's days reach back. */
const DOOR_DAYS = 365;

/** An instant as the gateway spells one: ISO 8601 in UTC, whole seconds, with the Z. */
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
/** The local date an instant falls on in the reporting timezone. en-CA formats as YYYY-MM-DD. */
const localDate = (ms: number): string => new Intl.DateTimeFormat("en-CA", { timeZone: ZZ_TZ }).format(new Date(ms));
/** The local date `n` days after `date`: calendar arithmetic on the date alone, in UTC. */
const plusDays = (date: string, n: number): string =>
  new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)) + n)).toISOString().slice(0, 10);

type Own = {
  malformed: PeriodFigure[]; followup: PeriodFigure[]; sessions: PeriodFigure[];
  bugs: { filed: number; fixed: number; notABug: number; duplicate: number; open: number };
};
type DayState = "clear" | "marked" | "red" | "none" | "unavailable";
type DoorObservation = {
  door: (typeof DOORS)[number];
  days: { date: string; calls: number | null; toolFailures: number | null; state: DayState; complete: boolean }[];
  totals: { calls: number; toolFailures: number; others: number; faultDays: number; lastFaultDay: string | null };
  run: { days: number; atLeast: boolean; through: string } | null;
  finding: Finding;
};
type Records = {
  daysWithWork: number; daysUnderOnePercent: number;
  longestUnderOnePercent: { days: number; from: string; to: string } | null;
};
type Running = { platform: string; console: string | null; releasedAt: string; previous: string | null; migrations: number | null };

type PlatformStatus = {
  meta: ReadMeta; needs: Needs; measures: StatusMeasure[];
  records: Part<Records>; doors: Part<DoorObservation[]>; running: Part<Running>; own: Part<Own>;
};

/** A measure as read, or, when its statement failed, every week unavailable. */
async function orUnavailable(grid: Grid, key: MeasureKey, team: string | null, read: Promise<StatusMeasure>): Promise<StatusMeasure> {
  try {
    return await read;
  } catch (err) {
    console.error(`console the platform's status: ${key} could not be counted:`, err);
    return unavailableMeasure(grid, key, team);
  }
}

/** A check's reading, or null when it failed; the failure is logged under `what`. */
const orNull = <T>(what: string, read: Promise<T>): Promise<T | null> => read.catch((err: unknown) => {
  console.error(`console the platform's status: ${what} could not be read:`, err);
  return null;
});

/** One local day's real-work calls through one door (null for a tool key with none), its tool
 *  failures, the refusals classified `other`, and the instant of its first tool failure. */
type DayRow = { day: string; door: string | null; calls: number; failures: number; others: number; first_failure_ms: number | null };

async function readDays(db: pg.Pool, grid: Grid): Promise<DayRow[]> {
  return (await db.query<DayRow>(
    `select to_char(e.ts at time zone $1::text, 'YYYY-MM-DD') as day,
            nullif(split_part(e.tool_key, ':', 1), '') as door,
            count(*)::int as calls,
            (count(*) filter (where e.refusal_owner = 'theirs'))::int as failures,
            (count(*) filter (where e.refusal_owner = 'other'))::int as others,
            (extract(epoch from min(e.ts) filter (where e.refusal_owner = 'theirs')) * 1000)::float8 as first_failure_ms
       from zz.event e
      where e.kind = 'tool_call' and e.origin = 'work' and e.ts < $2::timestamptz
      group by 1, 2`, [ZZ_TZ, new Date(grid.asOfMs).toISOString()])).rows;
}

/** A day's state from its calls and tool failures: no calls is `none`, never a clear day. */
function stateOf(calls: number, failures: number): DayState {
  if (calls === 0) return "none";
  if (failures * 100 >= calls * 5) return "red";
  return failures * 100 >= calls ? "marked" : "clear";
}

/** Every local day from `first` through `last`. */
function daysFrom(first: string, last: string): string[] {
  const out: string[] = [];
  for (let d = first; d <= last; d = plusDays(d, 1)) out.push(d);
  return out;
}

/** Each door over its days, and each door's today for what needs attention. */
function doorsOf(rows: DayRow[], grid: Grid): { doors: DoorObservation[]; today: DoorToday[] } {
  const today = localDate(grid.asOfMs);
  const from = grid.coverageDay > plusDays(today, 1 - DOOR_DAYS) ? grid.coverageDay : plusDays(today, 1 - DOOR_DAYS);
  const dates = daysFrom(from, today);
  const doors = DOORS.map((door): DoorObservation => {
    const at = new Map(rows.filter((r) => r.door === door).map((r) => [r.day, r]));
    const days = dates.map((date) => {
      const r = at.get(date);
      const calls = r?.calls ?? 0, toolFailures = r?.failures ?? 0;
      return { date, calls, toolFailures, state: stateOf(calls, toolFailures), complete: date < today };
    });
    const faults = days.filter((d) => d.complete && (d.state === "marked" || d.state === "red"));
    const counts = days.map((d) => ({ ...d, available: true }));
    return {
      door, days,
      totals: {
        calls: days.reduce((n, d) => n + d.calls, 0),
        toolFailures: days.reduce((n, d) => n + d.toolFailures, 0),
        others: dates.reduce((n, date) => n + (at.get(date)?.others ?? 0), 0),
        faultDays: faults.length, lastFaultDay: faults.at(-1)?.date ?? null,
      },
      run: runOf(counts), finding: runFinding(counts),
    };
  });
  return {
    doors,
    today: DOORS.map((door) => {
      const r = rows.find((x) => x.door === door && x.day === today);
      return { door, calls: r?.calls ?? 0, toolFailures: r?.failures ?? 0, firstFailureMs: r?.first_failure_ms ?? null };
    }),
  };
}

/** Over every real-work call by local day, from where the record begins through the latest complete
 *  day: the days in a row with a call ending on it, the days with calls under 1% tool failures, and
 *  the longest run of those, the earliest on a tie. */
function recordsOf(rows: DayRow[], grid: Grid): Records {
  const today = localDate(grid.asOfMs);
  const by = new Map<string, { calls: number; failures: number }>();
  for (const r of rows) {
    const d = by.get(r.day) ?? { calls: 0, failures: 0 };
    by.set(r.day, { calls: d.calls + r.calls, failures: d.failures + r.failures });
  }
  const dates = daysFrom(grid.coverageDay, plusDays(today, -1));
  const under = dates.map((date) => { const d = by.get(date); return d !== undefined && d.calls > 0 && d.failures * 100 < d.calls; });
  let daysWithWork = 0;
  for (let i = dates.length - 1; i >= 0 && (by.get(dates[i])?.calls ?? 0) > 0; i--) daysWithWork++;
  let longest: Records["longestUnderOnePercent"] = null;
  for (let i = 0; i < dates.length; i++) {
    if (!under[i] || (i > 0 && under[i - 1])) continue;
    let j = i;
    while (j + 1 < dates.length && under[j + 1]) j++;
    if (longest === null || j - i + 1 > longest.days) longest = { days: j - i + 1, from: dates[i], to: dates[j] };
  }
  return { daysWithWork, daysUnderOnePercent: under.filter(Boolean).length, longestUnderOnePercent: longest };
}

/** What is running: this gateway's version and its release row, the release before it by time, and
 *  the migrations applied; a count that cannot be read is null beside the row that was. */
async function runningOf(db: pg.Pool): Promise<Part<Running>> {
  const row = (await db.query<{ console_version: string | null; released_ms: number; previous: string | null }>(
    `select r.console_version, (extract(epoch from r.released_at) * 1000)::float8 as released_ms,
            (select p.version from zz.release p
              where p.released_at < r.released_at
              order by p.released_at desc, p.version desc limit 1) as previous
       from zz.release r
      where r.version = $1`, [PLATFORM_VERSION])).rows[0];
  if (row === undefined) return { state: "unavailable", reason: "unrecorded" };
  const migrations = await orNull("the migrations applied", db.query<{ n: number }>(
    "select count(*)::int as n from zz.schema_migration").then((r) => r.rows[0].n));
  return {
    state: "ok",
    data: { platform: PLATFORM_VERSION, console: row.console_version, releasedAt: iso(row.released_ms), previous: row.previous, migrations },
  };
}

export function mountPlatformStatus(app: Express): void {
  app.get("/api/console/platform/status", platformPublic("the platform's status", async (_req, res, { superadmin, activeTeam }) => {
    const db = platformDb();
    const grid = await readGrid(db);
    const asOf = iso(grid.asOfMs);
    // One read of the real reports, for the rate, the reader's own counts and what needs attention.
    const reports = orNull("the real bug reports", realReports(asOf));
    const latency = latencyMeasures(db, grid);
    const days = orNull("the doors' days", readDays(db, grid));
    const [measures, pending, evaluation, running] = await Promise.all([
      Promise.all([
        orUnavailable(grid, "malformed_per_1000", null, malformedMeasure(db, grid)),
        orUnavailable(grid, "same_tool_followup_pct", null, followupMeasure(db, grid)),
        orUnavailable(grid, "call_p50_ms", null, latency.then(([p50]) => p50)),
        orUnavailable(grid, "call_p95_ms", null, latency.then(([, p95]) => p95)),
        orUnavailable(grid, "searches_with_results_pct", null, searchesMeasure(db, grid)),
        orUnavailable(grid, "bugs_per_1000", null, reports.then((r) => {
          if (r === null) throw new Error("no real bug reports to count");
          return bugsMeasure(db, grid, r);
        })),
        orUnavailable(grid, "sessions", null, sessionsMeasure(db, grid)),
        orUnavailable(grid, "work_finished", null, finishedMeasure(db, grid)),
      ]),
      orNull("the revisions waiting for approval", pendingRevisions(asOf)),
      orNull("the evaluation findings waiting", evaluationWaiting(grid.asOfMs)),
      runningOf(db).catch((err: unknown): Part<Running> => {
        console.error("console the platform's status: what is running could not be read:", err);
        return { state: "unavailable", reason: "query_failed" };
      }),
    ]);
    const dayRows = await days;
    const observed = dayRows === null ? null : doorsOf(dayRows, grid);

    // The reader's own team, from the identity alone; a slug that names no team is no team.
    let own: Part<Own> = { state: "unavailable", reason: "no_team" };
    let team: string | null = null;
    try {
      team = activeTeam === null ? null : (await db.query<{ id: string }>(
        "select t.id::text as id from zz.team t where t.slug = $1", [activeTeam])).rows[0]?.id ?? null;
    } catch (err) {
      console.error("console the platform's status: the reader's team could not be read:", err);
      own = { state: "unavailable", reason: "query_failed" };
    }
    if (team !== null) {
      const [malformed, followup, sessions, mine] = await Promise.all([
        orUnavailable(grid, "malformed_per_1000", team, malformedMeasure(db, grid, team)),
        orUnavailable(grid, "same_tool_followup_pct", team, followupMeasure(db, grid, team)),
        orUnavailable(grid, "sessions", team, sessionsMeasure(db, grid, team)),
        reports,
      ]);
      own = mine === null
        ? { state: "unavailable", reason: "query_failed" }
        : { state: "ok", data: { malformed: malformed.weeks, followup: followup.weeks, sessions: sessions.weeks, bugs: ownBugs(mine, team) } };
    }

    const failed = { state: "unavailable", reason: "query_failed" } as const;
    const answer: PlatformStatus = {
      meta: {
        asOf, timezone: ZZ_TZ,
        period: { from: grid.weeks[0] ? iso(grid.weeks[0].fromMs) : asOf, to: asOf },
        scope: "platform-public", population: POPULATION,
        coverageFrom: grid.coverageMs === null ? null : iso(grid.coverageMs),
      },
      needs: needsOf({
        superadmin, asOfMs: grid.asOfMs, timezone: ZZ_TZ, reports: await reports, doors: observed?.today ?? null,
        evaluation, pending, latency: await latency.catch(() => null),
      }),
      measures,
      records: dayRows === null ? failed : { state: "ok", data: recordsOf(dayRows, grid) },
      doors: observed === null ? failed : { state: "ok", data: observed.doors },
      running, own,
    };
    res.json(answer);
  }));
}
