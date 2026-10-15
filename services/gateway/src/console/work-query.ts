/**
 * GET /api/console/work/query: Work's prepared queries, so the agent asks the database what a page does
 * not show. One measure, grouped by one of the dimensions it allows, over a window, against the previous
 * window of the same length when asked, and down to one group's rows, paged.
 *
 *   measure    grouped by                                      read from
 *   closures   outcome, flow, initiative, period               initiativeList's rows, closed in the window
 *   opened     flow, period                                    openedRows, each with its initiativeList row
 *   words      document, initiative, period                    transitions and lessons, the words each added
 *   approvals  presentation, decision_basis, initiative, period callerApprovalRows, the caller's alone
 *   lessons    kind, period                                    the team's lessons, import cohorts left out
 *   runs       skill, initiative, weekday, hour, period        runsIn, those whose first call is in the window
 *   searches   found, period                                   the team's completed work searches
 *
 * The queries are prepared: no argument is SQL, and nothing is searched but Initiatives' own q over
 * the initiatives' slugs. state, flow and q are Initiatives' filters and narrow the measures over
 * initiatives alone. Nothing is answered that a Work page could not show this person: approvals are
 * the caller's, a row is the row its page draws, and no row carries a body or a question's text.
 *
 * The window defaults to the last whole week; what it counts is inside it and before the cutoff, the
 * read's moment rounded up to a whole second, as Home's. A period group is a period of the window at
 * the grain grainFor draws it at, every one of them in order and none folded, its previous value the
 * same period of the previous window by position. Any other dimension answers its 20 largest groups,
 * the largest first and the key breaking a tie, the rest folded into one count. A drill answers the
 * group's rows newest first, the keys breaking a tie, so a page and the next never overlap; a drilled
 * initiative's next move is zz-core's, relayed as the person for the page's names alone.
 *
 * An unknown measure, an unknown dimension or one the measure does not allow, and any argument it
 * cannot read, is refused with 400 naming what is allowed, before anything is read. A read that
 * fails makes the total and the groups unavailable, and the drilled rows with them, and says so.
 *
 * Work is the active team's, for the superadmin too, and reading it records nothing: its statements
 * write no row, and the next moves are relayed as the person's console session, for which
 * initiative_status writes no event.
 *
 * DELIBERATE: no backticks in the comments of this file. check:sql reads it as text, and a backtick in
 * a comment opens a template literal it then parses as code.
 *
 * COUPLED: the console's WorkQuery and WorkQueryRow in src/lib/work-shapes.ts, and its fake answer in
 * scripts/fake-gateway/work-query.ts, which checks/console-work-query.ts compares this route's answer
 * with, key set by key set; the 400 sentences are the fake's, which the console's tests read.
 */
import type { Mcp } from "@zz/mcp-client";
import type { Express } from "express";

import { coreFor } from "../core-as-caller.js";
import { platformDb } from "../db.js";
import { callerApprovalRows } from "./approvals.js";
import type { Figure, Part, ReadMeta, Window } from "./figures.js";
import { localDate } from "./findings.js";
import { lessonImports } from "./imports.js";
import { initiativeList, listParams } from "./initiative-list.js";
import { runsIn } from "./runs-observed.js";
import { platformPublic, ZZ_TZ } from "./shared.js";
import { grainFor, lastWholeWeek, openedRows, periodsOf, type Grain, type Period } from "./work-figures.js";
import { lessonAdditions, transitions } from "./writing.js";

/** Each measure and the dimensions it may be grouped by. */
const MEASURES = {
  closures: ["outcome", "flow", "initiative", "period"],
  opened: ["flow", "period"],
  words: ["document", "initiative", "period"],
  approvals: ["presentation", "decision_basis", "initiative", "period"],
  lessons: ["kind", "period"],
  runs: ["skill", "initiative", "weekday", "hour", "period"],
  searches: ["found", "period"],
} as const;
type Measure = keyof typeof MEASURES;

