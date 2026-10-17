/**
 * GET /api/console/work/query: Work's prepared queries, so the agent asks the database what a page does
 * not show. One measure, grouped by one of the dimensions it allows, over a window, against the previous
 * window of the same length when asked, and down to one group's rows, paged.
 *
 *   measure      grouped by                                      read from
 *   closures     outcome, flow, initiative, period               initiativeList's rows, closed in the window
 *   opened       flow, period                                    openedRows, each with its initiativeList row
 *   words        document, initiative, period                    transitions and lessons, the words each added
 *   approvals    presentation, decision_basis, initiative, period callerApprovalRows, the caller's alone
 *   lessons      kind, period                                    the team's lessons, import cohorts left out
 *   runs         skill, initiative, weekday, hour, period        runsIn, those whose first call is in the window
 *   searches     found, period                                   the team's completed work searches
 *   calls        tool, initiative, refused, period               the team's real-work tool calls, as Activity's log
 *   refusals     owner, tool, initiative, period                 those of them refused, under refusalWeeks' owners
 *   output       skill, initiative, period                       runsIn's observed output, as Runs reads it
 *   skill_calls  plugin, skill, period                           the team's calls of a shipped skill, as Plugins
 *   shelf        kind, standing                                  the team's shelf as of the window's end
 *
 * The queries are prepared: no argument is SQL, and nothing is searched but Initiatives' own q over
 * the initiatives' slugs. state, flow and q are Initiatives' filters and narrow the measures over
 * initiatives alone. Nothing is answered that a Work page could not show this person: approvals are
 * the caller's, a row is the row its page draws, and no row carries a body. A search's question is
 * answered only in a drill of the searches that found nothing, as Knowledge lists them, and only to
 * the team that asked it; a refusal's message only to its own team, as Activity's log does.
 *
 * A refusal is a real-work tool call with ok false, owned as refusalWeeks owns it, a row with no owner
 * counted as other, so the four owners sum to the total; grouped by owner, all four are answered, and
 * grouped by refused, both. Output is the bytes a run's own calls answered, summed over the runs that
 * measured it, those that measured none counted beside each figure as unmeasured; a group whose runs
 * all measured none is no_data, never zero. skill_calls counts what Plugins counts for the team, every
 * real-work tool call of a skill a shipped plugin ships, under the plugin that ships it; its groups are its
 * rows, so it is not drilled. The shelf is a stock: the team's lessons made before the window's end,
 * standing or superseded as they stand now, because nothing records when a lesson was superseded; each
 * figure says beside it how many of its standing lessons an import made, and no figure of an earlier
 * window is answered for it, so period is not its dimension.
 *
 * The window defaults to the last whole week; what it counts is inside it and before the cutoff, the
 * read's moment rounded up to a whole second, as Home's. from and to are two instants, or two dates read
 * as the reporting timezone's days, the window running from the first's midnight to the midnight after
 * the second; a from of 0001-01-01, which ZZ Meridian's runner sends for all, is the first local day the
 * measure's record holds, found before the where filters. A period group is a period of the window at
 * the grain grainFor draws it at, every one of them in order and none folded, its previous value the
 * same period of the previous window by position. Every measure that takes period also takes the four
 * buckets, day, week, month and weekday, as work-query-buckets.ts keys them, but for runs, whose
 * weekday is its own dimension: every bucket of the window in order, the latest top of them answered
 * and the earlier ones folded, a day, week or month's previous value the same bucket of the previous
 * window by position, a weekday's the same weekday. Any other dimension answers its top largest
 * groups, 20 when not asked, the largest first and the key breaking a tie, the rest folded into one
 * count. where filters the rows on the measure's own dimensions, equality alone, at most four. A drill
 * answers the group's rows newest first, the keys breaking a tie, so a page and the next never
 * overlap; rows answers the newest of every row the filters and the window keep, as ZZ Meridian's
 * runner drills; a drilled initiative's next move is zz-core's, relayed as the person for the page's
 * names alone.
 *
 * An unknown measure, an unknown dimension or one the measure does not allow, a filter on a dimension
 * it does not take or outside a closed vocabulary, a date and an instant in one window, rows or a group
 * of skill_calls, and any argument it cannot read, is refused with 400 naming what is allowed and never
 * echoing a value sent, before anything is read. A read that fails makes the total and the groups
 * unavailable, and the drilled rows with them, and says so.
 *
 * Work is the active team's, for the superadmin too, and reading it records nothing: its statements
 * write no row, and the next moves are relayed as the person's console session, for which
 * initiative_status writes no event.
 *
 * DELIBERATE: no backticks in the comments of this file. check:sql reads it as text, and a backtick in
 * a comment opens a template literal it then parses as code.
 *
 * COUPLED: the console's WorkQuery and WorkQueryRow in src/lib/work-shapes.ts, and its fake answer in
 * ../zz-stack-dashboard/scripts/fake-gateway/work-query.ts, which checks/console-work-query.ts and
 * checks/console-work-query-destinations.ts compare this route's answer with, key set by key set; the
 * 400 sentences are the fake's, which the console's tests read. A drilled row is the row its page
 * draws, read by the page's own function: Activity's eventRows, Runs' runRow and the shelf's shelfRows.
 */
