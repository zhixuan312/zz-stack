/**
 * The teams the superadmin's Teams read is answered from, seeded into a throwaway database, and the values a reader
 * must find beside them: `checks/console-platform-teams.ts` drives the gateway's own routes over them.
 *
 * Weeks are Monday to Monday in the reporting timezone, counted back from the running one (`weekStart`): `back` 0 is
 * the running week, 1 the last whole week (L), 2 the one before it, and so on. Every call runs one second apart from
 * its batch's first instant, but the running week's, which all fall on its first instant so none lies after the clock.
 *
 * `seedFleetPeople` writes the people and the six teams, and nothing else: a reader finds an empty platform over it.
 * `seedFleet` writes the rest on top:
 *
 *   - alder: three memberships; four initiatives, three open, one of them with no document; a gated `sdlc-flow` spec
 *     and plan presented and not approved (the plan's first revision approved), an explore presented, which the flow
 *     does not gate, two sources (one a plan audit's round, typed with its stage's name, which is a source by its path
 *     and not a document), a note and a closed initiative's presented spec; three standing lessons and one
 *     superseded; real-work calls in L-1, L (two of them refused) and the running week;
 *   - birch: two memberships; a review presented and not approved, a spec approved, a plan presented after the clock
 *     and a closed initiative's presented spec; two sources; two standing lessons; calls in L-2 and L, and two
 *     maintenance calls in the running week, newer than its last real-work one;
 *   - cedar: archived, one membership, one closed initiative, one standing lesson and two superseded, its only calls
 *     in back 9;
 *   - dune: nothing at all, a page view and a lesson's event aside;
 *   - elm: one membership, an open initiative with no flow and a presented spec; the first real-work call on the
 *     platform, in back 30, so the record runs 31 weeks and the read draws the last 26; calls in L-1 and one in L with
 *     no session;
 *   - fir: one membership, held by a person since deactivated; a gated spec whose second revision is presented and
 *     not approved; one standing lesson; maintenance calls in L and the running week, and no real-work call.
 *
 * Page views, a lesson's event and a real-work call in no team are written beside them, and none may move a figure.
 *
 * A helper, not a check: every `.ts` under `checks/` is a check the gate runs.
 */
import type pg from "pg";

import { weekStart, type Seeded } from "./status-seed.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The superadmin, in no team; alder's admin, who is refused; a person in no team the write round adds; and a person
 *  deactivated, whom no team may take. */
export const SUPERADMIN = "root@fleet.example.test";
export const MEMBER = "member@fleet.example.test";
export const NEWCOMER = "dana@fleet.example.test";
export const DEACTIVATED = "gone@fleet.example.test";
const ANA = "ana@fleet.example.test", BEN = "ben@fleet.example.test", CY = "cy@fleet.example.test";

export type Slug = "alder" | "birch" | "cedar" | "dune" | "elm" | "fir";

/** Each team, its name, its state, the instant it was created and who is in it. */
export const TEAMS: Readonly<Record<Slug, { name: string; status: "active" | "archived"; createdAt: string; members: [string, "admin" | "member"][] }>> = {
  alder: { name: "Alder Works", status: "active", createdAt: "2026-03-02T00:00:00Z", members: [[MEMBER, "admin"], [ANA, "member"], [BEN, "member"]] },
  birch: { name: "Birch Bank", status: "active", createdAt: "2026-04-06T00:00:00Z", members: [[ANA, "admin"], [CY, "member"]] },
  cedar: { name: "Cedar Field", status: "archived", createdAt: "2025-11-03T00:00:00Z", members: [[BEN, "member"]] },
  dune: { name: "Dune", status: "active", createdAt: "2026-10-01T00:00:00Z", members: [] },
  elm: { name: "Elm Street", status: "active", createdAt: "2026-01-12T00:00:00Z", members: [[CY, "admin"]] },
  fir: { name: "Fir Analytics", status: "active", createdAt: "2026-02-09T00:00:00Z", members: [[DEACTIVATED, "member"]] },
};

/** One batch of tool calls: `back` weeks before the running one and `offsetMs` into it, one call per entry of
 *  `sessions` (`''` is a call with no session), the first `refused` of them refused as malformed. */
interface Calls { team: Slug | null; back: number; offsetMs: number; sessions: string[]; refused?: number; origin: "work" | "platform" }

const work = (team: Slug | null, back: number, offsetMs: number, sessions: string[], refused = 0): Calls =>
  ({ team, back, offsetMs, sessions, refused, origin: "work" });
