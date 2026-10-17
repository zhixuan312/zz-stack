/**
 * GET /api/console/platform/query: the Platform prepared query, which every Platform view's prepared query is answered
 * by, so the agent asks the database what a Platform page does not show. One measure over a window of the reporting
 * time zone's whole days, grouped by one of its dimensions or by a bucket of its days, against the window before it
 * of the same length when asked, and down to the rows its page draws. The measures, what each counts and the page
 * figure it equals are platform-query-measures.ts's; the calendar is Work's, work-query-buckets.ts's.
 *
 *   measure     one of the measures
 *   by          one of the measure's dimensions, or a bucket: day, week, month, weekday; left out, the total alone
 *   from, to    inclusive dates, YYYY-MM-DD, both or neither; neither is the last whole week; from=0001-01-01 reads
 *               from the measure's first recorded day
 *   compare     previous: each group's value in the window before, of the same length; not for a stock
 *   where       dimension=value, an equality filter on one of the measure's dimensions, repeated, at most four; an
 *               empty value keeps the rows with no value along it
 *   group       a group's key, empty for the group with none, to drill to its rows, limit of them from offset
 *   rows        1 to 20: the rows the filters and the window keep, newest first, with no group
 *   top         1 to 50, default 20: the largest groups of a dimension, the key breaking a tie, or the latest
 *               buckets, in date order and the weekdays Monday to Sunday; the rest are folded into one count
 *   limit       1 to 20, default 10, and offset: the page of a group's rows
 *
 * Any other argument changes nothing, as on every console route: the console's server sends scope on every read,
 * and a team named outside a where filter names nothing here.
 *
 * Its calendar is Work's, work-query-buckets.ts: a date is the reporting time zone's whole day, and a bucket's key
 * and label, and the buckets a window holds before its end or the cutoff, are that module's, so one reader of both
 * prepared queries reads their buckets alike. A bucket's previous is the same bucket of the window before by its
 * place in it, a weekday's the same weekday.
 * The queries are prepared: no argument is SQL, and a filter's value is held to its dimension's vocabulary before it
 * is compared with anything. What a member reads is what the measure's page shows a member, and the superadmin's
 * measures (teams, people, sign_ins, audit), a team's name as a dimension or a filter, and the questions searches
 * asked are the superadmin's alone: a member asking any of them, a where on team among them, is refused 403 with
 * the sentence every console route refuses with, before anything is read.
 *
 * A measure, a dimension, a bucket, a filter, a window, top, rows or a page outside what the route takes is refused
 * 400 with a sentence naming what it takes, a filter's value with the vocabulary it is held to and never the value
 * sent; a vocabulary is read before that refusal and nothing else is. A read that fails makes the total and the
 * groups unavailable, and the drilled rows with them, and says so, never a zero; rows that fail alone are
 * unavailable beside the figures that stand.
 *
 * One cutoff a request, the read's moment in whole seconds, as every Platform page cuts its own. Reading it records
 * nothing.
 *
 * COUPLED: PlatformQuery in packages/contracts/src/platform-query.ts, and the console's copy of it.
 */
import type { PlatformQuery, PlatformQueryFigure, PlatformQueryGroup } from "@zz/contracts";
import type { Express } from "express";

import { platformDb } from "../db.js";
import { MEASURES, type Ctx, type Fact, type Measure, type Who } from "./platform-query-measures.js";
import { platformPublic, ZZ_TZ } from "./shared.js";
import {
  BUCKETS, WEEKDAYS, addDays, bucketLabel, bucketOf, bucketsOf, isDate, midnight, type Bucket,
} from "./work-query-buckets.js";

const PARAMS = ["measure", "by", "from", "to", "compare", "group", "rows", "top", "limit", "offset"];
/** The first date there is: the runner's all, read as from the measure's first recorded day. */
const ALL = "0001-01-01";
const FILTERS = 4;
const WINDOW = "from and to are inclusive dates, YYYY-MM-DD, given both or neither, from no later than to; from=0001-01-01 " +
  "reads from the first recorded day";
const MIXED = "from and to are both dates or both instants, not one of each";
/** The sentence every console route refuses a member with. */
const REFUSED = { status: 403, error: "not permitted" } as const;

