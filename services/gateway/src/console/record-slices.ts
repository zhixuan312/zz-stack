/**
 * Three of Record's slices for a team, a period window and the read's cutoff: Knowledge, Your agents,
 * and Firsts and bests. Every count is over the window and before the cutoff, but the as-of stocks,
 * which are the same whatever the window: the lessons by kind, the running total of lessons adopted,
 * and the firsts.
 *
 * Knowledge.
 *   adopted             the team's lessons made inside the window outside an import cohort (lessonImports)
 *   adoptedInAll        the same over the whole record up to each period's end, a running total
 *   searches            zz-core's work knowledge.search rows carrying detail.returned, the completed
 *                       searches searchesWithResults counts, each returned entry read as
 *                       shelf:initiative/path: ownReturned the team-shelf lessons (initiative _knowledge),
 *                       sharedResults the entries from the shared shelf (shelf platform), meanResults the
 *                       entries per completed search, no data with none, and returnedByKind each entry
 *                       as a lesson, a source (a path under sources/) or a document, most first
 *   searchesWithResults searchesWithResults by period at the window's grain
 *   byKind              the standing lessons on the team's shelf as of the cutoff, imports included: an
 *                       inventory, so an import moves it and nothing a period produced
 *
 * Your agents: observedRuns over the window, each figure as it counted.
 *
 * Firsts and bests. The bests are the window's, each with the instant it was set:
 *   most_versions    the most transitions of one flow document dated inside the window (transitions),
 *                    set by the transition that reached it; a revision whose words are a gap is not one
 *   most_sources     the most sources registered inside the window supporting one flow document, its
 *                    sources those whose current revision carries a supports link to it, set when the
 *                    last of them was registered
 *   most_words_week  documentFacts' most words added in a complete week, at the week's start
 *   most_open        mostOpenAtOnce, the value Record's Work slice shows, and when it was first reached
 * A tie keeps the record set first; a best nothing set is left out. The firsts (reconciliation 34) are
 * the whole record's, the first time before the cutoff the team:
 *   closed           closed a piece of work, whatever its outcome
 *   approved         had a document approved: its earliest approval recorded as work; or, when one of its
 *                    revisions was sealed on a day before the platform recorded any approval, that day's
 *                    local midnight, which is all the seal records
 *   lesson           adopted a lesson outside an import cohort
 *   run              began an observed agent run
 *   words_week       had a week of recorded word additions, at that week's start: the week of its
 *                    earliest transition adding words, or of its first lesson outside an import cohort
 * the earliest first, a first not yet reached left out.
 *
 * A period is cut by grainFor on the reporting timezone's calendar, the running one not complete. Each
 * function throws when a statement fails; the read makes that slice unavailable and the rest stands.
 *
 * DELIBERATE: no backticks in the comments of this file. check:sql reads it as text, and a backtick in a
 * comment opens a template literal it then parses as code.
 *
 * COUPLED: the console's KnowledgeSlice, AgentsSlice and FirstsSlice in src/lib/work-shapes.ts, and the
 * fake's answer in ../zz-stack-dashboard/scripts/fake-gateway/work-record.ts.
 */
import { platformDb } from "../db.js";
import type { Figure, PeriodFigure } from "./figures.js";
import { lessonImports } from "./imports.js";
import { observedRuns } from "./runs-observed.js";
import { ZZ_TZ } from "./shared.js";
import { grainFor, mostOpenAtOnce, periodsOf, searchesWithResults } from "./work-figures.js";
import { documentFacts, transitions } from "./writing.js";

/** A window as a caller names it: two instants, the first in it and the first after it. */
type Span = { from: string; to: string };
type KnowledgeSlice = {
  adopted: Figure; adoptedInAll: PeriodFigure[]; ownReturned: Figure; meanResults: Figure; sharedResults: Figure;
  searchesWithResults: PeriodFigure[];
  returnedByKind: { kind: string; results: number }[];
  byKind: { kind: string; lessons: number }[];
};
type AgentsSlice = {
  coverageMs: Figure; summedMs: Figure; peak: Figure; runs: Figure; zeroLength: number; skillsUsed: Figure;
  weekdayHour: number[][];
  days: { day: string; runs: number }[];
  bySkill: { skill: string; runs: number }[];
};
type BestKey = "most_versions" | "most_sources" | "most_words_week" | "most_open";
type FirstKey = "closed" | "approved" | "lesson" | "run" | "words_week";
type Best = { key: BestKey; value: number; at: string; subject: string | null };
type FirstsSlice = { bests: Best[]; firsts: { key: FirstKey; at: string }[] };

