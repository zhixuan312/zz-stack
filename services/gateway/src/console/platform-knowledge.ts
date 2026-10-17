/**
 * /api/console/platform/knowledge — the knowledge store's health: what stands on each shelf, what was made week by
 * week with the imports told apart, how the searches went, and, for the superadmin alone, the questions that found
 * nothing.
 *
 * The parts:
 *
 *   tiles     the standing lessons on every shelf, imports included; the lessons made outside the import cohorts, the
 *             searches and the share of them that found nothing, each in the last complete week and the one before
 *   shelves   per shelf: its standing lessons, those superseded, those imported (whatever their lifecycle), its
 *             lessons made last week outside the cohorts, and its team's searches last week with the share that found
 *             nothing. The superadmin's rows are every team by slug, their own active team `own`, the shared shelf
 *             `shared` and the totals `all`; a member's are their own shelf as `own`, the shared shelf as `shared`
 *             and the totals as `all`, and name no team
 *   made      lessons by the local week of their `created_at`, outside the import cohorts, each week saying how many it
 *             left out exactly and by the day rule; `exactFrom` the first `knowledge.add` event that names its lesson
 *   searches  zz-core's work `knowledge.search` rows by week: the share with no result (an empty `detail.returned`) and
 *             the share widened, both from the status read's `searchesMeasure`, and the mean results
 *   cohorts   lessons by the week made, imports included, how many are superseded now (nothing records when), how
 *             many are imported and on what basis: `by_day` when any of them rests on the day rule, otherwise `exact`
 *   byKind    the standing lessons by kind, most first
 *   questions the superadmin's alone, null for a member: the subjects of work searches that found nothing over the
 *             weeks drawn, by question and the slug of the team that asked, most asked first, ten, with the total
 *
 * Weeks are the status read's (`readGrid`), the last 26 of them, the running one included and not complete. Imports are
 * told by `lessonImports` (console/imports.ts), the one rule; an import stays in every inventory and in its cohort,
 * and is in no week's lessons made. A share of searches stands on 30 in a week and is `insufficient` below it. Neither
 * more lessons nor fewer searches is called better: no part here is judged.
 *
 * A part whose statement fails is `unavailable` and the others stand: the lessons or the import rule failing takes the
 * tiles, the shelves, the lessons made and the cohorts with it, the lessons alone also the kinds; the searches failing
 * the tiles, the shelves and the searches. A failure to read the cutoff and the weeks is the whole response's.
 *
 * Public by route: mounted through `platformPublic`, it reads no team or scope from the request; a member's own shelf
 * is their active team as the identity resolved it. DELIBERATE: the one statement that selects a search's subject is
 * `readQuestions`, and only the superadmin's reads call it, this one's and the Platform prepared query's drill of the
 * searches, so a member's read selects no question at all.
 *
 * COUPLED: the console's `KnowledgeHealth` in src/lib/fleet-shapes.ts, and its fake answer in
 * ../zz-stack-dashboard/scripts/fake-gateway/platform-knowledge.ts, which `checks/console-platform-knowledge.ts` compares this route's
 * answer with, key set by key set.
 */
import type { Express } from "express";
import type pg from "pg";

import { platformDb } from "../db.js";
import { PLATFORM_TEAM } from "../identity.js";
import type { Figure, Part, PeriodFigure, ReadMeta, Window } from "./figures.js";
import { lessonImports } from "./imports.js";
import { readGrid, searchDays, searchesMeasure, type Grid } from "./platform-measures.js";
import { platformPublic, ZZ_TZ } from "./shared.js";

const POPULATION = "standing lessons on every shelf, imports included; lessons made outside import cohorts; real-work searches";
/** How many weeks the charts and the questions reach back, the running one included. */
const WEEKS = 26;
/** How many questions the superadmin is shown. */
const QUESTIONS = 10;
/** A weekly share of searches stands on this many; fewer are `insufficient`. COUPLED: platform-measures.ts's own. */
const MIN_SAMPLES = 30;
/** Every kind a lesson may have. COUPLED: the CHECK on zz.knowledge_node.kind. */
export const KINDS = ["decision", "design", "process", "knowledge", "behavior", "style"] as const;

