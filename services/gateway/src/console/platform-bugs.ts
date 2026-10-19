/**
 * /api/console/platform/bugs — the bug queue in two projections: the safe one for everybody the
 * console lets in, and the report itself for the superadmin.
 *
 * `GET /platform/bugs` answers the counts, the oldest open report, the median hours to resolve, the
 * weekly cohorts and one page of the queue, over real reports only (`realReports`). A row anybody
 * reads holds a title built from the report's impact, canonical surface and filed day, and typed
 * metadata, nothing else: never the reporter's title or detail, the team, the reporter, the
 * initiative, the resolution or the duplicate target. The superadmin's rows add the internal title
 * and the team.
 * Only the queue is filtered; every figure is over all real reports.
 *
 * `GET /platform/bugs/:id` and `/platform/bugs/:id/duplicates` are the superadmin's: a member is
 * refused from `platformPublic`'s flag before anything is read, with no name in the refusal. A
 * report's surface is spelt as the queue spells it when it is a word of the vocabulary, and as
 * stored otherwise. An id
 * that is not a UUID naming a row of `zz.bug` is a 404 with no body. Nothing here writes `zz.bug`.
 *
 * The Platform prepared query (platform-query-measures.ts) counts the same real reports and answers
 * the queue's rows through `realReports`, `publicRow` and `adminRows`. The status read's bugs on one
 * tool, which the agent read `platform_status` asks for, are the same reports' open ones on that
 * surface, its tool argument kept only when `canonicalSurface` keeps it, as anybody reads them in the
 * queue (`publicRow`), with the record's start by `bugsCoverage`.
 *
 * COUPLED: the console's `Bugs`, `AdminBugRow` and `BugReport` in src/lib/platform-shapes.ts, and
 * its fake answer in ../zz-stack-dashboard/scripts/fake-gateway/platform-bugs.ts, whose `canonicalSurface` copies the rule
 * below; `checks/console-platform-bugs.ts` compares this route's answers with the fake's, key set by
 * key set.
 */
import type { Express, Request } from "express";

import { platformDb } from "../db.js";
import type { Figure, Part, ReadMeta } from "./figures.js";
import { platformPublic, ZZ_TZ } from "./shared.js";

type Impact = "blocks_work" | "wrong_result" | "confusing" | "cosmetic";
type Status = "open" | "fixed" | "not_a_bug" | "duplicate";
export const IMPACTS: readonly Impact[] = ["blocks_work", "wrong_result", "confusing", "cosmetic"];
export const STATUSES: readonly Status[] = ["open", "fixed", "not_a_bug", "duplicate"];
export const STATES = ["open", "resolved"] as const;

/** The words a surface is canonical in besides the doors' tool names. */
const DOORS_AND_CONSOLE = ["core", "manage", "eval", "console"];

/** A cohort's rate of reports per 1,000 calls stands only on this many calls. */
const MIN_CALLS = 30;
const HOUR = 3_600_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BAD_PAGE = "limit must be a whole number from 1 to 100, and offset one from 0";

/** An instant as the gateway spells one: ISO 8601 in UTC, whole seconds, with the Z. */
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

export type PublicBugRow = {
  id: string; title: string; impact: Impact; surface: string | null;
  filedAt: string; platformVersion: string | null; status: Status; resolvedAt: string | null;
};
type AdminBugRow = PublicBugRow & { internalTitle: string; team: string | null };
type Bugs = {
  meta: ReadMeta;
  counts: Part<{ open: number; resolved: number; byImpact: Record<Impact, number>; byStatus: Record<Status, number> }>;
  oldestOpenAt: string | null; medianResolveHours: Figure;
  cohorts: { week: string; filed: Figure; resolved: Figure; stillOpen: Figure; filedPer1000: Figure; medianResolveHours: Figure }[];
  queue: Part<{ rows: PublicBugRow[]; total: number }>;
};
type BugReport = {
  id: string; title: string; detail: string; surface: string | null; impact: string; status: string;
  platformVersion: string | null; reportedAt: string; resolvedAt: string | null;
  resolution: string | null; duplicateOf: string | null; team: string | null;
};