import { OUTCOMES, REFUSAL_OWNERS } from "@zz/contracts";
import { catalogEntries, pluginName } from "@zz/catalog";
import type { Mcp } from "@zz/mcp-client";
import type { Express } from "express";

import { coreFor } from "../core-as-caller.js";
import { platformDb } from "../db.js";
import { BASELINE } from "../package/skills.js";
import { eventRows } from "./activity.js";
import { callerApprovalRows } from "./approvals.js";
import { skillsOf } from "./catalog.js";
import type { Figure, Part, ReadMeta, Window } from "./figures.js";
import { localDate } from "./findings.js";
import { lessonImports } from "./imports.js";
import { initiativeList, listParams } from "./initiative-list.js";
import { shelfRows } from "./knowledge.js";
import { runRow } from "./runs.js";
import { runsIn } from "./runs-observed.js";
import { platformPublic, ZZ_TZ } from "./shared.js";
import { grainFor, lastWholeWeek, openedRows, periodsOf, type Grain, type Period } from "./work-figures.js";
import { BUCKETS, WEEKDAYS, addDays, bucketLabel, bucketOf, bucketsOf, isDate, localDay, midnight, type Bucket } from "./work-query-buckets.js";
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
  calls: ["tool", "initiative", "refused", "period"],
  refusals: ["owner", "tool", "initiative", "period"],
  output: ["skill", "initiative", "period"],
  skill_calls: ["plugin", "skill", "period"],
  shelf: ["kind", "standing"],
} as const;
type Measure = keyof typeof MEASURES;
/** The groups a dimension always answers, an empty one as zero, so no owner or standing falls out of a chart. */
const FIXED: Record<string, readonly string[]> = { owner: REFUSAL_OWNERS, refused: ["refused", "answered"], standing: ["standing", "superseded"] };
/** The values a filter on a closed dimension may name; a free one, a tool or an initiative, takes any. */
const VOCABULARY: Record<string, readonly string[]> = {
  ...FIXED, found: ["found", "none"], outcome: OUTCOMES, weekday: WEEKDAYS, hour: Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0")),
};

/** What a measure may be grouped by: its dimensions, then the buckets where it takes period and has no dimension of the name. */
const groupings = (m: Measure): readonly string[] => {
  const dims: readonly string[] = MEASURES[m];
  return dims.includes("period") ? [...dims, ...BUCKETS.filter((b) => !dims.includes(b))] : dims;
};
/** The bucket a grouping names, or null for a dimension or period. */
const bucketFor = (m: Measure, by: string): Bucket | null =>
  (BUCKETS as readonly string[]).includes(by) && !(MEASURES[m] as readonly string[]).includes(by) ? by as Bucket : null;

