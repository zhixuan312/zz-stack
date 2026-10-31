/**
 * checks/console-work-query-harness.ts — what the console's Work and Platform checks share: the request a console
 * session's read arrives as, a mounted route called as Express would, the gateway's door to zz-core as server.ts mounts
 * it and tool calls through it, a phase of the record moved into its week, and the cases every measure answers alike
 * over a window of dates (AC-5.2, AC-6.2 to AC-6.5). Not a check of its own: each check imports it and runs on its own
 * seeded record.
 *
 * The cases, each over every measure it is handed:
 *
 *   - a window of inclusive dates answers what the instants of those days' start and the next day's start answer, by
 *     every dimension and bucket the measure takes;
 *   - day, week, month and weekday answer every bucket of the window in order, the groups summing to the total, and
 *     each bucket's value is the sum of the rows its drill answers, words' words and output's bytes and every other
 *     measure's rows counted; skill_calls, which is never drilled, alone excepted; a week of a window that starts on a
 *     Monday is the period that week answers;
 *   - rows answers the window's rows newest first, every day's drill in turn from the latest;
 *   - where answers, by the measure's first dimension, the total its filter's group answers when grouped by it;
 *   - from=0001-01-01 answers from the first local day the record holds, as a window of every record before it does.
 *
 * DELIBERATE: the reporting timezone is Asia/Singapore, which keeps one offset all year, so a local date's midnight is
 * written with its offset here, never worked out with the code under test.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { lastJson } from "@zz/mcp-client";
import type { Request, RequestHandler } from "express";
import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import type { Core } from "../scripts/schema/throwaway-core.ts";
import { TIMEZONE } from "../scripts/schema/work-seed.ts";

export type Obj = Record<string, unknown>;
export type Route = (req: unknown, res: unknown) => void;
export type Who = { email: string; team: string | null; role?: "member" | "superadmin" };
export type Query = Record<string, string | string[]>;
type Counted = { value: number | null; why: string | null; unmeasured?: number; imported?: number };
type Group = { key: string; label: string; value: Counted; share: number | null; previous: Counted | null };
/** The answer, as far as the shared cases read it. */
type WQ = {
  meta: Obj; measure: string; by: string; window: { from: string; to: string }; grain: string | null; groups: Group[];
  rest: { groups: number; value: number } | null; total: Counted; rows: { state: string; data?: { rows: Obj[]; total: number } } | null;
};
/** The window the cases read, as two inclusive local dates. */
export type Days = { from: string; to: string };

const DAY = 86_400_000;
const BUCKETS = ["day", "week", "month", "weekday"];
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
/** The from ZZ Meridian's runner sends for all. */
export const FIRST = "0001-01-01";

export const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
/** Its value with every object's keys in order: an answer's key order is no part of its contract. */
export const canonical = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canonical)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Obj)[k])])) : v;
export const show = (v: unknown): string => JSON.stringify(v).slice(0, 700);
/** A question as its URL spells it, a repeated argument once a value. */
export const spelled = (q: Query): string =>
  String(new URLSearchParams(Object.entries(q).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => [k, x]))));

