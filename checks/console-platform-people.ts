#!/usr/bin/env node
/**
 * checks/console-platform-people.ts — People, the superadmin's read: each person's role, teams,
 * passkeys, last recorded sign-in and state, and the writes that add a person, give them an enrolment
 * link and deactivate them, through the gateway's own identity gate and routes on a real database
 * (AC-4.2).
 *
 *   node checks/console-platform-people.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL migrated by the real runner, seeds what
 * `scripts/schema/people-seed.ts` declares, and serves the gateway's built identity middleware,
 * `services/gateway/dist/console/people.js` and `dist/settings/platform.js` from this process, signed
 * in with real console session cookies. What it establishes, against the seed's written values:
 *
 *   - the tiles: people, with a passkey, active and never signed in, and the recorded sign-ins in the
 *     last complete week, a sign-in at that week's first instant in it, one at the running week's
 *     first instant and one with no actor out of it;
 *   - each person's row: what People draws and nothing else, their name, role, teams, passkeys, last
 *     recorded sign-in (null for a person with none, whatever session, token or passkey registration
 *     they hold) and state, with the day they were added; a person in two teams lists both;
 *   - the rows by the day each person was added and then by email, filtered by `q` (an email or a
 *     name, never a pattern) and `state`, paged 10 at a time by default and at most 100, the tiles
 *     the same under every filter, and a value it does not take refused with 400;
 *   - a member is refused 403 `not permitted` before anything is read, and no session 401;
 *   - a sign-in figure that cannot be counted is unavailable with the rows standing; a row query
 *     that fails is 500 with nothing partial;
 *   - through the real routes a person is added, given an enrolment link and deactivated, the read
 *     following each; an email `person_add`'s schema refuses is refused at the console too, and one
 *     it takes is taken; deactivating an email nobody has is refused and changes nothing;
 *   - the superadmin's answer agrees in shape with the console's fake one, key set by key set.
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
import { z } from "zod";

import { root } from "../scripts/deployment.ts";
import { DOMAIN, EXPECTED, MEMBER, PEOPLE, SUPERADMIN, instant, seedPeople, type SeededPeople } from "../scripts/schema/people-seed.ts";
import { signIn } from "../scripts/schema/status-seed.ts";
import { withThrowawayDb } from "../scripts/schema/throwaway.ts";

const NAME = "console-platform-people";
const DONE = "console-platform-people: the superadmin reads every person's role, teams, passkeys, last recorded sign-in " +
  "and state, a member is refused before anything is read, and a person is added, enrolled and deactivated through " +
  "the real routes, in the fake's shapes: ok";
const TIMEZONE = "Pacific/Auckland";
/** COUPLED: the fake answer in the console's checkout, `../zz-stack-dashboard` here and in CI. */
const FAKE = join(root, "..", "zz-stack-dashboard", "scripts", "fake-gateway", "platform-people.ts");
const POPULATION = "people, their passkeys and their recorded console sign-ins";

/** What People draws of a person, and the day they were added: a row holds these keys and no other. */
const ROW_KEYS = ["created", "email", "lastSignIn", "name", "passkeys", "role", "state", "teams"];
/** `person_add`'s schema for its email, as services/gateway/src/admin.ts registers it on the MCP door. */
const MCP_EMAIL = z.string().email();

class CaseFailure extends Error {}
function fail(step: string, detail: string): never {
  throw new CaseFailure(`${NAME}: FAILED at "${step}": ${detail}`);
}
const pass = (line: string): void => console.log(`  ok  ${line}`);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const keys = (v: unknown): string => (isObj(v) ? Object.keys(v).sort().join(",") : `not an object: ${JSON.stringify(v)}`);

/** A value with every object's keys in order, so two answers compare by content alone. */
function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
  return v;
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(sortDeep(a)) === JSON.stringify(sortDeep(b));

interface Answer { status: number; body: Obj; text: string }

/** Where two answers' shapes differ: at an object both hold, the key sets; at an array both hold,
 *  the first elements, the same way; a null on either side, nothing. */
