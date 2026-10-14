/**
 * The bug reports the platform's Bugs read is answered from, seeded into a throwaway database on top
 * of the status seed, and the values a reader must find beside them: `checks/console-platform-bugs.ts`
 * drives the gateway's own routes over them.
 *
 * Weeks are the status seed's: Monday to Monday in the reporting timezone, `back` 0 the running week,
 * 1 the last whole week (L), and so on to 5 (L-4), where the first real-work call falls on the week's
 * first instant. Their real-work calls are the status seed's, by `back`: 100, 0, 12, 200, 125 and 5.
 *
 * What it writes on top of `seedStatus`:
 *
 *   - the vocabulary: two plugin versions whose doors register `document_approve`, `knowledge_search`
 *     and `bug_report` on core and `whoami` on manage. `team_switch` is a tool name the console's fake
 *     knows and this table does not, so a report naming it is not canonical here;
 *   - two initiatives of team one, a release check's own (its slug carries `chain-check-`) and a real
 *     one;
 *   - ten real reports, R1 to R10, and two of the release check's own: P1 filed in its initiative, and
 *     P2 titled `chain-check probe ` with no initiative. R6 is filed in the real initiative and its
 *     title opens `chain-check probes`, which is not the probe's title. Every title, detail and
 *     resolution carries a sentinel no member's answer may hold.
 *
 * A helper, not a check: every `.ts` under `checks/` is a check the gate runs.
 */
import type pg from "pg";

import { MEMBER, TEAM_TWO, seedStatus, type Seeded } from "./status-seed.ts";

/** The real report's keys, and the release check's own two. */
type Real = "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7" | "R8" | "R9" | "R10";
type Key = Real | "P1" | "P2";

const HOUR = 3_600_000;

/** One report: `back` weeks before the running one and `hours` after that week's first instant, in
 *  team one, team two or no team, resolved `resolvedAfter` hours after it was filed. */
interface Report {
  id: string; back: number; hours: number; team: "one" | "two" | null;
  initiative: "probe" | "real" | null;
  title: string; detail: string; surface: string | null; impact: string; status: string;
  resolvedAfter: number | null; resolution: string | null; duplicateOf: Key | null; platformVersion: string;
}

/** COUPLED: R9's id sorts before R8's, and the two are filed at the same instant, so the queue's
 *  tie-breaker is what puts R9 first. */
