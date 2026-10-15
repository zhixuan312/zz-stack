#!/usr/bin/env node
/**
 * checks/console-access.ts — Access is read for the caller alone, and the caller revokes their own
 * applications and signs out their own other browsers (AC-6.6).
 *
 *   node checks/console-access.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL migrated by the real runner (`withThrowawayDb`), seeds two people on one
 * team, a person in no team, two OAuth clients, tokens, sessions and passkeys with SQL directly, every token
 * and cookie minted here so the check holds every secret it looks for. It serves the gateway's own built
 * identity gate, JSON parser, Access read (`services/gateway/dist/console/access.js`) and settings routes
 * over HTTP, in the order server.ts mounts them, and asks them with real cookies and real tokens. What it
 * establishes, with the expected values written below:
 *
 *   - the read answers the caller's own tokens (label, created, last used, revoked, and the application each
 *     was minted for), applications (name, tokens, first issued, last used), browsers (the current one
 *     marked and first, user agent, signed in, last seen, expires; no expired or signed-out one), passkeys
 *     (label, transports, created, last used), the teams the caller may act for with the one acted for, and
 *     the setup text settings/me/client-setup answers; a person in no team is answered no teams;
 *   - a second person on the same team sees none of the first's, and a token is refused the read;
 *   - the whole answer, and every event the check's issue, revokes and sign-out wrote, hold no token value,
 *     no token hash, no session cookie or its hash, no passkey credential id and no address, and no field is
 *     answered as redacted;
 *   - revoking an application revokes the caller's own live tokens minted through it, answered as how many,
 *     and no one else's, and leaves the client registered; again, it revokes none;
 *   - signing out another browser revokes that session alone, and its cookie signs nobody in; signing out
 *     the current one is refused with a sentence that says how to sign out, and it still reads;
 *   - another person's browser or application answers 404 and changes nothing, as does an id that is no
 *     session's;
 *   - both writes refuse a token-borne caller with 400 and change nothing, and log `via: "web"`;
 *   - the gate's console write rule lists both routes;
 *   - the key sets of the read and of both writes' answers match the console's fake.
 *
 * The only database it touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Express, RequestHandler } from "express";
import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import { withThrowawayDb } from "../scripts/schema/throwaway.ts";

const NAME = "console-access";
const DONE = "console-access: Access answers the caller's own tokens, applications, browsers, passkeys, teams and setup and no " +
  "secret, and the caller revokes their own applications and other browsers, from a browser alone: ok";
/** COUPLED: the fake answer in the console's checkout, `../zz-stack-dashboard` here and in CI. */
const FAKE = join(root, "..", "zz-stack-dashboard", "scripts", "fake-gateway");
const GATE = "scripts/gate/checks/console.ts";

const ONE = "first@access.example.test";
const TWO = "second@access.example.test";
const LONER = "loner@access.example.test";
const TEAM = "access-team";
const OTHER = "access-other";
const CLIENT_A = "client-access-a";
const CLIENT_B = "client-access-b";
const HOUR = 3_600_000;

class CaseFailure extends Error {}
const fail = (step: string, detail: string): never => { throw new CaseFailure(`${NAME}: FAILED at "${step}": ${detail}`); };
const pass = (line: string): void => console.log(`ok ${line}`);
const load = (p: string) => import(pathToFileURL(join(root, "services/gateway/dist", p)).href);

type Obj = Record<string, unknown>;
type Answer = { status: number; text: string; body: Obj };
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const show = (v: unknown): string => JSON.stringify(v).slice(0, 900);
/** Its value with every object's keys in order: an answer's key order is no part of its contract. */
const canonical = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canonical)
    : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** Where two answers' shapes differ: at an object both hold, the key sets; at an array both hold, the first elements,
 *  the same way; a null on either side, nothing. */
