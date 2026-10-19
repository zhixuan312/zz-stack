#!/usr/bin/env node
/**
 * checks/console-platform-bugs.ts — the bug queue read in two projections, the safe one for everybody
 * and the report for the superadmin, through the gateway's own identity gate and routes on a real
 * database (AC-2.4, AC-3.5, AC-3.6).
 *
 *   node checks/console-platform-bugs.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL migrated by the real runner, seeds what
 * `scripts/schema/bugs-seed.ts` declares, and serves the gateway's built identity middleware and
 * `services/gateway/dist/console/platform-bugs.js` from this process, signed in with real console
 * session cookies. What it establishes, against the seed's written values:
 *
 *   - real reports leave out the release check's own, by its initiative's slug and by the probe's
 *     title, and keep a report whose title only resembles it; `realReports` answers them newest
 *     first, with no text a reporter wrote;
 *   - the counts, the oldest open report, the median hours to resolve, and each weekly cohort's
 *     filed, resolved, still-open, reports per 1,000 real-work calls of the same week and median;
 *   - the queue newest first with the id breaking a tie, filtered by state, impact and a canonical
 *     surface, paged, and refusing a value it does not know;
 *   - a member's rows hold exactly the public keys, the title built from the impact, the canonical
 *     surface and the day filed, an unknown surface null, and the member's whole answer holds no title, detail,
 *     resolution, raw surface, team, reporter, initiative or email; the superadmin's answer differs
 *     only by its scope and the internal title and team on each row; a person in no team, and a
 *     `?team=` or `?scope=`, change nothing;
 *   - a report and its duplicate targets answer the superadmin alone: a member is refused 403 with
 *     no name, an unknown id answered 404 with no body, and the targets are exactly the reports
 *     `bug_resolve` would accept;
 *   - no session is 401 and a member's token 403; a query that fails is 500 with nothing partial;
 *   - every answer agrees in shape with the console's fake one, key set by key set;
 *   - no read changed a row of `zz.bug`.
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
import { EXPECTED, INITIATIVES, REPORTS, seedBugs } from "../scripts/schema/bugs-seed.ts";
import { MEMBER, NO_TEAM, SUPERADMIN, TEAM_TWO, signIn, type Seeded } from "../scripts/schema/status-seed.ts";
import { withThrowawayDb } from "../scripts/schema/throwaway.ts";

const NAME = "console-platform-bugs";
const DONE = "console-platform-bugs: the bug queue's figures and rows are answered over real reports, a member's in the " +
  "safe projection and the report and its duplicate targets to the superadmin alone, in the fake's shapes: ok";
const TIMEZONE = "Pacific/Auckland";
/** A withheld title's words for an impact, and its day in the seed's timezone: `Blocks work: document_approve, filed 14 Sept 2026`. */
const IMPACT_WORDS: Record<string, string> = { blocks_work: "Blocks work", wrong_result: "Wrong result", confusing: "Confusing", cosmetic: "Cosmetic" };
const FILED_DAY = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, day: "2-digit", month: "short", year: "numeric" });
/** COUPLED: the fake answer in the console's checkout, `../zz-stack-dashboard` here and in CI. */
const FAKE = join(root, "..", "zz-stack-dashboard", "scripts", "fake-gateway", "platform-bugs.ts");
const UNKNOWN = "b0000000-0000-4000-8000-0000000000ff";

const PUBLIC_ROW = ["filedAt", "id", "impact", "platformVersion", "resolvedAt", "status", "surface", "title"];
const ADMIN_ROW = [...PUBLIC_ROW, "internalTitle", "team"].sort();
const REPORT_KEYS = ["detail", "duplicateOf", "id", "impact", "platformVersion", "reportedAt", "resolution",
  "resolvedAt", "status", "surface", "team", "title"];
const REAL_KEYS = ["id", "impact", "platformVersion", "reportedMs", "resolvedMs", "status", "surface", "teamId"];

