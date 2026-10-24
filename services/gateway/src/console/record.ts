/**
 * GET /api/console/record?period=quarter|year|all&limit&offset: the active team's retained text as of
 * the cutoff, the period's work in six slices, and the record of every initiative, with the approvals in
 * it signed in the caller's name alone. Every part is read at one cutoff, the read's moment rounded up to
 * a whole second, as Home and the Initiatives list round it.
 *
 * The period is cut on the reporting timezone's calendar: quarter from the first day of the running
 * calendar quarter, year from 1 January, all (the default) from the team's first record, which is when
 * its first initiative was opened, as Home reads it. Activity is counted over [start, cutoff), at the
 * grain grainFor draws that window at, so a year answers months. A team with no initiative has an empty
 * all. The period's start and the cutoff are the meta's period; the first record is its coverageFrom.
 * Knowledge's searches and lessons adopted and Your agents' runs, which no initiative bounds, are counted
 * from the later of the period's start and the first record, so a quarter or a year beginning before it
 * counts nothing there, as all does, and a team with no initiative counts none in any period; Knowledge
 * keeps the period's own periods.
 * When the period starts before the caller joined the team, the population says it is team history.
 *
 * Work is the active team's, for the superadmin too: nothing the request names widens it. Reading
 * Record records nothing.
 *
 * The parts, each from the functions named:
 *
 *   lead        retainedStock as of the cutoff at the stated pace (writingEstimate, basis
 *               retained_stock): the eligible words known, with the coverage of what is not beside them;
 *               the same in every period, so it is marked as of the cutoff
 *   cumulative  additionsByPeriod's running total from the period's start
 *   foot        the period's closures (closuresByWeek), the initiatives opened (openedRows), the flow
 *               documents created and the versions written (documentFacts), and callerApprovals' total
 *   work        closuresByWeek summed by outcome and by period; mostOpenAtOnce; medianHoursToClose and
 *               medianHoursToAbandon, overall for the slice and by period for the chart; closures in
 *               all, a running total over the whole record to each period's end; and a typical piece of
 *               work, over the initiatives closed in the period: the median and the largest of its flow
 *               documents, its flow documents' revisions, its sources and the words it retains, the sum
 *               of its transitions' net words (transitions), exact where no revision of it is a gap and
 *               nothing of an import-made or unrecorded document
 *   documents   documentFacts' flow documents created, versions and most rewritten documents;
 *               additionsByPeriod's words by period and coverage; the sources under each gated document
 *               created in the period, the document gated as its flow declares (flowShape, the handover
 *               left out) and its sources those whose current revision carries a supports link to it,
 *               the population Firsts and bests reads; and the citations, the distinct cites links from
 *               one of the team's documents to another first recorded in the period, a link dated by the
 *               revision that carries it, or by its document's creation when that revision has no time;
 *               a supports link is a source's bearing, counted under the gated documents, not a citation
 *   knowledge, agents, firsts   knowledgeSlice and agentsSlice over the period from its first record,
 *               and firstsSlice over the period
 *   record      every initiative opened before the cutoff, newest first, the slug breaking a tie, paged:
 *               its outcome once closed, when it opened and closed, the hours it took, its flow documents
 *               and the lessons that cite it as evidence, inventories both, imports included; the summary
 *               by outcome and by flow over all of them, never the page
 *
 * The route's body is recordOf, which the agent read record_read (console/agent-reads.ts) calls too.
 *
 * Each part fails alone: what it is read from failing makes it unavailable, its figure null with why
 * unavailable, or the lead's estimate null, and the rest stands. No figure is hours saved, a speedup or
 * a measured productivity: the estimate is the time to write the text at the stated pace.
 *
 * DELIBERATE: no backticks in the comments of this file. check:sql reads it as text, and a backtick in a
 * comment opens a template literal it then parses as code.
 *
 * COUPLED: the console's RecordRead in src/lib/work-shapes.ts, and its fake answer in
 * ../zz-stack-dashboard/scripts/fake-gateway/work-record.ts, which checks/console-work-record.ts compares this route's answer
 * with, key set by key set.
 */
