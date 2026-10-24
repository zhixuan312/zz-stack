#!/usr/bin/env node
/**
 * checks/console-cache-scope.ts — the gate's guard that a kept console answer is reachable exactly when
 * what it read has not moved, and unreachable when it has.
 *
 *   node checks/console-cache-scope.ts   # a throwaway core, the built gateway in-process, six cases
 *
 * The cache exists so a page a person returns to costs nothing. That is only sound if the key names what
 * the answer was computed FROM: the collections its own entry declares, at the scope its figures are
 * about. Two ways to get it wrong, and both are silent — a key that names the route or the whole table
 * of collections makes a write to something the answer never read strand it (the page recomputes for
 * nothing), and a key that ignores the scope serves one caller's rows to another (a leak, not a cost).
 *
 * The cases are behavioural, over HTTP, and they count STATEMENTS rather than trusting a flag: a hit is
 * a read whose own statements did not run at all.
 *
 * Exit 0: every case holds — one line.
 * Exit 1: the first case that does not, quoting what was read.
 * Exit 2: Docker is not available.
 */
import type { Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Express, RequestHandler } from "express";
import pg from "pg";

import { root } from "../scripts/deployment.ts";
import { signIn } from "../scripts/schema/status-seed.ts";
import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";

const NAME = "console-cache-scope";
const DONE = "console-cache-scope: a kept answer is reachable exactly when what it read has not moved, " +
  "per scope — a collection the answer does not read leaves it reachable, another team's write strands " +
  "only the public aggregate, and two members of one team share one computation";

const INITIATIVES = "/api/console/initiatives";
const USAGE = "/api/console/platform/usage";
const STATUS = "/api/console/platform/status";

/** The statements a route's own reads run, told apart from the identity gate's, which every request pays. */
const OWN_READS: Record<string, RegExp> = {
  [INITIATIVES]: /zz\.initiative|zz\.doc\b|zz\.doc_revision/,
  [USAGE]: /zz\.event/,
  [STATUS]: /zz\.event/,
};

const SECOND = "cache-scope-second@example.test";
const SUPER = "cache-scope-super@example.test";
const OTHER_TEAM = "cache-scope-other";
const OTHER_MEMBER = "cache-scope-other@example.test";

class CaseFailure extends Error {}
const fail = (step: string, detail: string): never => { throw new CaseFailure(`${NAME}: FAILED at "${step}": ${detail}`); };
const pass = (line: string): void => console.log(`ok ${line}`);

const load = (f: string) => import(pathToFileURL(join(root, "services/gateway/dist", f)).href);

/** Every statement this process runs, in order. The gateway runs in-process here, so wrapping the pool's
 *  own `query` counts what the console's reads did — the cache's `hit` flag is a claim, and this is the
 *  fact beside it. Restored in `finally`, because a check that leaves it wrapped would skew every case
 *  after it. */
function countStatements(): { texts: string[]; stop: () => void } {
  const texts: string[] = [];
  const proto = pg.Pool.prototype as unknown as { query: (...args: unknown[]) => unknown };
  const original = proto.query;
  proto.query = function patched(this: unknown, ...args: unknown[]): unknown {
    const first = args[0];
    const text = typeof first === "string" ? first : (first as { text?: string } | undefined)?.text ?? "";
    texts.push(text);
    return original.apply(this, args as never);
  };
  return { texts, stop: () => { proto.query = original; } };
}

type Meta = { cacheHit?: boolean; scope?: string; revision?: string | null };
type Answer = { status: number; meta: Meta; body: Record<string, unknown> };

