/**
 * /api/console/platform/usage — how the platform is used, answered alike to everybody the console
 * lets in, with the superadmin's calls by week split by team.
 *
 * The weeks are `readGrid`'s, the 26 newest, the running one not complete; "the last week" is the
 * one before the running week and "the week before" the one before that. Every figure counts real
 * work (`tool_call`, `origin = 'work'`) unless its part names another population:
 *
 *   tiles        calls, the share refused (refusals over calls), the slowest 5% of calls and the
 *                sessions, by week, each with the last week and the week before
 *   callsByWeek  calls by week; for the superadmin alone, the three teams with the most calls over
 *                the weeks shown, by slug, and `Other` for every other call
 *   traffic      the last week's real-work calls against its maintenance calls (`origin = 'platform'`)
 *   refusals     the last week's real-work refusals by owner, and its maintenance refusals
 *   followup     Status's refusals put right by week, the median seconds to the call that put one
 *                right, the refused sessions that went on, and the refusals with no session or still
 *                inside their 120 seconds
 *   tools        each registered tool called in the last week, most calls first, ten: its median
 *                call in its first comparable week (the first complete week of the record with 30
 *                calls that have a duration; failing that, the first with any) and in the last week
 *   rhythm       calls by local weekday, Monday first, and hour over the complete weeks shown, in
 *                the reporting timezone
 *   mostUsed     the last week's calls by tool, ten, every tool no door registers under
 *                `Unregistered tools`
 *   perApproval  calls over the approvals zz-core recorded in the same week, for the last week and
 *                the week before
 *   modelCalls   the platform's own model calls (`zz.model_call`) in the last week and the week
 *                before, the last week's by purpose; nothing records their cost
 *
 * A tool is named only when `zz.plugin_tool` records a door serving it, so no name a caller sent
 * reaches anybody. A part whose statement fails is `unavailable` with `query_failed`, and one that
 * needs a last week and a week before it the record does not yet hold, with `no_data`; a failure to
 * read the cutoff and the weeks themselves is the whole response's. No field ranks, scores or calls
 * a direction better.
 *
 * Public by route: mounted through `platformPublic`, it reads no team and no scope from the request,
 * and the superadmin flag decides the split by team and nothing else.
 *
 * COUPLED: the console's `Usage` in src/lib/fleet-shapes.ts, and its fake answer in
 * ../zz-stack-dashboard/scripts/fake-gateway/platform-usage.ts, which `checks/console-platform-usage.ts` compares this
 * route's answer with, key set by key set.
 */
import type { Express } from "express";
import type pg from "pg";

import { platformDb } from "../db.js";
import type { Figure, Part, PeriodFigure, ReadMeta, Window } from "./figures.js";
import {
  byWeek, callWeeks, followupOf, latencyMeasures, LOOKAHEAD_MS, periodWeeks, readGrid, sessionsMeasure, share, tally, windowOf, type Grid,
} from "./platform-measures.js";
import { platformPublic, ZZ_TZ } from "./shared.js";
import {
  approvalWeeks, followupWeeks, modelWeeks, rhythmCells, teamWeeks, toolWeeks, weekTraffic, type ToolWeek,
} from "./usage-figures.js";

/** What the figures count, as `meta.population` says it. */
const POPULATION = "real-work tool calls; the platform's own traffic and all refusals by population also count maintenance " +
  "calls; calls per approval divide by the approvals zz-core recorded; model calls are the platform's own";
/** How many weeks are shown, the running one included. */
const SHOWN = 26;
/** How many tools a list names. */
const TOP = 10;
/** How many teams the superadmin's split names before `Other`. */
const NAMED = 3;
export const UNREGISTERED = "Unregistered tools";

