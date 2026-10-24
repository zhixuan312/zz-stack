#!/usr/bin/env node
/**
 * checks/console-read-contract.ts — the Record route's answer carries the change marker it saw and the
 * instant the read ran, end to end from the gateway to the wire (AC-1.1).
 *
 *   node checks/console-read-contract.ts   # needs Docker and a built tree (`npm run build`)
 *
 * This is the walking skeleton for the read contract: one real console route, over a real database, read
 * over HTTP as a browser reads it. What it establishes:
 *
 *   - with the change listener down, the answer still carries `observedAt` and carries `revision` as
 *     `null` — present, never omitted — and `cacheHit` as `false`;
 *   - once the listener is up, `revision` is a composite of the collections Record really reads, every
 *     name in it one a console tab may follow, and no name the route's own;
 *   - `observedAt` is the instant this request ran: a later read carries a later one, while a served
 *     answer's `asOf` stays where it was;
 *   - `cacheHit` is stated by the cache and is never inferred from the two instants: a second read of an
 *     unchanged answer says `true`, and a read after a write that moved the version says `false` again.
 *
 * It starts a throwaway PostgreSQL migrated by the real runner (`withThrowawayDb`), signs one member in,
 * and serves the gateway's built identity middleware, its revision and the Record route from this process
 * in `server.ts`'s order. The only database it touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { join } from "node:path";
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";

import type { Express, RequestHandler } from "express";
import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import { signIn } from "../scripts/schema/status-seed.ts";
import { withThrowawayDb } from "../scripts/schema/throwaway.ts";

const NAME = "console-read-contract";
const DONE = "console-read-contract: the Record route's answer carries the change marker it saw and the " +
  "instant the read ran, and the cache states its own hit: ok";

const TEAM = "read-contract-team";
const MEMBER = "member@read-contract.example.test";

class CaseFailure extends Error {}
const fail = (step: string, detail: string): never => { throw new CaseFailure(`${NAME}: FAILED at "${step}": ${detail}`); };
const pass = (line: string): void => console.log(`ok ${line}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Meta = {
  asOf?: string; observedAt?: string; revision?: string | null; cacheHit?: boolean;
  builtAt?: string | null; sourceRevision?: string | null;
};
type Answer = { status: number; meta: Meta };

/** A person on one team, so the Record route has a caller and a team to answer for. */
async function seed(sql: pg.Client): Promise<string> {
  const person = (await sql.query<{ id: string }>(
    "insert into zz.principal (email, display_name, role) values ($1, $2, 'member') returning id", [MEMBER, MEMBER])).rows[0].id;
  const team = (await sql.query<{ id: string }>(
    "insert into zz.team (slug, name, created_by) values ($1, $1, $2) returning id", [TEAM, person])).rows[0].id;
  await sql.query("insert into zz.membership (team_id, principal_id, role, added_by) values ($1, $2, 'member', $2)", [team, person]);
  return team;
}