type Refusal = { status: 400 | 403; error: string };
type Asked = {
  measure: string; m: Measure; by: string | null; bucket: Bucket | null;
  from: string | null; to: string | null; compare: boolean;
  where: [string, string | null][];
  /** The group drilled, its key null for the rows with none; undefined when no group is drilled. */
  group: string | null | undefined;
  rows: number | null; top: number; limit: number; offset: number;
};

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const bad = (error: string): Refusal => ({ status: 400, error });
const counted = (n: number): PlatformQueryFigure => ({ value: n, why: null });
const UNREAD: PlatformQueryFigure = { value: null, why: "unavailable" };
const sum = (fs: Fact[]): number => fs.reduce((n, f) => n + f.n, 0);
const DAY_MS = 86_400_000;
/** The days from one date through another, both counted. */
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1;

/** Whether a key names a bucket of its kind, as bucketOf keys it: a date, a Monday, a month or a weekday. */
function isBucketKey(key: string, bucket: Bucket): boolean {
  if (bucket === "weekday") return WEEKDAYS.includes(key);
  if (bucket === "month") return /^\d{4}-\d{2}$/.test(key) && isDate(`${key}-01`);
  return isDate(key) && (bucket === "day" || bucketOf("week", midnight(key)) === key);
}

/** A whole number from `lo` to `hi`, its default when absent, NaN when it is anything else. */
function whole(v: string | undefined, lo: number, hi: number, otherwise: number): number {
  if (v === undefined) return otherwise;
  return /^\d+$/.test(v) && Number(v) >= lo && Number(v) <= hi ? Number(v) : Number.NaN;
}

/** What a measure is grouped by, as its refusal names it. */
function groupedBy(measure: string, m: Measure): string {
  const dims = Object.keys(m.dims);
  const buckets = `a bucket: ${BUCKETS.join(", ")}`;
  if (!m.buckets) return `${measure} is grouped by ${dims.join(", ")}`;
  return dims.length ? `${measure} is grouped by one of ${dims.join(", ")}, or ${buckets}` : `${measure} is grouped by ${buckets}`;
}

/** The question's arguments, or the refusal; nothing is read to decide either. */
function parse(query: Record<string, unknown>, who: Who): Asked | Refusal {
  if (PARAMS.some((k) => query[k] !== undefined && typeof query[k] !== "string")) return bad("each argument is given at most once");
  const q = query as Record<string, string | undefined>;
  const measure = q.measure ?? "";
  if (!Object.hasOwn(MEASURES, measure)) return bad(`measure must be one of ${Object.keys(MEASURES).join(", ")}`);
  const m = MEASURES[measure];
  // What only the superadmin is shown is refused a member before anything else is said of the question.
  if (!who.superadmin && m.superadmin) return REFUSED;
  const dims = Object.keys(m.dims);

  const by = q.by ?? null;
  const bucket = by !== null && m.buckets && (BUCKETS as readonly string[]).includes(by) ? by as Bucket : null;
  if (by !== null && bucket === null && !dims.includes(by)) return bad(groupedBy(measure, m));
  if (by !== null && m.dims[by]?.superadmin && !who.superadmin) return REFUSED;

  const [from, to] = [q.from ?? null, q.to ?? null];
  if (from !== null || to !== null) {
    const instant = (v: string | null): boolean => v !== null && !isDate(v) && v.includes("T") && Number.isFinite(Date.parse(v));
    if ((isDate(from ?? "") || isDate(to ?? "")) && (instant(from) || instant(to))) return bad(MIXED);
    if (from === null || to === null || !isDate(from) || !isDate(to) || from > to) return bad(WINDOW);
  }

  const compare = q.compare ?? null;
  if (compare !== null && compare !== "previous") return bad("compare must be previous, or left out");
  if (compare !== null && m.stock) return bad(`${measure} is a stock, counted as of the window's end: a stock has no window before`);

  const where: [string, string | null][] = [];
  const asked = query.where === undefined ? [] : Array.isArray(query.where) ? query.where : [query.where];
  for (const w of asked) {
    const filter = typeof w === "string" ? /^([a-z_]+)=(.*)$/.exec(w) : null;
    if (!filter) return bad("each where is a dimension, an equals sign and a value");
    const [, k, v] = filter;
    // A team is the superadmin's dimension wherever it is named, a measure that has none included.
    if (k === "team" && !who.superadmin) return REFUSED;
    if (!dims.includes(k)) return bad(dims.length ? `${measure} is filtered by one of ${dims.join(", ")}` : `${measure} takes no filter`);
    if (m.dims[k].superadmin && !who.superadmin) return REFUSED;
    where.push([k, v === "" ? null : v]);
  }
  if (where.length > FILTERS) return bad(`where takes at most ${FILTERS} filters`);

  const group = q.group;
  if (group !== undefined && by === null) return bad("group names a group of by: give by with it");
  if (q.rows !== undefined && (group !== undefined || q.limit !== undefined || q.offset !== undefined)) {
    return bad("rows is the newest of the window's rows, so it is given without group, limit or offset");
  }
  if ((group !== undefined || q.rows !== undefined) && m.notDrilled) return bad(m.notDrilled);
  if ((group !== undefined || q.rows !== undefined) && m.drillSuperadmin && !who.superadmin) return REFUSED;
  if (group !== undefined && bucket !== null && !isBucketKey(group, bucket)) {
    return bad(`group must be a ${bucket} of the window, as by=${bucket} keys it`);
  }

  const rows = whole(q.rows, 1, 20, 0), top = whole(q.top, 1, 50, 20), limit = whole(q.limit, 1, 20, 10);
  const offset = whole(q.offset, 0, Number.MAX_SAFE_INTEGER, 0);
  if (Number.isNaN(rows)) return bad("rows must be a whole number from 1 to 20");
  if (Number.isNaN(top)) return bad("top must be a whole number from 1 to 50");
  if (Number.isNaN(limit) || Number.isNaN(offset)) return bad("limit must be a whole number from 1 to 20, and offset one from 0");

  return {
    measure, m, by, bucket, from, to, compare: compare !== null, where,
    group: group === undefined ? undefined : group === "" && bucket === null ? null : group,
    rows: q.rows === undefined ? null : rows, top, limit, offset,
  };
}

