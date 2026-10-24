#!/usr/bin/env node
/**
 * checks/console-read-contract.ts — every console GET the console's pages call answers with the instant it
 * was served, the change marker it could hear and the cache's own hit, with the real routes mounted from the
 * built gateway over a real database (AC-1.1, AC-1.2, AC-2.1, AC-3.1).
 *
 *   node checks/console-read-contract.ts   # needs Docker and a built tree (`npm run build`)
 *
 * This is the walking skeleton of the read contract: the whole console read surface, mounted from the built
 * gateway, read over HTTP as a browser reads it, one request per declared route. What it establishes:
 *
 *   - the route list is `read-envelope.ts`'s own `READ_ROUTES`, read through the built module rather than
 *     retyped, so a route the table forgot fails here instead of passing silently;
 *   - **with the change listener down**, every route answers an object carrying `observedAt` as an instant,
 *     a `revision` KEY holding an explicit `null`, and a boolean `cacheHit` — the field is present and null,
 *     never omitted and never invented;
 *   - **once the listener is up**, every route whose entry names collections carries a `revision` that is a
 *     composite of those collections, every name in it one a console tab may follow, and none the route's
 *     own;
 *   - Record, read twice, carries `observedAt` that moves with the request while a served answer's `asOf`
 *     stays at the computation, and `cacheHit` that the cache states itself — false, then true, then false
 *     again after a write that moved the marker.
 *
 * Every route is seeded rather than skipped: the initiative, the document, the lesson, the release and the
 * bug it needs are made here, because a route this check cannot answer is a route nothing covers. A route
 * that still cannot answer fails the run and names what it was answered.
 *
 * It starts a throwaway PostgreSQL migrated by the real runner, one real zz-core on it (`withThrowawayCore`),
 * signs the seeded principal in through a browser session, and serves the gateway's built identity
 * middleware, its console and its settings in `server.ts`'s order. The only database it touches is the one
 * that call started.
 *
 * Exit 0: every case held — one line per route, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";

import type { Express, RequestHandler } from "express";

import { root } from "../scripts/deployment.ts";
import { signIn } from "../scripts/schema/status-seed.ts";
import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";

const NAME = "console-read-contract";
const DONE = "console-read-contract: every console GET the console's pages call answers with the instant it " +
  "was served, the marker it could hear and the cache's own hit, and Record's four cases hold: ok";

/** How many reads one sweep holds: the route table plus nothing. A table that grows past this is a phase of
 *  its own, and the count is printed so the growth is visible rather than inferred. */
const ROUTES_EXPECTED = 41;

type Meta = {
  asOf?: string; observedAt?: string; revision?: string | null; cacheHit?: boolean;
  builtAt?: string | null; sourceRevision?: string | null;
};
type ReadRoute = { path: string; collections: readonly string[] };
type Answer = { status: number; text: string; body: Record<string, unknown> | null };

/** The values a declared path's placeholders take, each a real row the seed made. */
type Seeds = {
  team: string; initiative: string; doc: string; lesson: string; plugin: string; skill: string;
  version: string; bug: string; catalogPlugin: string; catalogSkill: string;
};

/**
 * The address one declared path is read at, or null when the table declares a path this check has no seed
 * for — which fails the run, because a route nothing can address is a route nothing covers.
 */
function addressOf(path: string, s: Seeds): string | null {
  const fixed: Record<string, string> = {
    "/api/console/teams/:slug": `/api/console/teams/${s.team}`,
    "/api/console/initiatives/:team/:slug": `/api/console/initiatives/${s.team}/${s.initiative}`,
    "/api/console/document/:team/:initiative/*": `/api/console/document/${s.team}/${s.initiative}/${s.doc}`,
    "/api/console/knowledge/:team/*": `/api/console/knowledge/${s.team}/${s.lesson}`,
    "/api/console/skills/:name": `/api/console/skills/${s.skill}`,
    "/api/console/plugins/:plugin/skills/:skill": `/api/console/plugins/${s.catalogPlugin}/skills/${s.catalogSkill}`,
    "/api/console/plugins/:plugin/eval": `/api/console/plugins/${s.catalogPlugin}/eval`,
    "/api/console/platform/releases/:version": `/api/console/platform/releases/${s.version}`,
    "/api/console/platform/bugs/:id": `/api/console/platform/bugs/${s.bug}`,
    "/api/console/platform/bugs/:id/duplicates": `/api/console/platform/bugs/${s.bug}/duplicates`,
  };
  if (path in fixed) return fixed[path];
  return path.includes(":") || path.endsWith("*") ? null : path;
}

