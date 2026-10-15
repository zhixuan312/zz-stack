/**
 * The writing ledger: the words a team added by period, the words it retains as of a cutoff, and the
 * document facts Record and Home draw beside them, all from the revisions zz-core keeps and the acts it
 * records. Nothing here is stored and no event gains a measurement; bodies are counted in this process
 * with the contracts' word count, each once: a revision's count is kept by its content_hash, which names
 * its bytes, and a lesson's by its id and updated_at, so a read fetches only the bodies it has not
 * counted. A team's revisions hold tens of megabytes, which every read fetching whole would cost seconds.
 *
 * A transition is revision n-1 to n of one of the team's flow documents (a path not under sources/,
 * outside the _knowledge initiative): its words added are max(0, W(n) - W(n-1)) and its words removed the
 * converse, revision 1 a creation from zero. A revision that retained no bytes (missing_legacy), and the
 * revision after it, is a gap: its words are unknown, so it adds nothing and is counted in the coverage,
 * never read as an empty document.
 *
 * A transition is dated by when its content was written. A revision whose written_at equals the ts of a
 * document.document_approve act on its document, or its initiative's closed_at, was last rewritten by
 * that seal in the seal's own transaction, and is dated by the latest content act on its document before
 * it (the four writing acts under both spellings, matched by team, initiative and path); with no such act
 * it is dated by its written_at and counted in datedByLastWrite. Every other revision is dated by its
 * written_at, and one with none is undated: in the stock, in no period. The acts are read whatever their
 * time, so a seal after the cutoff never moves content written before it.
 *
 * A document every recorded write of which came from a maintenance client is import-made, one with no
 * recorded write is unrecorded, both are left out of every figure here and counted in the coverage; a
 * document written both ways counts as work and is named (importedDocuments). A lesson adds its present
 * word count once, at its created_at, unless it is in an import cohort (lessonImports).
 *
 * documentFacts reads: versions, the revisions of the team's eligible documents dated inside the window,
 * gaps included; the most rewritten, the five documents with the most of them, two at least; the most
 * words added in a week, over the complete weeks of the window whatever its grain; and the documents
 * created by period, the eligible documents whose row was made in it.
 *
 * Each function throws when a statement fails; the read decides what a failure makes of its part.
 *
 * DELIBERATE: no backticks in the comments of this file. check:sql reads it as text, and a backtick in a
 * comment opens a template literal it then parses as code.
 *
 * COUPLED: the console's WritingCoverage and DocumentsSlice in src/lib/work-shapes.ts, and the fake's
 * words in scripts/fake-gateway/work-home.ts and work-record.ts.
 */
import { countWords, type WritingCoverage } from "@zz/contracts";

import { platformDb } from "../db.js";
import type { PeriodFigure } from "./figures.js";
import { importedDocuments, lessonImports } from "./imports.js";
import { grainFor, periodsOf, type Period } from "./work-figures.js";

/** A window as a caller names it: two instants, the first in it and the first after it. */
type Span = { from: string; to: string };
type Dating = "content_act" | "last_write";
/** How a document's recorded writes tell it, work being written only as work. */
type Kind = "work" | "imported" | "unrecorded" | "mixed";

/** One transition a period figure reduces. */
export type Transition = {
  docId: string; initiative: string; path: string; revision: number;
  added: number; removed: number; at: string; dating: Dating;
};

/** One revision as the ledger reads it: its words, or null when it or its predecessor retained none,
 *  and the instant it is dated at, or null when it carries no time. */
type Row = {
  docId: string; initiative: string; path: string; revision: number; kind: Kind;
  retained: boolean; words: number | null; added: number | null; removed: number | null;
  atMs: number | null; dating: Dating; fallback: boolean;
};

/** The content acts, under today's names and the retired ones, and the approval's seal act. */
const CONTENT_ACTS = ["write", "edit", "patch", "revise"].flatMap((a) => [`document.${a}`, `document.document_${a}`]);
const SEAL_ACT = "document.document_approve";
const MOST_REWRITTEN = 5;