class CaseFailure extends Error {}
function fail(step: string, detail: string): never {
  throw new CaseFailure(`${NAME}: FAILED at "${step}": ${detail}`);
}
const pass = (line: string): void => console.log(`  ok  ${line}`);

type Obj = Record<string, unknown>;
type Key = keyof typeof REPORTS;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const keys = (v: unknown): string => (isObj(v) ? Object.keys(v).sort().join(",") : `not an object: ${JSON.stringify(v)}`);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

interface Answer { status: number; body: Obj; text: string }

/** Where two answers' shapes differ: at an object both hold, the key sets; at an array both hold,
 *  the first elements, the same way; a null on either side, nothing. */
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

/** The key a row's id names in the seed. */
const keyOf = (id: unknown): string => Object.entries(REPORTS).find(([, r]) => r.id === id)?.[0] ?? `unseeded ${String(id)}`;

/** A list answer's queue rows, or a failure naming what came instead. */
function rowsOf(step: string, a: Answer): Obj[] {
  const q = a.body.queue as Obj | undefined;
  if (a.status !== 200 || !isObj(q) || q.state !== "ok" || !isObj(q.data) || !Array.isArray(q.data.rows)) {
    fail(step, `answered ${a.status}: ${a.text.slice(0, 400)}`);
  }
  return q.data.rows as Obj[];
}

/** What a report's public row must read, from the seed: its instants from the week it was placed in. */
function publicRow(seeded: Seeded, key: Exclude<Key, "P1" | "P2">): Obj {
  const r = REPORTS[key];
  const filed = seeded.starts.get(r.back)! + r.hours * 3_600_000;
  const surface = EXPECTED.surface[key];
  return {
    id: r.id, title: `${IMPACT_WORDS[r.impact]}: ${surface ?? "no surface named"}, filed ${FILED_DAY.format(new Date(filed))}`, impact: r.impact,
    surface, filedAt: iso(filed), platformVersion: r.platformVersion, status: r.status,
    resolvedAt: r.resolvedAfter === null ? null : iso(filed + r.resolvedAfter * 3_600_000),
  };
}

function figureCases(seeded: Seeded, a: Answer): void {
  let step = "the counts, the oldest open report and the median";
  const counts = a.body.counts as Obj;
  const want = { state: "ok", data: { open: EXPECTED.open, resolved: EXPECTED.resolved, byImpact: EXPECTED.byImpact, byStatus: EXPECTED.byStatus } };
  if (!same(sortDeep(counts), sortDeep(want))) {
    fail(step, `counts read ${JSON.stringify(counts)}, not ${JSON.stringify(want)}`);
  }
  const oldest = publicRow(seeded, EXPECTED.oldestOpen).filedAt;
  if (a.body.oldestOpenAt !== oldest) fail(step, `oldestOpenAt reads ${String(a.body.oldestOpenAt)}, not ${String(oldest)} (${EXPECTED.oldestOpen})`);
  if (!same(a.body.medianResolveHours, { value: EXPECTED.medianHours, why: null })) {
    fail(step, `medianResolveHours reads ${JSON.stringify(a.body.medianResolveHours)}, not ${EXPECTED.medianHours}`);
  }
  pass(`5 open and 5 resolved real reports, by impact and outcome as seeded, the oldest open ${EXPECTED.oldestOpen}, ` +
       `and a median of ${EXPECTED.medianHours} hours to resolve`);

  step = "the weekly cohorts";
  const cohorts = a.body.cohorts as Obj[];
  if (!Array.isArray(cohorts) || cohorts.length !== EXPECTED.cohorts.length) {
    fail(step, `${Array.isArray(cohorts) ? cohorts.length : "no"} cohorts, not ${EXPECTED.cohorts.length} from L-4 through the running week`);
  }
  for (const [i, c] of EXPECTED.cohorts.entries()) {
    const fig = (value: number | null, why: string | null) => ({ value, why });
    const wantCohort = {
      week: iso(seeded.starts.get(c.back)!), filed: fig(c.filed, null), resolved: fig(c.resolved, null),
      stillOpen: fig(c.stillOpen, null), filedPer1000: fig(c.per1000, c.per1000Why), medianResolveHours: fig(c.median, c.medianWhy),
    };
    if (!same(sortDeep(cohorts[i]), sortDeep(wantCohort))) fail(step, `back ${c.back} reads ${JSON.stringify(cohorts[i])}, not ${JSON.stringify(wantCohort)}`);
  }
  pass("each week from L-4 to the running one: filed, resolved and still open, reports per 1,000 real-work calls of the " +
       "same week (no data with none, insufficient under 30) and the median of its resolved");

  step = "meta";
  const meta = a.body.meta as Obj;
  const from = iso(seeded.starts.get(5)!);
  if (meta.scope !== "platform-public" || meta.timezone !== TIMEZONE || meta.coverageFrom !== from || meta.population !== "real bug reports"
      || !isObj(meta.period) || meta.period.from !== from || meta.period.to !== meta.asOf) {
    fail(step, JSON.stringify(meta));
  }
  pass(`meta reads platform-public in ${TIMEZONE}, real bug reports, coverage from the first real-work call`);
}

