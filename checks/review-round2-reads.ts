#!/usr/bin/env node
/**
 * checks/review-round2-reads.ts — the gateway reads review round 2 found wrong answer only what their routes
 * answer: an agent read bounded as its page, the knowledge log's totals over the whole log, and the word
 * counts a read found cached kept whatever the cache does (AC-5.2, AC-6.3, AC-7.1).
 *
 *   node checks/review-round2-reads.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL migrated by the real runner, seeds its own teams, initiatives, calls,
 * knowledge log entries and lessons beside the runs `scripts/schema/runs-seed.ts` declares, and calls the
 * gateway's own built functions (`services/gateway/dist/console/agent-reads.js`, `activity.js`, `runs.js`,
 * `runs-observed.js`, `findings.js`, `writing.js`) and the knowledge log's mounted route the way Express would, as a console
 * session. What it establishes:
 *
 *   - `activity_refusals` with a `since` before Activity's window answers the window Activity's summary
 *     route answers, from the same first instant with the same weeks: never more than its newest 24 whole
 *     weeks and the running one, and never a week before the team's first call; a `since` inside it starts
 *     at that date's first instant;
 *   - `activity_refusals` with an initiative the team does not hold, another team's or a slug nobody has,
 *     is refused in the initiative route's own not-found sentence, alike for both, while the team's own
 *     initiative is read;
 *   - `run_summary` with a `since` clips every run at that date's first instant as at the cutoff: its
 *     coverage, summed length and peak are what observedRuns answers over the same window, and the record
 *     it reads starts at that instant, never before it;
 *   - a door's days with no call say that no call was recorded, never that no tool failure was;
 *   - the knowledge log answers its newest 500 entries and, beside them, its totals over every entry
 *     before the cutoff: the entries, those recorded and those superseded, another team's and a later
 *     entry left out;
 *   - a read that finds the word-count cache past its bound counts every lesson it found cached as well
 *     as those it counted itself: the retained stock is every lesson's words, never only the newest's.
 *
 * DELIBERATE: the last case makes one lesson more than the word-count cache's bound, read from the
 * gateway's own source so a bound that moves is still passed; at 200,000 bodies that is 200,001 lessons,
 * which takes the throwaway some seconds.
 *
 * The only database it touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — every case that did and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import { CUTOFFS, TEAM as RUNS_TEAM, TIMEZONE, WEEK, seedRuns } from "../scripts/schema/runs-seed.ts";
import { withThrowawayDb } from "../scripts/schema/throwaway.ts";

const NAME = "review-round2-reads";
const DONE = "review-round2-reads: activity_refusals answers no more than Activity's window and refuses an initiative the " +
  "team does not hold, run_summary clips its runs at its since, a door nobody called says so, the knowledge log totals " +
  "every entry past its 500, and a read past the word cache's bound keeps every count it found: ok";
/** The initiative route's not-found. COUPLED: NO_INITIATIVE in services/gateway/src/console/initiatives.ts. */
const NO_INITIATIVE = "No initiative of the team you act for has that name.";
const ONE = "round2-one", TWO = "round2-two", WRITING = "round2-writing";
const OWN = "2026-10-01-round2-own", THEIRS = "2026-10-01-round2-theirs";
/** One lesson past the word-count cache's bound. COUPLED: COUNTED_BOUND in services/gateway/src/console/writing.ts,
 *  read from there rather than copied, so a raised bound is still passed and the case still reads past it. */
const BOUND = /^const COUNTED_BOUND = ([\d_]+);$/m
  .exec(readFileSync(join(root, "services/gateway/src/console/writing.ts"), "utf8"))?.[1];
if (BOUND === undefined) {
  console.error(`${NAME}: services/gateway/src/console/writing.ts no longer declares COUNTED_BOUND, so no case can pass it`);
  process.exit(1);
}
const PAST_BOUND = Number(BOUND.replaceAll("_", "")) + 1;
/** The knowledge log's ceiling, and the entries seeded past it. */
const CEILING = 500;
const RECORDED = 520, SUPERSEDED = 10;
const DAY = 86_400_000;