/** An instant as the gateway spells one: ISO 8601 in UTC, whole seconds, with the Z. */
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const eligible = (r: { kind: Kind }): boolean => r.kind === "work" || r.kind === "mixed";

/** Words counted, by a revision's content_hash and by a lesson's id and updated_at: a body's count never
 *  changes while what names it does not. Cleared whole past its bound, which only drafts rewritten in
 *  place, each leaving its old hash behind, can reach. */
const counted = new Map<string, number>();
const COUNTED_BOUND = 200_000;

/** The words of the bodies `missing` names, fetched by `read` and kept under the key `keyOf` gives. */
async function countMissing<R extends { body: string }>(missing: string[], read: () => Promise<R[]>, keyOf: (r: R) => string): Promise<void> {
  if (!missing.length) return;
  if (counted.size > COUNTED_BOUND) counted.clear();
  for (const r of await read()) counted.set(keyOf(r), countWords(r.body));
}

/** An instant in whole microseconds since the epoch, as PostgreSQL keeps it, so two instants compare
 *  exactly; and the same in milliseconds. */
const us = (t: string | null): bigint | null => (t === null ? null : BigInt(t));
const msOf = (t: bigint): number => Number(t) / 1000;

/** Every revision of the team's flow documents made before the cutoff, with its words, its transition
 *  and its date; the documents' creation; and the team's lessons made before it outside an import
 *  cohort, with their words. */