/** Before every record: a window from here is the whole of it. */
const ALL_TIME = "1970-01-01T00:00:00Z";
/** An instant as the gateway spells one: ISO 8601 in UTC, whole seconds, with the Z. */
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const counted = (n: number): Figure => ({ value: n, why: null });
/** The instants a window counts from and up to: inside it and before the cutoff. */
const boundsOf = (window: Span, asOf: string): [number, number] =>
  [Date.parse(window.from), Math.min(Date.parse(window.to), Date.parse(asOf))];

/** The lessons on the team's shelf made before the cutoff: their kind, whether they stand, when each was
 *  made, and whether an import cohort holds it. */
async function lessonsOf(team: string, asOf: string): Promise<{ kind: string; standing: boolean; createdMs: number; imported: boolean }[]> {
  const [{ rows }, imports] = await Promise.all([
    platformDb().query<{ id: string; kind: string; lifecycle: string; created_ms: number }>(
      `select n.id::text as id, n.kind, n.lifecycle, (extract(epoch from n.created_at) * 1000)::float8 as created_ms
         from zz.knowledge_node n
         join zz.team t on t.id = n.team_id
        where t.slug = $1 and n.created_at < $2::timestamptz`, [team, asOf]),
    lessonImports(asOf),
  ]);
  const imported = new Set(imports.lessons.map((l) => l.id));
  return rows.map((r) => ({ kind: r.kind, standing: r.lifecycle === "adopted", createdMs: r.created_ms, imported: imported.has(r.id) }));
}

/** What a returned entry is, from the shelf:initiative/path zz-core records it as. */
function kindOf(entry: string): "lesson" | "source" | "document" {
  const address = entry.slice(entry.indexOf(":") + 1);
  const slash = address.indexOf("/");
  if (address.slice(0, slash) === "_knowledge") return "lesson";
  return address.slice(slash + 1).startsWith("sources/") ? "source" : "document";
}

/** The returned entries of the team's completed searches inside the window, one list a search. */
async function searchesIn(team: string, window: Span, asOf: string): Promise<string[][]> {
  const [fromMs, endMs] = boundsOf(window, asOf);
  if (endMs <= fromMs) return [];
  const { rows } = await platformDb().query<{ returned: unknown }>(
    `select e.detail -> 'returned' as returned
       from zz.event e
       join zz.team t on t.id = e.team_id
      where t.slug = $1 and e.kind = 'knowledge.search' and e.origin = 'work' and e.detail ? 'returned'
        and e.ts >= $2::timestamptz and e.ts < $3::timestamptz`,
    [team, new Date(fromMs).toISOString(), new Date(endMs).toISOString()]);
  return rows.map((r) => (Array.isArray(r.returned) ? r.returned.filter((x): x is string => typeof x === "string") : []));
}

