/**
 * The record the import rule is read from, seeded into a throwaway database, and what the rule must
 * answer over it: `checks/console-imports.ts` calls `lessonImports` and `importedRevisions` from
 * services/gateway/src/console/imports.ts over these rows.
 *
 * Every instant is written in the reporting timezone the check sets, Asia/Singapore (+08:00, no
 * daylight saving), so a day cut on UTC's calendar misplaces whatever lies before local 08:00.
 *
 * Three shelves: the shared one (`zz-platform`), `osprey-works` and `wren-works`. A call is a
 * `tool_call` of `core:knowledge_add` made by a caller in `osprey-works` or `wren-works`; its shelf
 * is the shared one when it asked `scope: platform`, the caller's team otherwise. A lesson is a
 * `zz.knowledge_node`; one whose `knowledge.add` event names it (`detail.ids.node`) is marked
 * `exact` below, one with an older `knowledge.add` event naming only its ordinal is marked `legacy`,
 * and that event is `work`, as every row before the origin column was.
 *
 *   13 Sep, osprey: 5 platform calls, 2 work calls, 4 work calls refused. Lessons: four legacy
 *           ones and one exact `platform` from the import, one legacy by hand, one exact `work` by
 *           hand. An import day: 5 against 2, the refusals not counted.
 *   13 Sep, wren: 1 work call, one lesson. Not an import day.
 *   14 Sep, osprey callers: 3 platform calls asking `scope: platform`, 1 work call asking
 *           `scope: team`. Three shared lessons, one osprey lesson. An import day for the shared
 *           shelf only.
 *   15 Sep, wren: 2 platform calls, 2 work calls, four lessons. A tie, not an import day.
 *   16 Sep, wren: 1 platform call, 3 work calls; three lessons with no event and one exact
 *           `platform`. Not an import day, and the exact lesson is imported all the same.
 *   20 Sep, osprey: platform calls at 00:10 and 00:20 local, which is still 19 September in UTC,
 *           and a work call at 12:00. Three lessons at those times. An import day on local time.
 *    3 Oct, wren: 1 work call, one exact `work` lesson: the team's own work in October.
 *
 * Documents, each revision written by the `tool_call` of `core:document_write` or
 * `core:document_edit` listed with it, in that order, its `ids.path` the initiative and the path:
 *
 *   osprey 2026-09-01-history/spec.md: platform write, work edit (its `ids.path` with a leading
 *           slash, as a caller may send one), platform edit, work edit.
 *   osprey 2026-09-01-history/plan.md: a platform write refused, then a platform `document_read`
 *           of it, then a work write and a work edit.
 *   wren 2026-09-01-history/plan.md, the same initiative slug and path in another team: platform
 *           write, then a work edit on 3 October.
 *   wren 2026-09-01-history/notes.md: work write.
 *
 * Then the import added afterwards (`seedAddedImport`), on 5 October in wren: 4 platform calls and
 * four exact `platform` lessons, and a new initiative's document written by one platform write.
 *
 * A helper, not a check: every `.ts` under `checks/` is a check the gate runs.
 */
import type pg from "pg";

export const TIMEZONE = "Asia/Singapore";
const SHARED = "zz-platform";
const OSPREY = "osprey-works";
export const WREN = "wren-works";

/** The cutoff between the record and the import added afterwards. */
export const BEFORE_ADDED = "2026-10-04T00:00:00+08:00";

/** October in the reporting timezone: the period a team's own work is counted over. */
export const PERIOD = { from: "2026-10-01T00:00:00+08:00", to: "2026-11-01T00:00:00+08:00" } as const;

type Shelf = typeof SHARED | typeof OSPREY | typeof WREN;
type Origin = "work" | "platform";

/** `count` calls one second apart from `at`; `scope` is what the call asked; refused calls fail. */
interface Calls { team: typeof OSPREY | typeof WREN; scope: "team" | "platform"; origin: Origin; at: string; count: number; refused?: boolean }