/** The question answered over the window `[from, to]` of dates, at the cutoff. */
async function platformQuery(a: Asked, c: Ctx, asked: { from: string | null; to: string }): Promise<PlatformQuery> {
  const { m, by, bucket } = a;
  const who = c.who;
  let from = asked.from ?? asked.to;
  const to = asked.to;
  const keep = (f: Fact): boolean => a.where.every(([k, v]) => f.keys[k] === v);
  // A local day's bucket, read once a day: the calendar keys an instant, the facts their days.
  const buckets = new Map<string, string>();
  const bucketOfDay = (day: string, b: Bucket): string => {
    if (!buckets.has(day)) buckets.set(day, bucketOf(b, midnight(day)));
    return buckets.get(day)!;
  };
  const keyOf = (f: Fact): string | null => (bucket ? bucketOfDay(f.day, bucket) : by === null ? null : f.keys[by]);
  const drilled = a.group !== undefined || a.rows !== null;

  let now: Fact[], then: Fact[] = [];
  let failed = false;
  try {
    const read = await m.facts(c, { from: asked.from, to });
    // From the first recorded day: the earliest day the measure counts, whatever the filters keep.
    if (asked.from === null) from = read.reduce((d, f) => (f.day < d ? f.day : d), to);
    now = read.filter(keep);
    if (a.compare) {
      const length = daysBetween(from, to);
      then = (await m.facts(c, { from: addDays(from, -length), to: addDays(from, -1) })).filter(keep);
    }
  } catch (err) {
    console.error(`console platform query: ${a.measure} could not be read:`, err);
    now = [];
    failed = true;
  }

  const fromMs = midnight(from), toMs = midnight(addDays(to, 1));
  const window = {
    from: iso(fromMs), to: iso(toMs), observedFrom: iso(fromMs),
    observedThrough: iso(Math.max(fromMs, Math.min(toMs, c.asOfMs))), complete: toMs <= c.asOfMs,
  };
  const meta: PlatformQuery["meta"] = {
    asOf: c.asOf, timezone: ZZ_TZ, period: { from: window.from, to: window.to },
    scope: who.superadmin ? "platform-admin" : "platform-public", population: a.m.population,
    coverageFrom: asked.from === null && now.length ? window.from : null,
  };
  if (failed) {
    return {
      meta, measure: a.measure, by, window, groups: [], rest: null, total: UNREAD,
      rows: drilled ? { state: "unavailable", reason: "query_failed" } : null,
    };
  }

  const total = sum(now);
  const group = (key: string | null, label: string, value: number, previous: PlatformQueryFigure | null): PlatformQueryGroup =>
    ({ key, label, value: counted(value), share: total ? value / total : null, previous });
  let groups: PlatformQueryGroup[] = [], folded: PlatformQueryGroup[] = [];
  if (bucket) {
    // The buckets the window holds before its end or the cutoff, an empty one answered as zero.
    const keys = bucketsOf(bucket, fromMs, Math.min(toMs, c.asOfMs));
    const before = a.compare ? bucketsOf(bucket, midnight(addDays(from, -daysBetween(from, to))), fromMs) : [];
    const all = keys.map((key, i) => {
      // A bucket's previous is the same bucket of the window before by its place in it, a weekday by its name.
      const was = bucket === "weekday" ? key : before[i];
      const previous = !a.compare ? null : was === undefined ? { value: null, why: "no_data" as const }
        : counted(sum(then.filter((f) => bucketOfDay(f.day, bucket) === was)));
      return group(key, bucketLabel(bucket, key), sum(now.filter((f) => keyOf(f) === key)), previous);
    });
    [groups, folded] = [all.slice(-a.top), all.slice(0, -a.top)];
  } else if (by !== null) {
    const d = m.dims[by];
    const keys = [...new Set<string | null>([...(d.fixed?.(who) ?? []), ...now.map(keyOf)])];
    const all = keys.map((key) => group(key, key === null ? d.none : d.label?.(key, who) ?? key,
      sum(now.filter((f) => keyOf(f) === key)), a.compare ? counted(sum(then.filter((f) => f.keys[by] === key))) : null))
      .sort((x, y) => y.value.value! - x.value.value! || (x.key === y.key ? 0 : x.key === null ? 1 : y.key === null ? -1 : x.key < y.key ? -1 : 1));
    [groups, folded] = [all.slice(0, a.top), all.slice(a.top)];
  }

  let rows: PlatformQuery["rows"] = null;
  if (drilled) {
    const kept = a.group === undefined ? now : now.filter((f) => keyOf(f) === a.group);
    try {
      const want = a.rows ?? a.offset + a.limit;
      const r = await m.rows!(c, kept, want);
      rows = { state: "ok", data: { rows: a.rows === null ? r.rows.slice(a.offset, a.offset + a.limit) : r.rows.slice(0, a.rows), total: r.total } };
    } catch (err) {
      console.error(`console platform query: ${a.measure}'s rows could not be read:`, err);
      rows = { state: "unavailable", reason: "query_failed" };
    }
  }

  return {
    meta, measure: a.measure, by, window, groups,
    rest: folded.length ? {
      groups: folded.length, value: folded.reduce((n, g) => n + g.value.value!, 0),
      previous: a.compare ? folded.reduce((n, g) => n + (g.previous?.value ?? 0), 0) : null,
    } : null,
    total: counted(total),
    rows,
  };
}