/** A real report as every figure counts it: typed metadata and its canonical surface, and no text a
 *  reporter wrote. `teamId` is for a read narrowed to a team; no answer to a member carries it. */
export type RealReport = {
  id: string; teamId: string | null; impact: Impact; status: Status; surface: string | null;
  platformVersion: string | null; reportedMs: number; resolvedMs: number | null;
};

/** The surfaces a report may be said to concern: every tool name the three doors register in
 *  `zz.plugin_tool`, the door names, and `console`. */
export async function vocabulary(): Promise<Set<string>> {
  const { rows } = await platformDb().query<{ name: string }>("select distinct name from zz.plugin_tool");
  return new Set([...rows.map((r) => r.name), ...DOORS_AND_CONSOLE]);
}

/** A stored surface, lower-cased with a leading door prefix dropped, when it is then exactly a word
 *  of the vocabulary; null otherwise, so free text is never echoed. The one place a public title's
 *  only input is decided. */
export function canonicalSurface(stored: string | null, words: Set<string>): string | null {
  const word = (stored ?? "").trim().toLowerCase().replace(/^(core|manage|eval):/, "");
  return words.has(word) ? word : null;
}

/** The impacts as a withheld report's title says them. */
export const IMPACT_WORDS: Record<Impact, string> = {
  blocks_work: "Blocks work", wrong_result: "Wrong result", confusing: "Confusing", cosmetic: "Cosmetic",
};

/** The day a report was filed, as its withheld title says it and the console's Filed column draws it (its
 *  `formatDate`): `16 Sept 2026`, `03 Oct 2026`. */
export const FILED_DAY = new Intl.DateTimeFormat("en-GB", { timeZone: ZZ_TZ, day: "2-digit", month: "short", year: "numeric" });

/** The title of a report its reader may not read in full, built from what they may see of it: its
 *  impact, its canonical surface and the day it was filed in the reporting timezone, so two reports
 *  of a team read apart while nothing the reporter wrote is in it. `Blocks work: document_approve,
 *  filed 16 Sept 2026`, or `Cosmetic: no surface named, filed 03 Oct 2026`.
 *  COUPLED: the fake's `publicTitle` in ../zz-stack-dashboard/scripts/fake-gateway/platform-bugs.ts. */
export function publicTitle(r: Pick<RealReport, "impact" | "surface" | "reportedMs">): string {
  return `${IMPACT_WORDS[r.impact]}: ${r.surface ?? "no surface named"}, filed ${FILED_DAY.format(new Date(r.reportedMs))}`;
}

/**
 * Every real report filed by `asOf`, newest first with the id breaking a tie. A report is real
 * unless it is a release check's own: its initiative's slug carries `chain-check-`, the rule
 * scripts/ops/purge-probes.ts deletes by, or its title opens `chain-check probe `, which a probe
 * keeps after a purge sets its initiative null.
 *
 * DELIBERATE: rows, not a SQL fragment. Every console query is one literal statement check:sql can
 * PREPARE, so a predicate interpolated into another read's SQL would fail the gate; a read that
 * counts real reports counts these rows.
 */
export async function realReports(asOf: string): Promise<RealReport[]> {
  const words = await vocabulary();
  const { rows } = await platformDb().query<{
    id: string; team_id: string | null; impact: Impact; status: Status; surface: string | null;
    platform_version: string | null; reported_ms: number; resolved_ms: number | null;
  }>(
    `select b.id::text as id, b.team_id::text as team_id, b.impact, b.status, b.surface, b.platform_version,
            (extract(epoch from b.reported_at) * 1000)::float8 as reported_ms,
            (extract(epoch from b.resolved_at) * 1000)::float8 as resolved_ms
       from zz.bug b
      where b.reported_at <= $1::timestamptz
        and b.title not like 'chain-check probe %'
        and not exists (select 1 from zz.initiative i where i.id = b.initiative_id and i.slug like '%chain-check-%')
      order by b.reported_at desc, b.id`, [asOf]);
  return rows.map((r) => ({
    id: r.id, teamId: r.team_id, impact: r.impact, status: r.status, surface: canonicalSurface(r.surface, words),
    platformVersion: r.platform_version, reportedMs: r.reported_ms, resolvedMs: r.resolved_ms,
  }));
}