/** A value with every object's keys in order, so two answers compare by content alone. */
function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
  return v;
}

async function queueCases(seeded: Seeded, as: (email: string, query?: string) => Promise<Answer>, member: Answer): Promise<void> {
  let step = "the queue, newest first";
  const rows = rowsOf(step, member);
  const order = rows.map((r) => keyOf(r.id));
  if (order.join() !== EXPECTED.real.join() || (member.body.queue as { data: Obj }).data.total !== EXPECTED.real.length) {
    fail(step, `the queue lists ${order.join(", ")} of ${String((member.body.queue as { data: Obj }).data.total)}, not ${EXPECTED.real.join(", ")} of 10`);
  }
  pass("the queue lists the ten real reports newest first, R9 before R8 at the same instant by its id, and leaves out P1 and P2");

  step = "a member's row is the safe projection";
  for (const [i, r] of rows.entries()) {
    if (keys(r) !== PUBLIC_ROW.join()) fail(step, `${keyOf(r.id)} has keys ${keys(r)}, not ${PUBLIC_ROW.join(",")}`);
    const want = publicRow(seeded, EXPECTED.real[i]);
    if (!same(sortDeep(r), sortDeep(want))) fail(step, `${EXPECTED.real[i]} reads ${JSON.stringify(r)}, not ${JSON.stringify(want)}`);
  }
  if (rows[1].title !== rows[2].title) fail(step, `R9 and R8 are titled ${String(rows[1].title)} and ${String(rows[2].title)}`);
  pass("each row is the title built from impact, surface and day filed, and typed metadata only; `Bug_Report` and `bug_report` read one title, and a " +
       "surface in no door's registered tools (team_switch), free text and none read `no surface named`, surface null");

  step = "nothing a reporter wrote reaches a member";
  const member2 = await as(MEMBER, "?limit=100");
  const secrets = [
    "SENTINEL", "chain-check", "team_switch", "MANAGE", "kestrel", TEAM_TWO, INITIATIVES.probe, INITIATIVES.real,
    MEMBER, SUPERADMIN, NO_TEAM, ...Object.values(REPORTS).map((r) => r.title),
  ];
  for (const text of [member.text, member2.text]) {
    const leaked = secrets.find((s) => text.includes(s));
    if (leaked) fail(step, `the member's answer holds ${leaked}`);
  }
  pass("the member's answer holds no title, detail, resolution, raw surface, team, initiative or email");

  step = "filters and pages";
  for (const [query, want] of Object.entries(EXPECTED.filtered)) {
    const a = await as(MEMBER, `?${query}`);
    const got = rowsOf(`${step}: ${query}`, a).map((r) => keyOf(r.id));
    if (got.join() !== want.join()) fail(step, `?${query} lists ${got.join(", ")}, not ${want.join(", ")}`);
  }
  const page = await as(MEMBER, "?limit=3&offset=2");
  if ((page.body.queue as { data: Obj }).data.total !== 10) fail(step, `a page reads total ${JSON.stringify(page.body.queue)}, not 10`);
  if (!same(sortDeep({ ...page.body, queue: null, meta: null }), sortDeep({ ...member.body, queue: null, meta: null }))) {
    fail(step, "a filter or a page moved a figure, which only the queue may");
  }
  for (const bad of ["state=closed", "impact=severe", "surface=team_switch", "surface=Bug_Report", "surface=core:bug_report",
                     "limit=0", "limit=101", "limit=2.5", "offset=-1", "state=open&state=resolved"]) {
    const a = await as(MEMBER, `?${bad}`);
    if (a.status !== 400 || typeof a.body.error !== "string" || "queue" in a.body) fail(step, `?${bad} answered ${a.status}: ${a.text.slice(0, 200)}`);
  }
  pass("state, impact and a canonical surface filter the queue alone, a page keeps the total, and an unknown state, " +
       "impact or surface, a surface not in the vocabulary's own spelling, or a page out of range is 400");
}

