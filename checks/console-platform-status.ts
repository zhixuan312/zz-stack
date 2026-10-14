#!/usr/bin/env node
/**
 * checks/console-platform-status.ts — the platform's one public figure, read through the gateway's
 * own identity gate and route on a real database (AC-1.13, AC-8.9).
 *
 *   node checks/console-platform-status.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL migrated by the real runner (`withThrowawayDb`), seeds the events
 * and people `scripts/schema/status-seed.ts` declares, and serves the gateway's own built identity
 * middleware and `GET /api/console/platform/status` from this process, signed in with a real console
 * session cookie per person. What it establishes:
 *
 *   - every week from the first with a work call through the running one is answered, Monday to
 *     Monday in the reporting timezone, each carrying the malformed calls and the real-work calls
 *     this check counts for itself from what it seeded, and the rate between them: L reads 8 of 125,
 *     64; L-1 4 of 200, 20; L-2 3 of 12, 250, `insufficient`; L-3 no calls, a null with `no_data`;
 *     L-4 10 of 100, 100 — so maintenance calls, events of other kinds, the running week and the
 *     calls at a week's first instant each land where they belong;
 *   - only the running week is not `complete`; `first` is L-4, `best` L-1, `last` L, `previous`
 *     L-1, `highest` and `lowest` are null, and the judgement is `worsened`;
 *   - a member of team one, a superadmin and a person in no team receive the same measure, a team or
 *     scope parameter changes nothing, and the member's answer holds no other team's slug;
 *   - no session is refused with 401, a member's token with 403, and a query that fails answers 500
 *     with the route's sentence and no partial body;
 *   - the answer agrees in shape with the console's fake one, read from the sibling checkout: where
 *     both hold an object their key sets are equal, where both hold an array their first elements are
 *     compared the same way, and a null on either side is compared with nothing;
 *   - with L thinned to its 8 malformed calls, under the 30 a rate stands on, `last` is still L, as
 *     `insufficient` with its own counts, `previous` is still L-1, the judgement is `not_comparable`,
 *     and `first` and `best`, which only weeks of 30 calls or more supply, do not move.
 *
 * DELIBERATE: the reporting timezone is set here to Pacific/Auckland, twelve or thirteen hours ahead
 * of UTC and keeping daylight saving, so a week cut on UTC's calendar, or 168 hours long whatever the
 * clock did, misplaces the calls seeded at a week's first instant. The seed computes those instants
 * from `Intl`, not from Postgres, and the expected figures are written out by hand there.
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

import type { Express, RequestHandler } from "express";
import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import {
  CALLS, EXPECTED, MEMBER, NO_TEAM, SUPERADMIN, TEAM_TWO, seedStatus, signIn, weekStart, type Seeded,
} from "../scripts/schema/status-seed.ts";
import { withThrowawayDb } from "../scripts/schema/throwaway.ts";

const NAME = "console-platform-status";
const DONE = "console-platform-status: the platform's malformed-call rate is answered week by week in the reporting " +
  "timezone, alike to a member, a superadmin and a person in no team, from real-work tool calls only: ok";
const TIMEZONE = "Pacific/Auckland";
/** COUPLED: the fake answer in the console's checkout, `../zz-stack-dashboard` here and in CI. */
const FAKE = join(root, "..", "zz-stack-dashboard", "scripts", "fake-gateway", "platform-status.ts");

class CaseFailure extends Error {}
function fail(step: string, detail: string): never {
  throw new CaseFailure(`${NAME}: FAILED at "${step}": ${detail}`);
}
const pass = (line: string): void => console.log(`  ok  ${line}`);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

interface Answer { status: number; body: Obj; text: string }

/** Where two answers' shapes differ, by the contract's rule: at an object both hold, the key sets;
 *  at an array both hold, the first elements, the same way; a null on either side, nothing. */
function shapeDiffs(a: unknown, b: unknown, at: string, out: string[]): string[] {
  if (a === null || b === null) return out;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length && b.length) shapeDiffs(a[0], b[0], `${at}[0]`, out);
  } else if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    if (ka.join() !== kb.join()) out.push(`${at || "the answer"} has keys {${ka.join(", ")}} where the fake has {${kb.join(", ")}}`);
    for (const k of ka.filter((x) => kb.includes(x))) shapeDiffs(a[k], b[k], at ? `${at}.${k}` : k, out);
  }
  return out;
}

