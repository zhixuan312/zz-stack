#!/usr/bin/env node
/**
 * checks/console-platform-needs.ts — what needs attention on the platform's Status, how the doors did
 * and the records, read through the gateway's own identity gate and status route, and a resolve
 * through the console's own route and a real zz-core (AC-3.1, AC-3.2, AC-3.5, AC-3.9).
 *
 *   node checks/console-platform-needs.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL and a real zz-core on it (`withThrowawayCore`), seeds the people,
 * then the rows `seedNeeds` in scripts/schema/status-seed.ts declares, and serves the gateway's own
 * built identity middleware, `GET /api/console/platform/status` and
 * `POST /api/console/platform/bugs/:id/resolve` from this process, signed in with a real console
 * session cookie per person. What it establishes:
 *
 *   - before anything is recorded, a complete empty assessment reads `Nothing needs you` for the
 *     superadmin and `No known open issues` for a member, with a total of 0;
 *   - the shared predicate (`pendingRevisions`) answers exactly the seed's presented, unapproved
 *     current revisions of gated documents in open initiatives, longest waiting first;
 *   - over the seed's nine instances (an open report blocking work, two doors with a fault day so
 *     far today, findings waiting 14 days, three teams with a revision waiting 14 days, both
 *     latencies doubled), the superadmin's five rows and the overflow by kind add up to the total, as
 *     do a member's, whose approvals fold into one row naming no team and linking nowhere; the
 *     wording differs as the spec says; every link is null or a console page that exists; and no
 *     team's slug or id reaches the member;
 *   - each door's days run from where the record begins through today, today not complete; its
 *     totals, fault days, last fault day, run and finding are the seed's; a malformed call marks no
 *     fault day and a tool failure does, one of each on one day;
 *   - the records: days in a row with work, days under 1% tool failures across every door, and the
 *     longest run of those, the earlier of two that tie;
 *   - one check that cannot be read makes the needs partial with that kind named, the total null,
 *     the rest still known, and the headline says some checks are unavailable; every check failing
 *     reads `Status checks unavailable`;
 *   - resolving the one open real report through the console's route removes the `bugs` instance,
 *     lowers the total by one, and changes no other kind's count.
 *
 * DELIBERATE: the reporting timezone is Asia/Singapore, eight hours ahead of UTC, so a day cut on
 * UTC's calendar misplaces every call the seed puts at local noon or after local midnight.
 *
 * The only database it touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Express, RequestHandler } from "express";
import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import {
  NEEDS, NEEDS_MEMBER, NEEDS_SUPERADMIN, NEEDS_TEAMS, dayStart, seedNeeds, seedNeedsPeople, signIn, weekStart,
} from "../scripts/schema/status-seed.ts";
import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";

const NAME = "console-platform-needs";
const DONE = "console-platform-needs: what needs attention is counted in instances, projected for the superadmin and a " +
  "member, cut to five rows with the rest counted by kind, said as unavailable when a check is, and moves by one when " +
  "the open report is resolved; each door's days, totals, run and finding, and the records, are the seed's: ok";
const TIMEZONE = "Asia/Singapore";
const DAY = 86_400_000;
/** COUPLED: the console's checkout, `../zz-stack-dashboard` here and in CI; a link must open one of its pages. */
const CONSOLE = join(root, "..", "zz-stack-dashboard", "app", "(dash)");

type Obj = Record<string, unknown>;
type Answer = { status: number; body: Obj; text: string };
type Need = { kind: string; title: string; detail: string; instanceCount: number; oldestAt: string | null; href: string | null; tone: string };
type Needs = { state: string; rows: Need[]; total: number | null; knownCount: number; unavailableKinds: string[];
               overflowByKind: Record<string, number>; headline: string };
const KINDS = ["bugs", "door", "evaluation", "approvals", "drift"];

