#!/usr/bin/env node
/**
 * checks/console-platform-teams.ts — Teams is the superadmin's: every team with its counts against its own past, and
 * one team's page, through the gateway's own identity gate, routes and writes on a real database (AC-4.1).
 *
 *   node checks/console-platform-teams.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL migrated by the real runner, seeds what `scripts/schema/fleet-seed.ts` declares,
 * and serves the gateway's built identity middleware, `services/gateway/dist/console/teams.js` and the console's team
 * and platform settings from this process, signed in with real console session cookies. What it establishes, against
 * the seed's written values:
 *
 *   - a member is refused 403 `not permitted` on the list and on any team's page, known or not, before anything is
 *     read: with `zz.knowledge_node` gone the refusal is the same; no session is 401;
 *   - over an empty platform every team reads no week drawn, its last two weeks unavailable and no last activity;
 *   - over more than four teams the list answers its tiles over every team and, per team, what Teams draws and
 *     nothing else: the team, its memberships, open work, waiting, standing lessons, sessions by week (26 at most, the
 *     running week not complete), calls in the last two complete weeks and the latest real-work call, sorted by it, a
 *     team with none last and the slug breaking a tie; `q` and `status` filter, the page keeps the total, and a value
 *     the read does not take is 400;
 *   - each team's waiting equals `pendingRevisions` at the read's own cutoff, each revision once, and the pending tile
 *     is all of them;
 *   - a team's page answers its team, members, tiles and calls by week and nothing else, and its tiles equal its
 *     row's in the list; a slug no team has is 404 with no body;
 *   - maintenance calls, page views and calls in no team change no figure;
 *   - through the real routes the superadmin creates a team, adds and removes a member and archives it, the read
 *     following each, each act writing its event once; adding a deactivated person is refused and writes nothing;
 *   - a failed read of the revisions waiting is 500 with nothing partial;
 *   - every answer agrees in shape with the console's fake one, key set by key set.
 *
 * The only database it touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import type { Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Express, RequestHandler } from "express";
import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import {
  DEACTIVATED, EXPECTED, MEMBER, NEWCOMER, SUPERADMIN, TEAMS, seedFleet, seedFleetPeople, type Slug,
} from "../scripts/schema/fleet-seed.ts";
import { signIn, weekStart, type Seeded } from "../scripts/schema/status-seed.ts";
import { withThrowawayDb } from "../scripts/schema/throwaway.ts";
import { shapeDiffs } from "../scripts/schema/shape-diffs.ts";

const NAME = "console-platform-teams";
const DONE = "console-platform-teams: the superadmin reads every team's counts against its own past and each team's page, " +
  "a member is refused before anything is read, and the writes keep their routes and events, in the fake's shapes: ok";
const TIMEZONE = "Pacific/Auckland";
/** COUPLED: the fake answer in the console's checkout, `../zz-stack-dashboard` here and in CI. */
const FAKE = join(root, "..", "zz-stack-dashboard", "scripts", "fake-gateway", "platform-teams.ts");
const REFUSED = JSON.stringify({ error: "not permitted" });

/** What Teams draws of a row, and what a team's page draws: an answer holds these keys and no other. */
const ROW_KEYS = ["calls", "created", "lastActive", "lessons", "name", "openWork", "people", "sessions", "slug", "status", "waiting"];
const DETAIL_KEYS = ["calls", "members", "meta", "team", "tiles"];
/** The seed's written values a row reads; the seed writes more, which no page reads and the read no longer answers. */
const SEEDED = ["name", "status", "created", "people", "openWork", "waiting", "lessons"] as const;

class CaseFailure extends Error {}
function fail(step: string, detail: string): never {
  throw new CaseFailure(`${NAME}: FAILED at "${step}": ${detail}`);
}
const pass = (line: string): void => console.log(`  ok  ${line}`);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const keys = (v: unknown): string => (isObj(v) ? Object.keys(v).sort().join(",") : `not an object: ${JSON.stringify(v)}`);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(sortDeep(a)) === JSON.stringify(sortDeep(b));
function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
  return v;
}

interface Answer { status: number; body: Obj; text: string }
type Get = (path: string, email: string) => Promise<Answer>;
type Send = (method: "POST" | "DELETE", path: string, email: string, body: Obj) => Promise<Answer>;

/** A list answer's rows, or a failure naming what came instead. */
function rowsOf(step: string, a: Answer): Obj[] {
  if (a.status !== 200 || !Array.isArray(a.body.teams)) fail(step, `answered ${a.status}: ${a.text.slice(0, 400)}`);
  return a.body.teams as Obj[];
}