function shapeDiffs(a: unknown, b: unknown, at: string, out: string[]): string[] {
  if (a === null || b === null) return out;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length && b.length) shapeDiffs(a[0], b[0], `${at}[0]`, out);
  } else if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    if (ka.join() !== kb.join()) out.push(`${at || "the answer"} has keys {${ka.join(", ")}} where the fake has {${kb.join(", ")}}`);
    for (const k of ka.filter((x) => kb.includes(x))) shapeDiffs(a[k], b[k], at ? `${at}.${k}` : k, out);
  }
  return out;
}

/** The seed's name for the person an email belongs to. */
const localOf = (email: unknown): string => String(email).replace(`@${DOMAIN}`, "");

/** A list answer's people, or a failure naming what came instead. */
function rowsOf(step: string, a: Answer): Obj[] {
  if (a.status !== 200 || !Array.isArray(a.body.people)) fail(step, `answered ${a.status}: ${a.text.slice(0, 400)}`);
  return a.body.people as Obj[];
}

/** The local calendar date an instant falls on in the check's timezone; en-CA formats as YYYY-MM-DD. */
const localDate = (ms: number): string => new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(new Date(ms));

/** What a seeded person's row must read, from the seed's lists and the values written beside them. The seed also
 *  writes tokens and the team a person acts for, which no page reads and the read no longer answers. */
function rowOf(s: SeededPeople, local: string): Obj {
  const p = PEOPLE[local];
  const signedIn = EXPECTED.lastSignIn[local];
  return {
    email: `${local}@${DOMAIN}`, name: p.name, role: p.role, state: p.status, created: localDate(instant(s, p.added)),
    teams: EXPECTED.teams[local] ?? [], passkeys: EXPECTED.passkeys[local] ?? 0, lastSignIn: signedIn ? iso(instant(s, signedIn)) : null,
  };
}

/** The sign-ins of the last complete week as the tiles must state them. */
function signInsLastWeek(s: SeededPeople): Obj {
  const from = iso(s.starts.get(1)!), to = iso(s.starts.get(0)!);
  const n = EXPECTED.tiles.signInsLastWeek;
  return { window: { from, to, observedFrom: from, observedThrough: to, complete: true }, figure: { value: n, why: null },
    numerator: n, denominator: null };
}

function readCases(s: SeededPeople, a: Answer): void {
  let step = "the answer's parts";
  if (a.status !== 200 || keys(a.body) !== "meta,people,tiles,total") fail(step, `answered ${a.status}: ${a.text.slice(0, 400)}`);
  pass("the superadmin's answer is meta, tiles, people and total");

  step = "the tiles";
  const t = EXPECTED.tiles;
  const want = { people: t.people, withPasskey: t.withPasskey, neverSignedIn: t.neverSignedIn, signInsLastWeek: signInsLastWeek(s) };
  if (!same(a.body.tiles, want)) fail(step, `read ${JSON.stringify(a.body.tiles)}, not ${JSON.stringify(want)}`);
  pass(`12 people, 4 with a passkey, 7 active people never signed in (not the deactivated one with none, not the one with ` +
       `only a session, a token and a passkey registration counted as signed in), and 3 sign-ins in the last complete week: ` +
       `one at its first instant in it, the running week's first instant and a sign-in with no actor out of it`);

  step = "meta";
  const meta = a.body.meta as Obj;
  const first = iso(instant(s, EXPECTED.firstSignIn));
  const asOf = Date.parse(String(meta.asOf));
  if (meta.scope !== "platform-admin" || meta.timezone !== TIMEZONE || meta.population !== POPULATION || meta.coverageFrom !== first
      || !isObj(meta.period) || meta.period.from !== first || meta.period.to !== meta.asOf
      || !(asOf >= Math.floor(s.now / 1000) * 1000 && asOf <= Date.now())) {
    fail(step, JSON.stringify(meta));
  }
  pass(`meta reads platform-admin in ${TIMEZONE}, people and their recorded sign-ins, coverage from the first recorded sign-in`);

  step = "each person's row";
  const rows = rowsOf(step, a);
  for (const r of rows) {
    if (keys(r) !== [...ROW_KEYS].sort().join()) fail(step, `${localOf(r.email)} has keys ${keys(r)}, not ${[...ROW_KEYS].sort().join(",")}`);
    const wantRow = rowOf(s, localOf(r.email));
    if (!same(r, wantRow)) fail(step, `${localOf(r.email)} reads ${JSON.stringify(r)}, not ${JSON.stringify(wantRow)}`);
  }
  const nulls = rows.filter((r) => r.lastSignIn === null).map((r) => localOf(r.email)).sort();
  if (nulls.join() !== ["bo", "di", "fay", "member", "zed-1", "zed-2"].join()) fail(step, `lastSignIn is null for ${nulls.join(", ")}`);
  pass("each row reads its role, state, teams (both of ada's), passkeys and latest recorded sign-in as seeded, and no " +
       "field People does not draw; lastSignIn is null for bo, di, fay and member, never a date from a session, a token " +
       "or a passkey registration");
}

