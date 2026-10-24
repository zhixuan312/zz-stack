#!/usr/bin/env node
/**
 * checks/console-agent-reads.ts — the five reads the core door offers are functions of their caller, and each
 * answers what its page's route answers the same person (AC-7.2, AC-7.3, AC-7.4, AC-7.5).
 *
 *   node checks/console-agent-reads.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL and a real zz-core on it (`withThrowawayCore`), seeds what
 * `scripts/schema/isolation-seed.ts` declares through the tools and as rows (`seedIsolation`, `seedWork`,
 * `seedWorkRecord`), and beside it bug reports filed through zz-core's `bug_report` on a tool the doors
 * register, releases as the release records them, refusals and runs as the gateway records them. It serves
 * the gateway's built identity middleware, JSON parser and `mountConsole` from this process in server.ts's
 * order, and one route of its own behind the same identity gate that calls the built functions of
 * `services/gateway/dist/console/agent-reads.js` with the caller that gate resolved, as the agent door does.
 * Four people ask, each through a live console session: the first team's member, the second team's member,
 * a superadmin acting for the first team and a superadmin in no team. What it establishes:
 *
 *   - for each of them, each function's answer equals its page's route's answer, its instants masked, for the
 *     arguments the route takes: Status; Releases' list, the route's rows the function's with `upgradeNotes`
 *     removed, `clientAction` in both, and each function row's `upgradeNotes` its release page's; Activity's
 *     summary, the function's `byTool` and `messages` aside; Runs; Record in each period;
 *   - `platform_status` with a canonical tool answers that tool's open reports as public rows, the rows the
 *     bugs queue answers a member for that surface, and the same count, coverage and rows to both
 *     superadmins; a surface `canonicalSurface` drops is an input error;
 *   - `release_list` with `since` answers the releases recorded after that version, newest first in recorded
 *     order (a tie on the time broken by the version), the named one left out; `limit` bounds them, five
 *     when none is asked and at most 50; an unknown version is an input error naming `since`;
 *   - `activity_refusals` answers the page's summary with `byTool`, the window's refusals summed by tool,
 *     and `messages`, its ten largest groups; with `since` the weeks and groups count only what happened
 *     from that date, the tiles staying the page's last whole week; with `initiative` only that
 *     initiative of the active team's, the second team's refused as one nobody has; a read that fails is
 *     unavailable, never zero or none: with the weekly refusals read failing in the gateway's own pool, the
 *     calls, the refused, its owners, the weeks and the maintenance are each unavailable and the tool
 *     refused most stands, and with last week's refusals by tool failing, the tool refused most is
 *     unavailable and the rest stands;
 *   - `run_summary` with `since` counts only the runs from that date; the tools' own `since` is seven local
 *     days before the cutoff; a malformed or future date is an input error;
 *   - the superadmin in no team is answered the route's own no-team sentence by the three Work reads;
 *   - no answer the first team's member is given holds any of the second team's sentinels.
 *
 * DELIBERATE: the reporting timezone is Asia/Singapore and the dates asked are counted back from the local
 * day the check reads on; a run that crosses local midnight between two reads fails on a date. Run it again.
 *
 * The only database it touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import type { Express, Request, RequestHandler, Response } from "express";
import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import { seedIsolation, seedWork, seedWorkRecord, type Isolation, type WorkRecord } from "../scripts/schema/isolation-seed.ts";
import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";

import { send } from "./console-isolation-work.ts";

const NAME = "console-agent-reads";
const DONE = "console-agent-reads: the five agent reads answer the first team's member, the second team's member, a " +
  "superadmin acting for the first team and a superadmin in no team what their pages' routes answer them, with a tool's " +
  "open reports, releases after a version in recorded order, refusals and runs from a date and in an initiative, a " +
  "failed refusals read unavailable rather than zero or none, and an input error for every argument outside its bounds: ok";
const TIMEZONE = "Asia/Singapore";
/** The check's own route, behind the identity gate, as the agent door calls the functions. */
const READ = "/check/agent-read";
/** A tool the doors register, and the surface the reports are filed on. */
const TOOL = "document_write";
const OTHER_TOOL = "knowledge_search";
/** The releases as recorded, oldest first: days back and the version, 0.10.1 and 0.10.2 at one instant. */
const RELEASES: [number, string][] = [[40, "0.8.0"], [30, "0.9.0"], [20, "0.10.0"], [10, "0.10.1"], [10, "0.10.2"], [5, "0.11.0"], [1, "0.12.0"]];
const DAY = 86_400_000;