/** A week's figure as the read must answer it: a count that stands, or unavailable. */
const counted = (n: number) => ({ figure: { value: n, why: null }, numerator: n, denominator: null });
const unavailable = { figure: { value: null, why: "unavailable" }, numerator: null, denominator: null };

/** The first instant of the week `back` weeks before the running one; -1 is the week after it. */
const startOf = (s: Seeded, back: number): number => s.starts.get(back) ?? weekStart(s.now, back, TIMEZONE);

/** The week `back` weeks before the running one as a window, observed from where the record begins. */
function windowAt(s: Seeded, back: number, asOf: string) {
  const from = iso(startOf(s, back)), to = iso(startOf(s, back - 1));
  return { from, to, observedFrom: from, observedThrough: back === 0 ? asOf : to, complete: back > 0 };
}

/** The 26 weeks a team's series must hold, oldest first, `of` 0 for sessions and 1 for calls. */
function series(s: Seeded, team: Slug, of: 0 | 1, asOf: string): Obj[] {
  return Array.from({ length: EXPECTED.drawn }, (_, i) => {
    const back = EXPECTED.firstDrawn - i;
    return { window: windowAt(s, back, asOf), ...counted(EXPECTED.weeks[team][back]?.[of] ?? 0) };
  });
}

/** Everything a row of `team` must read, from the seed's written values. */
function wantRow(s: Seeded, team: Slug, asOf: string): Obj {
  const last = EXPECTED.lastActive[team];
  return {
    slug: team, ...Object.fromEntries(SEEDED.map((k) => [k, EXPECTED.rows[team][k]])), sessions: series(s, team, 0, asOf),
    calls: {
      last: { window: windowAt(s, 1, asOf), ...counted(EXPECTED.weeks[team][1]?.[1] ?? 0) },
      previous: { window: windowAt(s, 2, asOf), ...counted(EXPECTED.weeks[team][2]?.[1] ?? 0) },
    },
    lastActive: last === null ? null : iso(startOf(s, last[0]) + last[1]),
  };
}

async function refusalCases(db: pg.Client, get: Get, fetchAs: (h: Record<string, string>, path: string) => Promise<Answer>): Promise<void> {
  const step = "a member is refused before anything is read";
  const paths = ["/teams", "/teams?limit=100&scope=platform", "/teams/alder", "/teams/birch", "/teams/no-such-team"];
  for (const path of paths) {
    const a = await get(path, MEMBER);
    if (a.status !== 403 || a.text !== REFUSED) fail(step, `${path} answered ${a.status}: ${a.text.slice(0, 200)}`);
  }
  // A table the reads need and the identity gate does not: renamed, any read would fail.
  await db.query("alter table zz.knowledge_node rename to knowledge_node_hidden");
  try {
    for (const path of paths) {
      const a = await get(path, MEMBER);
      if (a.status !== 403 || a.text !== REFUSED) fail(step, `${path} with zz.knowledge_node gone answered ${a.status}: ${a.text.slice(0, 200)}`);
    }
  } finally {
    await db.query("alter table zz.knowledge_node_hidden rename to knowledge_node");
  }
  const none = await fetchAs({}, "/teams");
  if (none.status !== 401) fail(step, `no session answered ${none.status}`);
  pass("a member, alder's own admin, reads 403 `not permitted` and nothing else on the list and every team's page, known " +
       "or not, with zz.knowledge_node gone too; no session is 401");
}

async function emptyCases(get: Get): Promise<void> {
  const step = "an empty platform";
  const a = await get("/teams", SUPERADMIN);
  const rows = rowsOf(step, a);
  const now = Date.now();
  const window = (back: number) =>
    ({ from: iso(weekStart(now, back, TIMEZONE)), to: iso(weekStart(now, back - 1, TIMEZONE)), observedFrom: null, observedThrough: null, complete: false });
  if (rows.length !== 6 || !same(a.body.tiles, { teams: 6, openWork: 0, pending: 0, lessons: 0 }) || (a.body.meta as Obj).coverageFrom !== null) {
    fail(step, a.text.slice(0, 400));
  }
  for (const r of rows) {
    const want = { last: { window: window(1), ...unavailable }, previous: { window: window(2), ...unavailable } };
    if (!same(r.sessions, []) || !same(r.calls, want) || r.lastActive !== null || r.waiting !== 0) fail(step, `${String(r.slug)} reads ${JSON.stringify(r)}`);
  }
  pass("over six teams and no call, every row draws no week, its last two weeks unavailable before the record, and no last activity");
}

