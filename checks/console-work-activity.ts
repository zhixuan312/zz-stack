#!/usr/bin/env node
/**
 * checks/console-work-activity.ts — Activity is read for the active team: its refusals counted once under
 * four owners by week, its messages grouped, and its event log with four filters (AC-6.3).
 *
 *   node checks/console-work-activity.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL and a real zz-core on it (`withThrowawayCore`), and the gateway's own
 * built door in this process: the identity gate, the JSON parser, the tool-call telemetry and the relay to
 * that zz-core, in the order server.ts mounts them, so a call a person's session (`zz-plugin`) or a
 * maintenance client (`zz-migrate`) makes through it is recorded as the gateway records it, its refusal
 * owned by the gateway's own classifier. Each phase is moved, together and by one interval, into the week
 * it names. The refusals the door cannot be made to give (a `theirs`, an `other` with no text, a refused
 * row with no owner) and the second team's distinctive message are written as rows, as a seed writes them.
 * It calls the gateway's own built routes (`dist/console/activity.js`, `dist/console/page-view.js`) the way
 * Express would, as a console session. What it establishes, with the expected values written below:
 *
 *   - the summary's tiles are the last whole week's real-work calls with the weeks they are drawn from,
 *     its refusals with their four owners, and the tool refused most with its count and of how many;
 *   - its weeks run from the week of the team's first real-work call to the running one, each answering
 *     the four owners summing to the refused total; the maintenance is counted apart;
 *   - a read that fails is unavailable, never zero or none: with the weekly refusals read failing, the
 *     calls, the refused, its owners, the weeks and the maintenance are each unavailable and the tool
 *     refused most stands; with last week's refusals by tool failing, the tool refused most is
 *     unavailable and everything else stands. The faults are injected into the gateway's own pool;
 *   - its groups are refusalGroups' for the team: owner, tool, the newest text (null with none), count and
 *     last seen, the second team's identical refusal in none of them;
 *   - the log is the team's real-work events newest first, no page view among them, each with its id, kind,
 *     tool, initiative, owner and message; kind, tool, initiative and refused=true each narrow it and
 *     combine, before the latest 500 are taken, so an older match is reached past 500 newer events;
 *   - limit pages at 10 by default and is refused above 100, a negative offset and a refused that is not
 *     true or false are refused, the total is the matches up to the ceiling with ceiling 500;
 *   - an unknown initiative slug, and the second team's, answer no rows;
 *   - a superadmin acting for the team reads it alike, team and scope change nothing, and a superadmin in
 *     no team is answered 400;
 *   - no answer of /activity or /activity/summary, at any scope, carries the second team's refusal
 *     message, while that team's own log of refusals does;
 *   - the key sets match the console's fake answers.
 *
 * DELIBERATE: the reporting timezone is Asia/Singapore, eight hours ahead of UTC, and the weeks are counted
 * from the running week the check began in, so a run that crosses midnight into a Monday in that timezone
 * fails on dates; run it again.
 *
 * The only database it touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { lastJson } from "@zz/mcp-client";
import type { Request, RequestHandler } from "express";
import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";
import { OTHER_EMAIL, OTHER_TEAM, TIMEZONE, WEEK, at, runningWeek, type When } from "../scripts/schema/work-seed.ts";
import { shapeDiffs } from "../scripts/schema/shape-diffs.ts";

const NAME = "console-work-activity";
const DONE = "console-work-activity: Activity reads the active team's real work, its refusals under four owners by week " +
  "summing to the total, its messages grouped, and its log filtered before the 500 ceiling and paged, for a member and a " +
  "superadmin acting for it; a failed weekly or by-tool read leaves each figure it feeds unavailable, never zero or none; " +
  "and no answer at any scope carries another team's refusal message: ok";
/** COUPLED: the fake answer in the console's checkout, `../zz-stack-dashboard` here and in CI. */
const FAKE = join(root, "..", "zz-stack-dashboard", "scripts", "fake-gateway", "work-activity.ts");