type Span = { from: string; to: string };
type Relay = Pick<Mcp, "call">;
type InitiativeRow = Awaited<ReturnType<typeof initiativeList>>["rows"][number];
type ApprovalRow = Awaited<ReturnType<typeof callerApprovalRows>>[number];
type ActivityRow = Awaited<ReturnType<typeof eventRows>>[number]["row"];
type RunRow = ReturnType<typeof runRow>;
type KnowledgeRow = Awaited<ReturnType<typeof shelfRows>>[number]["row"];
type WorkQueryRow =
  | InitiativeRow
  | { initiative: string | null; path: string | null; added: number }   // a lesson: neither
  | ApprovalRow
  | { kind: string; at: string }
  | { skill: string; initiative: string | null; startedAt: string; lengthMs: number }
  | { at: string; found: boolean; question: string | null }
  | ActivityRow | RunRow | KnowledgeRow;
/** A figure, and for output the runs in it that measured none, for the shelf the imports among its standing lessons. */
type Counted = Figure & { unmeasured?: number; imported?: number };
type Group = { key: string; label: string; value: Counted; share: number | null; previous: Counted | null };
type WorkQuery = {
  meta: ReadMeta;
  measure: string; by: string; window: Window;
  grain: Grain | Bucket | null;
  groups: Group[];
  rest: { groups: number; value: number } | null;
  total: Counted;
  rows: Part<{ rows: WorkQueryRow[]; total: number }> | null;
};
/** Initiatives' filters, as its list reads them. */
type Filters = { state: InitiativeRow["state"] | null; flow: string | null; q: string };
/** The window's start: an instant, or the first local day of the measure's record. */
type From = number | typeof FIRST;
type Asked = {
  measure: Measure; by: string; compare: boolean; filters: Filters; where: [string, string][]; top: number;
  from: From | null; to: number | null; group: string | null; rows: number | null; limit: number; offset: number;
};
/** One row a measure counts: when it happened, what it adds (null for a run that measured no output), its key along
 *  each dimension but period, and its id where the record has one, the last to break a tie between two rows. */
type Fact = { ms: number; value: number | null; keys: Record<string, string>; row: WorkQueryRow | null; id?: string; imported?: boolean };

const PARAMS = ["measure", "by", "from", "to", "compare", "state", "flow", "q", "group", "rows", "top", "limit", "offset"];
/** The groups a dimension or a bucket answers when top is not asked; the rest are folded. */
const LARGEST = 20;
const MOST_TOP = 50, MOST_ROWS = 20, MOST_FILTERS = 4;
/** The from ZZ Meridian's runner sends for all. */
const FIRST = "0001-01-01";
/** Every row of a list read: the population is reduced here, never paged. */
const ALL = Number.MAX_SAFE_INTEGER;
/** The key of a group whose dimension the row has no value for: no flow, no initiative. */
const NONE = "none";
/** The group a lesson's words fall in when words are asked by document or initiative: a lesson is neither. */
const LESSONS = "lessons";
const BAD_WINDOW = "from and to must be ISO 8601 instants or dates, YYYY-MM-DD, from before to";
const MIXED_WINDOW = "from and to are both dates or both instants, not one of each";
const NOT_DRILLED = "skill_calls is not drilled: its groups are its rows";

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
  const allowed = groupings(measure as Measure);
  const by = text("by") ?? "";
  if (!allowed.includes(by)) return `${measure} is grouped by one of ${allowed.join(", ")}`;
  const compare = text("compare");
  if (compare !== null && compare !== "previous") return "compare must be previous, or left out";
  if (measure === "skill_calls" && (text("group") !== null || text("rows") !== null)) return NOT_DRILLED;
  const where = whereOf(measure as Measure, query.where);
  if (typeof where === "string") return where;
  const whole = (k: string, most: number): number | null | undefined => {
    const n = text(k) === null ? null : Number(text(k));
    return n === null || (Number.isInteger(n) && n >= 1 && n <= most) ? n : undefined;
  };
  const top = whole("top", MOST_TOP), rows = whole("rows", MOST_ROWS);
  if (top === undefined) return `top must be a whole number from 1 to ${MOST_TOP}`;
  if (top !== null && by === "period") return "period answers every period of the window, so it takes no top";
  if (rows === undefined) return `rows must be a whole number from 1 to ${MOST_ROWS}`;
  if (rows !== null && ["group", "limit", "offset"].some((k) => text(k) !== null)) {
    return "rows is the newest of the window's rows, so it is given without group, limit or offset";
  }
  // Initiatives' filters and the page, read as the list reads them.
  const list = listParams(query);
  if (typeof list === "string") return list;
  // A date as its local day's midnight, or for to the next day's; an instant in whole seconds, as every
  // instant this route compares is stamped. A text shaped as a date the calendar has not is neither.
  const bound = (k: string): { ms: number; date: boolean } | null => {
    const t = text(k);
    if (t === null) return null;
    if (isDate(t)) return { ms: midnight(k === "to" ? addDays(t, 1) : t), date: true };
    return { ms: /^\d{4}-\d{2}-\d{2}$/.test(t) ? NaN : Math.floor(Date.parse(t) / 1000) * 1000, date: false };
  };
  const to = bound("to");
  const from: ReturnType<typeof bound> | typeof FIRST = text("from") === FIRST ? FIRST : bound("from");
  if ([from, to].some((b) => b !== null && b !== FIRST && !Number.isFinite(b.ms))) return BAD_WINDOW;
  if (from !== null && to !== null && (from === FIRST || from.date) !== to.date) return MIXED_WINDOW;
  if (from !== null && from !== FIRST && to !== null && from.ms >= to.ms) return BAD_WINDOW;
  return {
    measure: measure as Measure, by, compare: compare !== null,
    filters: { state: list.state, flow: list.flow, q: list.q }, where, top: top ?? LARGEST,
    from: from === null || from === FIRST ? from : from.ms, to: to?.ms ?? null,
    group: text("group"), rows, limit: list.limit, offset: list.offset,
  };
}