/** A lesson by its slug, made at `at`, and the event that recorded it, if any. */
interface Lesson { slug: string; shelf: Shelf; at: string; event: "exact" | "legacy" | null; origin?: Origin }

/** One write of a document: the tool, the client's origin, and whether the call failed. */
interface Write { tool: "document_write" | "document_edit" | "document_read"; origin: Origin; at: string; refused?: boolean; leadingSlash?: boolean }
interface Doc { team: typeof OSPREY | typeof WREN; initiative: string; path: string; writes: Write[] }

const CALLS: readonly Calls[] = [
  { team: OSPREY, scope: "team", origin: "platform", at: "2026-09-13T10:00:00+08:00", count: 5 },
  { team: OSPREY, scope: "team", origin: "work", at: "2026-09-13T15:00:00+08:00", count: 2 },
  { team: OSPREY, scope: "team", origin: "work", at: "2026-09-13T17:00:00+08:00", count: 4, refused: true },
  { team: WREN, scope: "team", origin: "work", at: "2026-09-13T11:00:00+08:00", count: 1 },
  { team: OSPREY, scope: "platform", origin: "platform", at: "2026-09-14T09:00:00+08:00", count: 3 },
  { team: OSPREY, scope: "team", origin: "work", at: "2026-09-14T12:00:00+08:00", count: 1 },
  { team: WREN, scope: "team", origin: "platform", at: "2026-09-15T09:00:00+08:00", count: 2 },
  { team: WREN, scope: "team", origin: "work", at: "2026-09-15T10:00:00+08:00", count: 2 },
  { team: WREN, scope: "team", origin: "platform", at: "2026-09-16T09:00:00+08:00", count: 1 },
  { team: WREN, scope: "team", origin: "work", at: "2026-09-16T10:00:00+08:00", count: 3 },
  { team: OSPREY, scope: "team", origin: "platform", at: "2026-09-20T00:10:00+08:00", count: 1 },
  { team: OSPREY, scope: "team", origin: "platform", at: "2026-09-20T00:20:00+08:00", count: 1 },
  { team: OSPREY, scope: "team", origin: "work", at: "2026-09-20T12:00:00+08:00", count: 1 },
  { team: WREN, scope: "team", origin: "work", at: "2026-10-03T10:00:00+08:00", count: 1 },
];

const LESSONS: readonly Lesson[] = [
  { slug: "osprey-import-1", shelf: OSPREY, at: "2026-09-13T10:00:00+08:00", event: "legacy" },
  { slug: "osprey-import-2", shelf: OSPREY, at: "2026-09-13T10:00:01+08:00", event: "legacy" },
  { slug: "osprey-import-3", shelf: OSPREY, at: "2026-09-13T10:00:02+08:00", event: "legacy" },
  { slug: "osprey-import-4", shelf: OSPREY, at: "2026-09-13T10:00:03+08:00", event: "legacy" },
  { slug: "osprey-import-exact", shelf: OSPREY, at: "2026-09-13T10:00:04+08:00", event: "exact", origin: "platform" },
  { slug: "osprey-by-hand", shelf: OSPREY, at: "2026-09-13T15:00:00+08:00", event: "legacy" },
  { slug: "osprey-by-hand-exact", shelf: OSPREY, at: "2026-09-13T15:00:01+08:00", event: "exact", origin: "work" },
  { slug: "wren-same-day", shelf: WREN, at: "2026-09-13T11:00:00+08:00", event: "legacy" },
  { slug: "shared-1", shelf: SHARED, at: "2026-09-14T09:00:00+08:00", event: null },
  { slug: "shared-2", shelf: SHARED, at: "2026-09-14T09:00:01+08:00", event: null },
  { slug: "shared-3", shelf: SHARED, at: "2026-09-14T09:00:02+08:00", event: null },
  { slug: "osprey-14", shelf: OSPREY, at: "2026-09-14T12:00:00+08:00", event: null },
  { slug: "wren-tie-1", shelf: WREN, at: "2026-09-15T09:00:00+08:00", event: null },
  { slug: "wren-tie-2", shelf: WREN, at: "2026-09-15T09:00:01+08:00", event: null },
  { slug: "wren-tie-3", shelf: WREN, at: "2026-09-15T10:00:00+08:00", event: null },
  { slug: "wren-tie-4", shelf: WREN, at: "2026-09-15T10:00:01+08:00", event: null },
  { slug: "wren-16-exact", shelf: WREN, at: "2026-09-16T09:00:00+08:00", event: "exact", origin: "platform" },
  { slug: "wren-16-1", shelf: WREN, at: "2026-09-16T10:00:00+08:00", event: null },
  { slug: "wren-16-2", shelf: WREN, at: "2026-09-16T10:00:01+08:00", event: null },
  { slug: "wren-16-3", shelf: WREN, at: "2026-09-16T10:00:02+08:00", event: null },
  { slug: "osprey-20-1", shelf: OSPREY, at: "2026-09-20T00:10:00+08:00", event: null },
  { slug: "osprey-20-2", shelf: OSPREY, at: "2026-09-20T00:20:00+08:00", event: null },
  { slug: "osprey-20-hand", shelf: OSPREY, at: "2026-09-20T12:00:00+08:00", event: null },
  { slug: "wren-october", shelf: WREN, at: "2026-10-03T10:00:00+08:00", event: "exact", origin: "work" },
];