const WORK = "zz-plugin";
const MAINTENANCE = "zz-migrate";
const SUPERADMIN = "root@example.test";
/** A part the gateway could not read. */
const UNREAD = { state: "unavailable", reason: "query_failed" };
/** The second team's refusal: no answer to the first team may hold it. */
const SENTINEL = "ERROR: the beacon ledger is locked by the chargeback review";
const STATUS = "core:initiative_status";
const NONE_NAMED = /^ERROR: `…` names no initiative/;
const NOT_SINGLE = /^ERROR: a name in `…` must be a single name/;
const MALFORMED = /Input validation error|Invalid arguments|validation error/i;

type Obj = Record<string, unknown>;
type Route = (req: unknown, res: unknown) => void;
type Who = { email: string; role: "member" | "superadmin"; team: string | null };
type Row = { id: string; ts: string; kind: string; tool: string | null; initiative: string | null; owner: string | null; message: string | null };
type Group = { owner: string; tool: string; message: string | null; count: number; lastSeen: string };

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const show = (v: unknown): string => JSON.stringify(v).slice(0, 900);

/** The request a console session's read arrives as, past the gateway's middleware (COUPLED: identity.ts). */
function request(who: Who, query: Record<string, string | string[]> = {}): Obj {
  return {
    params: {}, query, body: { feature: "activity" },
    zzIdentity: { email: who.email, displayName: "Activity", platformRole: who.role, via: "session",
                  teams: who.team && who.role === "member" ? [{ slug: who.team, role: "admin" }] : [],
                  activeTeam: who.team, patTeam: null, sessionTeam: who.team },
    headers: {},
  };
}

/** Calls a mounted route as Express would, and waits for what it sends. */
function answer(route: Route, req: Obj): Promise<{ status: number; body: Obj }> {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200, headersSent: false,
      status(code: number) { this.statusCode = code; return this; },
      json(body: Obj) { this.headersSent = true; resolve({ status: this.statusCode, body }); },
      end() { this.headersSent = true; resolve({ status: this.statusCode, body: {} }); },
      sendStatus(code: number) { this.statusCode = code; this.end(); },
    };
    try { route(req, res); } catch (err) { reject(err); }
  });
}

interface Gateway {
  url: string; mine: string; theirs: string;
  log: Route; summary: Route; pageView: Route;
  refusalGroups: (team: string, window: { from: string; to: string }, asOf: string) => Promise<Obj>;
  /** Runs `f` with every statement `when` picks failing in the gateway's own pool, then restores it. */
  failing<T>(when: (sql: string, params: unknown[]) => boolean, f: () => Promise<T>): Promise<T>;
  stop(): Promise<void>;
}

/** A PAT of the person's, acting for their active team. */
async function patOf(c: Core, email: string): Promise<string> {
  const token = `zzp_${randomBytes(24).toString("hex")}`;
  await c.sql.query(
    "insert into zz.pat (principal_id, token_hash, team_id) select p.id, $2, null from zz.principal p where p.email = $1",
    [email, createHash("sha256").update(token, "utf8").digest("hex")]);
  return token;
}