/** The malformed-call measure of an answer, or a failure naming what came instead. */
function measureOf(step: string, a: Answer): Obj {
  const measures = a.body.measures;
  if (a.status !== 200 || !Array.isArray(measures) || measures.length !== 1 || !isObj(measures[0])
      || measures[0].key !== "malformed_per_1000") {
    fail(step, `answered ${a.status}: ${a.text.slice(0, 400)}`);
  }
  return measures[0] as Obj;
}

/** What each week must read, counted here from the seed's own list of calls: real-work tool calls
 *  only, by the week they were placed in. */
function counted(): Map<number, { numerator: number; denominator: number }> {
  const out = new Map<number, { numerator: number; denominator: number }>();
  for (let back = 0; back <= 5; back++) out.set(back, { numerator: 0, denominator: 0 });
  for (const c of CALLS.filter((x) => x.origin === "work")) {
    const w = out.get(c.back)!;
    w.denominator += c.calls;
    w.numerator += c.ours;
  }
  return out;
}

function weekCases(seeded: Seeded, a: Answer): void {
  const step = "every week reads what was seeded";
  const m = measureOf(step, a);
  const weeks = m.weeks as Obj[];
  const asOf = Date.parse(String((a.body.meta as Obj).asOf));
  const start = (back: number): number => seeded.starts.get(back) ?? weekStart(seeded.now, back, TIMEZONE);
  // Oldest first: L-4 (back 5) through the running week (back 0).
  if (weeks.length !== 6) fail(step, `${weeks.length} weeks answered, not the six from L-4 through the running week`);
  const mine = counted();
  for (const [i, w] of weeks.entries()) {
    const back = 5 - i;
    const win = w.window as Obj, fig = w.figure as Obj;
    if (win.from !== iso(start(back)) || win.to !== iso(start(back - 1))) {
      fail(step, `week ${i} runs ${String(win.from)} to ${String(win.to)}, not ${iso(start(back))} to ${iso(start(back - 1))} (Monday to Monday in ${TIMEZONE})`);
    }
    if (back === 0) {
      if (win.complete !== false || win.observedThrough !== iso(asOf)) {
        fail(step, `the running week reads complete ${String(win.complete)} observed through ${String(win.observedThrough)}, not false through asOf`);
      }
      continue;
    }
    const want = EXPECTED.weeks.find((e) => e.back === back)!;
    const own = mine.get(back)!;
    // The seed's stated figures and this check's own count of its calls must agree before either
    // is held against the route.
    if (own.numerator !== want.numerator || own.denominator !== want.denominator) {
      fail(step, `the seed states ${want.numerator} of ${want.denominator} for back ${back} and its calls count ${own.numerator} of ${own.denominator}`);
    }
    const value = own.denominator === 0 ? null : (1000 * own.numerator) / own.denominator;
    const why = own.denominator === 0 ? "no_data" : own.denominator < 30 ? "insufficient" : null;
    if (value !== want.value || why !== want.why) fail(step, `this check computes ${value}/${why} for back ${back}, the seed states ${want.value}/${want.why}`);
    if (w.numerator !== own.numerator || w.denominator !== own.denominator || fig.value !== value || fig.why !== why
        || win.complete !== want.complete || win.observedThrough !== win.to) {
      fail(step, `back ${back} reads ${JSON.stringify(w)}, not ${own.numerator} of ${own.denominator}, ${value}, ${why}, complete ${want.complete}`);
    }
  }
  pass("L reads 8 of 125 (64), L-1 4 of 200 (20), L-2 3 of 12 (250, insufficient), L-3 no data, L-4 10 of 100 (100), " +
       `Monday to Monday in ${TIMEZONE}, and only the running week is not complete`);

  const which = (k: string): string => {
    const f = m[k];
    if (f === null) return "null";
    const i = weeks.findIndex((w) => JSON.stringify(w) === JSON.stringify(f));
    return i < 0 ? `a week not in weeks (${JSON.stringify(f)})` : `back ${5 - i}`;
  };
  const picks = `first ${which("first")}, best ${which("best")}, last ${which("last")}, previous ${which("previous")}, ` +
    `highest ${which("highest")}, lowest ${which("lowest")}`;
  const want = `first back ${EXPECTED.first}, best back ${EXPECTED.best}, last back ${EXPECTED.last}, previous back ${EXPECTED.previous}, ` +
    "highest null, lowest null";
  if (picks !== want || m.better !== "down" || m.judgement !== EXPECTED.judgement) {
    fail("first, best, last and previous", `${picks}, better ${String(m.better)}, judgement ${String(m.judgement)}; wanted ${want}, down, ${EXPECTED.judgement}`);
  }
  pass("first is L-4, best L-1, last L, previous L-1, highest and lowest null, and L against L-1 is worsened");

  const meta = a.body.meta as Obj;
  if (meta.scope !== "platform-public" || meta.timezone !== TIMEZONE || meta.coverageFrom !== iso(start(5))
      || typeof meta.population !== "string" || !/work/.test(meta.population) || !isObj(meta.period)
      || (meta.period as Obj).from !== iso(start(5)) || (meta.period as Obj).to !== meta.asOf) {
    fail("meta", JSON.stringify(meta));
  }
  pass(`meta reads platform-public in ${TIMEZONE}, real-work calls, coverage from L-4's first instant`);
}

