/**
 * The eight measures the platform's Status reads, each counted week by week over the record and named
 * by `summarise`, and the same counts narrowed to one team for the reader's own part.
 *
 * Every week is Monday to Monday in the reporting timezone, from the one the first real-work call
 * falls in through the running one (`readGrid`). Every tool-call figure counts `tool_call` rows with
 * `origin = 'work'`, so maintenance clients and every other kind of event are outside it:
 *
 *   malformed_per_1000          1,000 × calls refused as `ours` / calls
 *   same_tool_followup_pct      100 × refusals followed by a success / eligible refusals; a refusal is
 *                               eligible with a session and its next 120 seconds read before the cutoff
 *   call_p50_ms, call_p95_ms    percentiles of the recorded durations of calls not batched
 *   searches_with_results_pct   100 × zz-core's work `knowledge.search` rows with a non-empty
 *                               `detail.returned` / those carrying it at all; the share widened beside it
 *   bugs_per_1000               1,000 × real reports filed (`realReports`) / calls
 *   sessions                    distinct (team, session) with a call, the empty session left out
 *   work_finished               initiatives closed as accepted or delivered
 *
 * Each measure's `definedFrom` is read from the record when it is read, never written here: the local
 * day of the first real-work call for the tool-call measures and bug reports, of the first search
 * carrying `detail.returned` (and, for the share widened, `detail.broadened`), and of the first close.
 * A week that began before it is unavailable, since the record did not hold what the measure counts.
 *
 * Each function here throws when its statement fails; the status read decides what a failure makes
 * of its answer. Narrowed to a team, a rate keeps no sample minimum: its counts stand beside it.
 */
import type pg from "pg";

import { summarise, type Measure, type MeasureKey, type PeriodFigure } from "./figures.js";
import type { realReports } from "./platform-bugs.js";
import { ZZ_TZ } from "./shared.js";

/** A weekly platform rate or latency stands only on this many observations; fewer are `insufficient`. */
const MIN_SAMPLES = 30;

/** How long after a refusal a success of the same tool counts as putting it right. */
const LOOKAHEAD_MS = 120_000;

/** An instant as the gateway spells one: ISO 8601 in UTC, whole seconds, with the Z. */
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** The read's one cutoff, in whole seconds so it is the `asOf` the answer states; where the record
 *  begins (the first real-work call, null when there is none) and its local date, today with none;
 *  and the weeks from the one it begins in through the running one. */
export type Grid = { asOfMs: number; coverageMs: number | null; coverageDay: string; weeks: { fromMs: number; toMs: number }[] };

/** One measure as Status answers it: what each draws beside its weeks, one entry per week. */
export type StatusMeasure = Measure & {
  followupCounts?: { refusals: number; eligible: number; missingSession: number; withinLookahead: number }[];
  missingDuration?: number[];
  widened?: PeriodFigure[];
  failed?: number[];
  withoutSession?: number[];
};

/** Real reports as `realReports` answers them. */
type Reports = Awaited<ReturnType<typeof realReports>>;

/** One week's counts as `summarise` takes them. */
type Counted = { numerator: number | null; denominator: number | null; value: number | null; samples: number };

/** What a measure is called and how it is judged; `rate` when a weekly figure needs its sample minimum. */
type Spec = { better: Measure["better"]; rate: boolean; precision: number; label: string; countLabel: string | null };

const SPECS: Record<MeasureKey, Spec> = {
  malformed_per_1000: { better: "down", rate: true, precision: 1, label: "malformed-call rate", countLabel: "calls refused for their shape" },
  same_tool_followup_pct: { better: "up", rate: true, precision: 1, label: "share of refusals put right",
    countLabel: "refusals followed by the same tool working within 2 minutes" },
  call_p50_ms: { better: "down", rate: true, precision: 0, label: "median call duration", countLabel: null },
  call_p95_ms: { better: "down", rate: true, precision: 0, label: "95th percentile call duration", countLabel: null },
  searches_with_results_pct: { better: "up", rate: true, precision: 1, label: "share of searches that found something",
    countLabel: "searches found something" },
  bugs_per_1000: { better: "neutral", rate: true, precision: 1, label: "bug reports per 1,000 calls", countLabel: null },
  sessions: { better: "neutral", rate: false, precision: 0, label: "sessions", countLabel: null },
  work_finished: { better: "neutral", rate: false, precision: 0, label: "pieces of work finished", countLabel: null },
};