export const REPORTS: Readonly<Record<Key, Report>> = {
  R1: { id: "b0000000-0000-4000-8000-000000000001", back: 5, hours: 10, team: "one", initiative: null,
    title: "SENTINEL-TITLE-R1 approve refuses kestrel's stakeholder", detail: "SENTINEL-DETAIL-R1",
    surface: "core:Document_Approve", impact: "blocks_work", status: "fixed", resolvedAfter: 10,
    resolution: "SENTINEL-RESOLUTION-R1", duplicateOf: null, platformVersion: "0.90.0" },
  R2: { id: "b0000000-0000-4000-8000-000000000002", back: 5, hours: 20, team: "one", initiative: null,
    title: "SENTINEL-TITLE-R2", detail: "SENTINEL-DETAIL-R2", surface: "knowledge_search", impact: "wrong_result",
    status: "duplicate", resolvedAfter: 30, resolution: "SENTINEL-RESOLUTION-R2", duplicateOf: "R1", platformVersion: "0.90.0" },
  R3: { id: "b0000000-0000-4000-8000-000000000003", back: 3, hours: 5, team: "two", initiative: null,
    title: "SENTINEL-TITLE-R3", detail: "SENTINEL-DETAIL-R3", surface: "the search page in heron-works SENTINEL-SURFACE",
    impact: "confusing", status: "open", resolvedAfter: null, resolution: null, duplicateOf: null, platformVersion: "0.91.0" },
  R4: { id: "b0000000-0000-4000-8000-000000000004", back: 3, hours: 6, team: null, initiative: null,
    title: "SENTINEL-TITLE-R4", detail: "SENTINEL-DETAIL-R4", surface: null, impact: "cosmetic", status: "not_a_bug",
    resolvedAfter: 4, resolution: "SENTINEL-RESOLUTION-R4", duplicateOf: null, platformVersion: "0.91.0" },
  R5: { id: "b0000000-0000-4000-8000-000000000005", back: 2, hours: 1, team: null, initiative: null,
    title: "SENTINEL-TITLE-R5", detail: "SENTINEL-DETAIL-R5", surface: "console", impact: "cosmetic", status: "duplicate",
    resolvedAfter: 2, resolution: "SENTINEL-RESOLUTION-R5", duplicateOf: "R4", platformVersion: "0.92.0" },
  R6: { id: "b0000000-0000-4000-8000-000000000006", back: 2, hours: 30, team: "one", initiative: "real",
    title: "chain-check probes ran slowly SENTINEL-TITLE-R6", detail: "SENTINEL-DETAIL-R6", surface: "team_switch",
    impact: "wrong_result", status: "open", resolvedAfter: null, resolution: null, duplicateOf: null, platformVersion: "0.92.0" },
  R7: { id: "b0000000-0000-4000-8000-000000000007", back: 1, hours: 48, team: "one", initiative: null,
    title: "SENTINEL-TITLE-R7", detail: "SENTINEL-DETAIL-R7", surface: "  MANAGE ", impact: "blocks_work", status: "open",
    resolvedAfter: null, resolution: null, duplicateOf: null, platformVersion: "0.93.0" },
  R8: { id: "b0000000-0000-4000-8000-000000000009", back: 1, hours: 72, team: "two", initiative: null,
    title: "SENTINEL-TITLE-R8", detail: "SENTINEL-DETAIL-R8", surface: "Bug_Report", impact: "confusing", status: "fixed",
    resolvedAfter: 20, resolution: "SENTINEL-RESOLUTION-R8", duplicateOf: null, platformVersion: "0.93.0" },
  R9: { id: "b0000000-0000-4000-8000-000000000008", back: 1, hours: 72, team: "two", initiative: null,
    title: "SENTINEL-TITLE-R9", detail: "SENTINEL-DETAIL-R9", surface: "bug_report", impact: "confusing", status: "open",
    resolvedAfter: null, resolution: null, duplicateOf: null, platformVersion: "0.93.0" },
  R10: { id: "b0000000-0000-4000-8000-000000000010", back: 0, hours: 0, team: "one", initiative: null,
    title: "SENTINEL-TITLE-R10", detail: "SENTINEL-DETAIL-R10", surface: "core", impact: "wrong_result", status: "open",
    resolvedAfter: null, resolution: null, duplicateOf: null, platformVersion: "0.94.0" },
  P1: { id: "b0000000-0000-4000-8000-0000000000a1", back: 1, hours: 60, team: "one", initiative: "probe",
    title: "SENTINEL-TITLE-P1", detail: "SENTINEL-DETAIL-P1", surface: "bug_report", impact: "blocks_work", status: "open",
    resolvedAfter: null, resolution: null, duplicateOf: null, platformVersion: "0.93.0" },
  P2: { id: "b0000000-0000-4000-8000-0000000000a2", back: 2, hours: 12, team: null, initiative: null,
    title: "chain-check probe 2026-09-01-chain-check-0109-gone", detail: "SENTINEL-DETAIL-P2", surface: "bug_report",
    impact: "cosmetic", status: "not_a_bug", resolvedAfter: 1, resolution: "SENTINEL-RESOLUTION-P2", duplicateOf: null,
    platformVersion: "0.92.0" },
};

/** The two initiatives' slugs, which no member's answer may hold. */
export const INITIATIVES = { probe: "2026-09-02-chain-check-0209-a1b2c3", real: "2026-09-20-console-rework" } as const;

/** A cohort as the read must answer it, by `back`: counts, then the rate's value and reason, then
 *  the median's. */
interface ExpectedCohort {
  back: number; filed: number; resolved: number; stillOpen: number;
  per1000: number | null; per1000Why: "no_data" | "insufficient" | null;
  median: number | null; medianWhy: "no_data" | null;
}

/** What a reader must find, written out by hand from the reports above and the status seed's calls,
 *  not computed from them. Cohorts oldest first, L-4 through the running week. */
