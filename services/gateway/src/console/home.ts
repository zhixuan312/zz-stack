/**
 * GET /api/console/home: the active team's last whole week, what waits on it, and what is open, with
 * the approvals in it signed in the caller's name alone. Every part is read at one cutoff, the read's
 * moment rounded up to a whole second, as the Initiatives list rounds it.
 *
 * Work is the active team's, for the superadmin too: the team is the one the caller's identity acts
 * for, and nothing the request names widens it. Reading Home records nothing: its statements write no
 * row, and the next moves are relayed as the person's console session, for which initiative_status
 * writes no event.
 *
 * The parts, each from one function:
 *
 *   title           homeTitle over the weeks of the team's record, the running week last
 *   waiting         pendingRevisions for the team: how many, the oldest, and the one when one
 *   words           additionsByPeriod by week, with periodFinding's finding and the coverage
 *   approvals       callerApprovals by week, the caller's alone, with periodFinding's finding
 *   foot            the last whole week's words at the stated pace (writingEstimate, basis
 *                   period_net_additions), and observedRuns' coverage and peak over that week
 *   tiles           of the last whole week: closures (closuresByWeek), the median hours to close
 *                   with its count (medianHoursToClose), searches with results with their numerator
 *                   and denominator (searchesWithResults), and the local days a real-work tool call
 *                   of the team was recorded, of the week's seven
 *   runs            observedRuns' runs active at the cutoff, grouped above four, and the last run's end
 *   milestones      nextMilestones over the team's totals as of the cutoff
 *   openWork        initiativeList's waiting rows, then its open rows, five at most, four when quiet
 *                   initiatives are folded into one row of their count
 *   closedLastWeek  the initiatives closed in the last whole week, with their outcomes
 *
 * The weeks are those of the team's record, from the week its first initiative was opened in, the
 * newest 24 whole weeks at most and the running week, so every weekly figure is cut at week grain. The
 * totals are as of the cutoff, over the whole record: read from the same calls when the weeks reach
 * its start, and from a second call over the record when they do not. Words are recorded net
 * additions and lessons those made outside an import cohort, so an import adds nothing to any part.
 *
 * Each part fails alone: what it is read from failing makes it unavailable, or its figure null with
 * why unavailable, and the rest stands. A missing word basis leaves no estimate at all, so no coverage
 * of zeros stands in for one; a missing run record leaves the coverage and peak unavailable; neither
 * is ever a zero.
 *
 * DELIBERATE: no backticks in the comments of this file. check:sql reads it as text, and a backtick in
 * a comment opens a template literal it then parses as code.
 *
 * COUPLED: the console's Home in src/lib/work-shapes.ts, and its fake answer in
 * ../zz-stack-dashboard/scripts/fake-gateway/work-home.ts, which checks/console-work-home.ts compares this route's answer
 * with, key set by key set.
 */
import { writingEstimate, type WritingCoverage } from "@zz/contracts";
import type { Mcp } from "@zz/mcp-client";
import type { Express } from "express";

import { coreFor } from "../core-as-caller.js";
import { platformDb } from "../db.js";
import { callerApprovals } from "./approvals.js";
import type { Figure, Part, PeriodFigure, ReadMeta, Window } from "./figures.js";
import { localDate, periodFinding, type AgentDay, type Finding } from "./findings.js";
import { homeTitle, nextMilestones, type HomeFacts, type Milestone } from "./home-findings.js";
import { lessonImports } from "./imports.js";
import { initiativeList } from "./initiative-list.js";
import { pendingRevisions } from "./pending.js";
import { observedRuns } from "./runs-observed.js";
import { platformPublic, ZZ_TZ } from "./shared.js";
import {
  closuresByWeek, grainFor, lastWholeWeek, medianHoursToClose, periodsOf, searchesWithResults, type ClosureWeek, type Period,
} from "./work-figures.js";
import { additionsByPeriod, documentFacts } from "./writing.js";

