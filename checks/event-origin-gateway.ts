#!/usr/bin/env node
/**
 * checks/event-origin-gateway.ts — every event the gateway writes says where it came from: an
 * administration act, a team switch and a console write each land with the origin of the client
 * that made them (AC-4.5, so Audit can label a maintenance act).
 *
 *   node checks/event-origin-gateway.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL migrated by the real runner and a real zz-core on it
 * (`withThrowawayCore`), and the gateway's own built middleware and routes in this process: the
 * identity gate, the JSON parser, the console's settings, its page view and its bug resolve, and
 * the /manage door, in the order server.ts mounts them. The seeded person is made a superadmin,
 * holds a PAT and a console session. For each client below, sent as `x-zz-client` (or not sent),
 * it makes:
 *
 *   - an administration act on each door: `team_create` on /manage, and the console's team create;
 *   - a team switch on each door: `team_switch` on /manage, and the console's own switch;
 *   - console writes: a token issued and revoked from Settings, and a bug resolved;
 *
 * and reads the row each one wrote. Each of the three maintenance clients, in any case and with a
 * version after it, lands `platform`; another client and no header land `work`. A page view stays
 * `work` whoever sent it, as the spec says.
 *
 * DELIBERATE: the three names and both origins are written here and nothing is imported from
 * `@zz/contracts`. A check that read them from the code under test would agree with whatever it
 * said.
 *
 * The only database this touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { lastJson } from "@zz/mcp-client";
import type { Express, RequestHandler } from "express";
import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";

const NAME = "event-origin-gateway";
const DONE = "event-origin-gateway: an administration act, a team switch and a console write made by a maintenance client " +
  "land platform on the row the gateway writes, by any other client or none land work, and a page view stays work: ok";

type Origin = "work" | "platform";

/** A client name as a caller sends it, or no header at all, and the origin its acts must read. */
const CLIENTS: readonly { client: string | null; origin: Origin }[] = [
  { client: "chain-check", origin: "platform" },
  { client: "zz-migrate", origin: "platform" },
  { client: "zz-doctor", origin: "platform" },
  { client: "Zz-Doctor/0.96.0 (darwin arm64)", origin: "platform" },
  { client: "zz-plugin", origin: "work" },
  { client: null, origin: "work" },
];

/** A page view per client, each naming its own destination so its row is found by its subject. */
const PAGES = ["home", "record", "initiatives", "approvals", "knowledge", "activity"];

const shown = (client: string | null): string => (client === null ? "no client" : JSON.stringify(client));

/** Rows matching `sql`, waited on until there are `n` of them: the gateway writes an event after
 *  the answer it describes, so it is polled for, briefly. */
async function rowsOnce<T extends pg.QueryResultRow>(c: Core, sql: string, params: unknown[], n: number): Promise<T[]> {
  const until = Date.now() + 5000;
  for (;;) {
    const { rows } = await c.sql.query<T>(sql, params);
    if (rows.length >= n || Date.now() > until) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The gateway as server.ts mounts the parts this check drives, and the seeded person's two
 *  credentials: a PAT for /manage and a console session's cookie secret. */
interface Gateway { url: string; token: string; session: string; stop(): Promise<void> }

async function listen(c: Core): Promise<Gateway> {
  // `withThrowawayDb` ended the gateway's pool after migrating; a fresh one on the same container.
  process.env.TEAM_DB_URL = c.url;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  // The bug resolve reaches zz-core here, the harness's own child.
  process.env.CORE_MCP_URL = c.mcp.url;
  const load = (p: string) => import(pathToFileURL(join(root, p)).href);
  const express = (await import("express")).default;
  const { serveMcp } = (await import("@zz/mcp-http")) as
    { serveMcp: (app: Express, path: string, build: () => unknown) => void };
  const db = (await load("services/gateway/dist/db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await db.initPlatformDb();
  const { identityMiddleware } = (await load("services/gateway/dist/identity.js")) as { identityMiddleware: () => RequestHandler };
  const { mountSettings } = (await load("services/gateway/dist/settings.js")) as
    { mountSettings: (app: Express, deps: Record<string, unknown>) => void };
  const credentials = (await load("services/gateway/dist/credentials.js")) as Record<string, unknown>;
  const { mountPageView } = (await load("services/gateway/dist/console/page-view.js")) as { mountPageView: (app: Express) => void };
  const { mountPlatformBugResolve } = (await load("services/gateway/dist/console/platform-bug-resolve.js")) as
    { mountPlatformBugResolve: (app: Express) => void };
  const { buildAccessServer } = (await load("services/gateway/dist/access-door.js")) as { buildAccessServer: () => unknown };

  const app = express();
  // COUPLED: services/gateway/src/server.ts — the identity gate, the JSON parser, the console's
  // routes, then the /manage door, in the order server.ts mounts them.
  app.use(identityMiddleware());
  app.use(express.json({ limit: "20mb" }));
  mountPageView(app);
  mountPlatformBugResolve(app);
  mountSettings(app, {
    myAccessTokensFor: credentials.myAccessTokensFor,
    issueMyAccessTokenFor: credentials.issueMyAccessTokenFor,
    revokeMyAccessTokenFor: credentials.revokeMyAccessTokenFor,
  });
  serveMcp(app, "/manage/mcp", buildAccessServer);
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));

  const hash = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
  const token = `zzp_${randomBytes(24).toString("hex")}`;
  await c.sql.query("insert into zz.pat (principal_id, token_hash) select id, $2 from zz.principal where email = $1",
                    [c.email, hash(token)]);
  const session = randomBytes(24).toString("hex");
  await c.sql.query(
    `insert into zz.console_session (principal_id, token_hash, expires_at)
     select id, $2, now() + interval '1 hour' from zz.principal where email = $1`, [c.email, hash(session)]);
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    token, session,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.platformDb().end().catch(() => undefined);
      delete process.env.TEAM_DB_URL;
      delete process.env.ZZ_CATALOG_DIR;
      delete process.env.CORE_MCP_URL;
    },
  };
}