/** An instant as the gateway spells one: ISO 8601 in UTC, whole seconds, with the Z. */
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

type Week = { fromMs: number; toMs: number };
type Basis = "exact" | "by_day";
type ShelfKind = "own" | "shared" | "team" | "all";
type ShelfRow = {
  shelf: string; kind: ShelfKind; standing: number; superseded: number; imported: number;
  madeLastWeek: number; searchesLastWeek: number; noResult: PeriodFigure;
};
export type Question = { question: string; shelf: string; asked: number; lastAskedAt: string };
type KnowledgeHealth = {
  meta: ReadMeta;
  tiles: Part<{
    standing: number;
    madeLastWeek: { last: PeriodFigure; previous: PeriodFigure };
    searches: { last: PeriodFigure; previous: PeriodFigure };
    noResult: { last: PeriodFigure; previous: PeriodFigure };
  }>;
  shelves: Part<{ rows: ShelfRow[] }>;
  made: Part<{ exactFrom: string | null; weeks: { window: Window; made: Figure; importedExact: number; importedByDay: number }[] }>;
  searches: Part<{ weeks: { window: Window; noResult: PeriodFigure; widened: PeriodFigure; meanResults: Figure }[] }>;
  cohorts: Part<{ rows: { window: Window; made: number; supersededSince: number; imported: number; basis: Basis | null }[] }>;
  byKind: Part<{ kind: string; standing: number }[]>;
  questions: Part<{ window: Window; rows: Question[]; total: number }> | null;
};

/** One lesson as the read counts it: its shelf's slug, its kind, whether it stands, the week it was made in (the instant
 *  that week starts), and the local day and instant it was made. */
export type Lesson = { id: string; shelf: string; kind: string; standing: boolean; fromMs: number; day: string; createdMs: number };
/** Work searches carrying `detail.returned`, by week and the slug of the team that made them (null for none). */
type SearchCount = { fromMs: number; shelf: string | null; searches: number; empty: number; results: number };

/** The two complete weeks before the running one, the earlier first, cut on local wall time as `readGrid` cuts. */
async function readLastTwo(db: pg.Pool, asOf: string): Promise<[Week, Week]> {
  const { rows } = await db.query<{ from_ms: number; to_ms: number }>(
    `select (extract(epoch from (w at time zone $1::text)) * 1000)::float8 as from_ms,
            (extract(epoch from ((w + interval '1 week') at time zone $1::text)) * 1000)::float8 as to_ms
       from generate_series(date_trunc('week', $2::timestamptz at time zone $1::text) - interval '2 weeks',
                            date_trunc('week', $2::timestamptz at time zone $1::text) - interval '1 week',
                            interval '1 week') as w
      order by w`, [ZZ_TZ, asOf]);
  return [{ fromMs: rows[0].from_ms, toMs: rows[0].to_ms }, { fromMs: rows[1].from_ms, toMs: rows[1].to_ms }];
}

/** Every lesson made before `asOf`, and the instant of the first `knowledge.add` event that names its lesson. */
export async function readLessons(db: pg.Pool, asOf: string): Promise<{ lessons: Lesson[]; exactFromMs: number | null }> {
  const { rows } = await db.query<{ id: string; shelf: string; kind: string; lifecycle: string; from_ms: number; day: string; created_ms: number }>(
    `select n.id::text as id, t.slug as shelf, n.kind, n.lifecycle,
            (extract(epoch from (date_trunc('week', n.created_at at time zone $1::text) at time zone $1::text)) * 1000)::float8 as from_ms,
            to_char(n.created_at at time zone $1::text, 'YYYY-MM-DD') as day,
            (extract(epoch from n.created_at) * 1000)::float8 as created_ms
       from zz.knowledge_node n
       join zz.team t on t.id = n.team_id
      where n.created_at < $2::timestamptz`, [ZZ_TZ, asOf]);
  const first = (await db.query<{ first_ms: number | null }>(
    `select (extract(epoch from min(e.ts)) * 1000)::float8 as first_ms
       from zz.event e
      where e.kind = 'knowledge.add' and e.detail -> 'ids' ->> 'node' is not null and e.ts < $1::timestamptz`, [asOf])).rows[0];
  return {
    lessons: rows.map((r) => ({
      id: r.id, shelf: r.shelf, kind: r.kind, standing: r.lifecycle === "adopted", fromMs: r.from_ms, day: r.day, createdMs: r.created_ms,
    })),
    exactFromMs: first.first_ms,
  };
}

