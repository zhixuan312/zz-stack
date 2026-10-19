#!/usr/bin/env node
/**
 * checks/console-work-home.ts — Home is read for the active team at one cutoff, the approvals in it the
 * caller's alone (AC-5.1, AC-5.2).
 *
 *   node checks/console-work-home.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL and a real zz-core on it (`withThrowawayCore`), and the gateway's own
 * built door in this process: the identity gate, the JSON parser, the tool-call telemetry and the relay
 * to that zz-core, in the order server.ts mounts them, so a document a person's session (`zz-plugin`) or
 * a maintenance client (`zz-migrate`) writes through it leaves the rows the import rule and the agents'
 * days are read from. The record is made in phases, each moved, together and by one interval, into the
 * week and hour it names; the searches and the runs are written as rows, as their own seeds write them.
 * It calls the gateway's own built route (`services/gateway/dist/console/home.js`) the way Express
 * would, as a console session, its relay reaching that zz-core. What it establishes, with the expected
 * values written below:
 *
 *   - the title is homeTitle's over the last whole week's facts: two closures, the most in a week yet;
 *   - the waiting strip counts nothing with nothing pending, names the one document with one, and
 *     counts two with their oldest wait with two;
 *   - the paired figures are the words added and the approvals in the caller's name by week, each
 *     with periodFinding's finding, a week with no recorded words no data rather than zero;
 *   - the foot is the last week's words at 500 words an hour, marked as an estimate on its basis, beside
 *     the week's observed run coverage and peak overlap;
 *   - the tiles: work closed, the median hours to close with its count, searches with results with
 *     numerator and denominator, and the days the agents ran of the week's seven, each of the last
 *     whole week; the closures listed are that week's, with their outcomes;
 *   - runs active now, grouped by initiative above four, or with none the last run's time;
 *   - the four milestones over the totals as of the cutoff, and with a record older than the 24 whole
 *     weeks drawn, the totals still over all of it, that read building the writing ledger once and
 *     scanning the platform for imports once, documents and lessons each, though four of its parts read
 *     them (statements counted on the gateway's own pool, matched by a fragment only that statement holds,
 *     COUPLED: console/writing.ts ledger, console/imports.ts importedDocuments and lessonImports);
 *   - open work: the waiting first, then the most recently touched, four rows beside the folded quiet
 *     ones and their count, each row's next move what initiative_status answers for it;
 *   - an import-made document, a maintenance client's lesson and its calls add nothing to any of them;
 *   - the words' basis or the run record missing is said, never zero, and the other parts stand;
 *   - a second person's approvals are not the caller's, and the same week reads alike to both;
 *   - reading Home records no event, and a page view changes no figure;
 *   - a person in no team is refused, and the key sets match the console's fake answer.
 *
 * It prints how long one whole read took: the throwaway's record is small, so the number is a floor, not the
 * representative measure the plan asks for before anything is cached.
 *
 * DELIBERATE: the reporting timezone is Asia/Singapore, eight hours ahead of UTC, so a week cut on UTC's
 * calendar moves what the record places before 08:00 on a Monday.
 *
 * DELIBERATE: what waits, the running week's writes and the active runs are made as the check runs, and the
 * weeks are counted from the running week it began in, so a run that crosses midnight into a Monday in that
 * timezone, some twenty seconds in a week, fails on dates; run it again.
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

import { lastJson } from "@zz/mcp-client";
import type { Request, RequestHandler } from "express";
import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";
import { EXPECTED, TIMEZONE, WEEK, at, runningWeek, seedSearches, type When } from "../scripts/schema/work-seed.ts";

const NAME = "console-work-home";
const DONE = "console-work-home: Home reads the active team's last whole week, what waits and what is open at one cutoff, " +
  "the approvals in it the caller's alone, an import adding nothing and a missing record said, never zero: ok";
/** COUPLED: the fake answer in the console's checkout, `../zz-stack-dashboard` here and in CI. */
const FAKE = join(root, "..", "zz-stack-dashboard", "scripts", "fake-gateway", "work-home.ts");

