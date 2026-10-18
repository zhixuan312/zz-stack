#!/usr/bin/env node
/**
 * checks/console-work-record.ts — Record is read for the active team at one cutoff: the retained text's
 * estimate as of it, the period's work, and the record of every initiative, the approvals in it the
 * caller's alone (AC-5.3, AC-5.4).
 *
 *   node checks/console-work-record.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL and a real zz-core on it (`withThrowawayCore`), and the gateway's own
 * built door in this process (the identity gate, the JSON parser, the tool-call telemetry and the relay,
 * in the order server.ts mounts them), so a document a person's session (`zz-plugin`) or a maintenance
 * client (`zz-migrate`) writes through it leaves the rows the import rule reads, and one written to
 * zz-core directly leaves none and is unrecorded. The record is made in phases, each moved, together and
 * by one interval, into the week and hour it names; a search and a run are written as rows. It calls the
 * gateway's own built route (`services/gateway/dist/console/record.js`) the way Express would, for each
 * period. What it establishes, the expected values written below as what each phase made:
 *
 *   - the period starts at the quarter's first day, at 1 January, or at the team's first initiative, in
 *     the reporting timezone, and activity is `[start, cutoff)`, at weeks up to 26 of them and months
 *     beyond, so a year answers months once it is longer than that;
 *   - the lead is the eligible retained words as of the cutoff at 500 words an hour, basis
 *     `retained_stock`, marked as of the cutoff, the same in every period: the known words, with the
 *     import-made and the unrecorded document in the coverage beside them;
 *   - the cumulative words added; the foot: work closed of opened, flow documents and versions, and the
 *     approvals in the caller's name;
 *   - Work: closed by outcome, most open at once (`mostOpenAtOnce`'s own), the median hours to close and
 *     until abandoned work stopped, closures in all, closures and the median hours to close by period, a
 *     typical piece of work; Documents: flow documents, versions, the median and largest sources under a
 *     gated document, citations, words added by period, the most rewritten documents, the coverage;
 *   - Knowledge, Your agents, and Firsts and bests are `knowledgeSlice`'s, `agentsSlice`'s and
 *     `firstsSlice`'s at the same cutoff: Knowledge over the period's window counted from the later of
 *     its start and the team's first initiative, Your agents over the window from that instant, and
 *     Firsts and bests over the window;
 *   - the record: every initiative newest first, paged, with its outcome, hours, documents and lessons,
 *     and the summary by outcome and by flow over all of them;
 *   - the population says team history from before the caller joined; a second person reads none of the
 *     first's approvals as theirs and the same estimate;
 *   - the answer carries what Copy as text copies (scope, cutoff, coverage, basis, pace) and nothing of
 *     weekends, days off, hours saved, a speedup or productivity;
 *   - each part fails alone; a person in no team, an unknown period and a bad page are refused; reading
 *     records no event; the key sets match the console's fake answer.
 *
 * It prints how long one whole read took: the throwaway's record is small, so the number is a floor.
 *
 * DELIBERATE: the reporting timezone is Asia/Singapore, eight hours ahead of UTC with no daylight saving.
 * The quarter and the year move with the calendar, so which phases a period holds is decided against the
 * period's start the answer states, after that start is itself checked; every phase is at least ten hours
 * past a local midnight, so no phase sits on a period's edge.
 *
 * DELIBERATE: the population names the local date the caller joined, which the throwaway stamps when it
 * seeds, and the check compares it with the local date it reads; a run that crosses local midnight between
 * the two, a few seconds a day, fails on that date. Run it again.
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
import { TIMEZONE, WEEK, at, runningWeek, type When } from "../scripts/schema/work-seed.ts";

const NAME = "console-work-record";
const DONE = "console-work-record: Record reads the retained text as of the cutoff, the same in every period, beside the period's " +
  "work in six slices and the record of every initiative, each part failing alone: ok";
/** COUPLED: the fake answer in the console's checkout, `../zz-stack-dashboard` here and in CI. */
const FAKE = join(root, "..", "zz-stack-dashboard", "scripts", "fake-gateway", "work-record.ts");

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
/** The words of EXPLORE, SPEC and LESSON, as the contracts count them. */
const FLOW_WORDS = 11 + 91, LESSON_WORDS = 21;
const LESSON = "Close a piece of work only after the person who asked for it has read what the agents wrote for them.";

