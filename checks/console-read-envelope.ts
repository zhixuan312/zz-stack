#!/usr/bin/env node
/**
 * checks/console-read-envelope.ts — one mechanism stamps every console GET answer (AC-1.2, AC-2.1, AC-3.1).
 *
 *   node checks/console-read-envelope.ts   # needs Docker and a built tree (`npm run build`)
 *
 * Two arms, because they fail differently.
 *
 * **Static.** Every `app.get("/api/console/…")` path literal under `services/gateway/src/console/` and
 * `services/gateway/src/settings/` resolves to a path `read-envelope.ts` declares, or is the stream
 * `/api/console/live`; and every collection an entry names is one a tab follows (`COLLECTIONS`). The
 * source text of both directories is what has to be read: a route the table forgot compiles perfectly
 * and answers happily, so nothing else in the tree would notice it.
 *
 * **Live.** Over a throwaway database, with the real identity middleware, the revision middleware and
 * the envelope mounted in `server.ts`'s order, and two routes of the check's own at declared paths — one
 * answering a plain object with no `meta` at all, one answering through `cachedWithHit` and `served`:
 *
 *   - with the change listener down, both carry `observedAt`, `revision` as an explicit `null` and
 *     `cacheHit` as `false`, and the answer with no `meta` gains `builtAt` and `sourceRevision` as nulls;
 *   - with `mountConsoleLive` up and `dataVersion()` non-null, both carry the composite their declared
 *     entry names, every name in it one a tab may follow;
 *   - the cached route reports `false` on its first read and `true` on its second, its `observedAt` moves
 *     between the two while its `asOf` does not — which is the proof the envelope is a fresh object per
 *     request and never written into the answer the cache shares between callers.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: the tree is not built, or Docker is not available — the check could not run, and that is not a pass.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Express, RequestHandler } from "express";
import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import { signIn } from "../scripts/schema/status-seed.ts";
import { withThrowawayDb } from "../scripts/schema/throwaway.ts";

const NAME = "console-read-envelope";
const DONE = "console-read-envelope: every console GET resolves to a declared entry, and one middleware stamps " +
  "every answer with the instant it was served, the marker it could hear and the cache's own hit: ok";

/** The two directories whose GET routes the table has to declare. */
const SOURCES = ["services/gateway/src/console", "services/gateway/src/settings"];
/** The one console GET that is not an answer: a stream held open, which no envelope may touch. */
const STREAM = "/api/console/live";

const TEAM = "read-envelope-team";
const MEMBER = "member@read-envelope.example.test";

/** The two declared paths this check mounts its own routes at, so each answer has a marker to compose. */
const BARE = "/api/console/home";
const KEPT = "/api/console/record";