async function filterCases(as: (email: string, query?: string) => Promise<Answer>, whole: Answer): Promise<void> {
  let step = "filters and pages";
  for (const [query, [want, total]] of Object.entries(EXPECTED.filtered)) {
    const a = await as(SUPERADMIN, query ? `?${query}` : "");
    const got = rowsOf(`${step}: ${query || "no query"}`, a).map((r) => localOf(r.email));
    if (got.join() !== want.join() || a.body.total !== total) {
      fail(step, `?${query} lists ${got.join(", ")} of ${String(a.body.total)}, not ${want.join(", ")} of ${total}`);
    }
    if (!same(a.body.tiles, whole.body.tiles)) fail(step, `?${query} moved the tiles: ${JSON.stringify(a.body.tiles)}`);
  }
  pass("10 rows by default and up to 100, by the day added and then by email (ada before bo, added two hours later the " +
       "same day); a page past the end keeps the total; `q` matches an email or a name in any case and never as a " +
       "pattern; `state` narrows to the active or the deactivated; no filter moves a tile");

  step = "what the read does not take";
  for (const bad of ["state=gone", "state=Active", "state=active&state=deactivated", "q=a&q=b", "limit=0", "limit=101",
                     "limit=2.5", "limit=ten", "offset=-1", "offset=1.5", "limit=1&limit=2"]) {
    const a = await as(SUPERADMIN, `?${bad}`);
    if (a.status !== 400 || keys(a.body) !== "error" || typeof a.body.error !== "string") fail(step, `?${bad} answered ${a.status}: ${a.text.slice(0, 200)}`);
  }
  pass("an unknown state, a repeated parameter, or a page out of range is 400 with a sentence and nothing else");
}

async function refusalCases(as: (email: string, query?: string) => Promise<Answer>, none: () => Promise<Answer>,
                            failing: <T>(when: (sql: string) => boolean, f: () => Promise<T>) => Promise<T>): Promise<void> {
  const step = "a member is refused before anything is read";
  for (const query of ["", "?limit=100", "?state=gone", "?scope=platform"]) {
    const m = await as(MEMBER, query);
    if (m.status !== 403 || m.text !== JSON.stringify({ error: "not permitted" })) fail(step, `${query || "no query"} answered ${m.status}: ${m.text.slice(0, 200)}`);
  }
  const unread = await failing((sql) => sql.includes("zz."), () => as(MEMBER));
  if (unread.status !== 403 || unread.text !== JSON.stringify({ error: "not permitted" })) {
    fail(step, `with every read of the platform's tables failing, the member answered ${unread.status}: ${unread.text.slice(0, 200)}`);
  }
  const anon = await none();
  if (anon.status !== 401) fail(step, `no session answered ${anon.status}: ${anon.text.slice(0, 200)}`);
  pass("a member is 403 `not permitted` and nothing else, whatever they ask and with every read failing, and no session 401");
}