/** The where filters, each an equality on one of the measure's own dimensions, or the sentence a 400 says. */
function whereOf(measure: Measure, raw: unknown): [string, string][] | string {
  if (raw === undefined) return [];
  const list = typeof raw === "string" ? [raw] : Array.isArray(raw) && raw.every((w) => typeof w === "string") ? raw as string[] : null;
  if (list === null) return "each where is a dimension, an equals sign and a value";
  if (list.length > MOST_FILTERS) return `where takes at most ${MOST_FILTERS} filters`;
  const dims = (MEASURES[measure] as readonly string[]).filter((d) => d !== "period");
  const out: [string, string][] = [];
  for (const w of list) {
    const at = w.indexOf("=");
    if (at < 1) return "each where is a dimension, an equals sign and a value";
    const [dim, value] = [w.slice(0, at), w.slice(at + 1)];
    if (!dims.includes(dim)) return `${measure} is filtered by one of ${dims.join(", ")}`;
    if (VOCABULARY[dim] && !VOCABULARY[dim].includes(value)) return `a filter on ${dim} takes one of ${VOCABULARY[dim].join(", ")}`;
    out.push([dim, value]);
  }
  return out;
}

/** An instant on the reporting timezone's calendar: its local date, weekday and hour. */
function local(ms: number): { weekday: string; hour: string } {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: ZZ_TZ, weekday: "long", hour: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(ms));
  const of = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  return { weekday: of("weekday"), hour: of("hour") };
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
 *  them: each with whether its result set was not empty and, for one that found nothing, its question
 *  normalised for case and spacing as Knowledge lists it (COUPLED: knowledge-summary.ts questionsOf). */