/** The share of searches widened, drawn beside the searches measure and named by nothing. */
const WIDENED: Spec = { better: "neutral", rate: true, precision: 1, label: "share of searches widened", countLabel: null };

/** Reads the cutoff, where the record begins, and every week from then through the running one, a week
 *  with nothing in it included: a missing week stays a no-data point rather than closing the gap
 *  between its neighbours. Weeks are cut on local wall time, so a week a daylight-saving change falls
 *  in is as long as the clock says. */
export async function readGrid(db: pg.Pool): Promise<Grid> {
  const asOfMs = Math.floor(Date.now() / 1000) * 1000;
  const asOf = new Date(asOfMs).toISOString();
  const cov = (await db.query<{ first_ms: number | null; first_day: string }>(
    `select (extract(epoch from min(e.ts)) * 1000)::float8 as first_ms,
            to_char(coalesce(min(e.ts), $1::timestamptz) at time zone $2::text, 'YYYY-MM-DD') as first_day
       from zz.event e
      where e.kind = 'tool_call' and e.origin = 'work' and e.ts < $1::timestamptz`, [asOf, ZZ_TZ])).rows[0];
  const weeks = cov.first_ms === null ? [] : (await db.query<{ from_ms: number; to_ms: number }>(
    `select (extract(epoch from (w at time zone $1::text)) * 1000)::float8 as from_ms,
            (extract(epoch from ((w + interval '1 week') at time zone $1::text)) * 1000)::float8 as to_ms
       from generate_series(date_trunc('week', $3::timestamptz at time zone $1::text),
                            date_trunc('week', $2::timestamptz at time zone $1::text),
                            interval '1 week') as w
      order by w`, [ZZ_TZ, asOf, new Date(cov.first_ms).toISOString()])).rows.map((r) => ({ fromMs: r.from_ms, toMs: r.to_ms }));
  return { asOfMs, coverageMs: cov.first_ms, coverageDay: cov.first_day, weeks };
}

/** A measure over the grid: `count` gives a week's counts by the instant it starts, or is null when
 *  they could not be read, which makes every week unavailable. A week is complete once it has ended
 *  and `settleMs` more has been read after it, and when it lies wholly inside known coverage. */
function weekly(grid: Grid, key: MeasureKey, spec: Spec, team: string | null, definedFrom: string | null,
                count: ((fromMs: number) => Counted) | null, settleMs = 0): Measure {
  return summarise({
    key, better: spec.better, precision: spec.precision, label: spec.label, countLabel: spec.countLabel,
    minSamples: spec.rate && team === null ? MIN_SAMPLES : 0,
    definedFrom, coverageFrom: definedFrom ?? grid.coverageDay, timezone: ZZ_TZ,
    weeks: grid.weeks.map((w) => ({
      from: iso(w.fromMs), to: iso(w.toMs),
      observedFrom: iso(Math.max(w.fromMs, grid.coverageMs!)),
      observedThrough: iso(Math.min(w.toMs, grid.asOfMs)),
      ...(count ? count(w.fromMs) : { numerator: null, denominator: null, value: null, samples: 0 }),
      complete: w.toMs + settleMs <= grid.asOfMs && w.fromMs >= grid.coverageMs!,
      available: count !== null,
    })),
  });
}

/** A measure whose counts could not be read: every week unavailable, and nothing counted beside them. */
export function unavailableMeasure(grid: Grid, key: MeasureKey, team: string | null): StatusMeasure {
  const m: StatusMeasure = weekly(grid, key, SPECS[key], team, null, null);
  if (key === "same_tool_followup_pct") m.followupCounts = [];
  if (key === "call_p50_ms" || key === "call_p95_ms") m.missingDuration = [];
  if (key === "searches_with_results_pct") Object.assign(m, { widened: weekly(grid, key, WIDENED, team, null, null).weeks, failed: [] });
  if (key === "sessions") m.withoutSession = [];
  return m;
}

/** Rows keyed by the instant their week starts, and a reader of one numeric column that gives 0 for a
 *  week with no row. */