async function seed(sql: pg.Client, core: Core): Promise<{ teamA: string; teamB: string }> {
  const teamA = (await sql.query<{ id: string }>("select id from zz.team where slug = $1", [core.team])).rows[0].id;
  const person = (await sql.query<{ id: string }>("select id from zz.principal where email = $1", [core.email])).rows[0].id;
  const second = (await sql.query<{ id: string }>(
    "insert into zz.principal (email, display_name, role) values ($1::zz.citext, $1::text, 'member') returning id", [SECOND])).rows[0].id;
  await sql.query("insert into zz.membership (team_id, principal_id, role, added_by) values ($1, $2, 'member', $3)",
    [teamA, second, person]);
  const teamB = (await sql.query<{ id: string }>(
    "insert into zz.team (slug, name, created_by) values ($1, $1, $2) returning id", [OTHER_TEAM, person])).rows[0].id;
  await sql.query("insert into zz.principal (email, display_name, role) values ($1::zz.citext, $1::text, 'member')", [OTHER_MEMBER]);
  const other = (await sql.query<{ id: string }>("select id from zz.principal where email = $1", [OTHER_MEMBER])).rows[0].id;
  await sql.query("insert into zz.membership (team_id, principal_id, role, added_by) values ($1, $2, 'member', $3)",
    [teamB, other, person]);
  // The superadmin acts for a team like anybody else, which is what case (f) switches.
  await sql.query("insert into zz.principal (email, display_name, role) values ($1::zz.citext, $1::text, 'superadmin')", [SUPER]);
  const superId = (await sql.query<{ id: string }>("select id from zz.principal where email = $1", [SUPER])).rows[0].id;
  for (const team of [teamA, teamB]) {
    await sql.query("insert into zz.membership (team_id, principal_id, role, added_by) values ($1, $2, 'member', $3)",
      [team, superId, person]);
  }
  await sql.query("update zz.principal set active_team_id = $2 where id = $1", [superId, teamA]);
  await sql.query("update zz.principal set active_team_id = $1 where id = $2", [teamA, person]);
  await sql.query("update zz.principal set active_team_id = $1 where id = $2", [teamB, other]);
  return { teamA, teamB };
}