async function searchesIn(team: string, [from, end]: [string, string]): Promise<{ ms: number; found: boolean; question: string | null }[]> {
  const { rows } = await platformDb().query<{ at_ms: number; found: boolean; question: string | null }>(
    `select s.at_ms, s.found, case when not s.found then s.question end as question
       from (select (extract(epoch from e.ts) * 1000)::float8 as at_ms,
                    (jsonb_typeof(e.detail -> 'returned') = 'array' and e.detail -> 'returned' <> '[]'::jsonb) as found,
                    lower(btrim(regexp_replace(coalesce(e.subject, ''), '\\s+', ' ', 'g'))) as question
               from zz.event e
               join zz.team t on t.id = e.team_id
              where t.slug = $1 and e.kind = 'knowledge.search' and e.origin = 'work' and e.detail ? 'returned'
                and e.ts >= $2::timestamptz and e.ts < $3::timestamptz) s`, [team, from, end]);
  return rows.map((r) => ({ ms: r.at_ms, found: r.found, question: r.question }));
}

/** The team's real-work tool calls of a skill inside the span before the cutoff, as Plugins counts them for the
 *  team: a call naming no skill version counted under no skill (COUPLED: catalog.ts, /plugins). */
async function skillCallsIn(team: string, [from, end]: [string, string]): Promise<{ ms: number; skill: string }[]> {
  const { rows } = await platformDb().query<{ at_ms: number; skill: string }>(
    `select (extract(epoch from e.ts) * 1000)::float8 as at_ms, sk.name as skill
       from zz.event e
       join zz.team t on t.id = e.team_id
       join zz.skill_version sv on sv.id = e.skill_version_id
       join zz.skill sk on sk.id = sv.skill_id
      where t.slug = $1 and e.kind = 'tool_call' and e.origin = 'work'
        and e.ts >= $2::timestamptz and e.ts < $3::timestamptz`, [team, from, end]);
  return rows.map((r) => ({ ms: r.at_ms, skill: r.skill }));
}

/** Each skill a plugin this image ships, and the plugin: of two shipping one name, the first by name. */
function pluginOfSkill(): Map<string, string> {
  const of = new Map<string, string>();
  for (const plugin of [...new Set([BASELINE, ...catalogEntries().map((e) => pluginName(e.flow))])].sort()) {
    for (const skill of skillsOf(plugin)) if (!of.has(skill)) of.set(skill, plugin);
  }
  return of;
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
      ms: s.ms, value: 1, keys: { found: s.found ? "found" : NONE }, row: { at: iso(s.ms), found: s.found, question: s.question },
    }));
    case "calls":
    case "refusals": return (await eventRows(team, bounds[1], { kind: "tool_call", tool: null, initiative: null, refused: null, from: bounds[0] }, null)).filter((c) => a.measure === "calls" || c.row.ok === false).map((c) => ({
      ms: c.ms, value: 1, id: c.row.id, row: c.row,
      keys: { tool: c.row.tool ?? NONE, initiative: c.row.initiative ?? NONE, refused: c.row.ok === false ? "refused" : "answered", owner: c.row.owner ?? "" },
    }));
    case "output": return (await runsIn(team, span, asOf)).map((r) => ({
      ms: Date.parse(r.startedAt), value: r.bytes, id: r.id, keys: { skill: r.skill, initiative: r.initiative ?? NONE },
      row: runRow(r, Date.parse(asOf)),
    }));
    case "skill_calls": {
      const plugin = pluginOfSkill();
      return (await skillCallsIn(team, bounds)).flatMap((c) => (plugin.has(c.skill)
        ? [{ ms: c.ms, value: 1, keys: { plugin: plugin.get(c.skill)!, skill: c.skill }, row: null }] : []));
    }
    // A stock as of the window's end, counted whatever the window's start.
    case "shelf": {
      const [lessons, imports] = await Promise.all([shelfRows(team, bounds[1], { q: "", kind: null, limit: null, offset: 0 }), lessonImports(asOf)]);
      const imported = new Set(imports.lessons.map((l) => l.id));
      return lessons.map((l) => ({
        ms: l.createdMs, value: 1, id: l.id, row: l.row, imported: l.standing && imported.has(l.id),
        keys: { kind: l.row.type, standing: l.standing ? "standing" : "superseded" },
      }));
    }
  }
}

/** What facts add up to: for output, beside it the runs that measured none, and no_data where every run did; for
 *  the shelf, beside it its standing lessons an import made. */
