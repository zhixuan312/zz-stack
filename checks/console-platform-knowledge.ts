#!/usr/bin/env node
/**
 * checks/console-platform-knowledge.ts — Knowledge health is read with its inventories, its imports labelled, and the
 * questions that found nothing the superadmin's alone, through the gateway's own identity gate and route on a real
 * database (AC-4.6, AC-4.7, AC-2.11).
 *
 *   node checks/console-platform-knowledge.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL migrated by the real runner, seeds what `scripts/schema/knowledge-health-seed.ts`
 * declares, and serves the gateway's built identity middleware and `services/gateway/dist/console/platform-knowledge.js`
 * from this process, signed in with real console session cookies. What it establishes, against values written here:
 *
 *   - the superadmin reads the tiles, every shelf by its slug (their own marked `own`, the shared one `shared`), the
 *     lessons made by week outside the import cohorts with how many each week left out exactly and by the day rule
 *     and where exact attribution begins, the searches by week with the share with no result, the share widened and
 *     the mean results, the lessons by the week made with how many since superseded and each cohort's basis, a week
 *     mixing both labelled by the day, the standing lessons by kind, and the ten questions with no result most asked
 *     first with their total, over the 26 weeks drawn;
 *   - a member reads the same figures for their own shelf, the shared shelf and the totals, as `own`, `shared` and
 *     `all`, the questions null, and no other shelf's slug and no question anywhere in the answer;
 *   - with `zz.event.subject` gone the member's read runs no statement that fails and answers as before, and only the
 *     superadmin's questions fail;
 *   - a team or scope parameter changes neither answer;
 *   - an import added afterwards moves the standing lessons, its shelf's imports and its week's cohort, and no week's
 *     lessons made;
 *   - with the lessons unreadable, their parts are unavailable and the searches and the questions stand;
 *   - both answers agree in shape with the console's fake one, key set by key set.
 *
 * The only database it touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import type { Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Express, RequestHandler } from "express";
import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import {
  MEMBER, SUPERADMIN, TIMEZONE, seedAddedImport, seedKnowledgeHealth, type KnowledgeSeeded,
} from "../scripts/schema/knowledge-health-seed.ts";
import { signIn, weekStart } from "../scripts/schema/status-seed.ts";
import { withThrowawayDb } from "../scripts/schema/throwaway.ts";
import { shapeDiffs } from "../scripts/schema/shape-diffs.ts";

const NAME = "console-platform-knowledge";
const DONE = "console-platform-knowledge: the superadmin reads every shelf, the imports labelled and the questions with no " +
  "result, a member their own shelf, the shared shelf and the totals and no question, in the fake's shapes: ok";
/** COUPLED: the fake answer in the console's checkout, `../zz-stack-dashboard` here and in CI. */
const FAKE = join(root, "..", "zz-stack-dashboard", "scripts", "fake-gateway", "platform-knowledge.ts");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

class CaseFailure extends Error {}
function fail(step: string, detail: string): never {
  throw new CaseFailure(`${NAME}: FAILED at "${step}": ${detail}`);
}
const pass = (line: string): void => console.log(`  ok  ${line}`);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
  return v;
}
const text = (v: unknown): string => JSON.stringify(sortDeep(v));
function expectSame(step: string, what: string, found: unknown, want: unknown): void {
  if (text(found) !== text(want)) fail(step, `${what} reads\n${text(found)}\nnot\n${text(want)}`);
}

interface Answer { status: number; body: Obj; text: string }

/* ---- What a reader must find, written out by hand from the seed's lists ---- */

/** The weeks drawn, back 25 to the running one; the record begins in back 28. */
const DRAWN = 26, FIRST = 25;
/** Lessons by `back`: made outside the cohorts, left out exactly, left out by the day rule, made in all, since
 *  superseded, and the cohort's basis. Every week not named holds none. */
const LESSON_WEEKS: Record<number, [number, number, number, number, number, "exact" | "by_day" | null]> = {
  3: [1, 0, 6, 7, 2, "by_day"], 2: [2, 0, 0, 2, 0, null], 1: [3, 3, 1, 7, 1, "by_day"], 0: [1, 0, 0, 1, 0, null],
};
/** Searches by `back`: completed, finding nothing, widened, results in all. */
const SEARCH_WEEKS: Record<number, [number, number, number, number]> = {
  4: [30, 11, 3, 38], 2: [2, 2, 0, 0], 1: [6, 2, 1, 10], 0: [2, 2, 0, 0],
};
/** The first week the share widened is defined in: its first `broadened` falls on back 4's Tuesday, so back 4 itself
 *  began before it. */