async function ledger(team: string, asOf: string, withLessons: boolean) {
  const db = platformDb();
  const [revisions, acts, told, lessons, cohorts] = await Promise.all([
    db.query<{ doc_id: string; initiative_id: string; initiative: string; path: string; created_us: string; revision: number;
               retained: boolean; hash: string | null; written_us: string | null; closed_us: string | null }>(
      `select d.id::text as doc_id, i.id::text as initiative_id, i.slug as initiative, d.path,
              (extract(epoch from d.created_at) * 1000000)::bigint::text as created_us,
              r.revision, r.content_state = 'retained' as retained, r.content_hash as hash,
              (extract(epoch from r.written_at) * 1000000)::bigint::text as written_us,
              (extract(epoch from i.closed_at) * 1000000)::bigint::text as closed_us
         from zz.doc d
         join zz.initiative i on i.id = d.initiative_id
         join zz.team t on t.id = i.team_id
         join zz.doc_revision r on r.doc_id = d.id
        where t.slug = $1 and d.path not like 'sources/%' and i.slug <> '_knowledge' and d.created_at < $2::timestamptz
        order by d.id, r.revision`, [team, asOf]),
    db.query<{ initiative_id: string; path: string; seal: boolean; ts_us: string }>(
      `select e.initiative_id::text as initiative_id, ltrim(e.subject, '/') as path, e.kind = $3 as seal,
              (extract(epoch from e.ts) * 1000000)::bigint::text as ts_us
         from zz.event e
         join zz.team t on t.id = e.team_id
        where t.slug = $1 and e.kind = any($2::text[]) and e.initiative_id is not null`,
      [team, [...CONTENT_ACTS, SEAL_ACT], SEAL_ACT]),
    importedDocuments(asOf),
    withLessons
      ? db.query<{ id: string; updated_us: string; created_ms: number }>(
          `select n.id::text as id, (extract(epoch from n.updated_at) * 1000000)::bigint::text as updated_us,
                  (extract(epoch from n.created_at) * 1000)::float8 as created_ms
             from zz.knowledge_node n
             join zz.team t on t.id = n.team_id
            where t.slug = $1 and n.created_at < $2::timestamptz`, [team, asOf])
      : null,
    withLessons ? lessonImports(asOf) : null,
  ]);

  // The bodies not yet counted, fetched by what names them; a body rewritten between the two reads is
  // kept under its new name and counted on the next read.
  const hashes = [...new Set(revisions.rows.filter((r) => r.retained && r.hash !== null && !counted.has(r.hash)).map((r) => r.hash!))];
  const docIds = [...new Set(revisions.rows.map((r) => r.doc_id))];
  const lessonKey = (id: string, updatedUs: string): string => `lesson ${id} ${updatedUs}`;
  const unread = (lessons?.rows ?? []).filter((l) => !counted.has(lessonKey(l.id, l.updated_us))).map((l) => l.id);
  await Promise.all([
    countMissing(hashes, async () => (await db.query<{ hash: string; body: string }>(
      `select distinct on (r.content_hash) r.content_hash as hash, r.body
         from zz.doc_revision r
        where r.doc_id = any($1::uuid[]) and r.content_hash = any($2::text[])`, [docIds, hashes])).rows, (r) => r.hash),
    countMissing(unread, async () => (await db.query<{ id: string; updated_us: string; body: string }>(
      `select n.id::text as id, (extract(epoch from n.updated_at) * 1000000)::bigint::text as updated_us, n.body
         from zz.knowledge_node n
        where n.id = any($1::uuid[])`, [unread])).rows, (l) => lessonKey(l.id, l.updated_us)),
  ]);

  // Each document's seals and content acts, by its initiative and its path within the team.
  const actsOf = new Map<string, { seals: Set<bigint>; content: bigint[] }>();
  for (const a of acts.rows) {
    const key = `${a.initiative_id} ${a.path}`;
    const of = actsOf.get(key) ?? { seals: new Set<bigint>(), content: [] };
    if (a.seal) of.seals.add(BigInt(a.ts_us));
    else of.content.push(BigInt(a.ts_us));
    actsOf.set(key, of);
  }
  const kindOf = new Map<string, Kind>();
  for (const k of ["imported", "unrecorded", "mixed"] as const) for (const d of told[k]) kindOf.set(d.docId, k);
  const rows: Row[] = [];
  const created: { kind: Kind; atMs: number }[] = [];
  let before = null as { docId: string; revision: number; words: number | null } | null;
  for (const r of revisions.rows) {
    const kind = kindOf.get(r.doc_id) ?? "work";
    if (before?.docId !== r.doc_id) created.push({ kind, atMs: msOf(BigInt(r.created_us)) });
    const words = r.retained && r.hash !== null ? counted.get(r.hash) ?? null : null;
    // Revision 1 is a creation from zero; any other needs its own predecessor's words.
    const prior = r.revision === 1 ? 0
      : before?.docId === r.doc_id && before.revision === r.revision - 1 ? before.words : null;
    const known = words !== null && prior !== null;
    const written = us(r.written_us);
    const of = actsOf.get(`${r.initiative_id} ${r.initiative}/${r.path}`);
    const sealed = written !== null && (written === us(r.closed_us) || (of?.seals.has(written) ?? false));
    const act = sealed ? (of?.content ?? []).reduce<bigint | null>((m, t) => (t < written && (m === null || t > m) ? t : m), null) : null;
    rows.push({
      docId: r.doc_id, initiative: r.initiative, path: r.path, revision: r.revision, kind, retained: r.retained, words,
      added: known ? Math.max(0, words - prior) : null, removed: known ? Math.max(0, prior - words) : null,
      atMs: act !== null ? msOf(act) : written !== null ? msOf(written) : null,
      dating: act !== null ? "content_act" : "last_write", fallback: sealed && act === null,
    });
    before = { docId: r.doc_id, revision: r.revision, words };
  }
  const imported = new Set(cohorts?.lessons.map((l) => l.id) ?? []);
  return {
    rows, created,
    // A lesson rewritten between the two reads is left out of this one rather than counted as empty.
    lessons: (lessons?.rows ?? []).filter((l) => !imported.has(l.id) && counted.has(lessonKey(l.id, l.updated_us)))
      .map((l) => ({ words: counted.get(lessonKey(l.id, l.updated_us))!, atMs: l.created_ms })),
  };
}