type Span = { from: string; to: string };
type Relay = Pick<Mcp, "call">;
type InitiativeRow = Awaited<ReturnType<typeof initiativeList>>["rows"][number];
type ActiveGroup = Awaited<ReturnType<typeof observedRuns>>["active"][number];
type Home = {
  meta: ReadMeta;
  title: ReturnType<typeof homeTitle>;
  waiting: Part<{ count: number; oldestSince: string | null; one: { initiative: string; path: string; version: number } | null }>;
  words: Part<{ weeks: PeriodFigure[]; finding: Finding | null; coverage: WritingCoverage }>;
  approvals: Part<{ weeks: PeriodFigure[]; finding: Finding | null }>;
  foot: { estimate: ReturnType<typeof writingEstimate> | null; coverageMs: Figure; peak: Figure };
  tiles: { closed: PeriodFigure; medianHoursToClose: PeriodFigure; searchesWithResults: PeriodFigure; agentDays: PeriodFigure };
  runs: Part<{ active: ActiveGroup[]; more: number; lastRunAt: string | null }>;
  milestones: Part<Milestone[]>;
  openWork: Part<{ rows: InitiativeRow[]; quiet: number; total: number }>;
  closedLastWeek: Part<{ slug: string; outcome: string; closedAt: string }[]>;
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
/** The whole weeks drawn before the running one, at most: few enough that every window is cut at week grain. */
const WHOLE_WEEKS = 24;
/** Open work's rows, the folded quiet row among them. */
const OPEN_ROWS = 5;
/** The days before the last whole week's Monday read for the agents' run of days, enough to decide a run of 30. */
const RUN_DAYS = 30;

/** An instant as the gateway spells one: ISO 8601 in UTC, whole seconds, with the Z. */
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
/** A local date moved by whole days, on the calendar alone. */
const shiftDate = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const unavailable = (window: Window): PeriodFigure =>
  ({ window, figure: { value: null, why: "unavailable" }, numerator: null, denominator: null });
const countIn = (window: Window, n: number, denominator: number | null = null): PeriodFigure =>
  ({ window, figure: { value: n, why: null }, numerator: n, denominator });
const unread: Figure = { value: null, why: "unavailable" };

/** What a function answers, or null when it failed; the failure is logged under its name. */
async function attempt<T>(what: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    console.error(`console home: ${what} could not be read:`, err);
    return null;
  }
}
const partOf = <T>(data: T | null): Part<T> => (data === null ? { state: "unavailable", reason: "query_failed" } : { state: "ok", data });
/** The figure of the period that starts where the window does. */
const at = <T extends { window: Window }>(list: T[] | null | undefined, w: Window): T | undefined =>
  list?.find((x) => x.window.from === w.from);

/** When the team's first initiative was opened, its knowledge shelf's own left out; null with none. */
async function firstOpened(team: string, asOf: string): Promise<number | null> {
  const { rows } = await platformDb().query<{ first_ms: number | null }>(
    `select (extract(epoch from min(i.opened_at)) * 1000)::float8 as first_ms
       from zz.initiative i
       join zz.team t on t.id = i.team_id
      where t.slug = $1 and i.slug <> '_knowledge' and i.opened_at <= $2::timestamptz`, [team, asOf]);
  return rows[0]?.first_ms ?? null;
}

/** When each lesson on the team's shelf was made before the cutoff, those of an import cohort left out. */
async function lessonsMade(team: string, asOf: string): Promise<number[]> {
  const [{ rows }, imports] = await Promise.all([
    platformDb().query<{ id: string; created_ms: number }>(
      `select n.id::text as id, (extract(epoch from n.created_at) * 1000)::float8 as created_ms
         from zz.knowledge_node n
         join zz.team t on t.id = n.team_id
        where t.slug = $1 and n.created_at < $2::timestamptz`, [team, asOf]),
    lessonImports(asOf),
  ]);
  const imported = new Set(imports.lessons.map((l) => l.id));
  return rows.filter((r) => !imported.has(r.id)).map((r) => r.created_ms);
}

/** Every whole local day from RUN_DAYS before the week's Monday through its Sunday, and whether a
 *  real-work tool call of the team was recorded on it. */
async function agentDaysOf(team: string, week: Window): Promise<AgentDay[]> {
  const first = shiftDate(localDate(week.from, ZZ_TZ), -RUN_DAYS);
  const end = localDate(week.to, ZZ_TZ);
  const { rows } = await platformDb().query<{ day: string }>(
    `select distinct to_char(e.ts at time zone $2::text, 'YYYY-MM-DD') as day
       from zz.event e
       join zz.team t on t.id = e.team_id
      where t.slug = $1 and e.kind = 'tool_call' and e.origin = 'work'
        and e.ts >= ($3::date::timestamp at time zone $2::text) and e.ts < $4::timestamptz`,
    [team, ZZ_TZ, first, week.to]);
  const active = new Set(rows.map((r) => r.day));
  const days: AgentDay[] = [];
  for (let d = first; d < end; d = shiftDate(d, 1)) days.push({ day: d, active: active.has(d) });
  return days;
}

