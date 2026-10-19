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
 *   work_finished               initiatives closed as accepted or delivered, a release check's probe and a
 *                               close a maintenance client made left out
 *
 * Each measure's `definedFrom` is read from the record when it is read, never written here: the local
 * day of the first real-work call for the tool-call measures and bug reports, of the first search
 * carrying `detail.returned` (and, for the share widened, `detail.broadened`), and of the first close.
 * A week that began before it is unavailable, since the record did not hold what the measure counts.
 *
 * Each function here throws when its statement fails; the status read decides what a failure makes
 * of its answer. Narrowed to a team, a rate keeps no sample minimum: its counts stand beside it.
 *
 * The searches by day, which Status and Knowledge health both reduce, are counted here too, so the
 * Platform prepared query (platform-query-measures.ts) reads the statement the pages it equals read.
 */
import type pg from "pg";

import { summarise, type Measure, type MeasureKey, type PeriodFigure, type Window } from "./figures.js";
import type { realReports } from "./platform-bugs.js";
import { ZZ_TZ } from "./shared.js";
import { followupWeeks, type FollowupRow } from "./usage-figures.js";

/** A weekly platform rate or latency stands only on this many observations; fewer are `insufficient`. */
const MIN_SAMPLES = 30;

/** How long after a refusal a success of the same tool counts as putting it right. */
export const LOOKAHEAD_MS = 120_000;

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

/** A figure only its weeks are read of: no direction, and nothing a finding says. */
const UNNAMED: Spec = { better: "neutral", rate: false, precision: 0, label: "", countLabel: null };

/** Reads where the record begins at the cutoff, the read's moment in whole seconds unless one is given,
 *  and every week from then through the running one, a week with nothing in it included: a missing week
 *  stays a no-data point rather than closing the gap between its neighbours. Weeks are cut on local wall
 *  time, so a week a daylight-saving change falls in is as long as the clock says. */
