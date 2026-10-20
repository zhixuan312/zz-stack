/**
 * GET /api/console/activity/summary and GET /api/console/activity: the active team's real work, its
 * refusals counted once under their four owners by week and grouped by owner, tool and message, and
 * its event log with four filters.
 *
 * Work is the active team's, for the superadmin too: the team is the one the caller's identity acts
 * for, and nothing the request names widens it; a caller who acts for no team is answered 400. Both
 * reads count real work (origin work) and leave out every console page view; the summary counts the
 * maintenance it leaves out beside the rest. No other team's refusal text is read by either.
 *
 * The summary's weeks are the team's, from the week of its first real-work call, the newest 24 whole
 * weeks at most and the running week, cut in the reporting timezone. Its parts:
 *
 *   tiles        the last whole week's real-work calls, its refusals with their four owners, and the
 *                tool refused most then, with its count and of how many (none, when nothing was refused)
 *   weeks        refusalWeeks by week: the calls, and the refused by owner summing to the refused total
 *   groups       refusalGroups over the weeks: the 20 largest groups, the rest folded with their count
 *   maintenance  the maintenance calls and refusals over the weeks, counted apart
 *
 * Each part fails alone: weeks or groups unread is unavailable and the rest stands. The calls, the
 * refused, its owners and the maintenance are read with the weeks; when that read fails, each of them
 * is unavailable, never zero. The tool refused most is last week's refusals by tool, a read of its own:
 * when it fails it is unavailable, never none, and the tiles beside it stand.
 *
 * The summary's body is summaryOf, which the agent read activity_refusals (console/agent-reads.ts) calls
 * too, with a first instant and an initiative the route never names: the weeks, the groups and the
 * maintenance are then counted from that instant to the cutoff, or from the start of the route's own
 * window when that instant is before it, and every part, the tiles included, only in the team's
 * initiative of that slug. The tiles stay the last whole week's, read on their own when the window starts
 * inside it.
 *
 * The log is the team's real-work events newest first, narrowed by kind, tool, initiative (a slug of
 * the active team) and refused before the latest 500 are taken, then paged; its total is the matches
 * up to that ceiling. A refused call carries its owner and its stored message.
 *
 * DELIBERATE: no backticks in the comments of this file. check:sql reads it as text, and a backtick in
 * a comment opens a template literal it then parses as code.
 *
 * COUPLED: the console's ActivitySummary and ActivityLog in src/lib/destination-shapes.ts, and its fake
 * answer in ../zz-stack-dashboard/scripts/fake-gateway/work-activity.ts, which checks/console-work-activity.ts compares these
 * routes' answers with, key set by key set.
 */
import type { RefusalOwner } from "@zz/contracts";
import type { Express, Request } from "express";

import { platformDb } from "../db.js";
import type { Part, PeriodFigure, ReadMeta, Window } from "./figures.js";
import { refusalGroups, refusalWeeks, type RefusalGroup, type RefusalPeriod } from "./refusals.js";
import { BAD_PAGE, NO_TEAM, platformPublic, ZZ_TZ } from "./shared.js";
import { lastWholeWeek, periodsOf } from "./work-figures.js";

type Owners = Record<RefusalOwner, number>;
type MostRefused = { tool: string; count: number; of: number };
export type ActivitySummary = {
  meta: ReadMeta;
  tiles: { calls: PeriodFigure; refused: PeriodFigure & { owners: Part<Owners> }; mostRefused: Part<MostRefused | null> };
  weeks: Part<RefusalPeriod[]>;
  groups: Part<{ rows: RefusalGroup[]; groups: number; rest: { groups: number; count: number } | null }>;
  maintenance: Part<{ calls: number; refused: number }>;
};
type ActivityRow = {
  id: string; ts: string; kind: string; tool: string | null; initiative: string | null; step: string | null;
  ok: boolean | null; owner: RefusalOwner | null; message: string | null; actor: string | null;
};
type ActivityLog = { meta: ReadMeta; rows: ActivityRow[]; total: number; ceiling: 500; kinds: string[]; tools: string[] };
type Asked = { kind: string | null; tool: string | null; initiative: string | null; refused: boolean | null; limit: number; offset: number };

