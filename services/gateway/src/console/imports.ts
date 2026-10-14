/**
 * The one rule that tells an import from a team's own work, for lessons and for documents. Knowledge
 * health reads lessons through `lessonImports`; Record and Home read documents through
 * `importedDocuments`. An import stays in every inventory; what this rule names is left out of what a
 * team made in a period.
 *
 * A lesson is judged exactly when zz-core's `knowledge.add` event names it (`detail.ids.node`, written
 * since the lesson's id was recorded): imported when that event's origin is `platform`, whatever the
 * day. A lesson no event names is judged by day: a local day in the reporting timezone is an import day
 * for a shelf when, over that day's successful `core:knowledge_add` calls whose shelf it is (the shared
 * shelf for a call asking `scope: platform`, the caller's team otherwise), those with origin `platform`
 * outnumber those with origin `work`, a tie not being one; the lessons made on that shelf that day are
 * its cohort, a lesson added by hand among them, and are labelled `by_day`.
 *
 * A document is judged by its writes: the successful calls of the four writing tools, `document_write`
 * and `document_edit` and the retired `document_patch` and `document_revise`, whose `ids.path`, less a
 * leading `/`, names its initiative and its path, in its team. It is imported when it has at least one
 * and every one has origin `platform`; unrecorded when it has none; mixed when both origins appear.
 * Only a flow document is judged: one whose path is not under `sources/`, outside `_knowledge`.
 *
 * DELIBERATE: the document, not its revisions. A draft nobody has been shown is rewritten in place, so
 * several calls make one revision and no order of writing pairs a call with the revision it made.
 *
 * The rule reads ids, counts, times and origins, never what anybody wrote. Each function throws when
 * its statement fails; the read that calls it says which of its parts that made unavailable.
 */
import { platformDb } from "../db.js";
import { PLATFORM_TEAM } from "../identity.js";
import { ZZ_TZ } from "./shared.js";

/** One imported lesson: its node id, the slug of the shelf it is on, and how it was told. */
type ImportedLesson = { id: string; shelf: string; basis: "exact" | "by_day" };

/** One import day on one shelf, a local date, with the calls it was decided on. */
type ImportDay = { day: string; shelf: string; platform: number; work: number };

/** One document, by its id, its team, its initiative and its path within it. */
type DocRef = { docId: string; team: string; initiative: string; path: string };

/** How a document's writes tell it: every one a maintenance client's, none recorded, or both kinds. */
type Told = "imported" | "unrecorded" | "mixed";

/**
 * Every lesson made before `asOf` that is an import, by shelf and ordinal, and every import day before
 * it, by day and shelf. A call, an event or a lesson recorded at or after `asOf` is not yet read.
 */
export async function lessonImports(asOf: string): Promise<{ lessons: ImportedLesson[]; days: ImportDay[] }> {
  const db = platformDb();
  const days = (await db.query<{ shelf_id: string; shelf: string; day: string; platform: number; work: number }>(
    `select c.shelf_id::text as shelf_id, t.slug as shelf, c.day,
            (count(*) filter (where c.origin = 'platform'))::int as platform,
            (count(*) filter (where c.origin = 'work'))::int as work
       from (select case when e.detail -> 'ids' ->> 'scope' = 'platform'
                         then (select p.id from zz.team p where p.slug = $3::text)
                         else e.team_id end as shelf_id,
                    to_char(e.ts at time zone $2::text, 'YYYY-MM-DD') as day,
                    e.origin
               from zz.event e
              where e.kind = 'tool_call' and e.tool_key = 'core:knowledge_add' and e.ok
                and e.ts < $1::timestamptz) c
       join zz.team t on t.id = c.shelf_id
      group by c.shelf_id, t.slug, c.day
     having count(*) filter (where c.origin = 'platform') > count(*) filter (where c.origin = 'work')
      order by c.day, t.slug`, [asOf, ZZ_TZ, PLATFORM_TEAM])).rows;
  const lessons = (await db.query<{ id: string; shelf: string; basis: "exact" | "by_day" }>(
    `with named as (
       select distinct on (e.detail -> 'ids' ->> 'node') e.detail -> 'ids' ->> 'node' as node, e.origin
         from zz.event e
        where e.kind = 'knowledge.add' and e.detail -> 'ids' ->> 'node' is not null and e.ts < $1::timestamptz
        order by e.detail -> 'ids' ->> 'node', e.ts, e.id),
     import_day as (
       select d.shelf_id, d.day from unnest($3::uuid[], $4::text[]) as d(shelf_id, day))
     select n.id::text as id, t.slug as shelf, case when x.node is null then 'by_day' else 'exact' end as basis
       from zz.knowledge_node n
       join zz.team t on t.id = n.team_id
       left join named x on x.node = n.id::text
      where n.created_at < $1::timestamptz
        and (x.origin = 'platform'
             or (x.node is null
                 and exists (select 1 from import_day d
                              where d.shelf_id = n.team_id
                                and d.day = to_char(n.created_at at time zone $2::text, 'YYYY-MM-DD'))))
      order by t.slug, n.node_ordinal`,
    [asOf, ZZ_TZ, days.map((d) => d.shelf_id), days.map((d) => d.day)])).rows;
  return { lessons, days: days.map((d) => ({ day: d.day, shelf: d.shelf, platform: d.platform, work: d.work })) };
}

/**
 * Every flow document made before `asOf` whose write calls before it are all a maintenance client's
 * (`imported`), none at all (`unrecorded`), or both a maintenance client's and the team's (`mixed`), by
 * team, initiative and path. A document written only as work is in none of the three. A call recorded at
 * or after `asOf`, and a document made at or after it, is not yet read.
 */
export async function importedDocuments(asOf: string): Promise<{ imported: DocRef[]; unrecorded: DocRef[]; mixed: DocRef[] }> {
  const { rows } = await platformDb().query<{ doc_id: string; team: string; initiative: string; path: string; told: Told }>(
    `with writes as (
       select e.team_id, ltrim(e.detail -> 'ids' ->> 'path', '/') as path,
              (count(*) filter (where e.origin = 'platform'))::int as platform,
              (count(*) filter (where e.origin = 'work'))::int as work
         from zz.event e
        where e.kind = 'tool_call' and e.ok and e.team_id is not null and e.ts < $1::timestamptz
          and e.tool_key in ('core:document_write', 'core:document_edit', 'core:document_patch', 'core:document_revise')
        group by 1, 2)
     select d.id::text as doc_id, t.slug as team, i.slug as initiative, d.path,
            case when w.path is null then 'unrecorded' when w.work = 0 then 'imported' else 'mixed' end as told
       from zz.doc d
       join zz.initiative i on i.id = d.initiative_id
       join zz.team t on t.id = i.team_id
       left join writes w on w.team_id = i.team_id and w.path = i.slug || '/' || d.path
      where d.path not like 'sources/%' and i.slug <> '_knowledge' and d.created_at < $1::timestamptz
        and (w.path is null or w.platform > 0)
      order by t.slug, i.slug, d.path`, [asOf]);
  const told: Record<Told, DocRef[]> = { imported: [], unrecorded: [], mixed: [] };
  for (const r of rows) told[r.told].push({ docId: r.doc_id, team: r.team, initiative: r.initiative, path: r.path });
  return told;
}