type Obj = Record<string, unknown>;
type Route = (req: unknown, res: unknown) => void;
type Span = { from: string; to: string };
type Part<T> = { state: "ok"; data: T } | { state: "unavailable"; reason: string };
type Caller = { email: string; superadmin: boolean; activeTeam: string | null };
type Summary = { meta: { period: { from: string; to: string }; coverageFrom: string | null }; weeks: Part<{ window: { from: string } }[]> };
type Coverage = { coverageMs: number; summedMs: number; peak: number };
type Gateway = {
  activityRefusals: (caller: Caller, args: { since?: string; initiative?: string }, asOf: string) => Promise<Summary | { inputError: string }>;
  summaryOf: (team: string, asOf: string) => Promise<Summary>;
  cutoff: () => string;
  midnight: (date: string) => number;
  localDay: (ms: number) => string;
  runsAt: (team: string, params: { skill: string | null; limit: number; offset: number; since?: string | null }, asOf: string) =>
    Promise<{ since: string | null; meta: { period: Span; coverageFrom: string | null }; coverage: Coverage }>;
  observedRuns: (team: string, window: Span, asOf: string) => Promise<Coverage>;
  retainedStock: (team: string, asOf: string) => Promise<{ words: number }>;
  runFinding: (days: { date: string; calls: number | null; toolFailures: number | null; complete: boolean; available: boolean }[]) =>
    { kind: string; text: string; dates: string[]; tie: boolean };
  log: Route;
};

class CaseFailure extends Error {}
function fail(step: string, detail: string): never {
  throw new CaseFailure(`"${step}": ${detail}`);
}
const show = (v: unknown): string => JSON.stringify(v).slice(0, 700);
/** An instant as the gateway spells one: ISO 8601 in UTC, whole seconds, with the Z. */
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** The request a console session's read arrives as, past the gateway's middleware (COUPLED: identity.ts). */
function request(team: string | null, query: Obj = {}): Obj {
  return {
    params: {}, query, body: {},
    zzIdentity: { email: "round2@example.test", displayName: "Round 2", platformRole: "member", via: "session",
                  teams: team ? [{ slug: team, role: "admin" }] : [], activeTeam: team, patTeam: null, sessionTeam: team },
    headers: {},
  };
}