const counted = (value: number): Figure => ({ value, why: null });

/** The median hours from filing to resolution of the resolved reports among `of`; a report closed
 *  with no time recorded has no duration and is left out. */
export function medianHours(of: RealReport[]): Figure {
  const hours = of.filter((r) => r.status !== "open" && r.resolvedMs !== null)
    .map((r) => (r.resolvedMs! - r.reportedMs) / HOUR).sort((a, b) => a - b);
  if (!hours.length) return { value: null, why: "no_data" };
  const mid = Math.floor(hours.length / 2);
  return { value: hours.length % 2 ? hours[mid] : (hours[mid - 1] + hours[mid]) / 2, why: null };
}

/** Where the record of bugs begins: the first real-work call, the cohorts' denominator, or the first real
 *  report if one came before it; null with neither. The status read's bugs on a tool begin where these do. */
export function bugsCoverage(firstCallMs: number | null, reports: RealReport[]): number | null {
  const firsts = [firstCallMs, reports.at(-1)?.reportedMs ?? null].filter((v): v is number => v !== null);
  return firsts.length ? Math.min(...firsts) : null;
}

/** One query parameter given at most once: its text, null when absent, false when repeated. */
const one = (v: unknown): string | null | false => (v === undefined ? null : typeof v === "string" ? v : false);

type Filter = { state: string | null; impact: string | null; surface: string | null };

/** The queue: the reports a filter keeps, newest first as `realReports` orders them. */
export function queueOf(reports: RealReport[], filter: Filter): RealReport[] {
  return reports
    .filter((r) => filter.state === null || (filter.state === "open") === (r.status === "open"))
    .filter((r) => filter.impact === null || r.impact === filter.impact)
    .filter((r) => filter.surface === null || r.surface === filter.surface);
}

/** A report as anybody reads it in the queue: a title built from its impact, canonical surface and filed day, and typed metadata. */
export function publicRow(r: RealReport): PublicBugRow {
  return {
    id: r.id, title: publicTitle(r), impact: r.impact, surface: r.surface, filedAt: iso(r.reportedMs),
    platformVersion: r.platformVersion, status: r.status, resolvedAt: r.resolvedMs === null ? null : iso(r.resolvedMs),
  };
}

/** The superadmin's rows of a page of the queue: each public row with the reporter's own title and the team, read for
 *  those rows alone. */
export async function adminRows(page: RealReport[]): Promise<AdminBugRow[]> {
  const internal = new Map((await platformDb().query<{ id: string; title: string; team: string | null }>(
    `select b.id::text as id, b.title, t.slug as team
       from zz.bug b left join zz.team t on t.id = b.team_id
      where b.id = any($1::uuid[])`, [page.map((r) => r.id)])).rows.map((r) => [r.id, r]));
  return page.map((r): AdminBugRow => ({ ...publicRow(r), internalTitle: internal.get(r.id)!.title, team: internal.get(r.id)!.team }));
}

/** The queue's filter and page, or the refusal: each filter a closed list, so nothing a caller
 *  types is matched as free text. */
function parse(req: Request, words: Set<string>): { filter: Filter; limit: number; offset: number } | string {
  const [state, impact, surface, limitText, offsetText] =
    ["state", "impact", "surface", "limit", "offset"].map((k) => one(req.query[k]));
  if (state === false || impact === false || surface === false || limitText === false || offsetText === false) {
    return "each filter and the page are given at most once";
  }
  if (state !== null && !(STATES as readonly string[]).includes(state)) return `state must be one of ${STATES.join(", ")}`;
  if (impact !== null && !(IMPACTS as readonly string[]).includes(impact)) return `impact must be one of ${IMPACTS.join(", ")}`;
  if (surface !== null && !words.has(surface)) return "surface must be a tool, a door or console";
  const limit = Number(limitText ?? 10), offset = Number(offsetText ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) return BAD_PAGE;
  return { filter: { state, impact, surface }, limit, offset };
}