import { OUTCOMES, writingEstimate, type WritingCoverage } from "@zz/contracts";
import type { Express } from "express";

import { platformDb } from "../db.js";
import { cachedWithHit, prefixFor, served } from "./answer-cache.js";
import { callerApprovals } from "./approvals.js";
import type { Figure, Part, PeriodFigure, ReadMeta } from "./figures.js";
import { localDate } from "./findings.js";
import { agentsSlice, firstsSlice, knowledgeSlice } from "./record-slices.js";
import { BAD_PAGE, flowShape, NO_TEAM, platformPublic, ZZ_TZ } from "./shared.js";
import {
  closuresByWeek, grainFor, medianHoursToAbandon, medianHoursToClose, mostOpenAtOnce, openedRows, periodsOf, type ClosureWeek,
} from "./work-figures.js";
import { additionsByPeriod, documentFacts, retainedStock, transitions } from "./writing.js";

type Span = { from: string; to: string };
export type PeriodName = "quarter" | "year" | "all";
type Outcome = (typeof OUTCOMES)[number];
type Spread = { median: Figure; largest: Figure };
type WorkSlice = {
  closedByOutcome: Record<Outcome, Figure>;
  mostOpenAtOnce: { value: Figure; at: string | null };
  medianHoursToClose: PeriodFigure; medianHoursToAbandon: PeriodFigure;
  closuresInAll: PeriodFigure[];
  closuresByWeek: ClosureWeek[];
  medianHoursByWeek: PeriodFigure[];
  typical: { documents: Spread; versions: Spread; sources: Spread; words: Spread };
};
type DocumentsSlice = {
  flowDocuments: Figure; versions: Figure; sourcesUnderGated: Spread; citations: Figure;
  wordsByWeek: PeriodFigure[];
  mostRewritten: { initiative: string; path: string; versions: number }[];
  coverage: WritingCoverage;
};
type RecordRow = { slug: string; outcome: string | null; opened: string; closed: string | null; tookHours: number | null; documents: number; lessons: number };
type RecordTable = {
  rows: RecordRow[]; total: number;
  summary: { byOutcome: { open: number } & Record<Outcome, number>; byFlow: { flow: string | null; count: number }[] };
};
export type RecordRead = {
  meta: ReadMeta;
  period: PeriodName;
  /** estimate is null when the retained text could not be read: no coverage of zeros stands in for one. */
  lead: { estimate: ReturnType<typeof writingEstimate> | null; asOf: string };
  cumulative: PeriodFigure[];
  foot: { closed: Figure; opened: Figure; documents: Figure; versions: Figure; approvalsInYourName: Figure };
  work: Part<WorkSlice>;
  documents: Part<DocumentsSlice>;
  knowledge: Part<Awaited<ReturnType<typeof knowledgeSlice>>>;
  agents: Part<Awaited<ReturnType<typeof agentsSlice>>>;
  firsts: Part<Awaited<ReturnType<typeof firstsSlice>>>;
  record: Part<RecordTable>;
};
/** One of the team's initiatives as of the cutoff, with what it holds. */
type Initiative = {
  slug: string; flow: string | null; outcome: Outcome | null; openedMs: number; closedMs: number | null;
  documents: number; versions: number; sources: number;
};

export const PERIODS: readonly PeriodName[] = ["quarter", "year", "all"];
const HOUR = 3_600_000;
/** Before every record: a window from here is the whole of it. */
const ALL_TIME = "1970-01-01T00:00:00Z";

/** An instant as the gateway spells one: ISO 8601 in UTC, whole seconds, with the Z. */
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const counted = (n: number): Figure => ({ value: n, why: null });
const unread: Figure = { value: null, why: "unavailable" };
const sum = (figures: PeriodFigure[]): number => figures.reduce((n, p) => n + (p.figure.value ?? 0), 0);

