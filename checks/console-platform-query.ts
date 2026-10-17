#!/usr/bin/env node
/**
 * checks/console-platform-query.ts — the Platform prepared query answers each measure as the page that draws it does,
 * caller-projected as that page is (AC-1.14, AC-1.15, AC-2.4, AC-4.4).
 *
 *   node checks/console-platform-query.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL and a real zz-core on it (`withThrowawayCore`), seeds what
 * `checks/console-platform-query-seed.ts` declares, and calls the gateway's own built routes the way Express would, as
 * a console session: the query (`services/gateway/dist/console/platform-query.js`) and every page it must equal, Status,
 * Releases, Bugs, Evaluation, Usage, Knowledge health, Teams, People and Audit, each read against the same rows. What it
 * establishes, as a member of a team and as the superadmin, the expected values the pages' own answers:
 *
 *   - every measure, by each dimension it allows, answers the figure its page draws for the same window: the last
 *     whole week, the weeks before it by bucket, or every day from the first recorded one; where no page draws a
 *     dimension, each group is the total the query answers filtered to it, and the groups sum to the total;
 *   - a drill answers the page's rows under the same filters and window, newest first, each with its address, and pages
 *     without overlap;
 *   - top bounds the groups and the latest buckets, the groups with the folded rest summing to the total, and
 *     from=0001-01-01 answers from the first recorded day;
 *   - a member asking a superadmin's measure, a team as a dimension or a where filter, or the questions searches asked, is
 *     answered 403 with the body Teams answers a member, and no answer to a member holds a team's slug, a report's own
 *     title, a finding's pattern, a protocol's or a measure's key, or a question;
 *   - what the route does not take is refused 400 with a sentence naming what it takes, before anything is read where
 *     no vocabulary is needed, a filter's value outside its vocabulary never echoed; a read that fails is unavailable,
 *     never a zero.
 *
 * DELIBERATE: the reporting time zone is Asia/Singapore, eight hours ahead of UTC, so a day cut on UTC's calendar moves
 * what the seed places before 08:00.
 *
 * The only database it touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";

import { LONER, SENTINEL, SHARED, SUPERADMIN, TWO, TWO_ADMIN, seedPlatformQuery, type Seeded } from "./console-platform-query-seed.ts";

const NAME = "console-platform-query";
const DONE = "console-platform-query: every measure by every dimension it allows answers the figure its page draws for the " +
  "same window, its rows the page's, newest first, for a member and for the superadmin, a member refused what only the " +
  "superadmin is shown and answered nothing a member's page leaves out, what it does not take refused naming what it takes: ok";
const TIMEZONE = "Asia/Singapore";
const ALL = "0001-01-01";

type Obj = Record<string, unknown>;
type Route = (req: unknown, res: unknown) => void;
type Who = { email: string; role: "member" | "superadmin"; team: string | null };
type Figure = { value: number | null; why: string | null };
type Group = { key: string | null; label: string; value: Figure; share: number | null; previous: Figure | null };
type PQ = {
  meta: Obj; measure: string; by: string | null; window: { from: string; to: string }; groups: Group[];
  rest: { groups: number; value: number; previous: number | null } | null; total: Figure;
  rows: { state: string; data?: { rows: Obj[]; total: number } } | null;
};
type Answer = { status: number; body: Obj };
/** Status's and Releases' weekly read of the calls, and the cutoff and weeks it is read over (platform-measures.ts). */
interface Weekly {
  readGrid: (db: pg.Pool) => Promise<{ weeks: { fromMs: number }[] }>;
  callWeeks: (db: pg.Pool, grid: unknown, team: string | null) => Promise<(fromMs: number, column: "calls" | "malformed" | "refusals") => number>;
}
/** A query as Express hands it on: a where repeated is an array. */
type Query = Record<string, string | string[]>;

const show = (v: unknown): string => JSON.stringify(v).slice(0, 700);
const canonical = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canonical)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Obj)[k])])) : v;
const dayOf = (ms: number): string => new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(new Date(ms));
const data = (a: Answer, part: string): Obj => ((a.body[part] as Obj).data as Obj);
/** Rows with what moves between two reads a second apart left out: the cutoff, and a running window's observed end;
 *  and with the query's own two fields, the instant a row is ordered by and its address, taken off. */
const settled = (rows: Obj[] | undefined, own = true): unknown => JSON.parse(JSON.stringify(
  (rows ?? []).map((r) => (own ? Object.fromEntries(Object.entries(r).filter(([k]) => k !== "at" && k !== "address")) : r)),
  function (this: Obj, k: string, x: unknown) { return k === "asOf" || (k === "observedThrough" && this.complete === false) ? undefined : x; }));