const WIDENED_FROM = 3;
/** Each shelf: standing, superseded, imported, made in L outside the cohorts, searches in L, and of them nothing. */
const SHELVES: Record<string, [number, number, number, number, number, number]> = {
  alder: [6, 2, 4, 1, 3, 1], birch: [2, 0, 0, 0, 2, 1], cedar: [1, 0, 0, 0, 0, 0], "zz-platform": [6, 2, 6, 2, 1, 0],
  all: [15, 4, 10, 3, 6, 2],
};
const BY_KIND = [["decision", 4], ["process", 3], ["style", 3], ["design", 2], ["knowledge", 2], ["behavior", 1]];
/** The questions, `[question, shelf, asked, back, ms into that week]` of the last asking, and their total. */
const ROLL_BACK = "how do we roll back a migration";
const QUESTIONS: [string, string, number, number, number][] = [
  [ROLL_BACK, "alder", 3, 0, 0], [ROLL_BACK, "birch", 1, 0, 0],
  ["chargeback window for refunds", "birch", 1, 1, 2 * DAY + 13 * HOUR], ["who owns the nightly reindex", "cedar", 1, 2, 2 * DAY + 11 * HOUR],
  ...[11, 10, 9, 8, 7, 6].map((n): [string, string, number, number, number] =>
    [`cedar question ${String(n).padStart(2, "0")}`, "cedar", 1, 4, DAY + 10 * HOUR + (n - 1) * 1000]),
];
const QUESTION_TOTAL = 15;
/** Exact attribution begins with birch's lesson, Tuesday 11:00 of back 2. */
const EXACT_FROM: [number, number] = [2, DAY + 11 * HOUR];
/** Text no member may read: every question that found nothing, and every shelf's slug, their own included, since a
 *  member's shelves are named by what they are to them. */
const PRIVATE = [ROLL_BACK, "chargeback window", "nightly reindex", "cedar question", "maintenance probe", "alder", "birch", "cedar", "zz-platform"];

/** What the import added afterwards changes: cedar's standing and imports, the totals, the running week's cohort and
 *  what it left out exactly, and four kinds. */
const ADDED = { standing: 19, cedar: [5, 0, 4, 0, 0, 0], all: [19, 4, 14, 3, 6, 2], running: [1, 4, 0, 5, 0, "exact"],
  byKind: [["decision", 5], ["process", 4], ["design", 3], ["knowledge", 3], ["style", 3], ["behavior", 1]] };

/* ---- The windows and figures those values arrive in ---- */

const startOf = (s: KnowledgeSeeded, back: number): number => s.starts.get(back) ?? weekStart(s.now, back, TIMEZONE);
function windowAt(s: KnowledgeSeeded, back: number, asOf: string) {
  const from = iso(startOf(s, back)), to = iso(startOf(s, back - 1));
  return { from, to, observedFrom: from, observedThrough: back === 0 ? asOf : to, complete: back > 0 };
}
const stands = (value: number) => ({ value, why: null });
const tally = (window: Obj, n: number) => ({ window, figure: stands(n), numerator: n, denominator: null });
const shareAt = (window: Obj, n: number, d: number) => ({
  window, numerator: n, denominator: d,
  figure: d === 0 ? { value: null, why: "no_data" } : { value: (100 * n) / d, why: d < 30 ? "insufficient" : null },
});
const unavailableAt = (window: Obj) => ({ window, figure: { value: null, why: "unavailable" }, numerator: null, denominator: null });
const backs = (): number[] => Array.from({ length: DRAWN }, (_, i) => FIRST - i);

function wantShelf(s: KnowledgeSeeded, asOf: string, shelf: string, kind: string, v: number[]): Obj {
  return { shelf, kind, standing: v[0], superseded: v[1], imported: v[2], madeLastWeek: v[3], searchesLastWeek: v[4],
    noResult: shareAt(windowAt(s, 1, asOf), v[5], v[4]) };
}