/** What a function answers, or null when it failed; the failure is logged under its name. */
async function attempt<T>(what: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    console.error(`console record: ${what} could not be read:`, err);
    return null;
  }
}
const partOf = <T>(data: T | null): Part<T> => (data === null ? { state: "unavailable", reason: "query_failed" } : { state: "ok", data });
/** Every input of a part, or null when one of them failed. */
const all = <T extends unknown[]>(...inputs: T): { [K in keyof T]: NonNullable<T[K]> } | null =>
  inputs.some((x) => x === null) ? null : (inputs as { [K in keyof T]: NonNullable<T[K]> });

/** The median and the largest of a list, no data when it is empty. */
function spread(values: number[]): Spread {
  if (!values.length) return { median: { value: null, why: "no_data" }, largest: { value: null, why: "no_data" } };
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return { median: counted(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2), largest: counted(s.at(-1)!) };
}

/** Where each period starts in the reporting timezone, when the team's first initiative was opened, and
 *  when the caller joined the team; the last two null when there is none. */
async function boundsOf(team: string, caller: string, asOf: string) {
  const { rows: [r] } = await platformDb().query<{ quarter_ms: number; year_ms: number; first_ms: number | null; joined_ms: number | null }>(
    `select (extract(epoch from (date_trunc('quarter', $2::timestamptz at time zone $3::text) at time zone $3::text)) * 1000)::float8 as quarter_ms,
            (extract(epoch from (date_trunc('year', $2::timestamptz at time zone $3::text) at time zone $3::text)) * 1000)::float8 as year_ms,
            (select (extract(epoch from min(i.opened_at)) * 1000)::float8
               from zz.initiative i join zz.team t on t.id = i.team_id
              where t.slug = $1 and i.slug <> '_knowledge' and i.opened_at < $2::timestamptz) as first_ms,
            (select (extract(epoch from min(m.created_at)) * 1000)::float8
               from zz.membership m
               join zz.team t on t.id = m.team_id
               join zz.principal p on p.id = m.principal_id
              where t.slug = $1 and lower(p.email) = lower($4)) as joined_ms`,
    [team, asOf, ZZ_TZ, caller]);
  return r;
}

/** The team's initiatives opened before the cutoff, each with its flow documents, their revisions and
 *  its sources made before it. */
async function initiativesOf(team: string, asOf: string): Promise<Initiative[]> {
  const { rows } = await platformDb().query<{
    slug: string; flow: string | null; outcome: Outcome | null; opened_ms: number; closed_ms: number | null;
    documents: number; versions: number; sources: number;
  }>(
    `select i.slug, i.flow, i.outcome,
            (extract(epoch from i.opened_at) * 1000)::float8 as opened_ms,
            (extract(epoch from i.closed_at) * 1000)::float8 as closed_ms,
            (select count(*)::int from zz.doc d
              where d.initiative_id = i.id and d.path not like 'sources/%' and d.created_at < $2::timestamptz) as documents,
            (select count(*)::int from zz.doc d join zz.doc_revision r on r.doc_id = d.id
              where d.initiative_id = i.id and d.path not like 'sources/%' and d.created_at < $2::timestamptz
                and (r.written_at is null or r.written_at < $2::timestamptz)) as versions,
            (select count(*)::int from zz.doc d
              where d.initiative_id = i.id and d.path like 'sources/%' and d.created_at < $2::timestamptz) as sources
       from zz.initiative i
       join zz.team t on t.id = i.team_id
      where t.slug = $1 and i.slug <> '_knowledge' and i.opened_at < $2::timestamptz`, [team, asOf]);
  const asOfMs = Date.parse(asOf);
  return rows.map((r) => {
    const closed = r.closed_ms !== null && r.closed_ms < asOfMs;
    return {
      slug: r.slug, flow: r.flow, outcome: closed ? r.outcome : null, openedMs: r.opened_ms, closedMs: closed ? r.closed_ms : null,
      documents: r.documents, versions: r.versions, sources: r.sources,
    };
  });
}