async function listCases(s: Seeded, get: Get, pending: (asOf: string) => Promise<{ team: string }[]>): Promise<Answer> {
  let step = "the list";
  const a = await get("/teams", SUPERADMIN);
  const rows = rowsOf(step, a);
  const asOf = String((a.body.meta as Obj).asOf);
  if (rows.map((r) => r.slug).join() !== EXPECTED.order.join() || a.body.total !== 6) {
    fail(step, `lists ${rows.map((r) => String(r.slug)).join(", ")} of ${String(a.body.total)}, not ${EXPECTED.order.join(", ")} of 6`);
  }
  for (const r of rows) {
    if (keys(r) !== ROW_KEYS.join()) fail(step, `${String(r.slug)} has keys ${keys(r)}`);
    const want = wantRow(s, r.slug as Slug, asOf);
    if (!same(r, want)) fail(step, `${String(r.slug)} reads\n${JSON.stringify(sortDeep(r))}\nnot\n${JSON.stringify(sortDeep(want))}`);
  }
  pass("six teams, latest real-work call first and dune before fir with none, each with its team, memberships, open " +
       "work, waiting, standing lessons, 26 weeks of sessions from back 25 (the running one not complete), its calls in " +
       "L and L-1 and its latest call, as the seed writes them out, and no field Teams does not draw");

  step = "the tiles and meta";
  const meta = a.body.meta as Obj;
  if (!same(a.body.tiles, EXPECTED.tiles)) fail(step, `tiles read ${JSON.stringify(a.body.tiles)}`);
  if (meta.scope !== "platform-admin" || meta.timezone !== TIMEZONE || meta.coverageFrom !== iso(startOf(s, EXPECTED.recordBegins))
      || !isObj(meta.period) || meta.period.from !== iso(startOf(s, EXPECTED.firstDrawn)) || meta.period.to !== asOf) {
    fail(step, JSON.stringify(meta));
  }
  pass("the tiles count 6 teams, 6 open initiatives, 4 revisions waiting and 7 standing lessons; meta reads platform-admin " +
       "from the record's first call, its period the weeks drawn");

  step = "waiting is the pending-revision query's";
  const byTeam = new Map<string, number>();
  const waiting = await pending(asOf);
  for (const p of waiting) byTeam.set(p.team, (byTeam.get(p.team) ?? 0) + 1);
  for (const r of rows) {
    if (r.waiting !== (byTeam.get(String(r.slug)) ?? 0)) fail(step, `${String(r.slug)} waits ${String(r.waiting)}, pendingRevisions ${byTeam.get(String(r.slug)) ?? 0}`);
  }
  if (a.body.tiles === null || (a.body.tiles as Obj).pending !== waiting.length) fail(step, `pending tile ${JSON.stringify(a.body.tiles)}, query ${waiting.length}`);
  pass(`each team's waiting is its rows of pendingRevisions at the read's cutoff, and the pending tile all ${waiting.length} of them`);

  step = "filters and pages";
  for (const [query, [want, total]] of Object.entries(EXPECTED.filtered)) {
    const f = await get(`/teams?${query}`, SUPERADMIN);
    const got = rowsOf(`${step}: ${query}`, f).map((r) => String(r.slug));
    if (got.join() !== want.join() || f.body.total !== total) fail(step, `?${query} lists ${got.join(", ")} of ${String(f.body.total)}, not ${want.join(", ")} of ${total}`);
    if (!same(f.body.tiles, EXPECTED.tiles)) fail(step, `?${query} moved the tiles: ${JSON.stringify(f.body.tiles)}`);
  }
  const first = await get("/teams?limit=1", SUPERADMIN);
  if (rowsOf(step, first).length !== 1 || first.body.total !== 6) fail(step, `limit=1 answered ${first.text.slice(0, 200)}`);
  for (const bad of ["status=closed", "status=Active", "limit=0", "limit=101", "limit=2.5", "offset=-1", "q=a&q=b", "status=active&status=archived"]) {
    const b = await get(`/teams?${bad}`, SUPERADMIN);
    if (b.status !== 400 || keys(b.body) !== "error") fail(step, `?${bad} answered ${b.status}: ${b.text.slice(0, 200)}`);
  }
  const hundred = await get("/teams?limit=100", SUPERADMIN);
  if (rowsOf(step, hundred).length !== 6) fail(step, `limit=100 answered ${hundred.text.slice(0, 200)}`);
  pass("q matches a slug or a name in any case, status narrows to one state, a page keeps the total and the tiles, and an " +
       "unknown status, a page out of range or a repeated parameter is 400");
  return a;
}