/** The client a maintenance command names itself, and the one a person's session does. */
const MAINTENANCE = "zz-migrate";
const WORK = "zz-plugin";
const HOUR = 3_600_000;
const EXPLORE = "## Background\nx\n\n## Current state\nx\n\n## Rough direction\nx\n";
/** A spec the spec gate takes: every declared section, one phase, one core statement. */
const SPEC =
  "## Context\nx\n\n## Problem\nx\n\n## Goals & Requirements\nx\n\n## Alternatives\nx\n\n" +
  "## Approach, Method & Structure\nx\n\n## Verification Plan\nx\n\n## Risks & Mitigations\nx\n\n" +
  "## Stakeholders & Work\nx\n\n" +
  "## Phase outline\n- **Phase 0 — Loop:** the control loop runs end to end.\n\n" +
  "## Core statements\n| ID | Statement | If false | Status | Evidence | Note |\n|---|---|---|---|---|---|\n" +
  "| CS-1 | The loop runs. | Nothing is checked. | fails | run:control-loop-e2e — `loop` | resolved-by-design-change: a probe has no design |\n";
/** The words of EXPLORE and SPEC, and of the lesson below, as the contracts count them. */
const EXPLORE_WORDS = 11, SPEC_WORDS = 91, LESSON_WORDS = 21;
const LESSON = "Close a piece of work only after the person who asked for it has read what the agents wrote for them.";

type Obj = Record<string, unknown>;
type Route = (req: unknown, res: unknown) => void;
type Who = { email: string; team: string | null };
type Win = { from: string; to: string; observedFrom: string | null; observedThrough: string | null; complete: boolean };
type PF = { window: Win; figure: { value: number | null; why: string | null }; numerator: number | null; denominator: number | null };
type Part = { state: string; data?: Obj; reason?: string };

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
/** A local `YYYY-MM-DD` date as the console writes a day in a sentence (its `formatDay`): `28 Sept`, `1 Oct`. */
const sentenceDay = (date: string): string => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" })
  .format(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))));
/** Its value with every object's keys in order: an answer's key order is no part of its contract. */
const canonical = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canonical)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Obj)[k])])) : v;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const show = (v: unknown): string => JSON.stringify(v).slice(0, 700);
/** `n` words: a heading of two, then `tag` words, twenty to a line. */
function text(n: number, tag: string): string {
  const words = Array.from({ length: n - 2 }, (_, i) => (i === 0 ? `${tag}-start` : tag));
  const lines: string[] = [];
  for (let i = 0; i < words.length; i += 20) lines.push(words.slice(i, i + 20).join(" "));
  return `# ${tag}\n\n${lines.join("\n")}\n`;
}

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

/** The request a console session's read arrives as, past the gateway's middleware (COUPLED: identity.ts). */
function request(who: Who): Obj {
  return {
    params: {}, query: {}, body: { feature: "home" },
    zzIdentity: { email: who.email, displayName: "Home", platformRole: "member", via: "session",
                  teams: who.team ? [{ slug: who.team, role: "admin" }] : [], activeTeam: who.team, patTeam: null, sessionTeam: who.team },
    headers: {
      "x-zz-user-email": who.email, "x-zz-user-name": "Home", "x-zz-user-id": "", "x-zz-user-role": "user",
      "x-zz-via": "session", "x-zz-pat-team": "", "x-zz-session-team": who.team ?? "",
    },
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

/** The gateway's door to zz-core as server.ts mounts it, a PAT of the seeded person's, and Home's and the page
 *  view's routes, loaded once the reporting timezone is set. */
interface Gateway { url: string; token: string; home: Route; pageView: Route; pool: pg.Pool; stop(): Promise<void> }

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
  ((await load("console/home.js")) as { mountHome: (app: unknown) => void }).mountHome(fake);
  ((await load("console/page-view.js")) as { mountPageView: (app: unknown) => void }).mountPageView(fake);

  const app = express();
  // COUPLED: services/gateway/src/server.ts — the identity gate, the JSON parser, the telemetry on the door and
  // then the door's relay to zz-core, in the order server.ts mounts them.
  app.use(identityMiddleware());
  app.use(express.json({ limit: "20mb" }));
  app.use(["/core/mcp"], toolCallTelemetry((req) => doorSurface(req.originalUrl)));
  app.all("/core/mcp", passThrough(c.mcp.url, "core proxy", "zz-core is not reachable"));
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const token = `zzp_${randomBytes(24).toString("hex")}`;
  await c.sql.query(
    `insert into zz.pat (principal_id, token_hash, team_id) select p.id, $2, null from zz.principal p where p.email = $1`,
    [c.email, createHash("sha256").update(token, "utf8").digest("hex")]);
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token,
    home: routes.get("GET /api/console/home") ?? c.fail("mount", "no route GET /api/console/home"),
    pageView: routes.get("POST /api/console/page-view") ?? c.fail("mount", "no route POST /api/console/page-view"),
    pool: db.platformDb(),
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.platformDb().end().catch(() => undefined);
      for (const k of ["TEAM_DB_URL", "ZZ_TZ", "ZZ_CATALOG_DIR", "CORE_MCP_URL"]) delete process.env[k];
    },
  };
}