type Obj = Record<string, unknown>;
type Route = (req: unknown, res: unknown) => void;
type Who = { email: string; team: string | null };
type Span = { from: string; to: string };
type Win = { from: string; to: string; observedFrom: string | null; observedThrough: string | null; complete: boolean };
type Fig = { value: number | null; why: string | null };
type PF = { window: Win; figure: Fig; numerator: number | null; denominator: number | null };
type Part = { state: string; data?: Obj; reason?: string };
type Slice = (team: string, window: Span, asOf: string) => Promise<Obj>;
interface Gateway {
  url: string; token: string; record: Route;
  slices: { knowledgeSlice: (team: string, window: Span, asOf: string, countFrom?: string) => Promise<Obj>; agentsSlice: Slice; firstsSlice: Slice };
  mostOpenAtOnce(team: string, window: Span, asOf: string): Promise<Obj>;
  stop(): Promise<void>;
}

/** What the record holds, each item at the phase that made it. A closure: opened, closed, outcome, and what a
 *  typical piece of work reads of it (documents, versions, sources, words). */
const CLOSES: { key: string; opened: When; closed: When; outcome: string; typical: [number, number, number, number] }[] = [
  { key: "old", opened: [50, 10], closed: [49, 10], outcome: "accepted", typical: [1, 1, 0, 100] },
  { key: "mid", opened: [20, 10], closed: [19, 34], outcome: "abandoned", typical: [2, 2, 0, FLOW_WORDS] },
  { key: "done", opened: [2, 10], closed: [1, 10], outcome: "accepted", typical: [1, 2, 1, 350] },
];
const OPENED: When[] = [[50, 10], [20, 10], [3, 10], [3, 20], [2, 10]];
/** The eligible flow documents created, and every revision of them, with the document it is of. */
const DOCS: When[] = [[50, 10], [20, 10], [20, 10], [3, 10], [3, 10], [2, 10]];
const VERSIONS: [string, When][] = [["old", [50, 10]], ["mid/explore", [20, 10]], ["mid/spec", [20, 10]], ["recent/explore", [3, 10]],
  ["recent/spec", [3, 10]], ["done", [2, 10]], ["done", [2, 30]]];
/** The words added: the documents' net additions and the lesson. */
const ADDED: [number, When][] = [[100, [50, 10]], [FLOW_WORDS, [20, 10]], [FLOW_WORDS + LESSON_WORDS, [3, 10]], [300, [2, 10]], [50, [2, 30]]];
const APPROVALS: When[] = [[49, 10], [1, 10], [1, 10]];
/** The gated documents created, mid's spec and recent's, with the sources under each. */
const GATED: [number, When][] = [[0, [20, 10]], [2, [3, 10]]];
/** The citations: each of the three sources cites the revision it bears on, from when it was registered. */
const CITES: When[] = [[3, 10], [3, 10], [2, 10]];
/** The words retained, every eligible document's latest and the lesson. */
const RETAINED = 100 + FLOW_WORDS + FLOW_WORDS + LESSON_WORDS + 350;
/** What the retained text was counted over: eight flow documents of nine revisions, one import-made, one unrecorded. */
const COVERAGE = { documents: 8, revisions: 9, importMade: 1, unrecorded: 1, mixed: 0, datedByLastWrite: 0, undated: 0, missingLegacy: 0 };

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const show = (v: unknown): string => JSON.stringify(v).slice(0, 900);
/** Its value with every object's keys in order: an answer's key order is no part of its contract. */
const canonical = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canonical)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Obj)[k])])) : v;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
/** A local date, YYYY-MM-DD; and a local instant as "Mon, YYYY-MM-DD, HH:MM". */
const dateOf = (ms: number): string => new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(new Date(ms));
const stamp = (ms: number): string => new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" }).format(new Date(ms));
const counted = (value: number) => ({ value, why: null });
/** `n` words: a heading of two, then `tag` words, twenty to a line. */
function text(n: number, tag: string): string {
  const words = Array.from({ length: n - 2 }, (_, i) => (i === 0 ? `${tag}-start` : tag));
  const lines: string[] = [];
  for (let i = 0; i < words.length; i += 20) lines.push(words.slice(i, i + 20).join(" "));
  return `# ${tag}\n\n${lines.join("\n")}\n`;
}
function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b), mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Where two answers' shapes differ: at an object both hold, the key sets; at an array both hold, the first elements,
 *  the same way; a null on either side, nothing. */