/** Everything both readers read alike: the tiles, the charts and the kinds. */
function wantCharts(s: KnowledgeSeeded, asOf: string, lessonWeeks = LESSON_WEEKS, byKind = BY_KIND, standing = 15): Obj {
  const lessons = (back: number) => lessonWeeks[back] ?? [0, 0, 0, 0, 0, null];
  const searches = (back: number) => SEARCH_WEEKS[back] ?? [0, 0, 0, 0];
  return {
    tiles: { state: "ok", data: {
      standing,
      madeLastWeek: { last: tally(windowAt(s, 1, asOf), lessons(1)[0]), previous: tally(windowAt(s, 2, asOf), lessons(2)[0]) },
      searches: { last: tally(windowAt(s, 1, asOf), searches(1)[0]), previous: tally(windowAt(s, 2, asOf), searches(2)[0]) },
      noResult: { last: shareAt(windowAt(s, 1, asOf), searches(1)[1], searches(1)[0]), previous: shareAt(windowAt(s, 2, asOf), searches(2)[1], searches(2)[0]) },
    } },
    made: { state: "ok", data: {
      exactFrom: iso(startOf(s, EXACT_FROM[0]) + EXACT_FROM[1]),
      weeks: backs().map((b) => ({ window: windowAt(s, b, asOf), made: stands(lessons(b)[0]), importedExact: lessons(b)[1], importedByDay: lessons(b)[2] })),
    } },
    searches: { state: "ok", data: { weeks: backs().map((b) => {
      const [d, empty, widened, results] = searches(b);
      const w = windowAt(s, b, asOf);
      return {
        window: w, noResult: shareAt(w, empty, d),
        widened: b > WIDENED_FROM ? unavailableAt(w) : shareAt(w, widened, d),
        meanResults: d === 0 ? { value: null, why: "no_data" } : { value: results / d, why: d < 30 ? "insufficient" : null },
      };
    }) } },
    cohorts: { state: "ok", data: { rows: backs().map((b) => {
      const [, exact, byDay, made, superseded, basis] = lessons(b);
      return { window: windowAt(s, b, asOf), made, supersededSince: superseded, imported: exact + byDay, basis };
    }) } },
    byKind: { state: "ok", data: byKind.map(([kind, n]) => ({ kind, standing: n })) },
  };
}

function wantMeta(s: KnowledgeSeeded, asOf: string, scope: string): Obj {
  return { asOf, timezone: TIMEZONE, period: { from: iso(startOf(s, FIRST)), to: asOf }, scope,
    population: "standing lessons on every shelf, imports included; lessons made outside import cohorts; real-work searches",
    coverageFrom: iso(startOf(s, 28) + HOUR) };
}

function wantQuestions(s: KnowledgeSeeded, asOf: string): Obj {
  return { state: "ok", data: {
    window: { from: iso(startOf(s, FIRST)), to: iso(startOf(s, -1)), observedFrom: iso(startOf(s, FIRST)), observedThrough: asOf, complete: false },
    rows: QUESTIONS.map(([question, shelf, asked, back, ms]) => ({ question, shelf, asked, lastAskedAt: iso(startOf(s, back) + ms) })),
    total: QUESTION_TOTAL,
  } };
}

/* ---- The cases ---- */

function superadminCase(s: KnowledgeSeeded, a: Answer): void {
  const step = "the superadmin's read";
  if (a.status !== 200 || !isObj(a.body.meta)) fail(step, `answered ${a.status}: ${a.text.slice(0, 400)}`);
  const asOf = String((a.body.meta as Obj).asOf);
  expectSame(step, "meta", a.body.meta, wantMeta(s, asOf, "platform-admin"));
  const shelves = { state: "ok", data: { rows: [
    wantShelf(s, asOf, "alder", "team", SHELVES.alder), wantShelf(s, asOf, "birch", "own", SHELVES.birch),
    wantShelf(s, asOf, "cedar", "team", SHELVES.cedar), wantShelf(s, asOf, "zz-platform", "shared", SHELVES["zz-platform"]),
    wantShelf(s, asOf, "all", "all", SHELVES.all),
  ] } };
  expectSame(step, "the shelves", a.body.shelves, shelves);
  const charts = wantCharts(s, asOf);
  for (const k of Object.keys(charts)) expectSame(step, k, a.body[k], charts[k]);
  expectSame(step, "the questions", a.body.questions, wantQuestions(s, asOf));
  pass("the superadmin reads 15 standing lessons, every shelf by slug with birch their own, 26 weeks of lessons made " +
       "outside the cohorts (back 3 leaving 6 out by the day, L 3 exactly and 1 by the day) from exact attribution's " +
       "first event, the searches' shares and mean results, each week's cohort with back 3 and L labelled by the day, " +
       "the kinds, and ten of fifteen questions with no result, most asked first");
}