/** Tool calls through the gateway's door as a client, counted so the rows they leave can be waited for. */
function door(c: Core, g: Gateway) {
  let sent = 0;
  const call = async (step: string, client: string, name: string, args: Obj): Promise<string> => {
    const res = await fetch(`${g.url}/core/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${g.token}`, "content-type": "application/json",
                 accept: "application/json, text/event-stream", "x-zz-client": client },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(60_000),
    });
    const raw = await res.text();
    sent++;
    const env = lastJson(raw);
    const reply = env?.result?.content?.map((p) => p.text ?? "").join("") ?? env?.error?.message ?? raw.slice(0, 300);
    if (res.status !== 200 || reply.startsWith("ERROR")) c.fail(step, `${name} as ${client} answered ${res.status}: ${reply.slice(0, 300)}`);
    return reply;
  };
  return { call, sent: () => sent };
}

const count = async (c: Core, where: string): Promise<number> =>
  (await c.sql.query<{ n: number }>(`select count(*)::int as n from zz.event where ${where}`)).rows[0].n;

/**
 * Runs `make` and waits until every row it leaves has landed (the gateway writes a tool call after its answer,
 * and zz-core most acts after its commit); then, with a `target`, moves every timestamp the phase wrote by one
 * interval, so its first instant lands there: the events, the revisions' written and presented times, the
 * documents', the initiatives' and the lessons'. One interval keeps a seal's written_at equal to its act's ts.
 */
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
  const to = new Date(target).toISOString();
  const move = (table: string, columns: string[]) => c.sql.query(
    `update ${table} set ${columns.map((k) => `${k} = case when ${k} >= $1::timestamptz then ${k} + ($2::timestamptz - $1::timestamptz) else ${k} end`).join(", ")}
      where ${columns.map((k) => `${k} >= $1::timestamptz`).join(" or ")}`, [start, to]);
  await move("zz.event", ["ts"]);
  await move("zz.doc_revision", ["written_at", "presented_at"]);
  await move("zz.doc", ["created_at", "updated_at"]);
  await move("zz.initiative", ["opened_at", "closed_at"]);
  await move("zz.knowledge_node", ["created_at", "updated_at"]);
}

async function run(c: Core): Promise<void> {
  const g = await listen(c);
  try {
    await cases(c, g);
  } finally {
    await g.stop();
  }
}