function countOf(measure: Measure, fs: Fact[]): Counted {
  const measured = fs.filter((f) => f.value !== null);
  const sum: Figure = fs.length && !measured.length ? { value: null, why: "no_data" } : counted(measured.reduce((n, f) => n + f.value!, 0));
  if (measure === "output") return { ...sum, unmeasured: fs.length - measured.length };
  if (measure === "shelf") return { ...sum, imported: fs.filter((f) => f.imported).length };
  return sum;
}

/** How a group is named where its key is not a sentence. */
function labelOf(by: string, key: string, grain: Grain | null): string {
  if (grain) return `${grain === "week" ? "Week" : grain === "month" ? "Month" : "Quarter"} from ${localDate(key, ZZ_TZ)}`;
  if (by === "found") return key === NONE ? "Found nothing" : "Found something";
  if (by === "refused" || by === "standing") return key[0].toUpperCase() + key.slice(1);
  if (key === NONE && (by === "flow" || by === "initiative")) return by === "flow" ? "No flow" : "No initiative";
  if (key === LESSONS && (by === "document" || by === "initiative")) return "Lessons";
  return by === "hour" ? `${key}:00` : key;
}

/** One prepared question over the window from one instant, or the record's first local day, up to another,
 *  answered for the team at the cutoff, the approvals in it the caller's. */