const HISTORY = "2026-09-01-history";

const DOCS: readonly Doc[] = [
  { team: OSPREY, initiative: HISTORY, path: "spec.md", writes: [
    { tool: "document_write", origin: "platform", at: "2026-09-13T12:00:00+08:00" },
    { tool: "document_edit", origin: "work", at: "2026-09-20T13:00:00+08:00", leadingSlash: true },
    { tool: "document_edit", origin: "platform", at: "2026-09-21T13:00:00+08:00" },
    { tool: "document_edit", origin: "work", at: "2026-09-22T13:00:00+08:00" },
  ] },
  { team: OSPREY, initiative: HISTORY, path: "plan.md", writes: [
    { tool: "document_write", origin: "platform", at: "2026-09-13T12:30:00+08:00", refused: true },
    { tool: "document_read", origin: "platform", at: "2026-09-13T12:45:00+08:00" },
    { tool: "document_write", origin: "work", at: "2026-09-13T13:00:00+08:00" },
    { tool: "document_edit", origin: "work", at: "2026-09-14T13:00:00+08:00" },
  ] },
  { team: WREN, initiative: HISTORY, path: "plan.md", writes: [
    { tool: "document_write", origin: "platform", at: "2026-09-13T12:00:00+08:00" },
    { tool: "document_edit", origin: "work", at: "2026-10-03T13:00:00+08:00" },
  ] },
  { team: WREN, initiative: HISTORY, path: "notes.md", writes: [
    { tool: "document_write", origin: "work", at: "2026-09-16T13:00:00+08:00" },
  ] },
];

const ADDED_CALLS: readonly Calls[] = [
  { team: WREN, scope: "team", origin: "platform", at: "2026-10-05T10:00:00+08:00", count: 4 },
];
const ADDED_LESSONS: readonly Lesson[] = [1, 2, 3, 4].map((n) => (
  { slug: `wren-added-${n}`, shelf: WREN, at: `2026-10-05T10:00:0${n - 1}+08:00`, event: "exact", origin: "platform" }));
const ADDED_DOCS: readonly Doc[] = [
  { team: WREN, initiative: "2026-10-05-import", path: "history.md", writes: [
    { tool: "document_write", origin: "platform", at: "2026-10-05T11:00:00+08:00" },
  ] },
];

/** What the rule must answer, written out by hand from the lists above and not computed from them.
 *  Lessons by slug and basis; days with the counts each was decided on; revisions by team,
 *  initiative, path and number. */
