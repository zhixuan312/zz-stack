/**
 * /api/console/platform/releases and /platform/releases/:version — the platform's releases, each with
 * what was observed in the 72 hours either side of it, answered alike to everybody the console lets in.
 *
 * A release is a row of `zz.release`, which the release writes once its tag exists; its time is the
 * tag's. Each side of it is a window, `[released_at - 72h, released_at)` and `[released_at,
 * released_at + 72h)`, counted over real-work tool calls (`kind = 'tool_call'`, `origin = 'work'`):
 * the calls, the malformed ones (`refusal_owner = 'ours'`) and their rate per 1,000, the tool
 * failures (`refusal_owner = 'theirs'`), and the p95 of the recorded durations. A window is counted
 * only between the first real-work call and the read's cutoff, says so in its observed bounds, and is
 * `complete` only when both bounds are its own. The figures are observations around a release's
 * time: the other releases inside a window are named on it, and nothing here compares the two sides.
 *
 * The weekly malformed-call rate is the status read's own, `malformedMeasure` over `readGrid`'s weeks
 * (console/platform-measures.ts), so the two reads give the same figures; each week also counts the
 * releases tagged in it. The Platform prepared query (platform-query-measures.ts) counts the
 * releases and the migrations, and answers these rows, through `releaseTimes`, `migrationTimes` and
 * `releaseRows`.
 *
 * Public by route: mounted through `platformPublic`, it takes no team and no scope. No figure names a
 * team.
 *
 * The list's body is `releasesOf`, which the agent read `release_list` (console/agent-reads.ts) calls too:
 * its rows carry each release's changelog and upgrade notes, which the route drops and only
 * `/:version` answers. Given a version, the rows are the releases recorded after it, in the order
 * releases are recorded in (`released_at`, then `version`), newest first, the named one left out; the
 * route names none.
 *
 * COUPLED: the console's `Releases` and `ReleaseDetail` in src/lib/platform-shapes.ts, and its fake
 * answer in ../zz-stack-dashboard/scripts/fake-gateway/platform-releases.ts, which `checks/console-platform-releases.ts`
 * compares this route's answers with, key set by key set.
 */
import type { Express } from "express";
import type pg from "pg";

import { platformDb } from "../db.js";
import type { Figure, Part, PeriodFigure, ReadMeta, Window } from "./figures.js";
import { malformedMeasure, readGrid } from "./platform-measures.js";
import { platformPublic, ZZ_TZ } from "./shared.js";

/** How far either side of a release its windows reach. */
const WINDOW_MS = 72 * 3_600_000;

/** A rate or a latency stands only on this many calls; fewer are drawn as `insufficient`, the value kept. */
const MIN_SAMPLES = 30;

/** COUPLED: `NO_CHANGELOG` in scripts/release-record.ts, which the gateway cannot import. */
const NO_CHANGELOG = "No changelog entry";

/** What the read counts, as `meta.population` says it. */
const POPULATION = "recorded releases, and real-work tool calls around them";

const BAD_PAGE = "limit must be a whole number from 1 to 100, and offset one from 0";

type ReleaseWindow = {
  window: Window; calls: Figure; malformed: Figure;
  malformedPer1000: Figure; toolFailures: Figure; p95Ms: Figure;
  overlappingVersions: string[];
};
type ReleaseRow = {
  version: string; consoleVersion: string | null; releasedAt: string;
  summary: string; clientAction: string | null;
  before: ReleaseWindow; after: ReleaseWindow;
};
export type ReleaseDetail = ReleaseRow & { changelog: string; upgradeNotes: string | null };
export type Releases<Row = ReleaseRow> = {
  meta: ReadMeta;
  tiles: {
    releases: number; lastWeek: number;
    latest: { version: string; releasedAt: string } | null;
    migrations: { applied: number; lastAt: string | null };
  };
  weeks: { window: Window; releases: number; malformedPer1000: PeriodFigure }[];
  rows: Part<{ rows: Row[]; total: number }>;
};