/** The gateway's door to zz-core as server.ts mounts it, a PAT for each team's person, and the routes read. */
async function listen(c: Core): Promise<Gateway> {
  process.env.TEAM_DB_URL = c.url;
  process.env.ZZ_TZ = TIMEZONE;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  process.env.CORE_MCP_URL = c.mcp.url;
  const load = (p: string) => import(pathToFileURL(join(root, "services/gateway/dist", p)).href);
  const express = (await import("express")).default;
  const db = (await load("db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await db.initPlatformDb();
  const { identityMiddleware } = (await load("identity.js")) as { identityMiddleware: () => RequestHandler };
  const { toolCallTelemetry, doorSurface } = (await load("tool-telemetry.js")) as
    { toolCallTelemetry: (surface: (req: Request) => string) => RequestHandler; doorSurface: (url: string) => string };
  const { passThrough } = (await load("relay.js")) as { passThrough: (url: string, what: string, refusal: string) => RequestHandler };
  const routes = new Map<string, Route>();
  const fake = { get: (p: string, h: Route) => routes.set(`GET ${p}`, h), post: (p: string, h: Route) => routes.set(`POST ${p}`, h) };
  ((await load("console/activity.js")) as { mountActivity: (app: unknown) => void }).mountActivity(fake);
  ((await load("console/page-view.js")) as { mountPageView: (app: unknown) => void }).mountPageView(fake);
  const { refusalGroups } = (await load("console/refusals.js")) as Pick<Gateway, "refusalGroups">;

  const app = express();
  // COUPLED: services/gateway/src/server.ts — the identity gate, the JSON parser, the telemetry on the door and
  // then the door's relay to zz-core, in the order server.ts mounts them.
  app.use(identityMiddleware());
  app.use(express.json({ limit: "20mb" }));
  app.use(["/core/mcp"], toolCallTelemetry((req) => doorSurface(req.originalUrl)));
  app.all("/core/mcp", passThrough(c.mcp.url, "core proxy", "zz-core is not reachable"));
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const route = (key: string): Route => routes.get(key) ?? c.fail("mount", `no route ${key}`);
  const pool = db.platformDb();
  const real = pool.query.bind(pool) as (text: unknown, params?: unknown[]) => Promise<unknown>;
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    mine: await patOf(c, c.email), theirs: await patOf(c, OTHER_EMAIL),
    log: route("GET /api/console/activity"), summary: route("GET /api/console/activity/summary"),
    pageView: route("POST /api/console/page-view"), refusalGroups,
    failing: async (when, f) => {
      (pool as unknown as { query: unknown }).query = (text: unknown, params?: unknown[]) =>
        typeof text === "string" && when(text, params ?? []) ? Promise.reject(new Error("injected by the check")) : real(text, params);
      try { return await f(); } finally { (pool as unknown as { query: unknown }).query = real; }
    },
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.platformDb().end().catch(() => undefined);
      for (const k of ["TEAM_DB_URL", "ZZ_TZ", "ZZ_CATALOG_DIR", "CORE_MCP_URL"]) delete process.env[k];
    },
  };
}

/** Tool calls through the gateway's door, each expected to be answered or refused, counted so the rows they
 *  leave can be waited for. */