/** The headers a caller sends: its credential, and its client name unless it sends none. */
function headersOf(client: string | null, credential: Record<string, string>): Record<string, string> {
  return { ...credential, "content-type": "application/json", ...(client === null ? {} : { "x-zz-client": client }) };
}

/** One tool on /manage, with the PAT, as `client`: the tool's reply. */
async function tool(c: Core, g: Gateway, step: string, client: string | null, name: string,
                    args: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${g.url}/manage/mcp`, {
    method: "POST",
    headers: { ...headersOf(client, { authorization: `Bearer ${g.token}` }), accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(60_000),
  });
  const raw = await res.text();
  const env = lastJson(raw);
  const reply = env?.result?.content?.map((p) => p.text ?? "").join("") ?? env?.error?.message ?? raw.slice(0, 300);
  if (res.status !== 200 || !reply || reply.startsWith("ERROR")) {
    c.fail(step, `${name} as ${shown(client)} answered ${res.status}: ${reply.slice(0, 300)}`);
  }
  return reply;
}

/** One console route, signed in as the console session, as `client`: its status and body. */
async function consoleCall(g: Gateway, client: string | null, method: string, path: string,
                           body?: Record<string, unknown>): Promise<{ status: number; body: string }> {
  const res = await fetch(`${g.url}${path}`, {
    method,
    headers: headersOf(client, { cookie: `zz_console=${g.session}` }),
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  return { status: res.status, body: await res.text() };
}

/** The origin of every row of `kind` about `subject`: exactly one is expected. */
async function originOf(c: Core, step: string, kind: string, subject: string, client: string | null): Promise<string> {
  const rows = await rowsOnce<{ origin: string }>(c,
    "select origin from zz.event where kind = $1 and subject = $2", [kind, subject], 1);
  if (rows.length !== 1) {
    c.fail(step, `${kind} about ${subject}, made by ${shown(client)}, left ${rows.length} rows, not one`);
  }
  return rows[0].origin;
}

async function seed(c: Core): Promise<void> {
  // A superadmin, so every tier of /manage is registered and the console's platform writes admit them.
  await c.sql.query("update zz.principal set role = 'superadmin' where email = $1", [c.email]);
  // One team per switch, so each switch's row is found by its subject.
  for (const [i] of CLIENTS.entries()) {
    for (const door of ["mcp", "web"]) {
      await c.sql.query(
        `with t as (insert into zz.team (slug, name, created_by)
                    select $2, $2, id from zz.principal where email = $1 returning id)
         insert into zz.membership (team_id, principal_id, role, added_by)
         select t.id, p.id, 'member', p.id from t, zz.principal p where p.email = $1`,
        [c.email, `${door}-switch-${i}`]);
    }
  }
}

/** A report per client, open, for the console's resolve to close. */
const bugId = (i: number): string => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;

async function seedBugs(c: Core): Promise<void> {
  for (const [i] of CLIENTS.entries()) {
    await c.sql.query(
      `insert into zz.bug (id, title, detail, team_id, reported_by, status)
       select $1::uuid, 'Probe', 'A report for the console to close.', t.id, p.id, 'open'
         from zz.team t, zz.principal p where t.slug = $2 and p.email = $3`, [bugId(i), c.team, c.email]);
  }
}

async function cases(c: Core, g: Gateway): Promise<void> {
  const wrong: string[] = [];
  const expect = async (step: string, kind: string, subject: string, f: (typeof CLIENTS)[number]): Promise<void> => {
    const origin = await originOf(c, step, kind, subject, f.client);
    if (origin !== f.origin) wrong.push(`${kind} about ${subject} by ${shown(f.client)} reads ${origin}, not ${f.origin}`);
  };
  for (const [i, f] of CLIENTS.entries()) {
    let step = `an administration act on /manage as ${shown(f.client)}`;
    await tool(c, g, step, f.client, "team_create", { slug: `mcp-made-${i}`, name: `Made on manage ${i}` });
    await expect(step, "admin.create_team", `mcp-made-${i}`, f);

    step = `an administration act in the console as ${shown(f.client)}`;
    const made = await consoleCall(g, f.client, "POST", "/api/console/settings/platform/teams",
                                   { slug: `web-made-${i}`, name: `Made in the console ${i}` });
    if (made.status !== 200) c.fail(step, `answered ${made.status}: ${made.body.slice(0, 300)}`);
    await expect(step, "admin.create_team", `web-made-${i}`, f);

    step = `a team switch on /manage as ${shown(f.client)}`;
    await tool(c, g, step, f.client, "team_switch", { team: `mcp-switch-${i}` });
    await expect(step, "team.switch", `mcp-switch-${i}`, f);

    step = `a team switch in the console as ${shown(f.client)}`;
    const switched = await consoleCall(g, f.client, "POST", "/api/console/settings/me/active-team", { team: `web-switch-${i}` });
    if (switched.status !== 200) c.fail(step, `answered ${switched.status}: ${switched.body.slice(0, 300)}`);
    await expect(step, "team.switch", `web-switch-${i}`, f);

    step = `a token issued and revoked in the console as ${shown(f.client)}`;
    const label = `origin probe ${i}`;
    const issued = await consoleCall(g, f.client, "POST", "/api/console/settings/me/tokens", { label });
    if (issued.status !== 200) c.fail(step, `issue answered ${issued.status}: ${issued.body.slice(0, 300)}`);
    await expect(step, "pat.self_issue", label, f);
    const pat = (await c.sql.query<{ id: string }>("select id::text as id from zz.pat where label = $1", [label])).rows[0];
    if (!pat) c.fail(step, `no token labelled ${label} was stored`);
    const revoked = await consoleCall(g, f.client, "DELETE", `/api/console/settings/me/tokens/${pat.id}`);
    if (revoked.status !== 200) c.fail(step, `revoke answered ${revoked.status}: ${revoked.body.slice(0, 300)}`);
    await expect(step, "pat.self_revoke", pat.id, f);

    step = `a bug resolved in the console as ${shown(f.client)}`;
    const resolved = await consoleCall(g, f.client, "POST", `/api/console/platform/bugs/${bugId(i)}/resolve`,
                                       { status: "fixed", resolution: "Closed by the origin probe." });
    if (resolved.status !== 204) c.fail(step, `answered ${resolved.status}: ${resolved.body.slice(0, 300)}`);
    await expect(step, "bug.console_resolve", bugId(i), f);
  }
  if (wrong.length) c.fail("each act lands its client's origin", wrong.join("; "));
  const names = (o: Origin): string => CLIENTS.filter((f) => f.origin === o).map((f) => shown(f.client)).join(", ");
  c.pass(`an administration act on /manage and in the console lands platform for ${names("platform")} and work for ${names("work")}`);
  c.pass("a team switch on /manage and in the console lands the same origins");
  c.pass("a console write — a token issued, a token revoked, a bug resolved — lands the same origins");
}

async function pageViews(c: Core, g: Gateway): Promise<void> {
  const step = "a page view stays work";
  for (const [i, f] of CLIENTS.entries()) {
    const viewed = await consoleCall(g, f.client, "POST", "/api/console/page-view", { feature: PAGES[i] });
    if (viewed.status !== 204) c.fail(step, `${PAGES[i]} as ${shown(f.client)} answered ${viewed.status}: ${viewed.body.slice(0, 300)}`);
    const origin = await originOf(c, step, "console.page_view", PAGES[i], f.client);
    if (origin !== "work") c.fail(step, `the page view of ${PAGES[i]} by ${shown(f.client)} reads ${origin}, not work`);
  }
  c.pass(`a page view lands work whoever sent it, ${CLIENTS.map((f) => shown(f.client)).join(", ")} included`);
}

async function run(c: Core): Promise<void> {
  await seed(c);
  await seedBugs(c);
  const g = await listen(c);
  try {
    await cases(c, g);
    await pageViews(c, g);
  } finally {
    await g.stop();
  }
}

process.exitCode = await withThrowawayCore(NAME, DONE, run);
