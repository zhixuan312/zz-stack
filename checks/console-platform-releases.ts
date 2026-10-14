#!/usr/bin/env node
/**
 * checks/console-platform-releases.ts — the platform's releases, each with what was observed in the
 * 72 hours either side of it, read through the gateway's own identity gate and routes on a real
 * database (AC-2.4, AC-2.13, AC-3.4).
 *
 *   node checks/console-platform-releases.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL migrated by the real runner (`withThrowawayDb`), seeds the
 * releases, events and people `scripts/schema/releases-seed.ts` declares, and serves the gateway's
 * own built identity middleware, `GET /api/console/platform/releases`, `/platform/releases/:version`
 * and `/platform/status` from this process, signed in with a real console session cookie per person.
 * What it establishes:
 *
 *   - every release row, newest first, carries its published summary and client action, and both
 *     windows with their bounds, calls, malformed calls and their rate, tool failures and p95, each
 *     equal to the seed's written values, which this check first recounts from the seed's own calls:
 *     a release under 72 hours old has an after-window observed through the cutoff and not complete,
 *     a before-window that ended before the record began has no bounds and every figure
 *     `unavailable`, a window with no calls has no rate and no latency, a window under 30 calls keeps
 *     its rate as `insufficient`, one malformed call and one tool failure on one day each count where
 *     they belong, batched calls and calls with no duration stay out of the p95, and maintenance
 *     calls, page views and other events change nothing;
 *   - two releases inside 72 hours of each other each name the other, on the window it falls in;
 *   - every key set is exactly the contract's, so no field compares the two windows;
 *   - the tiles count the releases, those of the last seven days and the latest one, and the
 *     migrations `zz.schema_migration` holds; the weeks run Monday to Monday from the record's first
 *     week through the running one, each counting the releases tagged in it, and each is the status
 *     read's figure for that week exactly;
 *   - a release's page adds its changelog and upgrade notes, a section that published nothing reads
 *     `No changelog entry`, and an unknown version is a 404 with no body;
 *   - `limit` and `offset` page the rows, and a limit outside 1 to 100 or a negative offset is a 400;
 *   - a member of team one, a superadmin and a person in no team receive the same answer, a team or
 *     scope parameter changes nothing, the member's answer holds no other team's slug, no session is
 *     refused with 401 and a member's token with 403;
 *   - one release whose window count fails has its windows `unavailable` and keeps the releases named
 *     on them, the other releases unchanged; rows that cannot be read are `unavailable` beside tiles
 *     and weeks that stand; a tile query that fails answers 500 with the route's sentence alone;
 *   - the answers agree in shape with the console's fake ones, read from the sibling checkout;
 *   - with no release recorded, the tiles say none and the weeks still stand.
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
import { UNKNOWN_ACTION } from "../scripts/release-record.ts";
import {
  EXPECTED, MEMBER, NO_TEAM, RELEASES, SUPERADMIN, TEAM_TWO, seedReleases, workCalls, type Seeded,
} from "../scripts/schema/releases-seed.ts";
import { signIn, weekStart } from "../scripts/schema/status-seed.ts";
import { withThrowawayDb } from "../scripts/schema/throwaway.ts";

const NAME = "console-platform-releases";
const DONE = "console-platform-releases: each release is read with the calls, malformed calls, tool failures and p95 " +
  "observed in the 72 hours either side of it, partial and unobserved windows said, overlaps named and nothing compared, " +
  "alike to a member, a superadmin and a person in no team: ok";
const TIMEZONE = "Pacific/Auckland";
const HOUR = 3_600_000;
/** COUPLED: the fake answer in the console's checkout, `../zz-stack-dashboard` here and in CI. */
const FAKE = join(root, "..", "zz-stack-dashboard", "scripts", "fake-gateway", "platform-releases.ts");

const ANSWER_KEYS = ["meta", "rows", "tiles", "weeks"];
const ROW_KEYS = ["after", "before", "clientAction", "consoleVersion", "releasedAt", "summary", "version"];
const DETAIL_KEYS = [...ROW_KEYS, "changelog", "upgradeNotes"].sort();
const SIDE_KEYS = ["calls", "malformed", "malformedPer1000", "overlappingVersions", "p95Ms", "toolFailures", "window"];