/** One side of a release as counted: null when its query failed. */
type Counts = { calls: number; malformed: number; toolFailures: number; timed: number; p95Ms: number | null };

/** A `zz.release` row, `released_ms` its tag's time. */
type Stored = {
  version: string; console_version: string | null; released_ms: number; summary: string;
  client_action: string | null; changelog: string; upgrade_notes: string | null;
};

/** An instant as the gateway spells one: ISO 8601 in UTC, whole seconds, with the Z. */
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

const UNAVAILABLE: Figure = { value: null, why: "unavailable" };
const NO_DATA: Figure = { value: null, why: "no_data" };

/** Every release's version and time, newest first, `version` breaking a tie: what the tiles, the weeks
 *  and every window's overlapping releases are read from. */
export async function releaseTimes(db: pg.Pool): Promise<{ version: string; ms: number }[]> {
  return (await db.query<{ version: string; ms: number }>(
    `select r.version, (extract(epoch from r.released_at) * 1000)::float8 as ms
       from zz.release r
      order by r.released_at desc, r.version desc`)).rows;
}

/** Both sides of one release, counted between the bounds each was observed in; an unobserved side is
 *  given an empty interval and its counts are not read. */
async function countSides(db: pg.Pool, before: [number, number], after: [number, number]): Promise<{ before: Counts; after: Counts }> {
  const rows = (await db.query<{ side: "before" | "after"; calls: number; malformed: number; tool_failures: number; timed: number; p95_ms: number | null }>(
    `select s.side,
            count(e.ts)::int as calls,
            (count(e.ts) filter (where e.refusal_owner = 'ours'))::int as malformed,
            (count(e.ts) filter (where e.refusal_owner = 'theirs'))::int as tool_failures,
            (count(e.duration_ms) filter (where e.batched = false))::int as timed,
            round(percentile_cont(0.95) within group (order by e.duration_ms) filter (where e.batched = false))::float8 as p95_ms
       from (values ('before', $1::timestamptz, $2::timestamptz), ('after', $3::timestamptz, $4::timestamptz)) as s(side, lo, hi)
       left join zz.event e
         on e.kind = 'tool_call' and e.origin = 'work' and e.ts >= s.lo and e.ts < s.hi
      group by s.side`,
    [before[0], before[1], after[0], after[1]].map((ms) => new Date(ms).toISOString()))).rows;
  const of = (side: "before" | "after"): Counts => {
    const r = rows.find((x) => x.side === side)!;
    return { calls: r.calls, malformed: r.malformed, toolFailures: r.tool_failures, timed: r.timed, p95Ms: r.p95_ms };
  };
  return { before: of("before"), after: of("after") };
}

/** One side of a release, `[from, to)`. Observed no earlier than the record's start and no later than
 *  the cutoff; never observed, or not counted because its query failed, every figure is unavailable,
 *  never zero. No calls is no rate and no latency. */
function side(from: number, to: number, observed: [number, number] | null, counts: Counts | null, overlappingVersions: string[]): ReleaseWindow {
  if (observed === null || counts === null) {
    return {
      window: { from: iso(from), to: iso(to), observedFrom: null, observedThrough: null, complete: false },
      calls: UNAVAILABLE, malformed: UNAVAILABLE, malformedPer1000: UNAVAILABLE, toolFailures: UNAVAILABLE, p95Ms: UNAVAILABLE,
      overlappingVersions,
    };
  }
  const short = (n: number): Figure["why"] => (n < MIN_SAMPLES ? "insufficient" : null);
  return {
    window: { from: iso(from), to: iso(to), observedFrom: iso(observed[0]), observedThrough: iso(observed[1]),
      complete: observed[0] === from && observed[1] === to },
    calls: { value: counts.calls, why: null },
    malformed: { value: counts.malformed, why: null },
    malformedPer1000: counts.calls === 0 ? NO_DATA : { value: (1000 * counts.malformed) / counts.calls, why: short(counts.calls) },
    toolFailures: { value: counts.toolFailures, why: null },
    p95Ms: counts.timed === 0 || counts.p95Ms === null ? NO_DATA : { value: counts.p95Ms, why: short(counts.timed) },
    overlappingVersions,
  };
}

