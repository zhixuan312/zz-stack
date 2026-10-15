#!/usr/bin/env node
/**
 * checks/console-record-slices.ts — Record's Knowledge, Your agents, and Firsts and bests slices, for a
 * quarter, a year and all (AC-5.3).
 *
 *   node checks/console-record-slices.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL and a real zz-core on it (`withThrowawayCore`), and the gateway's own
 * built door in this process (the identity gate, the JSON parser, the tool-call telemetry and the relay,
 * in the order server.ts mounts them), so the documents a person's session (`zz-plugin`) or a maintenance
 * client (`zz-migrate`) writes through it leave the rows the import rule reads. The record is made in
 * phases, each moved, together and by one interval, into the week and hour it names; the searches and
 * the runs are written as rows, the searches in the shape zz-core records them. It calls the gateway's
 * built `knowledgeSlice`, `agentsSlice` and `firstsSlice` (`services/gateway/dist/console/record-slices.js`)
 * over three windows to one cutoff: twelve weeks and the running one (weeks), forty (months) and the
 * whole record from its first week (months). What it establishes, with the expected values written below:
 *
 *   - Knowledge: the lessons adopted outside import cohorts in the window and the running total of them
 *     by period; the times the team's own lessons were returned, the mean results a search returns and
 *     the results from the shared shelf, over completed work searches only; searches with results by
 *     period; what searches returned by kind; the standing lessons by kind;
 *   - Your agents: observed run coverage and the summed duration, the peak overlap, the runs, those of
 *     no length, the skills used, weekday by hour, every day of the window and the runs by skill;
 *   - Firsts and bests: the most versions of one document, the most sources under one document, the
 *     most words added in a week and the most open at once (mostOpenAtOnce's own value), each dated, and
 *     the dated firsts: closed, approved, lesson, run and the first week with words;
 *   - the period's activity changes with the window while the as-of stocks (the lessons by kind, the
 *     running total's last point, the firsts) do not;
 *   - an import (a maintenance client's document and lesson, in the last week and before the record's
 *     first) changes the lessons by kind and nothing a period produced, nor any first;
 *   - a year answers months;
 *   - a slice whose statement fails throws, and the others still answer.
 *
 * DELIBERATE: the reporting timezone is Asia/Singapore, eight hours ahead of UTC, so a week or a day cut on
 * UTC's calendar moves what lies before local 08:00.
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

const NAME = "console-record-slices";
const DONE = "console-record-slices: Record's Knowledge, Your agents, and Firsts and bests answer the window's activity " +
  "beside as-of stocks that no window moves, an import moving the inventory alone: ok";

/** The client a maintenance command names itself, and the one a person's session does. */
const MAINTENANCE = "zz-migrate";
const WORK = "zz-plugin";
const HOUR = 3_600_000;

type Obj = Record<string, unknown>;
type Span = { from: string; to: string };
type Win = { from: string; to: string; observedFrom: string | null; observedThrough: string | null; complete: boolean };
type PF = { window: Win; figure: { value: number | null; why: string | null }; numerator: number | null; denominator: number | null };
type Slice = (team: string, window: Span, asOf: string) => Promise<Obj>;
interface Slices { knowledgeSlice: Slice; agentsSlice: Slice; firstsSlice: Slice }
interface Gateway {
  url: string; token: string; slices: Slices;
  mostOpenAtOnce(team: string, window: Span, asOf: string): Promise<{ value: { value: number | null }; at: string | null }>;
  stop(): Promise<void>;
}

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const show = (v: unknown): string => JSON.stringify(v).slice(0, 900);
const local = (ms: number): string => new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(new Date(ms));
/** `n` words: a heading of two, then `tag` words, twenty to a line. */
function text(n: number, tag: string): string {
  const words = Array.from({ length: n - 2 }, (_, i) => (i === 0 ? `${tag}-start` : tag));
  const lines: string[] = [];
  for (let i = 0; i < words.length; i += 20) lines.push(words.slice(i, i + 20).join(" "));
  return `# ${tag}\n\n${lines.join("\n")}\n`;
}
const counted = (value: number | null) => ({ value, why: null });

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
  const slices = (await load("console/record-slices.js")) as Slices;
  const { mostOpenAtOnce } = (await load("console/work-figures.js")) as Pick<Gateway, "mostOpenAtOnce">;

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
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token, slices, mostOpenAtOnce,
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