class CaseFailure extends Error {}
const fail = (step: string, detail: string): never => { throw new CaseFailure(`${NAME}: FAILED at "${step}": ${detail}`); };
const pass = (line: string): void => console.log(`ok ${line}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type ReadRoute = { path: string; collections: readonly string[] };
type Meta = {
  asOf?: string; observedAt?: string; revision?: string | null; cacheHit?: boolean;
  builtAt?: string | null; sourceRevision?: string | null;
};
type Answer = { status: number; body: Record<string, unknown>; meta: Meta };

const load = (f: string) => import(pathToFileURL(join(root, "services/gateway/dist", f)).href);

/** The built modules this reads. The table and the cache are what both arms are about, and a tree that is
 *  not built has neither — which is exit 2, not a failure. */
const BUILT = ["console/read-envelope.js", "console/answer-cache.js", "console/live-revision.js"];
const built = (): boolean => BUILT.every((f) => existsSync(join(root, "services/gateway/dist", f)));

/**
 * The static arm: the source text of the two directories against the table the built module holds.
 * Returns nothing, and throws the first thing it finds — a route the table forgot, or a name no tab
 * follows, is the defect each case exists for.
 */
async function staticArm(): Promise<void> {
  const envelope = (await load("console/read-envelope.js")) as { READ_ROUTES: readonly ReadRoute[] };
  const live = (await load("console/live-revision.js")) as { COLLECTIONS: readonly string[] };

  const declared = new Set(envelope.READ_ROUTES.map((route) => route.path));
  const followed = new Set(live.COLLECTIONS);
  if (envelope.READ_ROUTES.length === 0) fail("the table declares the routes it stamps", "READ_ROUTES is empty");

  let step = "every console GET path literal resolves to a declared entry";
  const undeclared: string[] = [];
  let seen = 0;
  for (const dir of SOURCES) {
    for (const name of readdirSync(join(root, dir)).filter((f) => f.endsWith(".ts"))) {
      const src = readFileSync(join(root, dir, name), "utf8");
      for (const m of src.matchAll(/app\.get\(\s*"([^"]+)"/g)) {
        const path = m[1];
        seen++;
        if (path !== STREAM && !declared.has(path)) undeclared.push(`${dir}/${name} mounts ${path}`);
      }
    }
  }
  if (undeclared.length) fail(step, `${undeclared.length} route(s) the table does not declare: ${undeclared.join("; ")}`);
  pass(`${seen} console GET path literals under both directories resolve to a declared entry, or are the stream`);

  step = "every collection an entry names is one a tab may follow";
  const unknown = envelope.READ_ROUTES.flatMap((route) =>
    route.collections.filter((c) => !followed.has(c)).map((c) => `${route.path} names ${c}`));
  if (unknown.length) fail(step, `no tab follows ${unknown.join("; ")} — every one must be in COLLECTIONS`);
  pass(`${envelope.READ_ROUTES.length} declared entries name only the ${followed.size} collections a tab follows`);
}

/** A person on one team, so the identity middleware has a caller to resolve. */
async function seed(sql: pg.Client): Promise<void> {
  const person = (await sql.query<{ id: string }>(
    "insert into zz.principal (email, display_name, role) values ($1, $2, 'member') returning id", [MEMBER, MEMBER])).rows[0].id;
  const team = (await sql.query<{ id: string }>(
    "insert into zz.team (slug, name, created_by) values ($1, $1, $2) returning id", [TEAM, person])).rows[0].id;
  await sql.query("insert into zz.membership (team_id, principal_id, role, added_by) values ($1, $2, 'member', $2)", [team, person]);
}

async function run(sql: pg.Client, url: string): Promise<void> {
  await seed(sql);
  const cookie = `zz_console=${await signIn(sql, MEMBER)}`;

  process.env.TEAM_DB_URL = url;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  const express = (await import("express")).default;
  const dbModule = (await load("db.js")) as { initPlatformDb: () => Promise<void> };
  const { identityMiddleware } = (await load("identity.js")) as { identityMiddleware: () => RequestHandler };
  const live = (await load("console/live-revision.js")) as {
    mountConsoleRevision: (app: Express) => void;
    dataVersion: () => string | null;
    COLLECTIONS: readonly string[];
  };
  const envelope = (await load("console/read-envelope.js")) as {
    mountReadEnvelope: (app: Express) => void;
    READ_ROUTES: readonly ReadRoute[];
    collectionsFor: (path: string) => readonly string[] | null;
  };
  const cache = (await load("console/answer-cache.js")) as {
    cachedWithHit: <T>(key: string, read: () => Promise<T>) => Promise<{ value: T; hit: boolean }>;
    served: <T extends { meta: { asOf?: string; cacheHit?: boolean } }>(served: { value: T; hit: boolean }) => T;
  };
  const changes = (await load("console/live.js")) as { mountConsoleLive: (app: Express) => void };
  await dbModule.initPlatformDb();

  // COUPLED: services/gateway/src/server.ts and console.ts — the identity gate, the revision in front of
  // every console read, then the envelope in front of every read, then the read itself.
  const app = express();
  app.use(identityMiddleware());
  live.mountConsoleRevision(app);
  envelope.mountReadEnvelope(app);
  // The one answer with no `meta` of its own: it gains the three request fields and two nulls.
  app.get(BARE, (_req, res) => { res.json({ bare: "an answer carrying no meta of its own" }); });
  // The one answer the cache keeps: `served` states the hit, and `asOf` is the computation's instant.
  app.get(KEPT, async (_req, res) => {
    res.json(cache.served(await cache.cachedWithHit(`${NAME}|kept`, async () => ({
      meta: { asOf: new Date().toISOString() },
      kept: "an answer computed once",
    }))));
  });
  const servers: Server[] = [];
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const read = async (path: string): Promise<Answer> => {
    const res = await fetch(`${base}${path}`, { headers: { cookie, accept: "application/json" } });
    const body = await res.json() as Record<string, unknown>;
    return { status: res.status, body, meta: (body.meta ?? {}) as Meta };
  };
  const present = (step: string, path: string, answer: Answer): void => {
    if (answer.status !== 200) fail(step, `${path} answered ${answer.status}`);
    if (typeof answer.meta.observedAt !== "string" || Number.isNaN(Date.parse(answer.meta.observedAt))) {
      fail(step, `${path} carries meta.observedAt ${JSON.stringify(answer.meta.observedAt)}, not an instant`);
    }
    if (!("revision" in answer.meta)) fail(step, `${path} carries no revision key at all: ${JSON.stringify(Object.keys(answer.meta))}`);
    if (typeof answer.meta.cacheHit !== "boolean") fail(step, `${path} carries meta.cacheHit ${JSON.stringify(answer.meta.cacheHit)}, not a boolean`);
  };

  try {
    // 1. Nothing listening yet: both answers carry the fields, and the marker is an explicit null.
    let step = "with the change listener down both answers carry the fields and a null marker";
    const coldBare = await read(BARE);
    const coldKept = await read(KEPT);
    for (const [path, answer] of [[BARE, coldBare], [KEPT, coldKept]] as const) {
      present(step, path, answer);
      if (answer.meta.revision !== null) fail(step, `${path} carries meta.revision ${JSON.stringify(answer.meta.revision)}, not null while nothing listens`);
      if (answer.meta.cacheHit !== false) fail(step, `${path} carries meta.cacheHit ${answer.meta.cacheHit} with nothing listening`);
    }
    if (coldBare.meta.builtAt !== null || coldBare.meta.sourceRevision !== null) {
      fail(step, `the answer with no meta of its own gained builtAt ${JSON.stringify(coldBare.meta.builtAt)} and ` +
        `sourceRevision ${JSON.stringify(coldBare.meta.sourceRevision)}, not the two nulls an answer computed from rows carries`);
    }
    pass("with the listener down both answers carry observedAt, an explicit null revision, cacheHit false, and null builtAt/sourceRevision");

    // 2. Listening: each answer's marker is the composite of its own declared entry.
    step = "once the listener is up each answer carries the composite its entry names";
    // The real `LISTEN` connection, not a set flag: a write has to reach this process the way it reaches the
    // gateway, or the case below would test a counter nobody increments.
    changes.mountConsoleLive(app);
    for (let waited = 0; live.dataVersion() === null; waited += 100) {
      if (waited > 15_000) fail(step, "the change listener did not come up within 15s");
      await sleep(100);
    }
    const firstBare = await read(BARE);
    const firstKept = await read(KEPT);
    for (const [path, answer] of [[BARE, firstBare], [KEPT, firstKept]] as const) {
      present(step, path, answer);
      const entry = envelope.collectionsFor(path) ?? fail(step, `${path} resolves to no declared entry`);
      const marker = typeof answer.meta.revision === "string" ? answer.meta.revision : "";
      if (marker === "") fail(step, `${path} carries meta.revision ${JSON.stringify(answer.meta.revision)}, not a marker`);
      const named = marker.split(",").map((pair) => pair.slice(0, pair.indexOf(":")));
      const unknown = named.filter((n) => !live.COLLECTIONS.includes(n));
      if (unknown.length) fail(step, `${path} names ${JSON.stringify(unknown)}, which no console tab follows`);
      if (named.join(",") !== entry.join(",")) {
        fail(step, `${path} composes ${named.join(",")}, not the ${entry.join(",")} its entry names`);
      }
    }
    pass(`once listening, each answer composes the collections its own entry names: ` +
      `${(envelope.collectionsFor(BARE) ?? []).length} for ${BARE}, ${(envelope.collectionsFor(KEPT) ?? []).length} for ${KEPT}`);

    // 3. The cache's own hit, and the envelope as a fresh object per request.
    step = "the cached route states its own hit, and observedAt moves while asOf does not";
    if (firstKept.meta.cacheHit !== false) fail(step, `the first listening read reported cacheHit ${firstKept.meta.cacheHit}, not false`);
    await sleep(5);
    const secondBare = await read(BARE);
    const secondKept = await read(KEPT);
    present(step, KEPT, secondKept);
    if (secondKept.meta.cacheHit !== true) fail(step, `an unchanged second read reported cacheHit ${secondKept.meta.cacheHit}, not true`);
    if (Date.parse(secondKept.meta.observedAt!) <= Date.parse(firstKept.meta.observedAt!)) {
      fail(step, `the second read's observedAt ${secondKept.meta.observedAt} is not later than the first's ${firstKept.meta.observedAt}`);
    }
    if (Date.parse(secondBare.meta.observedAt!) <= Date.parse(firstBare.meta.observedAt!)) {
      fail(step, `the plain answer's observedAt ${secondBare.meta.observedAt} is not later than the first's ${firstBare.meta.observedAt}`);
    }
    if (secondKept.meta.asOf !== firstKept.meta.asOf) {
      fail(step, `a served answer moved asOf from ${firstKept.meta.asOf} to ${secondKept.meta.asOf}; asOf is when it was computed`);
    }
    pass("cacheHit reports false on the computation and true on the answer it kept, while observedAt moves and asOf stays");

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
try {
  if (!built()) throw new Error("the tree is not built — run npm run build");
  await staticArm();
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
// Every case has been decided by the time this resolves, and the throwaway database is dropped. The
// process's LISTEN connection is the one thing still alive, and its reconnect timer would otherwise keep
// the process up and turn a green run red — so the run ends here, with the exit code its cases earned.
process.exit(0);