/** The request a console session's read arrives as, past the gateway's middleware (COUPLED: identity.ts). */
function request(who: Who, query: Query): Obj {
  return {
    params: {}, query, body: {},
    zzIdentity: { email: who.email, displayName: "Query", platformRole: who.role, via: "session",
                  teams: who.team ? [{ slug: who.team, role: "admin" }] : [], activeTeam: who.team, patTeam: null, sessionTeam: who.team },
    headers: {},
  };
}

/** Calls a mounted route as Express would, and waits for what it sends. */
function answer(route: Route, req: Obj): Promise<Answer> {
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

async function run(c: Core): Promise<void> {
  process.env.TEAM_DB_URL = c.url;
  process.env.ZZ_TZ = TIMEZONE;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  const load = (p: string) => import(pathToFileURL(join(root, "services/gateway/dist", p)).href);
  const db = (await load("db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await db.initPlatformDb();
  const routes = new Map<string, Route>();
  const fake = { get: (p: string, h: Route) => routes.set(p, h), post: () => undefined };
  for (const [file, mount] of [
    ["platform-query", "mountPlatformQuery"], ["platform-status", "mountPlatformStatus"], ["platform-releases", "mountPlatformReleases"],
    ["platform-bugs", "mountPlatformBugs"], ["platform-evaluation", "mountPlatformEvaluation"], ["platform-usage", "mountPlatformUsage"],
    ["platform-knowledge", "mountPlatformKnowledge"], ["teams", "mountTeams"], ["people", "mountPeople"], ["platform-audit", "mountPlatformAudit"],
  ]) ((await load(`console/${file}.js`)) as Record<string, (app: unknown) => void>)[mount](fake);
  try {
    const s = await seedPlatformQuery(c, TIMEZONE);
    const figures = (await load("console/platform-measures.js")) as Weekly;
    await cases(c, s, (p) => routes.get(`/api/console${p}`) ?? c.fail("mount", `no route GET ${p}`), figures, db.platformDb());
  } finally {
    await db.platformDb().end().catch(() => undefined);
    for (const k of ["TEAM_DB_URL", "ZZ_TZ", "ZZ_CATALOG_DIR"]) delete process.env[k];
  }
}

async function cases(c: Core, s: Seeded, route: (p: string) => Route, figures: Weekly, pool: pg.Pool): Promise<void> {
  const MEMBER: Who = { email: c.email, role: "member", team: c.team };
  const ADMIN: Who = { email: SUPERADMIN, role: "superadmin", team: null };
  const PEOPLE = [MEMBER, ADMIN];
  /** Every answer a member was given, held at the end to what a member may read. */
  const memberSaw: string[] = [];
  let step = "the record";
  const same = (st: string, found: unknown, expected: unknown): void => {
    if (JSON.stringify(canonical(found)) !== JSON.stringify(canonical(expected))) c.fail(st, `found ${show(found)}, expected ${show(expected)}`);
  };
  const raw = async (who: Who, query: Query): Promise<Answer> => {
    const a = await answer(route("/platform/query"), request(who, query));
    if (who === MEMBER) memberSaw.push(JSON.stringify(a.body));
    return a;
  };
  const ask = async (who: Who, query: Query): Promise<PQ> => {
    const a = await raw(who, query);
    if (a.status !== 200) c.fail(step, `${show(query)} answered ${a.status}: ${show(a.body)}`);
    return a.body as unknown as PQ;
  };
  const page = async (who: Who, path: string, query: Record<string, string> = {}): Promise<Answer> => {
    const a = await answer(route(path), request(who, query));
    if (a.status !== 200) c.fail(step, `${path}?${new URLSearchParams(query)} answered ${a.status}: ${show(a.body)}`);
    return a;
  };
  const values = (w: PQ): Record<string, number | null> => Object.fromEntries(w.groups.map((g) => [g.key ?? "(none)", g.value.value]));
  const nonzero = (r: Record<string, number | null>): Record<string, number | null> => Object.fromEntries(Object.entries(r).filter(([, n]) => n));
  /** The groups sum, with the rest, to the total, and each is the total filtered to it. */
  const consistent = async (st: string, who: Who, query: Query, by: string): Promise<PQ> => {
    const w = await ask(who, { ...query, by });
    if (w.groups.reduce((n, g) => n + g.value.value!, 0) + (w.rest?.value ?? 0) !== w.total.value) c.fail(st, `${by}'s groups do not sum to ${w.total.value}: ${show(w.groups)}`);
    for (const g of w.groups) {
      const alone = await ask(who, { ...query, where: `${by}=${g.key ?? ""}` });
      if (alone.total.value !== g.value.value) c.fail(st, `${by}=${g.key} answers ${alone.total.value}, its group ${g.value.value}`);
    }
    return w;
  };

  // The weeks, as dates: L the last whole week, L-1 and L-2 before it; today; and the window of everything.
  const start = (back: number): number => s.starts.get(back)!;
  const week = (back: number) => ({ from: dayOf(start(back)), to: dayOf(start(back - 1) - 1) });
  const L = week(1), L1 = week(2), L2 = week(3);
  const today = dayOf(Date.now());
  const everything = { from: ALL, to: today };
  const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  const atWeek = <T extends { window: { from: string } }>(weeks: T[], back: number): T =>
    weeks.find((w) => w.window.from === iso(start(back))) ?? c.fail(step, `no week from ${iso(start(back))} in ${show(weeks.map((w) => w.window.from))}`);

  step = "the defaults";
  const plain = await ask(MEMBER, { measure: "calls" });
  same(step, [plain.window.from, plain.window.to, plain.groups, plain.rest, plain.rows, plain.by], [iso(start(1)), iso(start(0)), [], null, null, null]);
  c.pass(`${step}: no window is the last whole week, and no by the total alone`);

  // What the seed writes, counted by hand, so no comparison below holds because both sides read nothing.
  step = "the record holds what the comparisons are made over";
  same(step, [
    (await ask(ADMIN, { measure: "calls", ...L })).total.value,
    values(await ask(ADMIN, { measure: "calls", by: "team", ...L })),
    values(await ask(ADMIN, { measure: "refusals", by: "owner", ...L })),
    (await ask(ADMIN, { measure: "malformed", from: L1.from, to: L.to, by: "week" })).groups.map((g) => g.value.value),
    values(await ask(ADMIN, { measure: "bugs_filed", by: "impact", ...everything })),
    values(await ask(ADMIN, { measure: "findings", by: "decision", ...everything })),
    values(await ask(ADMIN, { measure: "lessons", by: "imported", ...L })),
    (await ask(ADMIN, { measure: "searches", ...L })).total.value,
    (await ask(ADMIN, { measure: "sign_ins", ...L })).total.value,
  ], [
    31, { [c.team]: 19, [TWO]: 10, "(none)": 2 }, { guardrail: 1, ours: 4, theirs: 1, other: 2 }, [3, 4],
    { blocks_work: 2, wrong_result: 2, confusing: 1, cosmetic: 2 }, { applied: 1, rejected: 0, deferred: 3 },
    { imported: 1, not_imported: 5 }, 6, 4,
  ]);
  c.pass(`${step}: calls, refusals, malformed calls, reports, findings, lessons, searches and sign-ins as written`);

  step = "calls answer Usage's calls by week, by tool and by refusal, and the superadmin's by team";
  for (const who of PEOPLE) {
    const usage = await page(who, "/platform/usage");
    const weeks = data(usage, "callsByWeek").weeks as { window: { from: string }; calls: Figure; parts: { label: string; calls: number }[] | null }[];
    same(step, (await ask(who, { measure: "calls", ...L })).total.value, atWeek(weeks, 1).calls.value);
    same(step, values(await ask(who, { measure: "calls", by: "week", from: L1.from, to: L.to })),
      { [L1.from]: atWeek(weeks, 2).calls.value, [L.from]: atWeek(weeks, 1).calls.value });
    const most = data(usage, "mostUsed").rows as { tool: string; calls: number }[];
    const byTool = await ask(who, { measure: "calls", by: "tool", ...L });
    same(step, Object.fromEntries(byTool.groups.map((g) => [g.key ?? "Unregistered tools", g.value.value])), Object.fromEntries(most.map((r) => [r.tool, r.calls])));
    const refused = (data(usage, "tiles").refusedShare as { last: { numerator: number; denominator: number } }).last;
    const byRefusal = await ask(who, { measure: "calls", by: "refused", ...L });
    same(step, [values(byRefusal).refused, byRefusal.total.value], [refused.numerator, refused.denominator]);
    if (who === ADMIN) {
      const parts = atWeek(weeks, 1).parts ?? c.fail(step, "the superadmin's calls by week carry no parts");
      same(step, Object.fromEntries((await ask(who, { measure: "calls", by: "team", ...L })).groups.map((g) => [g.key ?? "Other", g.value.value])),
        Object.fromEntries(parts.filter((p) => p.calls).map((p) => [p.label, p.calls])));
    }
  }
  c.pass(step);

  step = "refusals answer Usage's under their four owners and Status's by week";
  const status = await page(MEMBER, "/platform/status");
  const measures = status.body.measures as { key: string; weeks: { window: { from: string }; numerator: number | null }[]; followupCounts?: { refusals: number }[] }[];
  const followup = measures.find((m) => m.key === "same_tool_followup_pct")!;
  const malformedWeeks = measures.find((m) => m.key === "malformed_per_1000")!.weeks;
  for (const who of PEOPLE) {
    const usage = await page(who, "/platform/usage");
    const owners = data(usage, "refusals");
    same(step, values(await ask(who, { measure: "refusals", by: "owner", ...L })),
      Object.fromEntries(["guardrail", "ours", "theirs", "other"].map((o) => [o, owners[o]])));
    for (const back of [1, 2]) {
      const at = followup.weeks.findIndex((w) => w.window.from === iso(start(back)));
      same(step, (await ask(who, { measure: "refusals", ...week(back) })).total.value, followup.followupCounts![at].refusals);
    }
    await consistent(step, who, { measure: "refusals", from: L1.from, to: L.to }, "tool");
  }
  c.pass(step);

  step = "malformed calls answer Status's and Releases' weekly counts";
  const releases = await page(MEMBER, "/platform/releases", { limit: "100" });
  const releaseWeeks = releases.body.weeks as { window: { from: string }; releases: number; malformedPer1000: { numerator: number | null } }[];
  for (const who of PEOPLE) {
    for (const back of [1, 2, 3]) {
      const n = (await ask(who, { measure: "malformed", ...week(back) })).total.value;
      same(`${step}: back ${back}`, [n, n], [atWeek(malformedWeeks, back).numerator, atWeek(releaseWeeks, back).malformedPer1000.numerator]);
    }
    await consistent(step, who, { measure: "malformed", ...everything }, "tool");
  }
  c.pass(step);

  step = "calls, malformed calls and refusals by week answer callWeeks, every team's, and calls and refusals one team's";
  const grid = await figures.readGrid(pool);
  for (const [team, id] of [[null, null], [c.team, s.one]] as const) {
    const weekly = await figures.callWeeks(pool, grid, id);
    // malformed has no team among its dimensions: Status narrows it to the reader's team, and no page by any other.
    for (const [measure, column] of ([["calls", "calls"], ["malformed", "malformed"], ["refusals", "refusals"]] as const).filter(([m]) => !team || m !== "malformed")) {
      const asked = await ask(ADMIN, { measure, by: "week", from: L2.from, to: L.to, ...(team ? { where: `team=${team}` } : {}) });
      same(`${step}: ${measure}${team ? ` of ${team}` : ""}`, values(asked), Object.fromEntries([3, 2, 1].map((b) => [week(b).from, weekly(start(b), column)])));
    }
  }
  c.pass(step);

  step = "releases and migrations answer Releases' weeks, tiles and rows";
  const tiles = releases.body.tiles as { releases: number; migrations: { applied: number } };
  for (const who of PEOPLE) {
    same(step, values(await ask(who, { measure: "releases", by: "week", from: L2.from, to: L.to })),
      Object.fromEntries([3, 2, 1].map((b) => [week(b).from, atWeek(releaseWeeks, b).releases])));
    const all = await ask(who, { measure: "releases", ...everything, rows: "20" });
    same(step, all.total.value, tiles.releases);
    same(step, settled(all.rows?.data?.rows), settled(data(releases, "rows").rows as Obj[], false));
    same(step, (await ask(who, { measure: "migrations", ...everything })).total.value, tiles.migrations.applied);
  }
  c.pass(step);

  step = "bugs answer Bugs' cohorts, counts, outcomes and queue, the superadmin's rows their own";
  for (const who of PEOPLE) {
    const bugs = await page(who, "/platform/bugs", { limit: "20" });
    const counts = data(bugs, "counts") as { open: number; resolved: number; byImpact: Obj; byStatus: Obj };
    const cohorts = bugs.body.cohorts as { week: string; filed: Figure; resolved: Figure }[];
    same(step, values(await ask(who, { measure: "bugs_filed", by: "impact", ...everything })), counts.byImpact);
    same(step, values(await ask(who, { measure: "bugs_filed", by: "state", ...everything })), { open: counts.open, resolved: counts.resolved });
    same(step, values(await ask(who, { measure: "bugs_resolved", by: "outcome", ...everything })),
      { fixed: counts.byStatus.fixed, not_a_bug: counts.byStatus.not_a_bug, duplicate: counts.byStatus.duplicate });
    const cohort = (b: number) => cohorts.find((x) => x.week === iso(start(b)))!;
    same(step, values(await ask(who, { measure: "bugs_filed", by: "week", from: L2.from, to: L.to })),
      Object.fromEntries([3, 2, 1].map((b) => [week(b).from, cohort(b).filed.value])));
    same(step, values(await ask(who, { measure: "bugs_resolved", by: "week", from: L2.from, to: L.to })),
      Object.fromEntries([3, 2, 1].map((b) => [week(b).from, cohort(b).resolved.value])));
    for (const filter of [{ state: "open" }, { impact: "wrong_result" }, { surface: "document_read" }, { state: "resolved", impact: "cosmetic" }] as Record<string, string>[]) {
      const queue = data(await page(who, "/platform/bugs", { ...filter, limit: "20" }), "queue") as { rows: Obj[]; total: number };
      const asked = await ask(who, { measure: filter.state === "resolved" ? "bugs_resolved" : "bugs_filed", ...everything,
        where: Object.entries(filter.state === "resolved" ? { impact: filter.impact } : filter).map(([k, v]) => `${k}=${v}`), rows: "20" });
      same(`${step}: the queue under ${show(filter)}`, [asked.total.value, asked.rows?.data?.total, asked.rows?.data?.rows.map(({ at: _a, address: _d, ...r }) => r)],
        [queue.total, queue.total, queue.rows]);
      if (asked.rows?.data?.rows.some((r) => r.address !== "/platform/bugs" || r.at !== r.filedAt)) c.fail(step, show(asked.rows));
    }
    await consistent(step, who, { measure: "bugs_filed", ...everything }, "surface");
  }
  c.pass(step);

  step = "findings and scores answer Evaluation's decisions, owners, waiting summaries and scores established";
  for (const who of PEOPLE) {
    const evaluation = await page(who, "/platform/evaluation");
    same(step, values(await ask(who, { measure: "findings", by: "decision", ...everything })), data(evaluation, "byDecision"));
    same(step, nonzero(values(await ask(who, { measure: "findings", by: "owner", ...everything }))), data(evaluation, "byOwner"));
    await consistent(step, who, { measure: "findings", ...everything }, "plugin");
    const waiting = (data(evaluation, "waiting").rows as Obj[]).slice().reverse();
    const drilled = await ask(who, { measure: "findings", by: "decision", group: "deferred", ...everything, limit: "20" });
    same(step, drilled.rows?.data?.rows.map(({ at: _a, address: _d, ...r }) => r), waiting);
    const established = ((evaluation.body.plugins as Obj).data as { plugin: string; standing: string }[]).filter((p) => p.standing === "established");
    same(step, (await ask(who, { measure: "scores", ...everything })).total.value, (evaluation.body.tiles as Obj).established);
    const scores = await ask(who, { measure: "scores", by: "plugin", ...everything, rows: "20" });
    same(step, [values(scores), scores.rows?.data?.rows.map(({ at: _a, address: _d, ...r }) => r).sort((a, b) => String(a.plugin) < String(b.plugin) ? -1 : 1)],
      [Object.fromEntries(established.map((p) => [p.plugin, 1])), established]);
  }
  c.pass(step);

  step = "lessons answer Knowledge health's lessons made, cohorts and shelves, a member's shelves their own and the shared one";
  for (const who of PEOPLE) {
    const health = await page(who, "/platform/knowledge");
    const made = data(health, "made").weeks as { window: { from: string }; made: Figure }[];
    const cohorts = data(health, "cohorts").rows as { window: { from: string }; made: number; imported: number }[];
    const span = { from: L1.from, to: L.to };
    same(step, values(await ask(who, { measure: "lessons", by: "week", ...span, where: "imported=not_imported" })),
      { [L1.from]: atWeek(made, 2).made.value, [L.from]: atWeek(made, 1).made.value });
    same(step, values(await ask(who, { measure: "lessons", by: "week", ...span })), { [L1.from]: atWeek(cohorts, 2).made, [L.from]: atWeek(cohorts, 1).made });
    same(step, values(await ask(who, { measure: "lessons", by: "week", ...span, where: "imported=imported" })),
      { [L1.from]: atWeek(cohorts, 2).imported, [L.from]: atWeek(cohorts, 1).imported });
    const shelves = data(health, "shelves").rows as { shelf: string; kind: string; madeLastWeek: number }[];
    const byShelf = values(await ask(who, { measure: "lessons", by: "shelf", ...L, where: "imported=not_imported" }));
    const named = Object.fromEntries(shelves.filter((r) => r.kind !== "all" && r.madeLastWeek).map((r) => [r.shelf, r.madeLastWeek]));
    const all = shelves.find((r) => r.kind === "all")!.madeLastWeek;
    if (who === MEMBER) named["(none)"] = all - Object.values(named).reduce((n, v) => n + v, 0);
    same(step, nonzero(byShelf), nonzero(named));
    await consistent(step, who, { measure: "lessons", ...everything }, "kind");
  }
  c.pass(step);

  step = "searches answer Knowledge health's and Status's searches, and the superadmin's questions";
  const found = measures.find((m) => m.key === "searches_with_results_pct")!.weeks as { window: { from: string }; numerator: number | null; denominator: number | null }[];
  for (const who of PEOPLE) {
    const health = await page(who, "/platform/knowledge");
    const t = data(health, "tiles").searches as { last: { figure: Figure }; previous: { figure: Figure } };
    same(step, values(await ask(who, { measure: "searches", by: "week", from: L1.from, to: L.to })), { [L1.from]: t.previous.figure.value, [L.from]: t.last.figure.value });
    const byFound = await ask(who, { measure: "searches", by: "found", ...L });
    same(step, [values(byFound).found, byFound.total.value], [atWeek(found, 1).numerator, atWeek(found, 1).denominator]);
    const widened = atWeek(data(health, "searches").weeks as { window: { from: string }; widened: { numerator: number; denominator: number } }[], 1).widened;
    const byWidened = values(await ask(who, { measure: "searches", by: "widened", ...L }));
    same(step, [byWidened.widened, byWidened.widened! + byWidened.not_widened!], [widened.numerator, widened.denominator]);
  }
  const health = await page(ADMIN, "/platform/knowledge");
  const questions = data(health, "questions") as { window: { from: string }; rows: Obj[] };
  const drawn = { from: dayOf(Date.parse(questions.window.from)), to: today };
  const asked = await ask(ADMIN, { measure: "searches", ...drawn, where: "found=nothing", rows: "20" });
  same(step, asked.rows?.data?.rows.map(({ at: _a, address: _d, ...r }) => r).sort((a, b) => show(a) < show(b) ? -1 : 1),
    questions.rows.slice().sort((a, b) => show(a) < show(b) ? -1 : 1));
  c.pass(step);

  step = "model calls answer Usage's last week and the week before it";
  for (const who of PEOPLE) {
    const model = data(await page(who, "/platform/usage"), "modelCalls") as { last: { calls: number }; previous: { calls: number } };
    const w = await consistent(step, who, { measure: "model_calls", ...L, compare: "previous" }, "model");
    same(step, [w.total.value, w.groups.reduce((n, g) => n + (g.previous?.value ?? 0), 0) + (w.rest?.previous ?? 0)], [model.last.calls, model.previous.calls]);
  }
  c.pass(step);

  step = "the superadmin's teams, people, sign-ins and audit answer their pages' tiles, totals and rows";
  const teams = await page(ADMIN, "/teams", { limit: "100" });
  same(step, (await ask(ADMIN, { measure: "teams", ...everything })).total.value, (teams.body.tiles as Obj).teams);
  for (const st of ["active", "archived"]) {
    same(step, values(await ask(ADMIN, { measure: "teams", by: "status", ...everything }))[st] ?? 0, (await page(ADMIN, "/teams", { status: st })).body.total);
  }
  const teamRows = await ask(ADMIN, { measure: "teams", ...everything, rows: "20" });
  const bySlug = (rows: Obj[]) => rows.slice().sort((a, b) => String(a.slug) < String(b.slug) ? -1 : 1);
  same(step, settled(bySlug(teamRows.rows!.data!.rows)), settled(bySlug(teams.body.teams as Obj[]), false));
  if (teamRows.rows!.data!.rows.some((r) => r.address !== `/teams/${String(r.slug)}`)) c.fail(step, show(teamRows.rows));
  const people = await page(ADMIN, "/people", { limit: "100" });
  same(step, (await ask(ADMIN, { measure: "people", ...everything })).total.value, (people.body.tiles as Obj).people);
  for (const st of ["active", "deactivated"]) {
    same(step, values(await ask(ADMIN, { measure: "people", by: "state", ...everything }))[st], (await page(ADMIN, "/people", { state: st })).body.total);
  }
  await consistent(step, ADMIN, { measure: "people", ...everything }, "role");
  const personRows = await ask(ADMIN, { measure: "people", ...everything, rows: "20" });
  const byEmail = (rows: Obj[]) => rows.slice().sort((a, b) => String(a.email) < String(b.email) ? -1 : 1);
  same(step, byEmail(personRows.rows!.data!.rows.map(({ at: _a, address: _d, ...r }) => r)), byEmail(people.body.people as Obj[]));
  same(step, (await ask(ADMIN, { measure: "sign_ins", ...L })).total.value, ((people.body.tiles as Obj).signInsLastWeek as { figure: Figure }).figure.value);
  const signedIn = await ask(ADMIN, { measure: "sign_ins", ...L, rows: "20" });
  same(step, byEmail(signedIn.rows!.data!.rows.map(({ at: _a, address: _d, ...r }) => r)),
    byEmail((people.body.people as Obj[]).filter((p) => [c.email, TWO_ADMIN, SUPERADMIN].includes(String(p.email)))));
  const audit = (await page(ADMIN, "/platform/audit", { filter: "all", limit: "100" })).body;
  same(step, (await ask(ADMIN, { measure: "audit", ...everything })).total.value, audit.total);
  for (const g of (await ask(ADMIN, { measure: "audit", by: "kind", ...everything })).groups) {
    same(`${step}: audit's ${g.key}`, g.value.value, (await page(ADMIN, "/platform/audit", { filter: "all", kind: g.key! })).body.total);
  }
  for (const g of (await ask(ADMIN, { measure: "audit", by: "team", ...everything })).groups.filter((x) => x.key !== null)) {
    same(`${step}: audit's ${g.key}`, g.value.value, (await page(ADMIN, "/platform/audit", { filter: "all", team: g.key! })).body.total);
  }
  const signIns = await ask(ADMIN, { measure: "audit", ...everything, where: "kind=console.sign_in", rows: "20" });
  same(step, signIns.rows?.data?.rows.map(({ address: _d, ...r }) => r),
    (await page(ADMIN, "/platform/audit", { filter: "all", kind: "console.sign_in", limit: "20" })).body.rows);
  c.pass(step);

  step = "top bounds the groups and the latest buckets, and the rest folds into the total";
  const tools = await ask(ADMIN, { measure: "calls", by: "tool", from: L2.from, to: L.to });
  const one = await ask(ADMIN, { measure: "calls", by: "tool", from: L2.from, to: L.to, top: "1" });
  same(step, [one.groups, one.rest], [tools.groups.slice(0, 1), {
    groups: tools.groups.length - 1, value: tools.groups.slice(1).reduce((n, g) => n + g.value.value!, 0), previous: null }]);
  const days = await ask(ADMIN, { measure: "calls", by: "day", from: L2.from, to: L.to, top: "3" });
  same(step, [days.groups.map((g) => g.key), days.rest?.groups, days.groups.reduce((n, g) => n + g.value.value!, 0) + days.rest!.value],
    [[-2, -1, 0].map((d) => dayOf(start(0) - 1 + d * 86_400_000)), 18, days.total.value]);
  const weekdays = await ask(ADMIN, { measure: "calls", by: "weekday", ...L });
  same(step, weekdays.groups.map((g) => g.key), ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]);
  const three = await ask(ADMIN, { measure: "calls", by: "weekday", from: dayOf(start(1) + 4 * 86_400_000), to: L.to });
  same(step, three.groups.map((g) => [g.key, g.label]), [["Friday", "Friday"], ["Saturday", "Saturday"], ["Sunday", "Sunday"]]);
  same(step, [days.groups[0].label, (await ask(ADMIN, { measure: "calls", by: "week", ...L })).groups[0].label,
    (await ask(ADMIN, { measure: "calls", by: "month", ...L })).groups.at(-1)!.label], [days.groups[0].key, `Week from ${L.from}`, `Month ${L.to.slice(0, 7)}`]);
  c.pass(`${step}: by tool, by day and the weekdays the window holds, Monday to Sunday, labelled as Work labels them`);

  step = "compare=previous answers each bucket's value in the window before, by its place in it, a weekday by its name";
  const usageWeeks = data(await page(ADMIN, "/platform/usage"), "callsByWeek").weeks as { window: { from: string }; calls: Figure }[];
  const weekly = await ask(ADMIN, { measure: "calls", by: "week", ...L, compare: "previous" });
  same(step, weekly.groups.map((g) => [g.key, g.value.value, g.previous?.value]), [[L.from, atWeek(usageWeeks, 1).calls.value, atWeek(usageWeeks, 2).calls.value]]);
  for (const by of ["day", "weekday"]) {
    const [now, before] = [await ask(ADMIN, { measure: "calls", by, ...L, compare: "previous" }), await ask(ADMIN, { measure: "calls", by, ...L1 })];
    same(`${step}: by ${by}`, now.groups.map((g) => g.previous?.value), before.groups.map((g) => g.value.value));
  }
  c.pass(step);

  step = "the console's scope, and a team named outside a where filter, change nothing";
  for (const who of PEOPLE) {
    for (const query of [{ measure: "calls", by: "tool", ...L }, { measure: "bugs_filed", by: "impact", ...everything, rows: "5" }] as Record<string, string>[]) {
      const [plain, scoped] = [await ask(who, query), await ask(who, { ...query, scope: "platform", team: TWO })];
      same(`${step}: ${show(query)}`, [scoped.groups, scoped.total, scoped.rest, scoped.rows], [plain.groups, plain.total, plain.rest, plain.rows]);
    }
  }
  c.pass(step);

  step = "from=0001-01-01 answers from the first recorded day";
  const first = (await c.sql.query<{ ms: number }>(
    "select (extract(epoch from min(ts)) * 1000)::float8 as ms from zz.event where kind = 'tool_call' and origin = 'work'")).rows[0].ms;
  same(step, (await ask(MEMBER, { measure: "calls", ...everything })).window.from,
    iso(Date.parse(`${dayOf(first)}T00:00:00+08:00`)));
  c.pass(step);

  step = "a drill pages a group's rows newest first, without overlap";
  const pageOf = async (offset: number) => (await ask(ADMIN, { measure: "bugs_filed", by: "impact", group: "wrong_result", ...everything, limit: "1", offset: String(offset) })).rows!.data!;
  const both = (await ask(ADMIN, { measure: "bugs_filed", by: "impact", group: "wrong_result", ...everything, limit: "2" })).rows!.data!;
  same(step, [[...(await pageOf(0)).rows, ...(await pageOf(1)).rows], both.total], [both.rows, 2]);
  if (!(String(both.rows[0].at) >= String(both.rows[1].at))) c.fail(step, `not the newest first: ${show(both.rows)}`);
  c.pass(step);

  step = "a member is refused what only the superadmin is shown, with the body Teams answers";
  const teamsBody = await answer(route("/teams"), request(MEMBER, {}));
  for (const query of [
    { measure: "teams" }, { measure: "people" }, { measure: "sign_ins" }, { measure: "audit" }, { measure: "calls", by: "team" },
    { measure: "refusals", where: `team=${TWO}` }, { measure: "calls", where: ["tool=core:document_read", `team=${c.team}`] }, { measure: "searches", rows: "5" },
    { measure: "searches", by: "found", group: "nothing" },
  ] as Query[]) {
    same(`${step}: ${show(query)}`, await raw(MEMBER, query), teamsBody);
  }
  c.pass(step);

  step = "what it does not take is refused with a sentence naming what it takes, before anything is read";
  const refusals: [Query, string][] = [
    [{ measure: "bytes" }, "calls, refusals, malformed, releases, migrations, bugs_filed"],
    [{ measure: "calls", by: "impact" }, "tool, refused, team, or a bucket: day, week, month, weekday"],
    [{ measure: "teams", by: "week" }, "teams is grouped by status"],
    [{ measure: "calls", where: "impact=cosmetic" }, "calls is filtered by one of tool, refused, team"],
    [{ measure: "calls", where: "tool" }, "each where is a dimension, an equals sign and a value"],
    [{ measure: "teams", compare: "previous" }, "a stock has no window before"],
    [{ measure: "calls", from: L.from, to: `${L.to}T00:00:00Z` }, "from and to are both dates or both instants, not one of each"],
    [{ measure: "calls", from: L.to, to: L.from }, "inclusive dates, YYYY-MM-DD"],
    [{ measure: "calls", from: L.from }, "given both or neither"],
    [{ measure: "calls", by: "tool", top: "51" }, "1 to 50"],
    [{ measure: "calls", rows: "21" }, "1 to 20"],
    [{ measure: "calls", by: "tool", group: "core:document_read", limit: "21" }, "1 to 20"],
    [{ measure: "refusals", rows: "5" }, "Usage and Status count them"],
    [{ measure: "calls", group: "x" }, "give by with it"],
    [{ measure: "calls", by: "tool", group: "core:document_read", rows: "5" }, "rows is the newest of the window's rows, so it is given without group, limit or offset"],
    [{ measure: "calls", rows: "5", limit: "5" }, "given without group, limit or offset"],
    [{ measure: "calls", by: "week", group: L.to }, "a week of the window"],
    [{ measure: "bugs_filed", where: ["impact=blocks_work", "state=open", "surface=core", "impact=cosmetic", "state=resolved"] }, "where takes at most 4 filters"],
  ];
  await c.sql.query("alter table zz.event rename to event_hidden");
  try {
    for (const [query, says] of refusals) {
      const a = await raw(ADMIN, query);
      if (a.status !== 400 || !String(a.body.error).includes(says)) c.fail(step, `${show(query)} answered ${a.status}: ${show(a.body)}`);
    }
  } finally {
    await c.sql.query("alter table zz.event_hidden rename to event");
  }
  for (const [query, says] of [
    [{ measure: "bugs_filed", where: "impact=SENTINEL-value" }, "a filter on impact takes one of blocks_work, wrong_result, confusing, cosmetic"],
    [{ measure: "calls", where: "tool=core:SENTINEL-value" }, "a tool a door registers"],
    [{ measure: "lessons", where: "shelf=SENTINEL-value" }, "a filter on shelf takes one of own, shared"],
  ] as [Query, string][]) {
    const a = await raw(MEMBER, query);
    if (a.status !== 400 || !String(a.body.error).includes(says) || JSON.stringify(a.body).includes("SENTINEL-value")) c.fail(step, `${show(query)} answered ${a.status}: ${show(a.body)}`);
  }
  c.pass(`${step}: ${refusals.length} questions with zz.event hidden, and three values outside their vocabulary, none echoed`);

  step = "a read that fails is unavailable, never a zero";
  await c.sql.query("alter table zz.event rename to event_hidden");
  const quiet = console.error;
  console.error = () => undefined;
  let failed: PQ;
  try {
    failed = await ask(ADMIN, { measure: "calls", by: "tool", ...L, rows: "5" });
  } finally {
    console.error = quiet;
    await c.sql.query("alter table zz.event_hidden rename to event");
  }
  same(step, [failed.total, failed.groups, failed.rest, failed.rows], [{ value: null, why: "unavailable" }, [], null, { state: "unavailable", reason: "query_failed" }]);
  c.pass(step);

  step = "no answer to a member holds a team's slug or anything a member's page leaves out";
  const said = memberSaw.join("\n");
  const held = [TWO, c.team, SHARED, SENTINEL, LONER, "protokey", "measurekey", "internalTitle", "pattern"].filter((x) => said.includes(x));
  if (held.length) c.fail(step, `${memberSaw.length} answers to the member hold ${held.join(", ")}`);
  c.pass(`${step}: ${memberSaw.length} answers`);
}

process.exitCode = await withThrowawayCore(NAME, DONE, run);
