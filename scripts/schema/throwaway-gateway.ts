/**
 * scripts/schema/throwaway-gateway.ts — the gateway's own built middleware and routes, mounted in
 * this process on a throwaway database the way server.ts mounts them, for the checks that drive the
 * /manage door, the console's routes, OAuth and the passkey ceremony end to end.
 *
 * Needs a built tree (`npm run build`) and a `withThrowawayCore` run to stand on.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import type { Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { issuePat, type Db } from "@zz/contracts";
import { lastJson } from "@zz/mcp-client";
import type { Express, RequestHandler } from "express";
import type pg from "pg";

import { root } from "../deployment.ts";
import type { Core } from "./throwaway-core.ts";

const hash = (s: string | Buffer): Buffer => createHash("sha256").update(s).digest();
const b64 = (b: Buffer): string => b.toString("base64url");

/** The console's own origin, which the passkey ceremony is bound to. Any https origin will do. */
const CONSOLE_URL = "https://console.example.test";

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
    { mountPasskey: (app: Express) => void; issueEnrolment: (principalId: string) => Promise<{ url: string } | null> };
  const { mountSettings } = (await load("services/gateway/dist/settings.js")) as
    { mountSettings: (app: Express) => void };
  const { mountPageView } = (await load("services/gateway/dist/console/page-view.js")) as { mountPageView: (app: Express) => void };
  const { mountPlatformBugResolve } = (await load("services/gateway/dist/console/platform-bug-resolve.js")) as
    { mountPlatformBugResolve: (app: Express) => void };
  const { mountConsoleClose } = (await load("services/gateway/dist/console-close.js")) as { mountConsoleClose: (app: Express) => void };
  const { mountConsoleWrite } = (await load("services/gateway/dist/console-write.js")) as { mountConsoleWrite: (app: Express) => void };
  const { buildAccessServer } = (await load("services/gateway/dist/access-door.js")) as { buildAccessServer: () => unknown };
  const { mountUpload } = (await load("services/gateway/dist/upload.js")) as { mountUpload: (app: Express) => void };
  const { mountBodyParsers } = (await load("services/gateway/dist/body.js")) as { mountBodyParsers: (app: Express) => void };

  const app = express();
  // COUPLED: services/gateway/src/server.ts — the identity gate with its public prefixes let past
  // it, the upload routes, the body parsers, the OAuth surface, the passkey ceremony, the console's routes
  // (mountConsole's page view, bug resolve and close, then mountConsoleWrite and mountSettings),
  // then the /manage door, in the order server.ts mounts them.
  const requireIdentity = identityMiddleware();
  app.use((req, res, next) => {
    if (PUBLIC_PREFIXES.some((p) => req.path.startsWith(p))) { next(); return; }
    requireIdentity(req, res, next);
  });
  mountUpload(app);
  mountBodyParsers(app);
  mountMcpOauth(app, ["/manage/mcp"]);
  passkey.mountPasskey(app);
  mountPageView(app);
  mountPlatformBugResolve(app);
  mountConsoleClose(app);
  mountConsoleWrite(app);
  mountSettings(app);
  serveMcp(app, "/manage/mcp", buildAccessServer);
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));

  const hex = (s: string): string => hash(s).toString("hex");
  const { token } = await insertPat(c, c.email, "", null);
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
    // Never null here: CONSOLE_PUBLIC_URL is set above, before the module loads.
    enrol: async (principalId: string) => (await passkey.issueEnrolment(principalId)) as { url: string },
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.platformDb().end().catch(() => undefined);
      delete process.env.CONSOLE_PUBLIC_URL;
      delete process.env.TEAM_DB_URL;
      delete process.env.ZZ_CATALOG_DIR;
      delete process.env.CORE_MCP_URL;
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

/** A PAT issued for `email` through issuePat, the one write path a token goes through, labelled and
 *  bound as asked: the plaintext and its row id. A live token of the same label is replaced, as
 *  issuePat always does (checks/pat-one-live-per-label.ts). */
export async function insertPat(c: Core, email: string, label: string, team: string | null,
                                extra: { door?: string; oauthClientId?: string } = {}): Promise<{ token: string; id: string }> {
  const { principal_id: principalId, team_id: teamId } = (await c.sql.query<{ principal_id: string; team_id: string | null }>(
    "select p.id as principal_id, (select id from zz.team where slug = $2) as team_id from zz.principal p where p.email = $1",
    [email, team])).rows[0];
  // The check's one client stands in for a pool: issuePat's transaction runs on it, released to nobody.
  const query = ((text: string, params?: unknown[]) => c.sql.query(text, params)) as Db["query"];
  const db: Db = { query, connect: async () => ({ query, release: () => undefined }) };
  const { token, patId } = await issuePat(db, { principalId, teamId, label, expiresAt: null,
    door: extra.door ?? null, oauthClientId: extra.oauthClientId ?? null });
  return { token, id: patId };
}

/** Minimal CBOR: the unsigned and negative integers, byte and text strings, and maps a WebAuthn
 *  attestation and a COSE key are made of. */
function cbor(v: number | string | Buffer | Map<number | string, unknown>): Buffer {
  const head = (major: number, n: number): Buffer =>
    n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n])
      : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x as never)])]);
}

/** A software authenticator holding one P-256 credential for the console's relying party: the
 *  browser's half of a ceremony, everything `navigator.credentials` would answer. */
export function authenticator(): {
  id: string;
  create(challenge: string): Record<string, unknown>;
  get(challenge: string, userHandle: string): Record<string, unknown>;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" }) as
    { publicKey: KeyObject; privateKey: KeyObject };
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const raw = randomBytes(16);
  const id = b64(raw);
  const rpIdHash = hash(new URL(CONSOLE_URL).hostname);
  const clientData = (type: string, challenge: string): Buffer =>
    Buffer.from(JSON.stringify({ type, challenge, origin: CONSOLE_URL, crossOrigin: false }));
  // Flags: user present (0x01) and verified (0x04), and credential data attached (0x40) at creation.
  // The signature counter stays 0, as a synced platform authenticator's does.
  const authData = (flags: number, attested?: Buffer): Buffer =>
    Buffer.concat([rpIdHash, Buffer.from([flags, 0, 0, 0, 0]), ...(attested ? [attested] : [])]);
  return {
    id,
    create(challenge) {
      // COSE_Key: EC2 (1: 2), ES256 (3: -7), P-256 (-1: 1), and the point's two coordinates.
      const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1],
        [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]));
      const len = Buffer.from([raw.length >> 8, raw.length & 255]);
      const attested = Buffer.concat([Buffer.alloc(16), len, raw, cose]);
      const attestation = cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()],
        ["authData", authData(0x45, attested)]]));
      return { id, rawId: id, type: "public-key", clientExtensionResults: {},
               response: { clientDataJSON: b64(clientData("webauthn.create", challenge)),
                           attestationObject: b64(attestation), transports: ["internal"] } };
    },
    get(challenge, userHandle) {
      const data = clientData("webauthn.get", challenge);
      const auth = authData(0x05);
      const signature = sign("sha256", Buffer.concat([auth, hash(data)]), privateKey);
      return { id, rawId: id, type: "public-key", clientExtensionResults: {},
               response: { clientDataJSON: b64(data), authenticatorData: b64(auth), signature: b64(signature),
                           userHandle: b64(Buffer.from(userHandle, "utf8")) } };
    },
  };
}
