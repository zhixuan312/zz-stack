/**
 * /api/console/platform/status — the platform's own health, answered alike to everybody the console
 * lets in, and the reader's own team's share of it.
 *
 * As far as this phase has built it: the eight measures, in the spec's order, each counted week by
 * week in console/platform-measures.ts and named by `summarise`; and `own`, the reader's active team's
 * malformed calls, refusals put right and sessions, counted by the same functions narrowed to that team
 * with no sample minimum, and its real bug reports by how they stand. `needs`, `records`, `doors` and
 * `running` are answered as unavailable, never as an empty part that reads as "nothing to report".
 *
 * A measure whose statement fails is answered with every week unavailable, and the others stand; a
 * failure to read the cutoff and the weeks themselves is the whole response's.
 *
 * Public by route: it is mounted through `platformPublic`, takes no team and no scope, and reads
 * neither from the request. No measure names a team; `own` is the caller's active team as the
 * identity resolved it, and `unavailable` with `no_team` for a person in none.
 *
 * COUPLED: the console's `PlatformStatus` in src/lib/platform-shapes.ts, and its fake answer in
 * scripts/fake-gateway/platform-status.ts, which `checks/console-platform-status.ts` compares this
 * route's answer with, key set by key set.
 */
import type { Express } from "express";

import { platformDb } from "../db.js";
import type { MeasureKey, Part, PeriodFigure, ReadMeta } from "./figures.js";
import { realReports } from "./platform-bugs.js";
import {
  bugsMeasure, finishedMeasure, followupMeasure, latencyMeasures, malformedMeasure, ownBugs, readGrid, searchesMeasure,
  sessionsMeasure, unavailableMeasure, type Grid, type StatusMeasure,
} from "./platform-measures.js";
import { platformPublic, ZZ_TZ } from "./shared.js";

/** What the measures count, as `meta.population` says it. */
const POPULATION = "real-work tool calls and searches, real bug reports, and closed initiatives";

const NOT_BUILT = { state: "unavailable", reason: "not_built" } as const;

/** An instant as the gateway spells one: ISO 8601 in UTC, whole seconds, with the Z. */
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

type Own = {
  malformed: PeriodFigure[]; followup: PeriodFigure[]; sessions: PeriodFigure[];
  bugs: { filed: number; fixed: number; notABug: number; duplicate: number; open: number };
};

/** The answer as far as this phase builds it: every part the spec names, the unbuilt ones unavailable. */
type PlatformStatus = {
  meta: ReadMeta;
  needs: { state: "unavailable"; rows: []; total: null; knownCount: 0; unavailableKinds: string[]; overflowByKind: object };
  measures: StatusMeasure[];
  records: Part<never>; doors: Part<never>; running: Part<never>; own: Part<Own>;
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

export function mountPlatformStatus(app: Express): void {
  app.get("/api/console/platform/status", platformPublic("the platform's status", async (_req, res, { activeTeam }) => {
    const db = platformDb();
    const grid = await readGrid(db);
    const asOf = iso(grid.asOfMs);
    // One read of the real reports, for the rate and the reader's own counts; null when it failed.
    const reports = realReports(asOf).catch((err: unknown) => {
      console.error("console the platform's status: the real bug reports could not be read:", err);
      return null;
    });
    const latency = latencyMeasures(db, grid);
    const measures = await Promise.all([
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
    ]);

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

    const answer: PlatformStatus = {
      meta: {
        asOf, timezone: ZZ_TZ,
        period: { from: grid.weeks[0] ? iso(grid.weeks[0].fromMs) : asOf, to: asOf },
        scope: "platform-public", population: POPULATION,
        coverageFrom: grid.coverageMs === null ? null : iso(grid.coverageMs),
      },
      needs: {
        state: "unavailable", rows: [], total: null, knownCount: 0,
        unavailableKinds: ["bugs", "evaluation", "approvals", "drift", "door"], overflowByKind: {},
      },
      measures,
      records: NOT_BUILT, doors: NOT_BUILT, running: NOT_BUILT, own,
    };
    res.json(answer);
  }));
}