async function failureCases(s: SeededPeople, as: (email: string, query?: string) => Promise<Answer>, whole: Answer,
                            failing: <T>(when: (sql: string) => boolean, f: () => Promise<T>) => Promise<T>): Promise<void> {
  let step = "a sign-in figure that cannot be counted";
  const a = await failing((sql) => sql.includes("min(e.ts)"), () => as(SUPERADMIN));
  const fig = (a.body.tiles as Obj | undefined)?.signInsLastWeek;
  const want = { window: { from: iso(s.starts.get(1)!), to: iso(s.starts.get(0)!), observedFrom: null, observedThrough: null, complete: false },
    figure: { value: null, why: "unavailable" }, numerator: null, denominator: null };
  const rest = (b: Obj) => ({ ...b, meta: null, tiles: { ...(b.tiles as Obj), signInsLastWeek: null } });
  if (a.status !== 200 || !same(fig, want) || !same(rest(a.body), rest(whole.body)) || (a.body.meta as Obj).coverageFrom !== null) {
    fail(step, `answered ${a.status}: ${a.text.slice(0, 600)}`);
  }
  pass("a sign-in count that fails reads unavailable over the same week, coverage unknown, and every row and other tile stands");

  step = "a row query that fails";
  const broken = await failing((sql) => sql.includes("offset $"), () => as(SUPERADMIN));
  if (broken.status !== 500 || broken.text !== JSON.stringify({ error: "could not read people" })) {
    fail(step, `answered ${broken.status}: ${broken.text.slice(0, 300)}`);
  }
  pass("a row query that fails answers 500, could not read people, and nothing else");
}

