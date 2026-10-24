#!/usr/bin/env node
/**
 * checks/core-agent-reads.ts — the core door offers `platform_status`, `release_list`, `activity_refusals`,
 * `run_summary` and `record_read` to every caller, and answers each through the gateway's agent door, which
 * only zz-core may use (AC-7.1, AC-7.2, AC-7.3, AC-7.4, AC-7.5).
 *
 *   node checks/core-agent-reads.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL and a real zz-core on it (`withThrowawayCore`), seeds what
 * `scripts/schema/isolation-seed.ts` declares (`seedIsolation`, `seedWork`, `seedWorkRecord`) and beside it a
 * tool the doors register with a report on it from each team, releases, and refusals of each team, and mints
 * a platform token for each person who asks. It serves, from this process, the gateway's built agent door,
 * identity middleware, JSON parser, console and core-door relay in server.ts's order, with the agent door
 * answering the loopback (`localhost`); and beside it two agent doors that answer nobody here, one naming a
 * host that does not resolve and one left to `CORE_PEERS`' default, `zz-core`. zz-core is restarted with
 * `GATEWAY_INTERNAL_URL` pointed at each in turn. What it establishes:
 *
 *   - `deploy/Caddyfile`'s `api.` site answers `/internal/*` with 404 before its proxy, and no site hands
 *     `/internal/*` to the gateway;
 *   - with the gateway unreachable, or an agent door that does not trust zz-core, each tool answers an ERROR
 *     saying the read is unavailable, with no structured content;
 *   - a door that does not trust the caller refuses 403 before anything is read: with forged identity headers
 *     naming a real member or with none, an unknown tool and a body that is not JSON alike;
 *   - the trusted door refuses headers naming no active principal (403), answers 404 for a tool it does not
 *     serve, `constructor` among them, 400 for arguments that are not an object, and an input error as
 *     400 with the read's own sentence;
 *   - `tools/list` on `/core/mcp` names all five reads, each declared a read (`readOnlyHint`) and none taking a
 *     `team` or a `scope`, to the first team's member, the second team's member and a superadmin;
 *   - for the first team's member, the second team's member, a superadmin acting for the first team, the same
 *     superadmin's token bound to that team, a superadmin in no team and a member of both teams whose stored
 *     team is not the first, each read's structured content equals what the gateway's function answers that
 *     person (their email, their role through `isSuper` and their team as the platform decides it), its
 *     instants masked and `platform_status`'s doors without their days; each text part is the JSON of its
 *     structured content; an input error, and a Work read to a caller in no team, is the function's sentence
 *     in the tool's `ERROR` form, with no structured content;
 *   - the bound token reads as a member (its status differs from the unbound token's), the member of both
 *     teams reads for the team `session_whoami` says it acts for (and its reads differ from the other team's);
 *     the unbound superadmin's status and record equal the console routes' answers to the same token, which
 *     a member's token may not read;
 *   - a `team`, a `scope` or any argument a tool does not declare, and forged identity headers on the core
 *     door, widen nothing: each answer equals the call without them;
 *   - no answer to the first team's member holds any of the second team's sentinels, in either half.
 *
 * DELIBERATE: the reporting timezone is Asia/Singapore, and an answer is compared with the function's read a
 * moment later; a run that crosses local midnight between the two fails on a date. Run it again.
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
import { isDeepStrictEqual } from "node:util";

import { mintPat } from "@zz/contracts";
import { Mcp } from "@zz/mcp-client";
import type { Express, Request, RequestHandler, Response } from "express";
import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import { seedIsolation, seedWork, seedWorkRecord, type Isolation, type WorkRecord } from "../scripts/schema/isolation-seed.ts";
import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";

const NAME = "core-agent-reads";
const DONE = "core-agent-reads: the core door lists platform_status, release_list, activity_refusals, run_summary " +
  "and record_read to every caller as reads taking no team, answers each with the gateway function's answer to that " +
  "person as structured content and its JSON text, widens nothing for an undeclared argument or a forged header, " +
  "leaks no second team's sentinel to a member, and reaches the gateway through an agent door that answers zz-core " +
  "alone and that Caddy refuses from outside: ok";
const TIMEZONE = "Asia/Singapore";
const READ_TOOLS = ["platform_status", "release_list", "activity_refusals", "run_summary", "record_read"];
/** What each read declares, as a client lists it. */
const DECLARED: Record<string, string[]> = {
  platform_status: ["tool"], release_list: ["limit", "since"], activity_refusals: ["initiative", "since"],
  run_summary: ["since", "skill"], record_read: ["period"],
};
/** A tool the doors register, the surface the reports are filed on. */
const TOOL = "document_write";
const DAY = 86_400_000;

