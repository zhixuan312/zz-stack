#!/usr/bin/env node
/**
 * checks/console-doors-one-owner.ts — a door's day has one owner for its failure rate: the gateway computes it
 * once, and the day's colour is that same number (AC-5.1).
 *
 *   node checks/console-doors-one-owner.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL migrated by the real runner (`withThrowawayDb`), seeds three days of real-work
 * calls for the core door — 50 with no tool failure, 50 with 1, 50 with 4 — and one call through the manage door
 * four days back, so the days begin there and the core door has a day with no call of its own; then it serves the
 * gateway's own built identity middleware and `GET /api/console/platform/status` from this process, signed in with a
 * real console session cookie. What it establishes:
 *
 *   - every day of every door carries `rate`, its tool failures as a percentage of its calls, equal to
 *     `100 * toolFailures / calls` — the one division, answered rather than left to the reader — and `state` is
 *     exactly what that rate's thresholds give: `none` with no calls, `marked` from 1%, `red` from 5%;
 *   - the core door's three seeded days read 0 of 50 as 0 and `clear`, 1 of 50 as 2 and `marked`, and 4 of 50 as 8
 *     and `red`; the day four days back, and today, carry `rate: null` and `state: "none"`, never a rate of zero;
 *   - the console's `doorRow` draws the gateway's rate: it maps the days it draws to `rate` and divides the two
 *     counts nowhere, so the sparkline and the day's colour cannot disagree;
 *   - the console's fake answer carries the same two numbers from the same inputs on every day of its three doors.
 *
 * DELIBERATE: the reporting timezone is Asia/Singapore, eight hours ahead of UTC, so a day cut on UTC's calendar
 * puts every call seeded at local noon on the wrong day.
 *
 * The only database it touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Express, RequestHandler } from "express";
import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import { NEEDS_MEMBER, dayStart, seedNeedsPeople, signIn } from "../scripts/schema/status-seed.ts";
import { withThrowawayDb } from "../scripts/schema/throwaway.ts";

const NAME = "console-doors-one-owner";
const DONE = "console-doors-one-owner: every door's day carries the gateway's own tool-failure rate and the state read " +
  "from that number, a day with no calls a null and none, and the console draws the rate instead of dividing the " +
  "counts again: ok";
const TIMEZONE = "Asia/Singapore";
const HOUR = 3_600_000;
/** COUPLED: the console's checkout, `../zz-stack-dashboard` here and in CI. */
const CONSOLE = join(root, "..", "zz-stack-dashboard");
const CONTEXT = join(CONSOLE, "src", "logic", "platform-status-context.ts");
const FAKE = join(CONSOLE, "scripts", "fake-gateway", "platform-status.ts");

class CaseFailure extends Error {}
function fail(step: string, detail: string): never {
  throw new CaseFailure(`${NAME}: FAILED at "${step}": ${detail}`);
}
const pass = (line: string): void => console.log(`  ok  ${line}`);

type Obj = Record<string, unknown>;
type Day = { date: string; calls: number | null; toolFailures: number | null; rate: number | null; state: string; complete: boolean };
type Door = { door: string; days: Day[] };

/** The core door's seeded days, `k` days before today: calls, and how many of them are tool failures. */
const SEEDED = [{ k: 3, calls: 50, failures: 0 }, { k: 2, calls: 50, failures: 1 }, { k: 1, calls: 50, failures: 4 }] as const;
/** The day before the core door's first, four days back, on which the manage door alone is called: so a day with no
 *  call of the core door's own is answered inside the days, and not only today. */
const QUIET = 4;

/** A day's rate as the gateway must answer it: tool failures as a percentage of calls, null with no calls. */
const rateOf = (calls: number, failures: number): number | null => (calls === 0 ? null : (100 * failures) / calls);
/** The state that rate's thresholds give: no calls is `none`, 1% or more `marked`, 5% or more `red`. */
const stateOf = (rate: number | null): string => (rate === null ? "none" : rate >= 5 ? "red" : rate >= 1 ? "marked" : "clear");

/** A local `YYYY-MM-DD` date in the reporting timezone. */
const localDate = (ms: number): string => new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(new Date(ms));

/** The member `seedNeedsPeople` wrote, and the team it acts for. */
async function memberOf(db: pg.ClientBase | pg.Pool): Promise<{ member: string; team: string }> {
  return (await db.query<{ member: string; team: string }>(
    "select p.id::text as member, p.active_team_id::text as team from zz.principal p where p.email = $1", [NEEDS_MEMBER])).rows[0];
}

/**
 * Seeds the manage door's one call on D-4, which is where the days then begin, and `SEEDED`'s calls for the core
 * door from noon local on each of D-3, D-2 and D-1, one second apart, the first of them refused as a tool failure.
 */