function shapeDiffs(a: unknown, b: unknown, path: string, out: string[]): string[] {
  if (a === null || b === null) return out;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length && b.length) shapeDiffs(a[0], b[0], `${path}[0]`, out);
    else if (a.length !== b.length) out.push(`${path} is empty on one side, so its elements were not compared`);
  } else if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    if (ka.join() !== kb.join()) out.push(`${path || "the answer"} has keys {${ka.join(", ")}} where the fake has {${kb.join(", ")}}`);
    for (const k of ka.filter((x) => kb.includes(x))) shapeDiffs(a[k], b[k], path ? `${path}.${k}` : k, out);
  }
  return out;
}

/** The request a console session's read arrives as, past the gateway's middleware (COUPLED: identity.ts). */
function request(who: Who, query: Obj): Obj {
  return {
    params: {}, query, body: {},
    zzIdentity: { email: who.email, displayName: "Record", platformRole: "member", via: "session",
                  teams: who.team ? [{ slug: who.team, role: "admin" }] : [], activeTeam: who.team, patTeam: null, sessionTeam: who.team },
    headers: { "x-zz-user-email": who.email, "x-zz-via": "session", "x-zz-session-team": who.team ?? "" },
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
    };
    try { route(req, res); } catch (err) { reject(err); }
  });
}

/** The gateway's door to zz-core as server.ts mounts it, a PAT of the seeded person's, Record's route and the
 *  functions it reads, loaded once the reporting timezone is set. */
