/**
 * scripts/schema/throwaway-gateway.ts — the gateway's own built middleware and routes, mounted in
 * this process on a throwaway database the way server.ts mounts them, for the checks that drive the
 * /manage door, the console's routes, OAuth and the passkey ceremony end to end.
 *
 * Needs a built tree (`npm run build`) and a `withThrowawayCore` run to stand on.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { lastJson } from "@zz/mcp-client";
import type { Express, RequestHandler } from "express";
import type pg from "pg";

import { root } from "../deployment.ts";
import type { Core } from "./throwaway-core.ts";

const hash = (s: string | Buffer): Buffer => createHash("sha256").update(s).digest();

/** The console's own origin, which the passkey ceremony is bound to. Any https origin will do. */
export const CONSOLE_URL = "https://console.example.test";

/** The gateway as server.ts mounts the parts this check drives, and the seeded person's
 *  credentials: a PAT for /manage, a console session's cookie secret, and a second session that
 *  stays on the seeded team. */
export interface Gateway {
  url: string; token: string; session: string; teamSession: string;
  /** `issueEnrolment`, the passkey module's own: an enrolment link for one principal. */
  enrol(principalId: string): Promise<{ url: string }>;
  stop(): Promise<void>;
}

/** The paths server.ts lets past the identity gate that this check reaches.
 *  COUPLED: `PUBLIC_PREFIXES` in services/gateway/src/server.ts. */
const PUBLIC_PREFIXES = ["/auth/", "/oauth/"];

export async function listenGateway(c: Core): Promise<Gateway> {
  // Read by passkey.js and mcp-oauth.js when they load, so set before anything is imported.
  process.env.CONSOLE_PUBLIC_URL = CONSOLE_URL;
  // `withThrowawayDb` ended the gateway's pool after migrating; a fresh one on the same container.
  process.env.TEAM_DB_URL = c.url;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  // The console's acts reach zz-core here, the harness's own child.
  process.env.CORE_MCP_URL = c.mcp.url;
  const load = (p: string) => import(pathToFileURL(join(root, p)).href);
  const express = (await import("express")).default;
  const { serveMcp } = (await import("@zz/mcp-http")) as
    { serveMcp: (app: Express, path: string, build: () => unknown) => void };
  const db = (await load("services/gateway/dist/db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await db.initPlatformDb();
  const { identityMiddleware } = (await load("services/gateway/dist/identity.js")) as { identityMiddleware: () => RequestHandler };
  const { mountMcpOauth } = (await load("services/gateway/dist/mcp-oauth.js")) as
    { mountMcpOauth: (app: Express, doors: readonly string[]) => void };
  const passkey = (await load("services/gateway/dist/passkey.js")) as
    { mountPasskey: (app: Express) => void; issueEnrolment: (principalId: string) => Promise<{ url: string }> };
  const { mountSettings } = (await load("services/gateway/dist/settings.js")) as
    { mountSettings: (app: Express, deps: Record<string, unknown>) => void };
  const credentials = (await load("services/gateway/dist/credentials.js")) as Record<string, unknown>;
  const { mountPageView } = (await load("services/gateway/dist/console/page-view.js")) as { mountPageView: (app: Express) => void };
  const { mountPlatformBugResolve } = (await load("services/gateway/dist/console/platform-bug-resolve.js")) as
    { mountPlatformBugResolve: (app: Express) => void };
  const { mountConsoleClose } = (await load("services/gateway/dist/console-close.js")) as { mountConsoleClose: (app: Express) => void };
  const { mountConsoleWrite } = (await load("services/gateway/dist/console-write.js")) as { mountConsoleWrite: (app: Express) => void };
  const { buildAccessServer } = (await load("services/gateway/dist/access-door.js")) as { buildAccessServer: () => unknown };
  const { mountUpload } = (await load("services/gateway/dist/upload.js")) as { mountUpload: (app: Express) => void };

  const app = express();
  // COUPLED: services/gateway/src/server.ts — the identity gate with its public prefixes let past
  // it, the upload routes, the JSON and form parsers, the OAuth surface, the passkey ceremony, the console's routes
  // (mountConsole's page view, bug resolve and close, then mountConsoleWrite and mountSettings),
  // then the /manage door, in the order server.ts mounts them.
  const requireIdentity = identityMiddleware();
  app.use((req, res, next) => {
    if (PUBLIC_PREFIXES.some((p) => req.path.startsWith(p))) { next(); return; }
    requireIdentity(req, res, next);
  });
  mountUpload(app);
  app.use(express.json({ limit: "20mb" }));
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));
  mountMcpOauth(app, ["/manage/mcp"]);
  passkey.mountPasskey(app);
  mountPageView(app);
  mountPlatformBugResolve(app);
  mountConsoleClose(app);
  mountConsoleWrite(app);
  mountSettings(app, {
    issueMyAccessTokenFor: credentials.issueMyAccessTokenFor,
    revokeMyAccessTokenFor: credentials.revokeMyAccessTokenFor,
  });
  serveMcp(app, "/manage/mcp", buildAccessServer);
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));

  const hex = (s: string): string => hash(s).toString("hex");
  const token = `zzp_${randomBytes(24).toString("hex")}`;
  await c.sql.query("insert into zz.pat (principal_id, token_hash) select id, $2 from zz.principal where email = $1",
                    [c.email, hex(token)]);
  const session = randomBytes(24).toString("hex");
  const teamSession = randomBytes(24).toString("hex");
  await c.sql.query(
    `insert into zz.console_session (principal_id, token_hash, expires_at, team_id)
     select p.id, s.h, now() + interval '1 hour', case when s.on_team then t.id end
       from zz.principal p, zz.team t, (values ($2, false), ($3, true)) s (h, on_team)
      where p.email = $1 and t.slug = $4`, [c.email, hex(session), hex(teamSession), c.team]);
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    token, session, teamSession,
    enrol: passkey.issueEnrolment,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.platformDb().end().catch(() => undefined);
      for (const k of ["CONSOLE_PUBLIC_URL", "TEAM_DB_URL", "ZZ_CATALOG_DIR", "CORE_MCP_URL"]) delete process.env[k];
    },
  };
}

/** The headers a caller sends: its credential, and its client name unless it sends none. */
export function headersOf(client: string | null, credential: Record<string, string>): Record<string, string> {
  return { ...credential, "content-type": "application/json", ...(client === null ? {} : { "x-zz-client": client }) };
}


/** One tool on /manage with `token`: the tool's reply text, the JSON-RPC error, or the HTTP status. */
export async function manageCall(g: Gateway, token: string, name: string, args: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${g.url}/manage/mcp`, {
    method: "POST",
    headers: { ...headersOf(null, { authorization: `Bearer ${token}` }), accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(60_000),
  });
  const env = lastJson(await res.text());
  return env?.result?.content?.map((p) => p.text ?? "").join("") ?? env?.error?.message ?? `HTTP ${res.status}`;
}

/** A PAT inserted for `email`, labelled and bound as asked: the plaintext and its row id. */
export async function insertPat(c: Core, email: string, label: string, team: string | null): Promise<{ token: string; id: string }> {
  const token = `zzp_${randomBytes(24).toString("hex")}`;
  const id = String((await c.sql.query(
    `insert into zz.pat (principal_id, token_hash, label, team_id)
     select p.id, $2, $3, (select id from zz.team where slug = $4) from zz.principal p where p.email = $1
     returning id`, [email, hash(token).toString("hex"), label, team])).rows[0].id);
  return { token, id };
}