/** Record's Knowledge slice. */
export async function knowledgeSlice(team: string, window: Span, asOf: string): Promise<KnowledgeSlice> {
  const grain = grainFor(window);
  const [lessons, searches, found, periods] = await Promise.all([
    lessonsOf(team, asOf), searchesIn(team, window, asOf), searchesWithResults(team, window, asOf, grain), periodsOf(window, asOf, grain),
  ]);
  const [fromMs, endMs] = boundsOf(window, asOf);
  const adopted = lessons.filter((l) => !l.imported);
  const returned = searches.flat();
  const tally = <K extends string>(keys: K[]): [K, number][] => {
    const n = new Map<K, number>();
    for (const k of keys) n.set(k, (n.get(k) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };
  return {
    adopted: counted(adopted.filter((l) => l.createdMs >= fromMs && l.createdMs < endMs).length),
    adoptedInAll: periods.map((p): PeriodFigure => {
      const n = adopted.filter((l) => l.createdMs < Math.min(p.toMs, endMs)).length;
      return { window: p.window, figure: counted(n), numerator: n, denominator: null };
    }),
    ownReturned: counted(returned.filter((r) => r.startsWith("team:_knowledge/")).length),
    meanResults: searches.length ? counted(returned.length / searches.length) : { value: null, why: "no_data" },
    sharedResults: counted(returned.filter((r) => r.startsWith("platform:")).length),
    searchesWithResults: found,
    returnedByKind: tally(returned.map(kindOf)).map(([kind, results]) => ({ kind, results })),
    byKind: tally(lessons.filter((l) => l.standing).map((l) => l.kind)).map(([kind, n]) => ({ kind, lessons: n })),
  };
}

/** Record's Your agents slice. */
export async function agentsSlice(team: string, window: Span, asOf: string): Promise<AgentsSlice> {
  const r = await observedRuns(team, window, asOf);
  return {
    coverageMs: counted(r.coverageMs), summedMs: counted(r.summedMs), peak: counted(r.peak), runs: counted(r.runs),
    zeroLength: r.zeroLength, skillsUsed: counted(r.skillsUsed),
    weekdayHour: r.weekdayHour, days: r.days, bySkill: r.bySkill,
  };
}

/** The best of candidates: the highest value, the one set first among equals, then by subject. */
function bestOf(key: BestKey, candidates: { value: number; atMs: number; subject: string }[]): Best | null {
  const [top] = [...candidates].sort((a, b) => b.value - a.value || a.atMs - b.atMs || a.subject.localeCompare(b.subject));
  return top ? { key, value: top.value, at: iso(top.atMs), subject: top.subject } : null;
}

/** Each flow document's transitions dated inside the window, as the count each reached and when. */
async function mostVersions(team: string, window: Span, asOf: string): Promise<Best | null> {
  const reached = new Map<string, { value: number; atMs: number; subject: string }>();
  for (const t of await transitions(team, window, asOf)) {
    const was = reached.get(t.docId);
    reached.set(t.docId, { value: (was?.value ?? 0) + 1, atMs: Date.parse(t.at), subject: `${t.initiative}/${t.path}` });
  }
  return bestOf("most_versions", [...reached.values()]);
}

/** The sources registered inside the window under each of the team's flow documents, by when each was. */
async function mostSources(team: string, window: Span, asOf: string): Promise<Best | null> {
  const [fromMs, endMs] = boundsOf(window, asOf);
  if (endMs <= fromMs) return null;
  const { rows } = await platformDb().query<{ subject: string; sources: number; last_ms: number }>(
    `select i.slug || '/' || d.path as subject, count(distinct s.id)::int as sources,
            (extract(epoch from max(s.created_at)) * 1000)::float8 as last_ms
       from zz.doc d
       join zz.initiative i on i.id = d.initiative_id
       join zz.team t on t.id = i.team_id
       join zz.doc_link l on l.to_doc_id = d.id and l.kind = 'supports'
       join zz.doc s on s.id = l.from_doc_id and l.from_revision = s.current_revision
      where t.slug = $1 and d.path not like 'sources/%' and i.slug <> '_knowledge' and s.path like 'sources/%'
        and s.created_at >= $2::timestamptz and s.created_at < $3::timestamptz
      group by i.slug, d.path`,
    [team, new Date(fromMs).toISOString(), new Date(endMs).toISOString()]);
  return bestOf("most_sources", rows.map((r) => ({ value: r.sources, atMs: r.last_ms, subject: r.subject })));
}

/** When the team first closed a piece of work, first had an approval recorded as work, and first began
 *  a run; the earliest day one of its revisions was sealed, and the day the platform's approvals began
 *  to be recorded, both local dates. */
async function firstActs(team: string, asOf: string) {
  const { rows: [r] } = await platformDb().query<{
    closed_ms: number | null; approved_ms: number | null; run_ms: number | null; sealed_day: string | null; sealed_ms: number | null; began_day: string | null;
  }>(
    `select (select (extract(epoch from min(i.closed_at)) * 1000)::float8
               from zz.initiative i join zz.team t on t.id = i.team_id
              where t.slug = $1 and i.slug <> '_knowledge' and i.closed_at < $2::timestamptz) as closed_ms,
            (select (extract(epoch from min(e.ts)) * 1000)::float8
               from zz.event e join zz.team t on t.id = e.team_id
              where t.slug = $1 and e.kind = 'document.document_approve' and e.origin = 'work' and e.ts < $2::timestamptz) as approved_ms,
            (select (extract(epoch from min(r.started_at)) * 1000)::float8
               from zz.skill_run r join zz.team t on t.id = r.team_id
              where t.slug = $1 and r.started_at < $2::timestamptz) as run_ms,
            s.day as sealed_day,
            (extract(epoch from (s.day::date::timestamp at time zone $3::text)) * 1000)::float8 as sealed_ms,
            (select to_char(min(e.ts) at time zone $3::text, 'YYYY-MM-DD')
               from zz.event e
              where e.kind = 'document.document_approve' and e.ts < $2::timestamptz) as began_day
       from (select to_char(min(r.approved_at::date), 'YYYY-MM-DD') as day
               from zz.doc_revision r
               join zz.doc d on d.id = r.doc_id
               join zz.initiative i on i.id = d.initiative_id
               join zz.team t on t.id = i.team_id
              where t.slug = $1 and d.path not like 'sources/%' and i.slug <> '_knowledge'
                and r.approved_at::date < ($2::timestamptz at time zone $3::text)::date) s`,
    [team, asOf, ZZ_TZ]);
  return r;
}

/** When the team's earliest transition adding words was dated, over the whole record; null with none. */
async function firstAdded(team: string, asOf: string): Promise<number | null> {
  const added = (await transitions(team, { from: ALL_TIME, to: asOf }, asOf)).find((t) => t.added > 0);
  return added ? Date.parse(added.at) : null;
}

/** Record's Firsts and bests slice. */
export async function firstsSlice(team: string, window: Span, asOf: string): Promise<FirstsSlice> {
  const [versions, sources, facts, open, acts, lessons, addedMs] = await Promise.all([
    mostVersions(team, window, asOf), mostSources(team, window, asOf), documentFacts(team, window, asOf),
    mostOpenAtOnce(team, window, asOf), firstActs(team, asOf), lessonsOf(team, asOf), firstAdded(team, asOf),
  ]);
  const week = facts.mostWordsInAWeek;
  const bests = [
    versions, sources,
    week && { key: "most_words_week" as const, value: week.words, at: week.week, subject: null },
    open.at !== null && open.value.value !== null ? { key: "most_open" as const, value: open.value.value, at: open.at, subject: null } : null,
  ].filter((b): b is Best => b !== null);

  const own = lessons.filter((l) => !l.imported).map((l) => l.createdMs);
  const lessonMs = own.length ? Math.min(...own) : null;
  // A seal is a day: it stands for the first approval only when it is earlier than any recorded one.
  const sealedFirst = acts.sealed_day !== null && (acts.began_day === null || acts.sealed_day < acts.began_day);
  const approvedMs = sealedFirst ? acts.sealed_ms : acts.approved_ms;
  // Words were first added by the earlier of the first transition adding any and the first lesson.
  const wordsMs = addedMs === null ? lessonMs : lessonMs === null ? addedMs : Math.min(addedMs, lessonMs);
  const wordsWeek = wordsMs === null ? null
    : (await periodsOf({ from: iso(wordsMs), to: iso(wordsMs + 1000) }, asOf, "week"))[0]?.window.from ?? null;

  const firsts = ([
    ["closed", acts.closed_ms], ["approved", approvedMs], ["lesson", lessonMs], ["run", acts.run_ms],
    ["words_week", wordsWeek === null ? null : Date.parse(wordsWeek)],
  ] as [FirstKey, number | null][])
    .filter((f): f is [FirstKey, number] => f[1] !== null)
    .sort((a, b) => a[1] - b[1])
    .map(([key, ms]) => ({ key, at: iso(ms) }));
  return { bests, firsts };
}