async function detailCases(s: Seeded, get: Get, list: Answer): Promise<Answer> {
  const step = "a team's page";
  const listed = new Map((list.body.teams as Obj[]).map((r) => [String(r.slug), r]));
  let alder: Answer | null = null;
  // Every membership was written today, in the reporting timezone's calendar; en-CA formats as YYYY-MM-DD.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(new Date());
  for (const team of EXPECTED.order) {
    const a = await get(`/teams/${team}`, SUPERADMIN);
    if (a.status !== 200 || keys(a.body) !== DETAIL_KEYS.join()) fail(step, `${team} answered ${a.status}: ${a.text.slice(0, 300)}`);
    const asOf = String((a.body.meta as Obj).asOf);
    const row = wantRow(s, team, asOf);
    const t = TEAMS[team];
    const want = {
      team: { slug: team, name: t.name, status: t.status, created: EXPECTED.rows[team].created },
      members: EXPECTED.members[team].map(([email, role]) => ({ email, name: email.split("@")[0], role, joined: today })),
      tiles: { people: row.people, openWork: row.openWork, waiting: row.waiting, lessons: row.lessons },
      calls: series(s, team, 1, asOf),
    };
    if (!same({ ...a.body, meta: null }, { ...want, meta: null })) {
      fail(step, `${team} reads\n${JSON.stringify(sortDeep({ ...a.body, meta: null }))}\nnot\n${JSON.stringify(sortDeep(want))}`);
    }
    const r = listed.get(team)!;
    if (!same(a.body.tiles, { people: r.people, openWork: r.openWork, waiting: r.waiting, lessons: r.lessons })) {
      fail(step, `${team}'s tiles differ from its row in the list: ${JSON.stringify(a.body.tiles)}`);
    }
    if ((a.body.meta as Obj).scope !== "platform-admin") fail(step, `${team}'s meta reads ${JSON.stringify(a.body.meta)}`);
    if (team === "alder") alder = a;
  }
  for (const path of ["/teams/no-such-team", "/teams/ALDER", "/teams/%20alder"]) {
    const a = await get(path, SUPERADMIN);
    if (a.status !== 404 || a.text !== "") fail(step, `${path} answered ${a.status}: ${a.text.slice(0, 200)}`);
  }
  pass("each team's page reads its team, its members by role then email, its tiles and 26 weeks of calls and nothing " +
       "else, and its tiles are its row's in the list; a slug no team has is 404 with no body");
  return alder!;
}

async function noiseCases(db: pg.Client, get: Get, list: Answer): Promise<void> {
  const step = "maintenance calls and page views change nothing";
  const ts = new Date(Date.now() - 2_000).toISOString();
  await db.query(
    `insert into zz.event (ts, kind, subject, ok, tool_key, origin, team_id, session)
     select $1::timestamptz, 'tool_call', 'core:document_read', true, 'core:document_read', 'platform', t.id, 'late'
       from zz.team t where t.slug in ('dune', 'cedar', 'fir')`, [ts]);
  await db.query(
    `insert into zz.event (ts, kind, subject, detail, origin, team_id, session)
     select $1::timestamptz, 'console.page_view', 'platform.teams', '{}'::jsonb, 'work', t.id, 'late' from zz.team t`, [ts]);
  await db.query(
    "insert into zz.event (ts, kind, subject, ok, tool_key, origin, session) values ($1, 'tool_call', 'core:whoami', true, 'core:whoami', 'work', 'late')",
    [ts]);
  const again = await get("/teams", SUPERADMIN);
  const running = (b: Obj) => sortDeep({ ...b, meta: null, teams: (b.teams as Obj[]).map((r) => ({
    ...r, sessions: (r.sessions as Obj[]).map((w) => ({ ...w, window: { ...(w.window as Obj), observedThrough: null } })),
  })) });
  if (!same(running(again.body), running(list.body))) fail(step, `the list moved: ${again.text.slice(0, 400)}`);
  pass("a maintenance call in three teams, a page view in every team and a real-work call in no team, all newer than " +
       "every team's latest, move no figure, tile or order");
}