class CaseFailure extends Error {}
function fail(step: string, detail: string): never {
  throw new CaseFailure(`${NAME}: FAILED at "${step}": ${detail}`);
}
const pass = (line: string): void => console.log(`  ok  ${line}`);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const keys = (o: unknown): string => (isObj(o) ? Object.keys(o).sort().join() : `not an object: ${JSON.stringify(o)}`);

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

/** An answer without what moves between two requests a second apart: the cutoff, and the bound a
 *  window still running is observed through. */
function settled(v: unknown): string {
  return JSON.stringify(v, function (this: Obj, k: string, x: unknown) {
    if (k === "asOf") return undefined;
    if (k === "period" && isObj(x)) return { from: x.from };
    return k === "observedThrough" && this.complete === false ? undefined : x;
  });
}

/** `percentile_cont(0.95)` over durations, rounded to a whole millisecond, as this check computes it. */
function p95(ms: number[]): number | null {
  if (!ms.length) return null;
  const s = [...ms].sort((a, b) => a - b), pos = 0.95 * (s.length - 1), lo = Math.floor(pos);
  return Math.round(s[lo] + (pos - lo) * ((s[lo + 1] ?? s[lo]) - s[lo]));
}

/** The rows of a list answer, or a failure naming what came instead. */
function rowsOf(step: string, a: Answer): Obj[] {
  const rows = a.body.rows;
  if (a.status !== 200 || !isObj(rows) || rows.state !== "ok" || !isObj(rows.data) || !Array.isArray((rows.data as Obj).rows)) {
    fail(step, `answered ${a.status}: ${a.text.slice(0, 400)}`);
  }
  return (rows.data as Obj).rows as Obj[];
}

/** One side of a release against what the seed states, after this check has recounted the seed's
 *  own calls and found the same. */
function sideCase(s: Seeded, version: string, which: "before" | "after", got: Obj, asOf: number): void {
  const step = `${version}'s ${which}-window`;
  const want = EXPECTED.releases[version][which];
  const at = s.at.get(version)!;
  const [from, to] = which === "before" ? [at - 72 * HOUR, at] : [at, at + 72 * HOUR];

  // The seed's stated figures and this check's own count of its calls must agree before either is
  // held against the route.
  const lo = Math.max(from, s.coverage), hi = Math.min(to, asOf);
  if (want.observed !== "never") {
    const inside = workCalls(s).filter((c) => c.ts >= lo && c.ts < hi);
    const timed = inside.flatMap((c) => (c.ms === null ? [] : [c.ms]));
    const own = { calls: inside.length, malformed: inside.filter((c) => c.owner === "ours").length,
      toolFailures: inside.filter((c) => c.owner === "theirs").length, p95: p95(timed) };
    const rate = own.calls === 0 ? null : (1000 * own.malformed) / own.calls;
    if (own.calls !== want.calls || own.malformed !== want.malformed || own.toolFailures !== want.toolFailures
        || own.p95 !== want.p95 || rate !== want.rate) {
      fail(step, `the seed states ${JSON.stringify(want)} and its calls count ${JSON.stringify({ ...own, rate })}`);
    }
  } else if (lo < hi) fail(step, "the seed states a window never observed, and the record began before it ended");

  const win = got.window as Obj;
  const bounds = {
    whole: [iso(from), iso(to), true], running: [iso(from), iso(asOf), false],
    late: [iso(s.coverage), iso(to), false], never: [null, null, false],
  }[want.observed];
  if (keys(got) !== SIDE_KEYS.join() || keys(win) !== "complete,from,observedFrom,observedThrough,to") {
    fail(step, `keys {${keys(got)}} and window {${keys(win)}}, not exactly the contract's`);
  }
  if (win.from !== iso(from) || win.to !== iso(to) || win.observedFrom !== bounds[0] || win.observedThrough !== bounds[1]
      || win.complete !== bounds[2]) {
    fail(step, `the window reads ${JSON.stringify(win)}, not ${iso(from)} to ${iso(to)} observed ${JSON.stringify(bounds)}`);
  }
  const count = (n: number | null) => (n === null ? { value: null, why: "unavailable" } : { value: n, why: null });
  const figures = {
    calls: count(want.calls), malformed: count(want.malformed), toolFailures: count(want.toolFailures),
    malformedPer1000: { value: want.rate, why: want.rateWhy }, p95Ms: { value: want.p95, why: want.p95Why },
  };
  for (const [k, f] of Object.entries(figures)) {
    if (JSON.stringify(got[k]) !== JSON.stringify(f)) fail(step, `${k} reads ${JSON.stringify(got[k])}, not ${JSON.stringify(f)}`);
  }
  if (JSON.stringify(got.overlappingVersions) !== JSON.stringify(want.overlapping)) {
    fail(step, `overlappingVersions reads ${JSON.stringify(got.overlappingVersions)}, not ${JSON.stringify(want.overlapping)}`);
  }
}