type Obj = Record<string, unknown>;
type Who = { label: string; email: string; cookie: string; team: string | null; superadmin: boolean };
type Part = { state: string; data?: unknown; reason?: string };
type Answer = { status: number; body: Obj; text: string };

/** The initiative route's not-found, which activity_refusals answers for a slug the team does not hold.
 *  COUPLED: NO_INITIATIVE in services/gateway/src/console/initiatives.ts. */
const NO_INITIATIVE = "No initiative of the team you act for has that name.";
/** A part the gateway could not read. */
const UNREAD = { state: "unavailable", reason: "query_failed" };

/** The harness's own failure, set once it starts: the case and what was found. */
let fail: Core["fail"] = (step, detail) => { throw new Error(`${step}: ${detail}`); };
const pass = (line: string): void => console.log(`  ok  ${line}`);
const show = (v: unknown): string => JSON.stringify(v).slice(0, 700);
/** The fields that describe the REQUEST rather than the figures: `observedAt` is when this request obtained its
 *  answer, `cacheHit` is what the cache decided for it, and `revision` is the marker it could hear. A route and the
 *  function it reuses legitimately differ in all three and still say the same thing. */
const REQUEST_SCOPED = ["observedAt", "cacheHit", "revision"] as const;

/** An answer with every instant masked and the request-scoped fields removed: what is left is what it says. */
const masked = (v: unknown): string => {
  const strip = (o: unknown): unknown => {
    if (Array.isArray(o)) return o.map(strip);
    if (o && typeof o === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(o as Record<string, unknown>)) {
        if ((REQUEST_SCOPED as readonly string[]).includes(k)) continue;
        out[k] = strip(x);
      }
      return out;
    }
    return o;
  };
  return JSON.stringify(strip(v)).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<instant>");
};
/** A part's data, or the case fails. */
function data<T>(step: string, part: unknown): T {
  const p = part as Part;
  if (p?.state !== "ok") fail(step, `the part answered ${show(p)}`);
  return p.data as T;
}
/** Where two answers differ, by the first top-level key that does, masked. */
function differs(a: unknown, b: unknown): string | null {
  if (masked(a) === masked(b)) return null;
  const ka = Object.keys(a as Obj), kb = Object.keys(b as Obj);
  if (ka.join() !== kb.join()) return `keys {${ka.join(", ")}} where the route has {${kb.join(", ")}}`;
  const k = ka.find((x) => masked((a as Obj)[x]) !== masked((b as Obj)[x]))!;
  return `${k} reads ${masked((a as Obj)[k]).slice(0, 400)} where the route reads ${masked((b as Obj)[k]).slice(0, 400)}`;
}
const without = (o: Obj, ...keys: string[]): Obj => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

/** The local date `n` days before today in the reporting timezone. */
const daysBack = (n: number): string => new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(new Date(Date.now() - n * DAY));

/** Rows beside the seed's: a tool the doors register, reports filed on it through zz-core, the releases,
 *  refusals and runs. Answers the second team's report title, a sentinel of its own. */