async function writeCases(db: pg.Client, get: Get, send: Send): Promise<void> {
  let step = "the superadmin creates a team";
  const created = await send("POST", "/settings/platform/teams", SUPERADMIN, { slug: "grove", name: "Grove Labs" });
  if (created.status !== 200) fail(step, `answered ${created.status}: ${created.text.slice(0, 200)}`);
  const row = async (): Promise<Obj | undefined> => rowsOf(step, await get("/teams?q=grove", SUPERADMIN))[0];
  const detail = async (): Promise<Obj> => (await get("/teams/grove", SUPERADMIN)).body;
  let r = await row();
  if (!r || r.status !== "active" || r.people !== 0 || r.lastActive !== null || (await get("/teams", SUPERADMIN)).body.total !== 7) {
    fail(step, `the list reads ${JSON.stringify(r)}`);
  }
  pass("the superadmin creates grove through the console's route, and the list reads it active, with nobody in it and no activity");

  step = "the superadmin adds a member";
  const added = await send("POST", "/settings/team/members", SUPERADMIN, { team: "grove", email: NEWCOMER });
  if (added.status !== 200) fail(step, `answered ${added.status}: ${added.text.slice(0, 200)}`);
  r = await row();
  const members = (await detail()).members as Obj[];
  if (r?.people !== 1 || members.length !== 1 || members[0].email !== NEWCOMER || members[0].role !== "member") {
    fail(step, `the reads say ${JSON.stringify(r)} and ${JSON.stringify(members)}`);
  }
  const guarded = await send("POST", "/settings/team/members", MEMBER, { team: "grove", email: SUPERADMIN });
  if (guarded.status !== 403) fail(step, `alder's admin adding to grove answered ${guarded.status}: ${guarded.text.slice(0, 200)}`);
  pass("adding dana makes grove's row and page read one member; alder's admin adding to grove is still refused 403");

  step = "a deactivated person is refused";
  const refused = await send("POST", "/settings/team/members", SUPERADMIN, { team: "grove", email: DEACTIVATED });
  if (refused.status !== 400 || !/deactivated/.test(String(refused.body.error))) fail(step, `answered ${refused.status}: ${refused.text.slice(0, 200)}`);
  if ((await row())?.people !== 1) fail(step, "grove's row moved");
  pass(`adding ${DEACTIVATED}, deactivated, answers 400 saying so, and grove still reads one member`);

  step = "the superadmin removes the member";
  const removed = await send("DELETE", "/settings/team/members", SUPERADMIN, { team: "grove", email: NEWCOMER, confirm: "grove" });
  if (removed.status !== 200) fail(step, `answered ${removed.status}: ${removed.text.slice(0, 200)}`);
  if ((await row())?.people !== 0 || ((await detail()).members as Obj[]).length !== 0) fail(step, "grove still reads a member");
  pass("removing dana makes grove's row and page read nobody");

  step = "the superadmin archives the team";
  const archived = await send("DELETE", "/settings/platform/teams", SUPERADMIN, { team: "grove", confirm: "grove" });
  if (archived.status !== 200) fail(step, `answered ${archived.status}: ${archived.text.slice(0, 200)}`);
  const archivedRows = rowsOf(step, await get("/teams?status=archived", SUPERADMIN)).map((x) => String(x.slug));
  if ((await row())?.status !== "archived" || archivedRows.join() !== "cedar,grove") fail(step, `archived lists ${archivedRows.join(", ")}`);
  pass("archiving grove makes its row read archived, listed with cedar under status=archived");

  step = "each act writes its event once";
  const want = ["admin.add_member", "admin.archive_team", "admin.create_team", "admin.remove_member"];
  let kinds: string[] = [];
  for (let i = 0; i < 50 && kinds.length < want.length; i++) {
    if (i) await new Promise((resolve) => setTimeout(resolve, 100));
    kinds = (await db.query<{ kind: string; via: string | null }>(
      "select kind, detail->>'via' as via from zz.event where kind like 'admin.%' order by kind")).rows.map((e) => `${e.kind}/${String(e.via)}`);
  }
  if (kinds.join() !== want.map((k) => `${k}/web`).join()) fail(step, `events read ${kinds.join(", ")}`);
  pass("create, add, remove and archive each wrote one admin event marked from the web, and the refused add none");
}

