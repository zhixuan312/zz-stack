/**
 * The record the platform's Knowledge health is read from, seeded into a throwaway database:
 * `checks/console-platform-knowledge.ts` drives the gateway's own route over it and writes out by hand
 * what each reader must find.
 *
 * Weeks are Monday to Monday in the reporting timezone, counted back from the running one (`weekStart`):
 * `back` 0 is the running week, 1 the last whole week (L), 2 the one before it, and so on. An entry
 * `day` days and `hour` hours into its week falls on that local day; the running week's entries all
 * fall on its first instant, so none lies after the clock.
 *
 * Four shelves: the shared one (`zz-platform`), `alder` (the member's team), `birch` (the superadmin's
 * active team) and `cedar`. The record begins with a real-work call in alder in back 28, so the grid
 * runs 29 weeks and the read draws the last 26, back 25 to the running week.
 *
 * Lessons, `kind` and whether since superseded; an event is zz-core's `knowledge.add`, `exact` naming
 * the lesson (`detail.ids.node`), `legacy` naming only its ordinal and recorded `work`, as every row
 * before the lesson's id was:
 *
 *   back 27  alder: two decisions, legacy, one superseded. Standing, and before every week drawn.
 *   back 3   Wednesday 10:00, the shared shelf: five lessons imported, legacy (three processes, two
 *            knowledge, one of each superseded), and a design added by hand at 15:00; that day five
 *            maintenance `knowledge_add` calls asking `scope: platform` against one work call make it
 *            an import day for the shared shelf, so all six are `by_day`. The same day alder gains a
 *            decision through one work call of its own, which is not an import.
 *   back 2   Tuesday 11:00, birch: a behavior named exactly by a work event, the first event that
 *            names its lesson; cedar: a style with no event.
 *   back 1   Thursday 09:00, alder: three decisions named exactly by maintenance events (one since
 *            superseded), a design named exactly by a work event at 14:00, and a process with no
 *            event at 15:00; that day three maintenance calls against one work call make it an import
 *            day for alder, so the process is `by_day` and the design, judged by its own event, is
 *            not imported. Friday, the shared shelf: a knowledge and a style by hand, no event.
 *   back 0   birch: a style with no event.
 *
 * Searches, zz-core's work `knowledge.search` rows, the question as the subject, the team the
 * searcher's, `detail.returned` the results, `detail.broadened` whether the engine widened:
 *
 *   back 27  alder: one found nothing, with no `broadened` key.
 *   back 4   Tuesday 10:00, cedar: thirty, eleven of them finding nothing (`cedar question 01` to
 *            `11`, a second apart) and nineteen two results each; three widened.
 *   back 2   Wednesday 10:00: alder `how do we roll back a migration` and cedar `who owns the nightly
 *            reindex`, both nothing.
 *   back 1   Wednesday 10:00: alder two results, four results, and the roll-back question again with
 *            nothing; birch `chargeback window for refunds` with nothing and one result widened; the
 *            shared shelf's team three results.
 *   back 0   alder and birch each ask the roll-back question and find nothing.
 *
 * Beside them, and none may move a figure: a maintenance search in L that found nothing, asking
 * `maintenance probe question`, and a refused `core:knowledge_search` call.
 *
 * `seedAddedImport` adds four lessons to cedar in the running week, each named exactly by a
 * maintenance event: an import made after the rest was read.
 *
 * A helper, not a check: every `.ts` under `checks/` is a check the gate runs.
 */
import type pg from "pg";

import { weekStart, type Seeded } from "./status-seed.ts";

export const TIMEZONE = "Asia/Singapore";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The superadmin, acting for birch, and alder's admin, acting for alder. */
export const SUPERADMIN = "root@knowledge.example.test";
export const MEMBER = "member@knowledge.example.test";

const SHARED = "zz-platform";
type Shelf = typeof SHARED | "alder" | "birch" | "cedar";
type Kind = "decision" | "design" | "process" | "knowledge" | "behavior" | "style";
type Origin = "work" | "platform";

/** When something happened: `back` weeks before the running one, `day` and `hour` into that week. */
interface At { back: number; day: number; hour: number }
interface Lesson extends At { shelf: Shelf; kind: Kind; superseded?: boolean; event: "exact" | "legacy" | null; origin?: Origin }
/** `count` successful `core:knowledge_add` calls by a caller in `team`, a second apart. */
interface AddCalls extends At { team: Shelf; scope: "team" | "platform"; origin: Origin; count: number }
/** One search; `returned` is how many results it found, `broadened` absent when null. */
interface Search extends At { team: Shelf; question: string; returned: number; broadened: boolean | null; origin?: Origin }

const at = (back: number, day: number, hour: number): At => ({ back, day, hour });
const lessons = (n: number, base: Omit<Lesson, "kind">, kinds: Kind[], superseded: number[] = []): Lesson[] =>
  Array.from({ length: n }, (_, i) => ({ ...base, hour: base.hour + i / 3600, kind: kinds[i], superseded: superseded.includes(i) }));

