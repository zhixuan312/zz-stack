#!/usr/bin/env node
/**
 * checks/event-origin-gateway.ts — every event the gateway writes says where it came from: an
 * administration act, a team switch, a console write, a credential an OAuth client obtains and a
 * browser's sign-in each land with the origin of the client that made them (AC-4.5, so Audit can
 * label a maintenance act).
 *
 *   node checks/event-origin-gateway.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL migrated by the real runner and a real zz-core on it
 * (`withThrowawayCore`), and the gateway's own built middleware and routes in this process: the
 * identity gate with the two public prefixes this check reaches let past it, the JSON and form
 * parsers, the OAuth surface, the passkey ceremony, the console's page view, bug resolve and close,
 * its document writes, its settings, and the /manage door, in the order server.ts mounts them. The
 * seeded person is made a superadmin, holds a PAT and two console sessions — one for the switches,
 * one that stays on the seeded team for the document writes and the close. For each client below,
 * sent as `x-zz-client` (or not sent), it makes:
 *
 *   - an administration act on each door: `team_create` on /manage, and the console's team create;
 *   - a team switch on each door: `team_switch` on /manage, and the console's own switch;
 *   - console writes: a token issued and revoked from Settings, a bug resolved, a document shown and
 *     approved (`document.console_shown`, `document.approve`), an initiative closed
 *     (`initiative.console_close`), and another browser of the person's signed out
 *     (`console.sign_out`);
 *   - a credential obtained by an OAuth client (`credential.set`): registered, authorized as the
 *     console session on a loopback redirect, which needs no consent page, and exchanged at
 *     `/oauth/token`, form-encoded as the MCP SDK sends it;
 *   - a passkey registered and signed in with (`console.passkey_registered`, `console.sign_in`), by
 *     a person of its own, enrolled through `issueEnrolment`. The browser's half of the ceremony is
 *     a software authenticator here: a P-256 key, `none` attestation, and an assertion signed over
 *     the challenge the route issued. Everything the gateway does — the challenge, the ceremony
 *     cookie, `@simplewebauthn/server`'s verification, the row — is the real route's;
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
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import type { Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { lastJson } from "@zz/mcp-client";
import type { Express, RequestHandler } from "express";
import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";

const NAME = "event-origin-gateway";
const DONE = "event-origin-gateway: an administration act, a team switch, a console write — a token, a bug, a document " +
  "shown and approved, an initiative closed, a browser signed out — an OAuth credential and a passkey registration " +
  "and sign-in made by a maintenance client land platform on the row the gateway writes, by any other client or " +
  "none land work, and a page view stays work: ok";

/** The console's own origin, which the passkey ceremony is bound to. Any https origin will do. */
const CONSOLE_URL = "https://console.example.test";

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
type Client = (typeof CLIENTS)[number];

/** A page view per client, each naming its own destination so its row is found by its subject. */
const PAGES = ["home", "record", "initiatives", "approvals", "knowledge", "activity"];

const shown = (client: string | null): string => (client === null ? "no client" : JSON.stringify(client));
const b64 = (b: Buffer): string => b.toString("base64url");
const hash = (s: string | Buffer): Buffer => createHash("sha256").update(s).digest();

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

/** The gateway as server.ts mounts the parts this check drives, and the seeded person's
 *  credentials: a PAT for /manage, a console session's cookie secret, and a second session that
 *  stays on the seeded team. */
interface Gateway {
  url: string; token: string; session: string; teamSession: string;
  /** `issueEnrolment`, the passkey module's own: an enrolment link for one principal. */
  enrol(principalId: string): Promise<{ url: string }>;
  stop(): Promise<void>;
}

/** The paths server.ts lets past the identity gate that this check reaches.
 *  COUPLED: `PUBLIC_PREFIXES` in services/gateway/src/server.ts. */
const PUBLIC_PREFIXES = ["/auth/", "/oauth/"];