async function run(c: Core): Promise<void> {
  await seedNeedsPeople(c.sql);
  const cookie = new Map<string, string>();
  for (const email of [NEEDS_SUPERADMIN, NEEDS_MEMBER]) cookie.set(email, await signIn(c.sql, email));

  // `withThrowawayDb` ended the gateway's pool after migrating; a fresh one on the same container, the reporting
  // timezone set before shared.js reads it at load, and the resolve route reaching the harness's own zz-core.
  process.env.TEAM_DB_URL = c.url;
  process.env.ZZ_TZ = TIMEZONE;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  process.env.CORE_MCP_URL = c.mcp.url;
  const load = (p: string) => import(pathToFileURL(join(root, p)).href);
  const express = (await import("express")).default;
  const dbModule = (await load("services/gateway/dist/db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await dbModule.initPlatformDb();
  const { identityMiddleware } = (await load("services/gateway/dist/identity.js")) as { identityMiddleware: () => RequestHandler };
  const { mountPlatformStatus } = (await load("services/gateway/dist/console/platform-status.js")) as { mountPlatformStatus: (app: Express) => void };
  const { mountPlatformBugResolve } = (await load("services/gateway/dist/console/platform-bug-resolve.js")) as
    { mountPlatformBugResolve: (app: Express) => void };
  const { pendingRevisions } = (await load("services/gateway/dist/console/pending.js")) as
    { pendingRevisions: (asOf: string) => Promise<{ team: string; teamId: string; initiative: string; path: string; revision: number; presentedMs: number }[]> };
  const app = express();
  // COUPLED: services/gateway/src/server.ts — the body parser and the identity gate before every console route.
  app.use(express.json());
  app.use(identityMiddleware());
  mountPlatformStatus(app);
  mountPlatformBugResolve(app);
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/console`;
  const call = async (email: string, path: string, body?: unknown): Promise<Answer> => {
    const res = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(60_000),
      headers: { cookie: `zz_console=${cookie.get(email)}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: Obj = {};
    try { const v: unknown = JSON.parse(text); if (v !== null && typeof v === "object") parsed = v as Obj; } catch { /* no JSON: stays empty */ }
    return { status: res.status, body: parsed, text };
  };
  const status = async (step: string, email: string): Promise<Answer> => {
    const a = await call(email, "/platform/status");
    if (a.status !== 200) c.fail(step, `answered ${a.status}: ${a.text.slice(0, 400)}`);
    return a;
  };
  const needsOf = (a: Answer): Needs => a.body.needs as Needs;
  /** Instances by kind: the rows' counts and the overflow's. */
  const byKind = (n: Needs): Record<string, number> => {
    const out = Object.fromEntries(KINDS.map((k) => [k, n.overflowByKind[k] ?? 0]));
    for (const r of n.rows) out[r.kind] += r.instanceCount;
    return out;
  };

  try {
    let step = "a complete empty assessment";
    for (const [email, headline] of [[NEEDS_SUPERADMIN, "Nothing needs you"], [NEEDS_MEMBER, "No known open issues"]]) {
      const n = needsOf(await status(step, email));
      const want = { state: "complete", rows: [], total: 0, knownCount: 0, unavailableKinds: [], overflowByKind: {}, headline };
      if (JSON.stringify(n) !== JSON.stringify(want)) c.fail(step, `${email} reads ${JSON.stringify(n)}`);
    }
    c.pass("before anything is recorded the superadmin reads Nothing needs you and a member No known open issues, total 0");

    const now = Date.now();
    const open = await seedNeeds(c.sql, TIMEZONE, now);
    const date = (k: number): string => new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(new Date(dayStart(now, k, TIMEZONE)));
    const coverage = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(new Date(weekStart(now, 6, TIMEZONE)));
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const said = (d: string): string => `${Number(d.slice(8))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;

    step = "the shared predicate";
    const pending = await pendingRevisions(new Date().toISOString());
    const got = pending.map((p) => [p.team, p.path, p.revision, Math.round((now - p.presentedMs) / DAY)]);
    const want = NEEDS.pending.map(([t, path, revision, days]) => [NEEDS_TEAMS[t], path, revision, days]);
    if (JSON.stringify(got) !== JSON.stringify(want)) c.fail(step, `answered ${JSON.stringify(got)}, not ${JSON.stringify(want)}`);
    c.pass("pendingRevisions answers exactly the presented, unapproved current revisions of gated documents in open initiatives, " +
           "longest waiting first: not an approved one, a closed initiative's, an ungated document's, one never presented or one with no flow");

    const admin = await status("the superadmin's read", NEEDS_SUPERADMIN);
    const member = await status("a member's read", NEEDS_MEMBER);

    step = "the doors";
    const doors = admin.body.doors as { state: string; data: Obj[] };
    if (doors.state !== "ok" || doors.data.map((d) => d.door).join() !== "core,manage,eval") c.fail(step, JSON.stringify(doors).slice(0, 400));
    for (const d of doors.data) {
      const want = NEEDS.doors[d.door as keyof typeof NEEDS.doors];
      const days = d.days as { date: string; calls: number; toolFailures: number; state: string; complete: boolean }[];
      const problems: string[] = [];
      if (days[0]?.date !== coverage || days.at(-1)?.date !== date(0)) problems.push(`days run ${days[0]?.date} to ${days.at(-1)?.date}, not ${coverage} to ${date(0)}`);
      if (days.some((x, i) => x.complete !== (i < days.length - 1))) problems.push("a day other than today is not complete, or today is");
      const run = want.run === null ? null : { days: want.run.days, atLeast: want.run.atLeast, through: date(want.run.through) };
      const totals = { calls: want.calls, toolFailures: want.toolFailures, others: want.others, faultDays: want.faultDays,
                       lastFaultDay: want.lastFaultDay === null ? null : date(want.lastFaultDay) };
      if (JSON.stringify(d.totals) !== JSON.stringify(totals)) problems.push(`totals ${JSON.stringify(d.totals)}, not ${JSON.stringify(totals)}`);
      if (JSON.stringify(d.run) !== JSON.stringify(run)) problems.push(`run ${JSON.stringify(d.run)}, not ${JSON.stringify(run)}`);
      const text = want.finding.text.replace("{1}", said(date(1))).replace("{coverage}", said(coverage));
      const f = d.finding as Obj;
      if (f.kind !== want.finding.kind || f.text !== text) problems.push(`finding ${JSON.stringify(f)}, not ${want.finding.kind} "${text}"`);
      if (days.at(-1)?.state !== want.today) problems.push(`today reads ${days.at(-1)?.state}, not ${want.today}`);
      for (const [k, state] of Object.entries(NEEDS.states[d.door as keyof typeof NEEDS.states])) {
        const x = days.find((y) => y.date === date(Number(k)));
        if (x?.state !== state) problems.push(`D-${k} reads ${JSON.stringify(x)}, not ${state}`);
      }
      if (problems.length) c.fail(step, `${String(d.door)}: ${problems.join("; ")}`);
    }
    c.pass("each door's days run from where the record begins through today, today not complete, with the seed's totals, fault " +
           "days, last fault day, run and finding; on D-2 core's malformed call marks nothing and manage's tool failure marks the day");

    step = "the records";
    const records = admin.body.records as { state: string; data: Obj };
    const l = NEEDS.records.longest;
    const wantRecords = { daysWithWork: NEEDS.records.daysWithWork, daysUnderOnePercent: NEEDS.records.daysUnderOnePercent,
                          longestUnderOnePercent: { days: l.days, from: date(l.from), to: date(l.to) } };
    if (records.state !== "ok" || JSON.stringify(records.data) !== JSON.stringify(wantRecords)) {
      c.fail(step, `${JSON.stringify(records)}, not ${JSON.stringify(wantRecords)}`);
    }
    c.pass("19 days in a row with work to yesterday, 21 days under 1% tool failures across every door, and the longest run of 9 " +
           "is the earlier of two that tie");

    step = "the superadmin's needs";
    const a = needsOf(admin);
    const rows = (n: Needs) => JSON.stringify(n.rows.map((r) => [r.kind, r.tone, r.instanceCount]));
    const sum = (n: Needs) => n.rows.reduce((s, r) => s + r.instanceCount, 0) + Object.values(n.overflowByKind).reduce((s, v) => s + v, 0);
    const doorTitles = a.rows.filter((r) => r.kind === "door").map((r) => r.title);
    const approvals = a.rows.find((r) => r.kind === "approvals");
    if (a.state !== "complete" || a.total !== 9 || a.knownCount !== 9 || a.unavailableKinds.length || sum(a) !== 9
        || rows(a) !== JSON.stringify(NEEDS.superadmin.rows) || JSON.stringify(a.overflowByKind) !== JSON.stringify(NEEDS.superadmin.overflowByKind)
        || a.headline !== NEEDS.superadmin.headline || JSON.stringify(byKind(a)) !== JSON.stringify(NEEDS.instances)
        || !doorTitles[0]?.includes(" core ") || !doorTitles[1]?.includes(" manage ")
        || approvals?.href !== `/teams/${NEEDS_TEAMS[NEEDS.superadmin.approvalsTeam]}` || !approvals.title.includes(NEEDS_TEAMS[NEEDS.superadmin.approvalsTeam])) {
      c.fail(step, JSON.stringify(a));
    }
    c.pass("the superadmin reads 9 things need you: five rows worst first, the oldest team's approvals linked to its page, " +
           "and 2 approvals and 2 drifts in the overflow, adding up to the total");

    step = "a member's needs";
    const m = needsOf(member);
    const folded = m.rows.find((r) => r.kind === "approvals");
    if (m.state !== "complete" || m.total !== 9 || sum(m) !== 9 || rows(m) !== JSON.stringify(NEEDS.member.rows)
        || JSON.stringify(m.overflowByKind) !== JSON.stringify(NEEDS.member.overflowByKind) || m.headline !== NEEDS.member.headline
        || folded?.href !== null || NEEDS_TEAMS.some((t) => folded.title.includes(t) || folded.detail.includes(t))) {
      c.fail(step, JSON.stringify(m));
    }
    const ids = (await c.sql.query<{ id: string }>("select id::text as id from zz.team where slug = any($1)", [NEEDS_TEAMS])).rows.map((r) => r.id);
    const leak = [...NEEDS_TEAMS, ...ids].find((t) => member.text.includes(t));
    if (leak) c.fail(step, `the member's answer holds ${leak}`);
    c.pass("a member reads 9 things are known and open: three teams' approvals fold into one row naming none and linking " +
           "nowhere, and no team's slug or id is anywhere in the answer");

    step = "every link opens a released page";
    for (const r of [...a.rows, ...m.rows]) {
      if (r.href === null) continue;
      const slug = /^\/teams\/([a-z0-9_-]+)$/.exec(r.href)?.[1];
      if (!slug || !existsSync(join(CONSOLE, "teams", "[slug]", "page.tsx"))) c.fail(step, `${r.kind} links ${r.href}`);
    }
    c.pass("every link is null or a team's page, which the console already serves; Bugs, Evaluation and Usage rows link nowhere yet");

    step = "a check that cannot be read";
    const pool = dbModule.platformDb();
    const real = pool.query.bind(pool) as (text: unknown, params?: unknown[]) => Promise<unknown>;
    const failing = async (marks: string[]): Promise<Answer> => {
      (pool as unknown as { query: unknown }).query = (text: unknown, params?: unknown[]) =>
        typeof text === "string" && marks.some((x) => text.includes(x)) ? Promise.reject(new Error("injected by the check")) : real(text, params);
      try { return await status(step, NEEDS_SUPERADMIN); } finally { (pool as unknown as { query: unknown }).query = real; }
    };
    const MARKS: Record<string, string> = {
      bugs: "chain-check probe", door: "split_part(e.tool_key", evaluation: "from zz.eval_finding f",
      approvals: "r.revision = d.current_revision", drift: "percentile_cont",
    };
    for (const kind of KINDS) {
      const x = await failing([MARKS[kind]]);
      const n = needsOf(x);
      const known = 9 - NEEDS.instances[kind as keyof typeof NEEDS.instances];
      if (n.state !== "partial" || n.total !== null || n.knownCount !== known || JSON.stringify(n.unavailableKinds) !== JSON.stringify([kind])
          || n.headline !== `${known} known issues; some checks unavailable` || n.rows.some((r) => r.kind === kind)) {
        c.fail(step, `${kind}: ${JSON.stringify(n)}`);
      }
      if (kind === "door" && ((x.body.doors as Obj).state !== "unavailable" || (x.body.records as Obj).state !== "unavailable")) {
        c.fail(step, `door: doors ${JSON.stringify(x.body.doors).slice(0, 200)}, records ${JSON.stringify(x.body.records).slice(0, 200)}`);
      }
    }
    const none = needsOf(await failing(Object.values(MARKS)));
    if (none.state !== "unavailable" || none.total !== null || none.knownCount !== 0 || none.headline !== "Status checks unavailable"
        || JSON.stringify(none.unavailableKinds) !== JSON.stringify(KINDS)) {
      c.fail(step, `every check failing: ${JSON.stringify(none)}`);
    }
    c.pass("one check that cannot be read makes the needs partial with its kind named, the total null and the rest known " +
           "(N known issues; some checks unavailable); every check failing reads Status checks unavailable");

    step = "resolving the open report";
    const closed = await call(NEEDS_SUPERADMIN, `/platform/bugs/${open}/resolve`, { status: "fixed", resolution: "Fixed for the needs check." });
    if (closed.status !== 204) c.fail(step, `the resolve answered ${closed.status}: ${closed.text.slice(0, 300)}`);
    for (const [who, before] of [[NEEDS_SUPERADMIN, a], [NEEDS_MEMBER, m]] as const) {
      const after = needsOf(await status(step, who));
      const moved = { ...byKind(before), bugs: 0 };
      if (after.total !== 8 || after.knownCount !== 8 || after.state !== "complete" || after.rows.some((r) => r.kind === "bugs")
          || JSON.stringify(byKind(after)) !== JSON.stringify(moved)) {
        c.fail(step, `${who} reads ${JSON.stringify(after)}`);
      }
    }
    c.pass("resolving the one open real report through the console's route removes the bugs need, lowers the total to 8, and no other kind moves");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await dbModule.platformDb().end().catch(() => undefined);
    delete process.env.ZZ_TZ;
    delete process.env.ZZ_CATALOG_DIR;
    delete process.env.CORE_MCP_URL;
  }
}

process.exitCode = await withThrowawayCore(NAME, DONE, run);