async function run(core: Core): Promise<void> {
  const sql = core.sql;
  const { teamA, teamB } = await seed(sql, core);

  process.env.TEAM_DB_URL = core.url;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  const express = (await import("express")).default;
  const dbModule = (await load("db.js")) as { initPlatformDb: () => Promise<void> };
  const { identityMiddleware } = (await load("identity.js")) as { identityMiddleware: () => RequestHandler };
  const { mountConsole } = (await load("console.js")) as { mountConsole: (app: Express) => void };
  const live = (await load("console/live-revision.js")) as {
    mountConsoleRevision: (app: Express) => void; listening: () => void; notListening: () => void;
  };
  await dbModule.initPlatformDb();

  // COUPLED: services/gateway/src/server.ts — the identity gate in front of the console's own reads, which
  // bring the revision and the envelope with them.
  const app = express();
  app.use(identityMiddleware());
  mountConsole(app);
  const servers: Server[] = [];
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const member = `zz_console=${await signIn(sql, core.email)}`;
  const second = `zz_console=${await signIn(sql, SECOND)}`;
  const superadmin = `zz_console=${await signIn(sql, SUPER)}`;
  const otherTeam = `zz_console=${await signIn(sql, OTHER_MEMBER)}`;

  const counter = countStatements();
  const read = async (path: string, cookie: string): Promise<{ answer: Answer; own: number }> => {
    const from = counter.texts.length;
    const res = await fetch(`${base}${path}`, { headers: { cookie, accept: "application/json" } });
    const body = await res.json() as Record<string, unknown>;
    const own = counter.texts.slice(from).filter((text) => OWN_READS[path]?.test(text) ?? false).length;
    return { answer: { status: res.status, meta: (body.meta ?? {}) as Meta, body }, own };
  };
  const hit = async (step: string, path: string, cookie: string, want: boolean): Promise<Answer> => {
    const { answer, own } = await read(path, cookie);
    if (answer.status !== 200) fail(step, `${path} answered ${answer.status}: ${JSON.stringify(answer.body).slice(0, 300)}`);
    if (typeof answer.meta.cacheHit !== "boolean") fail(step, `${path} carries cacheHit ${JSON.stringify(answer.meta.cacheHit)}, not a boolean`);
    if (answer.meta.cacheHit !== want) {
      fail(step, `${path} reports cacheHit ${answer.meta.cacheHit}, and the read ran ${own} of its own statement(s)`);
    }
    if (want && own !== 0) fail(step, `${path} reports a hit but ran ${own} of its own statement(s)`);
    if (!want && own === 0) fail(step, `${path} reports a miss but ran none of its own statements`);
    return answer;
  };
  /** The listener hears a write on its own `LISTEN` connection, so the notification lands after the
   *  write returns. Every "and now it is stranded" case reads the next answer immediately, so without
   *  this gap each one races the notification — `console-read-contract.ts` waits the same 50 ms for
   *  the same reason. */
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 50));
  const writeCall = async (team: string): Promise<void> => {
    await sql.query(
      `insert into zz.event (ts, kind, origin, ok, team_id, tool_key, duration_ms, subject)
       values (now(), 'tool_call', 'work', true, $1, 'core:write-guards', 42, '')`, [team]);
    await settle();
  };

  try {
    // The listener has to be up: with nothing listening there is no version and nothing is kept at all.
    live.mountConsoleRevision(app);
    for (let waited = 0; ; waited += 100) {
      const up = (await load("console/live-revision.js")) as { dataVersion: () => string | null };
      if (up.dataVersion() !== null) break;
      if (waited > 15_000) fail("the change listener is up", "it did not come up within 15s");
      await new Promise((r) => setTimeout(r, 100));
    }
    pass("the change listener is up, so answers are kept at all");

    // (a) Two members of one team: the second is served the first's computation, and runs no statement.
    const step = "two members of one team share one computation";
    await hit(step, INITIATIVES, member, false);
    await hit(step, INITIATIVES, second, true);
    pass("a second member of the same team is served the kept answer and runs none of the route's statements");

    // (b) A member and a superadmin: different scopes, so neither is served the other's answer.
    const stepB = "a superadmin and a member are not served each other's answer";
    await hit(stepB, INITIATIVES, superadmin, false);
    await hit(stepB, INITIATIVES, member, true);
    pass("the superadmin's read is its own computation, and the member's kept answer is still its own");

    // (c) A collection the answer does NOT read moves. `/initiatives` declares `initiatives` and `document`;
    // a work call raises `activity` and `runs`. The answer stays reachable — on the tree before this task the
    // hint moved the route's marker and the member paid the read again.
    const stepC = "a collection the answer does not read leaves it reachable";
    await writeCall(teamA);
    await hit(stepC, INITIATIVES, member, true);
    pass("a work call raised `activity` and `runs`, which /initiatives does not read, and its answer was still kept");

    // (d) Another team writes: the PUBLIC platform aggregate the member read is stranded, because its
    // figures are every team's.
    const stepD = "another team's write strands the public aggregate";
    await hit(stepD, USAGE, member, false);
    await hit(stepD, USAGE, member, true);
    await writeCall(teamB);
    await hit(stepD, USAGE, member, false);
    pass("Usage's public aggregate is kept, then stranded by a write of a team the reader is not in");

    // (e) The same write leaves the reader's own team's answer reachable.
    const stepE = "another team's write leaves the reader's own answer reachable";
    await hit(stepE, INITIATIVES, member, true);
    pass("the same write of another team left the member's own /initiatives answer kept");

    // (f) The scope an answer is about changes: a superadmin switching active team is a different answer.
    const stepF = "a superadmin switching active team is not served the answer it computed for the other one";
    await hit(stepF, STATUS, superadmin, false);
    await hit(stepF, STATUS, superadmin, true);
    await sql.query("update zz.principal set active_team_id = $1 where email = $2", [teamB, SUPER]);
    await settle();
    await hit(stepF, STATUS, superadmin, false);
    pass("the superadmin's status answer was kept, then stranded when it switched active team");

    // Nothing above is about the other team's own reads, and a member of it is a normal caller.
    const stepG = "another team's member reads its own answer, kept and separate";
    await hit(stepG, INITIATIVES, otherTeam, false);
    await hit(stepG, INITIATIVES, otherTeam, true);
    pass("the other team's member computes once and is served its own answer, never the first team's");
  } finally {
    counter.stop();
    for (const s of servers) s.close();
  }
}

process.exit(await withThrowawayCore(NAME, DONE, run));