type Span = { from: string; to: string };
type Relay = Pick<Mcp, "call">;
type InitiativeRow = Awaited<ReturnType<typeof initiativeList>>["rows"][number];
type ApprovalRow = Awaited<ReturnType<typeof callerApprovalRows>>[number];
type WorkQueryRow =
  | InitiativeRow
  | { initiative: string | null; path: string | null; added: number }   // a lesson: neither
  | ApprovalRow
  | { kind: string; at: string }
  | { skill: string; initiative: string | null; startedAt: string; lengthMs: number }
  | { at: string; found: boolean };
type Group = { key: string; label: string; value: Figure; share: number | null; previous: Figure | null };
type WorkQuery = {
  meta: ReadMeta;
  measure: string; by: string; window: Window;
  grain: Grain | null;
  groups: Group[];
  rest: { groups: number; value: number } | null;
  total: Figure;
  rows: Part<{ rows: WorkQueryRow[]; total: number }> | null;
};
/** Initiatives' filters, as its list reads them. */
type Filters = { state: InitiativeRow["state"] | null; flow: string | null; q: string };
type Asked = {
  measure: Measure; by: string; compare: boolean; filters: Filters;
  from: number | null; to: number | null; group: string | null; limit: number; offset: number;
};
/** One row a measure counts: when it happened, what it adds, and its key along each dimension but period. */
type Fact = { ms: number; value: number; keys: Record<string, string>; row: WorkQueryRow };

const PARAMS = ["measure", "by", "from", "to", "compare", "state", "flow", "q", "group", "limit", "offset"];
/** The groups a dimension other than period answers; the rest are folded. */
const LARGEST = 20;
/** Every row of a list read: the population is reduced here, never paged. */
const ALL = Number.MAX_SAFE_INTEGER;
/** The key of a group whose dimension the row has no value for: no flow, no initiative. */
const NONE = "none";
/** The group a lesson's words fall in when words are asked by document or initiative: a lesson is neither. */
const LESSONS = "lessons";
const BAD_WINDOW = "from and to must be ISO 8601 instants, from before to";

/** An instant as the gateway spells one: ISO 8601 in UTC, whole seconds, with the Z. */
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const counted = (n: number): Figure => ({ value: n, why: null });
const unread: Figure = { value: null, why: "unavailable" };

/** The query's arguments, or the sentence a 400 says; nothing is read to decide either. */
function parse(query: Record<string, unknown>): Asked | string {
  if (PARAMS.some((k) => query[k] !== undefined && typeof query[k] !== "string")) return "each argument is given at most once";
  const text = (k: string): string | null => (query[k] as string | undefined) ?? null;
  const measure = text("measure") ?? "";
  if (!(measure in MEASURES)) return `measure must be one of ${Object.keys(MEASURES).join(", ")}`;
  const allowed: readonly string[] = MEASURES[measure as Measure];
  const by = text("by") ?? "";
  if (!allowed.includes(by)) return `${measure} is grouped by one of ${allowed.join(", ")}`;
  const compare = text("compare");
  if (compare !== null && compare !== "previous") return "compare must be previous, or left out";
  // Initiatives' filters and the page, read as the list reads them.
  const list = listParams(query);
  if (typeof list === "string") return list;
  // An instant in whole seconds, as every instant this route compares is stamped.
  const instant = (k: string): number | null => (text(k) === null ? null : Math.floor(Date.parse(text(k)!) / 1000) * 1000);
  const [from, to] = [instant("from"), instant("to")];
  if ([from, to].some((t) => t !== null && !Number.isFinite(t)) || (from !== null && to !== null && from >= to)) {
    return BAD_WINDOW;
  }
  return {
    measure: measure as Measure, by, compare: compare !== null,
    filters: { state: list.state, flow: list.flow, q: list.q },
    from, to, group: text("group"), limit: list.limit, offset: list.offset,
  };
}

/** An instant on the reporting timezone's calendar: its local date, weekday and hour. */
function local(ms: number): { weekday: string; hour: string } {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: ZZ_TZ, weekday: "long", hour: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(ms));
  const of = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  return { weekday: of("weekday"), hour: of("hour") };
}