const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;
/** The whole weeks drawn before the running one, at most. */
const WHOLE_WEEKS = 24;
/** The latest events the log reaches, after its filters. */
const CEILING = 500;

/** An instant as the gateway spells one: ISO 8601 in UTC, whole seconds, with the Z. */
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
/** A query parameter given once, absent, or given otherwise (false). */
const one = (v: unknown): string | null | false => (v === undefined ? null : typeof v === "string" ? v : false);
const population = (team: string, initiative: string | null = null): string =>
  `${team}'s real-work events` + (initiative === null ? "" : ` in its initiative ${initiative}`) + ", page views and the platform's maintenance left out";

/** What a function answers, or null when it failed; the failure is logged under its name. */
async function attempt<T>(what: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    console.error(`console activity: ${what} could not be read:`, err);
    return null;
  }
}
const UNREAD = { state: "unavailable", reason: "query_failed" } as const;
const partOf = <T>(data: T | null): Part<T> => (data === null ? UNREAD : { state: "ok", data });

/** When the team's first real-work call was recorded before the cutoff; null with none. */
async function firstCall(team: string, asOf: string): Promise<number | null> {
  const { rows } = await platformDb().query<{ first_ms: number | null }>(
    `select (extract(epoch from min(e.ts)) * 1000)::float8 as first_ms
       from zz.event e
       join zz.team t on t.id = e.team_id
      where t.slug = $1 and e.kind = 'tool_call' and e.origin = 'work' and e.ts < $2::timestamptz`, [team, asOf]);
  return rows[0]?.first_ms ?? null;
}

/** The tool refused most among the groups, the count of its refusals and of all of them; null with none. */
function mostRefusedOf(groups: RefusalGroup[]): MostRefused | null {
  const byTool = new Map<string, number>();
  for (const g of groups) byTool.set(g.tool, (byTool.get(g.tool) ?? 0) + g.count);
  const [top] = [...byTool].sort(([a, m], [b, n]) => n - m || (a < b ? -1 : a > b ? 1 : 0));
  return top ? { tool: top[0], count: top[1], of: groups.reduce((n, g) => n + g.count, 0) } : null;
}

/** The summary for the team at the cutoff: from the first call's week, or from the instant given, and in the
 *  initiative named. */
export async function summaryOf(team: string, asOf: string, ask: { from: string | null; initiative: string | null } = { from: null, initiative: null }): Promise<ActivitySummary> {
  const { initiative } = ask;
  const [week, firstMs] = await Promise.all([lastWholeWeek(asOf), firstCall(team, asOf)]);
  const weekMs = Date.parse(week.from);
  // From the first call's week, the last whole week at the latest and the newest WHOLE_WEEKS at most. A
  // Monday noon is the probe, so a daylight saving hour cannot carry it into the week before.
  const probe = Math.max(Math.min(firstMs ?? weekMs, weekMs), weekMs - (WHOLE_WEEKS - 1) * WEEK + 12 * HOUR);
  // An instant asked before that window starts at the window, so no answer reaches further than the route's.
  const windowFrom = (await periodsOf({ from: iso(probe), to: asOf }, asOf, "week"))[0].fromMs;
  const span = { from: ask.from !== null && Date.parse(ask.from) > windowFrom ? ask.from : iso(windowFrom), to: asOf };
  // A window starting inside the last whole week does not hold all of it, so the tiles read that week alone.
  const whole = Date.parse(span.from) <= weekMs;

  const [weeks, groups, lastWeek, ownWeek] = await Promise.all([
    attempt("the refusals by week", () => refusalWeeks(team, span, asOf, "week", initiative)),
    attempt("the refusal groups", () => refusalGroups(team, span, asOf, 20, initiative)),
    attempt("last week's refusals by tool", () => refusalGroups(team, { from: week.from, to: week.to }, asOf, Infinity, initiative)),
    whole ? null : attempt("last week's refusals", () => refusalWeeks(team, { from: week.from, to: week.to }, asOf, "week", initiative)),
  ]);
  const last = (whole ? weeks : ownWeek)?.periods.find((p) => p.window.from === week.from);
  const unread = (w: Window): PeriodFigure => ({ window: w, figure: { value: null, why: "unavailable" }, numerator: null, denominator: null });
  return {
    meta: {
      asOf, timezone: ZZ_TZ, period: { from: span.from, to: asOf }, scope: "active-team",
      population: population(team, initiative), coverageFrom: firstMs === null ? null : iso(firstMs),
    },
    tiles: {
      calls: last ? { window: last.window, figure: { value: last.calls, why: null }, numerator: last.calls, denominator: null } : unread(week),
      refused: last
        ? { window: last.window, figure: { value: last.refused, why: null }, numerator: last.refused, denominator: last.calls, owners: partOf(last.owners) }
        : { ...unread(week), owners: UNREAD },
      // Read, a week with nothing refused is none; unread, it is unavailable.
      mostRefused: lastWeek ? { state: "ok", data: mostRefusedOf(lastWeek.rows) } : UNREAD,
    },
    weeks: partOf(weeks && weeks.periods),
    groups: partOf(groups),
    maintenance: partOf(weeks && weeks.maintenance),
  };
}