type Tile = { weeks: PeriodFigure[]; last: PeriodFigure; previous: PeriodFigure };
type ModelWeek = { window: Window; calls: number; failed: number; inputTokens: number; outputTokens: number };
type ToolSide = { window: Window; medianMs: Figure; calls: number };
type Usage = {
  meta: ReadMeta;
  tiles: Part<{ calls: Tile; refusedShare: Tile; p95Ms: Tile; sessions: Tile }>;
  callsByWeek: Part<{ weeks: { window: Window; calls: Figure; parts: { label: string; calls: number }[] | null }[] }>;
  traffic: Part<{ window: Window; work: number; maintenance: number }>;
  refusals: Part<{ window: Window; guardrail: number; ours: number; theirs: number; other: number; maintenance: number }>;
  followup: Part<{ weeks: { window: Window; putRight: PeriodFigure; medianSeconds: Figure; sessionsContinued: PeriodFigure; unassessable: number }[] }>;
  tools: Part<{ rows: { tool: string; first: ToolSide; last: ToolSide }[]; total: number }>;
  rhythm: Part<{ timezone: string; window: Window; values: number[][] }>;
  mostUsed: Part<{ rows: { tool: string; calls: number }[]; total: number }>;
  perApproval: Part<{ last: PeriodFigure; previous: PeriodFigure }>;
  modelCalls: Part<{ last: ModelWeek; previous: ModelWeek; byPurpose: { purpose: string; calls: number }[]; cost: "not_recorded" }>;
};

type GridWeek = Grid["weeks"][number];
/** The last week and the week before it. */
type Ended = { last: GridWeek; previous: GridWeek };

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const NO_WEEK = { state: "unavailable", reason: "no_data" } as const;

/** A part as read, or `unavailable` when its statement failed; the failure is logged under `what`. */
async function part<T>(what: string, read: () => Promise<T>): Promise<Part<T>> {
  try {
    return { state: "ok", data: await read() };
  } catch (err) {
    console.error(`console the platform's usage: ${what} could not be read:`, err);
    return { state: "unavailable", reason: "query_failed" };
  }
}

/** Most first, the name breaking a tie. */
const byMost = <R extends { calls: number }>(name: (r: R) => string) => (a: R, b: R): number =>
  b.calls - a.calls || (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0);

/** The three teams with the most calls over the weeks shown, by slug, and `Other` for every other call, a call in
 *  no team included, week by week. */
function partsOf(rows: { from_ms: number; slug: string | null; calls: number }[], grid: Grid): { label: string; calls: number }[][] {
  const totals = new Map<string, number>();
  for (const r of rows) if (r.slug !== null) totals.set(r.slug, (totals.get(r.slug) ?? 0) + r.calls);
  const named = [...totals].map(([slug, calls]) => ({ slug, calls })).sort(byMost((t) => t.slug)).slice(0, NAMED).map((t) => t.slug);
  return grid.weeks.map((w) => {
    const mine = rows.filter((r) => r.from_ms === w.fromMs);
    const of = (slug: string): number => mine.filter((r) => r.slug === slug).reduce((n, r) => n + r.calls, 0);
    const all = mine.reduce((n, r) => n + r.calls, 0);
    const parts = named.map((slug) => ({ label: slug, calls: of(slug) }));
    return [...parts, { label: "Other", calls: all - parts.reduce((n, p) => n + p.calls, 0) }];
  });
}

/** Each registered tool called in the last week, most calls first: its median call in its first comparable week and
 *  in the last week, each with the calls that median is over. */
function toolsOf(rows: ToolWeek[], record: Grid, last: GridWeek): { rows: { tool: string; first: ToolSide; last: ToolSide }[]; total: number } {
  const lastAt = record.weeks.findIndex((w) => w.fromMs === last.fromMs);
  const called = rows.filter((r): r is ToolWeek & { tool: string } => r.tool !== null && r.from_ms === last.fromMs && r.calls > 0)
    .sort(byMost((r) => r.tool));
  const side = (p: PeriodFigure): ToolSide => ({ window: p.window, medianMs: p.figure, calls: p.denominator ?? 0 });
  return {
    rows: called.slice(0, TOP).map(({ tool }) => {
      const at = byWeek(rows.filter((r) => r.tool === tool));
      const weeks = periodWeeks(record, true, (w) => {
        const timed = at(w, "timed");
        return { numerator: null, denominator: timed, value: timed === 0 ? null : at(w, "median_ms"), samples: timed };
      });
      const first = weeks.find((w) => w.window.complete && w.figure.why === null)
        ?? weeks.find((w) => w.window.complete && (w.denominator ?? 0) > 0) ?? weeks[lastAt];
      return { tool, first: side(first), last: side(weeks[lastAt]) };
    }),
    total: called.length,
  };
}

