/**
 * GET /api/console/knowledge/summary: the active team's knowledge shelf as of the cutoff, its own questions that
 * found nothing, and its searches by week. Every part is read at one cutoff, the read's moment rounded up to a
 * whole second, as Home rounds it.
 *
 * Work is the active team's, for the superadmin too: the team is the one the caller's identity acts for, and
 * nothing the request names widens it. The shared shelf is left out of every count here; the list and the log
 * leave it out too.
 *
 * The parts, each from one function:
 *
 *   tiles      the team's standing lessons by lifecycle as of the cutoff, the imported among them by
 *              lessonImports; its superseded lessons; and of the last whole week, its searches and those that
 *              found nothing, both read off searchesWithResults' denominator and numerator
 *   questions  the team's own real-work searches that found nothing over the weeks drawn, by the question
 *              normalised for case and spacing, most asked first then the latest asked, ten with their total
 *   weeks      searchesWithResults by week over the weeks drawn, the running week not complete
 *   newest     the team's five most recently made lessons, each said imported or not
 *
 * The weeks drawn are those from the week of the team's first search, the newest 24 whole weeks at most and the
 * running week. A search is a real-work knowledge.search event carrying detail.returned; one whose returned list is
 * empty found nothing. A search that found something is retrieval coverage, never an answer to the question.
 *
 * A question's text is answered only to the team that asked it: every statement here names the team.
 *
 * Each part fails alone: what it is read from failing makes it unavailable, or its figure null with why
 * unavailable, and the rest stands. Never a zero for a count that was not read.
 *
 * DELIBERATE: no backticks in the comments of this file. check:sql reads it as text, and a backtick in a comment
 * opens a template literal it then parses as code.
 *
 * COUPLED: the console's KnowledgeSummary in src/lib/destination-shapes.ts, and its fake answer in
 * ../zz-stack-dashboard/scripts/fake-gateway/work-knowledge.ts, which checks/console-work-knowledge.ts compares this route's answer
 * with, key set by key set.
 */
import type { Express } from "express";

import { platformDb } from "../db.js";
import type { Figure, Part, PeriodFigure, ReadMeta, Window } from "./figures.js";
import { lessonImports } from "./imports.js";
import { NO_TEAM, platformPublic, ZZ_TZ } from "./shared.js";
import { lastWholeWeek, periodsOf, searchesWithResults } from "./work-figures.js";

type Question = { question: string; asked: number; lastAsked: string };
type NewLesson = { team: string; path: string; title: string; kind: string; createdAt: string; imported: boolean };
type KnowledgeSummary = {
  meta: ReadMeta;
  tiles: { standing: Figure & { imported: number }; superseded: Figure; searches: PeriodFigure; noResult: PeriodFigure };
  questions: Part<{ rows: Question[]; total: number }>;
  weeks: Part<PeriodFigure[]>;
  newest: Part<NewLesson[]>;
};
/** One lesson on the team's shelf, as the shelf statement reads it. */
type Lesson = { id: string; address: string; title: string; kind: string; standing: boolean; createdMs: number };

const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;
/** The whole weeks drawn before the running one, at most. COUPLED: home.ts draws the same. */
const WHOLE_WEEKS = 24;
/** The questions answered, five of the console's pages of ten, and the newest lessons. Ten answered of a total of 13
 *  left the page with no way to the other three (the console's Work M-8). COUPLED: the console's fake answers the same. */
const QUESTIONS = 50;
const NEWEST = 5;

/** An instant as the gateway spells one: ISO 8601 in UTC, whole seconds, with the Z. */
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const unavailable = (window: Window): PeriodFigure =>
  ({ window, figure: { value: null, why: "unavailable" }, numerator: null, denominator: null });
const counted = (n: number): Figure => ({ value: n, why: null });

/** What a function answers, or null when it failed; the failure is logged under its name. */
async function attempt<T>(what: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    console.error(`console knowledge summary: ${what} could not be read:`, err);
    return null;
  }
}
const partOf = <T>(data: T | null): Part<T> => (data === null ? { state: "unavailable", reason: "query_failed" } : { state: "ok", data });

/** When the team's first real-work search was recorded before the cutoff; null with none. */
async function firstSearch(team: string, asOf: string): Promise<number | null> {
  const { rows } = await platformDb().query<{ first_ms: number | null }>(
    `select (extract(epoch from min(e.ts)) * 1000)::float8 as first_ms
       from zz.event e
       join zz.team t on t.id = e.team_id
      where t.slug = $1 and e.kind = 'knowledge.search' and e.origin = 'work' and e.detail ? 'returned'
        and e.ts < $2::timestamptz`, [team, asOf]);
  return rows[0]?.first_ms ?? null;
}

/** Every lesson on the team's shelf made before the cutoff, the most recently made first. */
async function lessonsOf(team: string, asOf: string): Promise<Lesson[]> {
  const { rows } = await platformDb().query<{ id: string; address: string; title: string; kind: string; lifecycle: string; created_ms: number }>(
    `select k.id::text as id, 'nodes/' || k.node_ordinal || '-' || k.slug || '.md' as address, k.title, k.kind, k.lifecycle,
            (extract(epoch from k.created_at) * 1000)::float8 as created_ms
       from zz.knowledge_node k
       join zz.team t on t.id = k.team_id
      where t.slug = $1 and k.created_at < $2::timestamptz
      order by k.created_at desc, k.node_ordinal desc`, [team, asOf]);
  return rows.map((r) => ({ id: r.id, address: r.address, title: r.title, kind: r.kind, standing: r.lifecycle === "adopted", createdMs: r.created_ms }));
}