async function cases(c: Core, g: Gateway): Promise<void> {
  const d = door(c, g);
  const member = await c.member();
  const memberClient = c.client({ email: member });
  const w0 = runningWeek(Date.now());
  const when = (w: When): number => at(w0, w);
  const write = (step: string, client: string, path: string, content: string) => d.call(step, client, "document_write", { path, content });
  const S = new Map<string, string>();
  const slug = (key: string): string => S.get(key) ?? c.fail("the record", `no initiative ${key}`);
  const open = async (key: string, flow?: string) => { S.set(key, await c.open(`home-${key}`, flow)); };

  // The record, a week and an hour a phase: weeks back from the running one, hours into the week.
  let step = "the record made";
  await phase(c, d, when([5, 10]), () => open("quiet-one"));
  await phase(c, d, when([4, 34]), async () => { await write(step, WORK, `${slug("quiet-one")}/alpha.md`, text(300, "alpha")); });
  await phase(c, d, when([3, 34]), async () => {
    await open("quiet-two");
    await write(step, WORK, `${slug("quiet-two")}/beta.md`, text(200, "beta"));
    await c.sign(`${slug("quiet-one")}/alpha.md`);
  });
  await phase(c, d, when([2, 34]), () => open("accepted"));
  await phase(c, d, when([1, 10]), async () => { await open("abandoned"); await open("open-one"); });
  await phase(c, d, when([1, 34]), async () => {
    await open("open-two");
    await write(step, WORK, `${slug("accepted")}/notes.md`, text(500, "notes"));
  });
  await phase(c, d, when([1, 58]), async () => {
    await d.call(step, WORK, "knowledge_add", { title: "Close after reading", type: "decision", scope: "team", evidence: [slug("accepted")], body: LESSON });
  });
  // A maintenance client's day: an import-made document and a lesson it carried, and no agent's call.
  await phase(c, d, when([1, 82]), async () => {
    await write(step, MAINTENANCE, `${slug("accepted")}/imported.md`, text(1000, "imported"));
    await d.call(step, MAINTENANCE, "knowledge_add", { title: "Carried lesson", type: "knowledge", scope: "team",
      evidence: [slug("accepted")], body: Array(40).fill("carried").join(" ") });
  });
  await phase(c, d, when([1, 106]), async () => {
    await c.sign(`${slug("accepted")}/notes.md`);
    await c.ok(step, "document_present", { path: `${slug("accepted")}/imported.md` }, memberClient);
    await c.ok(step, "document_approve", { path: `${slug("accepted")}/imported.md` }, memberClient);
    await c.ok(step, "initiative_close", { initiative: slug("accepted"), disposition: "finished", document: "notes.md" });
    await c.ok(step, "initiative_close", { initiative: slug("abandoned"), disposition: "abandoned" });
  });
  // The running week, as it happens: two initiatives under sdlc-flow with a spec written, and one opened.
  await phase(c, d, null, async () => {
    for (const key of ["waiting-a", "waiting-b"]) {
      // A second apart, so the second is the more recently touched at the whole seconds a row is stamped in.
      if (key === "waiting-b") await new Promise((r) => setTimeout(r, 1100));
      await open(key, "sdlc-flow");
      await write(step, WORK, `${slug(key)}/explore.md`, EXPLORE);
      await write(step, WORK, `${slug(key)}/spec.md`, SPEC);
    }
    await open("open-three");
  });
  await seedSearches(c.sql, c.team, "home-nobody", w0);
  const runs = await seedRuns(c, slug);

  const ME: Who = { email: c.email, team: c.team };
  const read = async (s: string, who: Who = ME): Promise<Obj> => {
    const a = await answer(g.home, request(who));
    if (a.status !== 200) c.fail(s, `Home answered ${a.status}: ${show(a.body)}`);
    return a.body;
  };
  const ok = (s: string, part: unknown): Obj => {
    const p = part as Part;
    if (p?.state !== "ok") c.fail(s, `a part read ${show(part)}`);
    return p.data!;
  };
  const same = (s: string, found: unknown, expected: unknown): void => {
    if (JSON.stringify(canonical(found)) !== JSON.stringify(canonical(expected))) c.fail(s, `found ${show(found)}, expected ${show(expected)}`);
  };
  const presentedOf = async (key: string): Promise<string> => iso((await c.sql.query<{ ms: number }>(
    `select (extract(epoch from r.presented_at) * 1000)::float8 as ms from zz.doc d join zz.initiative i on i.id = d.initiative_id
       join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision where i.slug = $1 and d.path = 'spec.md'`, [slug(key)])).rows[0].ms);

  step = "the waiting strip: nothing pending, then one document, then two with the oldest";
  same(step, ok(step, (await read(step)).waiting), { count: 0, oldestSince: null, one: null });
  await c.ok(step, "document_present", { path: `${slug("waiting-a")}/spec.md` });
  same(step, ok(step, (await read(step)).waiting), { count: 1, oldestSince: await presentedOf("waiting-a"), one: { initiative: slug("waiting-a"), path: "spec.md", version: 1 } });
  await c.ok(step, "document_present", { path: `${slug("waiting-b")}/spec.md` });
  await runs.activate();
  const home = await read(step);
  same(step, ok(step, home.waiting), { count: 2, oldestSince: await presentedOf("waiting-a"), one: null });
  c.pass(step);

  // The weeks of the record, five whole ones and the running one, and the local date each begins on.
  const asOf = String((home.meta as Obj).asOf);
  const backs = [5, 4, 3, 2, 1, 0];
  const window = (b: number): Win => ({ from: iso(w0 - b * WEEK), to: iso(w0 - (b - 1) * WEEK), observedFrom: iso(w0 - b * WEEK),
                                        observedThrough: b === 0 ? asOf : iso(w0 - (b - 1) * WEEK), complete: b > 0 });
  const local = (b: number): string => new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(new Date(w0 - b * WEEK));
  const day = (b: number): string => sentenceDay(local(b));
  const lastWeek = window(1);
  const LAST_WORDS = 500 + LESSON_WORDS;
  const RUNNING_WORDS = 2 * (EXPLORE_WORDS + SPEC_WORDS);

  step = "the meta and the title";
  const opened = (await c.sql.query<{ ms: number }>("select (extract(epoch from opened_at) * 1000)::float8 as ms from zz.initiative where slug = $1", [slug("quiet-one")])).rows[0].ms;
  same(step, home.meta, { asOf, timezone: TIMEZONE, period: { from: iso(w0 - 5 * WEEK), to: asOf }, scope: "caller-in-active-team",
                          population: `${c.team}'s work last week, and the approvals signed in the caller's name there`, coverageFrom: iso(opened) });
  same(step, home.title, { sentence: "2 pieces of work closed last week, the most in a week yet", rule: 3 });
  c.pass(`${step}: the last whole week's two closures are the most in a week yet`);

  step = "the paired figures: words added and approvals in the caller's name by week, each with its finding";
  const words = ok(step, home.words);
  same(step, (words.weeks as PF[]).map((p) => [p.window, p.figure]),
    backs.map((b, i) => [window(b), [null, 300, 200, null, LAST_WORDS, RUNNING_WORDS][i] === null
      ? { value: null, why: "no_data" } : { value: [null, 300, 200, null, LAST_WORDS, RUNNING_WORDS][i], why: null }]));
  same(step, words.finding, { kind: "high_week", text: `Most recorded words added in a week since ${day(4)}`, dates: [local(1), local(4)], tie: false });
  const coverage = words.coverage as Obj;
  if (coverage.importMade !== 1 || coverage.unrecorded !== 0 || coverage.mixed !== 0) c.fail(step, `coverage ${show(coverage)}`);
  const approvals = ok(step, home.approvals);
  same(step, (approvals.weeks as PF[]).map((p) => [p.window.from, p.figure.value]), backs.map((b, i) => [window(b).from, [0, 0, 1, 0, 1, 0][i]]));
  same(step, approvals.finding, { kind: "high_week", text: `Most recorded approvals in your name in a week since ${day(5)}, tied with ${day(3)}`,
                                  dates: [local(1), local(5), local(3)], tie: true });
  c.pass(step);

  step = "the foot: the last week's words at the stated pace, estimated, beside the run coverage and peak";
  same(step, home.foot, { estimate: { basis: "period_net_additions", words: LAST_WORDS, assumedWordsPerHour: 500, hours: LAST_WORDS / 500, coverage },
                          coverageMs: { value: 3 * HOUR, why: null }, peak: { value: 2, why: null } });
  c.pass(step);

  step = "the four tiles of the last whole week, and its closures with their outcomes";
  const tiles = home.tiles as Record<string, PF>;
  const closedAt = async (key: string) => iso((await c.sql.query<{ ms: number }>(
    "select (extract(epoch from closed_at) * 1000)::float8 as ms from zz.initiative where slug = $1", [slug(key)])).rows[0].ms);
  const median = tiles.medianHoursToClose;
  const [found, completed] = EXPECTED.searches[1];
  same(step, [tiles.closed, tiles.searchesWithResults, tiles.agentDays], [
    { window: lastWeek, figure: { value: 2, why: null }, numerator: 2, denominator: null },
    { window: lastWeek, figure: { value: (100 * found) / completed, why: null }, numerator: found, denominator: completed },
    { window: lastWeek, figure: { value: 2, why: null }, numerator: 2, denominator: 7 },
  ]);
  // Opened Tuesday two weeks back and Monday last week, both closed on Friday: 240 and 96 hours, the
  // seconds the tools took between a phase's first instant and the act left in.
  if (JSON.stringify(median.window) !== JSON.stringify(lastWeek) || median.denominator !== 2 || median.figure.why !== null
      || Math.abs(Number(median.figure.value) - 168) > 0.05) c.fail(step, `median hours to close ${show(median)}`);
  same(step, ok(step, home.closedLastWeek), [{ slug: slug("accepted"), outcome: "accepted", closedAt: await closedAt("accepted") },
                                             { slug: slug("abandoned"), outcome: "abandoned", closedAt: await closedAt("abandoned") }]);
  c.pass(`${step}: two closed, a median of 168 hours over 2, ${found} of ${completed} searches, the agents on 2 days of 7`);

  step = "runs active now, grouped by initiative above four";
  same(step, ok(step, home.runs), runs.expected());
  c.pass(step);

  step = "the milestones, over the totals as of the cutoff";
  same(step, ok(step, home.milestones), [
    { count: "closed", next: 10, last: 0, value: 2 }, { count: "documents", next: 100, last: 0, value: 7 },
    { count: "lessons", next: 10, last: 0, value: 1 }, { count: "words", next: 1_000_000, last: 0, value: 300 + 200 + LAST_WORDS + RUNNING_WORDS },
  ]);
  c.pass(`${step}: the import-made document, the carried lesson and the maintenance client's day counted nowhere`);

  step = "open work: waiting first, then the most recently touched, the quiet folded, each with its next move";
  const work = ok(step, home.openWork);
  const rows = work.rows as { slug: string; state: string; nextMove: { action: string; document: string | null } | null }[];
  same(step, [rows.map((r) => [r.slug, r.state]), work.quiet, work.total],
    [[[slug("waiting-b"), "waiting"], [slug("waiting-a"), "waiting"], [slug("open-three"), "open"], [slug("open-two"), "open"]], 2, 7]);
  for (const r of rows) {
    const want = (await c.status(r.slug)).next_move ?? null;
    if (r.nextMove?.action !== (want?.action ?? "none") || (want?.document && r.nextMove.document !== want.document)) {
      c.fail(step, `${r.slug} reads ${show(r.nextMove)}, where initiative_status answers ${show(want)}`);
    }
  }
  if (rows.slice(0, 2).some((r) => r.nextMove?.action !== "await_approval" || r.nextMove.document !== "spec.md")) c.fail(step, show(rows));
  c.pass(step);

  step = "a second person on the team reads the same week, and none of the first's approvals as theirs";
  const theirs = await read(step, { email: member, team: c.team });
  same(step, (ok(step, theirs.approvals).weeks as PF[]).map((p) => p.figure.value), [0, 0, 0, 0, 1, 0]);
  const strip = (h: Obj) => JSON.stringify({ ...h, approvals: null, title: null, meta: null }).replaceAll(String((h.meta as Obj).asOf), "<asOf>");
  if (strip(theirs) !== strip(await read(step))) c.fail(step, "the second person read another week of the team's work");
  c.pass(step);

  step = "with no run active, the last run's time";
  await runs.settle();
  const settled = await read(step);
  same(step, ok(step, settled.runs), { active: [], more: 0, lastRunAt: runs.lastRunAt() });
  c.pass(step);

  step = "reading Home records no event, and a page view changes no figure";
  const before = await count(c, "true");
  const started = performance.now();
  const first = await read(step);
  const took = performance.now() - started;
  await new Promise((r) => setTimeout(r, 1500));
  if (await count(c, "true") !== before) c.fail(step, `${(await count(c, "true")) - before} events were recorded by reading Home`);
  const viewed = await answer(g.pageView, request(ME));
  if (viewed.status !== 204 && viewed.status !== 200) c.fail(step, `the page view answered ${viewed.status}`);
  for (let i = 0; i < 20 && (await count(c, "kind = 'console.page_view'")) === 0; i++) await new Promise((r) => setTimeout(r, 250));
  if ((await count(c, "kind = 'console.page_view'")) !== 1) c.fail(step, "the page view was not recorded");
  const masked = (h: Obj) => JSON.stringify(h).replaceAll(String((h.meta as Obj).asOf), "<asOf>");
  if (masked(await read(step)) !== masked(first)) c.fail(step, "a page view changed what Home reads");
  c.pass(`${step}: one whole read took ${took.toFixed(0)} ms on the throwaway's small record, a floor and not the representative measure`);

  step = "the words' basis missing is said, never zero, and the rest stands";
  await c.sql.query("alter table zz.knowledge_node rename to knowledge_node_hidden");
  const blind = await read(step).finally(() => c.sql.query("alter table zz.knowledge_node_hidden rename to knowledge_node"));
  // No estimate at all, not one of null words over a coverage of zeros: a count not read is never 0.
  if ((blind.words as Part).state !== "unavailable" || (blind.foot as Obj).estimate !== null
      || ok(step, blind.approvals) === null || (blind.runs as Part).state !== "ok") c.fail(step, show([blind.words, blind.foot, blind.runs]));
  same(step, ok(step, blind.milestones), [{ count: "closed", next: 10, last: 0, value: 2 }]);
  c.pass(step);

  step = "the run record missing is said, never zero, and the rest stands";
  await c.sql.query("alter table zz.skill_run rename to skill_run_hidden");
  const runless = await read(step).finally(() => c.sql.query("alter table zz.skill_run_hidden rename to skill_run"));
  const foot = runless.foot as Obj;
  if ((runless.runs as Part).state !== "unavailable" || ok(step, runless.words) === null) c.fail(step, show([runless.runs, runless.words]));
  same(step, [foot.coverageMs, foot.peak], [{ value: null, why: "unavailable" }, { value: null, why: "unavailable" }]);
  c.pass(step);

  step = "a person in no team is refused before anything is read";
  const none = await answer(g.home, request({ email: c.email, team: null }));
  if (none.status !== 400) c.fail(step, `answered ${none.status}: ${show(none.body)}`);
  c.pass(step);

  step = "a record older than the weeks drawn: the newest 24 whole weeks, and the totals over all of it";
  await phase(c, d, when([30, 10]), async () => {
    await open("old");
    await write(step, WORK, `${slug("old")}/notes.md`, text(100, "old"));
    await c.ok(step, "initiative_close", { initiative: slug("old"), disposition: "finished", document: "notes.md" });
  });
  const sent: string[] = [];
  const query = g.pool.query;
  g.pool.query = ((text: unknown, ...rest: unknown[]) => {
    if (typeof text === "string") sent.push(text);
    return (query as (...a: unknown[]) => unknown).call(g.pool, text, ...rest);
  }) as typeof query;
  const long = await read(step).finally(() => { g.pool.query = query; });
  const times = (fragment: string): number => sent.filter((t) => t.includes(fragment)).length;
  same(`${step}: the ledger and the import scans once`,
    [times("content_state = 'retained' as retained"), times("'core:document_patch'"), times("tool_key = 'core:knowledge_add'")], [1, 1, 1]);
  const drawn = ok(step, long.words).weeks as PF[];
  const drawnFrom = ((long.meta as Obj).period as Obj).from;
  if (drawn.length !== 25 || drawn[0].window.from !== iso(w0 - 24 * WEEK) || drawnFrom !== drawn[0].window.from) {
    c.fail(step, `the weeks drawn from ${show(drawn[0]?.window)}, ${drawn.length} of them, the period from ${String(drawnFrom)}`);
  }
  same(step, long.title, home.title);
  same(step, ok(step, long.milestones), [
    { count: "closed", next: 10, last: 0, value: 3 }, { count: "documents", next: 100, last: 0, value: 8 },
    { count: "lessons", next: 10, last: 0, value: 1 }, { count: "words", next: 1_000_000, last: 0, value: 100 + 300 + 200 + LAST_WORDS + RUNNING_WORDS },
  ]);
  c.pass(step);

  step = "the key sets match the console's fake answer";
  let fake: { home: (who: unknown) => unknown };
  try {
    fake = (await import(pathToFileURL(FAKE).href)) as typeof fake;
  } catch (err) {
    return c.fail(step, `could not read the console's fake answer at ${FAKE}: ${(err as Error).message}`);
  }
  const diffs = shapeDiffs(home, fake.home({ activeTeam: "atlas", email: "ava.lindqvist@example.com" }), "", []);
  if (diffs.length) c.fail(step, diffs.join("; "));
  c.pass(step);
}

