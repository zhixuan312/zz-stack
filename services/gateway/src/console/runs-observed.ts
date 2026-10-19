/**
 * The agent runs a team's reads observe: what ran inside a window, how much of it the runs covered
 * and how many ran at once, which skills ran and when, and what ran in the five minutes before the
 * cutoff.
 *
 * A run is one zz.skill_run row of the team, covering the span from its first call (started_at) to its
 * last (ended_at), its skill named through its skill version. The record holds no running state and
 * every run has an end, so nothing here is called running and no interval is left open.
 *
 * A run is the team's agents only for its real-work calls. Its counters are recomputed from every event
 * of its session whatever client made it, so what a maintenance client added is read back from the
 * events carrying the run's id with origin platform and taken off its calls, refusals and output
 * below. A run every call of which was a maintenance client's is no run at all, here and wherever runs
 * are read the same way: the skills read and Record's first run. A run
 * whose events the record no longer holds, or never held, keeps its counters whole: nothing in it is
 * attributable to maintenance.
 *
 *   - Coverage is the length of the union of the runs' spans clipped to the window and the cutoff, so
 *     time two runs share is counted once; the summed duration adds each clipped span, so it is
 *     counted once per run. A run of one call has no length and covers nothing: it adds to neither,
 *     and zeroLength counts it.
 *   - The peak is the most runs open at one instant. A run ending at an instant and another starting
 *     at it are not open together, and a run of no length is open at no instant.
 *   - A run is counted, by skill, by weekday and hour and by day, once, at its first call: those
 *     whose first call is inside the window and before the cutoff. One that began before the window
 *     adds its clipped time to coverage and is not counted.
 *   - Active is relative to the cutoff and not the window: a run whose recorded end is no more than
 *     five minutes before the cutoff and not after it. While four or fewer are active each is its own
 *     group; above four they are grouped by initiative, the group with the latest call first, and at
 *     most four groups are answered, activeMore counting the runs of the groups left out.
 *   - lastRunAt is the latest recorded end of any of the team's runs at or before the cutoff.
 *
 * Weekday by hour (Monday first) and the days of the window are cut on the reporting timezone's
 * calendar. Every function throws when its statement fails; the read decides what a failure makes of
 * its part. runsIn answers each run with its calls, its refusals and its observed output as recorded;
 * Runs reads every run of the team through it, with isActive's five minutes and overlapOf's union and
 * peak, so a run is active, and a union is cut, the same way on every page.
 *
 * DELIBERATE: no backticks in the comments of this file. check:sql reads it as text, and a backtick
 * in a comment opens a template literal it then parses as code.
 *
 * COUPLED: the console's ActiveGroup, Home and RecordRead in src/lib/work-shapes.ts and Runs in
 * src/lib/destination-shapes.ts, and the fake's answers in ../zz-stack-dashboard/scripts/fake-gateway/work-home.ts,
 * work-record.ts and work-runs.ts, which draw these figures.
 */
import { platformDb } from "../db.js";
import { ZZ_TZ } from "./shared.js";

/** A window as a caller names it: two instants, the first in it and the first after it. */
type Span = { from: string; to: string };
type RunRow = {
  id: string; initiative: string | null; skill: string; startedAt: string; endedAt: string;
  calls: number; refusals: number; bytes: number | null;
};
type ActiveGroup = { initiative: string | null; runs: { skill: string; startedAt: string; lastAt: string }[] };
type ObservedRuns = {
  runs: number; zeroLength: number; coverageMs: number; summedMs: number; peak: number;
  active: ActiveGroup[]; activeMore: number; lastRunAt: string | null;
  bySkill: { skill: string; runs: number }[]; skillsUsed: number;
  weekdayHour: number[][];
  days: { day: string; runs: number }[];
};

/* What a maintenance client added to a run r of zz.skill_run is joined beside it as m: its calls, refusals and output
 * bytes, from the events carrying the run's id with origin platform, and how many of the run's real-work events measured
 * output, one index lookup a run (event_run). A run is real work while r.calls > m.calls; its own calls, refusals and
 * bytes are the counters less m's, and output a maintenance client alone measured is null, never zero. Written out
 * whole in every statement that reads runs, so each is one literal check:sql can prepare.
 * COUPLED: the same join and the same three expressions in skills.ts and record-slices.ts (firstActs). */

const ACTIVE_MS = 5 * 60_000;
/** Whether a run whose recorded end is endedMs is active at the cutoff: no more than five minutes before it and not after. */
export const isActive = (endedMs: number, asOfMs: number): boolean => endedMs <= asOfMs && asOfMs - endedMs <= ACTIVE_MS;
/** Above this many active runs they are grouped by initiative, and this many groups are answered. */
const GROUPS = 4;
/** An instant as the gateway spells one: ISO 8601 in UTC, whole seconds, with the Z. */
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

type Row = {
  id: string; initiative: string | null; skill: string; started_ms: number; ended_ms: number;
  calls: number; refusals: number; bytes: number | null;
  day: string; weekday: number; hour: number;
};