const maintenance = (team: Slug, back: number, offsetMs: number, sessions: string[]): Calls =>
  ({ team, back, offsetMs, sessions, origin: "platform" });

const CALLS: readonly Calls[] = [
  work("elm", 30, 0, ["e1", "e1"]),
  work("cedar", 9, HOUR, ["c1", "c1", "c1", "c1", "c1", "c1", "c1"]),
  work("birch", 3, HOUR, ["b1", "b1", "b1", "b1"]),
  work("alder", 2, DAY, ["a1", "a1", "a2", "a2", "a3", ""]),
  work("elm", 2, 2 * DAY, ["e2", "e2"]),
  work("alder", 1, DAY, ["a4", "a4", "a4", "a4", "a5", "a5", "a5", "a5", "", ""], 2),
  work("birch", 1, 3 * DAY, ["b2", "b2", "b3", "b3", "b3"]),
  work("elm", 1, 5 * DAY, [""]),
  work("alder", 0, 0, ["a6", "a6", "a6"]),
  work(null, 0, 0, ["n1"]),
  maintenance("birch", 0, 0, ["m1", "m2"]),
  maintenance("fir", 1, DAY, ["m3", "m3", "m4"]),
  maintenance("fir", 0, 0, ["m5"]),
];

/** What a reader must find, written out by hand from the lists above and not computed from them. */
export const EXPECTED = {
  /** Over every team, whatever a filter narrows the rows to. */
  tiles: { teams: 6, openWork: 6, pending: 4, lessons: 7 },
  /** Latest real-work call first, a team with none last, the slug breaking a tie. */
  order: ["alder", "elm", "birch", "cedar", "dune", "fir"] as Slug[],
  rows: {
    alder: { name: "Alder Works", status: "active", created: "2026-03-02", people: 3, openWork: 3, waiting: 2, lessons: 3 },
    birch: { name: "Birch Bank", status: "active", created: "2026-04-06", people: 2, openWork: 1, waiting: 1, lessons: 2 },
    cedar: { name: "Cedar Field", status: "archived", created: "2025-11-03", people: 1, openWork: 0, waiting: 0, lessons: 1 },
    dune: { name: "Dune", status: "active", created: "2026-10-01", people: 0, openWork: 0, waiting: 0, lessons: 0 },
    elm: { name: "Elm Street", status: "active", created: "2026-01-12", people: 1, openWork: 1, waiting: 0, lessons: 0 },
    fir: { name: "Fir Analytics", status: "active", created: "2026-02-09", people: 1, openWork: 1, waiting: 1, lessons: 1 },
  } as Record<Slug, Record<string, string | number>>,
  /** Each team's latest real-work call as `[back, ms into that week]`, null for none. */
  lastActive: { alder: [0, 0], elm: [1, 5 * DAY], birch: [1, 3 * DAY + 4_000], cedar: [9, HOUR + 6_000], dune: null, fir: null } as
    Record<Slug, [number, number] | null>,
  /** Real-work `[sessions, calls]` by `back` in the 26 weeks drawn; every week not named holds none. Elm's calls in
   *  back 30 are before the 26. */
  weeks: {
    alder: { 2: [3, 6], 1: [2, 10], 0: [1, 3] }, birch: { 3: [1, 4], 1: [2, 5] }, cedar: { 9: [1, 7] }, dune: {},
    elm: { 2: [1, 2], 1: [0, 1] }, fir: {},
  } as Record<Slug, Record<number, [number, number]>>,
  /** The weeks drawn, from back 25 through the running one; the record begins on back 30's first instant. */
  drawn: 26, firstDrawn: 25, recordBegins: 30,
  /** Each team's members as its page lists them: by role, then email. */
  members: {
    alder: [[MEMBER, "admin"], [ANA, "member"], [BEN, "member"]], birch: [[ANA, "admin"], [CY, "member"]], cedar: [[BEN, "member"]],
    dune: [], elm: [[CY, "admin"]], fir: [[DEACTIVATED, "member"]],
  } as Record<Slug, [string, string][]>,
  /** The rows narrowed, by query string, in order, and the total each answers. */
  filtered: {
    "q=works": [["alder"], 1], "q=IR": [["birch", "fir"], 2], "status=archived": [["cedar"], 1],
    "status=active&q=e": [["alder", "elm", "dune"], 3], "limit=2&offset=1": [["elm", "birch"], 6], "q=%20Fir%20": [["fir"], 1],
  } as Record<string, [Slug[], number]>,
} as const;