function rowCases(s: Seeded, a: Answer): void {
  const step = "every release row";
  if (keys(a.body) !== ANSWER_KEYS.join()) fail(step, `the answer's keys are {${keys(a.body)}}`);
  const rows = rowsOf(step, a);
  const asOf = Date.parse(String((a.body.meta as Obj).asOf));
  const total = ((a.body.rows as Obj).data as Obj).total;
  if (rows.map((r) => r.version).join() !== RELEASES.map((r) => r.version).join() || total !== RELEASES.length) {
    fail(step, `rows ${rows.map((r) => String(r.version)).join(", ")} of ${String(total)}, not ${RELEASES.map((r) => r.version).join(", ")} of ${RELEASES.length}`);
  }
  for (const [i, row] of rows.entries()) {
    const r = RELEASES[i];
    if (keys(row) !== ROW_KEYS.join()) fail(step, `${r.version} has keys {${keys(row)}}, not exactly the contract's`);
    const summary = r.summary === "" ? "No changelog entry" : r.summary;
    if (row.releasedAt !== iso(s.at.get(r.version)!) || row.summary !== summary || row.clientAction !== r.clientAction
        || row.consoleVersion !== r.consoleVersion) {
      fail(step, `${r.version} reads ${JSON.stringify({ ...row, before: undefined, after: undefined })}`);
    }
    sideCase(s, r.version, "before", row.before as Obj, asOf);
    sideCase(s, r.version, "after", row.after as Obj, asOf);
  }
  pass("0.9.3 and 0.9.2 read their whole before-windows and after-windows observed through the cutoff, not complete");
  pass("0.9.0's windows are whole: 120 calls, 6 malformed, 2 tool failures and a p95 of 2,000 ms before it; one malformed call " +
       "and one tool failure on one day after it, batched and untimed calls outside the p95, maintenance calls and other events nowhere");
  pass("0.8.0's 20 calls before it keep their rate and p95 as insufficient, and its window with no calls has no rate and no latency");
  pass("0.7.0's before-window ended before the record began and is unavailable throughout, its after-window observed from the record's start");
  pass("0.9.3 names 0.9.2 on its before-window and 0.9.2 names 0.9.3 on its after-window, and every key set is exactly the contract's");
  if (rows[4].summary !== "No changelog entry" || rows[4].clientAction !== UNKNOWN_ACTION) {
    fail(step, `0.7.0 reads summary ${String(rows[4].summary)} and client action ${String(rows[4].clientAction)}`);
  }
}