function memberCase(s: KnowledgeSeeded, a: Answer, admin: Answer): void {
  const step = "the member's read";
  if (a.status !== 200 || !isObj(a.body.meta)) fail(step, `answered ${a.status}: ${a.text.slice(0, 400)}`);
  const asOf = String((a.body.meta as Obj).asOf);
  expectSame(step, "meta", a.body.meta, wantMeta(s, asOf, "platform-public"));
  expectSame(step, "the shelves", a.body.shelves, { state: "ok", data: { rows: [
    wantShelf(s, asOf, "own", "own", SHELVES.alder), wantShelf(s, asOf, "shared", "shared", SHELVES["zz-platform"]),
    wantShelf(s, asOf, "all", "all", SHELVES.all),
  ] } });
  const charts = wantCharts(s, asOf);
  for (const k of Object.keys(charts)) expectSame(step, k, a.body[k], charts[k]);
  if (!("questions" in a.body) || a.body.questions !== null) fail(step, `questions read ${JSON.stringify(a.body.questions)}`);
  const strip = (b: Obj, at: string) => text({ ...b, meta: null, shelves: null, questions: null }).replaceAll(at, "<asOf>");
  if (strip(a.body, asOf) !== strip(admin.body, String((admin.body.meta as Obj).asOf))) fail(step, "the charts differ from the superadmin's");
  for (const p of PRIVATE) if (a.text.includes(p)) fail(step, `the answer holds ${JSON.stringify(p)}`);
  pass("a member reads alder as `own`, the shared shelf as `shared` and the totals as `all`, the same tiles, charts and " +
       "kinds as the superadmin, the questions null, and no question and no other shelf's slug");
}