/** The instants a window counts from and up to: inside it and before the cutoff. */
const boundsOf = (window: Span, asOf: string): [number, number] =>
  [Date.parse(window.from), Math.min(Date.parse(window.to), Date.parse(asOf))];
const inside = (ms: number | null, [from, to]: [number, number]): ms is number => ms !== null && ms >= from && ms < to;
const inPeriod = (ms: number, p: Period): boolean => ms >= p.fromMs && ms < p.toMs;

/** What a population of revisions was counted over, and what it was not. */
function coverageOf(rows: Row[], gaps: (r: Row) => boolean): WritingCoverage {
  const docs = (k: Kind) => new Set(rows.filter((r) => r.kind === k).map((r) => r.docId)).size;
  const counted = rows.filter(eligible);
  return {
    documents: new Set(rows.map((r) => r.docId)).size, revisions: rows.length,
    importMade: docs("imported"), unrecorded: docs("unrecorded"), mixed: docs("mixed"),
    datedByLastWrite: counted.filter((r) => r.fallback).length,
    undated: counted.filter((r) => r.atMs === null).length,
    missingLegacy: counted.filter(gaps).length,
  };
}

/** The transitions a period figure reduces: the eligible documents' revisions dated inside the window and
 *  before the cutoff whose words are known, oldest first. */
const countedIn = (rows: Row[], bounds: [number, number]) =>
  rows.filter((r) => eligible(r) && r.added !== null && inside(r.atMs, bounds));

const toTransition = (r: Row): Transition => ({
  docId: r.docId, initiative: r.initiative, path: r.path, revision: r.revision,
  added: r.added!, removed: r.removed!, at: iso(r.atMs!), dating: r.dating,
});

/** The transitions of the team's eligible documents dated inside the window before the cutoff, the
 *  earliest first: the rows every period figure reduces. */
export async function transitions(team: string, window: Span, asOf: string): Promise<Transition[]> {
  const { rows } = await ledger(team, asOf, false);
  return countedIn(rows, boundsOf(window, asOf))
    .sort((a, b) => a.atMs! - b.atMs! || a.initiative.localeCompare(b.initiative) || a.path.localeCompare(b.path) || a.revision - b.revision)
    .map(toTransition);
}

/** A period's words: the sum of what it added, or no data when nothing was written in it. */
const wordsFigure = (window: PeriodFigure["window"], items: number[]): PeriodFigure => {
  if (!items.length) return { window, figure: { value: null, why: "no_data" }, numerator: null, denominator: null };
  const sum = items.reduce((a, b) => a + b, 0);
  return { window, figure: { value: sum, why: null }, numerator: sum, denominator: null };
};

/** Every word added inside the window before the cutoff, by instant: the documents' transitions and the
 *  lessons. */
function additionsIn(l: Awaited<ReturnType<typeof ledger>>, bounds: [number, number]): { atMs: number; words: number }[] {
  return [
    ...countedIn(l.rows, bounds).map((r) => ({ atMs: r.atMs!, words: r.added! })),
    ...l.lessons.filter((x) => inside(x.atMs, bounds)).map((x) => ({ atMs: x.atMs, words: x.words })),
  ];
}

/** Words added by period at the window's grain, the running period not complete, each period's own; the
 *  same summed from the window's start through each period; and what they were counted over: the
 *  revisions dated inside the window and those that carry no date. */