/** A release with both its windows. A failed count makes this release's windows unavailable and no
 *  other's; the releases named on a window come from the release record alone and stand either way. */
async function withWindows(db: pg.Pool, r: Stored, all: { version: string; ms: number }[], coverageMs: number | null, asOfMs: number): Promise<ReleaseDetail> {
  const at = r.released_ms;
  const bounds = { before: [at - WINDOW_MS, at] as [number, number], after: [at, at + WINDOW_MS] as [number, number] };
  const observe = ([from, to]: [number, number]): [number, number] | null => {
    if (coverageMs === null) return null;
    const lo = Math.max(from, coverageMs), hi = Math.min(to, asOfMs);
    return lo < hi ? [lo, hi] : null;
  };
  const seen = { before: observe(bounds.before), after: observe(bounds.after) };
  let counts: { before: Counts; after: Counts } | null = null;
  try {
    counts = await countSides(db, seen.before ?? [at, at], seen.after ?? [at, at]);
  } catch (err) {
    console.error(`console the platform's releases: the windows of ${r.version} could not be counted:`, err);
  }
  const others = ([from, to]: [number, number]): string[] =>
    all.filter((o) => o.version !== r.version && o.ms >= from && o.ms < to).map((o) => o.version);
  return {
    version: r.version, consoleVersion: r.console_version, releasedAt: iso(at),
    summary: r.summary.trim() === "" ? NO_CHANGELOG : r.summary, clientAction: r.client_action,
    before: side(...bounds.before, seen.before, counts?.before ?? null, others(bounds.before)),
    after: side(...bounds.after, seen.after, counts?.after ?? null, others(bounds.after)),
    changelog: r.changelog.trim() === "" ? NO_CHANGELOG : r.changelog, upgradeNotes: r.upgrade_notes,
  };
}

/** The instant each migration was applied: what the tiles count as migrations applied. */
export async function migrationTimes(db: pg.Pool): Promise<number[]> {
  return (await db.query<{ ms: number }>(
    "select (extract(epoch from m.applied_at) * 1000)::float8 as ms from zz.schema_migration m")).rows.map((r) => r.ms);
}

/** The rows of the versions named, in the order named, each with both its windows as this read draws them, at the
 *  cutoff `asOfMs`. */
export async function releaseRows(db: pg.Pool, versions: string[], asOfMs: number): Promise<ReleaseRow[]> {
  if (!versions.length) return [];
  const [stored, all, grid] = await Promise.all([
    db.query<Stored>(
      `select r.version, r.console_version, (extract(epoch from r.released_at) * 1000)::float8 as released_ms,
              r.summary, r.client_action, r.changelog, r.upgrade_notes
         from zz.release r
        where r.version = any($1::text[])`, [versions]),
    releaseTimes(db),
    readGrid(db, asOfMs),
  ]);
  const of = new Map(stored.rows.map((r) => [r.version, r]));
  const detailed = await Promise.all(versions.filter((v) => of.has(v)).map((v) => withWindows(db, of.get(v)!, all, grid.coverageMs, grid.asOfMs)));
  return detailed.map(({ changelog: _c, upgradeNotes: _u, ...row }) => row);
}

/** The releases read, one page of its rows each with its changelog and upgrade notes: the latest, or with
 *  `since` the releases recorded after that version; null when `since` names no recorded release. */