async function run(sql: pg.Client, url: string): Promise<void> {
  const team = await seed(sql);
  const cookie = `zz_console=${await signIn(sql, MEMBER)}`;

  process.env.TEAM_DB_URL = url;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  const load = (f: string) => import(pathToFileURL(join(root, "services/gateway/dist", f)).href);
  const express = (await import("express")).default;
  const dbModule = (await load("db.js")) as { initPlatformDb: () => Promise<void> };
  const { identityMiddleware } = (await load("identity.js")) as { identityMiddleware: () => RequestHandler };
  const live = (await load("console/live-revision.js")) as {
    mountConsoleRevision: (app: Express) => void;
    listening: () => void;
    COLLECTIONS: readonly string[];
  };
  const { mountRecord } = (await load("console/record.js")) as { mountRecord: (app: Express) => void };
  const changes = (await load("console/live.js")) as { mountConsoleLive: (app: Express) => void };
  const version = (await load("console/live-revision.js")) as { dataVersion: () => string | null };
  await dbModule.initPlatformDb();

  // COUPLED: services/gateway/src/server.ts and console.ts — the identity gate, the revision in front of
  // every console read, then the read itself.
  const app = express();
  app.use(identityMiddleware());
  live.mountConsoleRevision(app);
  mountRecord(app);
  const servers: Server[] = [];
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const read = async (): Promise<Answer> => {
    const res = await fetch(`${base}/api/console/record`, { headers: { cookie, accept: "application/json" } });
    const body = await res.json() as { meta?: Meta };
    return { status: res.status, meta: body.meta ?? {} };
  };
  const present = (step: string, meta: Meta): void => {
    if (typeof meta.observedAt !== "string" || Number.isNaN(Date.parse(meta.observedAt))) {
      fail(step, `meta.observedAt is ${JSON.stringify(meta.observedAt)}, not an instant`);
    }
    if (!("revision" in meta)) fail(step, `the answer carries no revision key at all: ${JSON.stringify(Object.keys(meta))}`);
    if (typeof meta.cacheHit !== "boolean") fail(step, `meta.cacheHit is ${JSON.stringify(meta.cacheHit)}, not a boolean`);
  };

  try {
    // 1. Nothing listening yet: the fields are present, and the marker is an explicit null.
    let step = "with the change listener down the answer still carries both fields and a null marker";
    const cold = await read();
    if (cold.status !== 200) fail(step, `/api/console/record answered ${cold.status}`);
    present(step, cold.meta);
    if (cold.meta.revision !== null) fail(step, `meta.revision is ${JSON.stringify(cold.meta.revision)}, not null while nothing listens`);
    if (cold.meta.cacheHit !== false) fail(step, `meta.cacheHit is ${cold.meta.cacheHit} with nothing listening`);
    pass("with the listener down, observedAt and revision are present and revision is an explicit null");

    // 2. Listening: the marker is a composite of collections a tab follows, never the route's own name.
    step = "once the listener is up the marker composes collections a tab may follow";
    // The real `LISTEN` connection, not a set flag: a write has to reach this process the way it reaches the
    // gateway, or the case below would test a counter nobody increments.
    changes.mountConsoleLive(app);
    for (let waited = 0; version.dataVersion() === null; waited += 100) {
      if (waited > 15_000) fail(step, "the change listener did not come up within 15s");
      await sleep(100);
    }
    const first = await read();
    if (first.status !== 200) fail(step, `/api/console/record answered ${first.status}`);
    present(step, first.meta);
    const marker = typeof first.meta.revision === "string" ? first.meta.revision : "";
    if (marker === "") fail(step, `meta.revision is ${JSON.stringify(first.meta.revision)}, not a marker`);
    const named = marker.split(",").map((pair) => pair.slice(0, pair.indexOf(":")));
    const unknown = named.filter((n) => !live.COLLECTIONS.includes(n));
    if (unknown.length) fail(step, `the marker names ${JSON.stringify(unknown)}, which no console tab follows`);
    if (named.includes("record")) fail(step, "the marker names `record`, which is a route and not a collection");
    pass(`once listening, revision composes ${named.length} followed collections (${named.join(", ")})`);

    // 3. observedAt is this request's instant, and a served answer keeps its own asOf.
    step = "observedAt is this request's instant while a served answer keeps the one it was computed at";
    await sleep(5);
    const second = await read();
    present(step, second.meta);
    if (Date.parse(second.meta.observedAt!) <= Date.parse(first.meta.observedAt!)) {
      fail(step, `the second read's observedAt ${second.meta.observedAt} is not later than the first's ${first.meta.observedAt}`);
    }
    if (second.meta.asOf !== first.meta.asOf) {
      fail(step, `a served answer moved asOf from ${first.meta.asOf} to ${second.meta.asOf}; asOf is when it was computed`);
    }
    pass("observedAt moves with the request while asOf stays at the computation");

    // 4. cacheHit is the cache's own statement, and it flips. A write that moves the version un-keeps the answer.
    step = "cacheHit is stated by the cache: false, then true, then false again after a write";
    if (first.meta.cacheHit !== false) fail(step, `the first listening read reported cacheHit ${first.meta.cacheHit}, not false`);
    if (second.meta.cacheHit !== true) fail(step, `an unchanged second read reported cacheHit ${second.meta.cacheHit}, not true`);
    await sql.query("insert into zz.event (kind, origin, subject, ok, tool_key, team_id) values ('tool_call', 'work', 'work', true, 'document_read', $1)", [team]);
    await sleep(50);
    const after = await read();
    present(step, after.meta);
    if (after.meta.cacheHit !== false) {
      fail(step, `after a write the answer reported cacheHit ${after.meta.cacheHit}, not false — the version did not move`);
    }
    pass("cacheHit reports false on a computation, true on the answer it kept, and false again after a write");

    // The process's one LISTEN connection is ended from the database side, the way `console-live-since.ts`
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
// Every case has been decided by the time this resolves, and the throwaway database is dropped. The
// process's LISTEN connection is the one thing still alive, and its reconnect timer would otherwise keep
// the process up and turn a green run red — so the run ends here, with the exit code its cases earned.
await withThrowawayDb((sql) => run(sql, url), async (u) => { url = u; });
process.exit(0);