async function run(db: pg.Client, url: string): Promise<void> {
  const seeded = await seedKnowledgeHealth(db, TIMEZONE);
  const cookie = new Map<string, string>();
  for (const email of [MEMBER, SUPERADMIN]) cookie.set(email, await signIn(db, email));

  // `withThrowawayDb` ended the gateway's pool after migrating; a fresh one on the same container, and the reporting
  // timezone set before shared.js reads it at load.
  process.env.TEAM_DB_URL = url;
  process.env.ZZ_TZ = TIMEZONE;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  const load = (p: string) => import(pathToFileURL(join(root, "services/gateway/dist", p)).href);
  const express = (await import("express")).default;
  const dbModule = (await load("db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await dbModule.initPlatformDb();
  const { identityMiddleware } = (await load("identity.js")) as { identityMiddleware: () => RequestHandler };
  const { mountPlatformKnowledge } = (await load("console/platform-knowledge.js")) as { mountPlatformKnowledge: (app: Express) => void };
  const app = express();
  // COUPLED: services/gateway/src/server.ts — the identity gate before every console route.
  app.use(identityMiddleware());
  mountPlatformKnowledge(app);
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/console/platform/knowledge`;
  const as = async (email: string, query = ""): Promise<Answer> => {
    const res = await fetch(`${base}${query}`, { headers: { cookie: `zz_console=${cookie.get(email)}` }, signal: AbortSignal.timeout(30_000) });
    const body = await res.text();
    let parsed: Obj = {};
    try { const v: unknown = JSON.parse(body); if (isObj(v)) parsed = v; } catch { /* not JSON: body stays empty */ }
    return { status: res.status, body: parsed, text: body };
  };
  /** An answer with its own cutoff spelled out of it, so two reads a second apart compare. */
  const settled = (a: Answer): string => text(a.body).replaceAll(String((a.body.meta as Obj | undefined)?.asOf), "<asOf>");
  /** `read` run with the gateway's error log held back, and what it logged: a part that failed logs its statement. */
  const quietly = async <T>(read: () => Promise<T>): Promise<[T, string[]]> => {
    const quiet = console.error, logged: string[] = [];
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
    try { return [await read(), logged]; } finally { console.error = quiet; }
  };

  try {
    const admin = await as(SUPERADMIN);
    superadminCase(seeded, admin);
    const member = await as(MEMBER);
    memberCase(seeded, member, admin);

    let step = "a team or scope parameter";
    const [memberAsked, adminAsked] = [await as(MEMBER, "?team=cedar&scope=platform"), await as(SUPERADMIN, "?team=alder&scope=team")];
    if (settled(memberAsked) !== settled(member) || settled(adminAsked) !== settled(admin)) fail(step, "an answer moved");
    pass("?team= and ?scope= change neither the member's answer nor the superadmin's");

    step = "a member's read selects no question";
    await db.query("alter table zz.event rename column subject to subject_hidden");
    let memberBlind!: Answer, memberLog!: string[], adminBlind!: Answer;
    try {
      [memberBlind, memberLog] = await quietly(() => as(MEMBER));
      [adminBlind] = await quietly(() => as(SUPERADMIN));
    } finally {
      await db.query("alter table zz.event rename column subject_hidden to subject");
    }
    // A statement that failed in a part the member is never shown would leave the answer as it was; its log would not.
    if (memberLog.length) fail(step, `the member's read ran a statement that failed: ${memberLog[0].slice(0, 300)}`);
    if (settled(memberBlind) !== settled(member)) fail(step, `the member's answer moved: ${memberBlind.text.slice(0, 400)}`);
    if (text(adminBlind.body.questions) !== text({ state: "unavailable", reason: "query_failed" })
        || settled({ ...adminBlind, body: { ...adminBlind.body, questions: null } }) !== settled({ ...admin, body: { ...admin.body, questions: null } })) {
      fail(step, `the superadmin's answer read ${adminBlind.text.slice(0, 400)}`);
    }
    pass("with zz.event.subject gone the member's read runs no statement that fails and answers as before, and only the " +
         "superadmin's questions are unavailable");

    step = "the shapes the console's fake answers";
    let fake: { knowledge: (admin: boolean, own: string | null) => unknown };
    try {
      fake = (await import(pathToFileURL(FAKE).href)) as typeof fake;
    } catch (err) {
      fail(step, `could not read the console's fake answer at ${FAKE}: ${(err as Error).message}`);
    }
    const diffs = [
      ...shapeDiffs(admin.body, fake.knowledge(true, "atlas"), "superadmin", []),
      ...shapeDiffs(member.body, fake.knowledge(false, "atlas"), "member", []),
    ];
    const fakeMember = fake.knowledge(false, "atlas") as Obj;
    if (!("questions" in fakeMember) || fakeMember.questions !== null) diffs.push("the fake's member questions are not null");
    if (diffs.length) fail(step, diffs.join("; "));
    pass("both answers agree in shape with the fake's, key set by key set, and the fake's member questions are null");

    step = "an import added afterwards";
    await seedAddedImport(db, seeded);
    const after = await as(SUPERADMIN);
    const asOf = String((after.body.meta as Obj).asOf);
    const charts = wantCharts(seeded, asOf, { ...LESSON_WEEKS, 0: ADDED.running as [number, number, number, number, number, "exact"] },
      ADDED.byKind, ADDED.standing);
    for (const k of Object.keys(charts)) expectSame(step, k, after.body[k], charts[k]);
    const rows = ((after.body.shelves as Obj).data as Obj).rows as Obj[];
    expectSame(step, "cedar", rows.find((r) => r.shelf === "cedar"), wantShelf(seeded, asOf, "cedar", "team", ADDED.cedar));
    expectSame(step, "the totals", rows.find((r) => r.shelf === "all"), wantShelf(seeded, asOf, "all", "all", ADDED.all));
    pass("four lessons imported exactly into cedar this week raise the standing lessons to 19, cedar's imports to 4 and " +
         "this week's cohort to 5 labelled exact, and leave every week's lessons made as they were");

    step = "a part that cannot be read";
    await db.query("alter table zz.knowledge_node rename to knowledge_node_hidden");
    const [[broken, brokenMember]] = await quietly(async () => [await as(SUPERADMIN), await as(MEMBER)]).finally(() =>
      db.query("alter table zz.knowledge_node_hidden rename to knowledge_node"));
    for (const [who, a, ref] of [["the superadmin", broken, after], ["the member", brokenMember, member]] as const) {
      if (a.status !== 200) fail(step, `${who} answered ${a.status}: ${a.text.slice(0, 300)}`);
      for (const k of ["tiles", "shelves", "made", "cohorts", "byKind"]) {
        if (text(a.body[k]) !== text({ state: "unavailable", reason: "query_failed" })) fail(step, `${who}'s ${k} read ${text(a.body[k]).slice(0, 200)}`);
      }
      const at = String((a.body.meta as Obj).asOf), refAt = String((ref.body.meta as Obj).asOf);
      if (text(a.body.searches).replaceAll(at, "<asOf>") !== text(ref.body.searches).replaceAll(refAt, "<asOf>")
          || text(a.body.questions).replaceAll(at, "<asOf>") !== text(ref.body.questions).replaceAll(refAt, "<asOf>")) {
        fail(step, `${who}'s searches or questions moved`);
      }
    }
    pass("with zz.knowledge_node unreadable the tiles, shelves, lessons made, cohorts and kinds are unavailable, and the " +
         "searches and questions stand as they were, for both readers");
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