type Obj = Record<string, unknown>;
type Caller = { email: string; superadmin: boolean; activeTeam: string | null };
type Who = { label: string; pat: string; caller: Caller };
type Answer = { text: string; parts: number; structured: Obj | undefined };
type Read = (caller: Caller, args: Obj) => Promise<Obj>;

/** The harness's own failure, set once it starts: the case and what was found. */
let fail: Core["fail"] = (step, detail) => { throw new Error(`${step}: ${detail}`); };
const pass = (line: string): void => console.log(`  ok  ${line}`);
const show = (v: unknown): string => JSON.stringify(v).slice(0, 600);
/** The fields that describe the REQUEST rather than the figures. A console route fills them; the agent read
 *  that answers from the same function has no request of its own to describe, so the two legitimately differ
 *  in exactly these five and in nothing else. */
const REQUEST_SCOPED = ["observedAt", "cacheHit", "revision", "builtAt", "sourceRevision"];

/** An answer with every instant masked and the request-scoped fields removed: what is left is what it says. */
const masked = (v: unknown): string => {
  const strip = (o: unknown): unknown => {
    if (Array.isArray(o)) return o.map(strip);
    if (o && typeof o === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(o as Record<string, unknown>)) {
        if (REQUEST_SCOPED.includes(k)) continue;
        out[k] = strip(x);
      }
      return out;
    }
    return o;
  };
  return JSON.stringify(strip(v)).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<instant>");
};
const without = (o: Obj, ...keys: string[]): Obj => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
/** Status as the tool answers it: each door without its days. */
function daysOff(status: Obj): Obj {
  const doors = status.doors as { state: string; data?: Obj[] };
  return doors.state === "ok" ? { ...status, doors: { ...doors, data: doors.data!.map((d) => without(d, "days")) } } : status;
}
/** The local date `n` days before today in the reporting timezone. */
const daysBack = (n: number): string => new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(new Date(Date.now() - n * DAY));