export async function releasesOf(page: { limit: number; offset: number; since: string | null }): Promise<Releases<ReleaseDetail> | null> {
  const db = platformDb();
  const all = await releaseTimes(db);
  // The releases after `since` are the ones before it in recorded order, newest first.
  const after = page.since === null ? all.length : all.findIndex((r) => r.version === page.since);
  if (after < 0) return null;
  const grid = await readGrid(db);
  const { asOfMs, coverageMs } = grid;
  const applied = await migrationTimes(db);

  const malformed = await malformedMeasure(db, grid);
  const weeks = malformed.weeks.map((w, i) => ({
    window: w.window,
    releases: all.filter((r) => r.ms >= grid.weeks[i].fromMs && r.ms < grid.weeks[i].toMs).length,
    malformedPer1000: w,
  }));

  let rows: Releases<ReleaseDetail>["rows"];
  try {
    const stored = page.since === null
      ? (await db.query<Stored>(
        `select r.version, r.console_version, (extract(epoch from r.released_at) * 1000)::float8 as released_ms,
                r.summary, r.client_action, r.changelog, r.upgrade_notes
           from zz.release r
          order by r.released_at desc, r.version desc
          limit $1 offset $2`, [page.limit, page.offset])).rows
      : (await db.query<Stored>(
        `select r.version, r.console_version, (extract(epoch from r.released_at) * 1000)::float8 as released_ms,
                r.summary, r.client_action, r.changelog, r.upgrade_notes
           from zz.release r, zz.release s
          where s.version = $3 and (r.released_at, r.version) > (s.released_at, s.version)
          order by r.released_at desc, r.version desc
          limit $1 offset $2`, [page.limit, page.offset, page.since])).rows;
    const detailed = await Promise.all(stored.map((r) => withWindows(db, r, all, coverageMs, asOfMs)));
    rows = { state: "ok", data: { rows: detailed, total: after } };
  } catch (err) {
    console.error("console the platform's releases: the rows could not be read:", err);
    rows = { state: "unavailable", reason: "query_failed" };
  }

  return {
    meta: {
      asOf: iso(asOfMs), timezone: ZZ_TZ,
      period: { from: weeks[0]?.window.from ?? iso(asOfMs), to: iso(asOfMs) },
      scope: "platform-public", population: POPULATION,
      coverageFrom: coverageMs === null ? null : iso(coverageMs),
    },
    tiles: {
      releases: all.length,
      lastWeek: all.filter((r) => r.ms >= asOfMs - 7 * 24 * 3_600_000 && r.ms < asOfMs).length,
      latest: all[0] ? { version: all[0].version, releasedAt: iso(all[0].ms) } : null,
      migrations: { applied: applied.length, lastAt: applied.length ? iso(Math.max(...applied)) : null },
    },
    weeks,
    rows,
  };
}

export function mountPlatformReleases(app: Express): void {
  app.get("/api/console/platform/releases", platformPublic("the platform's releases", async (req, res) => {
    const limit = Number(req.query.limit ?? 10), offset = Number(req.query.offset ?? 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) {
      res.status(400).json({ error: BAD_PAGE });
      return;
    }
    const { rows, ...answer } = (await releasesOf({ limit, offset, since: null }))!;
    const list: Releases = {
      ...answer,
      rows: rows.state === "ok"
        ? { state: "ok", data: { rows: rows.data.rows.map(({ changelog: _c, upgradeNotes: _u, ...row }) => row), total: rows.data.total } }
        : rows,
    };
    res.json(list);
  }));

  app.get("/api/console/platform/releases/:version", platformPublic("the platform's release", async (req, res) => {
    const db = platformDb();
    const found = (await db.query<Stored>(
      `select r.version, r.console_version, (extract(epoch from r.released_at) * 1000)::float8 as released_ms,
              r.summary, r.client_action, r.changelog, r.upgrade_notes
         from zz.release r
        where r.version = $1`, [req.params.version])).rows[0];
    if (!found) {
      res.status(404).end();
      return;
    }
    const { asOfMs, coverageMs } = await readGrid(db);
    const detail: ReleaseDetail = await withWindows(db, found, await releaseTimes(db), coverageMs, asOfMs);
    res.json(detail);
  }));
}