const LESSONS: readonly Lesson[] = [
  ...lessons(2, { shelf: "alder", ...at(27, 1, 10), event: "legacy" }, ["decision", "decision"], [1]),
  ...lessons(5, { shelf: SHARED, ...at(3, 2, 10), event: "legacy" }, ["process", "process", "process", "knowledge", "knowledge"], [0, 3]),
  { shelf: SHARED, ...at(3, 2, 15), kind: "design", event: "legacy" },
  { shelf: "alder", ...at(3, 2, 16), kind: "decision", event: "legacy" },
  { shelf: "birch", ...at(2, 1, 11), kind: "behavior", event: "exact", origin: "work" },
  { shelf: "cedar", ...at(2, 1, 12), kind: "style", event: null },
  ...lessons(3, { shelf: "alder", ...at(1, 3, 9), event: "exact", origin: "platform" }, ["decision", "decision", "decision"], [2]),
  { shelf: "alder", ...at(1, 3, 14), kind: "design", event: "exact", origin: "work" },
  { shelf: "alder", ...at(1, 3, 15), kind: "process", event: null },
  ...lessons(2, { shelf: SHARED, ...at(1, 4, 10), event: null }, ["knowledge", "style"]),
  { shelf: "birch", ...at(0, 0, 0), kind: "style", event: null },
];

const ADD_CALLS: readonly AddCalls[] = [
  { team: "birch", scope: "platform", origin: "platform", ...at(3, 2, 10), count: 5 },
  { team: "birch", scope: "platform", origin: "work", ...at(3, 2, 15), count: 1 },
  { team: "alder", scope: "team", origin: "work", ...at(3, 2, 16), count: 1 },
  { team: "birch", scope: "team", origin: "work", ...at(2, 1, 11), count: 1 },
  { team: "alder", scope: "team", origin: "platform", ...at(1, 3, 9), count: 3 },
  { team: "alder", scope: "team", origin: "work", ...at(1, 3, 14), count: 1 },
];

const ROLL_BACK = "how do we roll back a migration";
const SEARCHES: readonly Search[] = [
  { team: "alder", ...at(27, 2, 10), question: "a question from long ago", returned: 0, broadened: null },
  ...Array.from({ length: 30 }, (_, i): Search => ({
    team: "cedar", ...at(4, 1, 10 + i / 3600), question: i < 11 ? `cedar question ${String(i + 1).padStart(2, "0")}` : "cedar found",
    returned: i < 11 ? 0 : 2, broadened: i >= 27,
  })),
  { team: "alder", ...at(2, 2, 10), question: ROLL_BACK, returned: 0, broadened: false },
  { team: "cedar", ...at(2, 2, 11), question: "who owns the nightly reindex", returned: 0, broadened: false },
  { team: "alder", ...at(1, 2, 10), question: "alder found two", returned: 2, broadened: false },
  { team: "alder", ...at(1, 2, 11), question: "alder found four", returned: 4, broadened: false },
  { team: "alder", ...at(1, 2, 12), question: ROLL_BACK, returned: 0, broadened: false },
  { team: "birch", ...at(1, 2, 13), question: "chargeback window for refunds", returned: 0, broadened: false },
  { team: "birch", ...at(1, 2, 14), question: "birch found one", returned: 1, broadened: true },
  { team: SHARED, ...at(1, 2, 15), question: "shared found three", returned: 3, broadened: false },
  { team: "alder", ...at(0, 0, 0), question: ROLL_BACK, returned: 0, broadened: false },
  { team: "birch", ...at(0, 0, 0), question: ROLL_BACK, returned: 0, broadened: false },
  { team: "alder", ...at(1, 2, 16), question: "maintenance probe question", returned: 0, broadened: false, origin: "platform" },
];

const ADDED: readonly Lesson[] = lessons(4, { shelf: "cedar", ...at(0, 0, 0), event: "exact", origin: "platform" },
  ["decision", "design", "process", "knowledge"]);

/** What the seed gave ids to, for `seedAddedImport`. */
export interface KnowledgeSeeded extends Seeded { teams: Map<string, string>; person: string }

/** Seeds the people, the four teams and everything above into `db`, which must hold no other lesson, search or
 *  call, cutting weeks in `timezone`, the gateway's `ZZ_TZ`. */