async function adminCases(as: (email: string, query?: string) => Promise<Answer>, member: Answer): Promise<void> {
  let step = "the superadmin's answer";
  const admin = await as(SUPERADMIN);
  const rows = rowsOf(step, admin);
  for (const r of rows) {
    if (keys(r) !== ADMIN_ROW.join()) fail(step, `${keyOf(r.id)} has keys ${keys(r)}, not ${ADMIN_ROW.join(",")}`);
    const seeded = REPORTS[keyOf(r.id) as Key];
    const team = seeded.team === "one" ? "kestrel-works" : seeded.team === "two" ? TEAM_TWO : null;
    if (r.internalTitle !== seeded.title || r.team !== team) fail(step, `${keyOf(r.id)} reads ${String(r.internalTitle)} of ${String(r.team)}`);
  }
  const strip = (b: Obj) => sortDeep({ ...b, meta: { ...(b.meta as Obj), asOf: null, period: null, scope: null },
    queue: { ...(b.queue as Obj), data: { ...((b.queue as { data: Obj }).data), rows: rowsOf(step, { status: 200, body: b, text: "" })
      .map(({ internalTitle: _t, team: _team, ...rest }) => rest) } } });
  if ((admin.body.meta as Obj).scope !== "platform-admin" || !same(strip(admin.body), strip(member.body))) {
    fail(step, `the superadmin's answer differs from the member's by more than its scope and rows: ${admin.text.slice(0, 400)}`);
  }
  pass("the superadmin reads platform-admin and the same figures and rows, each row adding its internal title and team");

  step = "the same for everybody else";
  for (const [who, query] of [[NO_TEAM, ""], [MEMBER, `?team=${TEAM_TWO}&scope=platform`]] as const) {
    const a = await as(who, query);
    if (!same(strip(a.body), strip(member.body)) || (a.body.meta as Obj).scope !== "platform-public") {
      fail(step, `${who}${query} reads ${a.text.slice(0, 300)}`);
    }
  }
  pass("a person in no team reads what the member reads, and a team or scope parameter changes nothing");
}