/** The last week's calls by tool, every tool no door registers counted as one. */
function mostUsedOf(rows: ToolWeek[], last: GridWeek): { rows: { tool: string; calls: number }[]; total: number } {
  const week = rows.filter((r) => r.from_ms === last.fromMs && r.calls > 0);
  const unregistered = week.filter((r) => r.tool === null).reduce((n, r) => n + r.calls, 0);
  const named = week.filter((r): r is ToolWeek & { tool: string } => r.tool !== null).map((r) => ({ tool: r.tool, calls: r.calls }));
  const all = unregistered > 0 ? [...named, { tool: UNREGISTERED, calls: unregistered }] : named;
  return { rows: all.sort(byMost((r) => r.tool)).slice(0, TOP), total: named.length };
}

/** Real-work calls by local weekday and hour over the complete weeks shown. */
async function rhythmOf(db: pg.Pool, grid: Grid): Promise<Part<{ timezone: string; window: Window; values: number[][] }>> {
  const complete = grid.weeks.filter((w) => windowOf(grid, w).complete);
  if (complete.length === 0) return NO_WEEK;
  const fromMs = complete[0].fromMs, toMs = complete.at(-1)!.toMs;
  return part("the calls by weekday and hour", async () => {
    const values = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
    for (const c of await rhythmCells(db, fromMs, toMs)) values[c.day][c.hour] = c.calls;
    return { timezone: ZZ_TZ, window: { from: iso(fromMs), to: iso(toMs), observedFrom: iso(fromMs), observedThrough: iso(toMs), complete: true }, values };
  });
}

/** The platform's model calls in the last week and the week before, and the last week's by purpose. */
async function modelCallsOf(db: pg.Pool, grid: Grid, ended: Ended) {
  const rows = await modelWeeks(db, ended.previous.fromMs, ended.last.fromMs, ended.last.toMs);
  const week = (last: boolean, w: GridWeek): ModelWeek => {
    const mine = rows.filter((r) => r.last === last);
    const sum = (k: "calls" | "failed" | "input_tokens" | "output_tokens"): number => mine.reduce((n, r) => n + r[k], 0);
    return { window: windowOf(grid, w), calls: sum("calls"), failed: sum("failed"), inputTokens: sum("input_tokens"), outputTokens: sum("output_tokens") };
  };
  return {
    last: week(true, ended.last), previous: week(false, ended.previous),
    byPurpose: rows.filter((r) => r.last).map((r) => ({ purpose: r.purpose, calls: r.calls })).sort(byMost((r) => r.purpose)),
    cost: "not_recorded" as const,
  };
}