/** `deploy/Caddyfile`, read: the api site answers /internal/* with 404 ahead of its proxy. */
function caddy(): void {
  const step = "Caddy refuses the agent door from outside";
  const file = readFileSync(join(root, "deploy/Caddyfile"), "utf8");
  const code = (text: string): string => text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  const api = code(/^api\.[^\s{]*\s*\{([\s\S]*?)^\}/m.exec(file)?.[1] ?? "");
  const refuse = /^\s*respond\s+\/internal\/\*\s+404\s*$/m.exec(api);
  const proxy = /^\s*reverse_proxy\b/m.exec(api);
  if (!proxy) fail(step, "deploy/Caddyfile has no api site with a reverse_proxy");
  if (!refuse || refuse.index > proxy!.index) fail(step, `the api site does not answer /internal/* with 404 before its proxy: ${show(api.slice(0, 400))}`);
  if (/^\s*handle\s+\/internal\b/m.test(code(file))) fail(step, "a site hands /internal/* to a handler of its own");
  pass("deploy/Caddyfile's api site answers `respond /internal/* 404` ahead of its reverse_proxy, and no site hands /internal/* on");
}

/** Beside the seed's rows: a tool the doors register with one open report on it from each team, releases,
 *  refusals of each team, a stored team for the person in both that is not the first of theirs, and a token
 *  for each person who asks. Answers the second team's words, sentinels of their own, and the tokens. */
async function seedReads(c: Core, s: Isolation, w: WorkRecord) {
  const sql = c.sql;
  const { rows: [v] } = await sql.query<{ id: string }>(
    `with p as (insert into zz.plugin (name, origin) values ('core-agent-reads-doors', 'platform') returning id)
     insert into zz.plugin_version (plugin_id, version, digest) select id, '1.0.0', 'sha256:core-agent-reads' from p returning id::text as id`);
  await sql.query("insert into zz.plugin_tool (plugin_version_id, name, door) values ($1, $2, 'core')", [v.id, TOOL]);
  const theirs = { report: `report-${randomBytes(8).toString("hex")}`, refusal: `refusal-${randomBytes(8).toString("hex")}` };
  const report = (email: string, title: string) =>
    c.ok(`report ${title}`, "bug_report", { title, detail: `${title}, in detail`, surface: TOOL, impact: "blocks_work" }, c.client({ email }));
  await report(s.one.email, "the first team's write refused");
  await report(s.two.email, theirs.report);
  for (const [back, version] of [[20, "0.20.0"], [10, "0.21.0"], [2, "0.22.0"]] as [number, string][]) {
    await sql.query(
      `insert into zz.release (version, console_version, released_at, summary, changelog, upgrade_notes, client_action)
       values ($1, null, date_trunc('second', now()) - $2 * interval '1 day', $3, $4, $5, null)`,
      [version, back, `Release ${version}`, `## ${version}`, `Upgrade to ${version}.`]);
  }
  const refuse = (team: Isolation["one"], days: number, message: string) => sql.query(
    `insert into zz.event (ts, kind, subject, tool_key, ok, refusal, refusal_owner, origin, detail, team_id, actor_id, duration_ms)
     select now() - $1 * interval '1 day', 'tool_call', $2, $2, false, $3, 'ours', 'work', '{}'::jsonb, t.id, p.id, 40
       from zz.team t, zz.principal p where t.slug = $4 and p.email = $5`, [days, `core:${TOOL}`, message, team.slug, team.email]);
  await refuse(s.one, 1, "ERROR: SECTION_MISSING — the plan has no Phases");
  await refuse(s.one, 3, "ERROR: SECTION_MISSING — the plan has no Phases");
  await refuse(s.two, 1, `ERROR: ${theirs.refusal}`);
  // Stored in the first team, which sorts after the second: the fallback would pick the other one.
  await sql.query("update zz.principal set active_team_id = (select id from zz.team where slug = $2) where email = $1", [s.both, s.one.slug]);
  const token = async (email: string, label: string, team: string | null = null): Promise<string> => {
    const pat = mintPat();
    await sql.query(
      `insert into zz.pat (principal_id, token_hash, label, team_id)
       select p.id, $2, $3, (select id from zz.team where slug = $4) from zz.principal p where p.email = $1`,
      [email, createHash("sha256").update(pat).digest("hex"), label, team]);
    return pat;
  };
  const who = (label: string, pat: string, email: string, superadmin: boolean, activeTeam: string | null): Who =>
    ({ label, pat, caller: { email, superadmin, activeTeam } });
  const people = {
    member: who("the first team's member", await token(s.one.email, "agent reads"), s.one.email, false, s.one.slug),
    second: who("the second team's member", await token(s.two.email, "agent reads"), s.two.email, false, s.two.slug),
    acting: who("the superadmin acting for the first team", await token(w.acting, "agent reads"), w.acting, true, s.one.slug),
    bound: who("the same superadmin's token bound to the first team", await token(w.acting, "agent reads, bound", s.one.slug), w.acting, false, s.one.slug),
    loner: who("the superadmin in no team", await token(s.superadmin, "agent reads"), s.superadmin, true, null),
    both: who("the member of both teams stored in the first", await token(s.both, "agent reads"), s.both, false, s.one.slug),
  };
  return { theirs, people };
}

/** The gateway as server.ts mounts it, and the two doors that answer nobody here. */
async function listen(c: Core) {
  process.env.TEAM_DB_URL = c.url;
  process.env.ZZ_TZ = TIMEZONE;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  process.env.GATEWAY_PUBLIC_URL = "https://gateway.core-agent-reads.example.test";
  const load = (p: string) => import(pathToFileURL(join(root, "services/gateway/dist", p)).href);
  const express = (await import("express")).default;
  const db = (await load("db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await db.initPlatformDb();
  const { identityMiddleware } = (await load("identity.js")) as { identityMiddleware: () => RequestHandler };
  const { mountConsole } = (await load("console.js")) as { mountConsole: (app: Express) => void };
  const { passThrough } = (await load("relay.js")) as { passThrough: (url: string, what: string, refusal: string) => (req: Request, res: Response) => void };
  const { mountAgentDoor } = (await load("agent-door.js")) as { mountAgentDoor: (app: Express, peers?: string[]) => void };
  const { AGENT_READS } = (await load("console/agent-reads.js")) as { AGENT_READS: Record<string, Read> };
  const servers: Server[] = [];
  const serve = async (app: Express): Promise<string> => {
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  };
  // COUPLED: services/gateway/src/server.ts — the agent door outside the identity gate, then the gate, the
  // JSON parser, the console's reads and the core door's relay. The relay follows zz-core across restarts.
  const app = express();
  mountAgentDoor(app, ["localhost"]);
  app.use(identityMiddleware());
  app.use(express.json({ limit: "20mb" }));
  mountConsole(app);
  app.all("/core/mcp", (req, res) => passThrough(c.mcp.url, "core proxy", "zz-core is not reachable")(req, res));
  const nowhere = express();
  mountAgentDoor(nowhere, ["nothing.invalid"]);
  const unset = express();
  mountAgentDoor(unset);
  return {
    base: await serve(app), nowhere: await serve(nowhere), unset: await serve(unset), reads: AGENT_READS,
    stop: async () => {
      for (const server of servers) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      await db.platformDb().end().catch(() => undefined);
      for (const k of ["TEAM_DB_URL", "ZZ_TZ", "ZZ_CATALOG_DIR", "GATEWAY_PUBLIC_URL", "GATEWAY_INTERNAL_URL"]) delete process.env[k];
    },
  };
}
type Gateway = Awaited<ReturnType<typeof listen>>;

/** One tools/call, both halves of its answer. */
async function callOn(step: string, mcp: Mcp, tool: string, args: Obj): Promise<Answer> {
  const env = await mcp.rpc("tools/call", { name: tool, arguments: args });
  if (env.error) fail(step, `${tool}(${show(args)}) answered the error ${show(env.error)}`);
  const result = env.result as { content?: { type: string; text?: string }[]; structuredContent?: Obj };
  return { text: (result.content ?? []).map((p) => p.text ?? "").join("\n"), parts: result.content?.length ?? 0, structured: result.structuredContent };
}

/** A POST to an agent door, as the check's own peer. */
async function post(base: string, tool: string, body: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Obj }> {
  const res = await fetch(`${base}/internal/agent-read/${tool}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) as Obj }; } catch { return { status: res.status, body: { text } }; }
}

/** Each read, as a zz-core client of the first team's member, answers an ERROR saying it is unavailable. */
async function unavailable(c: Core, s: Isolation, step: string, why: string): Promise<void> {
  const mcp = c.client({ email: s.one.email });
  for (const tool of READ_TOOLS) {
    const a = await callOn(step, mcp, tool, {});
    if (!/^ERROR: \S+ is unavailable right now/.test(a.text) || a.structured !== undefined) fail(step, `${tool} answered ${show(a)}`);
  }
  pass(`${why}: each read answers an ERROR saying it is unavailable, with no structured content`);
}

async function doors(s: Isolation, g: Gateway): Promise<void> {
  let step = "a door that does not trust the caller refuses it before anything is read";
  const forged = { "x-zz-user-email": s.one.email, "x-zz-user-role": "admin", "x-zz-via": "pat", "x-zz-pat-team": "", "x-zz-session-team": "" };
  for (const [label, base] of [["naming nothing.invalid", g.nowhere], ["left to CORE_PEERS' default", g.unset]]) {
    for (const [what, tool, body, headers] of [
      ["forged headers naming the first team's member", "platform_status", '{"arguments":{}}', forged],
      ["no identity headers", "platform_status", '{"arguments":{}}', {}],
      ["a tool it does not serve", "constructor", '{"arguments":{}}', forged],
      ["a body that is not JSON", "release_list", "{not json", forged],
    ] as [string, string, string, Record<string, string>][]) {
      const a = await post(base, tool, body, headers);
      if (a.status !== 403 || a.body.error !== "not a trusted caller") fail(step, `the door ${label}, given ${what}, answered ${a.status} ${show(a.body)}`);
    }
  }
  pass("the doors naming nothing.invalid and left to the default zz-core answer 403 \"not a trusted caller\" to forged headers " +
    "naming a real member, to no headers, to a tool they do not serve and to a body that is not JSON: the peer is refused first");

  step = "the trusted door's own refusals";
  const asMember = { ...forged, "x-zz-user-role": "user" };
  const cases: [string, string, string, Record<string, string>, number, (b: Obj) => boolean][] = [
    ["no identity headers", "platform_status", '{"arguments":{}}', {}, 403, (b) => /no active principal/.test(String(b.error))],
    ["an address nobody holds", "platform_status", '{"arguments":{}}', { ...asMember, "x-zz-user-email": "nobody@core-agent-reads.example.test" }, 403, (b) => /no active principal/.test(String(b.error))],
    ["a tool it does not serve", "release_notes", '{"arguments":{}}', asMember, 404, (b) => /no agent read/.test(String(b.error))],
    ["constructor", "constructor", '{"arguments":{}}', asMember, 404, (b) => /no agent read/.test(String(b.error))],
    ["arguments that are a list", "release_list", '{"arguments":[]}', asMember, 400, (b) => b.error === "arguments must be an object"],
    ["an unknown release", "release_list", '{"arguments":{"since":"9.9.9"}}', asMember, 400, (b) => /^since names no recorded release/.test(String(b.error))],
  ];
  for (const [what, tool, body, headers, status, ok] of cases) {
    const a = await post(g.base, tool, body, headers);
    if (a.status !== status || !ok(a.body)) fail(step, `given ${what}, it answered ${a.status} ${show(a.body)}`);
  }
  pass("the door trusting the loopback answers 403 to headers naming no active principal, 404 to a tool it does not serve " +
    "(constructor too), 400 to arguments that are not an object, and an input error as 400 with the read's own sentence");
}

async function cases(s: Isolation, seeded: Awaited<ReturnType<typeof seedReads>>, g: Gateway): Promise<void> {
  const { people, theirs } = seeded;
  const clients = new Map<string, Mcp>();
  const mcpOf = (who: Who, headers: Record<string, string> = {}): Mcp => {
    const key = `${who.label}${JSON.stringify(headers)}`;
    if (!clients.has(key)) clients.set(key, new Mcp(`${g.base}/core/mcp`, { client: NAME, pat: who.pat, headers, timeoutMs: 60_000 }));
    return clients.get(key)!;
  };
  const call = (step: string, who: Who, tool: string, args: Obj, headers?: Record<string, string>) => callOn(step, mcpOf(who, headers), tool, args);
  /** What the gateway's function answers this caller, as the tool would carry it. */
  const expected = async (tool: string, caller: Caller, args: Obj): Promise<Obj> => {
    const a = await g.reads[tool](caller, args);
    return "inputError" in a || tool !== "platform_status" ? a : daysOff(a);
  };
  /** The tool's answer equals the function's, in both halves; answers the structured half. */
  const holds = async (step: string, who: Who, tool: string, args: Obj, headers?: Record<string, string>): Promise<Answer> => {
    const a = await call(step, who, tool, args, headers);
    const want = await expected(tool, who.caller, args);
    if ("inputError" in want) {
      if (a.text !== `ERROR: ${String(want.inputError)}` || a.structured !== undefined) fail(step, `${tool}(${show(args)}) as ${who.label} answered ${show(a)}, the function ${show(want)}`);
      return a;
    }
    if (a.structured === undefined || a.parts !== 1) fail(step, `${tool}(${show(args)}) as ${who.label} answered ${show(a.text)} with ${a.parts} part(s) and no structured content`);
    if (a.text !== JSON.stringify(a.structured)) fail(step, `${tool}(${show(args)}) as ${who.label}: the text part is not the JSON of the structured content`);
    if (masked(a.structured) !== masked(want)) {
      const k = Object.keys(want).find((x) => masked(a.structured![x]) !== masked(want[x])) ?? "(the keys)";
      fail(step, `${tool}(${show(args)}) as ${who.label}: ${k} reads ${masked(a.structured![k]).slice(0, 400)} where the function reads ${masked(want[k]).slice(0, 400)}`);
    }
    return a;
  };

  let step = "tools/list names the reads to every caller";
  for (const who of [people.member, people.second, people.acting]) {
    const tools = (await mcpOf(who).tools()) as { name: string; annotations?: { readOnlyHint?: boolean }; inputSchema?: { properties?: Obj } }[];
    for (const name of READ_TOOLS) {
      const t = tools.find((x) => x.name === name);
      const args = Object.keys(t?.inputSchema?.properties ?? {}).sort();
      if (!t) fail(step, `${who.label} is not offered ${name}`);
      if (t.annotations?.readOnlyHint !== true) fail(step, `${name} is not declared a read: ${show(t.annotations)}`);
      if (!isDeepStrictEqual(args, DECLARED[name])) fail(step, `${name} takes ${show(args)} for ${who.label}, not ${show(DECLARED[name])}`);
    }
  }
  pass(`${READ_TOOLS.join(", ")} are listed on /core/mcp to the first team's member, the second team's member and the ` +
    "acting superadmin, each with readOnlyHint and its own arguments only, none of them a team or a scope");

  step = "each read answers what the gateway's function answers the same person";
  const asked: [string, Obj][] = [
    ["platform_status", {}], ["platform_status", { tool: TOOL }], ["release_list", {}], ["release_list", { limit: 2, since: "0.20.0" }],
    ["activity_refusals", {}], ["activity_refusals", { since: daysBack(2) }], ["run_summary", {}], ["record_read", {}], ["record_read", { period: "quarter" }],
  ];
  const memberAnswers: Answer[] = [];
  for (const who of Object.values(people)) {
    for (const [tool, args] of asked) {
      const a = await holds(step, who, tool, args);
      if (who === people.member) memberAnswers.push(a);
    }
  }
  const tooled = (await call(step, people.member, "platform_status", { tool: TOOL })).structured!.bugs as { state: string; data: { count: number; rows: Obj[] } };
  if (tooled.state !== "ok" || tooled.data.count !== 2) fail(step, `platform_status with ${TOOL} reads ${show(tooled)}, not both teams' open reports`);
  const doorRows = ((await call(step, people.member, "platform_status", {})).structured!.doors as { data: Obj[] }).data;
  if (doorRows.some((d) => "days" in d || !("totals" in d) || !("run" in d) || !("finding" in d))) fail(step, `the doors read ${show(doorRows[0])}`);
  pass(`${asked.map(([t, a]) => `${t}(${JSON.stringify(a)})`).join(", ")} each equal, instants masked, the function's answer to ` +
    `${Object.values(people).map((w) => w.label).join(", ")}; each text part is its structured content's JSON, and ` +
    "platform_status's doors keep their totals, run and finding without their days");

  step = "an input error is the read's own sentence, in the tool's ERROR form";
  const errors: [Who, string, Obj][] = [
    [people.member, "platform_status", { tool: "not-a-tool" }], [people.member, "release_list", { since: "9.9.9" }],
    [people.member, "release_list", { limit: 51 }], [people.member, "activity_refusals", { since: "2026-02-30" }],
    [people.member, "run_summary", { since: daysBack(-1) }], [people.member, "record_read", { period: "week" }],
    [people.loner, "activity_refusals", {}], [people.loner, "run_summary", {}], [people.loner, "record_read", {}],
  ];
  for (const [who, tool, args] of errors) {
    if (!("inputError" in (await expected(tool, who.caller, args)))) fail(step, `${tool}(${show(args)}) is no input error to ${who.label}, so this case asks nothing`);
    await holds(step, who, tool, args);
  }
  pass("an unknown tool, an unknown release, a limit of 51, a malformed and a future date and the period week, and the Work " +
    "reads to the superadmin in no team, each answer ERROR: and the function's sentence, with no structured content");

  step = "the role and the team are the platform's";
  const status = async (superadmin: boolean) => masked(await expected("platform_status", { ...people.acting.caller, superadmin }, {}));
  if (await status(true) === await status(false)) fail(step, "the superadmin's status reads as a member's here, so the bound token's case asks nothing");
  const whoami = JSON.parse(await (mcpOf(people.both)).call("session_whoami", {})) as { team?: string };
  if (whoami.team !== s.one.slug || !(s.two.slug < s.one.slug)) fail(step, `session_whoami tells the member of both teams it acts for ${show(whoami.team)}, the teams sorting ${show([s.two.slug, s.one.slug].sort())}`);
  const otherTeam = await expected("activity_refusals", { ...people.both.caller, activeTeam: s.two.slug }, {});
  if (masked(otherTeam) === masked(await expected("activity_refusals", people.both.caller, {}))) fail(step, "both teams' refusals read alike, so the stored team's case asks nothing");
  const route = async (url: string, who: Who): Promise<{ status: number; body: Obj }> => {
    const res = await fetch(`${g.base}${url}`, { headers: { authorization: `Bearer ${who.pat}` } });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Obj };
  };
  for (const [tool, url] of [["platform_status", "/api/console/platform/status"], ["record_read", "/api/console/record"]]) {
    const page = await route(url, people.acting);
    const a = await call(step, people.acting, tool, {});
    if (page.status !== 200 || masked(a.structured) !== masked(tool === "platform_status" ? daysOff(page.body) : page.body)) {
      fail(step, `${tool} as ${people.acting.label} reads ${masked(a.structured).slice(0, 300)} where ${url} answers ${page.status} ${masked(page.body).slice(0, 300)}`);
    }
    if ((await route(url, people.member)).status !== 403) fail(step, `${url} answers the first team's member's token`);
  }
  pass("the bound token reads as a member where the unbound one reads as the superadmin, the two statuses differing; the member " +
    `of both teams acts for ${s.one.slug}, the team session_whoami names and not the first of theirs, whose refusals differ; ` +
    "the acting superadmin's status and record equal the console routes' answers to the same token, which refuse a member's");

  step = "an undeclared argument or a forged header widens nothing";
  const widen = { team: s.two.slug, scope: "platform", everyone: true };
  const forged = { "x-zz-user-email": s.two.email, "x-zz-user-role": "admin", "x-zz-pat-team": s.two.slug, "x-zz-session-team": s.two.slug };
  for (const [tool, args] of asked) {
    const plain = await call(step, people.member, tool, args);
    for (const [what, a] of [["the extra arguments", await call(step, people.member, tool, { ...args, ...widen })],
                             ["the forged headers", await call(step, people.member, tool, args, forged)]] as [string, Answer][]) {
      if (masked(a.structured) !== masked(plain.structured) || a.structured === undefined) fail(step, `${tool}(${show(args)}) with ${what} reads ${masked(a.structured).slice(0, 300)}, without ${masked(plain.structured).slice(0, 300)}`);
      memberAnswers.push(a);
    }
  }
  pass(`team ${s.two.slug.slice(0, 12)}…, scope platform and an argument no read declares, and identity headers naming the ` +
    "second team's member as an admin of it, leave every read's answer to the first team's member as it was");

  step = "the first team's member reads none of the second team's sentinels";
  const words = [...Object.values(s.sentinels), theirs.report, theirs.refusal];
  const leaked = words.filter((x) => memberAnswers.some((a) => a.text.includes(x) || JSON.stringify(a.structured ?? {}).includes(x)));
  if (leaked.length) fail(step, `the member's answers hold ${show(leaked)}`);
  if (!memberAnswers.some((a) => a.text.includes("SECTION_MISSING"))) fail(step, "no answer holds the member's own refusal, so the sweep read nothing");
  pass(`no answer to the first team's member, in its text or its structured content, holds any of the second team's ${words.length} words, ` +
    "its report's title and its refusal among them");
}

async function run(c: Core): Promise<void> {
  fail = c.fail;
  caddy();
  const s = await seedIsolation(c.sql);
  await seedWork(c.sql, s);
  const w = await seedWorkRecord(c, s);
  const seeded = await seedReads(c, s, w);
  await unavailable(c, s, "the gateway unreachable", "with GATEWAY_INTERNAL_URL left to http://cred-proxy:8000, which does not resolve here");
  // DELIBERATE: what zz-core wrote is stamped by the database's clock, which may run ahead of this process's;
  // every read here is cut at this process's clock, so the reads wait until both have passed the last write.
  const { rows: [clock] } = await c.sql.query<{ ms: number }>("select (extract(epoch from clock_timestamp()) * 1000)::float8 as ms");
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, clock.ms - Date.now()) + 1100));
  const g = await listen(c);
  try {
    process.env.GATEWAY_INTERNAL_URL = g.nowhere;
    await c.restart();
    await unavailable(c, s, "an agent door that does not trust zz-core", "with GATEWAY_INTERNAL_URL at a door naming nothing.invalid");
    await doors(s, g);
    process.env.GATEWAY_INTERNAL_URL = g.base;
    await c.restart();
    await cases(s, seeded, g);
  } finally {
    await g.stop();
  }
}

process.exitCode = await withThrowawayCore(NAME, DONE, run);