/** The lessons made before the cutoff that cite each of the team's initiatives as evidence. */
async function lessonsByInitiative(team: string, asOf: string): Promise<Map<string, number>> {
  const { rows } = await platformDb().query<{ slug: string; lessons: number }>(
    `select i.slug, count(distinct n.id)::int as lessons
       from zz.knowledge_node_evidence e
       join zz.knowledge_node n on n.id = e.node_id
       join zz.initiative i on i.id = e.initiative_id
       join zz.team t on t.id = i.team_id
      where t.slug = $1 and n.created_at < $2::timestamptz
      group by i.slug`, [team, asOf]);
  return new Map(rows.map((r) => [r.slug, r.lessons]));
}

/** Each of the team's flow documents created inside the window under a flow, with the sources whose
 *  current revision supports it; only those its flow gates, the handover left out. */
async function sourcesUnderGated(team: string, window: Span): Promise<number[]> {
  const { rows } = await platformDb().query<{ flow: string; path: string; sources: number }>(
    `select i.flow, d.path,
            (select count(distinct s.id)::int
               from zz.doc_link l
               join zz.doc s on s.id = l.from_doc_id and l.from_revision = s.current_revision
              where l.to_doc_id = d.id and l.kind = 'supports' and s.path like 'sources/%'
                and s.created_at < $3::timestamptz) as sources
       from zz.doc d
       join zz.initiative i on i.id = d.initiative_id
       join zz.team t on t.id = i.team_id
      where t.slug = $1 and i.slug <> '_knowledge' and i.flow is not null and d.path not like 'sources/%'
        and d.created_at >= $2::timestamptz and d.created_at < $3::timestamptz`, [team, window.from, window.to]);
  return rows.filter((r) => {
    const shape = flowShape(r.flow).get(r.path);
    return shape?.gate === true && shape.role !== "handover";
  }).map((r) => r.sources);
}

/** The distinct citations, cites links from one of the team's documents to another, first recorded
 *  inside the window, each dated by its earliest revision carrying it. */
async function citationsIn(team: string, window: Span): Promise<number> {
  const { rows: [r] } = await platformDb().query<{ n: number }>(
    `select count(*)::int as n
       from (select min(coalesce(r.written_at, f.created_at)) as first_at
               from zz.doc_link l
               join zz.doc f on f.id = l.from_doc_id
               join zz.initiative i on i.id = f.initiative_id
               join zz.team t on t.id = i.team_id
               left join zz.doc_revision r on r.doc_id = l.from_doc_id and r.revision = l.from_revision
              where t.slug = $1 and i.slug <> '_knowledge' and l.kind = 'cites'
              group by l.from_doc_id, l.to_doc_id) c
      where c.first_at >= $2::timestamptz and c.first_at < $3::timestamptz`, [team, window.from, window.to]);
  return r.n;
}

/** The net words each initiative retains in its eligible flow documents as of the cutoff. */
async function wordsByInitiative(team: string, asOf: string): Promise<Map<string, number>> {
  const words = new Map<string, number>();
  for (const t of await transitions(team, { from: ALL_TIME, to: asOf }, asOf)) {
    words.set(t.initiative, (words.get(t.initiative) ?? 0) + t.added - t.removed);
  }
  return words;
}

/** The record table: every initiative newest first, the slug breaking a tie, one page of it. */
function tableOf(initiatives: Initiative[], lessons: Map<string, number>, page: { limit: number; offset: number }): RecordTable {
  const rows = [...initiatives].sort((a, b) => b.openedMs - a.openedMs || a.slug.localeCompare(b.slug));
  const flows = [...new Set(rows.map((r) => r.flow))];
  return {
    rows: rows.slice(page.offset, page.offset + page.limit).map((r) => ({
      slug: r.slug, outcome: r.outcome, opened: iso(r.openedMs), closed: r.closedMs === null ? null : iso(r.closedMs),
      tookHours: r.closedMs === null ? null : (r.closedMs - r.openedMs) / HOUR, documents: r.documents, lessons: lessons.get(r.slug) ?? 0,
    })),
    total: rows.length,
    summary: {
      byOutcome: {
        open: rows.filter((r) => r.outcome === null).length,
        ...(Object.fromEntries(OUTCOMES.map((o) => [o, rows.filter((r) => r.outcome === o).length])) as Record<Outcome, number>),
      },
      byFlow: flows.map((flow) => ({ flow, count: rows.filter((r) => r.flow === flow).length }))
        .sort((a, b) => b.count - a.count || Number(a.flow === null) - Number(b.flow === null) || String(a.flow).localeCompare(String(b.flow))),
    },
  };
}