/**
 * The runs, written as zz.skill_run rows as runs-seed.ts writes them: two overlapping last Tuesday, from 10:00
 * to 12:00 and from 11:00 to 13:00, so three hours covered and two at once; and, when `activate` is called,
 * six ending in the minute before now in five initiatives, which `settle` moves an hour back.
 */
async function seedRuns(c: Core, slug: (key: string) => string) {
  const one = async (sql: string, args: unknown[]): Promise<string> => (await c.sql.query<{ id: string }>(sql, args)).rows[0].id;
  const team = await one("select id from zz.team where slug = $1", [c.team]);
  const versions = new Map<string, string>();
  for (const name of ["home-explore", "home-spec", "home-plan"]) {
    const skill = await one("insert into zz.skill (name) values ($1) returning id", [name]);
    versions.set(name, await one("insert into zz.skill_version (skill_id, version, content_hash) values ($1, '1.0.0', $2) returning id",
                                 [skill, createHash("sha256").update(name).digest("hex")]));
  }
  const insert = (initiative: string | null, skill: string, started: string, ended: string, session: string) => c.sql.query(
    `insert into zz.skill_run (team_id, initiative_id, skill_version_id, session, calls, bytes_total, started_at, ended_at)
     values ($1, (select id from zz.initiative where slug = $2), $3, $4, 3, 100, $5::timestamptz, $6::timestamptz)`,
    [team, initiative, versions.get(skill), session, started, ended]);
  const w0 = runningWeek(Date.now());
  await insert(slug("open-one"), "home-spec", iso(at(w0, [1, 34])), iso(at(w0, [1, 36])), "home-r1");
  await insert(slug("open-two"), "home-plan", iso(at(w0, [1, 35])), iso(at(w0, [1, 37])), "home-r2");
  // Seconds before now each ends, by initiative: open-one's two, then one a group down to waiting-a's, the fifth group.
  const ACTIVE: [string | null, string, number][] = [
    ["open-one", "home-plan", 10], ["open-two", "home-spec", 20], ["open-one", "home-spec", 30],
    [null, "home-plan", 40], ["open-three", "home-explore", 50], ["waiting-a", "home-plan", 60],
  ];
  const active = new Map<number, { started: string; ended: string }>();
  return {
    async activate(): Promise<void> {
      const now = Math.floor(Date.now() / 1000) * 1000;
      for (const [i, [key, skill, ago]] of ACTIVE.entries()) {
        const at = { started: iso(now - ago * 1000 - 600_000), ended: iso(now - ago * 1000) };
        active.set(i, at);
        await insert(key && slug(key), skill, at.started, at.ended, `home-a${i}`);
      }
    },
    /** What the runs part reads while they are active: four groups, the latest call first, and one run more. */
    expected(): Obj {
      const run = (i: number) => ({ skill: ACTIVE[i][1], startedAt: active.get(i)!.started, lastAt: active.get(i)!.ended });
      return {
        active: [
          { initiative: slug("open-one"), runs: [run(0), run(2)] }, { initiative: slug("open-two"), runs: [run(1)] },
          { initiative: null, runs: [run(3)] }, { initiative: slug("open-three"), runs: [run(4)] },
        ],
        more: 1, lastRunAt: active.get(0)!.ended,
      };
    },
    async settle(): Promise<void> {
      await c.sql.query("update zz.skill_run set started_at = started_at - interval '1 hour', ended_at = ended_at - interval '1 hour' where session like 'home-a%'");
    },
    lastRunAt: (): string => iso(Date.parse(active.get(0)!.ended) - HOUR),
  };
}

process.exitCode = await withThrowawayCore(NAME, DONE, run);