const one = async (db: pg.ClientBase | pg.Pool, sql: string, args: unknown[]): Promise<string> =>
  (await db.query<{ id: string }>(sql, args)).rows[0].id;

/** Seeds the seven people and the six teams with their memberships, MEMBER acting for alder. Nothing a figure counts. */
export async function seedFleetPeople(db: pg.ClientBase | pg.Pool): Promise<void> {
  for (const email of [SUPERADMIN, MEMBER, NEWCOMER, DEACTIVATED, ANA, BEN, CY]) {
    await db.query("insert into zz.principal (email, display_name, role) values ($1, $2, $3)",
      [email, email.split("@")[0], email === SUPERADMIN ? "superadmin" : "member"]);
  }
  const root = await one(db, "select id from zz.principal where email = $1", [SUPERADMIN]);
  for (const [slug, t] of Object.entries(TEAMS)) {
    const team = await one(db, "insert into zz.team (slug, name, status, created_by, created_at) values ($1, $2, $3, $4, $5) returning id",
      [slug, t.name, t.status, root, t.createdAt]);
    for (const [email, role] of t.members) {
      await db.query(
        "insert into zz.membership (team_id, principal_id, role, added_by) select $1, id, $3, $4 from zz.principal where email = $2",
        [team, email, role, root]);
    }
  }
  await db.query("update zz.principal set active_team_id = (select id from zz.team where slug = 'alder') where email = $1", [MEMBER]);
  await db.query("update zz.principal set status = 'deactivated' where email = $1", [DEACTIVATED]);
}

/**
 * Seeds every row above on top of `seedFleetPeople`, cutting weeks in `timezone`, the gateway's `ZZ_TZ`. Returns each
 * week's first instant by `back`, 0 to 30. The database must hold no other tool call or document.
 */