/** `last` is the last whole week and `previous` the one before it, whatever their counts; a week
 *  under 30 calls is drawn as `insufficient` and cannot be judged, so it supplies no judgement and
 *  no record. Run last: it deletes seeded rows, every work call of L that was not refused as
 *  malformed. */
async function thinLastWeek(db: pg.Client, seeded: Seeded, as: (email: string) => Promise<Answer>): Promise<void> {
  const step = "a last whole week under 30 calls";
  const removed = await db.query(
    `delete from zz.event
      where kind = 'tool_call' and origin = 'work' and refusal_owner is distinct from 'ours'
        and ts >= $1::timestamptz and ts < $2::timestamptz`,
    [new Date(seeded.starts.get(1)!).toISOString(), new Date(seeded.starts.get(0)!).toISOString()]);
  // What L holds now, counted from the seed's own list: its malformed calls, and nothing else.
  const ours = CALLS.filter((c) => c.back === 1 && c.origin === "work").reduce((n, c) => n + c.ours, 0);
  const before = CALLS.filter((c) => c.back === 1 && c.origin === "work").reduce((n, c) => n + c.calls, 0);
  if (removed.rowCount !== before - ours) fail(step, `${removed.rowCount} of L's work calls removed, not ${before - ours}`);
  const a = await as(MEMBER);
  const m = measureOf(step, a);
  const weeks = m.weeks as Obj[];
  const at = (back: number): string => JSON.stringify(weeks[5 - back]);
  const last = m.last as Obj | null, fig = (last?.figure ?? {}) as Obj;
  if (JSON.stringify(last) !== at(1) || last?.numerator !== ours || last?.denominator !== ours
      || fig.value !== 1000 || fig.why !== "insufficient") {
    fail(step, `last reads ${JSON.stringify(last)}, not L as ${ours} of ${ours}, 1000, insufficient`);
  }
  if (JSON.stringify(m.previous) !== at(2)) fail(step, `previous reads ${JSON.stringify(m.previous)}, not L-1`);
  if (m.judgement !== "not_comparable") fail(step, `the judgement reads ${String(m.judgement)}, not not_comparable`);
  if (JSON.stringify(m.first) !== at(EXPECTED.first) || JSON.stringify(m.best) !== at(EXPECTED.best)) {
    fail(step, `first reads ${JSON.stringify(m.first)} and best ${JSON.stringify(m.best)}, not L-4 and L-1`);
  }
  pass(`with L thinned to ${ours} calls, last is still L as insufficient (${ours} of ${ours}), previous L-1, the judgement ` +
       "not_comparable, and first and best unchanged");
}

/** A measure with the running week's `observedThrough` left out: it is the request's own `asOf`,
 *  which moves between two requests a second apart. Everything else must be identical. */
function settled(m: Obj): string {
  return JSON.stringify(m, function (this: Obj, k: string, v: unknown) {
    return k === "observedThrough" && this.complete === false ? undefined : v;
  });
}