async function tileAndWeekCases(db: pg.Client, s: Seeded, a: Answer, status: Answer): Promise<void> {
  let step = "the tiles";
  const tiles = a.body.tiles as Obj;
  const m = (await db.query<{ applied: number; last: Date | null }>(
    "select count(*)::int as applied, max(applied_at) as last from zz.schema_migration")).rows[0];
  const latest = RELEASES[0].version;
  const want = { releases: RELEASES.length, lastWeek: EXPECTED.lastWeek, latest: { version: latest, releasedAt: iso(s.at.get(latest)!) },
    migrations: { applied: m.applied, lastAt: m.last === null ? null : iso(m.last.getTime()) } };
  if (JSON.stringify(tiles) !== JSON.stringify(want)) fail(step, `${JSON.stringify(tiles)}, not ${JSON.stringify(want)}`);
  if (m.applied < 6) fail(step, `only ${m.applied} migrations recorded on a database the real runner migrated`);
  pass(`the tiles read ${RELEASES.length} releases, ${EXPECTED.lastWeek} in the last seven days, ${latest} the latest, ` +
       `and the ${m.applied} migrations zz.schema_migration holds`);

  step = "the weeks";
  const weeks = a.body.weeks as Obj[];
  const asOf = Date.parse(String((a.body.meta as Obj).asOf));
  const start = (back: number): number => weekStart(s.now, back, TIMEZONE);
  // The record begins on a Monday four weeks before the running one: back 4 through back 0.
  if (!Array.isArray(weeks) || weeks.length !== 5) fail(step, `${Array.isArray(weeks) ? weeks.length : "no"} weeks, not five`);
  const calls = workCalls(s);
  for (const [i, w] of weeks.entries()) {
    const back = 4 - i, from = start(back), to = start(back - 1);
    const win = w.window as Obj, f = w.malformedPer1000 as Obj;
    if (win.from !== iso(from) || win.to !== iso(to) || JSON.stringify(f.window) !== JSON.stringify(win)) {
      fail(step, `week ${i} runs ${String(win.from)} to ${String(win.to)}, not ${iso(from)} to ${iso(to)} in ${TIMEZONE}`);
    }
    const releases = [...s.at.values()].filter((t) => t >= from && t < to).length;
    if (w.releases !== releases) fail(step, `back ${back} counts ${String(w.releases)} releases, not ${releases}`);
    const inside = calls.filter((c) => c.ts >= from && c.ts < Math.min(to, asOf));
    const malformed = inside.filter((c) => c.owner === "ours").length;
    if (f.numerator !== malformed || f.denominator !== inside.length || win.complete !== (back > 0)) {
      fail(step, `back ${back} reads ${JSON.stringify(f)}, not ${malformed} of ${inside.length}, complete ${back > 0}`);
    }
  }
  // 0.7.0 was tagged the day before the record began, in no week the record holds.
  if (weeks.reduce((n, w) => n + Number(w.releases), 0) !== RELEASES.length - 1) fail(step, "the weeks do not hold every release since the record began");
  pass("the weeks run Monday to Monday from the record's first week through the running one, each counting the releases " +
       "tagged in it and its own real-work and malformed calls");

  step = "the same figures as Status";
  const measure = (status.body.measures as Obj[] | undefined)?.find((x) => x.key === "malformed_per_1000");
  if (status.status !== 200 || !measure) fail(step, `the status read answered ${status.status}: ${status.text.slice(0, 300)}`);
  const theirs = measure.weeks as Obj[];
  const mine = weeks.map((w) => w.malformedPer1000);
  if (theirs.length !== 5 || settled(mine) !== settled(theirs)) fail(step, `releases read ${settled(mine)}, status ${settled(theirs)}`);
  pass("each of the five weeks the status read answers is the same figure, window and counts in both");
}

async function detailCases(as: (email: string, path?: string) => Promise<Answer>, list: Answer): Promise<void> {
  const step = "a release's page";
  const listed = rowsOf(step, list);
  for (const r of [RELEASES[1], RELEASES[4]]) {
    const d = await as(MEMBER, `/${r.version}`);
    if (d.status !== 200 || keys(d.body) !== DETAIL_KEYS.join()) fail(step, `${r.version} answered ${d.status} with keys {${keys(d.body)}}`);
    const { changelog, upgradeNotes, ...row } = d.body;
    const changes = r.changelog === "" ? "No changelog entry" : r.changelog;
    if (changelog !== changes || upgradeNotes !== r.upgradeNotes) {
      fail(step, `${r.version} reads changelog ${JSON.stringify(changelog)} and notes ${JSON.stringify(upgradeNotes)}`);
    }
    if (settled(row) !== settled(listed.find((x) => x.version === r.version))) fail(step, `${r.version}'s page and its row differ: ${settled(row)}`);
  }
  const unknown = await as(MEMBER, "/9.9.9");
  if (unknown.status !== 404 || unknown.text !== "") fail(step, `an unknown version answered ${unknown.status}: ${unknown.text.slice(0, 200)}`);
  pass("a release's page is its row with its changelog and upgrade notes, a section that published nothing reads No changelog entry, " +
       "and an unknown version is a 404 with no body");
}

async function pageCases(as: (email: string, path?: string) => Promise<Answer>): Promise<void> {
  const step = "paging";
  const page = await as(MEMBER, "?limit=2&offset=1");
  const rows = rowsOf(step, page);
  if (rows.map((r) => r.version).join() !== "0.9.2,0.9.0" || ((page.body.rows as Obj).data as Obj).total !== RELEASES.length) {
    fail(step, `limit 2 offset 1 reads ${rows.map((r) => String(r.version)).join(", ")}`);
  }
  for (const q of ["?limit=0", "?limit=101", "?offset=-1", "?limit=ten", "?limit=2.5"]) {
    const bad = await as(MEMBER, q);
    if (bad.status !== 400 || typeof bad.body.error !== "string") fail(step, `${q} answered ${bad.status}: ${bad.text.slice(0, 200)}`);
  }
  pass("limit 2 offset 1 reads 0.9.2 and 0.9.0 of 5, and a limit of 0, 101, ten or 2.5 or an offset of -1 is a 400");
}