/** Work searches carrying `detail.returned` from `fromMs`, by week and team: how many, how many found nothing, and
 *  how many results they found in all, as `searchDays` counts them. */
async function readSearches(db: pg.Pool, fromMs: number, asOf: string): Promise<SearchCount[]> {
  const out = new Map<string, SearchCount>();
  for (const d of await searchDays(db, asOf, new Date(fromMs).toISOString())) {
    const at = `${d.week_ms}/${d.team ?? ""}`;
    const was = out.get(at) ?? { fromMs: d.week_ms, shelf: d.team, searches: 0, empty: 0, results: 0 };
    out.set(at, { ...was, searches: was.searches + d.searches, empty: was.empty + (d.found ? 0 : d.searches), results: was.results + d.results });
  }
  return [...out.values()];
}

/** The superadmin's alone: the work searches in `[fromMs, toMs)` that found nothing, by question and the slug of the
 *  team that asked, most asked first, then the latest asked, at most `limit` of them (null for every one), and how
 *  many such groups there are. `widened`, when given, keeps the searches the engine widened (`widened`), those it
 *  did not (`not_widened`) or those that recorded neither (the empty string). */
export async function readQuestions(db: pg.Pool, fromMs: number, toMs: number, limit: number | null, widened: string | null = null):
  Promise<{ rows: Question[]; total: number }> {
  const { rows } = await db.query<{ question: string; shelf: string; asked: number; last_ms: number; total: number }>(
    `select e.subject as question, t.slug as shelf, count(*)::int as asked,
            (extract(epoch from max(e.ts)) * 1000)::float8 as last_ms,
            (count(*) over ())::int as total
       from zz.event e
       join zz.team t on t.id = e.team_id
      where e.kind = 'knowledge.search' and e.origin = 'work' and e.detail -> 'returned' = '[]'::jsonb
        and e.ts >= $1::timestamptz and e.ts < $2::timestamptz
        and ($4::text is null or coalesce(case when e.detail ? 'broadened'
              then case when e.detail ->> 'broadened' = 'true' then 'widened' else 'not_widened' end end, '') = $4::text)
      group by e.subject, t.slug
      order by count(*) desc, max(e.ts) desc, e.subject, t.slug
      limit $3`, [new Date(fromMs).toISOString(), new Date(toMs).toISOString(), limit, widened]);
  return {
    rows: rows.map((r) => ({ question: r.question, shelf: r.shelf, asked: r.asked, lastAskedAt: iso(r.last_ms) })),
    total: rows[0]?.total ?? 0,
  };
}

/** Every team's slug, for the superadmin's shelves. */
export async function readSlugs(db: pg.Pool): Promise<string[]> {
  return (await db.query<{ slug: string }>("select t.slug from zz.team t order by t.slug")).rows.map((r) => r.slug);
}

/** A reading, or null when it failed; the failure is logged under `what`. */
const orNull = <T>(what: string, read: Promise<T>): Promise<T | null> => read.catch((err: unknown) => {
  console.error(`console the knowledge store's health: ${what} could not be read:`, err);
  return null;
});

/** A week's window, as `platform-measures.ts` bounds one: observed from where the record begins through the cutoff,
 *  and complete once it has ended and lies wholly inside the record. A week before the record was never observed. */
function windowOf(w: Week, { asOfMs, coverageMs }: Grid): Window {
  const observed = coverageMs !== null && w.toMs > coverageMs;
  return {
    from: iso(w.fromMs), to: iso(w.toMs),
    observedFrom: observed ? iso(Math.max(w.fromMs, coverageMs)) : null,
    observedThrough: observed ? iso(Math.min(w.toMs, asOfMs)) : null,
    complete: observed && w.toMs <= asOfMs && w.fromMs >= coverageMs,
  };
}