/** What waits on the team: how many revisions, since when the oldest, and the one when there is one. */
async function waitingOf(team: string, asOf: string): Promise<{ count: number; oldestSince: string | null; one: { initiative: string; path: string; version: number } | null }> {
  const queue = (await pendingRevisions(asOf)).filter((p) => p.team === team);
  let one = null;
  if (queue.length === 1) {
    // The public version of the revision waiting, which pendingRevisions names by its revision.
    const [p] = queue;
    const { rows: [row] } = await platformDb().query<{ version: number }>(
      `select r.version
         from zz.doc_revision r
         join zz.doc d on d.id = r.doc_id
         join zz.initiative i on i.id = d.initiative_id
         join zz.team t on t.id = i.team_id
        where t.slug = $1 and i.slug = $2 and d.path = $3 and r.revision = $4`, [team, p.initiative, p.path, p.revision]);
    one = row ? { initiative: p.initiative, path: p.path, version: row.version } : null;
  }
  return { count: queue.length, oldestSince: queue.length ? iso(queue[0].presentedMs) : null, one };
}

/** The team's initiatives closed inside the week, the earliest first. */
async function closedIn(team: string, week: Window): Promise<{ slug: string; outcome: string; closedAt: string }[]> {
  const { rows } = await platformDb().query<{ slug: string; outcome: string; closed_ms: number }>(
    `select i.slug, i.outcome, (extract(epoch from i.closed_at) * 1000)::float8 as closed_ms
       from zz.initiative i
       join zz.team t on t.id = i.team_id
      where t.slug = $1 and i.slug <> '_knowledge'
        and i.closed_at >= $2::timestamptz and i.closed_at < $3::timestamptz
      order by i.closed_at, i.slug`, [team, week.from, week.to]);
  return rows.map((r) => ({ slug: r.slug, outcome: r.outcome, closedAt: iso(r.closed_ms) }));
}

/** Open work: the waiting rows, then the open ones, each with its next move; the quiet folded into one
 *  row of their count, which takes the last of the five places. */
async function openWorkOf(team: string, asOf: string, relay: Relay): Promise<{ rows: InitiativeRow[]; quiet: number; total: number }> {
  const page = { flow: null, q: "", limit: OPEN_ROWS, offset: 0 };
  const [waiting, open] = await Promise.all([
    initiativeList(team, { state: "waiting", ...page }, asOf, relay),
    initiativeList(team, { state: "open", ...page }, asOf, relay),
  ]);
  // Open, waiting and quiet are every initiative not closed, so the quiet are the rest of the open.
  const quiet = waiting.tiles.open - waiting.tiles.waiting - open.total;
  return { rows: [...waiting.rows, ...open.rows].slice(0, quiet > 0 ? OPEN_ROWS - 1 : OPEN_ROWS), quiet, total: waiting.tiles.open };
}

/** Closures in a week: the three outcomes together. */
const closed = (w: ClosureWeek): number => (w.accepted.value ?? 0) + (w.delivered.value ?? 0) + (w.abandoned.value ?? 0);
const sum = (figures: PeriodFigure[]): number => figures.reduce((n, p) => n + (p.figure.value ?? 0), 0);