export async function readGrid(db: pg.Pool, asOfMs = Math.floor(Date.now() / 1000) * 1000): Promise<Grid> {
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

/** A week of the grid as a window: observed from where the record begins through the cutoff, and
 *  complete once it has ended and `settleMs` more has been read after it, and when it lies wholly
 *  inside known coverage. */
export function windowOf(grid: Grid, w: { fromMs: number; toMs: number }, settleMs = 0): Window {
  return {
    from: iso(w.fromMs), to: iso(w.toMs),
    observedFrom: iso(Math.max(w.fromMs, grid.coverageMs!)),
    observedThrough: iso(Math.min(w.toMs, grid.asOfMs)),
    complete: w.toMs + settleMs <= grid.asOfMs && w.fromMs >= grid.coverageMs!,
  };
}

/** A measure over the grid: `count` gives a week's counts by the instant it starts, or is null when
 *  they could not be read, which makes every week unavailable. */
function weekly(grid: Grid, key: MeasureKey, spec: Spec, team: string | null, definedFrom: string | null,
                count: ((fromMs: number) => Counted) | null, settleMs = 0): Measure {
  return summarise({
    key, better: spec.better, precision: spec.precision, label: spec.label, countLabel: spec.countLabel,
    minSamples: spec.rate && team === null ? MIN_SAMPLES : 0,
    definedFrom, coverageFrom: definedFrom ?? grid.coverageDay, timezone: ZZ_TZ,
    weeks: grid.weeks.map((w) => ({
      ...windowOf(grid, w, settleMs),
      ...(count ? count(w.fromMs) : { numerator: null, denominator: null, value: null, samples: 0 }),
      available: count !== null,
    })),
  });
}

/** A platform figure no measure names, week by week over the grid under a measure's rules: `rate`
 *  holds each week to the sample minimum, and a week with nothing to divide by has no data. */
export function periodWeeks(grid: Grid, rate: boolean, count: (fromMs: number) => Counted, settleMs = 0): PeriodFigure[] {
  return weekly(grid, "sessions", { ...UNNAMED, rate }, null, grid.coverageDay, count, settleMs).weeks;
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
export function byWeek<R extends { from_ms: number }>(rows: R[]): (fromMs: number, column: keyof R) => number {
  const at = new Map(rows.map((r) => [r.from_ms, r]));
  return (fromMs, column) => Number(at.get(fromMs)?.[column] ?? 0);
}
export const share = (n: number, of: number, scale: number): Counted =>
  ({ numerator: n, denominator: of, value: of === 0 ? null : (scale * n) / of, samples: of });
export const tally = (n: number): Counted => ({ numerator: n, denominator: null, value: n, samples: n });

/** Real-work calls, the malformed and every refusal among them, by week; `team` narrows to one team's.
 *  DELIBERATE: a weekly statement of its own rather than a reduction of `callDays`, so each read takes one row a
 *  week: Status reads it three times on a 1.0 s budget. checks/console-platform-query.ts holds the prepared
 *  query's calls, malformed calls and refusals by week, read from `callDays`, equal to it. */
export async function callWeeks(db: pg.Pool, grid: Grid, team: string | null) {
  return byWeek((await db.query<{ from_ms: number; calls: number; malformed: number; refusals: number }>(
    `select (extract(epoch from (date_trunc('week', e.ts at time zone $1::text) at time zone $1::text)) * 1000)::float8 as from_ms,
            count(*)::int as calls,
            (count(*) filter (where e.refusal_owner = 'ours'))::int as malformed,
            (count(*) filter (where e.refusal_owner is not null))::int as refusals
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
 *  within them, `(t, t + 120s)` after the refusal; when both name an initiative it is the same one
 *  (`followupWeeks` counts them). Several refusals before one success each count, so this counts
 *  refusals with a follow-up, not tasks that recovered. A week groups its refusals by their own time
 *  and is complete once the 120 seconds after its end have been read. */
export async function followupMeasure(db: pg.Pool, grid: Grid, team: string | null = null): Promise<StatusMeasure> {
  return followupOf(grid, await followupWeeks(db, grid, team), team);
}

/** The refusals-put-right measure from `followupWeeks`'s rows. */
export function followupOf(grid: Grid, rows: FollowupRow[], team: string | null): StatusMeasure {
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

/** zz-core's work `knowledge.search` rows that carry `detail.returned`, of one local day (`day`, and the instant its
 *  week starts) and one team (`team` its slug, null for none), split by whether the result set was not empty
 *  (`found`) and whether the engine widened (`widened`, null where `detail.broadened` was not recorded), with the
 *  results they found in all and the latest of each. The one count of searches Status, Knowledge health and the
 *  prepared query reduce. */
type SearchDay = {
  day: string; week_ms: number; team: string | null; found: boolean; widened: boolean | null;
  searches: number; results: number; last_ms: number;
};

/** Searches in `[from, to)`, `from` null for the whole record, as `SearchDay` rows. */
export async function searchDays(db: pg.Pool, to: string, from: string | null): Promise<SearchDay[]> {
  return (await db.query<SearchDay>(
    `select to_char(e.ts at time zone $1::text, 'YYYY-MM-DD') as day,
            (extract(epoch from (date_trunc('week', e.ts at time zone $1::text) at time zone $1::text)) * 1000)::float8 as week_ms,
            t.slug as team,
            (jsonb_typeof(e.detail -> 'returned') = 'array' and e.detail -> 'returned' <> '[]'::jsonb) as found,
            case when e.detail ? 'broadened' then e.detail ->> 'broadened' = 'true' end as widened,
            count(*)::int as searches,
            coalesce(sum(case when jsonb_typeof(e.detail -> 'returned') = 'array' then jsonb_array_length(e.detail -> 'returned') else 0 end), 0)::int as results,
            (extract(epoch from max(e.ts)) * 1000)::float8 as last_ms
       from zz.event e
       left join zz.team t on t.id = e.team_id
      where e.kind = 'knowledge.search' and e.origin = 'work' and e.detail ? 'returned'
        and e.ts < $2::timestamptz and ($3::timestamptz is null or e.ts >= $3::timestamptz)
      group by 1, 2, 3, 4, 5`, [ZZ_TZ, to, from])).rows;
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
  const weeks = new Map<number, { from_ms: number; completed: number; found: number; told: number; widened: number }>();
  for (const d of await searchDays(db, asOf, null)) {
    const w = weeks.get(d.week_ms) ?? { from_ms: d.week_ms, completed: 0, found: 0, told: 0, widened: 0 };
    weeks.set(d.week_ms, {
      from_ms: d.week_ms, completed: w.completed + d.searches, found: w.found + (d.found ? d.searches : 0),
      told: w.told + (d.widened === null ? 0 : d.searches), widened: w.widened + (d.widened ? d.searches : 0),
    });
  }
  const at = byWeek([...weeks.values()]);
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
 *  and not finished. Defined from the first close of any outcome. Only a team's own closes, in both
 *  statements, the condition written out in each so each is one literal check:sql can prepare: not a
 *  release check's probe, the rule the bug figures and `scripts/ops/purge-probes.ts` tell one by, and not
 *  closed by a maintenance client, which zz-core's own `initiative_close` row of the initiative records
 *  with origin `platform`. */
export async function finishedMeasure(db: pg.Pool, grid: Grid): Promise<Measure> {
  const asOf = new Date(grid.asOfMs).toISOString();
  const first = (await db.query<{ day: string | null }>(
    `select to_char(min(i.closed_at) at time zone $2::text, 'YYYY-MM-DD') as day
       from zz.initiative i
      where i.closed_at < $1::timestamptz and i.slug not like '%chain-check-%'
        and not exists (select 1 from zz.event c
                          where c.initiative_id = i.id and c.kind = 'initiative_close' and c.origin = 'platform')`,
    [asOf, ZZ_TZ])).rows[0];
  const at = byWeek((await db.query<{ from_ms: number; finished: number }>(
    `select (extract(epoch from (date_trunc('week', i.closed_at at time zone $1::text) at time zone $1::text)) * 1000)::float8 as from_ms,
            count(*)::int as finished
       from zz.initiative i
      where i.closed_at < $2::timestamptz and i.outcome in ('accepted', 'delivered') and i.slug not like '%chain-check-%'
        and not exists (select 1 from zz.event c
                          where c.initiative_id = i.id and c.kind = 'initiative_close' and c.origin = 'platform')
      group by 1`, [ZZ_TZ, asOf])).rows);
  return weekly(grid, "work_finished", SPECS.work_finished, null, first.day, (w) => tally(at(w, "finished")));
}

/** One team's real reports by how they stand. */
export function ownBugs(reports: Reports, team: string): { filed: number; fixed: number; notABug: number; duplicate: number; open: number } {
  const mine = reports.filter((r) => r.teamId === team);
  const by = (status: string): number => mine.filter((r) => r.status === status).length;
  return { filed: mine.length, fixed: by("fixed"), notABug: by("not_a_bug"), duplicate: by("duplicate"), open: by("open") };
}