export const EXPECTED = {
  lessons: [
    ["osprey-import-1", OSPREY, "by_day"], ["osprey-import-2", OSPREY, "by_day"],
    ["osprey-import-3", OSPREY, "by_day"], ["osprey-import-4", OSPREY, "by_day"],
    ["osprey-import-exact", OSPREY, "exact"], ["osprey-by-hand", OSPREY, "by_day"],
    ["shared-1", SHARED, "by_day"], ["shared-2", SHARED, "by_day"], ["shared-3", SHARED, "by_day"],
    ["wren-16-exact", WREN, "exact"],
    ["osprey-20-1", OSPREY, "by_day"], ["osprey-20-2", OSPREY, "by_day"], ["osprey-20-hand", OSPREY, "by_day"],
  ] as [string, string, string][],
  days: [
    { day: "2026-09-13", shelf: OSPREY, platform: 5, work: 2 },
    { day: "2026-09-14", shelf: SHARED, platform: 3, work: 0 },
    { day: "2026-09-20", shelf: OSPREY, platform: 2, work: 1 },
  ],
  revisions: [
    [OSPREY, HISTORY, "spec.md", 1], [OSPREY, HISTORY, "spec.md", 3], [WREN, HISTORY, "plan.md", 1],
  ] as [string, string, string, number][],
  /** What the import added afterwards adds to each. */
  added: {
    lessons: [["wren-added-1", WREN, "exact"], ["wren-added-2", WREN, "exact"],
              ["wren-added-3", WREN, "exact"], ["wren-added-4", WREN, "exact"]] as [string, string, string][],
    days: [{ day: "2026-10-05", shelf: WREN, platform: 4, work: 0 }],
    revisions: [[WREN, "2026-10-05-import", "history.md", 1]] as [string, string, string, number][],
  },
  /** Wren's inventories, before and after the added import: every lesson on its shelf and every document. */
  inventory: { before: { lessons: 10, documents: 2 }, after: { lessons: 14, documents: 3 } },
  /** What wren made in `PERIOD`, before and after: its lessons and its document revisions, imports left out. */
  made: { lessons: 1, revisions: 1 },
} as const;

/** The ids the seed gave: each lesson's node id by its slug, and each team's id by its slug. */
interface Seeded { lessons: Map<string, string>; teams: Map<string, string>; person: string }

/** Seeds the record above into `db`, which must hold no other `core:knowledge_add` call, lesson or
 *  document write. */
export async function seedImports(db: pg.ClientBase): Promise<Seeded> {
  const one = async (text: string, values: unknown[]): Promise<string> => (await db.query<{ id: string }>(text, values)).rows[0].id;
  const person = await one("insert into zz.principal (email, display_name, role) values ('importer@imports.example.test', 'importer', 'member') returning id", []);
  const teams = new Map<string, string>();
  for (const slug of [SHARED, OSPREY, WREN]) {
    await db.query(
      `insert into zz.team (slug, name, created_by) select $1, $1, $2
        where not exists (select 1 from zz.team where slug = $1)`, [slug, person]);
    teams.set(slug, await one("select id::text as id from zz.team where slug = $1", [slug]));
  }
  const seeded: Seeded = { lessons: new Map(), teams, person };
  await write(db, seeded, CALLS, LESSONS, DOCS);
  return seeded;
}

/** Adds the import made afterwards, on 5 October, to what `seedImports` wrote. */
export async function seedAddedImport(db: pg.ClientBase, seeded: Seeded): Promise<void> {
  await write(db, seeded, ADDED_CALLS, ADDED_LESSONS, ADDED_DOCS);
}