/** Faults injected into the gateway's own pool: one release's window count, then the rows, then a tile
 *  query, each failing alone. */
async function failureCases(db: pg.Client, pool: pg.Pool, s: Seeded, as: (email: string, path?: string) => Promise<Answer>, good: Answer): Promise<void> {
  let step = "one release's windows cannot be counted";
  const real = pool.query.bind(pool) as (text: unknown, params?: unknown[]) => Promise<unknown>;
  const failing = (when: (sql: string, params: unknown[]) => boolean) => {
    (pool as unknown as { query: unknown }).query = (text: unknown, params?: unknown[]) =>
      typeof text === "string" && when(text, params ?? []) ? Promise.reject(new Error("injected by the check")) : real(text, params);
  };
  const at = new Date(s.at.get("0.9.3")!).toISOString();
  failing((sql, params) => sql.includes("as s(side, lo, hi)") && params[1] === at);
  let a: Answer;
  try { a = await as(MEMBER); } finally { (pool as unknown as { query: unknown }).query = real; }
  const rows = rowsOf(step, a);
  const broken = rows[0];
  for (const which of ["before", "after"] as const) {
    const w = broken[which] as Obj;
    const figures = ["calls", "malformed", "malformedPer1000", "toolFailures", "p95Ms"].map((k) => JSON.stringify(w[k]));
    if (figures.some((f) => f !== JSON.stringify({ value: null, why: "unavailable" })) || (w.window as Obj).observedFrom !== null
        || (w.window as Obj).complete !== false) {
      fail(step, `0.9.3's ${which}-window reads ${JSON.stringify(w)}`);
    }
  }
  if (JSON.stringify((broken.before as Obj).overlappingVersions) !== JSON.stringify(["0.9.2"])) {
    fail(step, `0.9.3's before-window lost the release inside it: ${JSON.stringify(broken.before)}`);
  }
  if (settled(rows.slice(1)) !== settled(rowsOf(step, good).slice(1)) || settled(a.body.tiles) !== settled(good.body.tiles)) {
    fail(step, "the other releases or the tiles changed");
  }
  pass("a failed window count makes 0.9.3's windows unavailable, keeps 0.9.2 named on its before-window, and changes no other release");

  step = "the rows cannot be read";
  failing((sql) => sql.includes("limit $1 offset $2"));
  try { a = await as(MEMBER); } finally { (pool as unknown as { query: unknown }).query = real; }
  if (a.status !== 200 || JSON.stringify(a.body.rows) !== JSON.stringify({ state: "unavailable", reason: "query_failed" })
      || settled(a.body.tiles) !== settled(good.body.tiles) || settled(a.body.weeks) !== settled(good.body.weeks)) {
    fail(step, `answered ${a.status}: ${a.text.slice(0, 400)}`);
  }
  pass("rows that cannot be read are unavailable, and the tiles and weeks beside them stand");

  step = "a tile query that fails";
  await db.query("alter table zz.schema_migration rename to schema_migration_hidden");
  a = await as(MEMBER).finally(() => db.query("alter table zz.schema_migration_hidden rename to schema_migration"));
  if (a.status !== 500 || a.body.error !== "could not read the platform's releases" || Object.keys(a.body).length !== 1) {
    fail(step, `answered ${a.status}: ${a.text.slice(0, 300)}`);
  }
  pass("a tile query that fails answers 500, could not read the platform's releases, and nothing else");
}