function shapeDiffs(a: unknown, b: unknown, path: string, out: string[]): string[] {
  if (a === null || b === null) return out;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length && b.length) shapeDiffs(a[0], b[0], `${path}[0]`, out);
  } else if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    if (ka.join() !== kb.join()) out.push(`${path || "the answer"} has keys {${ka.join(", ")}} where the fake has {${kb.join(", ")}}`);
    for (const k of ka.filter((x) => kb.includes(x))) shapeDiffs(a[k], b[k], path ? `${path}.${k}` : k, out);
  }
  return out;
}

/** Everything a secret could be in this seed, by what it is: filled as tokens and cookies are minted. */
const secrets = new Map<string, string>();
const mint = (what: string, value: string): string => {
  secrets.set(value, what);
  secrets.set(sha(value), `the hash of ${what}`);
  return value;
};
/** The secrets a text holds, by name. */
const heldIn = (text: string): string[] => [...secrets].filter(([v]) => text.includes(v)).map(([, what]) => what);

/** The seed's instants, whole seconds before the check began. */
const T = Math.floor(Date.now() / 1000) * 1000;
const h = (hours: number): string => iso(T - hours * HOUR);

/** The seed: each row's own values, so the expected answers are written from them. */
const TOKENS = [
  { key: "t1", who: ONE, label: "laptop", created: 720, used: 24, revoked: null, client: null },
  { key: "t2", who: ONE, label: "old ci runner", created: 1440, used: 1080, revoked: 960, client: null },
  { key: "t3", who: ONE, label: `mcp oauth — Claude Code — /core/mcp — ${ONE}`, created: 240, used: 48, revoked: null, client: CLIENT_A },
  { key: "t4", who: ONE, label: `mcp oauth — Claude Code — /manage/mcp — ${ONE}`, created: 216, used: null, revoked: null, client: CLIENT_A },
  { key: "t5", who: ONE, label: `mcp oauth — ChatGPT — /core/mcp — ${ONE}`, created: 120, used: 3, revoked: null, client: CLIENT_B },
  { key: "t6", who: ONE, label: "mcp oauth — Claude Code — an earlier connection", created: 480, used: 400, revoked: 360, client: CLIENT_A },
  { key: "t7", who: TWO, label: `mcp oauth — Claude Code — /core/mcp — ${TWO}`, created: 192, used: 10, revoked: null, client: CLIENT_A },
  { key: "t8", who: TWO, label: "second person's machine", created: 300, used: null, revoked: null, client: null },
] as const;
const SESSIONS = [
  { key: "s1", who: ONE, team: TEAM, issued: 2, expires: -10, seen: 1, revoked: null, agent: "Mozilla/5.0 (Macintosh) current-browser", ip: "198.51.100.23" },
  { key: "s2", who: ONE, team: TEAM, issued: 6, expires: -6, seen: 5, revoked: null, agent: "Mozilla/5.0 (iPhone) other-browser", ip: "203.0.113.45" },
  { key: "s3", who: ONE, team: TEAM, issued: 30, expires: 18, seen: 20, revoked: null, agent: "expired-browser", ip: "203.0.113.46" },
  { key: "s4", who: ONE, team: TEAM, issued: 3, expires: -9, seen: 2.5, revoked: 2, agent: "signed-out-browser", ip: "203.0.113.47" },
  { key: "s5", who: TWO, team: TEAM, issued: 4, expires: -8, seen: 3, revoked: null, agent: "second-person-browser", ip: "192.0.2.77" },
  { key: "s6", who: LONER, team: null, issued: 1, expires: -11, seen: null, revoked: null, agent: null, ip: "192.0.2.78" },
] as const;
const PASSKEYS = [
  { who: ONE, label: "MacBook Touch ID", transports: ["internal", "hybrid"], created: 2400, used: 2 },
  { who: ONE, label: null, transports: null, created: 4800, used: null },
  { who: TWO, label: "second's key", transports: ["usb"], created: 900, used: 4 },
] as const;

