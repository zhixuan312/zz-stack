#!/usr/bin/env node
/**
 * checks/console-bug-title.ts — a member reads every bug report by a title built from what they may see
 * of it, its impact, its canonical surface and the day it was filed, so their own team's reports read
 * apart while no word a reporter wrote reaches them (AC-1.8, AC-8.4).
 *
 *   node checks/console-bug-title.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL migrated by the real runner, seeds what `scripts/schema/bugs-seed.ts`
 * declares, and serves the gateway's built identity middleware and
 * `services/gateway/dist/console/platform-bugs.js` from this process, signed in with real console
 * session cookies, as `checks/console-platform-bugs.ts` does. What it establishes:
 *
 *   - each of the member's own team's reports (R1, R2, R6, R7, R10) is titled by its impact, its
 *     canonical surface or `no surface named`, and the day it was filed in the reporting timezone,
 *     exactly `<Impact>: <surface>, filed <day>`, and no two of them read alike; neither do the
 *     reports with no canonical surface, whatever their team (R3, R4, R6);
 *   - no word of any report's own title reaches the member: not the title anywhere in the answer,
 *     and not one of its words a template or a surface does not already say in a title they read;
 *   - the superadmin's rows carry the same built title beside the reporter's own, unchanged;
 *   - the console's fake answers a member the same way: each title built from its row's impact,
 *     surface and filed day in the console's timezone, its own team's titles apart, and no word of
 *     a report's own title in it.
 *
 * The only database it touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";

import type { Express, RequestHandler } from "express";
import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import { EXPECTED, REPORTS, seedBugs } from "../scripts/schema/bugs-seed.ts";
import { MEMBER, SUPERADMIN, signIn, type Seeded } from "../scripts/schema/status-seed.ts";
import { withThrowawayDb } from "../scripts/schema/throwaway.ts";

const NAME = "console-bug-title";
const DONE = "console-bug-title: a member reads each report by its impact, surface and filed day, their own team's apart, " +
  "and no word a reporter wrote: ok";
const TIMEZONE = "Pacific/Auckland";
/** COUPLED: the fake answer in the console's checkout, `../zz-stack-dashboard` here and in CI. */
const FAKE = join(root, "..", "zz-stack-dashboard", "scripts", "fake-gateway", "platform-bugs.ts");
/** The console's own timezone (`app.timezone`), which the fake's titles are dated in. */
const CONSOLE_TIMEZONE = "Asia/Singapore";

/** The member's own team's reports, and the reports no canonical surface names. */
const OWN = ["R1", "R2", "R6", "R7", "R10"] as const;
const UNNAMED = ["R3", "R4", "R6"] as const;

const IMPACT: Record<string, string> = { blocks_work: "Blocks work", wrong_result: "Wrong result", confusing: "Confusing", cosmetic: "Cosmetic" };
const dayIn = (timeZone: string, ms: number): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short", year: "numeric" }).format(new Date(ms));
/** A withheld title, as the contract builds it. */
const titleOf = (impact: string, surface: string | null, day: string): string => `${IMPACT[impact]}: ${surface ?? "no surface named"}, filed ${day}`;

class CaseFailure extends Error {}
function fail(step: string, detail: string): never {
  throw new CaseFailure(`${NAME}: FAILED at "${step}": ${detail}`);
}
const pass = (line: string): void => console.log(`  ok  ${line}`);

type Obj = Record<string, unknown>;
type Key = keyof typeof REPORTS;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * The first of a report's own words found where a member reads: its whole title anywhere in the answer, or, in
 * the titles they are given, a run of its letters five long or more that a withheld title's template or a
 * canonical surface does not already say. Null when none is.
 */
function leakOf(title: string, answer: string, titles: string[], surfaces: string[]): string | null {
  if (answer.includes(title)) return title;
  const said = `${Object.values(IMPACT).join(" ")} no surface named filed ${surfaces.join(" ")}`.toLowerCase();
  const shown = titles.join(" | ").toLowerCase();
  return title.split(/[^A-Za-z]+/).find((w) => w.length >= 5 && !said.includes(w.toLowerCase()) && shown.includes(w.toLowerCase())) ?? null;
}
const titlesOf = (rows: Obj[]) => rows.map((r) => String(r.title));
const surfacesOf = (rows: Obj[]) => rows.map((r) => String(r.surface ?? ""));

/** A queue answer's rows, or a failure naming what came instead. */
function rowsOf(step: string, status: number, body: Obj, text: string): Obj[] {
  const q = body.queue as Obj | undefined;
  if (status !== 200 || !isObj(q) || q.state !== "ok" || !isObj(q.data) || !Array.isArray(q.data.rows)) {
    fail(step, `answered ${status}: ${text.slice(0, 400)}`);
  }
  return q.data.rows as Obj[];
}

