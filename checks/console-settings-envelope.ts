#!/usr/bin/env node
/**
 * checks/console-settings-envelope.ts — every settings GET answers an object carrying the envelope
 * (AC-1.2, AC-7.1).
 *
 *   node checks/console-settings-envelope.ts   # needs Docker and a built tree (`npm run build`)
 *
 * The envelope middleware stamps a plain object and deliberately leaves an array alone, so a settings read
 * that answers a bare array carries no marker at all. This is the check that holds the five reads to the
 * one shape: over a throwaway database holding one superadmin who administers one team, a plain member of
 * that team and two of the superadmin's own tokens, served by the real identity middleware, the revision
 * and envelope middleware in `server.ts`'s order, and the settings surface's three mounts:
 *
 *   - each of the five settings GETs answers an object, never a bare array, carrying `meta.observedAt` (an
 *     instant), `meta.revision` (the marker its own declared entry composes, once the change listener is
 *     up — a null here is a path no entry declares) and `meta.cacheHit` (false: a settings read keeps no
 *     answer, so it never served one);
 *   - the three that answered a bare array answer `{ rows, meta }` and hold no other key: the platform's
 *     people, a team's roster and the caller's own tokens, each with the length and the first row the
 *     array answered, so no value moved when the array became `rows`;
 *   - the two that already answered an object keep every field they had — `client` and `config`;
 *     `actingFor`, `teams` and `note` — with the `meta` beside them;
 *   - a settings GET it refuses answers its status and its `{ error }` and no `meta` at all: a team member
 *     who does not administer the team, a request naming no team, and a request with no session.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: the tree is not built, or Docker is not available — the check could not run, and that is not a pass.
 */
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Express, RequestHandler } from "express";
import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import { signIn } from "../scripts/schema/status-seed.ts";
import { withThrowawayDb } from "../scripts/schema/throwaway.ts";

const NAME = "console-settings-envelope";
const DONE = "console-settings-envelope: each of the five settings GETs answers an object carrying the observed " +
  "instant, the marker and the hit, the three lists hold their rows under rows, and a refusal carries no meta: ok";

const TEAM = "settings-envelope-team";
const SUPERADMIN = "root@settings-envelope.example.test";
const MEMBER = "member@settings-envelope.example.test";
/** The caller's two live tokens; the newer one is first, which is what `GET /settings/me/tokens` answers. */
const NEWER_TOKEN = "the newer seeded token";
const OLDER_TOKEN = "the older seeded token";

const PEOPLE = "/api/console/settings/platform/people";
const TOKENS = "/api/console/settings/me/tokens";
const CLIENT_SETUP = "/api/console/settings/me/client-setup";
const TEAMS = "/api/console/settings/me/teams";
const MEMBERS = `/api/console/settings/team/members?team=${TEAM}`;
/** The five settings reads, as a page asks them. */
const FIVE = [PEOPLE, TOKENS, CLIENT_SETUP, TEAMS, MEMBERS];