export const EXPECTED = {
  real: ["R10", "R9", "R8", "R7", "R6", "R5", "R4", "R3", "R2", "R1"] as Real[],
  open: 5, resolved: 5,
  byImpact: { blocks_work: 2, wrong_result: 3, confusing: 3, cosmetic: 2 },
  byStatus: { open: 5, fixed: 2, not_a_bug: 1, duplicate: 2 },
  oldestOpen: "R3" as Real,
  /** Over 2, 4, 10, 20 and 30 hours. */
  medianHours: 10,
  cohorts: [
    { back: 5, filed: 2, resolved: 2, stillOpen: 0, per1000: 20, per1000Why: null, median: 20, medianWhy: null },
    { back: 4, filed: 0, resolved: 0, stillOpen: 0, per1000: null, per1000Why: "no_data", median: null, medianWhy: "no_data" },
    { back: 3, filed: 2, resolved: 1, stillOpen: 1, per1000: 2000 / 12, per1000Why: "insufficient", median: 4, medianWhy: null },
    { back: 2, filed: 2, resolved: 1, stillOpen: 1, per1000: 10, per1000Why: null, median: 2, medianWhy: null },
    { back: 1, filed: 3, resolved: 1, stillOpen: 2, per1000: 24, per1000Why: null, median: 20, medianWhy: null },
    { back: 0, filed: 1, resolved: 0, stillOpen: 1, per1000: 200, per1000Why: "insufficient", median: null, medianWhy: "no_data" },
  ] as ExpectedCohort[],
  /** Each real report's canonical surface: R6's `team_switch` is in no door's registered tools here. */
  surface: { R1: "document_approve", R2: "knowledge_search", R3: null, R4: null, R5: "console", R6: null,
             R7: "manage", R8: "bug_report", R9: "bug_report", R10: "core" } as Record<Real, string | null>,
  /** The queue narrowed, by its query string. */
  filtered: {
    "state=open": ["R10", "R9", "R7", "R6", "R3"],
    "state=resolved": ["R8", "R5", "R4", "R2", "R1"],
    "impact=confusing": ["R9", "R8", "R3"],
    "surface=bug_report": ["R9", "R8"],
    "state=open&impact=blocks_work": ["R7"],
    "limit=3&offset=2": ["R8", "R7", "R6"],
  } as Record<string, Real[]>,
  /** The targets `bug_resolve` would accept, newest first: its team's other reports, the release
   *  check's own included, and no team matching no team. */
  duplicates: {
    R1: ["R10", "P1", "R7", "R6", "R2"],
    R3: ["R9", "R8"],
    R4: ["P2", "R5"],
  } as Partial<Record<Real, Key[]>>,
} as const;

/**
 * Seeds the status seed's teams, people and calls, then the vocabulary, the initiatives and every
 * report above, cutting weeks in `timezone`. Returns the status seed's weeks.
 */
export async function seedBugs(db: pg.ClientBase | pg.Pool, timezone: string): Promise<Seeded> {
  const seeded = await seedStatus(db, timezone);
  const ids = (await db.query<{ member: string; one: string; two: string }>(
    `select p.id::text as member, p.active_team_id::text as one, (select id::text from zz.team where slug = $2) as two
       from zz.principal p where p.email = $1`, [MEMBER, TEAM_TWO])).rows[0];

  for (const [plugin, door, tools] of [["zz-core", "core", ["document_approve", "knowledge_search", "bug_report"]],
                                       ["zz-access", "manage", ["whoami"]]] as const) {
    const version = (await db.query<{ id: string }>(
      `with p as (insert into zz.plugin (name, origin) values ($1, 'platform') returning id)
       insert into zz.plugin_version (plugin_id, version, digest) select id, '1.0.0', 'sha256:seed' from p returning id`,
      [plugin])).rows[0].id;
    for (const tool of tools) {
      await db.query("insert into zz.plugin_tool (plugin_version_id, name, door) values ($1, $2, $3)", [version, tool, door]);
    }
  }
  const initiative: Record<"probe" | "real", string> = { probe: "", real: "" };
  for (const kind of ["probe", "real"] as const) {
    initiative[kind] = (await db.query<{ id: string }>(
      "insert into zz.initiative (team_id, slug) values ($1, $2) returning id", [ids.one, INITIATIVES[kind]])).rows[0].id;
  }

  // In key order, so a duplicate's target is already there.
  for (const r of Object.values(REPORTS)) {
    const filed = seeded.starts.get(r.back)! + r.hours * HOUR;
    await db.query(
      `insert into zz.bug (id, reported_at, title, detail, surface, platform_version, impact, status, resolution,
                           resolved_at, team_id, initiative_id, duplicate_of, reported_by, resolved_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [r.id, new Date(filed).toISOString(), r.title, r.detail, r.surface, r.platformVersion, r.impact, r.status,
       r.resolution, r.resolvedAfter === null ? null : new Date(filed + r.resolvedAfter * HOUR).toISOString(),
       r.team === "one" ? ids.one : r.team === "two" ? ids.two : null,
       r.initiative === null ? null : initiative[r.initiative],
       r.duplicateOf === null ? null : REPORTS[r.duplicateOf].id, ids.member,
       r.resolvedAfter === null ? null : ids.member]);
  }
  return seeded;
}