/** Record for the team over the period at the cutoff, the approvals in it the caller's; its table paged. */
export async function recordOf(team: string, caller: string, period: PeriodName, page: { limit: number; offset: number }, asOf: string): Promise<RecordRead> {
  const bounds = await boundsOf(team, caller, asOf);
  const asOfMs = Date.parse(asOf);
  const startMs = period === "quarter" ? bounds.quarter_ms : period === "year" ? bounds.year_ms : bounds.first_ms ?? asOfMs;
  const window: Span = { from: iso(startMs), to: asOf };
  // What no initiative bounds is counted from the first record on: none at all for a team with no initiative.
  const since: Span = { from: iso(bounds.first_ms === null ? asOfMs : Math.max(startMs, bounds.first_ms)), to: asOf };
  const grain = grainFor(window);

  const [periods, stock, words, facts, mine, closures, toClose, toAbandon, open, opened, initiatives, lessons, gated, citations, retained,
         knowledge, agents, firsts] = await Promise.all([
    periodsOf(window, asOf, grain),
    attempt("the retained text", () => retainedStock(team, asOf)),
    attempt("the words added", () => additionsByPeriod(team, window, asOf)),
    attempt("the documents and versions", () => documentFacts(team, window, asOf)),
    attempt("the caller's approvals", () => callerApprovals(team, caller, window, asOf, grain)),
    attempt("the closures", () => closuresByWeek(team, window, asOf, grain)),
    attempt("the median hours to close", () => medianHoursToClose(team, window, asOf, grain)),
    attempt("the median hours to abandon", () => medianHoursToAbandon(team, window, asOf, grain)),
    attempt("the most open at once", () => mostOpenAtOnce(team, window, asOf)),
    attempt("the initiatives opened", () => openedRows(team, window, asOf)),
    attempt("the initiatives", () => initiativesOf(team, asOf)),
    attempt("the lessons by initiative", () => lessonsByInitiative(team, asOf)),
    attempt("the sources under gated documents", () => sourcesUnderGated(team, window)),
    attempt("the citations", () => citationsIn(team, window)),
    attempt("the words each initiative retains", () => wordsByInitiative(team, asOf)),
    attempt("the Knowledge slice", () => knowledgeSlice(team, window, asOf, since.from)),
    attempt("the Your agents slice", () => agentsSlice(team, since, asOf)),
    attempt("the Firsts and bests slice", () => firstsSlice(team, window, asOf)),
  ]);

  const byOutcome = closures && (Object.fromEntries(OUTCOMES.map((o) => [o, closures.reduce((n, w) => n + (w[o].value ?? 0), 0)])) as Record<Outcome, number>);
  const closedIn = byOutcome && OUTCOMES.reduce((n, o) => n + byOutcome[o], 0);
  const documents = facts && sum(facts.documentsCreated);

  const work = all(closures, toClose, toAbandon, open, initiatives, retained);
  const docs = all(facts, words, gated, citations);
  const joined = bounds.joined_ms;
  return {
    meta: {
      asOf, timezone: ZZ_TZ, period: { from: window.from, to: asOf }, scope: "caller-in-active-team",
      population: joined === null || joined > startMs
        ? `${team}'s team history${joined === null ? "" : `, from before the caller joined on ${localDate(iso(joined), ZZ_TZ)}`}, and the approvals signed in the caller's name there`
        : `${team}'s record since the caller joined, and the approvals signed in the caller's name there`,
      coverageFrom: bounds.first_ms === null ? null : iso(bounds.first_ms),
    },
    period,
    lead: { estimate: stock && writingEstimate(stock.words, "retained_stock", stock.coverage), asOf },
    cumulative: words?.cumulative ?? periods.map((p) => ({ window: p.window, figure: unread, numerator: null, denominator: null })),
    foot: {
      closed: closedIn === null ? unread : counted(closedIn),
      opened: opened ? counted(opened.length) : unread,
      documents: documents === null ? unread : counted(documents),
      versions: facts ? counted(facts.versions) : unread,
      approvalsInYourName: mine ? counted(mine.total) : unread,
    },
    work: partOf(work && ((): WorkSlice => {
      const [weeks, close, abandon, most, made, held] = work;
      const closedBefore = (ms: number) => made.filter((i) => i.closedMs !== null && i.closedMs < ms).length;
      const done = made.filter((i) => i.closedMs !== null && i.closedMs >= startMs);
      return {
        closedByOutcome: Object.fromEntries(OUTCOMES.map((o) => [o, counted(byOutcome![o])])) as Record<Outcome, Figure>,
        mostOpenAtOnce: most,
        medianHoursToClose: close.overall, medianHoursToAbandon: abandon.overall,
        closuresInAll: periods.map((p) => {
          const n = closedBefore(Math.min(p.toMs, asOfMs));
          return { window: p.window, figure: counted(n), numerator: n, denominator: null };
        }),
        closuresByWeek: weeks,
        medianHoursByWeek: close.periods,
        typical: {
          documents: spread(done.map((i) => i.documents)), versions: spread(done.map((i) => i.versions)),
          sources: spread(done.map((i) => i.sources)), words: spread(done.map((i) => held.get(i.slug) ?? 0)),
        },
      };
    })()),
    documents: partOf(docs && ((): DocumentsSlice => {
      const [f, w, g, c] = docs;
      return {
        flowDocuments: counted(sum(f.documentsCreated)), versions: counted(f.versions), sourcesUnderGated: spread(g), citations: counted(c),
        wordsByWeek: w.periods, mostRewritten: f.mostRewritten, coverage: w.coverage,
      };
    })()),
    knowledge: partOf(knowledge),
    agents: partOf(agents),
    firsts: partOf(firsts),
    record: partOf(initiatives && lessons && tableOf(initiatives, lessons, page)),
  };
}