/** A run read for what ran lately. */
type Recent = { initiative: string | null; skill: string; started_ms: number; ended_ms: number };

/** The instants a window counts from and up to: inside it and before the cutoff. */
const boundsOf = (window: Span, asOf: string): [number, number] =>
  [Date.parse(window.from), Math.min(Date.parse(window.to), Date.parse(asOf))];

/** The team's runs that touch the window before the cutoff, with the local day, weekday and hour of
 *  each one's first call. */
async function rowsOf(team: string, window: Span, asOf: string): Promise<Row[]> {
  const [fromMs, endMs] = boundsOf(window, asOf);
  if (endMs <= fromMs) return [];
  const { rows } = await platformDb().query<Row>(
    `select r.id::text as id, i.slug as initiative, s.name as skill,
            (extract(epoch from r.started_at) * 1000)::float8 as started_ms,
            (extract(epoch from r.ended_at) * 1000)::float8 as ended_ms,
            (r.calls - m.calls) as calls, (r.refusals - m.refusals) as refusals,
            (case when m.calls = 0 then r.bytes_total when m.measured = 0 then null else r.bytes_total - m.bytes end)::float8 as bytes,
            to_char(r.started_at at time zone $4::text, 'YYYY-MM-DD') as day,
            (extract(isodow from r.started_at at time zone $4::text) - 1)::int as weekday,
            extract(hour from r.started_at at time zone $4::text)::int as hour
       from zz.skill_run r
       join zz.team t on t.id = r.team_id
       join zz.skill_version sv on sv.id = r.skill_version_id
       join zz.skill s on s.id = sv.skill_id
       left join zz.initiative i on i.id = r.initiative_id
       cross join lateral (
         select (count(*) filter (where e.origin = 'platform'))::int as calls,
                (count(*) filter (where e.origin = 'platform' and e.ok is false))::int as refusals,
                coalesce(sum(e.response_bytes) filter (where e.origin = 'platform'), 0) as bytes,
                count(e.response_bytes) filter (where e.origin = 'work') as measured
           from zz.event e
          where e.run_id = r.id) m
      where t.slug = $1 and r.started_at < $3::timestamptz and r.ended_at >= $2::timestamptz and r.calls > m.calls
      order by r.started_at, r.id`,
    [team, new Date(fromMs).toISOString(), new Date(endMs).toISOString(), ZZ_TZ]);
  return rows;
}

/** The team's runs that touch the window before the cutoff, as recorded: the rows the figures reduce. */
export async function runsIn(team: string, window: Span, asOf: string): Promise<RunRow[]> {
  return (await rowsOf(team, window, asOf)).map((r) => ({
    id: r.id, initiative: r.initiative, skill: r.skill, startedAt: iso(r.started_ms), endedAt: iso(r.ended_ms),
    calls: r.calls, refusals: r.refusals, bytes: r.bytes,
  }));
}

/** Every local day the window holds up to the cutoff, the earliest first. */
async function daysOf(window: Span, asOf: string): Promise<string[]> {
  const [fromMs, endMs] = boundsOf(window, asOf);
  if (endMs <= fromMs) return [];
  const { rows } = await platformDb().query<{ day: string }>(
    `select to_char(d, 'YYYY-MM-DD') as day
       from generate_series(($2::timestamptz at time zone $1::text)::date,
                            ($3::timestamptz at time zone $1::text)::date,
                            interval '1 day') as d
      order by d`,
    [ZZ_TZ, new Date(fromMs).toISOString(), new Date(endMs - 1).toISOString()]);
  return rows.map((r) => r.day);
}

/** The team's runs whose recorded end is in the five minutes up to the cutoff, and the latest end at
 *  or before it. */
async function lately(team: string, asOf: string): Promise<{ active: Recent[]; last: number | null }> {
  const asOfIso = new Date(Date.parse(asOf)).toISOString();
  const sinceIso = new Date(Date.parse(asOf) - ACTIVE_MS).toISOString();
  const [active, last] = await Promise.all([
    platformDb().query<Recent>(
      `select i.slug as initiative, s.name as skill,
              (extract(epoch from r.started_at) * 1000)::float8 as started_ms,
              (extract(epoch from r.ended_at) * 1000)::float8 as ended_ms
         from zz.skill_run r
         join zz.team t on t.id = r.team_id
         join zz.skill_version sv on sv.id = r.skill_version_id
         join zz.skill s on s.id = sv.skill_id
         left join zz.initiative i on i.id = r.initiative_id
         cross join lateral (
           select (count(*) filter (where e.origin = 'platform'))::int as calls,
                  (count(*) filter (where e.origin = 'platform' and e.ok is false))::int as refusals,
                  coalesce(sum(e.response_bytes) filter (where e.origin = 'platform'), 0) as bytes,
                  count(e.response_bytes) filter (where e.origin = 'work') as measured
             from zz.event e
            where e.run_id = r.id) m
        where t.slug = $1 and r.ended_at >= $2::timestamptz and r.ended_at <= $3::timestamptz and r.calls > m.calls`,
      [team, sinceIso, asOfIso]),
    platformDb().query<{ last_ms: number | null }>(
      `select (extract(epoch from max(r.ended_at)) * 1000)::float8 as last_ms
         from zz.skill_run r
         join zz.team t on t.id = r.team_id
         cross join lateral (
           select (count(*) filter (where e.origin = 'platform'))::int as calls,
                  (count(*) filter (where e.origin = 'platform' and e.ok is false))::int as refusals,
                  coalesce(sum(e.response_bytes) filter (where e.origin = 'platform'), 0) as bytes,
                  count(e.response_bytes) filter (where e.origin = 'work') as measured
             from zz.event e
            where e.run_id = r.id) m
        where t.slug = $1 and r.ended_at <= $2::timestamptz and r.calls > m.calls`,
      [team, asOfIso]),
  ]);
  return { active: active.rows, last: last.rows[0]?.last_ms ?? null };
}