function byWeek<R extends { from_ms: number }>(rows: R[]): (fromMs: number, column: keyof R) => number {
  const at = new Map(rows.map((r) => [r.from_ms, r]));
  return (fromMs, column) => Number(at.get(fromMs)?.[column] ?? 0);
}
const share = (n: number, of: number, scale: number): Counted =>
  ({ numerator: n, denominator: of, value: of === 0 ? null : (scale * n) / of, samples: of });
const tally = (n: number): Counted => ({ numerator: n, denominator: null, value: n, samples: n });

/** Real-work calls and the malformed among them, by week; `team` narrows to one team's. */
async function callWeeks(db: pg.Pool, grid: Grid, team: string | null) {
  return byWeek((await db.query<{ from_ms: number; calls: number; malformed: number }>(
    `select (extract(epoch from (date_trunc('week', e.ts at time zone $1::text) at time zone $1::text)) * 1000)::float8 as from_ms,
            count(*)::int as calls,
            (count(*) filter (where e.refusal_owner = 'ours'))::int as malformed
       from zz.event e
      where e.kind = 'tool_call' and e.origin = 'work' and e.ts < $2::timestamptz
        and ($3::uuid is null or e.team_id = $3::uuid)
      group by 1`, [ZZ_TZ, new Date(grid.asOfMs).toISOString(), team])).rows);
}

/** Malformed calls per 1,000 real-work calls, week by week: the one weekly count the Status and
 *  Releases reads both draw. */
export async function malformedMeasure(db: pg.Pool, grid: Grid, team: string | null = null): Promise<Measure> {
  const at = await callWeeks(db, grid, team);
  return weekly(grid, "malformed_per_1000", SPECS.malformed_per_1000, team, grid.coverageDay,
    (w) => share(at(w, "malformed"), at(w, "calls"), 1000));
}

/** Refusals put right: of the refusals with a session whose next 120 seconds were read before the
 *  cutoff, those the same team, session and tool followed with a real-work call that was not refused
 *  within them, `[t, t + 120s)` after the refusal; when both name an initiative it is the same one.
 *  Several refusals before one success each count, so this counts refusals with a follow-up, not
 *  tasks that recovered. A week groups its refusals by their own time and is complete once the 120
 *  seconds after its end have been read. */
export async function followupMeasure(db: pg.Pool, grid: Grid, team: string | null = null): Promise<StatusMeasure> {
  const rows = (await db.query<{ from_ms: number; refusals: number; missing_session: number; within_lookahead: number; eligible: number; matched: number }>(
    `with r as (
       select e.ts, e.session,
              e.session <> '' and exists (
                select 1 from zz.event s
                 where s.kind = 'tool_call' and s.origin = 'work' and s.refusal_owner is null
                   and s.session = e.session and s.tool_key = e.tool_key and s.team_id is not distinct from e.team_id
                   and s.ts > e.ts and s.ts < e.ts + interval '120 seconds' and s.ts < $2::timestamptz
                   and (e.initiative_id is null or s.initiative_id is null or s.initiative_id = e.initiative_id)) as followed
         from zz.event e
        where e.kind = 'tool_call' and e.origin = 'work' and e.refusal_owner is not null and e.ts < $2::timestamptz
          and ($3::uuid is null or e.team_id = $3::uuid)
     )
     select (extract(epoch from (date_trunc('week', r.ts at time zone $1::text) at time zone $1::text)) * 1000)::float8 as from_ms,
            count(*)::int as refusals,
            (count(*) filter (where r.session = ''))::int as missing_session,
            (count(*) filter (where r.session <> '' and r.ts + interval '120 seconds' > $2::timestamptz))::int as within_lookahead,
            (count(*) filter (where r.session <> '' and r.ts + interval '120 seconds' <= $2::timestamptz))::int as eligible,
            (count(*) filter (where r.ts + interval '120 seconds' <= $2::timestamptz and r.followed))::int as matched
       from r
      group by 1`, [ZZ_TZ, new Date(grid.asOfMs).toISOString(), team])).rows;
  const at = byWeek(rows);
  const m: StatusMeasure = weekly(grid, "same_tool_followup_pct", SPECS.same_tool_followup_pct, team, grid.coverageDay,
    (w) => share(at(w, "matched"), at(w, "eligible"), 100), LOOKAHEAD_MS);
  m.followupCounts = grid.weeks.map((w) => ({
    refusals: at(w.fromMs, "refusals"), eligible: at(w.fromMs, "eligible"),
    missingSession: at(w.fromMs, "missing_session"), withinLookahead: at(w.fromMs, "within_lookahead"),
  }));
  return m;
}