/** Home for the team at the cutoff, the approvals in it the caller's. */
async function homeOf(team: string, caller: string, asOf: string, relay: Relay): Promise<Home> {
  const [week, firstMs] = await Promise.all([lastWholeWeek(asOf), firstOpened(team, asOf)]);
  const weekMs = Date.parse(week.from);
  // The record's first week, the last whole week at the latest and the newest WHOLE_WEEKS at most. A
  // Monday noon is the probe, so a daylight saving hour cannot carry it into the week before.
  const probe = Math.max(Math.min(firstMs ?? weekMs, weekMs), weekMs - (WHOLE_WEEKS - 1) * WEEK + 12 * HOUR);
  const startMs = (await periodsOf({ from: iso(probe), to: asOf }, asOf, "week"))[0].fromMs;
  const span: Span = { from: iso(startMs), to: asOf };
  const lastWeek: Span = { from: week.from, to: week.to };
  // The whole record, for the totals, when the weeks do not reach its start.
  const record: Span | null = firstMs !== null && firstMs < startMs ? { from: iso(firstMs), to: asOf } : null;

  const [periods, words, docs, mine, closures, medians, searches, runs, lessons, days, waiting, open, closedLast, wholeWords, wholeDocs, wholeClosures] =
    await Promise.all([
      periodsOf(span, asOf, "week"),
      attempt("the words added", () => additionsByPeriod(team, span, asOf)),
      attempt("the documents created", () => documentFacts(team, span, asOf)),
      attempt("the caller's approvals", () => callerApprovals(team, caller, span, asOf, "week")),
      attempt("the closures", () => closuresByWeek(team, span, asOf, "week")),
      attempt("the median hours to close", () => medianHoursToClose(team, span, asOf, "week")),
      attempt("the searches with results", () => searchesWithResults(team, lastWeek, asOf, "week")),
      attempt("the observed runs", () => observedRuns(team, lastWeek, asOf)),
      attempt("the lessons adopted", () => lessonsMade(team, asOf)),
      attempt("the agents' days", () => agentDaysOf(team, week)),
      attempt("what waits", () => waitingOf(team, asOf)),
      attempt("the open work", () => openWorkOf(team, asOf, relay)),
      attempt("last week's closures", () => closedIn(team, week)),
      record && attempt("the words added over the record", () => additionsByPeriod(team, record, asOf)),
      record && attempt("the documents created over the record", () => documentFacts(team, record, asOf)),
      record && attempt("the closures over the record", () => closuresByWeek(team, record, asOf, grainFor(record))),
    ]);
  const last = at(periods, week)!;

  // The weeks the title is chosen over: those of the team's record, none before it.
  const factWeeks = periods.filter((p) => firstMs !== null && p.toMs > firstMs).map((p: Period): HomeFacts["weeks"][number] => {
    const median = at(medians?.periods, p.window);
    return {
      window: p.window,
      closed: closures ? closed(at(closures, p.window)!) : null,
      words: words ? at(words.periods, p.window)?.figure.value ?? null : null,
      approvals: mine ? at(mine.periods, p.window)?.figure.value ?? null : null,
      lessons: lessons ? lessons.filter((ms) => ms >= p.fromMs && ms < p.toMs).length : null,
      documentsCreated: docs ? at(docs.documentsCreated, p.window)?.figure.value ?? null : null,
      medianHoursToClose: median && median.figure.value !== null ? { hours: median.figure.value, cohort: median.denominator ?? 0 } : null,
    };
  });
  const totals: HomeFacts["totals"] = {
    closed: record ? (wholeClosures ? wholeClosures.reduce((n, w) => n + closed(w), 0) : null) : closures && closures.reduce((n, w) => n + closed(w), 0),
    documents: record ? (wholeDocs ? sum(wholeDocs.documentsCreated) : null) : docs && sum(docs.documentsCreated),
    lessons: lessons && lessons.length,
    words: record ? (wholeWords ? sum(wholeWords.periods) : null) : words && sum(words.periods),
  };
  const title = homeTitle({ timezone: ZZ_TZ, weeks: factWeeks, totals, agentDays: days ?? [] });
  const milestones = nextMilestones(totals);
  const finding = (weeks: PeriodFigure[], label: string): Finding | null =>
    periodFinding(weeks, { label, better: "neutral", timezone: ZZ_TZ, precision: 0, coverageFrom: null, countLabel: null });
  const inWeek = days?.filter((d) => d.day >= localDate(week.from, ZZ_TZ) && d.day < localDate(week.to, ZZ_TZ));
  const lastClosures = at(closures, week);

  return {
    meta: {
      asOf, timezone: ZZ_TZ, period: { from: span.from, to: asOf }, scope: "caller-in-active-team",
      population: `${team}'s work last week, and the approvals signed in the caller's name there`,
      coverageFrom: firstMs === null ? null : iso(firstMs),
    },
    title,
    waiting: partOf(waiting),
    words: partOf(words && { weeks: words.periods, finding: finding(words.periods, "words added"), coverage: words.coverage }),
    approvals: partOf(mine && { weeks: mine.periods, finding: finding(mine.periods, "approvals in your name") }),
    foot: {
      estimate: words ? writingEstimate(at(words.periods, week)?.figure.value ?? null, "period_net_additions", words.coverage) : null,
      coverageMs: runs ? { value: runs.coverageMs, why: null } : unread,
      peak: runs ? { value: runs.peak, why: null } : unread,
    },
    tiles: {
      closed: lastClosures ? countIn(last.window, closed(lastClosures)) : unavailable(last.window),
      medianHoursToClose: at(medians?.periods, week) ?? unavailable(last.window),
      searchesWithResults: at(searches, week) ?? unavailable(last.window),
      agentDays: inWeek ? countIn(last.window, inWeek.filter((d) => d.active).length, inWeek.length) : unavailable(last.window),
    },
    runs: partOf(runs && { active: runs.active, more: runs.activeMore, lastRunAt: runs.lastRunAt }),
    milestones: partOf(Object.values(totals).every((v) => v === null) ? null : milestones),
    openWork: partOf(open),
    closedLastWeek: partOf(closedLast),
  };
}

export function mountHome(app: Express): void {
  /** Home, for the team the caller's identity acts for and no other, the approvals the caller's own. */
  app.get("/api/console/home", platformPublic("home", async (req, res, { activeTeam }) => {
    if (activeTeam === null) {
      res.status(400).json({ error: "no team: Work is the active team's, and you act for none" });
      return;
    }
    // The cutoff in whole seconds, rounded up, so what was written in the second the read began is inside it.
    res.json(await homeOf(activeTeam, req.zzIdentity!.email, iso(Math.ceil(Date.now() / 1000) * 1000), coreFor(req)));
  }));
}