/** Calls a mounted route as Express would, and waits for what it sends. */
function answer(route: Route, req: Obj): Promise<{ status: number; body: Obj }> {
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

/** The teams, their initiatives and the calls Activity counts: the first team's first call 40 weeks back, past the
 *  window's 24, the second team's three weeks back, and a refusal each two days back; then the knowledge log's
 *  entries, the first team's past the ceiling, one of them after the cutoff, and three of the second team's. */
async function seed(db: pg.Client): Promise<void> {
  const { rows: [person] } = await db.query<{ id: string }>(
    "insert into zz.principal (email, display_name, role) values ('round2@example.test', 'round2', 'member') returning id");
  const teams = new Map<string, string>();
  for (const slug of [ONE, TWO, WRITING]) {
    teams.set(slug, (await db.query<{ id: string }>(
      "insert into zz.team (slug, name, created_by) values ($1, $1, $2) returning id", [slug, person.id])).rows[0].id);
  }
  for (const [team, slug] of [[ONE, OWN], [TWO, THEIRS]]) {
    await db.query("insert into zz.initiative (team_id, slug) values ($1, $2)", [teams.get(team), slug]);
  }
  for (const [team, daysBack, ok] of [[ONE, 280, true], [ONE, 3, true], [ONE, 2, false], [TWO, 21, true], [TWO, 2, false]] as [string, number, boolean][]) {
    await db.query(
      `insert into zz.event (ts, kind, subject, ok, tool_key, refusal, refusal_owner, origin, team_id, actor_id)
       values (now() - $1 * interval '1 day', 'tool_call', 'core:document_write', $2, 'core:document_write',
               case when $2 then null else 'ERROR: GATE_REFUSED spec.md needs explore.md approved' end,
               case when $2 then null else 'guardrail' end, 'work', $3, $4)`,
      [daysBack, ok, teams.get(team), person.id]);
  }
  await db.query(
    `insert into zz.event (ts, kind, subject, detail, origin, team_id, actor_id)
     select now() - g * interval '1 minute', case when g <= $2 then 'knowledge.supersede' else 'knowledge.add' end,
            lpad(g::text, 4, '0'), jsonb_build_object('title', 'lesson ' || g), 'work', $3, $4
       from generate_series(1, $1::int) g`,
    [RECORDED + SUPERSEDED, SUPERSEDED, teams.get(ONE), person.id]);
  await db.query(
    `insert into zz.event (ts, kind, subject, detail, origin, team_id, actor_id)
     values (now() + interval '1 day', 'knowledge.add', '9999', '{"title": "after the cutoff"}', 'work', $1, $3),
            (now() - interval '1 hour', 'knowledge.add', '0001', '{"title": "theirs"}', 'work', $2, $3),
            (now() - interval '2 hours', 'knowledge.add', '0002', '{"title": "theirs"}', 'work', $2, $3),
            (now() - interval '3 hours', 'knowledge.add', '0003', '{"title": "theirs"}', 'work', $2, $3)`,
    [teams.get(ONE), teams.get(TWO), person.id]);
}

const caller = (team: string): Caller => ({ email: "round2@example.test", superadmin: false, activeTeam: team });
const weeks = (step: string, s: Summary): number => {
  if (s.weeks.state !== "ok") fail(step, `the weeks read ${show(s.weeks)}`);
  return s.weeks.data.length;
};
/** activity_refusals' answer, or the case fails on an input error. */
async function summary(g: Gateway, step: string, team: string, args: { since?: string; initiative?: string }, asOf: string): Promise<Summary> {
  const a = await g.activityRefusals(caller(team), args, asOf);
  if ("inputError" in a) fail(step, `refused ${show(args)}: ${a.inputError}`);
  return a;
}

/** activity_refusals' window: from a since before the newest 24 weeks, before the team's first call, and inside it. */
const activityCases: ((g: Gateway) => Promise<string>)[] = [
  async (g) => {
    const step = "activity_refusals from a since before the newest 24 weeks";
    const asOf = g.cutoff();
    const route = await g.summaryOf(ONE, asOf);
    const early = await summary(g, step, ONE, { since: "1970-01-01" }, asOf);
    if (early.meta.period.from !== route.meta.period.from || weeks(step, early) !== weeks(step, route) || weeks(step, route) !== 25) {
      fail(step, `from ${early.meta.period.from} over ${weeks(step, early)} weeks, where Activity's route answers from ` +
        `${route.meta.period.from} over ${weeks(step, route)}`);
    }
    return `${step}: from 1970 it answers Activity's own window, from ${route.meta.period.from} over 25 weeks, not one per week since 1970`;
  },
  async (g) => {
    const step = "activity_refusals from a since before the team's first call";
    const asOf = g.cutoff();
    const route = await g.summaryOf(TWO, asOf);
    const tenWeeks = g.localDay(Date.now() - 70 * DAY);
    const before = await summary(g, step, TWO, { since: tenWeeks }, asOf);
    if (before.meta.period.from !== route.meta.period.from || weeks(step, before) !== weeks(step, route)) {
      fail(step, `from ${tenWeeks} it answers from ${before.meta.period.from} over ${weeks(step, before)} weeks, where Activity's ` +
        `route answers from ${route.meta.period.from} over ${weeks(step, route)}`);
    }
    return `${step}: from ${tenWeeks} it answers from the first call's week, ${route.meta.period.from}, as the route does`;
  },
  async (g) => {
    const step = "activity_refusals from a since inside the window";
    const tenDays = g.localDay(Date.now() - 10 * DAY);
    const inside = await summary(g, step, ONE, { since: tenDays }, g.cutoff());
    if (inside.meta.period.from !== iso(g.midnight(tenDays))) fail(step, `from ${tenDays} it answers from ${inside.meta.period.from}`);
    return `${step}: from ${tenDays} it answers from that date's first instant`;
  },
  async (g) => {
    const step = "activity_refusals in an initiative the team does not hold";
    const asOf = g.cutoff();
    for (const slug of [THEIRS, "2026-10-01-nobody-round2"]) {
      const a = await g.activityRefusals(caller(ONE), { initiative: slug }, asOf);
      if (!isDeepStrictEqual(a, { inputError: NO_INITIATIVE })) fail(step, `${slug} answered ${show(a)}`);
    }
    await summary(g, step, ONE, { initiative: OWN }, asOf);
    return `${step}: the second team's and a slug nobody has are refused alike, in the initiative route's words; the team's own is read`;
  },
];

async function runsCase(g: Gateway): Promise<string> {
  const step = "run_summary clipped at its since";
  const since = "2026-09-07";
  const from = iso(Date.parse(WEEK.from));
  const got = await g.runsAt(RUNS_TEAM, { skill: null, limit: 100, offset: 0, since }, CUTOFFS.late);
  const observed = await g.observedRuns(RUNS_TEAM, { from: WEEK.from, to: CUTOFFS.late }, CUTOFFS.late);
  const found = { coverageMs: got.coverage.coverageMs, summedMs: got.coverage.summedMs, peak: got.coverage.peak, since: got.since, coverageFrom: got.meta.coverageFrom };
  const want = { coverageMs: observed.coverageMs, summedMs: observed.summedMs, peak: observed.peak, since: from, coverageFrom: from };
  if (!isDeepStrictEqual(found, want)) fail(step, `it reads ${show(found)}, where observedRuns over the same window reads ${show(want)}`);
  return `${step}: r1, under way at ${since}'s first instant, counts only its hour after it, as observedRuns counts it, and the record starts at ${from}`;
}

async function doorCase(g: Gateway): Promise<string> {
  const step = "a door nobody called in its days";
  const d = (date: string, calls: number, complete = true) => ({ date, calls, toolFailures: 0, complete, available: true });
  const idle = g.runFinding([d("2026-10-10", 0), d("2026-10-11", 0), d("2026-10-12", 0, false)]);
  const used = g.runFinding([d("2026-10-10", 0), d("2026-10-11", 4), d("2026-10-12", 0, false)]);
  const found = [idle, used.text], want = [{ kind: "count", text: "No call recorded since 10 Oct", dates: ["2026-10-10"], tie: false },
    "No tool failure recorded in 4 calls since 10 Oct"];
  if (!isDeepStrictEqual(found, want)) fail(step, `it reads ${show(found)}, expected ${show(want)}`);
  return `${step}: says no call was recorded, never that no tool failure was, while a door with calls still says it had none fail`;
}

async function logCase(g: Gateway): Promise<string> {
  const step = "the knowledge log's totals past its ceiling";
  const a = await answer(g.log, request(ONE));
  if (a.status !== 200) fail(step, `the log answered ${a.status}: ${show(a.body)}`);
  const entries = a.body.entries as unknown[];
  const found = { entries: entries.length, totals: a.body.totals, ceiling: a.body.ceiling };
  const want = { entries: CEILING, totals: { entries: RECORDED + SUPERSEDED, recorded: RECORDED, superseded: SUPERSEDED }, ceiling: CEILING };
  if (!isDeepStrictEqual(found, want)) fail(step, `it reads ${show(found)}, expected ${show(want)}`);
  return `${step}: the newest 500 of ${RECORDED + SUPERSEDED} entries, totalled as ${RECORDED} recorded and ${SUPERSEDED} superseded, the later entry and the second team's left out`;
}

async function writingCase(db: pg.Client, g: Gateway): Promise<string> {
  const step = "a read past the word cache's bound keeps the counts it found";
  const { rows: [team] } = await db.query<{ id: string }>("select id::text as id from zz.team where slug = $1", [WRITING]);
  const lessons = (from: number, to: number) => db.query(
    `insert into zz.knowledge_node (kind, title, body, team_id, node_ordinal, slug, created_at, updated_at)
     select 'knowledge', 'lesson ' || g, 'three words here', $1, lpad(g::text, 6, '0'), 'lesson-' || g,
            now() - interval '1 day', now() - interval '1 day'
       from generate_series($2::int, $3::int) g`, [team.id, from, to]);
  await lessons(1, PAST_BOUND);
  const first = await g.retainedStock(WRITING, g.cutoff());
  await lessons(PAST_BOUND + 1, PAST_BOUND + 1);
  // A cutoff of its own, so the read is not the first one's shared ledger.
  const second = await g.retainedStock(WRITING, iso(Date.parse(g.cutoff()) + 1000));
  const found = [first.words, second.words], want = [3 * PAST_BOUND, 3 * (PAST_BOUND + 1)];
  if (!isDeepStrictEqual(found, want)) fail(step, `the stock reads ${show(found)}, expected ${show(want)}`);
  return `${step}: ${PAST_BOUND.toLocaleString("en-GB")} lessons counted fill it, and the read that counts one more still sums all ${(PAST_BOUND + 1).toLocaleString("en-GB")}`;
}

async function run(db: pg.Client, url: string): Promise<string[]> {
  await seed(db);
  await seedRuns(db);

  // DELIBERATE: set before the gateway's modules load, which read both once.
  process.env.TEAM_DB_URL = url;
  process.env.ZZ_TZ = TIMEZONE;
  const load = (p: string) => import(pathToFileURL(join(root, "services/gateway/dist", p)).href);
  const dbModule = (await load("db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await dbModule.initPlatformDb();
  const knowledge = (await load("console/knowledge.js")) as { mountKnowledge: (app: unknown) => void };
  const routes = new Map<string, Route>();
  knowledge.mountKnowledge({ get: (p: string, h: Route) => routes.set(p, h) });
  const g: Gateway = {
    ...((await load("console/agent-reads.js")) as Pick<Gateway, "activityRefusals">),
    ...((await load("console/activity.js")) as Pick<Gateway, "summaryOf" | "cutoff">),
    ...((await load("console/work-query-buckets.js")) as Pick<Gateway, "midnight" | "localDay">),
    ...((await load("console/runs.js")) as Pick<Gateway, "runsAt">),
    ...((await load("console/runs-observed.js")) as Pick<Gateway, "observedRuns">),
    ...((await load("console/writing.js")) as Pick<Gateway, "retainedStock">),
    ...((await load("console/findings.js")) as Pick<Gateway, "runFinding">),
    log: routes.get("/api/console/knowledge/log") ?? fail("mount", "no route GET /api/console/knowledge/log"),
  };

  const failed: string[] = [];
  try {
    // Each case alone, so one that fails leaves the rest to say what they find.
    for (const one of [...activityCases.map((c) => () => c(g)), () => runsCase(g), () => doorCase(g), () => logCase(g), () => writingCase(db, g)]) {
      try {
        console.log(`  ok  ${await one()}`);
      } catch (err) {
        if (!(err instanceof CaseFailure)) throw err;
        failed.push(err.message);
      }
    }
  } finally {
    await dbModule.platformDb().end().catch(() => undefined);
    delete process.env.TEAM_DB_URL;
    delete process.env.ZZ_TZ;
  }
  return failed;
}

async function main(): Promise<number> {
  let dbUrl = "";
  let failed: string[];
  try {
    failed = await withThrowawayDb((db) => run(db, dbUrl), async (u) => { dbUrl = u; });
  } catch (err) {
    if (err instanceof Error && /Docker is not running/.test(err.message)) {
      console.error(`${NAME}: Docker is not available — the check could not run, which is not a pass`);
      return 2;
    }
    console.error(`${NAME}: ${String((err as Error)?.stack ?? err)}`);
    return 1;
  }
  if (failed.length) {
    console.error(`${NAME}: FAILED\n  ${failed.join("\n  ")}`);
    return 1;
  }
  console.log(DONE);
  return 0;
}

process.exitCode = await main();
