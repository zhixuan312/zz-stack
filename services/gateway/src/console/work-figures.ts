/**
 * The figures Work's reads share over a team's initiatives and searches: the grain a window is drawn
 * at, its periods, closures by period and outcome, the median hours to close and to abandon, the most
 * initiatives open at once, the initiatives opened, and the searches that found something.
 *
 * Every function takes the team's slug, a window from one instant up to another, and the read's
 * cutoff, and counts what happened inside the window and before the cutoff. A period is cut on the reporting timezone's
 * calendar at the grain asked for, the running one not complete, and every figure is computed from
 * that period's own observations, never from finer periods. The team's knowledge shelf, the
 * _knowledge initiative, is never one of its initiatives.
 *
 * The searches are not counted here: they come from searchDays, the one statement Status, Knowledge
 * health and the Platform prepared query reduce (platform-measures.ts), narrowed to the team.
 *
 * Each function throws when its statement fails; the read decides what a failure makes of its part.
 *
 * DELIBERATE: no backticks in the comments of this file. check:sql reads it as text, and a backtick
 * in a comment opens a template literal it then parses as code.
 *
 * COUPLED: the console's InitiativeList, Home and RecordRead in src/lib/work-shapes.ts, and the
 * fake's answers in ../zz-stack-dashboard/scripts/fake-gateway/work-*.ts, which draw these figures.
 */
import { OUTCOMES } from "@zz/contracts";
import { platformDb } from "../db.js";
import type { Figure, PeriodFigure, Window } from "./figures.js";
import { searchDays } from "./platform-measures.js";
import { ZZ_TZ } from "./shared.js";
import { localDay } from "./work-query-buckets.js";

export type Grain = "week" | "month" | "quarter";
/** A window as a caller names it: two instants, the first in it and the first after it. */
type Span = { from: string; to: string };
export type ClosureWeek = { window: Window; accepted: Figure; delivered: Figure; abandoned: Figure };
type Outcome = (typeof OUTCOMES)[number];
/** One period of a window, as instants in milliseconds, and as the window a figure states. */
export type Period = { fromMs: number; toMs: number; window: Window };

const HOUR = 3_600_000;
const STEP: Record<Grain, string> = { week: "1 week", month: "1 month", quarter: "3 months" };
/** An instant as the gateway spells one: ISO 8601 in UTC, whole seconds, with the Z. */
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Weeks up to 26 of them, months up to three years, quarters beyond. */
export function grainFor(window: Span): Grain {
  const from = new Date(window.from), to = Date.parse(window.to);
  if (to - from.getTime() <= 26 * 7 * 24 * HOUR) return "week";
  const three = new Date(from);
  three.setUTCFullYear(three.getUTCFullYear() + 3);
  return to <= three.getTime() ? "month" : "quarter";
}

/** The window's periods at the grain, oldest first: the first holds the window's start, the last its
 *  end or the cutoff, whichever is earlier. None when the window holds nothing before the cutoff. */
export async function periodsOf(window: Span, asOf: string, grain: Grain): Promise<Period[]> {
  const fromMs = Date.parse(window.from);
  const endMs = Math.min(Date.parse(window.to), Date.parse(asOf));
  if (endMs <= fromMs) return [];
  const { rows } = await platformDb().query<{ from_ms: number; to_ms: number }>(
    `select (extract(epoch from (p at time zone $1::text)) * 1000)::float8 as from_ms,
            (extract(epoch from ((p + $2::interval) at time zone $1::text)) * 1000)::float8 as to_ms
       from generate_series(date_trunc($3::text, $4::timestamptz at time zone $1::text),
                            date_trunc($3::text, $5::timestamptz at time zone $1::text),
                            $2::interval) as p
      order by p`,
    [ZZ_TZ, STEP[grain], grain, new Date(fromMs).toISOString(), new Date(endMs - 1).toISOString()]);
  return rows.map((r) => ({ fromMs: r.from_ms, toMs: r.to_ms, window: windowOf(r.from_ms, r.to_ms, window, asOf) }));
}

/** The last whole week before the cutoff, Monday to Monday in the reporting timezone. */
export async function lastWholeWeek(asOf: string): Promise<Window> {
  const asOfMs = Date.parse(asOf);
  const weeks = await periodsOf({ from: iso(asOfMs - 14 * 24 * HOUR), to: asOf }, asOf, "week");
  return weeks.filter((w) => w.toMs <= asOfMs).at(-1)!.window;
}