async function reportCases(seeded: Seeded, get: (path: string, email: string) => Promise<Answer>): Promise<void> {
  let step = "a report, to the superadmin";
  const r2 = REPORTS.R2;
  const filed = seeded.starts.get(r2.back)! + r2.hours * 3_600_000;
  const want = {
    id: r2.id, title: r2.title, detail: r2.detail, surface: r2.surface, impact: r2.impact, status: r2.status,
    platformVersion: r2.platformVersion, reportedAt: iso(filed), resolvedAt: iso(filed + r2.resolvedAfter! * 3_600_000),
    resolution: r2.resolution, duplicateOf: REPORTS.R1.id, team: "kestrel-works",
  };
  const a = await get(`/${r2.id}`, SUPERADMIN);
  if (a.status !== 200 || keys(a.body) !== REPORT_KEYS.join() || !same(sortDeep(a.body), sortDeep(want))) {
    fail(step, `R2 answered ${a.status}: ${a.text.slice(0, 400)}`);
  }
  pass("the superadmin reads R2's title, detail, raw surface, resolution, duplicate target and team");

  step = "duplicate targets, to the superadmin";
  for (const [key, targets] of Object.entries(EXPECTED.duplicates)) {
    const d = await get(`/${REPORTS[key as Key].id}/duplicates`, SUPERADMIN);
    const rows = (Array.isArray(d.body.rows) ? d.body.rows : []) as Obj[];
    if (d.status !== 200 || keys(d.body) !== "rows" || rows.map((r) => keyOf(r.id)).join() !== targets.join()) {
      fail(step, `${key}'s targets answered ${d.status}: ${d.text.slice(0, 300)}, not ${targets.join(", ")}`);
    }
    for (const r of rows) {
      const s = REPORTS[keyOf(r.id) as Key];
      if (keys(r) !== "id,reportedAt,status,title" || r.title !== s.title || r.status !== s.status
          || r.reportedAt !== iso(seeded.starts.get(s.back)! + s.hours * 3_600_000)) fail(step, `${key}'s target reads ${JSON.stringify(r)}`);
    }
  }
  pass("a report's targets are its team's other reports, no team matching no team, newest first, as bug_resolve accepts them");

  step = "a member is refused before anything is read";
  for (const path of [`/${r2.id}`, `/${r2.id}/duplicates`, `/${UNKNOWN}`, "/not-a-uuid", `/${UNKNOWN}/duplicates`]) {
    const m = await get(path, MEMBER);
    if (m.status !== 403 || m.text !== JSON.stringify({ error: "not permitted" })) fail(step, `${path} answered ${m.status}: ${m.text.slice(0, 200)}`);
  }
  pass("a member asking for a report or its targets, known, unknown or malformed, is 403 `not permitted` and nothing else");

  step = "an unknown report";
  for (const path of [`/${UNKNOWN}`, "/not-a-uuid", `/${UNKNOWN}/duplicates`, "/not-a-uuid/duplicates"]) {
    const s = await get(path, SUPERADMIN);
    if (s.status !== 404 || s.text !== "") fail(step, `${path} answered ${s.status}: ${s.text.slice(0, 200)}`);
  }
  pass("an id that is not a UUID, or names no report, is 404 with no body");
}