/** The period and the page, each given at most once, or the sentence a 400 says. */
function recordParams(query: Record<string, unknown>): { period: PeriodName; limit: number; offset: number } | string {
  for (const name of ["period", "limit", "offset"]) {
    if (query[name] !== undefined && typeof query[name] !== "string") return "the period and the page are given at most once";
  }
  const period = (query.period as string | undefined) ?? "all";
  if (!PERIODS.includes(period as PeriodName)) return `period must be one of ${PERIODS.join(", ")}`;
  const limit = Number(query.limit ?? 10), offset = Number(query.offset ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) return BAD_PAGE;
  return { period: period as PeriodName, limit, offset };
}

export function mountRecord(app: Express): void {
  /** Record, for the team the caller's identity acts for and no other, the approvals the caller's own. */
  app.get("/api/console/record", platformPublic("the record", async (req, res, { activeTeam }) => {
    if (activeTeam === null) {
      res.status(400).json({ error: NO_TEAM });
      return;
    }
    const params = recordParams(req.query as Record<string, unknown>);
    if (typeof params === "string") { res.status(400).json({ error: params }); return; }
    // The cutoff in whole seconds, rounded up, so what was written in the second the read began is inside it.
    // DELIBERATE: kept as one answer per caller, team, period and page until a write moves the marker of what it
    // reads (answer-cache.ts). The email stays in the key because the answer itself uses it: the approvals are the
    // ones signed in the caller's own name. The record is the whole history reduced by week; re-reading it between
    // two clicks that changed nothing was most of the page's time.
    res.json(served(await cachedWithHit(`record|${activeTeam}|${req.zzIdentity!.email}|${JSON.stringify(params)}`, () =>
      recordOf(activeTeam, req.zzIdentity!.email, params.period, params, iso(Math.ceil(Date.now() / 1000) * 1000)),
      prefixFor("/api/console/record", req.zzIdentity!, req))));
  }));
}