async function run(db: pg.Client, url: string): Promise<void> {
  const seeded = await seedStatus(db, TIMEZONE);
  const cookie = new Map<string, string>();
  for (const email of [MEMBER, SUPERADMIN, NO_TEAM]) cookie.set(email, await signIn(db, email));
  const pat = `zzp_${randomBytes(24).toString("hex")}`;
  await db.query("insert into zz.pat (principal_id, token_hash) select id, $2 from zz.principal where email = $1",
                 [MEMBER, createHash("sha256").update(pat, "utf8").digest("hex")]);

  // `withThrowawayDb` ended the gateway's pool after migrating; a fresh one on the same container,
  // and the reporting timezone set before shared.js reads it at load.
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
  const get = async (headers: Record<string, string>, query = ""): Promise<Answer> => {
    const res = await fetch(`${base}${query}`, { headers, signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    let body: Obj = {};
    try { const v: unknown = JSON.parse(text); if (isObj(v)) body = v; } catch { /* not JSON: body stays empty */ }
    return { status: res.status, body, text };
  };
  const as = (email: string, query = ""): Promise<Answer> => get({ cookie: `zz_console=${cookie.get(email)}` }, query);

  try {
    const member = await as(MEMBER);
    weekCases(seeded, member);

    let step = "the same measure for everybody";
    const ref = settled(measureOf(step, member));
    for (const [who, a] of [
      ["the superadmin", await as(SUPERADMIN)],
      ["the person in no team", await as(NO_TEAM)],
      ["the member sending ?team= and ?scope=", await as(MEMBER, `?team=${TEAM_TWO}&scope=platform`)],
      ["the superadmin sending ?scope=platform", await as(SUPERADMIN, "?scope=platform")],
    ] as const) {
      if (settled(measureOf(step, a)) !== ref) fail(step, `${who} receives ${settled(measureOf(step, a))}, the member ${ref}`);
      if (a.body.meta === undefined || (a.body.meta as Obj).scope !== "platform-public") fail(step, `${who} reads meta ${JSON.stringify(a.body.meta)}`);
    }
    pass("a member of team one, a superadmin and a person in no team receive the same measure, and a team or scope parameter changes nothing");

    step = "no other team's slug";
    if (member.text.includes(TEAM_TWO)) fail(step, `the member's answer holds ${TEAM_TWO}: ${member.text.slice(0, 400)}`);
    pass(`the member's answer does not hold ${TEAM_TWO}, the team whose calls it counts beside their own`);

    step = "refusals";
    const none = await get({});
    if (none.status !== 401) fail(step, `no session answered ${none.status}: ${none.text.slice(0, 300)}`);
    const token = await get({ authorization: `Bearer ${pat}` });
    if (token.status !== 403 || "measures" in token.body) fail(step, `a member's token answered ${token.status}: ${token.text.slice(0, 300)}`);
    pass("no session is refused with 401, and a member's token, which the console does not let in, with 403");

    step = "a query that fails";
    await db.query("alter table zz.event rename to event_hidden");
    const broken = await as(MEMBER).finally(() => db.query("alter table zz.event_hidden rename to event"));
    if (broken.status !== 500 || broken.body.error !== "could not read the platform's status" || Object.keys(broken.body).length !== 1) {
      fail(step, `answered ${broken.status}: ${broken.text.slice(0, 300)}`);
    }
    pass("a query that fails answers 500, could not read the platform's status, and nothing else");

    step = "the shape the console's fake answers";
    let fake: unknown;
    try {
      fake = ((await import(pathToFileURL(FAKE).href)) as { PLATFORM_STATUS: unknown }).PLATFORM_STATUS;
    } catch (err) {
      fail(step, `could not read the console's fake answer at ${FAKE}: ${(err as Error).message}`);
    }
    if (!isObj(fake)) fail(step, `${FAKE} exports no PLATFORM_STATUS object`);
    const diffs = shapeDiffs(member.body, fake, "", []);
    if (diffs.length) fail(step, diffs.join("; "));
    pass("the answer agrees in shape with the console's fake one, key set by key set");

    await thinLastWeek(db, seeded, as);
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