/** A period as a window: observed over the part of it inside the window and before the cutoff, and
 *  complete when it lies wholly inside the window and has ended. */
function windowOf(pFromMs: number, pToMs: number, window: Span, asOf: string): Window {
  const fromMs = Date.parse(window.from), toMs = Date.parse(window.to), asOfMs = Date.parse(asOf);
  return {
    from: iso(pFromMs), to: iso(pToMs),
    observedFrom: iso(Math.max(pFromMs, fromMs)),
    observedThrough: iso(Math.min(pToMs, toMs, asOfMs)),
    complete: pFromMs >= fromMs && pToMs <= toMs && pToMs <= asOfMs,
  };
}

/** The whole window as one period. */
const overallOf = (window: Span, asOf: string): Window =>
  windowOf(Date.parse(window.from), Date.parse(window.to), window, asOf);

/** The instants a window counts from and up to: inside it and before the cutoff. */
const boundsOf = (window: Span, asOf: string): [string, string] =>
  [window.from, new Date(Math.min(Date.parse(window.to), Date.parse(asOf))).toISOString()];

/** The team's initiatives closed inside the window before the cutoff, with when each opened. */
async function closuresIn(team: string, window: Span, asOf: string): Promise<{ outcome: Outcome; openedMs: number; closedMs: number }[]> {
  const [from, end] = boundsOf(window, asOf);
  const { rows } = await platformDb().query<{ outcome: Outcome; opened_ms: number; closed_ms: number }>(
    `select i.outcome, (extract(epoch from i.opened_at) * 1000)::float8 as opened_ms,
            (extract(epoch from i.closed_at) * 1000)::float8 as closed_ms
       from zz.initiative i
       join zz.team t on t.id = i.team_id
      where t.slug = $1 and i.slug <> '_knowledge'
        and i.closed_at >= $2::timestamptz and i.closed_at < $3::timestamptz`, [team, from, end]);
  return rows.map((r) => ({ outcome: r.outcome, openedMs: r.opened_ms, closedMs: r.closed_ms }));
}

const counted = (n: number): Figure => ({ value: n, why: null });
const inside = (ms: number, p: Period): boolean => ms >= p.fromMs && ms < p.toMs;

/** Closures by period and outcome, all three outcomes, each period's counts its own. */
export async function closuresByWeek(team: string, window: Span, asOf: string, grain: Grain): Promise<ClosureWeek[]> {
  const [periods, closures] = await Promise.all([periodsOf(window, asOf, grain), closuresIn(team, window, asOf)]);
  return periods.map((p) => {
    const here = closures.filter((c) => inside(c.closedMs, p));
    const of = (o: Outcome): Figure => counted(here.filter((c) => c.outcome === o).length);
    return { window: p.window, ...(Object.fromEntries(OUTCOMES.map((o) => [o, of(o)])) as Record<Outcome, Figure>) };
  });
}

/** The median of a non-empty list. */
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** The median of the hours from opened to closed, the closures counted as its denominator. */
const medianFigure = (window: Window, hours: number[]): PeriodFigure => ({
  window,
  figure: hours.length ? { value: median(hours), why: null } : { value: null, why: "no_data" },
  numerator: null, denominator: hours.length,
});

/** Each period's median hours from opened to closed over the closures of the outcomes named in it, and
 *  the same over the whole window. */
async function medianHours(team: string, window: Span, asOf: string, grain: Grain, outcomes: readonly Outcome[]) {
  const [periods, closures] = await Promise.all([periodsOf(window, asOf, grain), closuresIn(team, window, asOf)]);
  const mine = closures.filter((c) => outcomes.includes(c.outcome));
  const hours = (cs: typeof mine): number[] => cs.map((c) => (c.closedMs - c.openedMs) / HOUR);
  return {
    periods: periods.map((p) => medianFigure(p.window, hours(mine.filter((c) => inside(c.closedMs, p))))),
    overall: medianFigure(overallOf(window, asOf), hours(mine)),
  };
}

/** Median hours to close, over every closure whatever its outcome. */
export function medianHoursToClose(team: string, window: Span, asOf: string, grain: Grain): Promise<{ periods: PeriodFigure[]; overall: PeriodFigure }> {
  return medianHours(team, window, asOf, grain, OUTCOMES);
}