function door(c: Core, g: Gateway) {
  let sent = 0;
  const send = async (step: string, token: string, client: string, name: string, args: Obj, refused = false): Promise<string> => {
    const res = await fetch(`${g.url}/core/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json",
                 accept: "application/json, text/event-stream", "x-zz-client": client },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(60_000),
    });
    const raw = await res.text();
    sent++;
    const env = lastJson(raw);
    const reply = env?.result?.content?.map((p) => p.text ?? "").join("") ?? env?.error?.message ?? raw.slice(0, 300);
    const wasRefused = Boolean(env?.error) || Boolean((env?.result as { isError?: boolean } | undefined)?.isError) || reply.startsWith("ERROR");
    if (res.status !== 200 || wasRefused !== refused) c.fail(step, `${name} ${JSON.stringify(args)} as ${client} answered ${res.status}, ${wasRefused ? "refused" : "not refused"}: ${reply.slice(0, 300)}`);
    return reply;
  };
  return { send, sent: () => sent };
}

const count = async (c: Core, where: string): Promise<number> =>
  (await c.sql.query<{ n: number }>(`select count(*)::int as n from zz.event where ${where}`)).rows[0].n;

/** Runs `make`, waits until every row it leaves has landed, then with a `target` moves every event the phase
 *  wrote, and the initiatives it opened, by one interval so its first instant lands there. */
async function phase(c: Core, d: ReturnType<typeof door>, target: number | null, make: () => Promise<void>): Promise<void> {
  const start = (await c.sql.query<{ t: string }>("select clock_timestamp()::text as t")).rows[0].t;
  const base = await count(c, "kind = 'tool_call'") - d.sent();
  await make();
  const until = Date.now() + 15_000;
  let seen = -1;
  for (;;) {
    await new Promise((r) => setTimeout(r, 400));
    const calls = await count(c, "kind = 'tool_call'");
    const all = await count(c, "true");
    if (calls >= base + d.sent() && all === seen) break;
    if (Date.now() > until) c.fail("a phase settles", `${calls} tool calls of ${base + d.sent()}, events still moving`);
    seen = all;
  }
  if (target === null) return;
  const by = [start, new Date(target).toISOString()];
  await c.sql.query("update zz.event set ts = ts + ($2::timestamptz - $1::timestamptz) where ts >= $1::timestamptz", by);
  await c.sql.query(`update zz.initiative set opened_at = opened_at + ($2::timestamptz - $1::timestamptz) where opened_at >= $1::timestamptz`, by);
}

/** A refusal written as a row, as a seed writes one. */
async function row(c: Core, team: string, ts: number, tool: string, owner: string | null, refusal: string | null, initiative: string | null = null): Promise<void> {
  await c.sql.query(
    `insert into zz.event (ts, kind, subject, ok, tool_key, refusal, refusal_owner, origin, team_id, initiative_id)
     select $2::timestamptz, 'tool_call', $3, false, $3, $4, $5, 'work', t.id, (select i.id from zz.initiative i where i.team_id = t.id and i.slug = $6)
       from zz.team t where t.slug = $1`,
    [team, iso(ts), tool, refusal, owner, initiative]);
}

async function run(c: Core): Promise<void> {
  await c.sql.query(
    `with p as (insert into zz.principal (email, display_name, role) values ($1, 'Other', 'member') returning id),
          t as (insert into zz.team (slug, name, created_by) select $2, 'Other team', id from p returning id),
          m as (insert into zz.membership (team_id, principal_id, role, added_by) select t.id, p.id, 'admin', p.id from t, p)
     update zz.principal set active_team_id = (select id from t) where id = (select id from p)`, [OTHER_EMAIL, OTHER_TEAM]);
  await c.sql.query("insert into zz.principal (email, display_name, role) values ($1, 'Root', 'superadmin')", [SUPERADMIN]);
  const g = await listen(c);
  try {
    await cases(c, g);
  } finally {
    await g.stop();
  }
}

async function cases(c: Core, g: Gateway): Promise<void> {
  const d = door(c, g);
  const w0 = runningWeek(Date.now());
  const when = (w: When): number => at(w0, w);
  const mine = (step: string, client: string, name: string, args: Obj, refused = false) => d.send(step, g.mine, client, name, args, refused);
  const theirWork = (await c.ok("open the second team's", "initiative_open", { slug: "other-work" }, c.client({ email: OTHER_EMAIL })));
  const theirSlug = (JSON.parse(theirWork) as { initiative: string }).initiative;

  let step = "the record made";
  let alpha = "";
  // Two weeks back: the team's first real-work call opens an initiative, and one refusal.
  await phase(c, d, when([2, 30]), async () => {
    alpha = (JSON.parse(await mine(step, WORK, "initiative_open", { slug: "act-alpha" })) as { initiative: string }).initiative;
    await mine(step, WORK, "initiative_status", { initiatives: [] }, true);
  });
  // The last whole week: two calls answered and four refused through the door, the maintenance client's two, and
  // the second team's; then the three refusals the door cannot be made to give, and the second team's message.
  await phase(c, d, when([1, 34]), async () => {
    await mine(step, WORK, "initiative_status", { initiative: alpha });
    await mine(step, WORK, "document_write", { path: `${alpha}/notes.md`, content: "# Notes\n\nWhat the work found.\n" });
    await mine(step, WORK, "initiative_status", { initiatives: [] }, true);
    await mine(step, WORK, "initiative_status", { initiatives: [] }, true);
    await mine(step, WORK, "initiative_status", { initiatives: [alpha, "a/b"] }, true);
    await mine(step, WORK, "document_read", {}, true);
    await mine(step, MAINTENANCE, "initiative_status", { initiatives: [] }, true);
    await mine(step, MAINTENANCE, "initiative_status", { initiative: alpha });
    await d.send(step, g.theirs, WORK, "initiative_status", { initiatives: [theirSlug, "a/b"] }, true);
    await d.send(step, g.theirs, WORK, "initiative_status", { initiative: theirSlug });
  });
  await row(c, c.team, when([1, 60]), "core:skill_read", null, "the answer could not be read");
  await row(c, c.team, when([1, 61]), "core:document_read", "other", null);
  await row(c, c.team, when([1, 62]), "core:knowledge_search", "theirs", "upstream answered status 502: Bad Gateway", alpha);
  await row(c, OTHER_TEAM, when([1, 63]), "core:bug_report", "guardrail", SENTINEL);
  // The running week, as it happens: one call answered, one refused, and a page view.
  await phase(c, d, null, async () => {
    await mine(step, WORK, "initiative_status", { initiative: alpha });
    await mine(step, WORK, "initiative_status", { initiatives: [] }, true);
    const viewed = await answer(g.pageView, { ...request({ email: c.email, role: "member", team: c.team }), body: { feature: "activity" } });
    if (viewed.status !== 204) c.fail(step, `the page view answered ${viewed.status}`);
  });
  for (let i = 0; i < 20 && (await count(c, "kind = 'console.page_view'")) === 0; i++) await new Promise((r) => setTimeout(r, 250));
  c.pass(`${step}: ${alpha}, two weeks of calls through the door, three refusals written as rows, the running week's two and a page view`);

  const ME: Who = { email: c.email, role: "member", team: c.team };
  const ACTING: Who = { email: SUPERADMIN, role: "superadmin", team: c.team };
  const NOWHERE: Who = { email: SUPERADMIN, role: "superadmin", team: null };
  const THEM: Who = { email: OTHER_EMAIL, role: "member", team: OTHER_TEAM };
  const everything: string[] = [];
  /** The route's answer, every one kept for the last round; a status of null takes whatever the route answers. */
  const ask = async (s: string, route: Route, who: Who, query: Record<string, string | string[]> = {}, status: number | null = 200): Promise<Obj> => {
    const a = await answer(route, request(who, query));
    everything.push(JSON.stringify(a.body));
    if (status !== null && a.status !== status) c.fail(s, `${JSON.stringify(query)} as ${who.email} answered ${a.status}, not ${status}: ${show(a.body)}`);
    return a.body;
  };
  const same = (s: string, found: unknown, want: unknown): void => {
    if (!isDeepStrictEqual(found, want)) c.fail(s, `found ${show(found)}, expected ${show(want)}`);
  };
  const masked = (o: Obj): string => JSON.stringify(o).replaceAll(String((o.meta as Obj).asOf), "<asOf>");
  const owners = (guardrail: number, ours: number, theirs: number, other: number) => ({ guardrail, ours, theirs, other });

  step = "a failed read is unavailable, never zero or none";
  // What the faults leave the summary saying: the tiles' figures, the owners, the tool refused most, and the state of
  // the weeks, the groups and the maintenance.
  const said = (a: Obj) => {
    const t = a.tiles as { calls: { figure: unknown }; refused: { figure: unknown; numerator: unknown; owners: unknown }; mostRefused: unknown };
    const state = (k: string) => (a[k] as { state: string }).state;
    return [t.calls.figure, t.refused.figure, t.refused.numerator, t.refused.owners, t.mostRefused, state("weeks"), state("groups"), a.maintenance];
  };
  const unavailable = { value: null, why: "unavailable" };
  const most = { state: "ok", data: { tool: STATUS, count: 3, of: 7 } };
  // The weekly refusals read is the one statement over unnest's periods; the tiles and the maintenance are read with it.
  const weekly = await g.failing((sql) => sql.includes("with ordinality as p(lo, hi, n)"), () => ask(step, g.summary, ME));
  same(`${step}: the weekly refusals read failing`, said(weekly), [unavailable, unavailable, null, UNREAD, most, "unavailable", "ok", UNREAD]);
  // Last week's refusals by tool is the grouping statement over the last whole week alone; the groups read spans the weeks.
  const byTool = await g.failing((sql, params) => sql.includes("as normalized") && params[1] === iso(w0 - WEEK), () => ask(step, g.summary, ME));
  same(`${step}: last week's refusals by tool failing`, said(byTool),
    [{ value: 9, why: null }, { value: 7, why: null }, 7, { state: "ok", data: owners(3, 1, 1, 2) }, UNREAD, "ok", "ok", { state: "ok", data: { calls: 2, refused: 1 } }]);
  c.pass(`${step}: the weekly read failing leaves the calls, the refused, its owners, the weeks and the maintenance unavailable ` +
         `and ${STATUS} still refused most; last week's by-tool read failing leaves the tool refused most unavailable, not none, ` +
         "beside 7 refused");

  step = "the summary: last whole week's tiles, the weeks by owner, the groups and the maintenance";
  const summary = await ask(step, g.summary, ME);
  const asOf = String((summary.meta as Obj).asOf);
  const window = (b: number) => ({ from: iso(w0 - b * WEEK), to: iso(w0 - (b - 1) * WEEK), observedFrom: iso(w0 - b * WEEK),
                                   observedThrough: b === 0 ? asOf : iso(w0 - (b - 1) * WEEK), complete: b > 0 });
  const first = (await c.sql.query<{ ms: number }>(
    `select (extract(epoch from min(e.ts)) * 1000)::float8 as ms from zz.event e join zz.team t on t.id = e.team_id
      where t.slug = $1 and e.kind = 'tool_call'`, [c.team])).rows[0].ms;
  same(step, summary.meta, { asOf, timezone: TIMEZONE, period: { from: iso(w0 - 2 * WEEK), to: asOf }, scope: "active-team",
                             population: `${c.team}'s real-work events, page views and the platform's maintenance left out`, coverageFrom: iso(first) });
  same(step, summary.tiles, {
    calls: { window: window(1), figure: { value: 9, why: null }, numerator: 9, denominator: null },
    refused: { window: window(1), figure: { value: 7, why: null }, numerator: 7, denominator: 9, owners: { state: "ok", data: owners(3, 1, 1, 2) } },
    mostRefused: most,
  });
  same(step, summary.weeks, { state: "ok", data: [
    { window: window(2), complete: true, calls: 2, refused: 1, owners: owners(1, 0, 0, 0) },
    { window: window(1), complete: true, calls: 9, refused: 7, owners: owners(3, 1, 1, 2) },
    { window: window(0), complete: false, calls: 2, refused: 1, owners: owners(1, 0, 0, 0) },
  ] });
  same(step, summary.maintenance, { state: "ok", data: { calls: 2, refused: 1 } });
  c.pass(`${step}: 9 calls last week, 7 refused (guardrail 3, ours 1, theirs 1, other 2 with the row of no owner), ` +
         `${STATUS} refused 3 of 7; the weeks from the first call's, each owners summing to its total; maintenance 2 and 1 apart`);

  step = "the groups are refusalGroups' for the team";
  const groups = summary.groups as { state: string; data: { rows: Group[]; groups: number; rest: unknown } };
  same(step, groups, { state: "ok", data: await g.refusalGroups(c.team, { from: iso(w0 - 2 * WEEK), to: asOf }, asOf) });
  const shape = groups.data.rows.map((r) => [r.owner, r.tool, r.count]);
  same(step, [shape, groups.data.groups, groups.data.rest], [[
    ["guardrail", STATUS, 4], ["theirs", "core:knowledge_search", 1], ["other", "core:document_read", 1], ["other", "core:skill_read", 1],
    ["ours", "core:document_read", 1], ["guardrail", STATUS, 1]], 6, null]);
  const [g1, theirs, unread, unowned, malformed, single] = groups.data.rows;
  if (!NONE_NAMED.test(g1.message ?? "") || theirs.message !== "upstream answered status 502: Bad Gateway" || unread.message !== null
      || unowned.message !== "the answer could not be read" || !MALFORMED.test(malformed.message ?? "") || !NOT_SINGLE.test(single.message ?? "")) {
    c.fail(step, show(groups.data.rows));
  }
  same(step, [theirs.lastSeen, unread.lastSeen, unowned.lastSeen], [iso(when([1, 62])), iso(when([1, 61])), iso(when([1, 60]))]);
  c.pass(`${step}: four refusals naming no initiative over three weeks one group, the second team's same refusal in none, ` +
         "the refusal with no text its own group with no message, each with its count and last seen");

  step = "the log: real work newest first, no page view, each refusal with its owner and message";
  const log = async (s: string, query: Record<string, string | string[]>, who: Who = ME): Promise<{ rows: Row[]; total: number; ceiling: number; kinds: string[]; tools: string[] }> =>
    (await ask(s, g.log, who, query)) as unknown as { rows: Row[]; total: number; ceiling: number; kinds: string[]; tools: string[] };
  const all = await log(step, { limit: "100" });
  const recorded = await count(c, `team_id = (select id from zz.team where slug = '${c.team}') and origin = 'work' and kind <> 'console.page_view'`);
  if (all.total !== recorded || all.rows.length !== Math.min(recorded, 100) || all.ceiling !== 500) c.fail(step, `total ${all.total} of ${recorded} recorded, ${all.rows.length} rows`);
  if (all.rows.some((r, i) => i > 0 && (all.rows[i - 1].ts < r.ts))) c.fail(step, "the rows are not newest first");
  if (all.rows.some((r) => r.kind === "console.page_view") || all.kinds.includes("console.page_view")) c.fail(step, "a page view is in the log");
  if (!all.kinds.includes("tool_call") || !all.tools.includes(STATUS) || all.tools.includes("core:bug_report")) c.fail(step, `kinds ${show(all.kinds)}, tools ${show(all.tools)}`);
  const refused = await log(step, { refused: "true" });
  same(step, [refused.total, refused.rows.length], [9, 9]);
  // The door carries the caller's initiative forward onto every call after it opened alpha; of the rows written
  // as a seed writes them, only the theirs names it.
  const expectRefused: [string, string, RegExp | string | null, string | null][] = [
    ["guardrail", STATUS, NONE_NAMED, alpha], ["theirs", "core:knowledge_search", "upstream answered status 502: Bad Gateway", alpha],
    ["other", "core:document_read", null, null], ["other", "core:skill_read", "the answer could not be read", null],
    ["ours", "core:document_read", MALFORMED, alpha], ["guardrail", STATUS, NOT_SINGLE, alpha],
    ["guardrail", STATUS, NONE_NAMED, alpha], ["guardrail", STATUS, NONE_NAMED, alpha], ["guardrail", STATUS, NONE_NAMED, alpha],
  ];
  refused.rows.slice(0, 9).forEach((r, i) => {
    const [owner, tool, message, initiative] = expectRefused[i];
    const said = message === null ? r.message === null : typeof message === "string" ? r.message === message : message.test(r.message ?? "");
    if (r.kind !== "tool_call" || r.owner !== owner || r.tool !== tool || !said || r.initiative !== initiative || !/^[0-9a-f-]{36}$|^\d+$/.test(r.id)) {
      c.fail(step, `refusal ${i + 1} reads ${show(r)}`);
    }
  });
  if (all.rows.some((r) => (r.owner !== null || r.message !== null) && !(r.kind === "tool_call" && refused.rows.some((x) => x.id === r.id)))) {
    c.fail(step, "a row that is not a refused call carries an owner or a message");
  }
  c.pass(`${step}: ${recorded} events, the nine refusals newest first with their owner, tool, initiative and message, kinds and tools the team's own`);

  step = "four filters, each narrowing and combined";
  const filtered = async (query: Record<string, string>) => (await log(step, { limit: "100", ...query })).total;
  same(step, await Promise.all([
    filtered({ kind: "tool_call" }), filtered({ tool: STATUS }), filtered({ kind: "tool_call", refused: "false" }),
    filtered({ tool: STATUS, refused: "true" }), filtered({ initiative: alpha, refused: "true" }), filtered({ kind: "console.page_view" }),
    filtered({ initiative: "2026-01-01-nobody-has-this" }), filtered({ initiative: theirSlug }),
  ]), [13, 7, 4, 5, 7, 0, 0, 0]);
  const forAlpha = await log(step, { initiative: alpha, limit: "100" });
  if (!forAlpha.total || forAlpha.rows.some((r) => r.initiative !== alpha)) c.fail(step, `the initiative filter read ${show(forAlpha.rows)}`);
  c.pass(`${step}: 13 tool calls, 7 of ${STATUS}, 4 answered, 5 of them refused, alpha's 7 refusals; an unknown slug and the second team's none`);

  step = "the page: 10 by default, at most 100, a bad page or refused refused";
  const page = await log(step, {});
  const second = await log(step, { offset: "10", limit: "10" });
  same(step, [page.rows.map((r) => r.id), second.rows.map((r) => r.id), page.total], [all.rows.slice(0, 10).map((r) => r.id), all.rows.slice(10, 20).map((r) => r.id), recorded]);
  const bad: Record<string, string | string[]>[] = [{ limit: "101" }, { limit: "0" }, { offset: "-1" }, { limit: "2.5" }, { refused: "yes" }, { kind: ["tool_call", "skill_read"] }];
  for (const query of bad) {
    await ask(step, g.log, ME, query, 400);
  }
  c.pass(step);

  step = "the people who read it, and those who cannot";
  const forActing = await ask(step, g.summary, ACTING);
  if (masked(forActing) !== masked(summary)) c.fail(step, "the superadmin acting for the team reads another summary");
  for (const [who, query] of [[ME, { team: OTHER_TEAM }], [ME, { scope: "platform" }], [ACTING, { team: OTHER_TEAM, scope: "platform" }]] as [Who, Record<string, string>][]) {
    if (masked(await ask(step, g.summary, who, query)) !== masked(summary)) c.fail(step, `${JSON.stringify(query)} as ${who.email} widened the summary`);
    const widened = await log(step, { ...query, limit: "100" }, who);
    if (widened.total !== recorded || JSON.stringify(widened.rows) !== JSON.stringify(all.rows)) c.fail(step, `${JSON.stringify(query)} as ${who.email} widened the log`);
  }
  await ask(step, g.summary, NOWHERE, {}, 400);
  await ask(step, g.log, NOWHERE, { scope: "platform" }, 400);
  c.pass(`${step}: a superadmin acting for the team reads it alike, team and scope widen nothing, and a superadmin in no team is answered 400`);

  step = "an older match is reached past 500 newer events";
  await c.sql.query(
    `insert into zz.event (ts, kind, subject, origin, team_id)
     select now() - make_interval(secs => g), 'knowledge.add', 'filler', 'work', t.id
       from generate_series(1, 520) g, zz.team t where t.slug = $1`, [c.team]);
  const capped = await log(step, { limit: "100" });
  same(step, [capped.total, capped.ceiling, await filtered({ refused: "true" }), await filtered({ kind: "tool_call" })], [500, 500, 9, 13]);
  c.pass(`${step}: the unfiltered total stops at 500, and the nine refusals and 13 calls are all still found`);

  step = "no answer at any scope carries the second team's refusal message";
  const scopes: Record<string, string>[] = [{}, { scope: "platform" }, { team: OTHER_TEAM }, { team: OTHER_TEAM, scope: "platform" }];
  for (const query of scopes) {
    for (const who of [ME, ACTING]) {
      await ask(step, g.summary, who, query);
      await log(step, { ...query, refused: "true" }, who);
    }
  }
  const found = everything.filter((t) => t.includes(SENTINEL) || t.includes("beacon ledger"));
  if (found.length) c.fail(step, `${found.length} answers hold it: ${found[0].slice(0, 300)}`);
  // The positive control: the second team's own log of refusals names it, so finding it nowhere above proves something.
  if (!JSON.stringify(await ask(step, g.log, THEM, { refused: "true" })).includes(SENTINEL)) c.fail(step, "the second team's own log does not hold its message");
  c.pass(`${step}: ${everything.length} answers of /activity and /activity/summary, while the second team's own log holds it`);

  step = "the key sets match the console's fake answers";
  let fake: { activitySummary: (who: unknown) => [number, unknown]; activityLog: (who: unknown, q: URLSearchParams) => [number, unknown] };
  try {
    fake = (await import(pathToFileURL(FAKE).href)) as typeof fake;
  } catch (err) {
    return c.fail(step, `could not read the console's fake answer at ${FAKE}: ${(err as Error).message}`);
  }
  const fakeWho = { activeTeam: "atlas", email: "ava.lindqvist@example.com" };
  const diffs = [
    ...shapeDiffs(summary, fake.activitySummary(fakeWho)[1], "summary", []),
    ...shapeDiffs(refused, fake.activityLog(fakeWho, new URLSearchParams("refused=true"))[1], "log", []),
    ...shapeDiffs(all, fake.activityLog(fakeWho, new URLSearchParams())[1], "log", []),
  ];
  if (diffs.length) c.fail(step, diffs.join("; "));
  c.pass(step);
}

process.exitCode = await withThrowawayCore(NAME, DONE, run);