export function mountPlatformQuery(app: Express): void {
  /** One prepared question about the platform, answered as the measure's page answers the caller. */
  app.get("/api/console/platform/query", platformPublic("the platform query", async (req, res, { superadmin, activeTeam }) => {
    const who: Who = { superadmin, activeTeam };
    const asked = parse(req.query as Record<string, unknown>, who);
    if ("status" in asked) {
      res.status(asked.status).json({ error: asked.error });
      return;
    }
    const asOfMs = Math.floor(Date.now() / 1000) * 1000;
    const c: Ctx = { db: platformDb(), asOf: iso(asOfMs), asOfMs, who };
    // Each value a filter or a drilled group names, held to its dimension's vocabulary before anything is compared.
    const named: [string, string | null][] = [...asked.where, ...(asked.group !== undefined && asked.bucket === null ? [[asked.by!, asked.group] as [string, string | null]] : [])];
    for (const [k, v] of named) {
      if (v !== null && !(await asked.m.dims[k].has(c, v))) {
        res.status(400).json({ error: asked.m.dims[k].refuse(who) });
        return;
      }
    }
    // Neither bound is the last whole week: Monday to Sunday before the running one.
    const monday = bucketOf("week", asOfMs);
    const window = asked.from === null ? { from: addDays(monday, -7), to: addDays(monday, -1) }
      : { from: asked.from === ALL ? null : asked.from, to: asked.to! };
    res.json(await platformQuery(asked, c, window));
  }));
}