export async function seedFleet(db: pg.ClientBase | pg.Pool, timezone: string, now = Date.now()): Promise<Seeded> {
  const starts = new Map<number, number>();
  for (let back = 0; back <= EXPECTED.recordBegins; back++) starts.set(back, weekStart(now, back, timezone));
  const team = {} as Record<Slug, string>;
  for (const slug of Object.keys(TEAMS) as Slug[]) team[slug] = await one(db, "select id from zz.team where slug = $1", [slug]);
  const member = await one(db, "select id from zz.principal where email = $1", [MEMBER]);
  const ago = (days: number): string => new Date(now - days * DAY).toISOString();

  const initiative = (slug: Slug, name: string, flow: string | null, outcome: string | null): Promise<string> => one(db,
    `insert into zz.initiative (team_id, slug, flow, opened_by, opened_at, closed_at, closed_by, outcome)
     values ($1, $2, $3, $4, $5, case when $6::text is null then null else $7::timestamptz end,
             case when $6::text is null then null else $4::uuid end, $6)
     returning id`, [team[slug], name, flow, member, ago(60), outcome, ago(1)]);
  // A document and its revisions, each `[presented days ago | null, approved days ago | null]` (a negative day is after
  // the clock), the last current.
  const document = async (init: string, path: string, type: string, revisions: [number | null, number | null][]): Promise<void> => {
    await db.query("begin");
    await db.query("set constraints all deferred");
    const doc = await one(db,
      `insert into zz.doc (initiative_id, path, type, status, updated_at, title, body, current_revision, current_version)
       values ($1, $2, $3, 'draft', now(), $2, 'seeded', $4, $4) returning id`, [init, path, type, revisions.length]);
    for (const [i, [presented, approved]] of revisions.entries()) {
      await db.query(
        `insert into zz.doc_revision (doc_id, revision, version, content_state, title, body, tags, content_hash, written_by,
                                      written_at, approved_by, approved_at, presented_at)
         values ($1, $2, $2, 'retained', 'seeded', 'seeded', '{}', $3, $4, $5, case when $6::timestamptz is null then null else $4::uuid end,
                 $6, $7)`,
        [doc, i + 1, `hash-${doc}-${i + 1}`, member, ago(45), approved === null ? null : ago(approved), presented === null ? null : ago(presented)]);
    }
    const approvedAt = revisions.map(([, a], i) => (a === null ? 0 : i + 1)).filter(Boolean).pop() ?? null;
    await db.query("update zz.doc set approved_revision = $2, status = case when $2 = current_revision then 'approved' else 'draft' end where id = $1",
                   [doc, approvedAt]);
    await db.query("commit");
  };

  const gated = await initiative("alder", "2026-09-01-alder-gated", "sdlc-flow", null);
  await document(gated, "spec.md", "spec", [[10, null]]);
  await document(gated, "plan.md", "plan", [[20, 19], [5, null]]);
  await document(gated, "explore.md", "explore", [[30, null]]);
  await document(gated, "sources/a.md", "source", [[null, null]]);
  // A plan audit's round, filed as `source_add` files one, with its stage's name as its type: a source by its path.
  await document(gated, "sources/2026-09-10-plan-audit-round-1.md", "sdlc-plan-audit", [[null, null]]);
  await document(await initiative("alder", "2026-09-02-alder-quiet", null, null), "notes.md", "note", [[null, null]]);
  await document(await initiative("alder", "2026-09-03-alder-done", "sdlc-flow", "delivered"), "spec.md", "spec", [[30, null]]);
  await initiative("alder", "2026-09-04-alder-empty", null, null);
  const review = await initiative("birch", "2026-09-05-birch-review", "sdlc-flow", null);
  await document(review, "review.md", "review", [[3, null]]);
  await document(review, "spec.md", "spec", [[12, 11]]);
  await document(review, "plan.md", "plan", [[-1, null]]);
  await document(review, "sources/b.md", "source", [[null, null]]);
  await document(review, "sources/c.md", "source", [[null, null]]);
  await document(await initiative("birch", "2026-09-06-birch-closed", "sdlc-flow", "abandoned"), "spec.md", "spec", [[40, null]]);
  await document(await initiative("cedar", "2026-07-01-cedar-old", "sdlc-flow", "delivered"), "spec.md", "spec", [[90, null]]);
  await document(await initiative("elm", "2026-09-07-elm-noflow", null, null), "spec.md", "spec", [[8, null]]);
  await document(await initiative("fir", "2026-09-08-fir-gated", "sdlc-flow", null), "spec.md", "spec", [[15, null], [2, null]]);

  // Lessons: `standing` adopted, then `superseded` each replaced by the one before it.
  for (const [slug, standing, superseded] of [["alder", 3, 1], ["birch", 2, 0], ["cedar", 1, 2], ["fir", 1, 0]] as const) {
    let by: string | null = null;
    for (let i = 0; i < standing + superseded; i++) {
      const lifecycle = i < standing ? "adopted" : "superseded";
      const id: string = await one(db,
        `insert into zz.knowledge_node (kind, lifecycle, title, body, team_id, node_ordinal, slug, superseded_by_id)
         values ('decision', $1, 'seeded', 'seeded', $2, $3, $4, $5) returning id`,
        [lifecycle, team[slug], `n${i + 1}`, `seeded-${i + 1}`, lifecycle === "superseded" ? by : null]);
      by = id;
    }
  }

  const rows = CALLS.flatMap((c) => c.sessions.map((session, i) => ({
    ts: new Date(starts.get(c.back)! + c.offsetMs + (c.back === 0 ? 0 : i * 1000)).toISOString(),
    team: c.team === null ? null : team[c.team], session, origin: c.origin, owner: i < (c.refused ?? 0) ? "ours" : null,
  })));
  await db.query(
    `insert into zz.event (ts, kind, subject, ok, tool_key, refusal_owner, refusal, origin, team_id, actor_id, session)
     select u.ts, 'tool_call', 'core:document_read', u.owner is null, 'core:document_read', u.owner,
            case when u.owner is null then null else 'seeded refusal' end, u.origin, u.team, $6, u.session
       from unnest($1::timestamptz[], $2::uuid[], $3::text[], $4::text[], $5::text[]) as u(ts, team, session, origin, owner)`,
    [rows.map((r) => r.ts), rows.map((r) => r.team), rows.map((r) => r.session), rows.map((r) => r.origin), rows.map((r) => r.owner), member]);
  // Other kinds of event in the running week, in teams with and without calls.
  await db.query(
    `insert into zz.event (ts, kind, subject, detail, origin, team_id, actor_id, session)
     select $1::timestamptz, u.kind, 'seeded', '{}'::jsonb, 'work', u.team, $2, 'noise'
       from unnest($3::text[], $4::uuid[]) as u(kind, team)`,
    [new Date(starts.get(0)!).toISOString(), member,
     ["console.page_view", "console.page_view", "console.page_view", "knowledge.add"], [team.birch, team.fir, team.dune, team.dune]]);
  return { now, timezone, starts };
}