async function seedDoors(db: pg.ClientBase | pg.Pool, now: number): Promise<void> {
  const { member, team } = await memberOf(db);
  const ts: string[] = [], tools: string[] = [], owners: (string | null)[] = [];
  const push = (k: number, tool: string, calls: number, failures: number): void => {
    const from = dayStart(now, k, TIMEZONE) + 12 * HOUR;
    for (let i = 0; i < calls; i++) {
      ts.push(new Date(from + i * 1000).toISOString());
      tools.push(tool);
      owners.push(i < failures ? "theirs" : null);
    }
  };
  push(QUIET, "manage:whoami", 1, 0);
  for (const d of SEEDED) push(d.k, "core:knowledge_search", d.calls, d.failures);
  await db.query(
    `insert into zz.event (ts, kind, subject, ok, tool_key, refusal_owner, refusal, origin, team_id, actor_id)
     select u.ts, 'tool_call', u.tool, u.owner is null, u.tool, u.owner,
            case when u.owner is null then null else 'seeded refusal' end, 'work', $4, $5
       from unnest($1::timestamptz[], $2::text[], $3::text[]) as u(ts, tool, owner)`,
    [ts, tools, owners, team, member]);
}

/** Every day of every door, held to the rate its own counts give and the state that rate's thresholds give. */
function rateCases(doors: Door[]): void {
  const step = "every answered day carries its rate, and the state that rate's thresholds give";
  const problems: string[] = [];
  for (const d of doors) {
    for (const day of d.days) {
      if (day.calls === null || day.toolFailures === null) { problems.push(`${d.door} ${day.date} answers ${day.calls} calls and ${day.toolFailures} tool failures`); continue; }
      const want = rateOf(day.calls, day.toolFailures);
      if (day.rate !== want) problems.push(`${d.door} ${day.date} carries rate ${String(day.rate)}, not ${String(want)} of ${day.calls} calls and ${day.toolFailures} tool failures`);
      if (day.state !== stateOf(want)) problems.push(`${d.door} ${day.date} reads ${day.state}, not ${stateOf(want)} at ${String(want)}`);
    }
  }
  if (problems.length) fail(step, problems.slice(0, 6).join("; "));
  pass("every day of all three doors carries 100 * toolFailures / calls as a rate, and its state is that rate's own: " +
       "none with no calls, marked from 1%, red from 5%");
}

/** The core door's five days, written out by hand from the seed. */
function coreCases(doors: Door[], now: number): void {
  const step = "the core door's seeded days, and the two it was never called on";
  const core = doors.find((d) => d.door === "core");
  if (!core) fail(step, `no core door among ${doors.map((d) => d.door).join(", ") || "nothing"}`);
  const date = (k: number): string => localDate(dayStart(now, k, TIMEZONE));
  const want: [number, number, number, number | null, string][] = [
    [QUIET, 0, 0, null, "none"],
    ...SEEDED.map((d): [number, number, number, number | null, string] =>
      [d.k, d.calls, d.failures, rateOf(d.calls, d.failures), stateOf(rateOf(d.calls, d.failures))]),
    [0, 0, 0, null, "none"],
  ];
  const problems: string[] = [];
  if (core.days[0]?.date !== date(QUIET)) problems.push(`the days begin at ${String(core.days[0]?.date)}, not ${date(QUIET)}`);
  if (core.days.at(-1)?.date !== date(0) || core.days.at(-1)?.complete !== false) {
    problems.push(`the last day reads ${JSON.stringify(core.days.at(-1))}, not ${date(0)}, not complete`);
  }
  for (const [k, calls, failures, rate, state] of want) {
    const day = core.days.find((x) => x.date === date(k));
    if (!day || day.calls !== calls || day.toolFailures !== failures || day.rate !== rate || day.state !== state) {
      problems.push(`D-${k} reads ${JSON.stringify(day)}, not ${calls} calls, ${failures} tool failures, rate ${String(rate)}, ${state}`);
    }
  }
  if (problems.length) fail(step, problems.join("; "));
  pass("D-3 reads 0 of 50 as 0, clear; D-2 1 of 50 as 2, marked; D-1 4 of 50 as 8, red; and D-4, on which the manage " +
       "door alone was called, with today both carry rate null and state none, never a rate of zero");
}