async function run(db: pg.Client, url: string): Promise<void> {
  const seeded = await seedBugs(db, TIMEZONE);
  const cookie = new Map<string, string>();
  for (const email of [MEMBER, SUPERADMIN, NO_TEAM]) cookie.set(email, await signIn(db, email));
  const pat = `zzp_${randomBytes(24).toString("hex")}`;
  await db.query("insert into zz.pat (principal_id, token_hash) select id, $2 from zz.principal where email = $1",
                 [MEMBER, createHash("sha256").update(pat, "utf8").digest("hex")]);
  const snapshot = async (): Promise<string> =>
    (await db.query<{ h: string }>("select md5(coalesce(string_agg(b::text, '|' order by b.id), '')) as h from zz.bug b")).rows[0].h;
  const before = await snapshot();

  process.env.TEAM_DB_URL = url;
  process.env.ZZ_TZ = TIMEZONE;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  const load = (p: string) => import(pathToFileURL(join(root, p)).href);
  const express = (await import("express")).default;
  const dbModule = (await load("services/gateway/dist/db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await dbModule.initPlatformDb();
  const { identityMiddleware } = (await load("services/gateway/dist/identity.js")) as { identityMiddleware: () => RequestHandler };
  const { mountPlatformBugs, realReports } = (await load("services/gateway/dist/console/platform-bugs.js")) as
    { mountPlatformBugs: (app: Express) => void; realReports: (asOf: string) => Promise<Obj[]> };
  const app = express();
  // COUPLED: services/gateway/src/server.ts — the identity gate before every console route.
  app.use(identityMiddleware());
  mountPlatformBugs(app);
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/console/platform/bugs`;
  const fetchAs = async (headers: Record<string, string>, path: string): Promise<Answer> => {
    const res = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    let body: Obj = {};
    try { const v: unknown = JSON.parse(text); if (isObj(v)) body = v; } catch { /* not JSON: body stays empty */ }
    return { status: res.status, body, text };
  };
  const get = (path: string, email: string): Promise<Answer> => fetchAs({ cookie: `zz_console=${cookie.get(email)}` }, path);
  const as = (email: string, query = ""): Promise<Answer> => get(query, email);

  try {
    let step = "the real reports";
    const real = await realReports(new Date().toISOString());
    if (real.map((r) => keyOf(r.id)).join() !== EXPECTED.real.join() || real.some((r) => keys(r) !== REAL_KEYS.join())) {
      fail(step, `realReports answered ${JSON.stringify(real).slice(0, 400)}`);
    }
    pass("realReports leaves out P1 by its initiative's slug and P2 by its title, keeps R6, and carries no reporter's text");

    const member = await as(MEMBER);
    figureCases(seeded, member);
    await queueCases(seeded, as, member);
    await adminCases(as, member);
    await reportCases(seeded, get);

    step = "refusals";
    const none = await fetchAs({}, "");
    if (none.status !== 401) fail(step, `no session answered ${none.status}: ${none.text.slice(0, 300)}`);
    const token = await fetchAs({ authorization: `Bearer ${pat}` }, "");
    if (token.status !== 403 || "queue" in token.body) fail(step, `a member's token answered ${token.status}: ${token.text.slice(0, 300)}`);
    pass("no session is refused with 401, and a member's token, which the console does not let in, with 403");

    step = "the shapes the console's fake answers";
    let fake: { bugs: (admin: boolean, f: Obj, limit: number, offset: number) => Obj; REPORTS: Obj[];
                bugReport: (id: string) => Obj; duplicates: (id: string) => Obj };
    try {
      fake = (await import(pathToFileURL(FAKE).href)) as typeof fake;
    } catch (err) {
      fail(step, `could not read the console's fake answer at ${FAKE}: ${(err as Error).message}`);
    }
    const none3 = { state: null, impact: null, surface: null };
    const fakeWithTargets = fake.REPORTS.map((r) => String(r.id)).find((id) => ((fake.duplicates(id).rows as unknown[]) ?? []).length)!;
    const diffs = [
      ...shapeDiffs(member.body, fake.bugs(false, none3, 10, 0), "member", []),
      ...shapeDiffs((await as(SUPERADMIN)).body, fake.bugs(true, none3, 10, 0), "superadmin", []),
      ...shapeDiffs((await get(`/${REPORTS.R2.id}`, SUPERADMIN)).body, fake.bugReport(String(fake.REPORTS[1].id)), "report", []),
      ...shapeDiffs((await get(`/${REPORTS.R1.id}/duplicates`, SUPERADMIN)).body, fake.duplicates(fakeWithTargets), "duplicates", []),
    ];
    if (diffs.length) fail(step, diffs.join("; "));
    pass("the queue to a member and to the superadmin, a report and its targets agree in shape with the fake's, key set by key set");

    step = "nothing changed a report";
    if (await snapshot() !== before) fail(step, "a row of zz.bug differs from what was seeded after the reads");
    pass("every row of zz.bug reads as it was seeded after every read");

    step = "a query that fails";
    await db.query("alter table zz.bug rename to bug_hidden");
    const broken = await as(MEMBER).finally(() => db.query("alter table zz.bug_hidden rename to bug"));
    if (broken.status !== 500 || broken.body.error !== "could not read the platform's bugs" || Object.keys(broken.body).length !== 1) {
      fail(step, `answered ${broken.status}: ${broken.text.slice(0, 300)}`);
    }
    pass("a query that fails answers 500, could not read the platform's bugs, and nothing else");
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