async function writeCases(db: pg.Client, as: (email: string, query?: string) => Promise<Answer>,
                          send: (method: string, path: string, body: Obj) => Promise<Answer>,
                          addPerson: (id: unknown, email: string, name?: string) => Promise<Obj>, superadmin: unknown): Promise<void> {
  const NEW = `New.Person@${DOMAIN}`, NEW_LOWER = NEW.toLowerCase();
  const one = async (step: string): Promise<Obj> => {
    const a = await as(SUPERADMIN, "?q=new.person");
    const rows = rowsOf(step, a);
    if (rows.length !== 1) fail(step, `?q=new.person lists ${rows.length} people`);
    return rows[0];
  };
  const tiles = async (): Promise<Obj> => (await as(SUPERADMIN)).body.tiles as Obj;

  let step = "a person is added";
  let w = await send("POST", "/api/console/settings/platform/people", { email: NEW, display_name: "New Person" });
  if (w.status !== 200 || w.body.ok !== true) fail(step, `answered ${w.status}: ${w.text.slice(0, 300)}`);
  let row = await one(step);
  const added = { email: NEW_LOWER, name: "New Person", role: "member", state: "active", teams: [], passkeys: 0, lastSignIn: null };
  if (!same({ ...row, created: null }, { ...added, created: null })) fail(step, `the read lists ${JSON.stringify(row)}`);
  let t = await tiles();
  if (t.people !== EXPECTED.tiles.people + 1 || t.neverSignedIn !== EXPECTED.tiles.neverSignedIn + 1) fail(step, `the tiles read ${JSON.stringify(t)}`);
  pass("a person added at the console is read at once, lower-cased, active, with no team, passkey or recorded sign-in, " +
       "counted among the people and the never signed in");

  step = "an enrolment link is issued";
  w = await send("POST", "/api/console/settings/platform/enrolments", { email: NEW_LOWER });
  if (w.status !== 200 || typeof w.body.url !== "string" || !/\/enrol#t=zze_/.test(w.body.url)) fail(step, `answered ${w.status}: ${w.text.slice(0, 300)}`);
  const links = await db.query<{ open: string }>(
    `select count(*) filter (where e.used_at is null) as open from zz.passkey_enrolment e
       join zz.principal p on p.id = e.principal_id where p.email = $1`, [NEW_LOWER]);
  row = await one(step);
  if (links.rows[0].open !== "1" || row.passkeys !== 0 || row.lastSignIn !== null) {
    fail(step, `${links.rows[0].open} open link(s), and the read lists ${JSON.stringify(row)}`);
  }
  pass("an enrolment link is issued once, open, and is neither a passkey nor a sign-in in the read");

  step = "the person is deactivated";
  w = await send("DELETE", "/api/console/settings/platform/people", { email: NEW_LOWER, confirm: NEW_LOWER });
  if (w.status !== 200 || w.body.ok !== true) fail(step, `answered ${w.status}: ${w.text.slice(0, 300)}`);
  row = await one(step);
  const spent = await db.query<{ open: string }>(
    `select count(*) filter (where e.used_at is null) as open from zz.passkey_enrolment e
       join zz.principal p on p.id = e.principal_id where p.email = $1`, [NEW_LOWER]);
  t = await tiles();
  if (row.state !== "deactivated" || spent.rows[0].open !== "0"
      || t.people !== EXPECTED.tiles.people + 1 || t.neverSignedIn !== EXPECTED.tiles.neverSignedIn) {
    fail(step, `the read lists ${JSON.stringify(row)} with tiles ${JSON.stringify(t)}, ${spent.rows[0].open} link(s) open`);
  }
  pass("the person deactivated reads deactivated, their link spent, still a person and no longer among the active never signed in");

  step = "an email of the wrong form";
  const count = async (): Promise<string> => (await db.query<{ n: string }>("select count(*) as n from zz.principal")).rows[0].n;
  const before = await count();
  for (const bad of ["not-an-email", "two@@people.example.test", "space in@people.example.test", "trailing@", `@${DOMAIN}`, "a@b"]) {
    if (MCP_EMAIL.safeParse(bad).success) fail(step, `${bad} is taken by person_add's schema, so it cannot stand for a wrong form`);
    w = await send("POST", "/api/console/settings/platform/people", { email: bad, display_name: "Bad" });
    if (w.status !== 400 || typeof w.body.error !== "string") fail(step, `the console answered ${bad} with ${w.status}: ${w.text.slice(0, 200)}`);
    const direct = await addPerson(superadmin, bad, "Bad");
    if (direct.ok !== false || direct.status !== 400) fail(step, `addPerson took ${bad}: ${JSON.stringify(direct)}`);
  }
  if (await count() !== before) fail(step, "a principal was written for an email of the wrong form");
  const odd = `o'neil+tag@${DOMAIN}`;
  if (!MCP_EMAIL.safeParse(odd).success) fail(step, `${odd} is refused by person_add's schema, so it cannot stand for a right form`);
  w = await send("POST", "/api/console/settings/platform/people", { email: odd });
  if (w.status !== 200 || Number(await count()) !== Number(before) + 1) fail(step, `the console answered ${odd} with ${w.status}: ${w.text.slice(0, 200)}`);
  pass("every email person_add's schema refuses is refused at the console and by addPerson with 400, and writes nothing; " +
       "one it takes, with an apostrophe and a plus, is taken");

  step = "deactivating an email nobody has";
  const NOBODY = `nobody@${DOMAIN}`;
  const snapshot = async (): Promise<string> => (await db.query<{ h: string }>(
    `select md5(coalesce(string_agg(p.email || p.status, '|' order by p.email), '')) ||
            (select count(*) from zz.event where kind = 'admin.deactivate_person')::text as h from zz.principal p`)).rows[0].h;
  const was = await snapshot();
  w = await send("DELETE", "/api/console/settings/platform/people", { email: NOBODY, confirm: NOBODY });
  if (w.status !== 400 || typeof w.body.error !== "string" || !w.body.error.includes(NOBODY)) fail(step, `answered ${w.status}: ${w.text.slice(0, 300)}`);
  // The audit row of the real deactivation above is written after the act, fire-and-forget; give it a moment to land.
  await new Promise((r) => setTimeout(r, 300));
  if (await snapshot() !== was) fail(step, "a principal changed or a deactivation was recorded");
  pass("deactivating an email no principal has is refused with 400 naming it, and changes and records nothing");
}

async function run(db: pg.Client, url: string): Promise<void> {
  const seeded = await seedPeople(db, TIMEZONE);
  const cookie = new Map<string, string>();
  for (const email of [MEMBER, SUPERADMIN]) cookie.set(email, await signIn(db, email));

  process.env.TEAM_DB_URL = url;
  process.env.ZZ_TZ = TIMEZONE;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  const load = (p: string) => import(pathToFileURL(join(root, p)).href);
  const express = (await import("express")).default;
  const dbModule = (await load("services/gateway/dist/db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await dbModule.initPlatformDb();
  const { identityMiddleware } = (await load("services/gateway/dist/identity.js")) as { identityMiddleware: () => RequestHandler };
  const { mountPeople } = (await load("services/gateway/dist/console/people.js")) as { mountPeople: (app: Express) => void };
  const { mountPlatformSettings } = (await load("services/gateway/dist/settings/platform.js")) as { mountPlatformSettings: (app: Express) => void };
  const { addPerson } = (await load("services/gateway/dist/admin/people.js")) as
    { addPerson: (id: unknown, email: string, name?: string) => Promise<Obj> };
  const app = express();
  // COUPLED: services/gateway/src/server.ts — the identity gate, then the JSON body parser, before every console route.
  app.use(identityMiddleware());
  app.use(express.json());
  mountPeople(app);
  mountPlatformSettings(app);
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const fetchAs = async (headers: Record<string, string>, path: string, init: RequestInit = {}): Promise<Answer> => {
    const res = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init.body ? { "content-type": "application/json" } : {}) },
      signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    let body: Obj = {};
    try { const v: unknown = JSON.parse(text); if (isObj(v)) body = v; } catch { /* not JSON: body stays empty */ }
    return { status: res.status, body, text };
  };
  const as = (email: string, query = ""): Promise<Answer> =>
    fetchAs({ cookie: `zz_console=${cookie.get(email)}` }, `/api/console/people${query}`);
  const send = (method: string, path: string, body: Obj): Promise<Answer> =>
    fetchAs({ cookie: `zz_console=${cookie.get(SUPERADMIN)}` }, path, { method, body: JSON.stringify(body) });
  const pool = dbModule.platformDb();
  const real = pool.query.bind(pool) as (text: unknown, params?: unknown[]) => Promise<unknown>;
  const failing = async <T>(when: (sql: string) => boolean, f: () => Promise<T>): Promise<T> => {
    (pool as unknown as { query: unknown }).query = (text: unknown, params?: unknown[]) =>
      typeof text === "string" && when(text) ? Promise.reject(new Error("injected by the check")) : real(text, params);
    try { return await f(); } finally { (pool as unknown as { query: unknown }).query = real; }
  };

  try {
    const whole = await as(SUPERADMIN);
    readCases(seeded, whole);
    await filterCases(as, whole);
    await refusalCases(as, () => fetchAs({}, "/api/console/people"), failing);
    await failureCases(seeded, as, whole, failing);

    const step = "the shapes the console's fake answers";
    let fake: { people: (who: Obj, q: URLSearchParams, page: { limit: number; offset: number } | null) => [number, unknown] | null };
    try {
      fake = (await import(pathToFileURL(FAKE).href)) as typeof fake;
    } catch (err) {
      fail(step, `could not read the console's fake answer at ${FAKE}: ${(err as Error).message}`);
    }
    const answered = fake.people({ superadmin: true, activeTeam: null }, new URLSearchParams(), { limit: 10, offset: 0 });
    if (!answered || answered[0] !== 200) fail(step, `the fake answered the superadmin ${JSON.stringify(answered).slice(0, 200)}`);
    const diffs = shapeDiffs(whole.body, answered[1], "superadmin", []);
    if (diffs.length) fail(step, diffs.join("; "));
    pass("the superadmin's answer agrees in shape with the fake's, key set by key set");

    const identity = { email: SUPERADMIN, platformRole: "superadmin", via: "session", origin: "work" };
    await writeCases(db, as, send, addPerson, identity);
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