export function mountPlatformUsage(app: Express): void {
  app.get("/api/console/platform/usage", platformPublic("the platform's usage", async (_req, res, { superadmin }) => {
    const db = platformDb();
    const record = await readGrid(db);
    const grid: Grid = { ...record, weeks: record.weeks.slice(-SHOWN) };
    const asOf = iso(grid.asOfMs);
    const ended: Ended | null = grid.weeks.length >= 3 ? { last: grid.weeks.at(-2)!, previous: grid.weeks.at(-3)! } : null;
    // Read once for the parts that share them; each part that awaits one fails on its own.
    const calls = callWeeks(db, grid, null);
    const tools = toolWeeks(db, record);
    for (const p of [calls, tools]) p.catch(() => undefined);
    const tile = (weeks: PeriodFigure[]): Tile => ({ weeks, last: weeks.at(-2)!, previous: weeks.at(-3)! });

    const [tiles, callsByWeek, traffic, followup, tooled, rhythm, perApproval, modelCalls] = await Promise.all([
      ended === null ? NO_WEEK : part("the tiles", async () => {
        const at = await calls;
        const [[, p95], sessions] = await Promise.all([latencyMeasures(db, grid), sessionsMeasure(db, grid)]);
        return {
          calls: tile(periodWeeks(grid, false, (w) => tally(at(w, "calls")))),
          refusedShare: tile(periodWeeks(grid, true, (w) => share(at(w, "refusals"), at(w, "calls"), 100))),
          p95Ms: tile(p95.weeks), sessions: tile(sessions.weeks),
        };
      }),
      part("the calls by week", async () => {
        const at = await calls;
        const parts = superadmin ? partsOf(await teamWeeks(db, grid), grid) : null;
        return {
          weeks: periodWeeks(grid, false, (w) => tally(at(w, "calls")))
            .map((p, i) => ({ window: p.window, calls: p.figure, parts: parts === null ? null : parts[i] })),
        };
      }),
      ended === null ? null : part("the last week's traffic", () => weekTraffic(db, ended.last.fromMs, ended.last.toMs)),
      part("the refusals put right", async () => {
        const rows = await followupWeeks(db, grid, null);
        const at = byWeek(rows);
        const putRight = followupOf(grid, rows, null).weeks;
        const median = periodWeeks(grid, true, (w) => {
          const matched = at(w, "matched");
          return { numerator: null, denominator: matched, value: matched === 0 ? null : at(w, "median_ms") / 1000, samples: matched };
        }, LOOKAHEAD_MS);
        const continued = periodWeeks(grid, true, (w) => share(at(w, "continued_sessions"), at(w, "refused_sessions"), 100), LOOKAHEAD_MS);
        return {
          weeks: grid.weeks.map((w, i) => ({
            window: putRight[i].window, putRight: putRight[i], medianSeconds: median[i].figure, sessionsContinued: continued[i],
            unassessable: at(w.fromMs, "missing_session") + at(w.fromMs, "within_lookahead"),
          })),
        };
      }),
      ended === null ? null : Promise.all([
        part("the tools' median calls", async () => toolsOf(await tools, record, ended.last)),
        part("the tools called most", async () => mostUsedOf(await tools, ended.last)),
      ]),
      rhythmOf(db, grid),
      ended === null ? NO_WEEK : part("the calls per approval", async () => {
        const [at, approvals] = await Promise.all([calls, approvalWeeks(db, grid).then(byWeek)]);
        const weeks = periodWeeks(grid, false, (w) => share(at(w, "calls"), approvals(w, "approvals"), 1));
        return { last: weeks.at(-2)!, previous: weeks.at(-3)! };
      }),
      ended === null ? NO_WEEK : part("the model calls", () => modelCallsOf(db, grid, ended)),
    ]);

    const lastWindow = ended === null ? null : windowOf(grid, ended.last);
    const answer: Usage = {
      meta: {
        asOf, timezone: ZZ_TZ,
        period: { from: grid.weeks[0] ? iso(grid.weeks[0].fromMs) : asOf, to: asOf },
        scope: "platform-public", population: POPULATION,
        coverageFrom: grid.coverageMs === null ? null : iso(grid.coverageMs),
      },
      tiles, callsByWeek,
      traffic: traffic === null || lastWindow === null ? NO_WEEK : traffic.state === "ok"
        ? { state: "ok", data: { window: lastWindow, work: traffic.data.work, maintenance: traffic.data.maintenance } } : traffic,
      refusals: traffic === null || lastWindow === null ? NO_WEEK : traffic.state === "ok"
        ? { state: "ok", data: { window: lastWindow, guardrail: traffic.data.guardrail, ours: traffic.data.ours, theirs: traffic.data.theirs,
                                 other: traffic.data.other, maintenance: traffic.data.maintenance_refused } } : traffic,
      followup,
      tools: tooled?.[0] ?? NO_WEEK, mostUsed: tooled?.[1] ?? NO_WEEK,
      rhythm, perApproval, modelCalls,
    };
    res.json(answer);
  }));
}