export async function additionsByPeriod(team: string, window: Span, asOf: string): Promise<{ periods: PeriodFigure[]; cumulative: PeriodFigure[]; coverage: WritingCoverage }> {
  const [periods, l] = await Promise.all([periodsOf(window, asOf, grainFor(window)), ledger(team, asOf, true)]);
  const bounds = boundsOf(window, asOf);
  const added = additionsIn(l, bounds);
  let total = 0;
  const cumulative: PeriodFigure[] = [];
  const figures = periods.map((p) => {
    const here = added.filter((a) => inPeriod(a.atMs, p)).map((a) => a.words);
    const figure = wordsFigure(p.window, here);
    total += figure.figure.value ?? 0;
    cumulative.push({ window: p.window, figure: { value: total, why: null }, numerator: total, denominator: null });
    return figure;
  });
  const population = l.rows.filter((r) => r.atMs === null || inside(r.atMs, bounds));
  return { periods: figures, cumulative, coverage: coverageOf(population, (r) => r.added === null) };
}

/** The words the team retains as of the cutoff: each eligible document's latest revision dated before
 *  it, or carrying no date, counted once, and every lesson made before it outside an import cohort. A
 *  latest revision that retained no bytes adds nothing and is a gap. */
export async function retainedStock(team: string, asOf: string): Promise<{ words: number; coverage: WritingCoverage }> {
  const l = await ledger(team, asOf, true);
  const asOfMs = Date.parse(asOf);
  const kept = l.rows.filter((r) => r.atMs === null || r.atMs < asOfMs);
  const current = new Map<string, Row>();
  for (const r of kept) if ((current.get(r.docId)?.revision ?? 0) < r.revision) current.set(r.docId, r);
  const latest = [...current.values()];
  const words = latest.filter(eligible).reduce((a, r) => a + (r.words ?? 0), 0) + l.lessons.reduce((a, x) => a + x.words, 0);
  const coverage = coverageOf(latest, (r) => !r.retained);
  return { words, coverage: { ...coverage, revisions: kept.length } };
}

/** The versions written inside the window, the documents rewritten most in it, the week of it with the
 *  most words added, and the documents created by period at the window's grain. */
export async function documentFacts(team: string, window: Span, asOf: string): Promise<{
  versions: number; mostRewritten: { initiative: string; path: string; versions: number }[];
  mostWordsInAWeek: { words: number; week: string } | null; documentsCreated: PeriodFigure[];
}> {
  const [periods, weeks, l] = await Promise.all([
    periodsOf(window, asOf, grainFor(window)), periodsOf(window, asOf, "week"), ledger(team, asOf, true)]);
  const bounds = boundsOf(window, asOf);
  const written = l.rows.filter((r) => eligible(r) && inside(r.atMs, bounds));

  const byDoc = new Map<string, { initiative: string; path: string; versions: number }>();
  for (const r of written) {
    const d = byDoc.get(r.docId) ?? { initiative: r.initiative, path: r.path, versions: 0 };
    d.versions += 1;
    byDoc.set(r.docId, d);
  }
  const mostRewritten = [...byDoc.values()].filter((d) => d.versions >= 2)
    .sort((a, b) => b.versions - a.versions || a.initiative.localeCompare(b.initiative) || a.path.localeCompare(b.path))
    .slice(0, MOST_REWRITTEN);

  // A tie keeps the earliest week; a running week is drawn elsewhere and never chosen here.
  const added = additionsIn(l, bounds);
  let mostWordsInAWeek: { words: number; week: string } | null = null;
  for (const w of weeks.filter((p) => p.window.complete)) {
    const words = added.filter((a) => inPeriod(a.atMs, w)).reduce((s, a) => s + a.words, 0);
    if (words > 0 && words > (mostWordsInAWeek?.words ?? 0)) mostWordsInAWeek = { words, week: w.window.from };
  }

  const made = l.created.filter((d) => eligible(d) && inside(d.atMs, bounds));
  const documentsCreated = periods.map((p): PeriodFigure => {
    const n = made.filter((d) => inPeriod(d.atMs, p)).length;
    return { window: p.window, figure: { value: n, why: null }, numerator: n, denominator: null };
  });
  return { versions: written.length, mostRewritten, mostWordsInAWeek, documentsCreated };
}