/** The active runs as groups: one a run while there are four or fewer, by initiative above that. The
 *  latest call first, in a group and among groups; then the initiative's slug, none last. */
function groupsOf(active: Recent[]): { groups: ActiveGroup[]; more: number } {
  const runs = [...active].sort((a, b) => b.ended_ms - a.ended_ms || b.started_ms - a.started_ms || a.skill.localeCompare(b.skill));
  const asRun = (r: (typeof runs)[number]) => ({ skill: r.skill, startedAt: iso(r.started_ms), lastAt: iso(r.ended_ms) });
  if (runs.length <= GROUPS) return { groups: runs.map((r) => ({ initiative: r.initiative, runs: [asRun(r)] })), more: 0 };
  const byInitiative = new Map<string | null, typeof runs>();
  for (const r of runs) byInitiative.set(r.initiative, [...(byInitiative.get(r.initiative) ?? []), r]);
  const groups = [...byInitiative.entries()].sort(([ia, ra], [ib, rb]) =>
    rb[0].ended_ms - ra[0].ended_ms || (ia === null ? 1 : ib === null ? -1 : ia.localeCompare(ib)));
  return {
    groups: groups.slice(0, GROUPS).map(([initiative, rs]) => ({ initiative, runs: rs.map(asRun) })),
    more: groups.slice(GROUPS).reduce((n, [, rs]) => n + rs.length, 0),
  };
}

/** The union's length and the most open at once, over spans already clipped. */
export function overlapOf(spans: [number, number][]): { coverageMs: number; peak: number } {
  const open = spans.filter(([s, e]) => e > s);
  let coverageMs = 0, reach = -Infinity;
  for (const [s, e] of [...open].sort((a, b) => a[0] - b[0])) {
    if (e > reach) { coverageMs += e - Math.max(s, reach); reach = e; }
  }
  // An end before a start at the same instant, so runs that only touch are not open together.
  const changes = open.flatMap(([s, e]) => [{ at: s, by: 1 }, { at: e, by: -1 }]).sort((a, b) => a.at - b.at || a.by - b.by);
  let now = 0, peak = 0;
  for (const c of changes) { now += c.by; peak = Math.max(peak, now); }
  return { coverageMs, peak };
}

/** What the team's runs did inside the window before the cutoff, and what ran in the five minutes up
 *  to the cutoff. */
export async function observedRuns(team: string, window: Span, asOf: string): Promise<ObservedRuns> {
  const [rows, days, recent] = await Promise.all([rowsOf(team, window, asOf), daysOf(window, asOf), lately(team, asOf)]);
  const [fromMs, endMs] = boundsOf(window, asOf);
  const spans = rows.map((r): [number, number] => [Math.max(r.started_ms, fromMs), Math.min(r.ended_ms, endMs)]);
  const counted = rows.filter((r) => r.started_ms >= fromMs);

  const skills = new Map<string, number>();
  for (const r of counted) skills.set(r.skill, (skills.get(r.skill) ?? 0) + 1);
  const weekdayHour = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  for (const r of counted) weekdayHour[r.weekday][r.hour] += 1;
  const perDay = new Map<string, number>();
  for (const r of counted) perDay.set(r.day, (perDay.get(r.day) ?? 0) + 1);
  const { groups, more } = groupsOf(recent.active);

  return {
    runs: counted.length,
    zeroLength: counted.filter((r) => r.ended_ms === r.started_ms).length,
    ...overlapOf(spans),
    summedMs: spans.reduce((n, [s, e]) => n + Math.max(0, e - s), 0),
    active: groups, activeMore: more,
    lastRunAt: recent.last === null ? null : iso(recent.last),
    bySkill: [...skills.entries()].map(([skill, runs]) => ({ skill, runs }))
      .sort((a, b) => b.runs - a.runs || a.skill.localeCompare(b.skill)),
    skillsUsed: skills.size,
    weekdayHour,
    days: days.map((day) => ({ day, runs: perDay.get(day) ?? 0 })),
  };
}