/** Searches as zz-core records them, entries `shelf:initiative/path`; the last two of the team's are not completed
 *  work searches: a maintenance client's, and one that recorded no result set. */
const SEARCHES: [When, string, Obj][] = [
  [[20, 50], "work", { returned: ["team:_knowledge/nodes/1-close-after-reading.md"] }],
  [[2, 30], "work", { returned: ["team:_knowledge/nodes/1-close-after-reading.md", "platform:_knowledge/nodes/3-shared.md", "team:recent/spec.md"] }],
  [[1, 30], "work", { returned: ["team:recent/sources/audit.md", "team:_knowledge/nodes/2-read-first.md"] }],
  [[1, 31], "work", { returned: [] }],
  [[1, 32], "platform", { returned: ["team:_knowledge/nodes/1-close-after-reading.md"] }],
  [[1, 33], "work", { ranked_total: 0 }],
];
/** Runs, `[start, end, skill]`: one fifty weeks back, one twenty back, and in the last two weeks two
 *  overlapping by an hour and one of a single call. */
const RUNS: [When, When, string][] = [
  [[50, 34], [50, 35], "rs-explore"], [[20, 34], [20, 36], "rs-spec"],
  [[2, 50], [2, 50], "rs-spec"], [[1, 34], [1, 36], "rs-spec"], [[1, 35], [1, 37], "rs-plan"],
];