type Seeded = { tokens: Record<string, { id: string; value: string }>; sessions: Record<string, { id: string; cookie: string }> };

async function seed(sql: pg.Client): Promise<Seeded> {
  const person = async (email: string): Promise<string> => (await sql.query<{ id: string }>(
    "insert into zz.principal (email, display_name, role) values ($1, $2, 'member') returning id", [email, email])).rows[0].id;
  const ids = { [ONE]: await person(ONE), [TWO]: await person(TWO), [LONER]: await person(LONER) };
  const team = async (slug: string): Promise<string> => (await sql.query<{ id: string }>(
    "insert into zz.team (slug, name, created_by) values ($1, $2, $3) returning id", [slug, slug, ids[ONE]])).rows[0].id;
  const teams = { [TEAM]: await team(TEAM), [OTHER]: await team(OTHER) };
  for (const [t, who, role] of [[TEAM, ONE, "admin"], [TEAM, TWO, "member"], [OTHER, ONE, "member"]] as const) {
    await sql.query("insert into zz.membership (team_id, principal_id, role, added_by) values ($1, $2, $3, $4)", [teams[t], ids[who], role, ids[ONE]]);
  }
  await sql.query("insert into zz.mcp_oauth_client (client_id, redirect_uris, name) values ($1, '[]', 'Claude Code'), ($2, '[]', 'ChatGPT')",
    [CLIENT_A, CLIENT_B]);
  const out: Seeded = { tokens: {}, sessions: {} };
  for (const t of TOKENS) {
    const value = mint(`token ${t.key}`, `zzp_${randomBytes(24).toString("hex")}`);
    const { rows: [row] } = await sql.query<{ id: string }>(
      `insert into zz.pat (principal_id, token_hash, label, created_at, last_used_at, revoked_at, oauth_client_id, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, case when $7::text is null then null else now() + interval '30 days' end) returning id::text as id`,
      [ids[t.who], sha(value), t.label, h(t.created), t.used === null ? null : h(t.used), t.revoked === null ? null : h(t.revoked), t.client]);
    out.tokens[t.key] = { id: row.id, value };
  }
  for (const s of SESSIONS) {
    const cookie = mint(`session cookie ${s.key}`, randomBytes(32).toString("hex"));
    secrets.set(s.ip, `the address of ${s.key}`);
    const { rows: [row] } = await sql.query<{ id: string }>(
      `insert into zz.console_session (principal_id, token_hash, issued_at, expires_at, revoked_at, last_seen_at, user_agent, ip, team_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id::text as id`,
      [ids[s.who], sha(cookie), h(s.issued), h(s.expires), s.revoked === null ? null : h(s.revoked), s.seen === null ? null : h(s.seen),
       s.agent, s.ip, s.team === null ? null : teams[s.team]]);
    out.sessions[s.key] = { id: row.id, cookie };
  }
  for (const p of PASSKEYS) {
    const id = `credential-${randomBytes(16).toString("hex")}`;
    secrets.set(id, `a passkey's credential id (${p.label ?? "unlabelled"})`);
    await sql.query(
      `insert into zz.passkey (id, principal_id, public_key, transports, label, created_at, last_used_at)
       values ($1, $2, '\\x00'::bytea, $3, $4, $5, $6)`,
      [id, ids[p.who], p.transports, p.label, h(p.created), p.used === null ? null : h(p.used)]);
  }
  return out;
}

/** What the first person's read must answer, by the seed; the current browser's last seen is moved by every
 *  request it makes, so it is compared apart. */