async function workQuery(a: Asked, from: From, toMs: number, team: string, caller: string, asOf: string, relay: Relay): Promise<WorkQuery> {
  const asOfMs = Date.parse(asOf);
  // The record's first day is found over everything before the window's end, which then holds the previous window too.
  let read: Promise<Fact[]> | null = null;
  let fromMs: number;
  if (from === FIRST) {
    read = factsOf(a, team, caller, { from: iso(0), to: iso(toMs) }, asOf);
    const first = await read.then((fs) => fs.reduce((m, f) => (f.ms < toMs ? Math.min(m, f.ms) : m), Infinity), () => Infinity);
    fromMs = midnight(localDay(Number.isFinite(first) ? first : toMs - 1));
  } else {
    fromMs = from;
  }
  const meta: ReadMeta = {
    asOf, timezone: ZZ_TZ, period: { from: iso(fromMs), to: iso(toMs) },
    scope: a.measure === "approvals" ? "caller-in-active-team" : "active-team",
    population: a.measure === "approvals" ? `${team}'s approvals signed in the caller's name` : `${team}'s ${a.measure.replace("_", " ")}`,
    coverageFrom: null,
  };
  const window: Window = {
    from: iso(fromMs), to: iso(toMs), observedFrom: iso(fromMs), observedThrough: iso(Math.max(fromMs, Math.min(toMs, asOfMs))),
    complete: toMs <= asOfMs,
  };
  const grain = a.by === "period" ? grainFor({ from: iso(fromMs), to: iso(toMs) }) : null;
  const bucket = bucketFor(a.measure, a.by);
  const drilling = a.group !== null || a.rows !== null;
  const unanswered = (): WorkQuery => ({
    meta, measure: a.measure, by: a.by, window, grain: grain ?? bucket, groups: [], rest: null, total: unread,
    rows: drilling ? { state: "unavailable", reason: "query_failed" } : null,
  });

  const spanMs = toMs - fromMs;
  const startMs = a.compare ? fromMs - spanMs : fromMs;
  let facts: Fact[], periods: Period[], before: Period[];
  try {
    [facts, periods, before] = await Promise.all([
      read ?? factsOf(a, team, caller, { from: iso(startMs), to: iso(toMs) }, asOf),
      grain ? periodsOf({ from: iso(fromMs), to: iso(toMs) }, asOf, grain) : [],
      grain && a.compare ? periodsOf({ from: iso(startMs), to: iso(fromMs) }, asOf, grain) : [],
    ]);
  } catch (err) {
    console.error(`console work query: ${a.measure} by ${a.by} could not be read:`, err);
    return unanswered();
  }
  facts = facts.filter((f) => a.where.every(([dim, value]) => f.keys[dim] === value));

  const inside = (f: Fact, from: number, to: number): boolean => f.ms >= from && f.ms < Math.min(to, asOfMs);
  // A stock is counted as of the window's end, and nothing records it as of the end of the one before.
  const stock = a.measure === "shelf";
  const now = stock ? facts : facts.filter((f) => inside(f, fromMs, toMs));
  const then = a.compare && !stock ? facts.filter((f) => inside(f, startMs, fromMs)) : [];
  const periodOf = (f: Fact, ps: Period[]): number => ps.findIndex((p) => f.ms >= p.fromMs && f.ms < p.toMs);
  const keyOf = (f: Fact): string =>
    (grain ? periods[periodOf(f, periods)]?.window.from ?? "" : bucket ? bucketOf(bucket, f.ms) : f.keys[a.by]);
  const count = (fs: Fact[]): Counted => countOf(a.measure, fs);
  const total = count(now);
  const members = new Map<string, Fact[]>();
  for (const f of now) {
    const key = keyOf(f);
    if (!members.has(key)) members.set(key, []);
    members.get(key)!.push(f);
  }
  // A day, week or month of the previous window is matched to this one's by position, as a period is.
  const series = bucket ? bucketsOf(bucket, fromMs, Math.min(toMs, asOfMs)) : [];
  const earlier = bucket && bucket !== "weekday" && a.compare ? bucketsOf(bucket, startMs, Math.min(fromMs, asOfMs)) : [];

  const keys = grain ? periods.map((p) => p.window.from) : bucket ? series : [...new Set([...(FIXED[a.by] ?? []), ...members.keys()])];
  const groups = keys.map((key, i): Group => {
    const value = count(members.get(key) ?? []);
    let previous: Counted | null = null;
    if (a.compare && !stock) {
      const noData = (): Counted => ({ ...count([]), value: null, why: "no_data" });
      previous = grain ? (i < before.length ? count(then.filter((f) => periodOf(f, before) === i)) : noData())
        : bucket && bucket !== "weekday" ? (i < earlier.length ? count(then.filter((f) => bucketOf(bucket, f.ms) === earlier[i])) : noData())
        : count(then.filter((f) => (bucket ? bucketOf(bucket, f.ms) : f.keys[a.by]) === key));
    }
    const label = bucket ? bucketLabel(bucket, key) : labelOf(a.by, key, grain);
    return { key, label, value, share: total.value ? (value.value ?? 0) / total.value : null, previous };
  });
  if (!grain && !bucket) groups.sort((x, y) => (y.value.value ?? -1) - (x.value.value ?? -1) || x.key.localeCompare(y.key));
  // A bucket keeps the latest of the window, a dimension its largest; a period is never folded.
  const cut = grain ? 0 : bucket ? Math.max(0, groups.length - a.top) : Math.min(a.top, groups.length);
  const [kept, folded] = grain ? [groups, []] : bucket ? [groups.slice(cut), groups.slice(0, cut)] : [groups.slice(0, cut), groups.slice(cut)];

  let rows: WorkQuery["rows"] = null;
  if (drilling) {
    const order = (f: Fact): string => [...Object.values(f.keys), f.id ?? ""].join("\0");
    const drilled = [...(a.group !== null ? members.get(a.group) ?? [] : now)].sort((x, y) => y.ms - x.ms || order(x).localeCompare(order(y)));
    let page = (a.rows !== null ? drilled.slice(0, a.rows) : drilled.slice(a.offset, a.offset + a.limit)).map((f) => f.row!);
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
    meta, measure: a.measure, by: a.by, window, grain: grain ?? bucket,
    groups: kept,
    rest: folded.length ? { groups: folded.length, value: folded.reduce((n, g) => n + (g.value.value ?? 0), 0) } : null,
    total,
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
    if (from !== FIRST && from >= to) {
      res.status(400).json({ error: BAD_WINDOW });
      return;
    }
    res.json(await workQuery(asked, from, to, activeTeam, req.zzIdentity!.email, asOf, coreFor(req)));
  }));
}