class CaseFailure extends Error {}
function fail(step: string, detail: string): never {
  throw new CaseFailure(`${NAME}: FAILED at "${step}": ${detail}`);
}
const pass = (line: string): void => console.log(`  ok  ${line}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Obj = Record<string, unknown>;
type Answer = { status: number; body: unknown; text: string };
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const keys = (v: unknown): string => (isObj(v) ? Object.keys(v).sort().join(",") : `not an object: ${JSON.stringify(v)}`);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(sortDeep(a)) === JSON.stringify(sortDeep(b));
function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
  return v;
}

const load = (f: string) => import(pathToFileURL(join(root, "services/gateway/dist", f)).href);

/** The built modules this reads. A tree that is not built has none of them — which is exit 2, not a failure. */
const BUILT = ["console/read-envelope.js", "console/live-revision.js", "console/live.js", "settings/me.js"];
const built = (): boolean => BUILT.every((f) => existsSync(join(root, "services/gateway/dist", f)));

/**
 * One superadmin who administers one team — so the platform's people, the caller's own teams and that
 * team's roster are all readable by one caller — a plain member of it, who administers nothing, and two
 * live tokens of the superadmin's own.
 */
async function seed(sql: pg.Client): Promise<void> {
  const admin = (await sql.query<{ id: string }>(
    "insert into zz.principal (email, display_name, role) values ($1, 'Root Admin', 'superadmin') returning id",
    [SUPERADMIN])).rows[0].id;
  const member = (await sql.query<{ id: string }>(
    "insert into zz.principal (email, display_name, role, created_at) values ($1, 'Mo Reed', 'member', now() - interval '1 day') returning id",
    [MEMBER])).rows[0].id;
  const team = (await sql.query<{ id: string }>(
    "insert into zz.team (slug, name, created_by) values ($1, $1, $2) returning id", [TEAM, admin])).rows[0].id;
  // The membership first and the active team after it: `principal_active_membership_fkey` refuses a principal whose
  // active team is not one it belongs to, so the row it points at has to exist before the pointer does.
  await sql.query("insert into zz.membership (team_id, principal_id, role, added_by) values ($1, $2, 'admin', $2)", [team, admin]);
  await sql.query("insert into zz.membership (team_id, principal_id, role, added_by) values ($1, $2, 'member', $3)",
    [team, member, admin]);
  await sql.query("update zz.principal set active_team_id = $1 where id = $2", [team, admin]);
  await sql.query(
    `insert into zz.pat (principal_id, token_hash, label, created_at)
     values ($1, 'seeded-newer-token', $2, now()), ($1, 'seeded-older-token', $3, now() - interval '1 day')`,
    [admin, NEWER_TOKEN, OLDER_TOKEN]);
}

async function run(sql: pg.Client, url: string): Promise<void> {
  await seed(sql);
  const cookie = `zz_console=${await signIn(sql, SUPERADMIN)}`;

  process.env.TEAM_DB_URL = url;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  // A client package carries the address people reach the gateway at, so `/settings/me/client-setup` refuses to
  // render without one; every check that reads it names its own.
  process.env.GATEWAY_PUBLIC_URL = "https://gateway.settings-envelope.example.test";
  const express = (await import("express")).default;
  const dbModule = (await load("db.js")) as { initPlatformDb: () => Promise<void> };
  const { identityMiddleware } = (await load("identity.js")) as { identityMiddleware: () => RequestHandler };
  const live = (await load("console/live-revision.js")) as {
    mountConsoleRevision: (app: Express) => void;
    dataVersion: () => string | null;
    COLLECTIONS: readonly string[];
  };
  const envelope = (await load("console/read-envelope.js")) as { mountReadEnvelope: (app: Express) => void };
  const changes = (await load("console/live.js")) as { mountConsoleLive: (app: Express) => void };
  const credentials = (await load("credentials.js")) as Record<string, unknown>;
  const { mountMySettings } = (await load("settings/me.js")) as { mountMySettings: (app: Express, deps: unknown) => void };
  const { mountTeamSettings } = (await load("settings/team.js")) as { mountTeamSettings: (app: Express) => void };
  const { mountPlatformSettings } = (await load("settings/platform.js")) as { mountPlatformSettings: (app: Express) => void };
  await dbModule.initPlatformDb();

  // COUPLED: services/gateway/src/server.ts and console.ts — the identity gate, then the revision and the
  // envelope in front of every read, then the settings surface `mountSettings` mounts after them.
  const app = express();
  app.use(identityMiddleware());
  app.use(express.json());
  live.mountConsoleRevision(app);
  envelope.mountReadEnvelope(app);
  mountMySettings(app, {
    myAccessTokensFor: credentials.myAccessTokensFor, issueMyAccessTokenFor: credentials.issueMyAccessTokenFor,
    revokeMyAccessTokenFor: credentials.revokeMyAccessTokenFor,
  });
  mountTeamSettings(app);
  mountPlatformSettings(app);
  // Last, as `mountConsole` mounts it: the `LISTEN` connection every marker is a count from.
  changes.mountConsoleLive(app);

  const servers: Server[] = [];
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const fetchAs = async (headers: Record<string, string>, path: string): Promise<Answer> => {
    const res = await fetch(`${base}${path}`, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* not JSON: the body stays null */ }
    return { status: res.status, body, text };
  };
  const get = (path: string) => fetchAs({ cookie }, path);

  try {
    let step = "the change listener is up before any read";
    for (let waited = 0; live.dataVersion() === null; waited += 100) {
      if (waited > 15_000) fail(step, "the change listener did not come up within 15s");
      await sleep(100);
    }
    pass("the change listener is up, so a read's marker is the count of changes it could hear");

    // 1. The five answers are objects, and each carries the three fields the middleware states.
    step = "each of the five settings GETs answers an object carrying the envelope";
    for (const path of FIVE) {
      const a = await get(path);
      if (a.status !== 200) fail(step, `${path} answered ${a.status}: ${a.text.slice(0, 300)}`);
      if (!isObj(a.body)) {
        fail(step, `${path} answered ${Array.isArray(a.body) ? "a bare array" : typeof a.body}, which the envelope leaves alone`);
      }
      const meta = (a.body as Obj).meta;
      if (!isObj(meta)) fail(step, `${path} carries no meta object, its keys are ${keys(a.body)}`);
      if (typeof meta.observedAt !== "string" || Number.isNaN(Date.parse(meta.observedAt))) {
        fail(step, `${path} carries meta.observedAt ${JSON.stringify(meta.observedAt)}, not an instant`);
      }
      if (!("revision" in meta)) fail(step, `${path} carries no meta.revision key at all: ${keys(meta)}`);
      if (typeof meta.revision !== "string") {
        fail(step, `${path} carries meta.revision ${JSON.stringify(meta.revision)} with the listener up — a null is a path no entry declares`);
      }
      const named = meta.revision.split(",").map((pair) => pair.slice(0, pair.indexOf(":")));
      const unknown = named.filter((n) => !live.COLLECTIONS.includes(n));
      if (unknown.length) fail(step, `${path} composes ${JSON.stringify(unknown)}, which no console tab follows`);
      if (meta.cacheHit !== false) {
        fail(step, `${path} carries meta.cacheHit ${JSON.stringify(meta.cacheHit)}; a settings read keeps no answer, so it served none`);
      }
    }
    pass(`${FIVE.length} settings GETs answer an object carrying observedAt, a non-null revision naming only followed ` +
      "collections, and cacheHit false");

    // 2. The three lists hold their rows under `rows`, and nothing moved into it or out of it.
    step = "the platform's people answer their rows under rows";
    const people = await get(PEOPLE);
    if (keys(people.body) !== "meta,rows") fail(step, `${PEOPLE} answers ${keys(people.body)}, not meta and rows alone`);
    const peopleRows = (people.body as Obj).rows;
    if (!Array.isArray(peopleRows) || peopleRows.length !== 2) {
      fail(step, `${PEOPLE} answers ${Array.isArray(peopleRows) ? `${peopleRows.length} row(s)` : "no rows array"}: ${people.text.slice(0, 400)}`);
    }
    // Ordered by email, so the member is the first row and the superadmin the second.
    if (keys(peopleRows[0]) !== "created_at,display_name,email,role,status,teams") {
      fail(step, `the first row has keys ${keys(peopleRows[0])}`);
    }
    if ((peopleRows[0] as Obj).email !== MEMBER || (peopleRows[0] as Obj).role !== "member") {
      fail(step, `the first row is ${JSON.stringify(peopleRows[0])}, not ${MEMBER} with their role`);
    }
    const held = ((peopleRows[0] as Obj).teams as Obj[] | undefined) ?? [];
    if (held.length !== 1 || !same({ ...held[0], added_at: null }, { team: TEAM, role: "member", added_by: SUPERADMIN, added_at: null })
        || typeof held[0]?.added_at !== "string") {
      fail(step, `the first row's teams read ${JSON.stringify(held)}, not their one membership with who added them`);
    }
    pass(`the platform's people answer 2 rows under rows, in the email order the array answered, the member first ` +
      "with the one membership and who added them");

    step = "a team's roster answers its rows under rows";
    const members = await get(MEMBERS);
    if (keys(members.body) !== "meta,rows") fail(step, `${MEMBERS} answers ${keys(members.body)}, not meta and rows alone`);
    const memberRows = (members.body as Obj).rows;
    // Ordered by role then email, so the team's admin is first and the member second.
    if (!Array.isArray(memberRows) || !same(memberRows, [{ email: SUPERADMIN, role: "admin" }, { email: MEMBER, role: "member" }])) {
      fail(step, `${MEMBERS} answers ${JSON.stringify(memberRows)}, not the admin and then the member: ${members.text.slice(0, 400)}`);
    }
    pass(`a team's roster answers its admin and then its member under rows, each with their email and role alone`);

    step = "the caller's own tokens answer under rows, newest first";
    const tokens = await get(TOKENS);
    if (keys(tokens.body) !== "meta,rows") fail(step, `${TOKENS} answers ${keys(tokens.body)}, not meta and rows alone`);
    const tokenRows = (tokens.body as Obj).rows;
    if (!Array.isArray(tokenRows) || tokenRows.length !== 2) {
      fail(step, `${TOKENS} answers ${Array.isArray(tokenRows) ? `${tokenRows.length} row(s)` : "no rows array"}: ${tokens.text.slice(0, 400)}`);
    }
    for (const row of tokenRows) {
      if (keys(row) !== "created_at,id,label,last_used_at,revoked_at") fail(step, `a token row has keys ${keys(row)}`);
    }
    if (!same(tokenRows.map((r) => (r as Obj).label), [NEWER_TOKEN, OLDER_TOKEN])) {
      fail(step, `${TOKENS} lists ${JSON.stringify(tokenRows.map((r) => (r as Obj).label))}, not newest first`);
    }
    pass(`the caller's own tokens answer 2 rows under rows, newest first, each by label and date alone`);

    // 3. The two that already answered an object keep every field they had.
    step = "client setup keeps its client and config, and gains the meta";
    const setup = await get(CLIENT_SETUP);
    if (keys(setup.body) !== "client,config,meta") fail(step, `${CLIENT_SETUP} answers ${keys(setup.body)}`);
    if ((setup.body as Obj).client !== "claude-code" || typeof (setup.body as Obj).config !== "string"
        || ((setup.body as Obj).config as string).length === 0) {
      fail(step, `${CLIENT_SETUP} answers ${setup.text.slice(0, 300)}`);
    }
    pass("client setup keeps its client and config, with the meta beside them");

    step = "the caller's teams keep actingFor, teams and note, and gain the meta";
    const teams = await get(TEAMS);
    if (keys(teams.body) !== "actingFor,meta,note,teams") fail(step, `${TEAMS} answers ${keys(teams.body)}`);
    if ((teams.body as Obj).actingFor !== TEAM
        || !same((teams.body as Obj).teams, [{ team: TEAM, role: "admin", active: true }])
        || (teams.body as Obj).note !== null) {
      fail(step, `${TEAMS} answers ${teams.text.slice(0, 300)}`);
    }
    pass("the caller's teams keep actingFor, teams and note, with the meta beside them");

    // 4. A refusal is still a refusal, and carries no meta.
    step = "a team member who does not administer it is refused, with no meta";
    const guarded = await fetchAs({ cookie: `zz_console=${await signIn(sql, MEMBER)}` }, MEMBERS);
    if (guarded.status !== 403 || !isObj(guarded.body) || "meta" in guarded.body) {
      fail(step, `${MEMBERS} as ${MEMBER} answered ${guarded.status}: ${guarded.text.slice(0, 300)}`);
    }
    if (guarded.text !== JSON.stringify({ error: `team admin or superadmin required for ${TEAM}` })) {
      fail(step, `${MEMBERS} as ${MEMBER} answered ${guarded.text.slice(0, 300)}`);
    }
    pass(`as ${MEMBER}, who administers nothing, the roster answers 403 and its own sentence, and no meta`);

    step = "a request naming no team is refused, with no meta";
    const bare = await get("/api/console/settings/team/members");
    if (bare.status !== 400 || !isObj(bare.body) || "meta" in bare.body || bare.text !== JSON.stringify({ error: "team is required" })) {
      fail(step, `no team answered ${bare.status}: ${bare.text.slice(0, 300)}`);
    }
    pass("a request naming no team answers 400 \"team is required\", and no meta");

    step = "a request with no session is refused, with no meta";
    const anonymous = await fetchAs({}, PEOPLE);
    if (anonymous.status !== 401 || !isObj(anonymous.body) || "meta" in anonymous.body) {
      fail(step, `${PEOPLE} with no session answered ${anonymous.status}: ${anonymous.text.slice(0, 300)}`);
    }
    pass("a request with no session answers 401 and no meta");

    // The process's one LISTEN connection is ended from the database side, as the sibling envelope check
    // does: left open, its socket dies with the throwaway database and the error turns a green run red.
    step = "the listener is ended cleanly after the last case";
    const ended = await sql.query("select pg_terminate_backend(pid) from pg_stat_activity where query = 'listen zz_console_change'");
    if (ended.rowCount !== 1) fail(step, `found ${ended.rowCount} listening connections to end, not one`);
    await sleep(200);

    console.log(DONE);
  } finally {
    for (const s of servers) s.close();
  }
}

let url = "";
try {
  if (!built()) throw new Error("the tree is not built — run npm run build");
  await withThrowawayDb((sql) => run(sql, url), async (u) => { url = u; });
} catch (err) {
  if (err instanceof CaseFailure) {
    console.error(err.message);
    process.exit(1);
  }
  if (String(err).includes("the tree is not built") || String(err).includes("Docker is not running")) {
    console.error(`${NAME}: the check could not run — ${String(err)}`);
    process.exit(2);
  }
  throw err;
}
// Every case has been decided by the time this resolves, and the throwaway database is dropped. The process's
// LISTEN connection is the one thing still alive, and its reconnect timer would otherwise keep the process up
// and turn a green run red — so the run ends here, with the exit code its cases earned.
process.exit(0);