async function run(db: pg.Client, url: string): Promise<void> {
  const seeded = await seedReleases(db, TIMEZONE);
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
  const { mountPlatformReleases } = (await load("services/gateway/dist/console/platform-releases.js")) as
    { mountPlatformReleases: (app: Express) => void };
  const { mountPlatformStatus } = (await load("services/gateway/dist/console/platform-status.js")) as
    { mountPlatformStatus: (app: Express) => void };
  const app = express();
  // COUPLED: services/gateway/src/server.ts — the identity gate before every console route.
  app.use(identityMiddleware());
  mountPlatformReleases(app);
  mountPlatformStatus(app);
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/console/platform`;
  const get = async (headers: Record<string, string>, path = "/releases"): Promise<Answer> => {
    const res = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    let body: Obj = {};
    try { const v: unknown = JSON.parse(text); if (isObj(v)) body = v; } catch { /* not JSON: body stays empty */ }
    return { status: res.status, body, text };
  };
  const as = (email: string, path = ""): Promise<Answer> => get({ cookie: `zz_console=${cookie.get(email)}` }, `/releases${path}`);

  try {
    const member = await as(MEMBER);
    rowCases(seeded, member);
    await tileAndWeekCases(db, seeded, member, await get({ cookie: `zz_console=${cookie.get(MEMBER)}` }, "/status"));
    await detailCases(as, member);
    await pageCases(as);

    let step = "the same answer for everybody";
    const ref = settled(member.body);
    for (const [who, a] of [
      ["the superadmin", await as(SUPERADMIN)],
      ["the person in no team", await as(NO_TEAM)],
      ["the member sending ?team= and ?scope=", await as(MEMBER, `?team=${TEAM_TWO}&scope=platform`)],
      ["the superadmin sending ?scope=platform", await as(SUPERADMIN, "?scope=platform")],
    ] as const) {
      if (settled(a.body) !== ref) fail(step, `${who} receives ${settled(a.body).slice(0, 400)}`);
    }
    const detail = settled((await as(MEMBER, "/0.9.2")).body);
    if (settled((await as(NO_TEAM, "/0.9.2")).body) !== detail) fail(step, "a release's page differs for the person in no team");
    pass("a member of team one, a superadmin and a person in no team receive the same answer, and a team or scope parameter changes nothing");

    step = "no other team's slug";
    if (member.text.includes(TEAM_TWO)) fail(step, `the member's answer holds ${TEAM_TWO}: ${member.text.slice(0, 400)}`);
    pass(`the member's answer does not hold ${TEAM_TWO}, whose calls it counts in the windows`);

    step = "refusals";
    for (const path of ["/releases", "/releases/0.9.2"]) {
      const none = await get({}, path);
      if (none.status !== 401) fail(step, `no session answered ${none.status} at ${path}: ${none.text.slice(0, 300)}`);
      const token = await get({ authorization: `Bearer ${pat}` }, path);
      if (token.status !== 403 || "rows" in token.body || "version" in token.body) fail(step, `a member's token answered ${token.status} at ${path}`);
    }
    pass("no session is refused with 401, and a member's token, which the console does not let in, with 403, on both routes");

    await failureCases(db, dbModule.platformDb(), seeded, as, member);

    step = "the shape the console's fake answers";
    let fake: { releases: (limit: number, offset: number) => unknown; releaseDetail: (version: string) => unknown };
    try {
      fake = (await import(pathToFileURL(FAKE).href)) as typeof fake;
    } catch (err) {
      fail(step, `could not read the console's fake answer at ${FAKE}: ${(err as Error).message}`);
    }
    const fakeList = fake.releases(10, 0), fakeDetail = fake.releaseDetail("0.97.0");
    if (!isObj(fakeList) || !isObj(fakeDetail)) fail(step, `${FAKE} answers no releases or no 0.97.0`);
    const diffs = [
      ...shapeDiffs(member.body, fakeList, "", []),
      ...shapeDiffs((await as(MEMBER, "/0.9.2")).body, fakeDetail, "detail", []),
    ];
    if (diffs.length) fail(step, diffs.join("; "));
    pass("the list and a release's page agree in shape with the console's fake ones, key set by key set");

    step = "no release recorded";
    await db.query("delete from zz.release");
    const empty = await as(MEMBER);
    const tiles = empty.body.tiles as Obj;
    const weeks = empty.body.weeks as Obj[];
    if (empty.status !== 200 || tiles.releases !== 0 || tiles.lastWeek !== 0 || tiles.latest !== null
        || JSON.stringify(empty.body.rows) !== JSON.stringify({ state: "ok", data: { rows: [], total: 0 } })
        || weeks.length !== 5 || weeks.some((w) => w.releases !== 0)) {
      fail(step, `answered ${empty.status}: ${empty.text.slice(0, 400)}`);
    }
    pass("with no release recorded, the tiles read none and no latest, the rows are empty, and the weeks from the record's start stand");
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