async function cases(c: Core, g: Gateway): Promise<void> {
  const d = door(c, g);
  const w0 = runningWeek(Date.now());
  const when = (w: When): number => at(w0, w);
  const write = (step: string, client: string, path: string, content: string) => d.call(step, client, "document_write", { path, content });
  const present = (step: string, path: string) => d.call(step, WORK, "document_present", { path });
  /** Adds `n` words after the document's first tagged word. */
  const grow = (step: string, path: string, tag: string, n: number) =>
    d.call(step, WORK, "document_edit", { path, edits: [{ find: `${tag}-start`, replace: `${tag}-start ${Array(n).fill("more").join(" ")}` }] });
  const lesson = (step: string, client: string, kind: string, initiative: string, words: number, tag: string) =>
    d.call(step, client, "knowledge_add", { title: `Lesson ${tag}`, type: kind, scope: "team", evidence: [initiative], body: text(words, tag) });
  let first = "", old = "", recent = "";

  // The record's first week holds a lesson of 30 words alone, its first words; the next, a note of 100 words,
  // approved and its work closed.
  let step = "the record made";
  await phase(c, d, when([50, 10]), async () => { first = await c.open("first"); await write(step, WORK, `${first}/notes.md`, text(100, "first")); });
  await phase(c, d, when([51, 30]), () => lesson(step, WORK, "decision", first, 30, "firstlesson").then(() => undefined));
  await phase(c, d, when([50, 30]), async () => {
    await c.sign(`${first}/notes.md`);
    await c.ok(step, "initiative_close", { initiative: first, disposition: "finished", document: "notes.md" });
  });
  // Twenty weeks back: big.md in three versions, 300 then 500 then 600 words, two sources under it, and a lesson
  // of 40 words; the initiative stays open.
  await phase(c, d, when([20, 10]), async () => { old = await c.open("old"); await write(step, WORK, `${old}/big.md`, text(300, "big")); });
  await phase(c, d, when([20, 20]), async () => { await present(step, `${old}/big.md`); await grow(step, `${old}/big.md`, "big", 200); });
  await phase(c, d, when([20, 30]), async () => {
    await present(step, `${old}/big.md`);
    await grow(step, `${old}/big.md`, "big", 100);
    await c.source(step, { initiative: old, title: "first finding", content: "one", supports: ["big.md"] });
    await c.source(step, { initiative: old, title: "second finding", content: "two", supports: ["big.md"] });
  });
  await phase(c, d, when([20, 40]), () => lesson(step, WORK, "design", old, 40, "oldlesson").then(() => undefined));
  // The last weeks: notes.md of 200 words with a source under it, then 250 words and a lesson of 20.
  await phase(c, d, when([3, 10]), async () => {
    recent = await c.open("recent");
    await write(step, WORK, `${recent}/notes.md`, text(200, "recent"));
    await c.source(step, { initiative: recent, title: "audit", content: "three", supports: ["notes.md"] });
  });
  await phase(c, d, when([2, 10]), async () => {
    await present(step, `${recent}/notes.md`);
    await grow(step, `${recent}/notes.md`, "recent", 50);
    await lesson(step, WORK, "process", recent, 20, "recentlesson");
  });
  await c.sql.query(
    `insert into zz.event (ts, kind, subject, detail, origin, team_id)
     select u.ts, 'knowledge.search', 'seeded query', u.detail, u.origin, t.id
       from unnest($1::timestamptz[], $2::text[], $3::jsonb[]) as u(ts, origin, detail)
       join zz.team t on t.slug = $4`,
    [SEARCHES.map((s) => new Date(when(s[0])).toISOString()), SEARCHES.map((s) => s[1]), SEARCHES.map((s) => JSON.stringify(s[2])), c.team]);
  await seedRuns(c, when);

  const asOf = iso(Math.ceil(Date.now() / 1000) * 1000);
  const Q: Span = { from: iso(w0 - 12 * WEEK), to: asOf };
  const Y: Span = { from: iso(w0 - 40 * WEEK), to: asOf };
  const A: Span = { from: iso(w0 - 51 * WEEK), to: asOf };
  const read = async () => {
    const out: Record<"Q" | "Y" | "A", { knowledge: Obj; agents: Obj; firsts: Obj }> = {} as never;
    for (const [k, w] of [["Q", Q], ["Y", Y], ["A", A]] as const) {
      out[k] = { knowledge: await g.slices.knowledgeSlice(c.team, w, asOf), agents: await g.slices.agentsSlice(c.team, w, asOf),
                 firsts: await g.slices.firstsSlice(c.team, w, asOf) };
    }
    return out;
  };
  const same = (s: string, found: unknown, expected: unknown): void => {
    if (JSON.stringify(found) !== JSON.stringify(expected)) c.fail(s, `found ${show(found)}, expected ${show(expected)}`);
  };
  const instant = async (sql: string, args: unknown[]): Promise<string> =>
    iso((await c.sql.query<{ ms: number }>(`select (extract(epoch from (${sql})) * 1000)::float8 as ms`, args)).rows[0].ms);
  const before = await read();

  step = "Knowledge: lessons adopted, searches over completed work searches only, and the lessons by kind";
  const byKind = [{ kind: "decision", lessons: 1 }, { kind: "design", lessons: 1 }, { kind: "process", lessons: 1 }];
  const qWeeks = Array.from({ length: 13 }, (_, i) => 12 - i);
  const qk = before.Q.knowledge;
  same(step, [qk.adopted, qk.ownReturned, qk.meanResults, qk.sharedResults, qk.returnedByKind, qk.byKind], [
    counted(1), counted(2), counted(5 / 3), counted(1),
    [{ kind: "lesson", results: 3 }, { kind: "document", results: 1 }, { kind: "source", results: 1 }], byKind]);
  same(step, (qk.adoptedInAll as PF[]).map((p) => [p.window.from, p.figure.value]), qWeeks.map((b) => [iso(w0 - b * WEEK), b > 2 ? 2 : 3]));
  same(step, (qk.searchesWithResults as PF[]).map((p) => [p.window.from, p.figure.value, p.numerator, p.denominator]),
    qWeeks.map((b) => [iso(w0 - b * WEEK), b === 2 ? 100 : b === 1 ? 50 : null, b === 2 || b === 1 ? 1 : 0, b === 2 ? 1 : b === 1 ? 2 : 0]));
  for (const k of ["Y", "A"] as const) {
    const x = before[k].knowledge;
    same(`${step} (${k})`, [x.adopted, x.ownReturned, x.meanResults, x.sharedResults, x.returnedByKind, x.byKind], [
      counted(k === "Y" ? 2 : 3), counted(3), counted(1.5), counted(1),
      [{ kind: "lesson", results: 4 }, { kind: "document", results: 1 }, { kind: "source", results: 1 }], byKind]);
  }
  c.pass(step);

  step = "Your agents: coverage once, the summed duration, the peak, the runs, weekday by hour, every day and by skill";
  const qa = before.Q.agents;
  const cells = (marks: [number, number, number][]) => {
    const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
    for (const [day, hour, n] of marks) grid[day][hour] = n;
    return grid;
  };
  same(step, qa, {
    coverageMs: counted(3 * HOUR), summedMs: counted(4 * HOUR), peak: counted(2), runs: counted(3), zeroLength: 1, skillsUsed: counted(2),
    weekdayHour: cells([[1, 10, 1], [1, 11, 1], [2, 2, 1]]),
    days: dayList(w0 - 12 * WEEK, Date.parse(asOf), { [local(when([2, 50]))]: 1, [local(when([1, 34]))]: 2 }),
    bySkill: [{ skill: "rs-spec", runs: 2 }, { skill: "rs-plan", runs: 1 }],
  });
  const ya = before.Y.agents, aa = before.A.agents;
  same(`${step} (Y)`, [ya.coverageMs, ya.summedMs, ya.peak, ya.runs, ya.zeroLength, ya.skillsUsed, ya.bySkill, ya.weekdayHour],
    [counted(5 * HOUR), counted(6 * HOUR), counted(2), counted(4), 1, counted(2),
     [{ skill: "rs-spec", runs: 3 }, { skill: "rs-plan", runs: 1 }], cells([[1, 10, 2], [1, 11, 1], [2, 2, 1]])]);
  same(`${step} (A)`, [aa.coverageMs, aa.summedMs, aa.runs, aa.skillsUsed, aa.bySkill, aa.weekdayHour],
    [counted(6 * HOUR), counted(7 * HOUR), counted(5), counted(3),
     [{ skill: "rs-spec", runs: 3 }, { skill: "rs-explore", runs: 1 }, { skill: "rs-plan", runs: 1 }], cells([[1, 10, 3], [1, 11, 1], [2, 2, 1]])]);
  c.pass(step);

  step = "Firsts and bests: each best dated, most open at once mostOpenAtOnce's own, and the dated firsts";
  const revisionAt = (initiative: string, path: string, revision: number) => instant(
    `select r.written_at from zz.doc_revision r join zz.doc d on d.id = r.doc_id join zz.initiative i on i.id = d.initiative_id
      where i.slug = $1 and d.path = $2 and r.revision = $3`, [initiative, path, revision]);
  const sourceAt = (initiative: string, title: string) => instant(
    `select max(d.created_at) from zz.doc d join zz.initiative i on i.id = d.initiative_id
      where i.slug = $1 and d.path like 'sources/%' and d.title = $2`, [initiative, title]);
  const openedAt = (slug: string) => instant("select opened_at from zz.initiative where slug = $1", [slug]);
  const bests = async (w: Span, versions: [string, number, string], sources: [string, number, string], words: [number, number]) => {
    const open = await g.mostOpenAtOnce(c.team, w, asOf);
    if (open.value.value !== 2 || open.at !== await openedAt(recent)) c.fail(step, `mostOpenAtOnce read ${show(open)}`);
    return [
      { key: "most_versions", value: versions[1], at: await revisionAt(versions[0].split("/")[0], versions[0].split("/")[1], versions[1]), subject: versions[0] },
      { key: "most_sources", value: sources[1], at: await sourceAt(sources[0].split("/")[0], sources[2]), subject: sources[0] },
      { key: "most_words_week", value: words[0], at: iso(w0 - words[1] * WEEK), subject: null },
      { key: "most_open", value: open.value.value, at: open.at, subject: null },
    ];
  };
  same(`${step} (Q)`, (before.Q.firsts as Obj).bests,
    await bests(Q, [`${recent}/notes.md`, 2, ""], [`${recent}/notes.md`, 1, "audit"], [200, 3]));
  const longer = await bests(Y, [`${old}/big.md`, 3, ""], [`${old}/big.md`, 2, "second finding"], [600 + 40, 20]);
  same(`${step} (Y)`, (before.Y.firsts as Obj).bests, longer);
  same(`${step} (A)`, (before.A.firsts as Obj).bests, longer);
  const firsts = [
    { key: "words_week", at: iso(w0 - 51 * WEEK) },
    { key: "lesson", at: await instant("select min(created_at) from zz.knowledge_node", []) },
    { key: "approved", at: await instant("select min(ts) from zz.event where kind = 'document.document_approve'", []) },
    { key: "closed", at: await instant("select closed_at from zz.initiative where slug = $1", [first]) },
    { key: "run", at: iso(when([50, 34])) },
  ];
  for (const [f, w] of [[firsts[1], [51, 30]], [firsts[2], [50, 30]], [firsts[3], [50, 30]]] as [{ key: string; at: string }, When][]) {
    if (local(Date.parse(f.at)) !== local(when(w))) c.fail(step, `${f.key} first at ${f.at}, not in its phase`);
  }
  for (const k of ["Q", "Y", "A"] as const) same(`${step} (${k} firsts)`, (before[k].firsts as Obj).firsts, firsts);
  c.pass(step);

  step = "the period's activity changes with the window while the as-of stocks do not";
  const last = (k: "Q" | "Y" | "A") => (before[k].knowledge.adoptedInAll as PF[]).at(-1)!.figure;
  same(step, [before.Q.knowledge.adopted, before.Y.knowledge.adopted, before.A.knowledge.adopted].map((f) => (f as Obj).value), [1, 2, 3]);
  same(step, [before.Q.agents.runs, before.Y.agents.runs, before.A.agents.runs].map((f) => (f as Obj).value), [3, 4, 5]);
  same(step, [last("Q"), last("Y"), last("A")], [counted(3), counted(3), counted(3)]);
  same(step, [before.Y.knowledge.byKind, before.A.knowledge.byKind, before.Y.firsts.firsts], [before.Q.knowledge.byKind, before.Q.knowledge.byKind, before.Q.firsts.firsts]);
  c.pass(step);

  step = "a year answers months";
  for (const k of ["Y", "A"] as const) {
    const months = (before[k].knowledge.searchesWithResults as PF[]).map((p) => p.window);
    const from = local(Date.parse((k === "Y" ? Y : A).from)), to = local(Date.parse(asOf));
    const span = (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;
    const firstOfMonth = (ms: number) => local(ms).endsWith("-01") && local(ms - 1) !== local(ms);
    if (months.length !== span || months.some((w) => !firstOfMonth(Date.parse(w.from)) || !firstOfMonth(Date.parse(w.to)))) {
      c.fail(step, `${k}'s periods: ${months.length} of ${span} months, ${show(months.map((w) => w.from))}`);
    }
    if ((before[k].knowledge.adoptedInAll as PF[]).length !== span) c.fail(step, `${k}'s running total is not by month`);
  }
  c.pass(step);

  step = "an import changes the inventory and not the period's production";
  // One in the last week and one before the record's first, each a document of 5,000 words and a lesson.
  for (const [w, tag] of [[[1, 10], "late"], [[51, 10], "early"]] as [When, string][]) {
    await phase(c, d, when(w), async () => {
      await write(step, MAINTENANCE, `${recent}/imported-${tag}.md`, text(5000, tag));
      await lesson(step, MAINTENANCE, "knowledge", recent, 60, `carried${tag}`);
    });
  }
  const after = await read();
  for (const k of ["Q", "Y", "A"] as const) {
    same(`${step} (${k})`, after[k].knowledge.byKind, [{ kind: "knowledge", lessons: 2 }, ...byKind]);
    same(`${step} (${k})`, { ...after[k], knowledge: { ...after[k].knowledge, byKind: null } }, { ...before[k], knowledge: { ...before[k].knowledge, byKind: null } });
  }
  c.pass(step);

  step = "a slice whose statement fails throws, and the others still answer";
  const hidden = async (table: string, fails: (keyof Slices)[]) => {
    await c.sql.query(`alter table zz.${table} rename to ${table}_hidden`);
    try {
      for (const name of ["knowledgeSlice", "agentsSlice", "firstsSlice"] as const) {
        const threw = await g.slices[name](c.team, Q, asOf).then(() => false, () => true);
        if (threw !== fails.includes(name)) c.fail(step, `with zz.${table} hidden, ${name} ${threw ? "threw" : "answered"}`);
      }
    } finally {
      await c.sql.query(`alter table zz.${table}_hidden rename to ${table}`);
    }
  };
  await hidden("knowledge_node", ["knowledgeSlice", "firstsSlice"]);
  await hidden("skill_run", ["agentsSlice", "firstsSlice"]);
  await hidden("doc_link", ["firstsSlice"]);
  c.pass(step);
}

/** Every local day from `fromMs` through the day of `toMs`, with the runs `marks` names and none on the rest. */
function dayList(fromMs: number, toMs: number, marks: Record<string, number>): { day: string; runs: number }[] {
  const out: { day: string; runs: number }[] = [];
  const end = local(toMs - 1);
  for (let ms = fromMs + 12 * HOUR; local(ms) <= end; ms += 24 * HOUR) out.push({ day: local(ms), runs: marks[local(ms)] ?? 0 });
  return out;
}

/** The runs, written as zz.skill_run rows of the team as runs-seed.ts writes them. */
async function seedRuns(c: Core, when: (w: When) => number): Promise<void> {
  const one = async (sql: string, args: unknown[]): Promise<string> => (await c.sql.query<{ id: string }>(sql, args)).rows[0].id;
  const team = await one("select id from zz.team where slug = $1", [c.team]);
  const versions = new Map<string, string>();
  for (const name of new Set(RUNS.map((r) => r[2]))) {
    const skill = await one("insert into zz.skill (name) values ($1) returning id", [name]);
    versions.set(name, await one("insert into zz.skill_version (skill_id, version, content_hash) values ($1, '1.0.0', $2) returning id",
                                 [skill, createHash("sha256").update(name).digest("hex")]));
  }
  for (const [i, [start, end, skill]] of RUNS.entries()) {
    await c.sql.query(
      `insert into zz.skill_run (team_id, initiative_id, skill_version_id, session, calls, bytes_total, started_at, ended_at)
       values ($1, null, $2, $3, 3, 100, $4::timestamptz, $5::timestamptz)`,
      [team, versions.get(skill), `slices-${i}`, new Date(when(start)).toISOString(), new Date(when(end)).toISOString()]);
  }
}

process.exitCode = await withThrowawayCore(NAME, DONE, run);