export async function seedKnowledgeHealth(db: pg.ClientBase, timezone: string, now = Date.now()): Promise<KnowledgeSeeded> {
  const one = async (text: string, values: unknown[]): Promise<string> => (await db.query<{ id: string }>(text, values)).rows[0].id;
  const root = await one("insert into zz.principal (email, display_name, role) values ($1, 'root', 'superadmin') returning id::text as id", [SUPERADMIN]);
  const member = await one("insert into zz.principal (email, display_name, role) values ($1, 'member', 'member') returning id::text as id", [MEMBER]);
  const teams = new Map<string, string>();
  for (const slug of [SHARED, "alder", "birch", "cedar"]) {
    await db.query("insert into zz.team (slug, name, created_by) select $1, $1, $2 where not exists (select 1 from zz.team where slug = $1)",
      [slug, root]);
    teams.set(slug, await one("select id::text as id from zz.team where slug = $1", [slug]));
  }
  for (const [team, person] of [["alder", member], ["birch", root]]) {
    await db.query("insert into zz.membership (team_id, principal_id, role, added_by) values ($1, $2, 'admin', $3)", [teams.get(team), person, root]);
    await db.query("update zz.principal set active_team_id = $1 where id = $2", [teams.get(team), person]);
  }
  const starts = new Map<number, number>();
  for (let back = 0; back <= 28; back++) starts.set(back, weekStart(now, back, timezone));
  const s: KnowledgeSeeded = { now, timezone, starts, teams, person: member };

  // The record begins: one real-work call.
  await event(db, s, at(28, 0, 1), "tool_call", "core:document_read", {}, "work", "alder", "core:document_read", true);
  for (const c of ADD_CALLS) {
    for (let i = 0; i < c.count; i++) {
      await event(db, s, { ...c, hour: c.hour + i / 3600 }, "tool_call", "core:knowledge_add",
        { client: c.origin === "platform" ? "zz-migrate" : "claude-code", ids: { scope: c.scope, type: "decision" } }, c.origin, c.team, "core:knowledge_add", true);
    }
  }
  await writeLessons(db, s, LESSONS);
  for (const q of SEARCHES) {
    const returned = Array.from({ length: q.returned }, (_, i) => `team:2026-09-01-seeded/_knowledge/nodes/${String(i + 1).padStart(4, "0")}-seeded.md`);
    await event(db, s, q, "knowledge.search", q.question,
      { returned, ranked_total: q.returned, filters: {}, ...(q.broadened === null ? {} : { broadened: q.broadened }) }, q.origin ?? "work", q.team);
  }
  await event(db, s, at(1, 2, 17), "tool_call", "core:knowledge_search", {}, "work", "alder", "core:knowledge_search", false);
  return s;
}

/** Adds the import made after the rest was read: four lessons on cedar in the running week, each named exactly by a
 *  maintenance event. */
export async function seedAddedImport(db: pg.ClientBase, s: KnowledgeSeeded): Promise<void> {
  await writeLessons(db, s, ADDED);
}

const instant = (s: Seeded, a: At): string => new Date(s.starts.get(a.back)! + a.day * DAY + Math.round(a.hour * HOUR)).toISOString();

function event(db: pg.ClientBase, s: KnowledgeSeeded, a: At, kind: string, subject: string, detail: object, origin: Origin,
               team: Shelf, tool: string | null = null, ok: boolean | null = null) {
  return db.query(
    `insert into zz.event (ts, kind, subject, detail, origin, team_id, actor_id, tool_key, ok, refusal_owner, refusal)
     values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, case when $9 = false then 'theirs' end, case when $9 = false then 'seeded refusal' end)`,
    [instant(s, a), kind, subject, JSON.stringify(detail), origin, s.teams.get(team), s.person, tool, ok]);
}

/** Writes each lesson with the next ordinal on its shelf and its event, then supersedes those marked, each by the
 *  lesson written after it on its shelf. */
async function writeLessons(db: pg.ClientBase, s: KnowledgeSeeded, list: readonly Lesson[]): Promise<void> {
  const ids: string[] = [];
  for (const l of list) {
    const team = s.teams.get(l.shelf)!;
    const { rows: [{ ordinal }] } = await db.query<{ ordinal: string }>(
      "select lpad((coalesce(max(node_ordinal::int), 0) + 1)::text, 4, '0') as ordinal from zz.knowledge_node where team_id = $1", [team]);
    const { rows: [{ id }] } = await db.query<{ id: string }>(
      `insert into zz.knowledge_node (kind, title, body, team_id, node_ordinal, slug, created_at)
       values ($1, 'seeded', 'seeded', $2, $3, $4, $5) returning id::text as id`, [l.kind, team, ordinal, `seeded-${ordinal}`, instant(s, l)]);
    ids.push(id);
    if (l.event !== null) {
      await event(db, s, l, "knowledge.add", ordinal,
        { title: "seeded", type: l.kind, scope: "team", ...(l.event === "exact" ? { ids: { node: id } } : {}) }, l.origin ?? "work", l.shelf);
    }
  }
  for (const [i, l] of list.entries()) {
    if (!l.superseded) continue;
    // The lesson that supersedes it is the next one written on the same shelf that is not itself
    // superseded — never an earlier one, which would seed a chain running backwards.
    const by = list.findIndex((x, j) => j > i && x.shelf === l.shelf && !x.superseded);
    if (by === -1) {
      throw new Error(`seeded lesson ${i} on ${l.shelf} is marked superseded with no lesson after it to supersede it`);
    }
    await db.query("update zz.knowledge_node set lifecycle = 'superseded', superseded_by_id = $2 where id = $1", [ids[i], ids[by]]);
  }
}