/** The local date an instant falls on. en-CA formats as YYYY-MM-DD. */
export const localDay = (ms: number): string => new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(new Date(ms));
/** The instant a local date begins. */
export const midnightOf = (date: string): number => Date.parse(`${date}T00:00:00+08:00`);
const addDays = (date: string, n: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const weekdayOf = (date: string): string => WEEKDAYS[(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7];

/** Every bucket of a window of dates, oldest first, as ZZ Meridian keys them. */
export function bucketsOf(bucket: string, days: Days): string[] {
  const dates: string[] = [];
  for (let d = days.from; d <= days.to; d = addDays(d, 1)) dates.push(d);
  const keys = dates.map((d) => bucket === "day" ? d : bucket === "month" ? d.slice(0, 7)
    : bucket === "weekday" ? weekdayOf(d) : addDays(d, -WEEKDAYS.indexOf(weekdayOf(d))));
  const held = [...new Set(keys)];
  return bucket === "weekday" ? WEEKDAYS.filter((w) => held.includes(w)) : held;
}

/** `n` words: a heading of two, then `tag` words, twenty to a line. */
export function text(n: number, tag: string): string {
  const words = Array.from({ length: n - 2 }, (_, i) => (i === 0 ? `${tag}-start` : tag));
  const lines: string[] = [];
  for (let i = 0; i < words.length; i += 20) lines.push(words.slice(i, i + 20).join(" "));
  return `# ${tag}\n\n${lines.join("\n")}\n`;
}

/** The request a console session's read arrives as, past the gateway's middleware (COUPLED: identity.ts). A repeated
 *  argument is an array, as Express's query parser makes it. `who.role` is a member unless it says otherwise. */
export function request(who: Who, query: Query | Obj = {}, params: Obj = {}, body: Obj = {}): Obj {
  const role = who.role ?? "member";
  return {
    params, query, body,
    zzIdentity: { email: who.email, displayName: "Work", platformRole: role, via: "session",
                  teams: who.team ? [{ slug: who.team, role: "admin" }] : [], activeTeam: who.team, patTeam: null, sessionTeam: who.team },
    headers: {
      "x-zz-user-email": who.email, "x-zz-user-name": "Work", "x-zz-user-id": "", "x-zz-user-role": role === "superadmin" ? "admin" : "user",
      "x-zz-via": "session", "x-zz-pat-team": "", "x-zz-session-team": who.team ?? "",
    },
  };
}

/** Calls a mounted route as Express would, and waits for what it sends: a JSON body, or a bare status. */
export function answer(route: Route, req: Obj): Promise<{ status: number; body: Obj }> {
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

/** The gateway's door to zz-core as server.ts mounts it, on a port of its own: the gateway's built modules, loaded
 *  through `load` once the reporting timezone is set, a PAT minted for any seeded person, and `stop`. */
interface GatewayDoor { url: string; pool: pg.Pool; load: (p: string) => Promise<Obj>; pat(email: string): Promise<string>; stop(): Promise<void> }

/** Serves the door; with `skills`, the gateway also reads this checkout's skills/. */
export async function serveDoor(c: Core, { skills = false }: { skills?: boolean } = {}): Promise<GatewayDoor> {
  process.env.TEAM_DB_URL = c.url;
  process.env.ZZ_TZ = TIMEZONE;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  process.env.CORE_MCP_URL = c.mcp.url;
  if (skills) process.env.ZZ_SKILLS_DIR = join(root, "skills");
  const load = (p: string) => import(pathToFileURL(join(root, "services/gateway/dist", p)).href) as Promise<Obj>;
  const express = (await import("express")).default;
  const db = (await load("db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await db.initPlatformDb();
  const { identityMiddleware } = (await load("identity.js")) as { identityMiddleware: () => RequestHandler };
  const { toolCallTelemetry, doorSurface } = (await load("tool-telemetry.js")) as
    { toolCallTelemetry: (surface: (req: Request) => string) => RequestHandler; doorSurface: (url: string) => string };
  const { passThrough } = (await load("relay.js")) as { passThrough: (url: string, what: string, refusal: string) => RequestHandler };
  const app = express();
  // COUPLED: services/gateway/src/server.ts — the identity gate, the JSON parser, the telemetry on the door and then
  // the door's relay to zz-core, in the order server.ts mounts them.
  app.use(identityMiddleware());
  app.use(express.json({ limit: "20mb" }));
  app.use(["/core/mcp"], toolCallTelemetry((req) => doorSurface(req.originalUrl)));
  app.all("/core/mcp", passThrough(c.mcp.url, "core proxy", "zz-core is not reachable"));
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, pool: db.platformDb(), load,
    pat: async (email) => {
      const token = `zzp_${randomBytes(24).toString("hex")}`;
      await c.sql.query(
        `insert into zz.pat (principal_id, token_hash, team_id) select p.id, $2, null from zz.principal p where p.email = $1`,
        [email, createHash("sha256").update(token, "utf8").digest("hex")]);
      return token;
    },
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.platformDb().end().catch(() => undefined);
      for (const k of ["TEAM_DB_URL", "ZZ_TZ", "ZZ_CATALOG_DIR", "CORE_MCP_URL", "ZZ_SKILLS_DIR"]) delete process.env[k];
    },
  };
}

/** Tool calls through the door as a client holding `token`, counted so the rows they leave can be waited for. */
export function door(c: Core, g: { url: string; token: string }) {
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

export const count = async (c: Core, where: string): Promise<number> =>
  (await c.sql.query<{ n: number }>(`select count(*)::int as n from zz.event where ${where}`)).rows[0].n;

/**
 * Runs `make` and waits until every row it leaves has landed (the gateway writes a tool call after its answer, and
 * zz-core most acts after its commit); then, with a `target`, moves every timestamp the phase wrote by one interval, so
 * its first instant lands there: the events, the revisions' written and presented times, the documents', the
 * initiatives' and the lessons'. One interval keeps a seal's written_at equal to its act's ts.
 */
export async function phase(c: Core, d: { sent(): number }, target: number | null, make: () => Promise<unknown>): Promise<void> {
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
  const move = (table: string, columns: string[]) => c.sql.query(
    `update ${table} set ${columns.map((k) => `${k} = case when ${k} >= $1::timestamptz then ${k} + ($2::timestamptz - $1::timestamptz) else ${k} end`).join(", ")}
      where ${columns.map((k) => `${k} >= $1::timestamptz`).join(" or ")}`, [start, new Date(target).toISOString()]);
  await move("zz.event", ["ts"]);
  await move("zz.doc_revision", ["written_at", "presented_at"]);
  await move("zz.doc", ["created_at", "updated_at"]);
  await move("zz.initiative", ["opened_at", "closed_at"]);
  await move("zz.knowledge_node", ["created_at", "updated_at"]);
}

/** The shared cases' handle on one check: its seeded zz-core, and its question asked as the team's person. */
interface Asking { c: Core; ask: (step: string, q: Query) => Promise<WQ> }
/** Each measure handed to the cases and the dimensions it allows, as the check declares them. */
type Measures = Record<string, string[]>;

const same = (k: Asking, s: string, found: unknown, expected: unknown): void => {
  if (JSON.stringify(canonical(found)) !== JSON.stringify(canonical(expected))) k.c.fail(s, `found ${show(found)}, expected ${show(expected)}`);
};
/** What a drilled row adds to its group: words' words, output's bytes, one row of every other measure. */
const addsOf = (measure: string, row: Obj): number =>
  measure === "words" ? Number(row.added) : measure === "output" ? (row.bytes === null ? 0 : Number(row.bytes)) : 1;
/** The buckets a measure is grouped by: those of a measure that takes period, but a dimension of the same name. */
const bucketsFor = (dims: string[]): string[] => (dims.includes("period") ? BUCKETS.filter((b) => !dims.includes(b)) : []);
const sumOf = (w: WQ): number => w.groups.reduce((n, x) => n + (x.value.value ?? 0), 0) + (w.rest?.value ?? 0);

/** A window of dates answers what its instants answer, by every dimension and bucket. Returns the questions asked. */
export async function datesCases(k: Asking, step: string, measures: Measures, days: Days): Promise<number> {
  let asked = 0;
  for (const [measure, dims] of Object.entries(measures)) {
    for (const by of [...dims, ...bucketsFor(dims)]) {
      const dated = await k.ask(step, { measure, by, from: days.from, to: days.to });
      const instants = await k.ask(step, { measure, by, from: iso(midnightOf(days.from)), to: iso(midnightOf(addDays(days.to, 1))) });
      same(k, `${step}: ${measure} by ${by}`, [dated.window, dated.grain, dated.groups, dated.rest, dated.total],
        [instants.window, instants.grain, instants.groups, instants.rest, instants.total]);
      asked += 2;
    }
  }
  return asked;
}

/** Every bucket in order, each bucket's value the sum of its drilled rows, and rows the window's newest rows. Returns
 *  the buckets drilled. */
export async function bucketCases(k: Asking, step: string, measures: Measures, days: Days): Promise<number> {
  let drilled = 0;
  for (const [measure, dims] of Object.entries(measures)) {
    // Each day's drilled rows, oldest day first.
    const daily: Obj[][] = [];
    for (const bucket of bucketsFor(dims)) {
      const s = `${step}: ${measure} by ${bucket}`;
      const w = await k.ask(s, { measure, by: bucket, ...days, top: "50" });
      same(k, s, [w.grain, w.groups.map((x) => x.key), w.rest, sumOf(w)], [bucket, bucketsOf(bucket, days), null, w.total.value ?? 0]);
      if (bucket === "week" && weekdayOf(days.from) === "Monday") {
        const period = await k.ask(s, { measure, by: "period", ...days });
        same(k, `${s}: the periods`, [period.grain, period.groups.map((x) => localDay(Date.parse(x.key))), period.groups.map((x) => x.value)],
          ["week", w.groups.map((x) => x.key), w.groups.map((x) => x.value)]);
      }
      if (measure === "skill_calls") continue;
      for (const g of w.groups) {
        const d = await k.ask(s, { measure, by: bucket, ...days, group: g.key, limit: "100" });
        const rows = d.rows?.data ?? k.c.fail(s, `${g.key} drilled no rows: ${show(d.rows)}`);
        if (rows.total > 100 || rows.rows.length !== rows.total) k.c.fail(s, `${g.key} drilled ${rows.rows.length} of ${rows.total} rows`);
        const adds = rows.rows.reduce((n, r) => n + addsOf(measure, r), 0);
        if (adds !== (g.value.value ?? 0) || (g.value.value === null && g.value.why !== "no_data")) {
          k.c.fail(s, `${g.key} is ${show(g.value)}, its ${rows.total} drilled rows add ${adds}`);
        }
        if (bucket === "day") daily.push(rows.rows);
        drilled++;
      }
    }
    const newest = daily.reverse().flat();
    if (measure === "skill_calls" || !newest.length) continue;
    const s = `${step}: ${measure}'s rows`;
    const [twenty, one] = [await k.ask(s, { measure, by: dims[0], ...days, rows: "20" }), await k.ask(s, { measure, by: dims[0], ...days, rows: "1" })];
    same(k, s, [twenty.rows, one.rows], [{ state: "ok", data: { rows: newest.slice(0, 20), total: newest.length } },
      { state: "ok", data: { rows: newest.slice(0, 1), total: newest.length } }]);
  }
  return drilled;
}

/** Each filter on a dimension answers the total of its group, by the measure's first dimension. Returns the filters. */
export async function whereCases(k: Asking, step: string, measures: Measures, days: Days): Promise<number> {
  let asked = 0;
  for (const [measure, dims] of Object.entries(measures)) {
    for (const dim of dims.filter((d) => d !== "period")) {
      const groups = (await k.ask(step, { measure, by: dim, ...days })).groups.filter((x) => (x.value.value ?? 0) > 0).slice(0, 4);
      for (const g of groups) {
        const s = `${step}: ${measure} where ${dim}=${g.key}`;
        const w = await k.ask(s, { measure, by: dims[0], ...days, where: `${dim}=${g.key}` });
        same(k, s, [w.total, sumOf(w)], [g.value, g.value.value ?? 0]);
        asked++;
      }
    }
  }
  return asked;
}

/** from=0001-01-01 answers from the first local day the record holds, as every record before the window's end does.
 *  Returns the measures whose record holds a first day. */
export async function firstDayCases(k: Asking, step: string, measures: Measures, to: string): Promise<number> {
  let held = 0;
  for (const [measure, dims] of Object.entries(measures)) {
    const s = `${step}: ${measure}`;
    const all = await k.ask(s, { measure, by: dims[0], from: FIRST, to });
    const wide = await k.ask(s, { measure, by: dims[0], from: iso(Date.UTC(2000, 0, 1)), to: iso(midnightOf(addDays(to, 1))) });
    const first = localDay(Date.parse(all.window.from));
    const dated = await k.ask(s, { measure, by: dims[0], from: first, to });
    same(k, s, [all.window.from, all.groups, all.total, dated.groups, dated.total],
      [iso(midnightOf(first)), wide.groups, wide.total, all.groups, all.total]);
    if (!dims.includes("period")) continue;
    // The first day holds a row: its bucket is the earliest of the window and is not empty.
    const day = await k.ask(s, { measure, by: "day", from: FIRST, to, top: "50" });
    const rows = measure === "skill_calls" ? day.groups[0]?.value.value ?? 0
      : (await k.ask(s, { measure, by: "day", from: FIRST, to, group: first, limit: "1" })).rows?.data?.total ?? 0;
    if (day.groups[0]?.key !== first || day.rest !== null || (rows === 0) !== (all.total.value === 0)) {
      k.c.fail(s, `the first day ${first} answers ${show(day.groups[0])}, ${rows} rows, the rest ${show(day.rest)}`);
    }
    if (rows) held++;
  }
  return held;
}