const unavailable = (window: Window): PeriodFigure => ({ window, figure: { value: null, why: "unavailable" }, numerator: null, denominator: null });
const tally = (window: Window, n: number): PeriodFigure => ({ window, figure: { value: n, why: null }, numerator: n, denominator: null });
/** A share of searches in percent: no share without a search, and under `MIN_SAMPLES` kept as insufficient. */
const share = (window: Window, n: number, d: number): PeriodFigure => ({
  window, numerator: n, denominator: d,
  figure: d === 0 ? { value: null, why: "no_data" } : { value: (100 * n) / d, why: d < MIN_SAMPLES ? "insufficient" : null },
});

/** The searches measure's week as the share that found nothing, or unavailable where it was not counted. */
const noResultOf = (w: PeriodFigure): PeriodFigure => (w.figure.why === "unavailable" || w.denominator === null
  ? unavailable(w.window) : share(w.window, w.denominator - (w.numerator ?? 0), w.denominator));

/** Lessons and searches counted for one shelf, or the totals when `shelf` is null. */
function shelfRow(name: string, kind: ShelfKind, shelf: string | null, lessons: Lesson[], basis: Map<string, Basis>,
                  counts: SearchCount[], last: PeriodFigure): ShelfRow {
  const mine = lessons.filter((l) => shelf === null || l.shelf === shelf);
  const searched = counts.filter((c) => c.fromMs === Date.parse(last.window.from) && (shelf === null || c.shelf === shelf));
  const searches = searched.reduce((n, c) => n + c.searches, 0);
  return {
    shelf: name, kind,
    standing: mine.filter((l) => l.standing).length,
    superseded: mine.filter((l) => !l.standing).length,
    imported: mine.filter((l) => basis.has(l.id)).length,
    madeLastWeek: mine.filter((l) => l.fromMs === Date.parse(last.window.from) && !basis.has(l.id)).length,
    searchesLastWeek: searches,
    noResult: last.figure.why === "unavailable" ? unavailable(last.window) : share(last.window, searched.reduce((n, c) => n + c.empty, 0), searches),
  };
}