/** The query each route needs to answer rather than refuse for want of an argument. A route left out is read
 *  with none, which is how its page calls it. */
const QUERIES: Record<string, string> = {
  "/api/console/search": "?q=skeleton",
  "/api/console/work/query": "?measure=opened&by=period",
  "/api/console/platform/query": "?measure=calls&by=tool",
};

/** The team a route that takes it by query is read for. */
const teamQuery = (path: string, team: string): string =>
  path === "/api/console/settings/team/members" ? `?team=${team}` : "";

/** The answer, as the wire gave it. */
async function get(base: string, cookie: string, address: string): Promise<Answer> {
  const res = await fetch(`${base}${address}`, { headers: { cookie, accept: "application/json" } });
  const text = await res.text();
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    body = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { /* not JSON: the caller reports what came back */ }
  return { status: res.status, text, body };
}

const metaOf = (a: Answer): Meta => (a.body?.meta ?? {}) as Meta;
const short = (r: ReadRoute): string => `${r.path} (${r.collections.length} collections)`;

/**
 * The first catalog package that ships a `skills/` directory, and the first skill in it — the two names the
 * plugin-skill route is addressed with, resolved the way that route resolves them rather than guessed.
 */
function catalogWithASkill(dir: string): { plugin: string; skill: string } | null {
  for (const group of readdirSync(dir, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    for (const entry of readdirSync(join(dir, group.name), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skills = join(dir, group.name, entry.name, "skills");
      if (!statSync(skills, { throwIfNoEntry: false })?.isDirectory()) continue;
      const [first] = readdirSync(skills, { withFileTypes: true }).filter((s) => s.isDirectory());
      // The route names a plugin by its flow with the `-flow` suffix taken off (`pluginName` in
      // `@zz/catalog`), so the address is built the same way: `sdlc-flow` is the plugin `sdlc`.
      const plugin = entry.name.endsWith("-flow") ? entry.name.slice(0, -"-flow".length) : entry.name;
      if (first) return { plugin, skill: first.name };
    }
  }
  return null;
}

/** Every field the envelope promises, on one answer. Answers what is wrong, or null when nothing is. */
function envelopeFault(a: Answer, live: boolean, route: ReadRoute, followed: readonly string[]): string | null {
  if (a.status >= 400) return `answered ${a.status}: ${a.text.slice(0, 240)}`;
  if (a.body === null) return `answered ${a.status} with ${a.text.slice(0, 120)}, which is not a JSON object`;
  const meta = metaOf(a);
  if (typeof meta.observedAt !== "string" || Number.isNaN(Date.parse(meta.observedAt))) {
    return `meta.observedAt is ${JSON.stringify(meta.observedAt)}, not an instant`;
  }
  if (!("revision" in meta)) return `the answer carries no revision key at all: ${JSON.stringify(Object.keys(meta))}`;
  if (typeof meta.cacheHit !== "boolean") return `meta.cacheHit is ${JSON.stringify(meta.cacheHit)}, not a boolean`;
  if (!live) return meta.revision === null ? null : `meta.revision is ${JSON.stringify(meta.revision)} with nothing listening, not null`;
  if (route.collections.length === 0) {
    return meta.revision === null ? null : `meta.revision is ${JSON.stringify(meta.revision)} for a route that reads no collection`;
  }
  if (typeof meta.revision !== "string" || meta.revision === "") {
    return `meta.revision is ${JSON.stringify(meta.revision)} while listening, and the route names ${route.collections.join(", ")}`;
  }
  const named = meta.revision.split(",").map((pair) => pair.slice(0, pair.indexOf(":")));
  const unknown = named.filter((n) => !followed.includes(n));
  if (unknown.length) return `meta.revision names ${JSON.stringify(unknown)}, which no console tab follows`;
  const missing = route.collections.filter((c) => !named.includes(c));
  if (missing.length) return `meta.revision leaves out ${JSON.stringify(missing)}, which the table says the route reads`;
  return null;
}

async function run(c: Core): Promise<void> {
  // The superadmin reads the most: the rosters, the bug report, the audit and the people list refuse a
  // member, and a route this check cannot reach is a route nothing covers.
  await c.sql.query("update zz.principal set role = 'superadmin' where email = $1", [c.email]);
  const cookie = `zz_console=${await signIn(c.sql, c.email)}`;

  // What the routes read, made rather than skipped: one initiative, one document under it, one lesson on the
  // team's shelf.
  let step = "the seed every route is answered from";
  const initiative = await c.open("read-contract");
  await c.ok(step, "document_write", {
    path: `${initiative}/spec.md`,
    title: "The read contract's own document",
    content: "# The read contract\n\n## A body a route can read\n\nThe route that answers a document answers this one.\n",
  });
  const lessonReply = await c.ok(step, "knowledge_add", {
    title: "The read contract's own lesson",
    type: "decision",
    body: "A lesson the knowledge route answers.",
    evidence: [initiative],
    scope: "team",
  });
  const { rows: [version] } = await c.sql.query<{ version: string }>(
    `insert into zz.release (version, console_version, released_at, summary, changelog)
     values ('0.0.1-read-contract', '0.0.1', now(), 'The read contract''s own release',
             'Created by checks/console-read-contract.ts')
     returning version`);
  const { rows: [{ id: reporter }] } = await c.sql.query<{ id: string }>(
    "select id from zz.principal where email = $1", [c.email]);
  const { rows: [bug] } = await c.sql.query<{ id: string }>(
    `insert into zz.bug (title, detail, surface, impact, status, reported_by)
     values ('The read contract''s own bug', 'Reported by checks/console-read-contract.ts', 'the console',
             'confusing', 'open', $1)
     returning id::text as id`, [reporter]);
  const nodeRows = await c.sql.query<{ address: string; shelf: string }>(
    `select 'nodes/' || n.node_ordinal || '-' || n.slug || '.md' as address, t.slug as shelf
       from zz.knowledge_node n join zz.team t on t.id = n.team_id
      order by n.created_at desc limit 5`);
  const lesson = nodeRows.rows.find((r) => r.shelf === c.team) ?? nodeRows.rows[0];
  // The catalog's rows are made by the release, not by a service booting (`register-plugins`), so a throwaway
  // database holds none: one plugin and one skill are declared here, which is what the three catalog routes
  // need in order to answer a real subject rather than a 404.
  const { rows: [plugin] } = await c.sql.query<{ name: string }>(
    `insert into zz.plugin (name, origin) values ('read-contract-plugin', 'third_party')
     on conflict (name) do update set origin = excluded.origin returning name`);
  const { rows: [skill] } = await c.sql.query<{ name: string }>(
    `insert into zz.skill (name) values ('read-contract-skill')
     on conflict (name) do update set retired = zz.skill.retired returning name`);
  // One plugin skill is read off DISK rather than out of a table (`catalog.ts` walks the catalog directory), so
  // its two names come from the catalog this tree ships: the first package that has a `skills/` directory, and
  // the first skill in it. Reading them is how the route resolves them, so the check resolves them the same way.
  const catalog = catalogWithASkill(join(root, "catalog"));
  const missing = [
    !lesson && `a lesson's address (knowledge_add answered ${lessonReply.slice(0, 300)})`,
    catalog === null && "a catalog package that ships a skill",
  ].filter((x): x is string => Boolean(x));
  if (missing.length || catalog === null) c.fail(step, `the seed found no ${missing.join(", ")} — nothing can address the routes that read one`);
  const seeds: Seeds = {
    team: c.team, initiative, doc: "spec.md", lesson: lesson.address, plugin: plugin.name,
    skill: skill.name, version: version.version, bug: bug.id,
    catalogPlugin: catalog.plugin, catalogSkill: catalog.skill,
  };
  c.pass(`${step}: an initiative, a document, a lesson, a release, a bug, a plugin and a skill are read by it`);

  process.env.TEAM_DB_URL = c.url;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  process.env.CORE_MCP_URL = c.mcp.url;
  process.env.GATEWAY_PUBLIC_URL = "https://gateway.read-contract.example.test";
  const load = (p: string) => import(pathToFileURL(join(root, "services/gateway/dist", p)).href);
  const express = (await import("express")).default;
  const dbModule = (await load("db.js")) as { initPlatformDb: () => Promise<void> };
  const { identityMiddleware } = (await load("identity.js")) as { identityMiddleware: () => RequestHandler };
  const live = (await load("console/live-revision.js")) as {
    mountConsoleRevision: (app: Express) => void; listening: () => void; notListening: () => void;
    dataVersion: () => string | null; COLLECTIONS: readonly string[];
  };
  const envelope = (await load("console/read-envelope.js")) as {
    mountReadEnvelope: (app: Express) => void; READ_ROUTES: readonly ReadRoute[];
  };
  const { mountConsole } = (await load("console.js")) as { mountConsole: (app: Express) => void };
  const { mountSettings } = (await load("settings.js")) as { mountSettings: (app: Express, deps: unknown) => void };
  const credentials = (await load("credentials.js")) as Record<string, unknown>;
  await dbModule.initPlatformDb();

  // COUPLED: services/gateway/src/server.ts and console.ts — the identity gate, the console's reads with the
  // revision and the envelope in front of them, then the settings surface it mounts last.
  const app = express();
  app.use(identityMiddleware());
  mountConsole(app);
  mountSettings(app, {
    myAccessTokensFor: credentials.myAccessTokensFor, issueMyAccessTokenFor: credentials.issueMyAccessTokenFor,
    revokeMyAccessTokenFor: credentials.revokeMyAccessTokenFor,
  });
  const servers: Server[] = [];
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  try {
    step = "the route table";
    const routes = envelope.READ_ROUTES;
    const paths = routes.map((r) => r.path);
    const duplicates = paths.filter((p, i) => paths.indexOf(p) !== i);
    if (duplicates.length) c.fail(step, `the table declares ${duplicates.join(", ")} twice, so one entry's marker is unreachable`);
    if (routes.length !== ROUTES_EXPECTED) {
      c.fail(step, `the table declares ${routes.length} routes, not the ${ROUTES_EXPECTED} this check was written for — ` +
        "grow it here in the same change, so the new route is covered rather than assumed");
    }
    const unaddressable = routes.filter((r) => addressOf(r.path, seeds) === null).map((r) => r.path);
    if (unaddressable.length) c.fail(step, `this check has no seed for ${unaddressable.join(", ")} — add one rather than skipping the route`);
    c.pass(`${step}: ${routes.length} console GETs declared, each addressable, none twice`);

    /** One sweep over every declared route, and one line per route. */
    const sweep = async (listening: boolean): Promise<void> => {
      const faults: string[] = [];
      for (const route of routes) {
        const address = addressOf(route.path, seeds)! + (QUERIES[route.path] ?? teamQuery(route.path, seeds.team));
        const a = await get(base, cookie, address);
        const fault = envelopeFault(a, listening, route, live.COLLECTIONS);
        if (fault) faults.push(`${route.path}: ${fault}`);
        const meta = metaOf(a);
        console.log(`  ${listening ? "listening" : "quiet    "} ${short(route)}: ` +
          (fault ?? `envelope present, revision ${meta.revision === null ? "an explicit null" : `${String(meta.revision).split(",").length} collections`}`));
      }
      if (faults.length) c.fail(step, `${faults.length} of ${routes.length} routes answer without the envelope:\n    ${faults.join("\n    ")}`);
    };

    step = "with the change listener down every route answers the envelope and an explicit null marker";
    // DELIBERATE: `mountConsole` mounts the live stream, so this process's `LISTEN` connection is opened by the
    // time the routes answer. A read taken while no listener is up is a read a gateway answers in the seconds
    // after it boots, and the state is produced here the way that gateway produces it rather than by mocking it:
    // the same module, told what it does when its connection is not there. The wait first, so the connection's
    // own open has happened and cannot re-arm the marker underneath the sweep below.
    for (let waited = 0; live.dataVersion() === null; waited += 100) {
      if (waited > 15_000) c.fail(step, "the change listener never came up, so the listener-down arm would prove nothing");
      await new Promise((r) => setTimeout(r, 100));
    }
    live.notListening();
    if (live.dataVersion() !== null) c.fail(step, `dataVersion is ${live.dataVersion()} after the listener was taken down`);
    await sweep(false);
    c.pass(`${step}: all ${routes.length} answered`);

    // Record's four cases, the phase this contract began in: they are the ones that pin the MEANING of the
    // three fields, where the sweep above pins only that they are there.
    const record = async (): Promise<Answer> => get(base, cookie, "/api/console/record");
    step = "Record: with the listener down, observedAt and revision are present and revision is an explicit null";
    const cold = await record();
    if (cold.status !== 200) c.fail(step, `/api/console/record answered ${cold.status}: ${cold.text.slice(0, 240)}`);
    if (metaOf(cold).cacheHit !== false) c.fail(step, `meta.cacheHit is ${metaOf(cold).cacheHit} with nothing listening`);
    c.pass("with the listener down, observedAt and revision are present and revision is an explicit null");

    step = "once the listener is up the marker composes collections a tab may follow";
    // The real `LISTEN` connection, not a set flag: `mountConsole` opened it (`console/live.ts`), and this is the
    // module being told a new boot has begun — a write then reaches this process the way it reaches the gateway,
    // or the case below would test a counter nobody increments.
    live.listening();
    for (let waited = 0; live.dataVersion() === null; waited += 100) {
      if (waited > 15_000) c.fail(step, "the change listener did not come up within 15s");
      await new Promise((r) => setTimeout(r, 100));
    }
    const first = await record();
    if (first.status !== 200) c.fail(step, `/api/console/record answered ${first.status}: ${first.text.slice(0, 240)}`);
    const marker = typeof metaOf(first).revision === "string" ? metaOf(first).revision! : "";
    if (marker === "") c.fail(step, `meta.revision is ${JSON.stringify(metaOf(first).revision)}, not a marker`);
    const named = marker.split(",").map((pair) => pair.slice(0, pair.indexOf(":")));
    const unknown = named.filter((n) => !live.COLLECTIONS.includes(n));
    if (unknown.length) c.fail(step, `the marker names ${JSON.stringify(unknown)}, which no console tab follows`);
    if (named.includes("record")) c.fail(step, "the marker names `record`, which is a route and not a collection");
    c.pass(`once listening, revision composes ${named.length} followed collections (${named.join(", ")})`);

    step = "once listening every route answers the envelope and its own composite marker";
    // DELIBERATE: after the two cache cases below, not before them. This sweep is 41 requests and several of the
    // routes behind them record what they did — `/search` is zz-core's `knowledge_search`, which writes an
    // event — so a sweep between two reads of one answer moves the marker they are compared on, and the second
    // would be a computation rather than the kept answer the case exists to read.
    const liveStep = "once listening every route answers the envelope and its own composite marker";
    const sweepLive = async (): Promise<void> => {
      step = liveStep;
      await sweep(true);
      c.pass(`${liveStep}: all ${routes.length} answered`);
    };

    step = "observedAt is this request's instant while a served answer keeps the one it was computed at";
    await new Promise((r) => setTimeout(r, 5));
    const second = await record();
    if (second.status !== 200) c.fail(step, `/api/console/record answered ${second.status}`);
    const [was, now] = [metaOf(first).observedAt!, metaOf(second).observedAt!];
    if (Date.parse(now) <= Date.parse(was)) c.fail(step, `the second read's observedAt ${now} is not later than the first's ${was}`);
    if (metaOf(second).asOf !== metaOf(first).asOf) {
      c.fail(step, `a served answer moved asOf from ${metaOf(first).asOf} to ${metaOf(second).asOf}; asOf is when it was computed`);
    }
    c.pass("observedAt moves with the request while asOf stays at the computation");

    step = "cacheHit is stated by the cache: false, then true, then false again after a write";
    if (metaOf(first).cacheHit !== false) c.fail(step, `the first listening read reported cacheHit ${metaOf(first).cacheHit}, not false`);
    if (metaOf(second).cacheHit !== true) c.fail(step, `an unchanged second read reported cacheHit ${metaOf(second).cacheHit}, not true`);
    const { rows: [{ id: teamId }] } = await c.sql.query<{ id: string }>("select id from zz.team where slug = $1", [c.team]);
    await c.sql.query(
      "insert into zz.event (kind, origin, subject, ok, tool_key, team_id) values ('tool_call', 'work', 'work', true, 'document_read', $1)",
      [teamId]);
    await new Promise((r) => setTimeout(r, 50));
    const after = await record();
    if (after.status !== 200) c.fail(step, `/api/console/record answered ${after.status} after the write`);
    if (metaOf(after).cacheHit !== false) {
      c.fail(step, `after a write the answer reported cacheHit ${metaOf(after).cacheHit}, not false — the marker did not move`);
    }
    c.pass("cacheHit reports false on a computation, true on the answer it kept, and false again after a write");

    await sweepLive();

    // The process's one LISTEN connection is ended from the database side, the way `console-live-since.ts`
    // does: left open, its socket dies with the throwaway database and the error turns a green run red.
    step = "the listener is ended cleanly after the last case";
    const ended = await c.sql.query("select pg_terminate_backend(pid) from pg_stat_activity where query like 'listen zz_console_change%'");
    if (ended.rowCount !== 1) c.fail(step, `found ${ended.rowCount} listening connections to end, not one`);
    await new Promise((r) => setTimeout(r, 200));
  } finally {
    for (const s of servers) s.close();
  }
}

process.exit(await withThrowawayCore(NAME, DONE, run));