/** The instant a local date begins in the reporting timezone: an approval recorded by its day alone. */
function midnight(date: string): number {
  const offset = (ms: number): number => {
    const p = new Intl.DateTimeFormat("en-CA", {
      timeZone: ZZ_TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(ms));
    const n = (t: string): number => Number(p.find((x) => x.type === t)?.value);
    return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - ms;
  };
  const guess = Date.parse(`${date}T00:00:00Z`);
  return guess - offset(guess - offset(guess));
}

/** A relay that answers no initiative: the population read, which reduces rows and never draws a next move. */
const quiet: Relay = { call: async () => JSON.stringify({ initiatives: [] }) };

/** The relay asked for the names a drilled page holds alone, so zz-core is asked nothing else. */
function only(names: Set<string>, relay: Relay): Relay {
  return {
    call: async (tool, args) => {
      const wanted = ((args as { initiatives: string[] }).initiatives).filter((n) => names.has(n));
      return wanted.length ? relay.call(tool, { ...(args as object), initiatives: wanted }) : JSON.stringify({ initiatives: [] });
    },
  };
}

/** The team's lessons made inside the span before the cutoff, those of an import cohort left out. */
async function lessonsIn(team: string, [from, end]: [string, string], asOf: string): Promise<{ kind: string; ms: number }[]> {
  const [{ rows }, imports] = await Promise.all([
    platformDb().query<{ id: string; kind: string; created_ms: number }>(
      `select n.id::text as id, n.kind, (extract(epoch from n.created_at) * 1000)::float8 as created_ms
         from zz.knowledge_node n
         join zz.team t on t.id = n.team_id
        where t.slug = $1 and n.created_at >= $2::timestamptz and n.created_at < $3::timestamptz`, [team, from, end]),
    lessonImports(asOf),
  ]);
  const imported = new Set(imports.lessons.map((l) => l.id));
  return rows.filter((r) => !imported.has(r.id)).map((r) => ({ kind: r.kind, ms: r.created_ms }));
}

/** The team's completed work searches inside the span before the cutoff, as searchesWithResults counts
 *  them: each with whether its result set was not empty, and never its question. */
async function searchesIn(team: string, [from, end]: [string, string]): Promise<{ ms: number; found: boolean }[]> {
  const { rows } = await platformDb().query<{ at_ms: number; found: boolean }>(
    `select (extract(epoch from e.ts) * 1000)::float8 as at_ms,
            (jsonb_typeof(e.detail -> 'returned') = 'array' and e.detail -> 'returned' <> '[]'::jsonb) as found
       from zz.event e
       join zz.team t on t.id = e.team_id
      where t.slug = $1 and e.kind = 'knowledge.search' and e.origin = 'work' and e.detail ? 'returned'
        and e.ts >= $2::timestamptz and e.ts < $3::timestamptz`, [team, from, end]);
  return rows.map((r) => ({ ms: r.at_ms, found: r.found }));
}

/** Every row the measure counts inside the span before the cutoff, for the team and, for approvals, the caller. */
async function factsOf(a: Asked, team: string, caller: string, span: Span, asOf: string): Promise<Fact[]> {
  const bounds: [string, string] = [span.from, iso(Math.min(Date.parse(span.to), Date.parse(asOf)))];
  const list = () => initiativeList(team, { ...a.filters, limit: ALL, offset: 0 }, asOf, quiet);
  switch (a.measure) {
    case "closures": return (await list()).rows.filter((r) => r.closed !== null).map((r) => ({
      ms: Date.parse(r.closed!), value: 1, keys: { outcome: r.state, flow: r.flow ?? NONE, initiative: r.slug }, row: r,
    }));
    case "opened": {
      const [opened, { rows }] = await Promise.all([openedRows(team, span, asOf), list()]);
      const of = new Map(rows.map((r) => [r.slug, r]));
      return opened.flatMap((o) => (of.has(o.slug) ? [{ ms: Date.parse(o.opened), value: 1, keys: { flow: o.flow ?? NONE }, row: of.get(o.slug)! }] : []));
    }
    // The documents' transitions and the lessons' words, as Home's words add them: a lesson is no document,
    // so it is grouped as lessons whether the words are asked by document or by initiative.
    case "words": {
      const [moved, lessons] = await Promise.all([transitions(team, span, asOf), lessonAdditions(team, span, asOf)]);
      return [
        ...moved.map((t) => ({
          ms: Date.parse(t.at), value: t.added, keys: { document: `${t.initiative}/${t.path}`, initiative: t.initiative },
          row: { initiative: t.initiative, path: t.path, added: t.added },
        })),
        ...lessons.map((l) => ({ ms: l.atMs, value: l.words, keys: { document: LESSONS, initiative: LESSONS }, row: { initiative: null, path: null, added: l.words } })),
      ];
    }
    case "approvals": return (await callerApprovalRows(team, caller, span, asOf)).map((r) => ({
      ms: r.approvedAt.length === 10 ? midnight(r.approvedAt) : Date.parse(r.approvedAt), value: 1,
      keys: { presentation: r.presentation, decision_basis: r.decisionBasis, initiative: r.initiative }, row: r,
    }));
    case "lessons": return (await lessonsIn(team, bounds, asOf)).map((l) => ({ ms: l.ms, value: 1, keys: { kind: l.kind }, row: { kind: l.kind, at: iso(l.ms) } }));
    // A run counts at its first call, so one begun before the window touches it and is not counted in it.
    case "runs": return (await runsIn(team, span, asOf)).map((r) => {
      const ms = Date.parse(r.startedAt);
      return {
        ms, value: 1, keys: { skill: r.skill, initiative: r.initiative ?? NONE, ...local(ms) },
        row: { skill: r.skill, initiative: r.initiative, startedAt: r.startedAt, lengthMs: Date.parse(r.endedAt) - ms },
      };
    });
    case "searches": return (await searchesIn(team, bounds)).map((s) => ({
      ms: s.ms, value: 1, keys: { found: s.found ? "found" : NONE }, row: { at: iso(s.ms), found: s.found },
    }));
  }
}

/** How a group is named where its key is not a sentence. */
function labelOf(by: string, key: string, grain: Grain | null): string {
  if (grain) return `${grain === "week" ? "Week" : grain === "month" ? "Month" : "Quarter"} from ${localDate(key, ZZ_TZ)}`;
  if (by === "found") return key === NONE ? "Found nothing" : "Found something";
  if (key === NONE && (by === "flow" || by === "initiative")) return by === "flow" ? "No flow" : "No initiative";
  if (key === LESSONS && (by === "document" || by === "initiative")) return "Lessons";
  return by === "hour" ? `${key}:00` : key;
}

/** One prepared question over the window from one instant up to another, answered for the team at the
 *  cutoff, the approvals in it the caller's. */
async function workQuery(a: Asked, fromMs: number, toMs: number, team: string, caller: string, asOf: string, relay: Relay): Promise<WorkQuery> {
  const asOfMs = Date.parse(asOf);
  const meta: ReadMeta = {
    asOf, timezone: ZZ_TZ, period: { from: iso(fromMs), to: iso(toMs) },
    scope: a.measure === "approvals" ? "caller-in-active-team" : "active-team",
    population: a.measure === "approvals" ? `${team}'s approvals signed in the caller's name` : `${team}'s ${a.measure}`,
    coverageFrom: null,
  };
  const window: Window = {
    from: iso(fromMs), to: iso(toMs), observedFrom: iso(fromMs), observedThrough: iso(Math.max(fromMs, Math.min(toMs, asOfMs))),
    complete: toMs <= asOfMs,
  };
  const grain = a.by === "period" ? grainFor({ from: iso(fromMs), to: iso(toMs) }) : null;
  const unanswered = (): WorkQuery => ({
    meta, measure: a.measure, by: a.by, window, grain, groups: [], rest: null, total: unread,
    rows: a.group === null ? null : { state: "unavailable", reason: "query_failed" },
  });

  const spanMs = toMs - fromMs;
  const startMs = a.compare ? fromMs - spanMs : fromMs;
  let facts: Fact[], periods: Period[], before: Period[];
  try {
    [facts, periods, before] = await Promise.all([
      factsOf(a, team, caller, { from: iso(startMs), to: iso(toMs) }, asOf),
      grain ? periodsOf({ from: iso(fromMs), to: iso(toMs) }, asOf, grain) : [],
      grain && a.compare ? periodsOf({ from: iso(startMs), to: iso(fromMs) }, asOf, grain) : [],
    ]);
  } catch (err) {
    console.error(`console work query: ${a.measure} by ${a.by} could not be read:`, err);
    return unanswered();
  }

  const inside = (f: Fact, from: number, to: number): boolean => f.ms >= from && f.ms < Math.min(to, asOfMs);
  const now = facts.filter((f) => inside(f, fromMs, toMs));
  const then = a.compare ? facts.filter((f) => inside(f, startMs, fromMs)) : [];
  const periodOf = (f: Fact, ps: Period[]): number => ps.findIndex((p) => f.ms >= p.fromMs && f.ms < p.toMs);
  const keyOf = (f: Fact): string => (grain ? periods[periodOf(f, periods)]?.window.from ?? "" : f.keys[a.by]);
  const sum = (fs: Fact[]): number => fs.reduce((n, f) => n + f.value, 0);
  const total = sum(now);

  const keys = grain ? periods.map((p) => p.window.from) : [...new Set(now.map(keyOf))];
  const groups = keys.map((key, i): Group => {
    const value = sum(now.filter((f) => keyOf(f) === key));
    let previous: Figure | null = null;
    if (a.compare) {
      previous = !grain ? counted(sum(then.filter((f) => f.keys[a.by] === key)))
        : i < before.length ? counted(sum(then.filter((f) => periodOf(f, before) === i))) : { value: null, why: "no_data" };
    }
    return { key, label: labelOf(a.by, key, grain), value: counted(value), share: total ? value / total : null, previous };
  });
  if (!grain) groups.sort((x, y) => y.value.value! - x.value.value! || x.key.localeCompare(y.key));
  const kept = grain ? groups : groups.slice(0, LARGEST);
  const folded = grain ? [] : groups.slice(LARGEST);

  let rows: WorkQuery["rows"] = null;
  if (a.group !== null) {
    const order = (f: Fact): string => Object.values(f.keys).join("\0");
    const drilled = now.filter((f) => keyOf(f) === a.group).sort((x, y) => y.ms - x.ms || order(x).localeCompare(order(y)));
    let page = drilled.slice(a.offset, a.offset + a.limit).map((f) => f.row);
    if (a.measure === "closures" || a.measure === "opened") {
      // The page's next moves, asked of zz-core for its names alone; a batch it does not answer leaves them null.
      const names = new Set(page.map((r) => (r as InitiativeRow).slug));
      try {
        const moved = new Map((await initiativeList(team, { ...a.filters, limit: ALL, offset: 0 }, asOf, only(names, relay))).rows.map((r) => [r.slug, r]));
        page = page.map((r) => moved.get((r as InitiativeRow).slug) ?? r);
      } catch (err) {
        console.error("console work query: the drilled initiatives could not be read:", err);
        return unanswered();
      }
    }
    rows = { state: "ok", data: { rows: page, total: drilled.length } };
  }

  return {
    meta, measure: a.measure, by: a.by, window, grain,
    groups: kept,
    rest: folded.length ? { groups: folded.length, value: folded.reduce((n, g) => n + g.value.value!, 0) } : null,
    total: counted(total),
    rows,
  };
}

export function mountWorkQuery(app: Express): void {
  /** One prepared question about the team the caller's identity acts for and no other. */
  app.get("/api/console/work/query", platformPublic("the work query", async (req, res, { activeTeam }) => {
    const asked = parse(req.query as Record<string, unknown>);
    if (typeof asked === "string") {
      res.status(400).json({ error: asked });
      return;
    }
    if (activeTeam === null) {
      res.status(400).json({ error: "no team: Work is the active team's, and you act for none" });
      return;
    }
    // The cutoff in whole seconds, rounded up, so what was written in the second the read began is inside it.
    const asOf = iso(Math.ceil(Date.now() / 1000) * 1000);
    // A bound left out is the last whole week's, which a bound given may still pass.
    const week = asked.from === null || asked.to === null ? await lastWholeWeek(asOf) : null;
    const from = asked.from ?? Date.parse(week!.from), to = asked.to ?? Date.parse(week!.to);
    if (from >= to) {
      res.status(400).json({ error: BAD_WINDOW });
      return;
    }
    res.json(await workQuery(asked, from, to, activeTeam, req.zzIdentity!.email, asOf, coreFor(req)));
  }));
}