/** The console's `doorRow` draws the gateway's rate: it divides the two counts nowhere. */
function consoleCase(): void {
  const step = "the console's doorRow draws the gateway's rate and divides nothing";
  let source: string;
  try {
    source = readFileSync(CONTEXT, "utf8");
  } catch (err) {
    fail(step, `could not read the console's ${CONTEXT}: ${(err as Error).message}`);
  }
  const at = source.indexOf("export function doorRow");
  if (at < 0) fail(step, `${CONTEXT} has no doorRow`);
  const end = source.indexOf("\n}", at);
  const body = source.slice(at, end < 0 ? undefined : end);
  if (!body.includes("x.rate")) fail(step, `doorRow does not draw the gateway's rate: ${body.slice(0, 400)}`);
  const divided = /\/\s*x\.calls|100 \* x\.toolFailures/.exec(body);
  if (divided) fail(step, `doorRow divides the two counts again: "${divided[0]}"`);
  pass("doorRow maps the days it draws to the gateway's `rate`, with no division of `toolFailures` by `calls` left in it");
}

/** The console's fake answer carries the same two numbers the gateway computes, from the same inputs. */
async function fakeCase(): Promise<void> {
  const step = "the console's fake carries the same rate and state";
  let fake: Obj;
  try {
    fake = ((await import(pathToFileURL(FAKE).href)) as { PLATFORM_STATUS: Obj }).PLATFORM_STATUS;
  } catch (err) {
    fail(step, `could not read the console's fake answer at ${FAKE}: ${(err as Error).message}`);
  }
  const doors = fake.doors as { state: string; data: Door[] };
  if (doors?.state !== "ok") fail(step, `the fake's doors read ${JSON.stringify(fake.doors).slice(0, 200)}`);
  const problems: string[] = [];
  for (const d of doors.data) {
    for (const day of d.days) {
      const want = rateOf(day.calls ?? 0, day.toolFailures ?? 0);
      if (day.rate !== want || day.state !== stateOf(want)) {
        problems.push(`${d.door} ${day.date} carries ${JSON.stringify([day.rate, day.state])}, not ${JSON.stringify([want, stateOf(want)])}`);
      }
    }
  }
  if (problems.length) fail(step, problems.slice(0, 6).join("; "));
  pass(`the fake's three doors carry the same rate and the state it gives on every one of their ${doors.data.reduce((n, d) => n + d.days.length, 0)} days`);
}

async function run(db: pg.Client, url: string): Promise<void> {
  await seedNeedsPeople(db);
  const now = Date.now();
  await seedDoors(db, now);
  const cookie = await signIn(db, NEEDS_MEMBER);

  // `withThrowawayDb` ended the gateway's pool after migrating; a fresh one on the same container, and the
  // reporting timezone set before shared.js reads it at load.
  process.env.TEAM_DB_URL = url;
  process.env.ZZ_TZ = TIMEZONE;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  const load = (p: string) => import(pathToFileURL(join(root, p)).href);
  const express = (await import("express")).default;
  const dbModule = (await load("services/gateway/dist/db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await dbModule.initPlatformDb();
  const { identityMiddleware } = (await load("services/gateway/dist/identity.js")) as { identityMiddleware: () => RequestHandler };
  const { mountPlatformStatus } = (await load("services/gateway/dist/console/platform-status.js")) as
    { mountPlatformStatus: (app: Express) => void };
  const app = express();
  // COUPLED: services/gateway/src/server.ts — the identity gate before every console route.
  app.use(identityMiddleware());
  mountPlatformStatus(app);
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/console/platform/status`;

  try {
    const res = await fetch(base, { headers: { cookie: `zz_console=${cookie}` }, signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    let body: Obj = {};
    try { const v: unknown = JSON.parse(text); if (v !== null && typeof v === "object") body = v as Obj; } catch { /* not JSON: body stays empty */ }
    if (res.status !== 200) fail("the status read", `answered ${res.status}: ${text.slice(0, 400)}`);
    const doors = body.doors as { state: string; data: Door[] };
    if (doors?.state !== "ok" || doors.data.map((d) => d.door).join() !== "core,manage,eval") {
      fail("the doors", `read ${JSON.stringify(body.doors).slice(0, 400)}`);
    }
    rateCases(doors.data);
    coreCases(doors.data, now);
    consoleCase();
    await fakeCase();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await dbModule.platformDb().end().catch(() => undefined);
    delete process.env.TEAM_DB_URL;
    delete process.env.ZZ_TZ;
    delete process.env.ZZ_CATALOG_DIR;
  }
}

async function main(): Promise<number> {
  let dbUrl = "";
  try {
    await withThrowawayDb((db) => run(db, dbUrl), async (u) => { dbUrl = u; });
  } catch (err) {
    if (err instanceof Error && /Docker is not running/.test(err.message)) {
      console.error(`${NAME}: Docker is not available — the check could not run, which is not a pass`);
      return 2;
    }
    console.error(err instanceof CaseFailure ? err.message : `${NAME}: ${String((err as Error)?.stack ?? err)}`);
    return 1;
  }
  console.log(DONE);
  return 0;
}

process.exitCode = await main();