async function seedReads(c: Core, s: Isolation): Promise<string> {
  const sql = c.sql;
  const { rows: [v] } = await sql.query<{ id: string }>(
    `with p as (insert into zz.plugin (name, origin) values ('agent-reads-doors', 'platform') returning id)
     insert into zz.plugin_version (plugin_id, version, digest) select id, '1.0.0', 'sha256:agent-reads' from p returning id::text as id`);
  for (const tool of [TOOL, OTHER_TOOL]) await sql.query("insert into zz.plugin_tool (plugin_version_id, name, door) values ($1, $2, 'core')", [v.id, tool]);

  const report = (email: string, title: string, surface: string, impact: string) =>
    c.ok(`report ${title}`, "bug_report", { title, detail: `${title}, in detail`, surface, impact }, c.client({ email }));
  await report(s.one.email, "the first write refused", `core:${TOOL}`, "blocks_work");
  await report(s.one.email, "the second write refused", TOOL, "confusing");
  await report(s.one.email, "a search found nothing", OTHER_TOOL, "wrong_result");
  const theirs = `report-${randomBytes(8).toString("hex")}`;
  await report(s.two.email, theirs, TOOL, "cosmetic");

  for (const [back, version] of RELEASES) {
    await sql.query(
      `insert into zz.release (version, console_version, released_at, summary, changelog, upgrade_notes, client_action)
       values ($1, null, date_trunc('second', now()) - $2 * interval '1 day', $3, $4, $5, $6)`,
      [version, back, `Release ${version}`, `## ${version}\n\nWhat changed in ${version}.`,
       version === "0.10.2" ? null : `Upgrade to ${version} as its notes say.`, version === "0.11.0" ? "reinstall the plugins" : null]);
  }

  // Refusals as the gateway's telemetry records them: the first team's in its open initiative and outside it.
  const refuse = (team: Isolation["one"], days: number, tool: string, owner: string, message: string, inInitiative: boolean) => sql.query(
    `insert into zz.event (ts, kind, subject, tool_key, ok, refusal, refusal_owner, origin, detail, team_id, actor_id, initiative_id, duration_ms)
     select now() - $1 * interval '1 day', 'tool_call', $2, $2, false, $3, $4, 'work', '{}'::jsonb, t.id, p.id,
            case when $7 then (select i.id from zz.initiative i where i.team_id = t.id and i.slug = $6) end, 40
       from zz.team t, zz.principal p where t.slug = $5 and p.email = $8`,
    [days, `core:${tool}`, message, owner, team.slug, team.initiative, inInitiative, team.email]);
  await refuse(s.one, 12, TOOL, "ours", "ERROR: SECTION_MISSING — the plan has no Phases", true);
  await refuse(s.one, 2, TOOL, "ours", "ERROR: SECTION_MISSING — the plan has no Phases", true);
  await refuse(s.one, 2, OTHER_TOOL, "theirs", "ERROR: the store could not be reached", false);
  await refuse(s.two, 2, TOOL, "ours", `ERROR: SECTION_MISSING — ${s.sentinels.refusal}`, true);

  // A run of the first team twelve days back, beside seedWorkRecord's of a day back.
  await sql.query(
    `with k as (insert into zz.skill (name) values ('agent-reads-skill') returning id),
          v as (insert into zz.skill_version (skill_id, version, content_hash) select id, '1.0.0', $2 from k returning id)
     insert into zz.skill_run (team_id, initiative_id, skill_version_id, session, calls, refusals, bytes_total, started_at, ended_at)
     select t.id, null, v.id, $3, 5, 1, 2048, now() - interval '12 days', now() - interval '12 days' + interval '20 minutes'
       from zz.team t, v where t.slug = $1`, [s.one.slug, randomBytes(32).toString("hex"), `agent-reads-${randomBytes(6).toString("hex")}`]);
  return theirs;
}