function memberCases(seeded: Seeded, rows: Obj[], text: string): void {
  let step = "the member's own team's reports";
  const byKey = (k: Key) => rows.find((r) => r.id === REPORTS[k].id) ?? fail(step, `${k} is not in the member's queue`);
  const filedMs = (k: Key) => seeded.starts.get(REPORTS[k].back)! + REPORTS[k].hours * 3_600_000;
  for (const k of OWN) {
    const want = titleOf(REPORTS[k].impact, EXPECTED.surface[k as keyof typeof EXPECTED.surface], dayIn(TIMEZONE, filedMs(k)));
    if (byKey(k).title !== want) fail(step, `${k} is titled ${JSON.stringify(byKey(k).title)}, not ${JSON.stringify(want)}`);
  }
  const own = OWN.map((k) => String(byKey(k).title));
  if (new Set(own).size !== own.length) fail(step, `two of the team's reports read alike: ${own.join(" | ")}`);
  const unnamed = UNNAMED.map((k) => String(byKey(k).title));
  if (new Set(unnamed).size !== unnamed.length) fail(step, `two reports with no surface read alike: ${unnamed.join(" | ")}`);
  pass(`R1, R2, R6, R7 and R10 read ${own.map((t) => `"${t}"`).join(", ")}: impact, surface and day filed, each apart, ` +
       "and R3, R4 and R6, with no surface named, read apart too");

  step = "no word a reporter wrote";
  for (const [k, r] of Object.entries(REPORTS)) {
    const leaked = leakOf(r.title, text, titlesOf(rows), surfacesOf(rows));
    if (leaked) fail(step, `the member's answer holds ${JSON.stringify(leaked)} of ${k}'s own title`);
  }
  pass("no report's own title, and no word of one a template or its surface does not say, is in the member's answer");
}

function fakeCases(fake: { bugs: (admin: boolean, f: Obj, limit: number, offset: number) => Obj; REPORTS: Obj[] }): void {
  const step = "the console's fake";
  const body = fake.bugs(false, { state: null, impact: null, surface: null }, 100, 0);
  const rows = rowsOf(step, 200, body, JSON.stringify(body));
  for (const r of rows) {
    const want = titleOf(String(r.impact), (r.surface as string | null) ?? null, dayIn(CONSOLE_TIMEZONE, Date.parse(String(r.filedAt))));
    if (r.title !== want) fail(step, `${String(r.id)} is titled ${JSON.stringify(r.title)}, not ${JSON.stringify(want)}`);
  }
  const team = (t: string) => fake.REPORTS.filter((r) => r.team === t).map((r) => String(rows.find((x) => x.id === r.id)?.title));
  for (const t of new Set(fake.REPORTS.map((r) => r.team).filter((x): x is string => typeof x === "string"))) {
    const titles = team(t);
    if (new Set(titles).size !== titles.length) fail(step, `two of ${t}'s reports read alike: ${titles.join(" | ")}`);
  }
  for (const r of fake.REPORTS) {
    const leaked = leakOf(String(r.title), JSON.stringify(body), titlesOf(rows), surfacesOf(rows));
    if (leaked) fail(step, `the fake's member answer holds ${JSON.stringify(leaked)} of ${String(r.id)}'s own title`);
  }
  pass("the fake titles a member's rows the same way, each team's apart, with no word of a report's own title");
}

async function run(db: pg.Client, url: string): Promise<void> {
  const seeded = await seedBugs(db, TIMEZONE);
  const cookie = new Map<string, string>();
  for (const email of [MEMBER, SUPERADMIN]) cookie.set(email, await signIn(db, email));

  process.env.TEAM_DB_URL = url;
  process.env.ZZ_TZ = TIMEZONE;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  const load = (p: string) => import(pathToFileURL(join(root, p)).href);
  const express = (await import("express")).default;
  const dbModule = (await load("services/gateway/dist/db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await dbModule.initPlatformDb();
  const { identityMiddleware } = (await load("services/gateway/dist/identity.js")) as { identityMiddleware: () => RequestHandler };
  const { mountPlatformBugs } = (await load("services/gateway/dist/console/platform-bugs.js")) as { mountPlatformBugs: (app: Express) => void };
  const app = express();
  // COUPLED: services/gateway/src/server.ts — the identity gate before every console route.
  app.use(identityMiddleware());
  mountPlatformBugs(app);
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/console/platform/bugs`;
  const as = async (email: string): Promise<{ status: number; body: Obj; text: string }> => {
    const res = await fetch(`${base}?limit=100`, { headers: { cookie: `zz_console=${cookie.get(email)}` }, signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    let body: Obj = {};
    try { const v: unknown = JSON.parse(text); if (isObj(v)) body = v; } catch { /* not JSON: body stays empty */ }
    return { status: res.status, body, text };
  };

  try {
    const member = await as(MEMBER);
    const rows = rowsOf("the member's queue", member.status, member.body, member.text);
    memberCases(seeded, rows, member.text);

    const step = "the superadmin's rows";
    const admin = await as(SUPERADMIN);
    for (const r of rowsOf(step, admin.status, admin.body, admin.text)) {
      const k = (Object.keys(REPORTS) as Key[]).find((x) => REPORTS[x].id === r.id);
      const same = rows.find((x) => x.id === r.id);
      if (!k || !same || r.title !== same.title || r.internalTitle !== REPORTS[k].title) {
        fail(step, `${String(r.id)} reads ${JSON.stringify(r.title)} beside ${JSON.stringify(r.internalTitle)}`);
      }
    }
    pass("the superadmin's rows carry the same built title beside the reporter's own, unchanged");

    let fake: { bugs: (admin: boolean, f: Obj, limit: number, offset: number) => Obj; REPORTS: Obj[] };
    try {
      fake = (await import(pathToFileURL(FAKE).href)) as typeof fake;
    } catch (err) {
      fail("the console's fake", `could not read the console's fake answer at ${FAKE}: ${(err as Error).message}`);
    }
    fakeCases(fake);
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