function expectedOf(s: Seeded): Obj {
  const token = (k: string) => {
    const t = TOKENS.find((x) => x.key === k)!;
    return { id: s.tokens[k].id, label: t.label, createdAt: h(t.created), lastUsedAt: t.used === null ? null : h(t.used),
             revokedAt: t.revoked === null ? null : h(t.revoked), application: t.client };
  };
  const browser = (k: string, current: boolean) => {
    const b = SESSIONS.find((x) => x.key === k)!;
    return { id: s.sessions[k].id, current, userAgent: b.agent, issuedAt: h(b.issued), lastSeenAt: b.seen === null ? null : h(b.seen), expiresAt: h(b.expires) };
  };
  return {
    issued: ["t5", "t4", "t3", "t6", "t1", "t2"].map(token),
    applications: [
      { client: CLIENT_B, name: "ChatGPT", issuedCount: 1, firstAt: h(120), lastUsedAt: h(3) },
      { client: CLIENT_A, name: "Claude Code", issuedCount: 3, firstAt: h(480), lastUsedAt: h(48) },
    ],
    browsers: [browser("s1", true), browser("s2", false)],
    authenticators: [
      { label: "MacBook Touch ID", transports: ["internal", "hybrid"], createdAt: h(2400), lastUsedAt: h(2) },
      { label: null, transports: [], createdAt: h(4800), lastUsedAt: null },
    ],
    teams: { actingFor: TEAM, teams: [{ team: OTHER, role: "member", active: false }, { team: TEAM, role: "admin", active: true }] },
  };
}