/** The gateway as server.ts mounts the console, and the check's own route calling the agent reads. */
async function listen(c: Core): Promise<{
  base: string; local: (date: string) => Promise<string>;
  failing: <T>(when: (sql: string, params: unknown[]) => boolean, f: () => Promise<T>) => Promise<T>;
  stop: () => Promise<void>;
}> {
  process.env.TEAM_DB_URL = c.url;
  process.env.ZZ_TZ = TIMEZONE;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  process.env.CORE_MCP_URL = c.mcp.url;
  process.env.GATEWAY_PUBLIC_URL = "https://gateway.agent-reads.example.test";
  const load = (p: string) => import(pathToFileURL(join(root, "services/gateway/dist", p)).href);
  const express = (await import("express")).default;
  const db = (await load("db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await db.initPlatformDb();
  const { identityMiddleware, isSuper } = (await load("identity.js")) as { identityMiddleware: () => RequestHandler; isSuper: (id: unknown) => boolean };
  const { mountConsole } = (await load("console.js")) as { mountConsole: (app: Express) => void };
  type Read = (caller: unknown, args: Obj) => Promise<object>;
  const reads = (await load("console/agent-reads.js")) as Record<string, Read> & { AGENT_READS: Record<string, Read> };
  const app = express();
  // COUPLED: services/gateway/src/server.ts — the identity gate, the JSON parser, then the console's reads.
  app.use(identityMiddleware());
  app.use(express.json({ limit: "20mb" }));
  mountConsole(app);
  // The caller as the agent door builds it from the identity the gate resolved; `tool` asks the tool's own defaults.
  app.get(READ, (req: Request, res: Response) => {
    const id = (req as unknown as { zzIdentity?: { email: string; activeTeam: string | null } }).zzIdentity;
    if (!id) { res.status(401).json({ error: "no identity" }); return; }
    const caller = { email: id.email, superadmin: isSuper(id), activeTeam: id.activeTeam };
    const name = String(req.query.fn);
    const read = req.query.tool === "1" ? reads.AGENT_READS[name] : reads[name];
    if (typeof read !== "function") { res.status(404).json({ error: `no read ${name}` }); return; }
    read(caller, JSON.parse(String(req.query.args ?? "{}")) as Obj).then((a) => res.json(a), (err: unknown) => res.status(500).json({ error: String(err) }));
  });
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const pool = db.platformDb();
  const real = pool.query.bind(pool) as (text: unknown, params?: unknown[]) => Promise<unknown>;
  return {
    base: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    // Every statement `when` picks fails in the gateway's own pool while `f` runs.
    failing: async (when, f) => {
      (pool as unknown as { query: unknown }).query = (text: unknown, params?: unknown[]) =>
        typeof text === "string" && when(text, params ?? []) ? Promise.reject(new Error("injected by the check")) : real(text, params);
      try { return await f(); } finally { (pool as unknown as { query: unknown }).query = real; }
    },
    // A local date's first instant in the reporting timezone, as the database reads it.
    local: async (date) => (await c.sql.query<{ t: string }>(
      `select to_char(($1::date)::timestamp at time zone $2::text at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as t`, [date, TIMEZONE])).rows[0].t,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.platformDb().end().catch(() => undefined);
      for (const k of ["TEAM_DB_URL", "ZZ_TZ", "ZZ_CATALOG_DIR", "CORE_MCP_URL", "GATEWAY_PUBLIC_URL"]) delete process.env[k];
    },
  };
}

async function cases(s: Isolation, w: WorkRecord, theirs: string, g: Awaited<ReturnType<typeof listen>>): Promise<void> {
  const ask = async (who: Who, url: string): Promise<Answer> => {
    const a = await send(g.base, who.cookie, { method: "get", url, body: null });
    let body: Obj = {};
    try { body = JSON.parse(a.text) as Obj; } catch { /* a body that is not JSON is kept as its text */ }
    return { status: a.status, body, text: a.text };
  };
  const read = async (step: string, who: Who, fn: string, args: Obj = {}, tool = false): Promise<Obj> => {
    const a = await ask(who, `${READ}?fn=${fn}&tool=${tool ? 1 : 0}&args=${encodeURIComponent(JSON.stringify(args))}`);
    if (a.status !== 200) fail(step, `${fn}(${show(args)}) as ${who.label} answered ${a.status}: ${a.text.slice(0, 300)}`);
    return a.body;
  };
  const route = async (step: string, who: Who, url: string, status = 200): Promise<Obj> => {
    const a = await ask(who, url);
    if (a.status !== status) fail(step, `${url} as ${who.label} answered ${a.status}, not ${status}: ${a.text.slice(0, 300)}`);
    return a.body;
  };
  const refused = async (step: string, who: Who, fn: string, args: Obj, naming: string, tool = false): Promise<string> => {
    const a = await read(step, who, fn, args, tool);
    const said = a.inputError;
    if (typeof said !== "string" || !said.includes(naming) || Object.keys(a).length !== 1) fail(step, `${fn}(${show(args)}) answered ${show(a)}`);
    return said;
  };

  const member: Who = { label: "the first team's member", email: s.one.email, cookie: s.cookies.one, team: s.one.slug, superadmin: false };
  const second: Who = { label: "the second team's member", email: s.two.email, cookie: s.cookies.two, team: s.two.slug, superadmin: false };
  const acting: Who = { label: "the superadmin acting for the first team", email: w.acting, cookie: w.cookies.acting, team: s.one.slug, superadmin: true };
  const loner: Who = { label: "the superadmin in no team", email: s.superadmin, cookie: s.cookies.superadmin, team: null, superadmin: true };
  const people = [member, second, acting, loner];

  let step = "each function answers what its route answers the same person";
  for (const who of people) {
    const pairs: [string, Obj, Obj][] = [
      ["Status", await read(step, who, "platformStatus"), await route(step, who, "/api/console/platform/status")],
    ];
    const list = await read(step, who, "releaseList", { limit: 10 });
    const page = await route(step, who, "/api/console/platform/releases");
    const listRows = data<{ rows: Obj[]; total: number }>(step, list.rows);
    const stripped = (a: Obj): Obj => {
      const r = data<{ rows: Obj[]; total: number }>(step, a.rows);
      return { ...a, rows: { state: "ok", data: { ...r, rows: r.rows.map((x) => without(x, "upgradeNotes")) } } };
    };
    pairs.push(["Releases", stripped(list), page]);
    pairs.push(["Releases' second page of two", stripped(await read(step, who, "releaseList", { limit: 2, offset: 1 })),
      await route(step, who, "/api/console/platform/releases?limit=2&offset=1")]);
    for (const r of listRows.rows) {
      const detail = await route(step, who, `/api/console/platform/releases/${String(r.version)}`);
      if (!("clientAction" in r) || r.upgradeNotes !== detail.upgradeNotes || r.clientAction !== detail.clientAction) {
        fail(step, `${String(r.version)} reads upgradeNotes ${show(r.upgradeNotes)} and clientAction ${show(r.clientAction)}, its page ${show(detail.upgradeNotes)} and ${show(detail.clientAction)}`);
      }
    }
    if (who.team === null) {
      for (const [fn, url] of [["activityRefusals", "/api/console/activity/summary"], ["runSummary", "/api/console/runs"], ["recordRead", "/api/console/record"]]) {
        const said = await read(step, who, fn);
        const error = (await route(step, who, url, 400)).error;
        if (!isDeepStrictEqual(said, { inputError: error })) fail(step, `${fn} as ${who.label} answered ${show(said)} where its route says ${show(error)}`);
      }
    } else {
      const activity = await read(step, who, "activityRefusals");
      pairs.push(["Activity", without(activity, "byTool", "messages"), await route(step, who, "/api/console/activity/summary")]);
      pairs.push(["Runs", await read(step, who, "runSummary"), await route(step, who, "/api/console/runs")]);
      pairs.push(["Runs of one skill, a page of one", await read(step, who, "runSummary", { skill: "isolation-skill", limit: 1 }),
        await route(step, who, "/api/console/runs?skill=isolation-skill&limit=1")]);
      for (const period of ["quarter", "year", "all"]) {
        pairs.push([`Record over ${period}`, await read(step, who, "recordRead", { period }), await route(step, who, `/api/console/record?period=${period}`)]);
      }
    }
    for (const [what, fn, page] of pairs) {
      const diff = differs(fn, page);
      if (diff) fail(step, `${what} as ${who.label}: ${diff}`);
    }
    pass(`${who.label}: ${pairs.map(([what]) => what).join(", ")} each equal to the route's answer, instants masked; ` +
      (who.team === null ? "Activity, Runs and Record answer the route's own no-team sentence" : "each release row's upgrade notes and client action its page's"));
  }

  step = "platform_status with a canonical tool";
  const queue = data<{ rows: Obj[] }>(step, (await route(step, member, `/api/console/platform/bugs?state=open&surface=${TOOL}&limit=100`)).queue).rows;
  const bugsRead = await route(step, member, "/api/console/platform/bugs");
  const tooled: Obj[] = [];
  for (const who of people) {
    const st = await read(step, who, "platformStatus", { tool: `CORE:${TOOL.replace("document", "Document")}` });
    const bugs = data<{ tool: string; count: number; coverage: { from: string | null; to: string }; rows: Obj[] }>(step, st.bugs);
    const diff = differs(without(st, "bugs"), await route(step, who, "/api/console/platform/status"));
    if (diff) fail(step, `the rest of the answer as ${who.label}: ${diff}`);
    if (bugs.tool !== TOOL || bugs.count !== 3 || bugs.rows.length !== 3 || !isDeepStrictEqual(bugs.rows, queue)) {
      fail(step, `as ${who.label} it reads ${show(bugs)}, where the queue answers ${show(queue)}`);
    }
    if (bugs.coverage.from !== (bugsRead.meta as Obj).coverageFrom || bugs.rows.some((r) => Object.keys(r).sort().join() !== "filedAt,id,impact,platformVersion,resolvedAt,status,surface,title")) {
      fail(step, `as ${who.label} the coverage reads ${show(bugs.coverage)}, the bugs read's ${show((bugsRead.meta as Obj).coverageFrom)}, rows ${show(bugs.rows[0])}`);
    }
    tooled.push(without(bugs, "coverage"));
  }
  if (tooled.some((b) => !isDeepStrictEqual(b, tooled[0]))) fail(step, `the four read different reports: ${show(tooled)}`);
  for (const bad of ["not-a-tool", "first team bugSurface", "core:", ""]) await refused(step, member, "platformStatus", { tool: bad }, "tool");
  pass(`${TOOL} named as CORE:Document_write answers its three open reports, the second team's among them, as the public rows ` +
    "the bugs queue answers a member for that surface, with the bugs read's coverage, alike to all four; the rest of each answer " +
    "is the route's; a surface canonicalSurface drops is an input error naming tool");

  step = "release_list's since and limit";
  const versions = async (args: Obj, tool = false): Promise<{ rows: string[]; total: number }> => {
    const r = data<{ rows: Obj[]; total: number }>(step, (await read(step, member, tool ? "release_list" : "releaseList", args, tool)).rows);
    return { rows: r.rows.map((x) => String(x.version)), total: r.total };
  };
  const want: [Obj, string[], number][] = [
    [{ since: "0.9.0", limit: 50 }, ["0.12.0", "0.11.0", "0.10.2", "0.10.1", "0.10.0"], 5],
    [{ since: "0.10.1", limit: 50 }, ["0.12.0", "0.11.0", "0.10.2"], 3],
    [{ since: "0.9.0", limit: 2 }, ["0.12.0", "0.11.0"], 5],
    [{ since: "0.12.0" }, [], 0],
    [{}, ["0.12.0", "0.11.0", "0.10.2", "0.10.1", "0.10.0"], 7],
    [{ limit: 50 }, ["0.12.0", "0.11.0", "0.10.2", "0.10.1", "0.10.0", "0.9.0", "0.8.0"], 7],
  ];
  for (const [args, rows, total] of want) {
    for (const tool of [false, true]) {
      const got = await versions(args, tool);
      if (!isDeepStrictEqual(got, { rows, total })) fail(step, `${show(args)}${tool ? " as the tool" : ""} reads ${show(got)}, expected ${show({ rows, total })}`);
    }
  }
  for (const bad of [{ since: "9.9.9" }, { since: "" }, { since: 9 }]) await refused(step, member, "releaseList", bad, "since");
  for (const bad of [{ limit: 0 }, { limit: 51 }, { limit: 2.5 }, { limit: "5" }, { offset: -1 }]) await refused(step, member, "releaseList", bad, "limit");
  pass("since 0.9.0 answers 0.12.0 to 0.10.0 newest first, 0.10.2 before 0.10.1 at the same instant, never 0.9.0 itself; since " +
    "0.10.1 answers the three after it; limit 2 two of five; five when no limit is asked and up to 50; an unknown version is an " +
    "input error naming since, never every release; a limit of 0, 51 or 2.5 and an offset of -1 are input errors");

  step = "activity_refusals over its window";
  const groupsOf = (a: Obj): Obj[] => data<{ rows: Obj[] }>(step, a.groups).rows;
  const refusedIn = (a: Obj): number => data<{ refused: number }[]>(step, a.weeks).reduce((n, p) => n + p.refused, 0);
  const page = await route(step, member, "/api/console/activity/summary");
  const five = daysBack(5), fifteen = daysBack(15);
  const recent = await read(step, member, "activityRefusals", { since: five });
  const longer = await read(step, member, "activityRefusals", { since: fifteen });
  const sums = (a: Obj) => data<Obj[]>(step, a.byTool);
  const expectations: [string, unknown, unknown][] = [
    ["the window", (recent.meta as Obj).period, { from: await g.local(five), to: ((recent.meta as Obj).period as Obj).to }],
    ["the tiles from a date inside the last whole week", masked(recent.tiles), masked(page.tiles)],
    ["the tiles from a date before it", masked(longer.tiles), masked(page.tiles)],
    [`refused from ${five}`, refusedIn(recent), 2],
    [`refused from ${fifteen}`, refusedIn(longer), 3],
    [`by tool from ${five}`, sums(recent), [{ tool: `core:${TOOL}`, count: 1 }, { tool: `core:${OTHER_TOOL}`, count: 1 }]],
    [`by tool from ${fifteen}`, sums(longer), [{ tool: `core:${TOOL}`, count: 2 }, { tool: `core:${OTHER_TOOL}`, count: 1 }]],
    ["the messages", data(step, longer.messages), groupsOf(longer).slice(0, 10)],
  ];
  for (const [what, found, expected] of expectations) if (!isDeepStrictEqual(found, expected)) fail(step, `${what} reads ${show(found)}, expected ${show(expected)}`);
  if (groupsOf(longer).some((x) => x.lastSeen === undefined) || groupsOf(longer).length !== 2) fail(step, `the groups read ${show(groupsOf(longer))}`);
  pass(`from ${five} the weeks count the two refusals of two days back and from ${fifteen} the three, by tool as the groups sum; ` +
    "the window starts at that date's first instant, the tiles stay the page's last whole week, and the messages are the largest groups");

  step = "activity_refusals in an initiative";
  const own = await read(step, member, "activityRefusals", { since: fifteen, initiative: s.one.initiative });
  if (refusedIn(own) !== 2 || !isDeepStrictEqual(sums(own), [{ tool: `core:${TOOL}`, count: 2 }])) fail(step, `the first team's initiative reads ${show(own)}`);
  const ghost = `2026-10-01-nobody-${randomBytes(4).toString("hex")}`;
  const foreign = await read(step, member, "activityRefusals", { since: fifteen, initiative: s.two.initiative });
  const nobody = await read(step, member, "activityRefusals", { since: fifteen, initiative: ghost });
  for (const [what, a] of [["the second team's initiative", foreign], ["a slug nobody has", nobody]] as [string, Obj][]) {
    if (!isDeepStrictEqual(a, { inputError: NO_INITIATIVE })) fail(step, `${what} reads ${show(a)}, not the initiative route's own not-found sentence`);
  }
  pass("the first team's initiative counts its two refusals of the tool and not the search's outside it; the second team's " +
    "initiative is refused exactly as a slug nobody has, in the initiative route's own not-found sentence, nothing counted");

  step = "activity_refusals keeps a failed read unavailable, never zero or none";
  // What a fault leaves the answer saying: last week's calls, the refused's owners, the tool refused most, the maintenance,
  // and whether the weeks, the groups and the refusals by tool were read.
  const said = (a: Obj) => {
    const t = a.tiles as { calls: { figure: unknown }; refused: { owners: unknown }; mostRefused: unknown };
    return [t.calls.figure, t.refused.owners, t.mostRefused, a.maintenance, ...["weeks", "groups", "byTool"].map((k) => (a[k] as Part).state)];
  };
  const pageTiles = page.tiles as { calls: { window: { from: string } }; mostRefused: unknown };
  // The weekly refusals read is the one statement over unnest's periods, asked here as the door asks the tool.
  const weekly = await g.failing((sql) => sql.includes("with ordinality as p(lo, hi, n)"), () => read(step, member, "activity_refusals", {}, true));
  const weeklyWant = [{ value: null, why: "unavailable" }, UNREAD, pageTiles.mostRefused, UNREAD, "unavailable", "ok", "ok"];
  if (!isDeepStrictEqual(said(weekly), weeklyWant)) fail(step, `the weekly read failing, it reads ${show(said(weekly))}, expected ${show(weeklyWant)}`);
  // Last week's refusals by tool is the grouping statement over the last whole week alone; from fifteen days back, the
  // groups and the refusals by tool span more.
  const lastFrom = pageTiles.calls.window.from;
  const byTool = await g.failing((sql, params) => sql.includes("as normalized") && params[1] === lastFrom,
    () => read(step, member, "activityRefusals", { since: fifteen }));
  const byToolWant = [(longer.tiles as Obj & { calls: { figure: unknown } }).calls.figure, (longer.tiles as Obj & { refused: { owners: unknown } }).refused.owners,
    UNREAD, longer.maintenance, "ok", "ok", "ok"];
  if (!isDeepStrictEqual(said(byTool), byToolWant)) fail(step, `last week's by-tool read failing, it reads ${show(said(byTool))}, expected ${show(byToolWant)}`);
  if ((longer.tiles as { mostRefused: Part }).mostRefused.state !== "ok" || (longer.maintenance as Part).state !== "ok") fail(step, `unfaulted, it reads ${show(said(longer))}`);
  pass("the weekly read failing, the tool answers last week's calls, the owners, the weeks and the maintenance unavailable and " +
    "the tool refused most as the page reads it; last week's by-tool read failing, the tool refused most is unavailable, never " +
    "none, and the calls, the owners and the maintenance are the unfaulted read's");

  step = "run_summary from a date";
  const runs = (a: Obj): number => ((a.tiles as Obj).runs as { value: number }).value;
  const all = await read(step, member, "runSummary");
  const lately = await read(step, member, "runSummary", { since: five });
  const tooledRuns = await read(step, member, "run_summary", {}, true);
  const seven = daysBack(7);
  if (runs(all) !== 2 || runs(lately) !== 1 || runs(await read(step, member, "runSummary", { since: fifteen })) !== 2
      || runs(tooledRuns) !== 1 || ((tooledRuns.meta as Obj).period as Obj).from !== await g.local(seven)) {
    fail(step, `all time ${runs(all)}, from ${five} ${runs(lately)}, the tool ${show(tooledRuns.meta)}`);
  }
  if (runs(await read(step, second, "runSummary", { since: fifteen })) !== 1) fail(step, "the second team's member reads other runs than its own");
  const tooledActivity = await read(step, member, "activity_refusals", {}, true);
  if (((tooledActivity.meta as Obj).period as Obj).from !== await g.local(seven)) fail(step, `the tool's activity window reads ${show(tooledActivity.meta)}`);
  pass(`from ${five} only the run of a day back is counted, from ${fifteen} both; the tools' own since is ${seven}, seven local ` +
    "days before the cutoff, for runs and activity alike; the second team's member reads its own run alone");

  step = "a date or an argument outside its bounds is an input error";
  const tomorrow = daysBack(-1);
  for (const fn of ["activityRefusals", "runSummary"]) {
    for (const since of ["2026-02-30", "yesterday", "2026-1-5", tomorrow, 20261005]) await refused(step, member, fn, { since }, "since");
  }
  await refused(step, member, "recordRead", { period: "week" }, "period");
  await refused(step, member, "runSummary", { limit: 101 }, "limit");
  pass(`2026-02-30, yesterday, 2026-1-5, ${tomorrow} and a number are input errors naming since on both; period week and limit 101 too`);

  step = "the first team's member reads none of the second team's sentinels";
  const words = [...Object.values(s.sentinels), theirs];
  const answers = [
    await read(step, member, "platformStatus", { tool: TOOL }), await read(step, member, "releaseList", { limit: 50 }),
    longer, own, all, await read(step, member, "recordRead"), tooledActivity, tooledRuns,
  ];
  const leaked = words.filter((x) => answers.some((a) => JSON.stringify(a).includes(x)));
  if (leaked.length) fail(step, `the member's answers hold ${show(leaked)}`);
  pass(`no answer of the five reads to the first team's member holds any of the second team's ${words.length} sentinels, its report's title among them`);
}

async function run(c: Core): Promise<void> {
  const s = await seedIsolation(c.sql);
  await seedWork(c.sql, s);
  const w = await seedWorkRecord(c, s);
  const theirs = await seedReads(c, s);
  // DELIBERATE: what zz-core wrote is stamped by the database's clock, which may run ahead of this process's;
  // every read here is cut at this process's clock, so the reads wait until both have passed the last write.
  const { rows: [clock] } = await c.sql.query<{ ms: number }>("select (extract(epoch from clock_timestamp()) * 1000)::float8 as ms");
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, clock.ms - Date.now()) + 1100));
  const g = await listen(c);
  try {
    await cases(s, w, theirs, g);
  } finally {
    await g.stop();
  }
}

process.exitCode = await withThrowawayCore(NAME, DONE, (c) => {
  fail = c.fail;
  return run(c);
});