async function run(db: pg.Client, url: string): Promise<void> {
  await seedFleetPeople(db);
  const cookie = new Map<string, string>();
  for (const email of [MEMBER, SUPERADMIN]) cookie.set(email, await signIn(db, email));

  process.env.TEAM_DB_URL = url;
  process.env.ZZ_TZ = TIMEZONE;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  const load = (p: string) => import(pathToFileURL(join(root, "services/gateway/dist", p)).href);
  const express = (await import("express")).default;
  const dbModule = (await load("db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await dbModule.initPlatformDb();
  const { identityMiddleware } = (await load("identity.js")) as { identityMiddleware: () => RequestHandler };
  const { mountTeams } = (await load("console/teams.js")) as { mountTeams: (app: Express) => void };
  const { pendingRevisions } = (await load("console/pending.js")) as { pendingRevisions: (asOf: string) => Promise<{ team: string }[]> };
  const { mountTeamSettings } = (await load("settings/team.js")) as { mountTeamSettings: (app: Express) => void };
  const { mountPlatformSettings } = (await load("settings/platform.js")) as { mountPlatformSettings: (app: Express) => void };
  const app = express();
  // COUPLED: services/gateway/src/server.ts — the identity gate, the JSON parser, then the console's reads and its settings.
  app.use(identityMiddleware());
  app.use(express.json());
  mountTeams(app);
  mountTeamSettings(app);
  mountPlatformSettings(app);
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/console`;
  const fetchAs = async (headers: Record<string, string>, path: string, init: RequestInit = {}): Promise<Answer> => {
    const res = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) }, signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    let body: Obj = {};
    try { const v: unknown = JSON.parse(text); if (isObj(v)) body = v; } catch { /* not JSON: body stays empty */ }
    return { status: res.status, body, text };
  };
  const get: Get = (path, email) => fetchAs({ cookie: `zz_console=${cookie.get(email)}` }, path);
  const send: Send = (method, path, email, body) => fetchAs({ cookie: `zz_console=${cookie.get(email)}`, "content-type": "application/json" },
    path, { method, body: JSON.stringify(body) });

  try {
    await refusalCases(db, get, fetchAs);
    await emptyCases(get);
    const seeded = await seedFleet(db, TIMEZONE);
    const list = await listCases(seeded, get, pendingRevisions);
    const alder = await detailCases(seeded, get, list);
    await noiseCases(db, get, list);

    let step = "the shapes the console's fake answers";
    let fake: { teams: (who: Obj, q: URLSearchParams, page: { limit: number; offset: number }) => [number, unknown] | null;
                team: (who: Obj, slug: string) => [number, unknown] };
    try {
      fake = (await import(pathToFileURL(FAKE).href)) as typeof fake;
    } catch (err) {
      fail(step, `could not read the console's fake answer at ${FAKE}: ${(err as Error).message}`);
    }
    const who = { email: SUPERADMIN, name: "root", role: "superadmin", mayRead: true, superadmin: true, via: "session", teams: [], activeTeam: null };
    const diffs = [
      ...shapeDiffs(list.body, fake.teams(who, new URLSearchParams(), { limit: 10, offset: 0 })![1], "list", []),
      ...shapeDiffs(alder.body, fake.team(who, "atlas")[1], "team", []),
    ];
    if (diffs.length) fail(step, diffs.join("; "));
    pass("the list and a team's page agree in shape with the fake's, key set by key set");

    await writeCases(db, get, send);

    step = "a figure query that fails";
    await db.query("alter table zz.doc_revision rename to doc_revision_hidden");
    const quiet = console.error;
    console.error = () => undefined;
    const broken = await get("/teams", SUPERADMIN).finally(async () => {
      console.error = quiet;
      await db.query("alter table zz.doc_revision_hidden rename to doc_revision");
    });
    if (broken.status !== 500 || broken.text !== JSON.stringify({ error: "could not read the teams" })) {
      fail(step, `answered ${broken.status}: ${broken.text.slice(0, 300)}`);
    }
    pass("a read of the revisions waiting that fails answers 500, could not read the teams, and nothing else");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await dbModule.platformDb().end().catch(() => undefined);
    delete process.env.TEAM_DB_URL;
    delete process.env.ZZ_TZ;
    delete process.env.ZZ_CATALOG_DIR;
  }
}

async function main(): Promise<number> {
  let dbUrl = "";
  try {
    await withThrowawayDb((db) => run(db, dbUrl), async (u) => { dbUrl = u; });
  } catch (err) {
    if (err instanceof Error && /Docker is not running/.test(err.message)) {
      console.error(`${NAME}: Docker is not available — the check could not run, which is not a pass`);
      return 2;
    }
    console.error(err instanceof CaseFailure ? err.message : `${NAME}: ${String((err as Error)?.stack ?? err)}`);
    return 1;
  }
  console.log(DONE);
  return 0;
}

process.exitCode = await main();