export function mountPlatformBugs(app: Express): void {
  app.get("/api/console/platform/bugs", platformPublic("the platform's bugs", async (req, res, caller) => {
    const db = platformDb();
    const asked = parse(req, await vocabulary());
    if (typeof asked === "string") {
      res.status(400).json({ error: asked });
      return;
    }
    // One instant for every statement, in whole seconds so the cutoff is the `asOf` the answer states.
    const asOfMs = Math.floor(Date.now() / 1000) * 1000;
    const asOf = new Date(asOfMs).toISOString();
    const reports = await realReports(asOf);

    // The record begins with the first real-work call, the cohorts' denominator, or with the first
    // real report if one came before it.
    const cov = await db.query<{ first_ms: number | null }>(
      `select (extract(epoch from min(e.ts)) * 1000)::float8 as first_ms
         from zz.event e
        where e.kind = 'tool_call' and e.origin = 'work' and e.ts < $1::timestamptz`, [asOf]);
    const coverageMs = bugsCoverage(cov.rows[0]?.first_ms ?? null, reports);

    // Every Monday-to-Monday week of the reporting timezone from the one coverage begins in through
    // the running one, with its real-work calls, as the status read cuts them.
    const weeks = coverageMs === null ? [] : (await db.query<{ from_ms: number; to_ms: number; calls: number }>(
      `with buckets as (
         select date_trunc('week', e.ts at time zone $1::text) as week, count(*)::int as calls
           from zz.event e
          where e.kind = 'tool_call' and e.origin = 'work' and e.ts < $2::timestamptz
          group by 1
       )
       select (extract(epoch from (w at time zone $1::text)) * 1000)::float8 as from_ms,
              (extract(epoch from ((w + interval '1 week') at time zone $1::text)) * 1000)::float8 as to_ms,
              coalesce(b.calls, 0) as calls
         from generate_series(date_trunc('week', $3::timestamptz at time zone $1::text),
                              date_trunc('week', $2::timestamptz at time zone $1::text),
                              interval '1 week') as w
         left join buckets b on b.week = w
        order by w`, [ZZ_TZ, asOf, new Date(coverageMs).toISOString()])).rows;

    // A cohort is the reports filed in one week; its own resolved and still-open counts stand
    // beside its median, which is over the resolved alone.
    const cohorts = weeks.map((w) => {
      const filed = reports.filter((r) => r.reportedMs >= w.from_ms && r.reportedMs < w.to_ms);
      const resolved = filed.filter((r) => r.status !== "open").length;
      const filedPer1000: Figure = w.calls === 0 ? { value: null, why: "no_data" }
        : { value: (1000 * filed.length) / w.calls, why: w.calls < MIN_CALLS ? "insufficient" : null };
      return {
        week: iso(w.from_ms), filed: counted(filed.length), resolved: counted(resolved),
        stillOpen: counted(filed.length - resolved), filedPer1000, medianResolveHours: medianHours(filed),
      };
    });

    const open = reports.filter((r) => r.status === "open");
    const tally = <K extends string>(keys: readonly K[], of: (r: RealReport) => string): Record<K, number> =>
      Object.fromEntries(keys.map((k) => [k, reports.filter((r) => of(r) === k).length])) as Record<K, number>;

    const { filter, limit, offset } = asked;
    const queue = queueOf(reports, filter);
    const page = queue.slice(offset, offset + limit);
    // The reporter's own words and the team, read for the superadmin's page of rows alone.
    const rows: PublicBugRow[] = caller.superadmin ? await adminRows(page) : page.map(publicRow);

    const answer: Bugs = {
      meta: {
        asOf: iso(asOfMs), timezone: ZZ_TZ,
        period: { from: cohorts[0]?.week ?? iso(asOfMs), to: iso(asOfMs) },
        scope: caller.superadmin ? "platform-admin" : "platform-public", population: "real bug reports",
        coverageFrom: coverageMs === null ? null : iso(coverageMs),
      },
      counts: { state: "ok", data: {
        open: open.length, resolved: reports.length - open.length,
        byImpact: tally(IMPACTS, (r) => r.impact), byStatus: tally(STATUSES, (r) => r.status),
      } },
      oldestOpenAt: open.length ? iso(open.at(-1)!.reportedMs) : null,
      medianResolveHours: medianHours(reports),
      cohorts,
      queue: { state: "ok", data: { rows, total: queue.length } },
    };
    res.json(answer);
  }));

  app.get("/api/console/platform/bugs/:id", platformPublic("a bug report", async (req, res, caller) => {
    if (!caller.superadmin) {
      res.status(403).json({ error: "not permitted" });
      return;
    }
    const id = String(req.params.id ?? "");
    if (!UUID.test(id)) {
      res.status(404).end();
      return;
    }
    const { rows } = await platformDb().query<{
      id: string; title: string; detail: string; surface: string | null; impact: string; status: string;
      platform_version: string | null; reported_ms: number; resolved_ms: number | null;
      resolution: string | null; duplicate_of: string | null; team: string | null;
    }>(
      `select b.id::text as id, b.title, b.detail, b.surface, b.impact, b.status, b.platform_version,
              (extract(epoch from b.reported_at) * 1000)::float8 as reported_ms,
              (extract(epoch from b.resolved_at) * 1000)::float8 as resolved_ms,
              b.resolution, b.duplicate_of::text as duplicate_of, t.slug as team
         from zz.bug b left join zz.team t on t.id = b.team_id
        where b.id = $1::uuid`, [id]);
    const r = rows[0];
    if (!r) {
      res.status(404).end();
      return;
    }
    const report: BugReport = {
      id: r.id, title: r.title, detail: r.detail, surface: canonicalSurface(r.surface, await vocabulary()) ?? r.surface,
      impact: r.impact, status: r.status,
      platformVersion: r.platform_version, reportedAt: iso(r.reported_ms),
      resolvedAt: r.resolved_ms === null ? null : iso(r.resolved_ms),
      resolution: r.resolution, duplicateOf: r.duplicate_of, team: r.team,
    };
    res.json(report);
  }));

  // The targets `bug_resolve` would accept for this report: every other report of its team, a
  // report in no team matching another in none, whatever their status.
  // COUPLED: the duplicate checks in services/zz-core/src/tools/bugs.ts.
  app.get("/api/console/platform/bugs/:id/duplicates", platformPublic("a bug report's duplicate targets", async (req, res, caller) => {
    if (!caller.superadmin) {
      res.status(403).json({ error: "not permitted" });
      return;
    }
    const id = String(req.params.id ?? "");
    if (!UUID.test(id)) {
      res.status(404).end();
      return;
    }
    const db = platformDb();
    const self = await db.query<{ id: string }>("select id::text as id from zz.bug where id = $1::uuid", [id]);
    if (!self.rows.length) {
      res.status(404).end();
      return;
    }
    const { rows } = await db.query<{ id: string; title: string; status: string; reported_ms: number }>(
      `select o.id::text as id, o.title, o.status, (extract(epoch from o.reported_at) * 1000)::float8 as reported_ms
         from zz.bug s
         join zz.bug o on o.id <> s.id and o.team_id is not distinct from s.team_id
        where s.id = $1::uuid
        order by o.reported_at desc, o.id`, [id]);
    res.json({ rows: rows.map((r) => ({ id: r.id, title: r.title, status: r.status, reportedAt: iso(r.reported_ms) })) });
  }));
}