async function listen(c: Core): Promise<Gateway> {
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

  const app = express();
  // COUPLED: services/gateway/src/server.ts — the identity gate with its public prefixes let past
  // it, the JSON and form parsers, the OAuth surface, the passkey ceremony, the console's routes
  // (mountConsole's page view, bug resolve and close, then mountConsoleWrite and mountSettings),
  // then the /manage door, in the order server.ts mounts them.
  const requireIdentity = identityMiddleware();
  app.use((req, res, next) => {
    if (PUBLIC_PREFIXES.some((p) => req.path.startsWith(p))) { next(); return; }
    requireIdentity(req, res, next);
  });
  app.use(express.json({ limit: "20mb" }));
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));
  mountMcpOauth(app, ["/manage/mcp"]);
  passkey.mountPasskey(app);
  mountPageView(app);
  mountPlatformBugResolve(app);
  mountConsoleClose(app);
  mountConsoleWrite(app);
  mountSettings(app, {
    myAccessTokensFor: credentials.myAccessTokensFor,
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

/** One console route, signed in as a console session (the switching one unless `session` names
 *  another), as `client`: its status and body. */
async function consoleCall(g: Gateway, client: string | null, method: string, path: string,
                           body?: Record<string, unknown>, session = g.session): Promise<{ status: number; body: string }> {
  const res = await fetch(`${g.url}${path}`, {
    method,
    headers: headersOf(client, { cookie: `zz_console=${session}` }),
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  return { status: res.status, body: await res.text() };
}

/** The origin of the one row `where` finds in `zz.event e`, named `about` in a failure. */
async function originWhere(c: Core, step: string, about: string, client: string | null,
                           where: string, params: unknown[]): Promise<string> {
  const rows = await rowsOnce<{ origin: string }>(c, `select e.origin from zz.event e where ${where}`, params, 1);
  if (rows.length !== 1) c.fail(step, `${about}, made by ${shown(client)}, left ${rows.length} rows, not one`);
  return rows[0].origin;
}

/** The origin of every row of `kind` about `subject`: exactly one is expected. */
const originOf = (c: Core, step: string, kind: string, subject: string, client: string | null): Promise<string> =>
  originWhere(c, step, `${kind} about ${subject}`, client, "e.kind = $1 and e.subject = $2", [kind, subject]);

/** Collects every act whose row reads the wrong origin, so one run names them all. */
function judge(): { wrong: string[]; expect(about: string, origin: string, f: Client): void } {
  const wrong: string[] = [];
  return { wrong, expect: (about, origin, f) => {
    if (origin !== f.origin) wrong.push(`${about} by ${shown(f.client)} reads ${origin}, not ${f.origin}`);
  } };
}

const names = (o: Origin): string => CLIENTS.filter((f) => f.origin === o).map((f) => shown(f.client)).join(", ");

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
  const { wrong, expect } = judge();
  const check = async (step: string, kind: string, subject: string, f: Client): Promise<void> =>
    expect(`${kind} about ${subject}`, await originOf(c, step, kind, subject, f.client), f);
  for (const [i, f] of CLIENTS.entries()) {
    let step = `an administration act on /manage as ${shown(f.client)}`;
    await tool(c, g, step, f.client, "team_create", { slug: `mcp-made-${i}`, name: `Made on manage ${i}` });
    await check(step, "admin.create_team", `mcp-made-${i}`, f);

    step = `an administration act in the console as ${shown(f.client)}`;
    const made = await consoleCall(g, f.client, "POST", "/api/console/settings/platform/teams",
                                   { slug: `web-made-${i}`, name: `Made in the console ${i}` });
    if (made.status !== 200) c.fail(step, `answered ${made.status}: ${made.body.slice(0, 300)}`);
    await check(step, "admin.create_team", `web-made-${i}`, f);

    step = `a team switch on /manage as ${shown(f.client)}`;
    await tool(c, g, step, f.client, "team_switch", { team: `mcp-switch-${i}` });
    await check(step, "team.switch", `mcp-switch-${i}`, f);

    step = `a team switch in the console as ${shown(f.client)}`;
    const switched = await consoleCall(g, f.client, "POST", "/api/console/settings/me/active-team", { team: `web-switch-${i}` });
    if (switched.status !== 200) c.fail(step, `answered ${switched.status}: ${switched.body.slice(0, 300)}`);
    await check(step, "team.switch", `web-switch-${i}`, f);

    step = `a token issued and revoked in the console as ${shown(f.client)}`;
    const label = `origin probe ${i}`;
    const issued = await consoleCall(g, f.client, "POST", "/api/console/settings/me/tokens", { label });
    if (issued.status !== 200) c.fail(step, `issue answered ${issued.status}: ${issued.body.slice(0, 300)}`);
    await check(step, "pat.self_issue", label, f);
    const pat = (await c.sql.query<{ id: string }>("select id::text as id from zz.pat where label = $1", [label])).rows[0];
    if (!pat) c.fail(step, `no token labelled ${label} was stored`);
    const revoked = await consoleCall(g, f.client, "DELETE", `/api/console/settings/me/tokens/${pat.id}`);
    if (revoked.status !== 200) c.fail(step, `revoke answered ${revoked.status}: ${revoked.body.slice(0, 300)}`);
    await check(step, "pat.self_revoke", pat.id, f);

    step = `a bug resolved in the console as ${shown(f.client)}`;
    const resolved = await consoleCall(g, f.client, "POST", `/api/console/platform/bugs/${bugId(i)}/resolve`,
                                       { status: "fixed", resolution: "Closed by the origin probe." });
    if (resolved.status !== 204) c.fail(step, `answered ${resolved.status}: ${resolved.body.slice(0, 300)}`);
    await check(step, "bug.console_resolve", bugId(i), f);
  }
  if (wrong.length) c.fail("each act lands its client's origin", wrong.join("; "));
  c.pass(`an administration act on /manage and in the console lands platform for ${names("platform")} and work for ${names("work")}`);
  c.pass("a team switch on /manage and in the console lands the same origins");
  c.pass("a console write — a token issued, a token revoked, a bug resolved — lands the same origins");
}

/** The console's document writes, its close and its sign-out of another browser. The first two
 *  run on the session that stays on the seeded team: zz-core finds the document in the caller's
 *  acting team, and a close names the team the caller acts for. */
async function consoleActs(c: Core, g: Gateway): Promise<void> {
  const { wrong, expect } = judge();
  const check = async (step: string, kind: string, subject: string, f: Client): Promise<void> =>
    expect(`${kind} about ${subject}`, await originOf(c, step, kind, subject, f.client), f);
  const ok = (step: string, what: string, r: { status: number; body: string }, want: number): void => {
    if (r.status !== want) c.fail(step, `${what} answered ${r.status}: ${r.body.slice(0, 300)}`);
  };
  for (const [i, f] of CLIENTS.entries()) {
    let step = `a document shown and approved in the console as ${shown(f.client)}`;
    const initiative = await c.open(`origin-approve-${i}`);
    const path = `${initiative}/notes.md`;
    await c.ok(step, "document_write", { path, content: "# Notes\n\nwritten\n" });
    const read = await c.ok(step, "document_read", { path });
    const cr = /^content_revision: (cr_[a-z2-7]{26})$/m.exec(read)?.[1] ?? c.fail(step, `no content_revision in: ${read}`);
    const team = `?team=${encodeURIComponent(c.team)}`;
    const shownAt = await consoleCall(g, f.client, "POST", `/api/console/documents/shown${team}`,
                                      { initiative, path: "notes.md", content_revision: cr }, g.teamSession);
    ok(step, "shown", shownAt, 200);
    const rc = (JSON.parse(shownAt.body) as { review_context?: string }).review_context;
    await check(step, "document.console_shown", path, f);
    const approved = await consoleCall(g, f.client, "POST", `/api/console/documents/approve${team}`,
                                       { initiative, path: "notes.md", expected_revision: cr, review_context: rc }, g.teamSession);
    ok(step, "the console's Approve", approved, 200);
    await check(step, "document.approve", path, f);

    step = `an initiative closed in the console as ${shown(f.client)}`;
    const slug = await c.open(`origin-close-${i}`);
    const closed = await consoleCall(g, f.client, "POST", `/api/console/initiatives/${c.team}/${slug}/close`,
                                     { disposition: "abandoned" }, g.teamSession);
    ok(step, "the console's Close", closed, 200);
    await check(step, "initiative.console_close", slug, f);

    step = `another browser signed out in the console as ${shown(f.client)}`;
    const other = (await c.sql.query<{ id: string }>(
      `insert into zz.console_session (principal_id, token_hash, expires_at)
       select id, $2, now() + interval '1 hour' from zz.principal where email = $1 returning id::text as id`,
      [c.email, hash(randomBytes(24)).toString("hex")])).rows[0].id;
    ok(step, "sign-out", await consoleCall(g, f.client, "DELETE", `/api/console/settings/me/browsers/${other}`), 200);
    await check(step, "console.sign_out", other, f);
  }
  if (wrong.length) c.fail("each console act lands its client's origin", wrong.join("; "));
  c.pass("a console write — a document shown, a document approved, an initiative closed, a browser signed out — " +
    "lands the same origins");
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
function authenticator(): {
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

/** One step of a public route as `client`, carrying `cookie` if given: the status, the body read
 *  as JSON, and the ceremony cookie it set. */
async function publicCall(g: Gateway, client: string | null, path: string, body: Record<string, unknown>,
                          cookie?: string): Promise<{ status: number; body: Record<string, unknown>; ceremony?: string }> {
  const res = await fetch(`${g.url}${path}`, {
    method: "POST",
    headers: headersOf(client, cookie ? { cookie } : {}),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const ceremony = res.headers.getSetCookie().map((s) => s.split(";")[0]).find((s) => /^zz_ceremony=./.test(s));
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, ...(ceremony ? { ceremony } : {}) };
}

/** The two public surfaces, where no identity carries the client and the route reads the request's
 *  own header: an OAuth client's credential, and a passkey's registration and sign-in. */
async function publicActs(c: Core, g: Gateway): Promise<void> {
  const { wrong, expect } = judge();
  for (const [i, f] of CLIENTS.entries()) {
    let step = `a credential obtained by an OAuth client as ${shown(f.client)}`;
    const redirect = "http://127.0.0.1:9/callback";
    const reg = await publicCall(g, f.client, "/oauth/register", { redirect_uris: [redirect], client_name: `Origin probe ${i}` });
    const clientId = typeof reg.body.client_id === "string" ? reg.body.client_id
      : c.fail(step, `register answered ${reg.status}: ${JSON.stringify(reg.body)}`);
    const verifier = b64(randomBytes(32));
    const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code",
      code_challenge: b64(hash(verifier)), code_challenge_method: "S256", resource: `${g.url}/manage/mcp` });
    const authz = await fetch(`${g.url}/oauth/authorize?${query}`, {
      headers: headersOf(f.client, { cookie: `zz_console=${g.session}` }), redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    });
    const code = new URL(authz.headers.get("location") ?? "http://none/").searchParams.get("code")
      ?? c.fail(step, `authorize answered ${authz.status}: ${(await authz.text()).slice(0, 300)}`);
    const exchanged = await fetch(`${g.url}/oauth/token`, {
      method: "POST",
      headers: { ...headersOf(f.client, {}), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier,
                                  client_id: clientId, redirect_uri: redirect }).toString(),
      signal: AbortSignal.timeout(60_000),
    });
    if (exchanged.status !== 200) c.fail(step, `token answered ${exchanged.status}: ${(await exchanged.text()).slice(0, 300)}`);
    // Every client's credential is for the same door, so its row is found by the client it went to.
    expect(`credential.set for client ${clientId}`, await originWhere(c, step, `credential.set for client ${clientId}`,
      f.client, "e.kind = 'credential.set' and e.detail->>'client_id' = $1", [clientId]), f);

    step = `a passkey registered and signed in with as ${shown(f.client)}`;
    const email = `passkey-${i}@example.test`;
    const principal = (await c.sql.query<{ id: string }>(
      "insert into zz.principal (email, display_name) values ($1, $2) returning id::text as id", [email, email])).rows[0].id;
    const enrolment = new URL((await g.enrol(principal)).url).hash.replace(/^#t=/, "");
    const key = authenticator();
    const begun = await publicCall(g, f.client, "/auth/passkey/register/options", { token: enrolment });
    if (begun.status !== 200 || !begun.ceremony) c.fail(step, `register options answered ${begun.status}: ${JSON.stringify(begun.body)}`);
    const registered = await publicCall(g, f.client, "/auth/passkey/register/verify",
                                        { credential: key.create(begun.body.challenge as string) }, begun.ceremony);
    if (registered.status !== 200) c.fail(step, `register verify answered ${registered.status}: ${JSON.stringify(registered.body)}`);
    expect(`console.passkey_registered about ${key.id}`,
           await originOf(c, step, "console.passkey_registered", key.id, f.client), f);
    const asked = await publicCall(g, f.client, "/auth/passkey/login/options", {});
    if (asked.status !== 200 || !asked.ceremony) c.fail(step, `login options answered ${asked.status}: ${JSON.stringify(asked.body)}`);
    const signedIn = await publicCall(g, f.client, "/auth/passkey/login/verify",
                                      { credential: key.get(asked.body.challenge as string, principal) }, asked.ceremony);
    if (signedIn.status !== 200) c.fail(step, `login verify answered ${signedIn.status}: ${JSON.stringify(signedIn.body)}`);
    // A sign-in names no subject; each client signs in a person of its own, found by its actor.
    expect(`console.sign_in by ${email}`, await originWhere(c, step, `console.sign_in by ${email}`, f.client,
      "e.kind = 'console.sign_in' and e.actor_id = $1::uuid", [principal]), f);
  }
  if (wrong.length) c.fail("each public act lands its client's origin", wrong.join("; "));
  c.pass("a credential an OAuth client obtains at /oauth/token lands the same origins");
  c.pass("a passkey registered, and a sign-in with it, land the same origins");
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
    // First: the switches in `cases` move the person's own acting team, which the harness's MCP
    // client writes the documents under.
    await consoleActs(c, g);
    await cases(c, g);
    await publicActs(c, g);
    await pageViews(c, g);
  } finally {
    await g.stop();
  }
}

process.exitCode = await withThrowawayCore(NAME, DONE, run);