/** The filters and the page, or the refusal. */
function parse(req: Request): Asked | string {
  const [kind, tool, initiative, refused, limitText, offsetText] =
    ["kind", "tool", "initiative", "refused", "limit", "offset"].map((k) => one(req.query[k]));
  if (kind === false || tool === false || initiative === false || refused === false || limitText === false || offsetText === false) {
    return "each filter and the page are given at most once";
  }
  if (refused !== null && refused !== "true" && refused !== "false") return "refused must be true or false";
  const limit = Number(limitText ?? 10), offset = Number(offsetText ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) return BAD_PAGE;
  return { kind, tool, initiative, refused: refused === null ? null : refused === "true", limit, offset };
}

/** The team's real-work events before the instant, page views left out, newest first: narrowed by kind, tool,
 *  initiative (its id), refused and a first instant, each null for none, and the newest limit of them, null for every
 *  one. Each is its log row, a refused call with its owner, other when none was stored, and its own message, and the
 *  instant it was recorded. The log reads its page from here, and Work's prepared queries their calls. */
export async function eventRows(team: string, end: string, f: {
  kind: string | null; tool: string | null; initiative: string | null; refused: boolean | null; from: string | null;
}, limit: number | null): Promise<{ ms: number; row: ActivityRow }[]> {
  const { rows } = await platformDb().query<{
    id: string; ts_ms: number; kind: string; tool: string | null; initiative: string | null; step: string | null;
    ok: boolean | null; owner: RefusalOwner | null; message: string | null; actor: string | null;
  }>(
    `select e.id::text as id, (extract(epoch from e.ts) * 1000)::float8 as ts_ms, e.kind,
            case when e.kind = 'tool_call' then e.tool_key end as tool,
            i.slug as initiative, sk.name as step, e.ok,
            case when e.kind = 'tool_call' and e.ok = false then coalesce(e.refusal_owner, 'other') end as owner,
            case when e.kind = 'tool_call' and e.ok = false then nullif(e.refusal, '') end as message,
            p.email as actor
       from zz.event e
       join zz.team t on t.id = e.team_id
       left join zz.principal p on p.id = e.actor_id
       left join zz.initiative i on i.id = e.initiative_id
       left join zz.skill_version sv on sv.id = e.skill_version_id
       left join zz.skill sk on sk.id = sv.skill_id
      where t.slug = $1 and e.origin = 'work' and e.kind <> 'console.page_view' and e.ts < $2::timestamptz
        and ($3::text is null or e.kind = $3::text)
        and ($4::text is null or (e.kind = 'tool_call' and e.tool_key = $4::text))
        and ($5::uuid is null or e.initiative_id = $5::uuid)
        and ($6::boolean is null or (e.kind = 'tool_call' and e.ok is false) = $6::boolean)
        and ($7::timestamptz is null or e.ts >= $7::timestamptz)
      order by e.ts desc, e.id desc
      limit $8::int`,
    [team, end, f.kind, f.tool, f.initiative, f.refused, f.from, limit]);
  return rows.map(({ ts_ms, ...r }) => ({ ms: ts_ms, row: { ...r, ts: iso(ts_ms) } }));
}