/** The median and the 95th percentile of the recorded durations of real-work calls, recomputed from
 *  the calls of each week and never from other weeks' percentiles. A call with no duration, or one
 *  that shares a batch's latency, is counted as missing beside them. */
export async function latencyMeasures(db: pg.Pool, grid: Grid): Promise<[StatusMeasure, StatusMeasure]> {
  const at = byWeek((await db.query<{ from_ms: number; calls: number; timed: number; p50_ms: number | null; p95_ms: number | null }>(
    `select (extract(epoch from (date_trunc('week', e.ts at time zone $1::text) at time zone $1::text)) * 1000)::float8 as from_ms,
            count(*)::int as calls,
            (count(e.duration_ms) filter (where e.batched = false))::int as timed,
            round(percentile_cont(0.5) within group (order by e.duration_ms) filter (where e.batched = false))::float8 as p50_ms,
            round(percentile_cont(0.95) within group (order by e.duration_ms) filter (where e.batched = false))::float8 as p95_ms
       from zz.event e
      where e.kind = 'tool_call' and e.origin = 'work' and e.ts < $2::timestamptz
      group by 1`, [ZZ_TZ, new Date(grid.asOfMs).toISOString()])).rows);
  const missing = grid.weeks.map((w) => at(w.fromMs, "calls") - at(w.fromMs, "timed"));
  const percentile = (key: "call_p50_ms" | "call_p95_ms", column: "p50_ms" | "p95_ms"): StatusMeasure => ({
    ...weekly(grid, key, SPECS[key], null, grid.coverageDay, (w) => {
      const timed = at(w, "timed");
      return { numerator: null, denominator: timed, value: timed === 0 ? null : at(w, column), samples: timed };
    }),
    missingDuration: missing,
  });
  return [percentile("call_p50_ms", "p50_ms"), percentile("call_p95_ms", "p95_ms")];
}

/** Searches that found something: of zz-core's work `knowledge.search` rows that carry
 *  `detail.returned`, those whose result set is not empty, and beside them the share the engine
 *  widened (`detail.broadened`) and the `core:knowledge_search` calls that were refused, which are
 *  failures and never empty results. */
export async function searchesMeasure(db: pg.Pool, grid: Grid): Promise<StatusMeasure> {
  const asOf = new Date(grid.asOfMs).toISOString();
  const first = (await db.query<{ returned_day: string | null; broadened_day: string | null }>(
    `select (select to_char(min(e.ts) at time zone $2::text, 'YYYY-MM-DD') from zz.event e
              where e.kind = 'knowledge.search' and e.origin = 'work' and e.detail ? 'returned' and e.ts < $1::timestamptz) as returned_day,
            (select to_char(min(e.ts) at time zone $2::text, 'YYYY-MM-DD') from zz.event e
              where e.kind = 'knowledge.search' and e.origin = 'work' and e.detail ? 'broadened' and e.ts < $1::timestamptz) as broadened_day`,
    [asOf, ZZ_TZ])).rows[0];
  const at = byWeek((await db.query<{ from_ms: number; completed: number; found: number; told: number; widened: number }>(
    `select (extract(epoch from (date_trunc('week', e.ts at time zone $1::text) at time zone $1::text)) * 1000)::float8 as from_ms,
            count(*)::int as completed,
            (count(*) filter (where jsonb_typeof(e.detail -> 'returned') = 'array' and e.detail -> 'returned' <> '[]'::jsonb))::int as found,
            (count(*) filter (where e.detail ? 'broadened'))::int as told,
            (count(*) filter (where e.detail ->> 'broadened' = 'true'))::int as widened
       from zz.event e
      where e.kind = 'knowledge.search' and e.origin = 'work' and e.detail ? 'returned' and e.ts < $2::timestamptz
      group by 1`, [ZZ_TZ, asOf])).rows);
  const failed = byWeek((await db.query<{ from_ms: number; failed: number }>(
    `select (extract(epoch from (date_trunc('week', e.ts at time zone $1::text) at time zone $1::text)) * 1000)::float8 as from_ms,
            count(*)::int as failed
       from zz.event e
      where e.kind = 'tool_call' and e.origin = 'work' and e.tool_key = 'core:knowledge_search'
        and e.refusal_owner is not null and e.ts < $2::timestamptz
      group by 1`, [ZZ_TZ, asOf])).rows);
  return {
    ...weekly(grid, "searches_with_results_pct", SPECS.searches_with_results_pct, null, first.returned_day,
      (w) => share(at(w, "found"), at(w, "completed"), 100)),
    widened: weekly(grid, "searches_with_results_pct", WIDENED, null, first.broadened_day,
      (w) => share(at(w, "widened"), at(w, "told"), 100)).weeks,
    failed: grid.weeks.map((w) => failed(w.fromMs, "failed")),
  };
}