async function listen(c: Core): Promise<Gateway> {
  process.env.TEAM_DB_URL = c.url;
  process.env.ZZ_TZ = TIMEZONE;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  const load = (p: string) => import(pathToFileURL(join(root, "services/gateway/dist", p)).href);
  const express = (await import("express")).default;
  const db = (await load("db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await db.initPlatformDb();
  const { identityMiddleware } = (await load("identity.js")) as { identityMiddleware: () => RequestHandler };
  const { toolCallTelemetry, doorSurface } = (await load("tool-telemetry.js")) as
    { toolCallTelemetry: (surface: (req: Request) => string) => RequestHandler; doorSurface: (url: string) => string };
  const { passThrough } = (await load("relay.js")) as { passThrough: (url: string, what: string, refusal: string) => RequestHandler };
  const routes = new Map<string, Route>();
  ((await load("console/record.js")) as { mountRecord: (app: unknown) => void }).mountRecord({ get: (p: string, h: Route) => routes.set(p, h) });

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
    record: routes.get("/api/console/record") ?? c.fail("mount", "no route GET /api/console/record"),
    slices: (await load("console/record-slices.js")) as Gateway["slices"],
    mostOpenAtOnce: ((await load("console/work-figures.js")) as Pick<Gateway, "mostOpenAtOnce">).mostOpenAtOnce,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.platformDb().end().catch(() => undefined);
      for (const k of ["TEAM_DB_URL", "ZZ_TZ", "ZZ_CATALOG_DIR"]) delete process.env[k];
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
 * Runs `make`, waits until every row it leaves has landed, then moves every timestamp the phase wrote by one
 * interval, so its first instant lands at `target`: the events, the revisions' written and presented times, the
 * documents', the initiatives' and the lessons'. One interval keeps a seal's written_at equal to its act's ts.
 */
async function phase(c: Core, d: ReturnType<typeof door>, target: number, make: () => Promise<void>): Promise<void> {
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

/** Makes the record the expected values above describe, and answers each initiative's slug by its key. */
async function make(c: Core, g: Gateway, w0: number): Promise<Record<string, string>> {
  const d = door(c, g);
  const when = (w: When): number => at(w0, w);
  const s: Record<string, string> = {};
  const step = "the record made";
  const write = (client: string, path: string, content: string) => d.call(step, client, "document_write", { path, content });
  const flowDocs = async (key: string) => { await write(WORK, `${s[key]}/explore.md`, EXPLORE); await write(WORK, `${s[key]}/spec.md`, SPEC); };
  await phase(c, d, when([50, 10]), async () => { s.old = await c.open("old"); await write(WORK, `${s.old}/notes.md`, text(100, "old")); });
  await phase(c, d, when([49, 10]), async () => {
    await c.sign(`${s.old}/notes.md`);
    await c.ok(step, "initiative_close", { initiative: s.old, disposition: "finished", document: "notes.md" });
  });
  await phase(c, d, when([20, 10]), async () => { s.mid = await c.open("mid", "sdlc-flow"); await flowDocs("mid"); });
  await phase(c, d, when([19, 34]), async () => { await c.ok(step, "initiative_close", { initiative: s.mid, disposition: "abandoned" }); });
  await phase(c, d, when([3, 10]), async () => {
    s.recent = await c.open("recent", "sdlc-flow");
    await flowDocs("recent");
    for (const title of ["first finding", "second finding"]) await c.source(step, { initiative: s.recent, title, content: title, supports: ["spec.md"] });
    await d.call(step, WORK, "knowledge_add", { title: "Close after reading", type: "decision", scope: "team", evidence: [s.recent], body: LESSON });
  });
  // Written to zz-core directly, so no call of the door names it: an unrecorded document.
  await phase(c, d, when([3, 20]), async () => { s.live = await c.open("live"); await c.ok(step, "document_write", { path: `${s.live}/unrecorded.md`, content: text(400, "live") }); });
  await phase(c, d, when([2, 10]), async () => {
    s.done = await c.open("done");
    await write(WORK, `${s.done}/notes.md`, text(300, "done"));
    await c.source(step, { initiative: s.done, title: "audit", content: "three", supports: ["notes.md"] });
  });
  await phase(c, d, when([2, 30]), async () => {
    await d.call(step, WORK, "document_present", { path: `${s.done}/notes.md` });
    await d.call(step, WORK, "document_edit", { path: `${s.done}/notes.md`, edits: [{ find: "done-start", replace: `done-start ${Array(50).fill("more").join(" ")}` }] });
  });
  await phase(c, d, when([1, 10]), async () => {
    await c.sign(`${s.done}/notes.md`);
    await c.ok(step, "initiative_close", { initiative: s.done, disposition: "finished", document: "notes.md" });
    await c.sign(`${s.recent}/spec.md`);
  });
  await phase(c, d, when([1, 20]), async () => { await write(MAINTENANCE, `${s.recent}/imported.md`, text(1000, "imported")); });
  await c.sql.query(
    `insert into zz.event (ts, kind, subject, detail, origin, team_id)
     select $1::timestamptz, 'knowledge.search', 'seeded query', $2::jsonb, 'work', t.id from zz.team t where t.slug = $3`,
    [iso(when([1, 30])), JSON.stringify({ returned: ["team:_knowledge/nodes/1-close-after-reading.md", `team:${s.recent}/spec.md`] }), c.team]);
  const id = async (sql: string, args: unknown[]) => (await c.sql.query<{ id: string }>(sql, args)).rows[0].id;
  const skill = await id("insert into zz.skill (name) values ('rec-spec') returning id", []);
  const version = await id("insert into zz.skill_version (skill_id, version, content_hash) values ($1, '1.0.0', $2) returning id",
                           [skill, createHash("sha256").update("rec-spec").digest("hex")]);
  await c.sql.query(
    `insert into zz.skill_run (team_id, initiative_id, skill_version_id, session, calls, bytes_total, started_at, ended_at)
     select t.id, null, $2, 'rec-1', 3, 100, $3::timestamptz, $4::timestamptz from zz.team t where t.slug = $1`,
    [c.team, version, iso(when([1, 34])), iso(when([1, 36]))]);
  return s;
}

async function cases(c: Core, g: Gateway): Promise<void> {
  const w0 = runningWeek(Date.now());
  const s = await make(c, g, w0);
  const ME: Who = { email: c.email, team: c.team };
  const read = async (step: string, query: Obj, who: Who = ME): Promise<Obj> => {
    const a = await answer(g.record, request(who, query));
    if (a.status !== 200) c.fail(step, `Record answered ${a.status}: ${show(a.body)}`);
    return a.body;
  };
  const ok = (step: string, part: unknown): Obj => {
    if ((part as Part)?.state !== "ok") c.fail(step, `a part read ${show(part)}`);
    return (part as Part).data!;
  };
  const same = (step: string, found: unknown, expected: unknown): void => {
    if (JSON.stringify(canonical(found)) !== JSON.stringify(canonical(expected))) c.fail(step, `found ${show(found)}, expected ${show(expected)}`);
  };
  /** Hours as the tools left them: each act seconds after its phase's first instant. */
  const near = (step: string, found: Fig, hours: number | null): void => {
    if (hours === null ? found.value !== null || found.why !== "no_data" : found.why !== null || Math.abs(Number(found.value) - hours) > 0.05) {
      c.fail(step, `found ${show(found)}, expected ${hours === null ? "no data" : `${hours} hours`}`);
    }
  };
  const instant = async (sql: string, args: unknown[]): Promise<number> =>
    (await c.sql.query<{ ms: number }>(`select (extract(epoch from (${sql})) * 1000)::float8 as ms`, args)).rows[0].ms;
  const opened = (key: string) => instant("select opened_at from zz.initiative where slug = $1", [s[key]]);
  const closedAt = (key: string) => instant("select closed_at from zz.initiative where slug = $1", [s[key]]);

  let step = "the period starts at the quarter's first day, 1 January or the first initiative, in the reporting timezone";
  const R = { quarter: await read(step, { period: "quarter" }), year: await read(step, { period: "year" }), all: await read(step, {}) };
  if (R.all.period !== "all") c.fail(step, `the default period read ${String(R.all.period)}`);
  const asOf = String((R.all.meta as Obj).asOf);
  const [y, m] = dateOf(Date.parse(asOf)).split("-").map(Number);
  // The local midnight of a date, eight hours before the UTC one.
  const starts = { quarter: iso(Date.UTC(y, Math.floor((m - 1) / 3) * 3, 1) - 8 * HOUR), year: iso(Date.UTC(y, 0, 1) - 8 * HOUR), all: iso(await opened("old")) };
  for (const p of ["quarter", "year", "all"] as const) {
    const meta = R[p].meta as Obj;
    same(`${step} (${p})`, meta, {
      asOf: meta.asOf, timezone: TIMEZONE, period: { from: starts[p], to: meta.asOf }, scope: "caller-in-active-team",
      population: `${c.team}'s team history, from before the caller joined on ${dateOf(Date.now())}, and the approvals signed in the caller's name there`,
      coverageFrom: starts.all,
    });
  }
  c.pass(`${step}: ${starts.quarter}, ${starts.year} and ${starts.all}, each labelled team history`);

  step = "weeks up to 26 of them and months beyond, so a year answers months";
  for (const p of ["quarter", "year", "all"] as const) {
    const windows = (R[p].cumulative as PF[]).map((x) => x.window);
    const months = Date.parse(asOf) - Date.parse(starts[p]) > 26 * WEEK;
    // Every period begins on a local Monday, or on the 1st, at midnight, where the one before it ends.
    const bad = windows.filter((w, i) => !(months ? stamp(Date.parse(w.from)).includes("-01,") : stamp(Date.parse(w.from)).startsWith("Mon"))
      || !stamp(Date.parse(w.from)).endsWith("00:00") || (i > 0 && w.from !== windows[i - 1].to));
    if (!windows.length || bad.length || windows[0].observedFrom !== starts[p] || windows.at(-1)!.observedThrough !== asOf) {
      c.fail(`${step} (${p})`, `${months ? "months" : "weeks"} expected, read ${show(windows.map((w) => w.from))}`);
    }
  }
  c.pass(step);

  step = "the lead: the retained words as of the cutoff at 500 an hour, the same in every period, the coverage beside them";
  const estimate = { basis: "retained_stock", words: RETAINED, assumedWordsPerHour: 500, hours: RETAINED / 500, coverage: COVERAGE };
  for (const p of ["quarter", "year", "all"] as const) same(`${step} (${p})`, R[p].lead, { estimate, asOf: (R[p].meta as Obj).asOf });
  c.pass(`${step}: ${RETAINED} words, the import-made and the unrecorded document named in the coverage`);

  for (const p of ["quarter", "year", "all"] as const) {
    const r = R[p], meta = r.meta as Obj, window: Span = { from: starts[p], to: String(meta.asOf) };
    const fromMs = Date.parse(window.from), toMs = Date.parse(window.to);
    // A phase's acts land within a minute of its first instant.
    const inside = (w: When): boolean => at(w0, w) + 60_000 >= fromMs && at(w0, w) + 60_000 < toMs;
    const periods = (r.cumulative as PF[]).map((x) => x.window);
    const inPeriod = (w: When, pw: Win): boolean => inside(w) && at(w0, w) >= Date.parse(pw.from) && at(w0, w) < Date.parse(pw.to);
    const closes = CLOSES.filter((x) => inside(x.closed));
    const hours = (xs: typeof CLOSES) => median(xs.map((x) => at(w0, x.closed) - at(w0, x.opened)).map((ms) => ms / HOUR));

    step = `the cumulative words added and the foot (${p})`;
    same(step, (r.cumulative as PF[]).map((x) => x.figure.value),
      periods.map((pw) => ADDED.filter(([, w]) => inside(w) && at(w0, w) < Date.parse(pw.to)).reduce((n, [k]) => n + k, 0)));
    same(step, r.foot, {
      closed: counted(closes.length), opened: counted(OPENED.filter(inside).length), documents: counted(DOCS.filter(inside).length),
      versions: counted(VERSIONS.filter(([, w]) => inside(w)).length), approvalsInYourName: counted(APPROVALS.filter(inside).length),
    });
    c.pass(step);

    step = `Work: by outcome, most open at once, the medians, closures in all and by period, a typical piece of work (${p})`;
    const work = ok(step, r.work);
    const outcomes = (xs: typeof CLOSES) => Object.fromEntries(["accepted", "delivered", "abandoned"].map((o) => [o, counted(xs.filter((x) => x.outcome === o).length)]));
    same(step, work.closedByOutcome, outcomes(closes));
    same(step, work.mostOpenAtOnce, await g.mostOpenAtOnce(c.team, window, String(meta.asOf)));
    near(step, (work.medianHoursToClose as PF).figure, hours(closes));
    near(step, (work.medianHoursToAbandon as PF).figure, hours(closes.filter((x) => x.outcome === "abandoned")));
    same(step, (work.closuresInAll as PF[]).map((x) => x.figure.value),
      periods.map((pw) => CLOSES.filter((x) => at(w0, x.closed) < Math.min(Date.parse(pw.to), toMs)).length));
    same(step, (work.closuresByWeek as Obj[]).map(({ window: w, ...o }) => [w, o]),
      periods.map((pw) => [pw, outcomes(CLOSES.filter((x) => inPeriod(x.closed, pw)))]));
    (work.medianHoursByWeek as PF[]).forEach((x, i) => near(step, x.figure, hours(CLOSES.filter((k) => inPeriod(k.closed, periods[i])))));
    const typical = work.typical as Record<string, { median: Fig; largest: Fig }>;
    ["documents", "versions", "sources", "words"].forEach((k, i) => {
      const values = closes.map((x) => x.typical[i]);
      same(`${step}: the typical ${k}`, typical[k], values.length ? { median: counted(median(values)!), largest: counted(Math.max(...values)) }
        : { median: { value: null, why: "no_data" }, largest: { value: null, why: "no_data" } });
    });
    c.pass(`${step}: ${closes.length} closed`);

    step = `Documents: flow documents, versions, sources under a gated document, citations, words by period, most rewritten (${p})`;
    const docs = ok(step, r.documents);
    const gated = GATED.filter(([, w]) => inside(w)).map(([n]) => n);
    const doneVersions = VERSIONS.filter(([k, w]) => k === "done" && inside(w)).length;
    same(step, [docs.flowDocuments, docs.versions, docs.sourcesUnderGated, docs.citations, docs.mostRewritten], [
      counted(DOCS.filter(inside).length), counted(VERSIONS.filter(([, w]) => inside(w)).length),
      gated.length ? { median: counted(median(gated)!), largest: counted(Math.max(...gated)) } : { median: { value: null, why: "no_data" }, largest: { value: null, why: "no_data" } },
      counted(CITES.filter(inside).length), doneVersions >= 2 ? [{ initiative: s.done, path: "notes.md", versions: doneVersions }] : []]);
    same(step, (docs.wordsByWeek as PF[]).map((x) => x.figure.value), periods.map((pw) => {
      const here = ADDED.filter(([, w]) => inPeriod(w, pw));
      return here.length ? here.reduce((n, [k]) => n + k, 0) : null;
    }));
    if (p === "all") same(step, docs.coverage, COVERAGE);
    c.pass(step);

    step = `Knowledge, Your agents, and Firsts and bests are the slices' own over the period from its first record (${p})`;
    // Record counts runs and searches from the later of the period's start and its first record (Task I-131): in a run
    // from about 17 December the seeded first initiative falls after 1 January, and the year counts from the initiative.
    const since: Span = { from: starts[p] < starts.all ? starts.all : starts[p], to: window.to };
    same(`${step}: Knowledge`, ok(step, r.knowledge), await g.slices.knowledgeSlice(c.team, window, String(meta.asOf), since.from));
    same(`${step}: Your agents`, ok(step, r.agents), await g.slices.agentsSlice(c.team, since, String(meta.asOf)));
    same(`${step}: Firsts and bests`, ok(step, r.firsts), await g.slices.firstsSlice(c.team, window, String(meta.asOf)));
    c.pass(step);
  }

  step = "the record: every initiative newest first, paged, with the summary over all of them";
  const row = async (key: string, outcome: string | null, documents: number, lessons: number) => {
    const closed = outcome === null ? null : await closedAt(key);
    return { slug: s[key], outcome, opened: iso(await opened(key)), closed: closed === null ? null : iso(closed),
             tookHours: closed === null ? null : (closed - await opened(key)) / HOUR, documents, lessons };
  };
  const rows = [await row("done", "accepted", 1, 0), await row("live", null, 1, 0), await row("recent", null, 3, 1),
                await row("mid", "abandoned", 2, 0), await row("old", "accepted", 1, 0)];
  const summary = { byOutcome: { open: 2, accepted: 2, delivered: 0, abandoned: 1 }, byFlow: [{ flow: null, count: 3 }, { flow: "sdlc-flow", count: 2 }] };
  same(step, ok(step, R.all.record), { rows, total: 5, summary });
  for (const p of ["quarter", "year"] as const) same(`${step} (${p})`, ok(step, R[p].record), { rows, total: 5, summary });
  same(`${step}: limit 2, offset 1`, ok(step, (await read(step, { limit: "2", offset: "1" })).record), { rows: rows.slice(1, 3), total: 5, summary });
  c.pass(`${step}: ${rows.length} initiatives, an import-made and an unrecorded document counted in their inventories`);

  step = "the answer carries what Copy as text copies, and nothing of weekends, days off, hours saved or a speedup";
  const whole = JSON.stringify(R.all);
  for (const key of ['"scope"', '"asOf"', '"timezone"', '"coverage"', '"basis"', '"assumedWordsPerHour"']) if (!whole.includes(key)) c.fail(step, `no ${key}`);
  const claim = /weekend|day.?off|days.?off|holiday|saved|speed.?up|productiv/i.exec(whole);
  if (claim) c.fail(step, `the answer says ${claim[0]}`);
  c.pass(step);

  step = "a second person on the team reads none of the first's approvals as theirs, and the same estimate";
  const member = await c.member();
  const theirs = await read(step, {}, { email: member, team: c.team });
  same(step, [(theirs.foot as Obj).approvalsInYourName, (theirs.lead as Obj).estimate], [counted(0), estimate]);
  c.pass(step);

  step = "reading Record records no event";
  const before = await count(c, "true");
  const started = performance.now();
  await read(step, {});
  const took = performance.now() - started;
  await new Promise((r) => setTimeout(r, 1500));
  if (await count(c, "true") !== before) c.fail(step, `${(await count(c, "true")) - before} events were recorded by reading Record`);
  c.pass(`${step}: one whole read took ${took.toFixed(0)} ms on the throwaway's small record, a floor and not the representative measure`);

  step = "each part fails alone: the lessons hidden";
  const hidden = async (table: string): Promise<Obj> => {
    await c.sql.query(`alter table zz.${table} rename to ${table}_hidden`);
    return read(step, {}).finally(() => c.sql.query(`alter table zz.${table}_hidden rename to ${table}`));
  };
  const states = (r: Obj) => ["work", "documents", "knowledge", "agents", "firsts", "record"].map((k) => (r[k] as Part).state);
  const blind = await hidden("knowledge_node");
  same(step, [(blind.lead as Obj).estimate, states(blind), (blind.foot as Obj).documents, (blind.foot as Obj).closed,
              (blind.cumulative as PF[]).every((x) => x.figure.why === "unavailable")],
    [null, ["ok", "unavailable", "unavailable", "ok", "unavailable", "unavailable"], { value: null, why: "unavailable" }, (R.all.foot as Obj).closed, true]);
  c.pass(step);
  step = "each part fails alone: the runs hidden";
  const runless = await hidden("skill_run");
  same(step, [states(runless), (runless.lead as Obj).estimate], [["ok", "ok", "ok", "unavailable", "unavailable", "ok"], estimate]);
  c.pass(step);

  step = "a person in no team, an unknown period, a bad page and a repeated parameter are refused";
  for (const [who, query] of [[{ email: c.email, team: null }, {}], [ME, { period: "month" }], [ME, { limit: "0" }], [ME, { limit: "101" }],
                               [ME, { offset: "-1" }], [ME, { period: ["all", "year"] }]] as [Who, Obj][]) {
    const a = await answer(g.record, request(who, query));
    if (a.status !== 400) c.fail(step, `${show(query)} answered ${a.status}`);
  }
  c.pass(step);

  step = "the key sets match the console's fake answer";
  let fake: { record: (who: unknown, q: URLSearchParams) => [number, unknown] };
  try {
    fake = (await import(pathToFileURL(FAKE).href)) as typeof fake;
  } catch (err) {
    return c.fail(step, `could not read the console's fake answer at ${FAKE}: ${(err as Error).message}`);
  }
  const [status, body] = fake.record({ activeTeam: "atlas", email: "ava.lindqvist@example.com" }, new URLSearchParams());
  const diffs = status === 200 ? shapeDiffs(R.all, body, "", []) : [`the fake answered ${status}`];
  if (diffs.length) c.fail(step, diffs.join("; "));
  c.pass(step);
}

process.exitCode = await withThrowawayCore(NAME, DONE, run);