/** The log for the team at the cutoff, as asked. */
async function logOf(team: string, asked: Asked, asOf: string): Promise<ActivityLog> {
  const db = platformDb();
  const head = await db.query<{ id: string; first_ms: number | null; kinds: string[]; tools: string[] }>(
    `select t.id::text as id,
            (select (extract(epoch from min(e.ts)) * 1000)::float8 from zz.event e
              where e.team_id = t.id and e.origin = 'work' and e.kind <> 'console.page_view' and e.ts < $2::timestamptz) as first_ms,
            array(select distinct e.kind from zz.event e
                   where e.team_id = t.id and e.origin = 'work' and e.kind <> 'console.page_view' and e.ts < $2::timestamptz
                   order by 1) as kinds,
            array(select distinct e.tool_key from zz.event e
                   where e.team_id = t.id and e.origin = 'work' and e.kind = 'tool_call' and e.tool_key is not null
                     and e.ts < $2::timestamptz
                   order by 1) as tools
       from zz.team t
      where t.slug = $1`, [team, asOf]);
  const t = head.rows[0];
  // An initiative is named by its slug within the team and filtered by its id, so a slug the team does
  // not hold narrows to nothing rather than to another team's initiative of that name.
  let initiativeId: string | null = null;
  if (t && asked.initiative !== null) {
    const i = await db.query<{ id: string }>(
      "select i.id::text as id from zz.initiative i where i.team_id = $1::uuid and i.slug = $2", [t.id, asked.initiative]);
    initiativeId = i.rows[0]?.id ?? null;
  }
  const events = !t || (asked.initiative !== null && initiativeId === null) ? []
    : await eventRows(team, asOf, { kind: asked.kind, tool: asked.tool, initiative: initiativeId, refused: asked.refused, from: null }, CEILING);
  const asOfMs = Date.parse(asOf), firstMs = t?.first_ms ?? null;
  return {
    meta: {
      asOf, timezone: ZZ_TZ, period: { from: iso(firstMs ?? asOfMs), to: asOf }, scope: "active-team",
      population: population(team), coverageFrom: firstMs === null ? null : iso(firstMs),
    },
    rows: events.slice(asked.offset, asked.offset + asked.limit).map((e) => e.row),
    total: events.length, ceiling: CEILING, kinds: t?.kinds ?? [], tools: t?.tools ?? [],
  };
}

/** The cutoff in whole seconds, rounded up, so what was written in the second the read began is inside it. */
export const cutoff = (): string => iso(Math.ceil(Date.now() / 1000) * 1000);

export function mountActivity(app: Express): void {
  /** The active team's refusals by owner and week, grouped, and the maintenance left out of them. */
  app.get("/api/console/activity/summary", platformPublic("the activity summary", async (_req, res, { activeTeam }) => {
    if (activeTeam === null) {
      res.status(400).json({ error: NO_TEAM });
      return;
    }
    res.json(await summaryOf(activeTeam, cutoff()));
  }));

  /** The active team's event log, newest first, filtered before the latest 500 and paged.
   *
   *  Never a page view, even when kind names one: who opened which page is read where its population is
   *  named, not in the log of what was done. */
  app.get("/api/console/activity", platformPublic("activity", async (req, res, { activeTeam }) => {
    if (activeTeam === null) {
      res.status(400).json({ error: NO_TEAM });
      return;
    }
    const asked = parse(req);
    if (typeof asked === "string") {
      res.status(400).json({ error: asked });
      return;
    }
    res.json(await logOf(activeTeam, asked, cutoff()));
  }));
}