/** Real bug reports filed per 1,000 real-work calls of the same week. Reporting volume, never defect
 *  incidence: it is judged neither better nor worse. */
export async function bugsMeasure(db: pg.Pool, grid: Grid, reports: Reports): Promise<Measure> {
  const calls = await callWeeks(db, grid, null);
  const filed = (w: { fromMs: number; toMs: number }): number =>
    reports.filter((r) => r.reportedMs >= w.fromMs && r.reportedMs < w.toMs).length;
  return weekly(grid, "bugs_per_1000", SPECS.bugs_per_1000, null, grid.coverageDay, (fromMs) => {
    const w = grid.weeks.find((x) => x.fromMs === fromMs)!;
    return share(filed(w), calls(fromMs, "calls"), 1000);
  });
}

/** Distinct (team, session) pairs with a real-work call, a call with no session counted beside them
 *  and never merged into one session of its own. */
export async function sessionsMeasure(db: pg.Pool, grid: Grid, team: string | null = null): Promise<StatusMeasure> {
  const at = byWeek((await db.query<{ from_ms: number; sessions: number; without_session: number }>(
    `select (extract(epoch from (date_trunc('week', e.ts at time zone $1::text) at time zone $1::text)) * 1000)::float8 as from_ms,
            (count(distinct coalesce(e.team_id::text, '') || '/' || e.session) filter (where e.session <> ''))::int as sessions,
            (count(*) filter (where e.session = ''))::int as without_session
       from zz.event e
      where e.kind = 'tool_call' and e.origin = 'work' and e.ts < $2::timestamptz
        and ($3::uuid is null or e.team_id = $3::uuid)
      group by 1`, [ZZ_TZ, new Date(grid.asOfMs).toISOString(), team])).rows);
  return {
    ...weekly(grid, "sessions", SPECS.sessions, team, grid.coverageDay, (w) => tally(at(w, "sessions"))),
    withoutSession: grid.weeks.map((w) => at(w.fromMs, "without_session")),
  };
}

/** Initiatives closed as accepted or delivered, by the week they closed in; abandoned work is closed
 *  and not finished. Defined from the first close of any outcome. */
export async function finishedMeasure(db: pg.Pool, grid: Grid): Promise<Measure> {
  const asOf = new Date(grid.asOfMs).toISOString();
  const first = (await db.query<{ day: string | null }>(
    `select to_char(min(i.closed_at) at time zone $2::text, 'YYYY-MM-DD') as day
       from zz.initiative i
      where i.closed_at < $1::timestamptz`, [asOf, ZZ_TZ])).rows[0];
  const at = byWeek((await db.query<{ from_ms: number; finished: number }>(
    `select (extract(epoch from (date_trunc('week', i.closed_at at time zone $1::text) at time zone $1::text)) * 1000)::float8 as from_ms,
            count(*)::int as finished
       from zz.initiative i
      where i.closed_at < $2::timestamptz and i.outcome in ('accepted', 'delivered')
      group by 1`, [ZZ_TZ, asOf])).rows);
  return weekly(grid, "work_finished", SPECS.work_finished, null, first.day, (w) => tally(at(w, "finished")));
}

/** One team's real reports by how they stand. */
export function ownBugs(reports: Reports, team: string): { filed: number; fixed: number; notABug: number; duplicate: number; open: number } {
  const mine = reports.filter((r) => r.teamId === team);
  const by = (status: string): number => mine.filter((r) => r.status === status).length;
  return { filed: mine.length, fixed: by("fixed"), notABug: by("not_a_bug"), duplicate: by("duplicate"), open: by("open") };
}