async function write(db: pg.ClientBase, s: Seeded, calls: readonly Calls[], lessons: readonly Lesson[], docs: readonly Doc[]): Promise<void> {
  const one = async (text: string, values: unknown[]): Promise<string> => (await db.query<{ id: string }>(text, values)).rows[0].id;
  const team = (slug: string): string => s.teams.get(slug)!;
  const event = (ts: string, kind: string, subject: string, detail: object, origin: Origin, teamId: string,
                 tool: string | null = null, ok: boolean | null = null) => db.query(
    `insert into zz.event (ts, kind, subject, detail, origin, team_id, actor_id, tool_key, ok, refusal_owner, refusal)
     values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, case when $9 = false then 'theirs' end,
             case when $9 = false then 'seeded refusal' end)`,
    [ts, kind, subject, JSON.stringify(detail), origin, teamId, s.person, tool, ok]);

  for (const c of calls) {
    for (let i = 0; i < c.count; i++) {
      const ts = new Date(Date.parse(c.at) + i * 1000).toISOString();
      await event(ts, "tool_call", "core:knowledge_add", { client: c.origin === "platform" ? "zz-migrate" : "claude-code",
        ids: { scope: c.scope, type: "decision" } }, c.origin, team(c.team), "core:knowledge_add", !c.refused);
    }
  }
  for (const l of lessons) {
    const ordinal = await one(
      "select lpad((coalesce(max(node_ordinal::int), 0) + 1)::text, 4, '0') as id from zz.knowledge_node where team_id = $1",
      [team(l.shelf)]);
    const id = await one(
      `insert into zz.knowledge_node (kind, title, body, team_id, node_ordinal, slug, created_at)
       values ('decision', $1, $1, $2, $3, $4, $5) returning id::text as id`, [`Lesson ${l.slug}`, team(l.shelf), ordinal, l.slug, l.at]);
    s.lessons.set(l.slug, id);
    if (l.event === "exact") {
      await event(l.at, "knowledge.add", ordinal, { title: `Lesson ${l.slug}`, type: "decision", scope: "team", ids: { node: id } },
                  l.origin ?? "work", team(l.shelf));
    } else if (l.event === "legacy") {
      await event(l.at, "knowledge.add", ordinal, { title: `Lesson ${l.slug}`, type: "decision", scope: "team" }, "work", team(l.shelf));
    }
  }
  for (const d of docs) {
    const t = team(d.team);
    const initiative = await one(
      `with made as (insert into zz.initiative (team_id, slug, flow, opened_by, opened_at)
                     select $1, $2, 'sdlc-flow', $3, '2026-09-01T09:00:00+08:00'
                      where not exists (select 1 from zz.initiative where team_id = $1 and slug = $2)
                     returning id)
       select id::text as id from made union all select id::text from zz.initiative where team_id = $1 and slug = $2`,
      [t, d.initiative, s.person]);
    const writes = d.writes.filter((w) => w.tool !== "document_read" && !w.refused);
    await db.query("begin");
    await db.query("set constraints all deferred");
    const doc = await one(
      `insert into zz.doc (initiative_id, path, type, status, updated_at, title, body, current_revision, current_version)
       values ($1, $2, 'seeded', 'draft', $4, $2, 'seeded', $3, $3) returning id`, [initiative, d.path, writes.length, writes[writes.length - 1].at]);
    for (const [i, w] of writes.entries()) {
      await db.query(
        `insert into zz.doc_revision (doc_id, revision, version, content_state, title, body, tags, content_hash, written_by, written_at)
         values ($1, $2, $2, 'retained', 'seeded', 'seeded', '{}', $3, $4, $5)`, [doc, i + 1, `hash-${doc}-${i + 1}`, s.person, w.at]);
    }
    await db.query("commit");
    for (const w of d.writes) {
      const path = `${w.leadingSlash ? "/" : ""}${d.initiative}/${d.path}`;
      await event(w.at, "tool_call", `core:${w.tool}`, { client: w.origin === "platform" ? "zz-migrate" : "claude-code", ids: { path } },
                  w.origin, t, `core:${w.tool}`, !w.refused);
    }
  }
}