/** Median hours until abandoned work stopped: over the closures recorded as abandoned. */
export function medianHoursToAbandon(team: string, window: Span, asOf: string, grain: Grain): Promise<{ periods: PeriodFigure[]; overall: PeriodFigure }> {
  return medianHours(team, window, asOf, grain, ["abandoned"]);
}

/** The largest number of the team's initiatives open at one moment inside the window, and the first
 *  moment it was reached; a close and an open at the same instant are not open together. */
export async function mostOpenAtOnce(team: string, window: Span, asOf: string): Promise<{ value: Figure; at: string | null }> {
  const [from, end] = boundsOf(window, asOf);
  const { rows } = await platformDb().query<{ opened_ms: number; closed_ms: number | null }>(
    `select (extract(epoch from i.opened_at) * 1000)::float8 as opened_ms,
            (extract(epoch from i.closed_at) * 1000)::float8 as closed_ms
       from zz.initiative i
       join zz.team t on t.id = i.team_id
      where t.slug = $1 and i.slug <> '_knowledge'
        and i.opened_at < $3::timestamptz and (i.closed_at is null or i.closed_at > $2::timestamptz)`, [team, from, end]);
  const fromMs = Date.parse(from), endMs = Date.parse(end);
  // Each change in the count, a close before an open at the same instant; what opened before the
  // window counts from its start.
  const changes = rows.flatMap((r) => [
    { at: Math.max(r.opened_ms, fromMs), by: 1 },
    ...(r.closed_ms !== null && r.closed_ms < endMs ? [{ at: r.closed_ms, by: -1 }] : []),
  ]).sort((a, b) => a.at - b.at || a.by - b.by);
  let open = 0, most = 0, at: number | null = null;
  for (const c of changes) {
    open += c.by;
    if (open > most) { most = open; at = c.at; }
  }
  return { value: counted(most), at: at === null ? null : iso(at) };
}

/** The team's initiatives opened inside the window before the cutoff, the earliest first. */
export async function openedRows(team: string, window: Span, asOf: string): Promise<{ slug: string; flow: string | null; opened: string }[]> {
  const [from, end] = boundsOf(window, asOf);
  const { rows } = await platformDb().query<{ slug: string; flow: string | null; opened_ms: number }>(
    `select i.slug, i.flow, (extract(epoch from i.opened_at) * 1000)::float8 as opened_ms
       from zz.initiative i
       join zz.team t on t.id = i.team_id
      where t.slug = $1 and i.slug <> '_knowledge'
        and i.opened_at >= $2::timestamptz and i.opened_at < $3::timestamptz
      order by i.opened_at, i.slug`, [team, from, end]);
  return rows.map((r) => ({ slug: r.slug, flow: r.flow, opened: iso(r.opened_ms) }));
}

/** Searches with results by period: of the team's completed searches, zz-core's work knowledge.search
 *  rows carrying detail.returned, those whose result set was not empty, as a share of 100. A period
 *  with no completed search has no data.
 *
 *  The rows are searchDays', the one statement every caller of this count reduces, narrowed to the
 *  team: a row whose team did not resolve is null and belongs to no team's figure, as the inner join
 *  left it out before, and stays in Status's platform-wide one. */
export async function searchesWithResults(team: string, window: Span, asOf: string, grain: Grain): Promise<PeriodFigure[]> {
  const [from, end] = boundsOf(window, asOf);
  const [periods, days] = await Promise.all([
    periodsOf(window, asOf, grain),
    searchDays(platformDb(), end, from),
  ]);
  const mine = days.filter((d) => d.team === team);
  return periods.map((p) => {
    // A local day compared with a period as Home compares one with a week, so a search counts in the
    // period its own local date falls in.
    const first = localDay(p.fromMs), after = localDay(p.toMs);
    const here = mine.filter((d) => d.day >= first && d.day < after);
    const denominator = here.reduce((n, d) => n + d.searches, 0);
    const found = here.reduce((n, d) => n + (d.found ? d.searches : 0), 0);
    return {
      window: p.window,
      figure: denominator ? { value: (100 * found) / denominator, why: null } : { value: null, why: "no_data" },
      numerator: found, denominator,
    };
  });
}