export function mountPlatformKnowledge(app: Express): void {
  app.get("/api/console/platform/knowledge", platformPublic("the knowledge store's health", async (_req, res, { superadmin, activeTeam }) => {
    const db = platformDb();
    const grid = await readGrid(db);
    const asOf = iso(grid.asOfMs);
    const drawn = grid.weeks.slice(-WEEKS);
    const [previous, last] = await readLastTwo(db, asOf);
    const fromMs = drawn[0]?.fromMs ?? grid.asOfMs;
    const [read, imports, measure, counts, slugs, questions] = await Promise.all([
      orNull("the lessons", readLessons(db, asOf)),
      orNull("the imports", lessonImports(asOf)),
      orNull("the searches", searchesMeasure(db, { ...grid, weeks: drawn })),
      orNull("the searches by shelf", readSearches(db, Math.min(fromMs, previous.fromMs), asOf)),
      superadmin ? orNull("the shelves", readSlugs(db)) : Promise.resolve([]),
      superadmin ? orNull("the questions", readQuestions(db, fromMs, grid.asOfMs, QUESTIONS)) : Promise.resolve(null),
    ]);

    const failed = { state: "unavailable", reason: "query_failed" } as const;
    const lessons = read?.lessons ?? null;
    const basis = imports === null ? null : new Map(imports.lessons.map((l) => [l.id, l.basis]));
    // The searches measure's weeks, keyed by the instant each starts; a week it did not count is unavailable.
    const measured = new Map((measure?.weeks ?? []).map((w, i) => [Date.parse(w.window.from), { w, widened: measure!.widened![i] }]));
    const at = (w: Week): { w: PeriodFigure; widened: PeriodFigure } | null => measured.get(w.fromMs) ?? null;
    const searchesIn = (w: Week): PeriodFigure => { const m = at(w); return m === null || m.w.denominator === null ? unavailable(windowOf(w, grid)) : tally(m.w.window, m.w.denominator); };
    const noResultIn = (w: Week): PeriodFigure => { const m = at(w); return m === null ? unavailable(windowOf(w, grid)) : noResultOf(m.w); };
    const madeIn = (w: Week, of: (l: Lesson) => boolean): number => lessons!.filter((l) => l.fromMs === w.fromMs && of(l)).length;
    const outside = (l: Lesson): boolean => !basis!.has(l.id);
    const madeTile = (w: Week): PeriodFigure => { const window = windowOf(w, grid); return window.observedFrom === null ? unavailable(window) : tally(window, madeIn(w, outside)); };

    let shelves: KnowledgeHealth["shelves"] = failed;
    if (lessons !== null && basis !== null && measure !== null && counts !== null && slugs !== null) {
      const lastFigure = noResultIn(last);
      const row = (name: string, kind: ShelfKind, shelf: string | null) => shelfRow(name, kind, shelf, lessons, basis, counts, lastFigure);
      const own = activeTeam !== null && activeTeam !== PLATFORM_TEAM ? activeTeam : null;
      const rows = superadmin
        ? slugs.map((s) => row(s, s === PLATFORM_TEAM ? "shared" : s === activeTeam ? "own" : "team", s))
        : [...(own === null ? [] : [row("own", "own", own)]), row("shared", "shared", PLATFORM_TEAM)];
      shelves = { state: "ok", data: { rows: [...rows, row("all", "all", null)] } };
    }

    const answer: KnowledgeHealth = {
      meta: {
        asOf, timezone: ZZ_TZ, period: { from: drawn[0] ? iso(drawn[0].fromMs) : asOf, to: asOf },
        scope: superadmin ? "platform-admin" : "platform-public", population: POPULATION,
        coverageFrom: grid.coverageMs === null ? null : iso(grid.coverageMs),
      },
      tiles: lessons === null || basis === null || measure === null ? failed : { state: "ok", data: {
        standing: lessons.filter((l) => l.standing).length,
        madeLastWeek: { last: madeTile(last), previous: madeTile(previous) },
        searches: { last: searchesIn(last), previous: searchesIn(previous) },
        noResult: { last: noResultIn(last), previous: noResultIn(previous) },
      } },
      shelves,
      made: lessons === null || basis === null ? failed : { state: "ok", data: {
        exactFrom: read!.exactFromMs === null ? null : iso(read!.exactFromMs),
        weeks: drawn.map((w) => ({
          window: windowOf(w, grid), made: { value: madeIn(w, outside), why: null },
          importedExact: madeIn(w, (l) => basis.get(l.id) === "exact"), importedByDay: madeIn(w, (l) => basis.get(l.id) === "by_day"),
        })),
      } },
      searches: measure === null || counts === null ? failed : { state: "ok", data: { weeks: drawn.map((w) => {
        const m = at(w)!;
        const week = counts.filter((c) => c.fromMs === w.fromMs);
        const d = week.reduce((n, c) => n + c.searches, 0);
        const meanResults: Figure = m.w.figure.why === "unavailable" ? { value: null, why: "unavailable" }
          : d === 0 ? { value: null, why: "no_data" }
          : { value: week.reduce((n, c) => n + c.results, 0) / d, why: d < MIN_SAMPLES ? "insufficient" : null };
        return { window: m.w.window, noResult: noResultOf(m.w), widened: m.widened, meanResults };
      }) } },
      cohorts: lessons === null || basis === null ? failed : { state: "ok", data: { rows: drawn.map((w) => {
        const exact = madeIn(w, (l) => basis.get(l.id) === "exact"), byDay = madeIn(w, (l) => basis.get(l.id) === "by_day");
        return {
          window: windowOf(w, grid), made: madeIn(w, () => true), supersededSince: madeIn(w, (l) => !l.standing),
          imported: exact + byDay, basis: byDay > 0 ? "by_day" : exact > 0 ? "exact" : null,
        };
      }) } },
      byKind: lessons === null ? failed : { state: "ok", data: KINDS
        .map((kind) => ({ kind, standing: lessons.filter((l) => l.standing && l.kind === kind).length }))
        .sort((a, b) => b.standing - a.standing || (a.kind < b.kind ? -1 : 1)) },
      questions: !superadmin ? null : questions === null ? failed : { state: "ok", data: {
        window: drawn.length === 0
          ? { from: asOf, to: asOf, observedFrom: null, observedThrough: null, complete: false }
          : { ...windowOf(drawn[0], grid), to: iso(drawn.at(-1)!.toMs), observedThrough: asOf, complete: false },
        ...questions,
      } },
    };
    res.json(answer);
  }));
}