async function run(sql: pg.Client, url: string): Promise<void> {
  const s = await seed(sql);
  process.env.TEAM_DB_URL = url;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  // The client setup names the address people reach the gateway at; without one it answers 500.
  process.env.GATEWAY_PUBLIC_URL = "https://gateway.access.example.test";
  const express = (await import("express")).default;
  const db = (await load("db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await db.initPlatformDb();
  const { identityMiddleware } = (await load("identity.js")) as { identityMiddleware: () => RequestHandler };
  const { mountAccess } = (await load("console/access.js")) as { mountAccess: (app: Express) => void };
  const { mountSettings } = (await load("settings.js")) as { mountSettings: (app: Express, deps: unknown) => void };
  const credentials = (await load("credentials.js")) as Record<string, unknown>;
  const app = express();
  // COUPLED: services/gateway/src/server.ts — the identity gate, the JSON parser, then the console's reads and its settings.
  app.use(identityMiddleware());
  app.use(express.json({ limit: "1mb" }));
  mountAccess(app);
  mountSettings(app, { myAccessTokensFor: credentials.myAccessTokensFor, issueMyAccessTokenFor: credentials.issueMyAccessTokenFor,
                       revokeMyAccessTokenFor: credentials.revokeMyAccessTokenFor });
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const ask = async (method: string, path: string, as: { cookie?: string; bearer?: string }, body?: Obj): Promise<Answer> => {
    const res = await fetch(`${base}${path}`, {
      method, signal: AbortSignal.timeout(30_000),
      headers: {
        ...(as.cookie ? { cookie: `zz_console=${as.cookie}` } : {}), ...(as.bearer ? { authorization: `Bearer ${as.bearer}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, body: isObj(parsed) ? parsed : {} };
  };
  const one = { cookie: s.sessions.s1.cookie };
  const two = { cookie: s.sessions.s5.cookie };
  const answered: string[] = [];
  /** An answer checked for every secret and every redaction marker, then kept for the final sweep. */
  const clean = (step: string, what: string, a: Answer): Answer => {
    const held = heldIn(a.text);
    if (held.length) fail(step, `${what} holds ${held.join(", ")}`);
    if (/redacted/.test(a.text)) fail(step, `${what} answers a field as redacted: ${a.text.slice(0, 400)}`);
    answered.push(a.text);
    return a;
  };
  /** Every row the check's writes may have changed, as one text, to compare before and after. */
  const state = async (): Promise<string> => JSON.stringify((await sql.query(
    `select (select json_agg(json_build_object('id', id, 'revoked', revoked_at) order by id) from zz.pat) as pats,
            (select json_agg(json_build_object('id', id, 'revoked', revoked_at, 'expires', expires_at) order by id) from zz.console_session) as sessions,
            (select json_agg(json_build_object('id', client_id, 'revoked', revoked_at) order by client_id) from zz.mcp_oauth_client) as clients`)).rows[0]);

  try {
    let step = "the first person's read";
    const read = clean(step, "the first person's read", await ask("GET", "/api/console/access", one));
    if (read.status !== 200) fail(step, `answered ${read.status}: ${read.text}`);
    const got = read.body;
    const setup = clean(step, "client-setup", await ask("GET", "/api/console/settings/me/client-setup", one));
    const want = { ...expectedOf(s), setup: setup.body };
    const current = (got.browsers as Obj[] | undefined)?.[0];
    const seen = typeof current?.lastSeenAt === "string" ? Date.parse(current.lastSeenAt) : NaN;
    if (!(seen >= Date.parse(h(1)))) fail(step, `the current browser's last seen is ${String(current?.lastSeenAt)}, not at or after ${h(1)}`);
    const steady = { ...got, browsers: (got.browsers as Obj[]).map((b, i) => (i === 0 ? { ...b, lastSeenAt: h(1) } : b)) };
    delete (steady as Obj).meta;
    if (!same(steady, want)) fail(step, `answered\n  ${show(canonical(steady))}\nnot\n  ${show(canonical(want))}`);
    if (!String((setup.body as { config?: unknown }).config ?? "").includes(ONE)) fail(step, `the setup text is not written for ${ONE}: ${setup.text.slice(0, 300)}`);
    const meta = got.meta as Obj;
    const asOf = Date.parse(String(meta.asOf));
    if (meta.scope !== "caller-in-active-team" || meta.coverageFrom !== null || !(asOf >= T) || asOf > Date.now() + 1000
        || !same(meta.period, { from: h(4800), to: meta.asOf }) || typeof meta.timezone !== "string" || typeof meta.population !== "string") {
      fail(step, `meta is ${show(meta)}`);
    }
    pass("the first person reads their tokens newest first with the application each was minted through, two applications " +
      "grouped from them with their names, counts and dates, this browser marked and first and their other live one (not the " +
      "expired or signed-out), two passkeys, both teams with the one acted for, and the setup client-setup answers");

    step = "a second person on the same team";
    const theirs = clean(step, "the second person's read", await ask("GET", "/api/console/access", two));
    if (theirs.status !== 200) fail(step, `answered ${theirs.status}: ${theirs.text}`);
    const firsts = [...Object.values(s.tokens).slice(0, 6).map((t) => t.id), ...TOKENS.slice(0, 6).map((t) => t.label),
      s.sessions.s1.id, s.sessions.s2.id, "MacBook Touch ID", "current-browser", "other-browser", ONE];
    const seenOfFirst = firsts.filter((x) => theirs.text.includes(x));
    if (seenOfFirst.length) fail(step, `the second person's read holds the first's ${seenOfFirst.join(", ")}`);
    const b = theirs.body as { issued: Obj[]; applications: Obj[]; browsers: Obj[]; authenticators: Obj[] };
    if (!same(b.issued.map((t) => t.id), [s.tokens.t7.id, s.tokens.t8.id]) || !same(b.applications.map((a) => [a.client, a.issuedCount]), [[CLIENT_A, 1]])
        || !same(b.browsers.map((x) => [x.id, x.current]), [[s.sessions.s5.id, true]]) || !same(b.authenticators.map((k) => k.label), ["second's key"])) {
      fail(step, `answered ${show(b)}`);
    }
    const loner = clean(step, "the person in no team's read", await ask("GET", "/api/console/access", { cookie: s.sessions.s6.cookie }));
    if (loner.status !== 200 || !same(loner.body.teams, { actingFor: null, teams: [] }) || (loner.body.issued as unknown[]).length !== 0) {
      fail(step, `the person in no team was answered ${loner.status}: ${loner.text.slice(0, 400)}`);
    }
    const token = clean(step, "a token's read", await ask("GET", "/api/console/access", { bearer: s.tokens.t1.value }));
    if (token.status !== 403) fail(step, `a token was answered ${token.status}: ${token.text}`);
    pass("a second person on the same team reads only their own token, application, browser and passkey, a person in no team " +
      "reads no teams, and a token is refused the read");

    step = "the key sets match the console's fake answer";
    let fake: { access: (who: unknown) => [number, unknown]; revokeApplication: (who: unknown, c: string) => [number, unknown];
                revokeBrowser: (who: unknown, id: string) => [number, unknown] };
    let me: unknown;
    try {
      fake = (await import(pathToFileURL(join(FAKE, "work-access.ts")).href)) as typeof fake;
      me = ((await import(pathToFileURL(join(FAKE, "people.ts")).href)) as { ME: unknown }).ME;
    } catch (err) {
      return fail(step, `could not read the console's fake answer in ${FAKE}: ${(err as Error).message}`);
    }
    const fakeRead = fake.access(me)[1] as Obj;
    const diffs = shapeDiffs(got, fakeRead, "", []);
    for (const k of ["issued", "applications", "browsers", "authenticators"]) {
      if (!(got[k] as unknown[]).length || !(fakeRead[k] as unknown[]).length) diffs.push(`${k} is empty on one side, so its rows were not compared`);
    }
    const fakeClient = (fakeRead.applications as Obj[])[0].client as string;
    const fakeOther = (fakeRead.browsers as Obj[]).find((x) => !x.current)!.id as string;
    shapeDiffs({ ok: true, revoked: 2 }, fake.revokeApplication(me, fakeClient)[1], "an application's revoke", diffs);
    shapeDiffs({ ok: true, revoked: 1 }, fake.revokeBrowser(me, fakeOther)[1], "a browser's sign-out", diffs);
    if (diffs.length) fail(step, diffs.join("; "));
    pass("the read's key sets, every array's first row, and both writes' answers match the console's fake answer");

    step = "an issued token stays out of the read";
    const issued = await ask("POST", "/api/console/settings/me/tokens", one, { label: "issued by the check" });
    const value = String((issued.body as { token?: unknown }).token ?? "");
    if (issued.status !== 200 || !value.startsWith("zzp_")) fail(step, `the issue answered ${issued.status}: ${issued.text.slice(0, 200)}`);
    mint("the token the check issued", value);
    const after = clean(step, "the read after the issue", await ask("GET", "/api/console/access", one));
    const head = (after.body.issued as Obj[])[0];
    if (head?.label !== "issued by the check" || head.application !== null || head.revokedAt !== null) fail(step, `the newest token reads ${show(head)}`);
    pass("a token issued from the console heads the read by its label, and its value is in no answer but the issue's own");

    step = "a token-borne caller is refused both writes";
    let before = await state();
    for (const path of [`/api/console/settings/me/applications/${CLIENT_A}`, `/api/console/settings/me/browsers/${s.sessions.s2.id}`]) {
      const a = clean(step, `a token's DELETE ${path}`, await ask("DELETE", path, { bearer: s.tokens.t1.value }));
      if (a.status !== 400 || !/a token cannot revoke what signs you in/.test(String(a.body.error))) fail(step, `${path} answered ${a.status}: ${a.text}`);
    }
    if (await state() !== before) fail(step, "a refused write changed a token, a session or a client");
    pass("a token is refused both writes with 400, saying to revoke from the console signed in, and nothing changed");

    step = "another person's application or browser";
    before = await state();
    const notYours: [string, { cookie: string }][] = [
      [`/api/console/settings/me/applications/${CLIENT_B}`, two],
      [`/api/console/settings/me/applications/client-nobody-registered`, two],
      [`/api/console/settings/me/browsers/${s.sessions.s2.id}`, two],
      [`/api/console/settings/me/browsers/${s.sessions.s5.id}`, one],
      [`/api/console/settings/me/browsers/${s.sessions.s3.id}`, one],
      ["/api/console/settings/me/browsers/not-a-session", one],
    ];
    for (const [path, as] of notYours) {
      const a = clean(step, `DELETE ${path}`, await ask("DELETE", path, as));
      if (a.status !== 404) fail(step, `${path} answered ${a.status}: ${a.text}`);
    }
    if (await state() !== before) fail(step, "a 404 changed a token, a session or a client");
    pass("another person's application and browser, a client nobody registered, an expired session and an id that is no " +
      "session's each answer 404, and nothing changed");

    step = "revoking an application";
    const live = async (k: string): Promise<boolean> =>
      (await sql.query("select 1 from zz.pat where id = $1 and revoked_at is null", [s.tokens[k].id])).rowCount === 1;
    const revoked = clean(step, "the revoke", await ask("DELETE", `/api/console/settings/me/applications/${CLIENT_A}`, one));
    if (revoked.status !== 200 || !same(revoked.body, { ok: true, revoked: 2 })) fail(step, `answered ${revoked.status}: ${revoked.text}`);
    const left = { t3: await live("t3"), t4: await live("t4"), t7: await live("t7"), t5: await live("t5"), t1: await live("t1") };
    if (!same(left, { t3: false, t4: false, t7: true, t5: true, t1: true })) fail(step, `live afterwards: ${show(left)}`);
    const t6 = (await sql.query<{ r: Date }>("select revoked_at as r from zz.pat where id = $1", [s.tokens.t6.id])).rows[0].r;
    if (iso(t6.getTime()) !== h(360)) fail(step, `the token revoked before was revoked again, at ${t6.toISOString()}`);
    const client = await sql.query("select 1 from zz.mcp_oauth_client where client_id = $1 and revoked_at is null", [CLIENT_A]);
    if (client.rowCount !== 1) fail(step, `${CLIENT_A} is no longer registered`);
    const again = clean(step, "the revoke again", await ask("DELETE", `/api/console/settings/me/applications/${CLIENT_A}`, one));
    if (again.status !== 200 || !same(again.body, { ok: true, revoked: 0 })) fail(step, `again answered ${again.status}: ${again.text}`);
    pass("revoking an application revokes the caller's two live tokens minted through it and answers 2, leaves the one revoked " +
      "before, the second person's token from the same client and the caller's other tokens alone, keeps the client registered, " +
      "and a second revoke answers 0");

    step = "signing out a browser";
    const current2 = clean(step, "the current browser's sign-out", await ask("DELETE", `/api/console/settings/me/browsers/${s.sessions.s1.id}`, one));
    if (current2.status !== 400 || !/sign out from the menu/.test(String(current2.body.error))) fail(step, `the current browser answered ${current2.status}: ${current2.text}`);
    const out = clean(step, "the other browser's sign-out", await ask("DELETE", `/api/console/settings/me/browsers/${s.sessions.s2.id}`, one));
    if (out.status !== 200 || !same(out.body, { ok: true, revoked: 1 })) fail(step, `answered ${out.status}: ${out.text}`);
    const sessions = (await sql.query<{ id: string; revoked: boolean }>(
      "select id::text as id, revoked_at is not null as revoked from zz.console_session")).rows;
    const ended = sessions.filter((x) => x.revoked).map((x) => x.id).sort();
    if (!same(ended, [s.sessions.s2.id, s.sessions.s4.id].sort())) fail(step, `signed out afterwards: ${show(ended)}`);
    const gone = await ask("GET", "/api/console/access", { cookie: s.sessions.s2.cookie });
    if (gone.status !== 401) fail(step, `the signed-out browser's cookie was answered ${gone.status}`);
    const still = clean(step, "the read afterwards", await ask("GET", "/api/console/access", one));
    if (still.status !== 200 || !same((still.body.browsers as Obj[]).map((x) => x.id), [s.sessions.s1.id])) fail(step, `the read afterwards: ${still.text.slice(0, 400)}`);
    const twice = clean(step, "the sign-out again", await ask("DELETE", `/api/console/settings/me/browsers/${s.sessions.s2.id}`, one));
    if (twice.status !== 404) fail(step, `a second sign-out answered ${twice.status}`);
    pass("signing out the current browser is refused with 400 saying to sign out from the menu, and it still reads; signing out " +
      "the other revokes that session alone, whose cookie then signs nobody in, and a second sign-out answers 404");

    step = "the events the writes wrote";
    const wanted = 4;
    let events: { kind: string; subject: string; detail: Obj; text: string }[] = [];
    for (const until = Date.now() + 5000; Date.now() < until;) {
      events = (await sql.query<{ kind: string; subject: string; detail: Obj; text: string }>(
        `select kind, subject, detail, concat_ws(' ', kind, subject, detail::text, refusal, actor_id::text) as text
           from zz.event order by ts, id`)).rows;
      if (events.filter((e) => ["pat.self_issue", "pat.self_revoke", "console.sign_out"].includes(e.kind)).length >= wanted) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const writes = events.filter((e) => ["pat.self_issue", "pat.self_revoke", "console.sign_out"].includes(e.kind))
      .map((e) => ({ kind: e.kind, subject: e.subject, detail: e.detail }));
    const expected = [
      { kind: "pat.self_issue", subject: "issued by the check", detail: { via: "web" } },
      ...[s.tokens.t3.id, s.tokens.t4.id].sort().map((id) => ({ kind: "pat.self_revoke", subject: id, detail: { via: "web", client: CLIENT_A } })),
      { kind: "console.sign_out", subject: s.sessions.s2.id, detail: { via: "web" } },
    ];
    const sorted = (xs: Obj[]) => [...xs].sort((a, b) => JSON.stringify(canonical(a)).localeCompare(JSON.stringify(canonical(b))));
    if (!same(sorted(writes), sorted(expected))) fail(step, `the writes' events are ${show(writes)}, not ${show(expected)}`);
    for (const e of events) {
      const held = heldIn(e.text);
      if (held.length) fail(step, `the ${e.kind} event holds ${held.join(", ")}`);
    }
    pass(`the issue, both revoked tokens and the sign-out each wrote one event with via web, and none of the ${events.length} events ` +
      "holds a token value or hash, a cookie or its hash, a credential id or an address");

    step = "the gate's console write rule lists both routes";
    const gate = readFileSync(join(root, GATE), "utf8");
    const unlisted = ["delete /api/console/settings/me/applications/:client", "delete /api/console/settings/me/browsers/:id"]
      .filter((r) => !gate.includes(`"${r}"`));
    if (unlisted.length) fail(step, `${GATE} does not list ${unlisted.join(", ")}`);
    pass(`the gate's console write rule (${GATE}) lists both routes`);

    const sweep = heldIn(answered.join("\n"));
    if (sweep.length) fail("every answer", `the answers hold ${sweep.join(", ")}`);
    pass(`none of the ${answered.length} answers holds any of the ${secrets.size} secrets, and none answers a field as redacted`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.platformDb().end().catch(() => undefined);
    delete process.env.TEAM_DB_URL;
    delete process.env.ZZ_CATALOG_DIR;
    delete process.env.GATEWAY_PUBLIC_URL;
  }
}

let url = "";
try {
  await withThrowawayDb((sql) => run(sql, url), async (u) => { url = u; });
  console.log(DONE);
} catch (err) {
  if (err instanceof CaseFailure) { console.error(err.message); process.exitCode = 1; }
  else if (/Docker is not running/.test(String(err))) { console.error(`${NAME}: SKIPPED — ${String(err)}`); process.exitCode = 2; }
  else { console.error(`${NAME}: FAILED — ${err instanceof Error ? err.stack : String(err)}`); process.exitCode = 1; }
}