/** The team's real-work searches inside the window that found nothing, by the question normalised for case and
 *  spacing: most asked first, then the latest asked, QUESTIONS of them at most, and how many such questions there are. */
async function questionsOf(team: string, window: { from: string; to: string }): Promise<{ rows: Question[]; total: number }> {
  const { rows } = await platformDb().query<{ question: string; asked: number; last_ms: number; total: number }>(
    `select q.question, count(*)::int as asked, (extract(epoch from max(q.ts)) * 1000)::float8 as last_ms,
            (count(*) over ())::int as total
       from (select lower(btrim(regexp_replace(coalesce(e.subject, ''), '\\s+', ' ', 'g'))) as question, e.ts
               from zz.event e
               join zz.team t on t.id = e.team_id
              where t.slug = $1 and e.kind = 'knowledge.search' and e.origin = 'work' and e.detail ? 'returned'
                and not (jsonb_typeof(e.detail -> 'returned') = 'array' and e.detail -> 'returned' <> '[]'::jsonb)
                and e.ts >= $2::timestamptz and e.ts < $3::timestamptz) q
      group by q.question
      order by count(*) desc, max(q.ts) desc, q.question
      limit $4`, [team, window.from, window.to, QUESTIONS]);
  return {
    rows: rows.map((r) => ({ question: r.question, asked: r.asked, lastAsked: iso(r.last_ms) })),
    total: rows[0]?.total ?? 0,
  };
}

/** Knowledge for the team at the cutoff. */
async function summaryOf(team: string, asOf: string): Promise<KnowledgeSummary> {
  const [week, firstMs] = await Promise.all([lastWholeWeek(asOf), firstSearch(team, asOf)]);
  const weekMs = Date.parse(week.from);
  // The first search's week, the last whole week at the latest and the newest WHOLE_WEEKS at most. A Monday noon
  // is the probe, so a daylight saving hour cannot carry it into the week before.
  const probe = Math.max(Math.min(firstMs ?? weekMs, weekMs), weekMs - (WHOLE_WEEKS - 1) * WEEK + 12 * HOUR);
  const startMs = (await periodsOf({ from: iso(probe), to: asOf }, asOf, "week"))[0].fromMs;
  const span = { from: iso(startMs), to: asOf };

  const [lessons, imports, weeks, questions] = await Promise.all([
    attempt("the lessons", () => lessonsOf(team, asOf)),
    attempt("the imports", () => lessonImports(asOf)),
    attempt("the searches by week", () => searchesWithResults(team, span, asOf, "week")),
    attempt("the questions that found nothing", () => questionsOf(team, span)),
  ]);
  const imported = imports && new Set(imports.lessons.filter((l) => l.shelf === team).map((l) => l.id));
  const standing = lessons?.filter((l) => l.standing);
  // The last whole week's searches: every completed search is in the denominator, those that found something in the
  // numerator, so the ones that found nothing are the difference.
  const last = weeks?.find((p) => p.window.from === week.from);
  const searched = last?.denominator ?? null;
  const empty = last && last.denominator !== null && last.numerator !== null ? last.denominator - last.numerator : null;

  return {
    meta: {
      asOf, timezone: ZZ_TZ, period: { from: span.from, to: asOf }, scope: "active-team",
      population: `${team}'s knowledge shelf and its own searches, the shared shelf left out`,
      coverageFrom: firstMs === null ? null : iso(firstMs),
    },
    tiles: {
      // The imported count belongs to the standing figure, so a shelf read without its imports is not read at all.
      standing: standing && imported
        ? { ...counted(standing.length), imported: standing.filter((l) => imported.has(l.id)).length }
        : { value: null, why: "unavailable", imported: 0 },
      superseded: lessons ? counted(lessons.filter((l) => !l.standing).length) : { value: null, why: "unavailable" },
      searches: last && searched !== null
        ? { window: last.window, figure: counted(searched), numerator: searched, denominator: null }
        : unavailable(last?.window ?? week),
      noResult: last && empty !== null
        ? { window: last.window, figure: counted(empty), numerator: empty, denominator: searched }
        : unavailable(last?.window ?? week),
    },
    questions: partOf(questions),
    weeks: partOf(weeks),
    newest: partOf(lessons && imported && lessons.slice(0, NEWEST).map((l) => ({
      team, path: l.address, title: l.title, kind: l.kind, createdAt: iso(l.createdMs), imported: imported.has(l.id),
    }))),
  };
}

export function mountKnowledgeSummary(app: Express): void {
  /** Knowledge, for the team the caller's identity acts for and no other. */
  app.get("/api/console/knowledge/summary", platformPublic("the knowledge summary", async (_req, res, { activeTeam }) => {
    if (activeTeam === null) {
      res.status(400).json({ error: NO_TEAM });
      return;
    }
    // The cutoff in whole seconds, rounded up, so what was written in the second the read began is inside it.
    res.json(await summaryOf(activeTeam, iso(Math.ceil(Date.now() / 1000) * 1000)));
  }));
}
