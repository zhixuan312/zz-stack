#!/usr/bin/env node
/**
 * checks/console-work-runs.ts — Runs is read for the active team: what ran, its observed output, by
 * skill and lately (AC-6.4).
 *
 *   node checks/console-work-runs.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL migrated by the real runner, seeds the runs
 * `scripts/schema/runs-seed.ts` declares, and calls the gateway's own built read
 * (`services/gateway/dist/console/runs.js`) at a fixed cutoff, and its mounted route the way Express
 * would, as a console session. What it establishes, against the seed's written values:
 *
 *   - the tiles answer the team's runs since its first, the mean observed output over the runs that
 *     measured it with how many did not, and the largest run with its skill and initiative;
 *   - by skill, each row's runs, calls per run, share of calls refused, output per run and typical
 *     length, the median over its runs of more than one call with their count beside, sorted by
 *     output per run, then skill;
 *   - the recent runs newest first by their last call, paged at 10 and at most 100, each with its
 *     initiative and its state: active when its last call is five minutes before the cutoff,
 *     last_call six minutes back, one_call for a run of one call;
 *   - the coverage is the union of the runs' spans, two overlapping runs' shared time counted once in
 *     it and twice in the summed length, with the peak overlap and the runs of one call, as
 *     observedRuns answers them over the same runs; overlapping runs are counted once each and their
 *     output once each;
 *   - skill narrows the tiles, the table, the coverage and the recent runs, and a skill the team never
 *     ran answers nothing;
 *   - a bad limit or offset is refused 400, and so is a person in no team;
 *   - another team's runs change nothing;
 *   - a run whose every call a maintenance client made is no run: not counted, never the largest, never
 *     active or the last run, while a run of real work with maintenance calls in it counts only its own
 *     calls, refusals and output, as observedRuns reads them too;
 *   - with the run record unreadable the read fails whole and names nobody;
 *   - no field or label says context, tokens or cost, and the key sets match the console's fake.
 *
 * DELIBERATE: the read is called at a fixed cutoff, the seed's LATE, so a run's state is decided
 * against the seed's own instants rather than the day the check runs; the mounted route reads at
 * the moment it is called, when every seeded run is long over.
 *
 * The only database it touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import { CUTOFFS, OTHER, RUNS_READ, TEAM, TIMEZONE, seedRuns } from "../scripts/schema/runs-seed.ts";
import { withThrowawayDb } from "../scripts/schema/throwaway.ts";
import { shapeDiffs } from "../scripts/schema/shape-diffs.ts";

const NAME = "console-work-runs";
const DONE = "console-work-runs: Runs reads the active team's runs since its first, their observed output, by skill and " +
  "lately, active within five minutes of the cutoff and never running, the coverage as observedRuns counts it, another " +
  "team's changing nothing and the key sets the fake's: ok";
/** COUPLED: the fake answer in the console's checkout, `../zz-stack-dashboard` here and in CI. */
const FAKE = join(root, "..", "zz-stack-dashboard", "scripts", "fake-gateway", "work-runs.ts");
const SOURCE = join(root, "services", "gateway", "src", "console", "runs.ts");
/** The words no field or label of Runs may say. */
const FORBIDDEN = /context|tokens?\b|\bcost/i;

type Obj = Record<string, unknown>;
type Route = (req: unknown, res: unknown) => void;
type Span = { from: string; to: string };
type RunRow = { id: string; skill: string; initiative: string | null; lastCallAt: string; state: string } & Obj;
type Part<T> = { state: "ok"; data: T } | { state: "unavailable"; reason: string };
type Runs = {
  meta: Obj; since: string | null;
  tiles: { runs: { value: number | null; why: string | null }; outputPerRun: { value: number | null; why: string | null; unmeasured: number }; largest: RunRow | null };
  coverage: { coverageMs: number; summedMs: number; peak: number; oneCall: number };
  bySkill: Part<{ rows: Obj[] }>;
  recent: Part<{ rows: RunRow[]; total: number }>;
};
type Params = { skill: string | null; limit: number; offset: number };
type Reads = {
  runsAt: (team: string, params: Params, asOf: string) => Promise<Runs>;
  observedRuns: (team: string, window: Span, asOf: string) => Promise<{ coverageMs: number; summedMs: number; peak: number; zeroLength: number }>;
  route: Route;
};

class CaseFailure extends Error {}
function fail(step: string, detail: string): never {
  throw new CaseFailure(`${NAME}: FAILED at "${step}": ${detail}`);
}
const pass = (line: string): void => console.log(`  ok  ${line}`);
const show = (v: unknown): string => JSON.stringify(v).slice(0, 700);
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

/** Each field named, as found against as written. */
function expect(step: string, found: Obj, want: Obj): void {
  const wrong = Object.keys(want).filter((k) => !isDeepStrictEqual(found[k], want[k]));
  if (wrong.length) fail(step, wrong.map((k) => `${k} read ${show(found[k])}, expected ${show(want[k])}`).join("; "));
}

/** A part's data, or the case fails. */
function ok<T>(step: string, part: Part<T>): T {
  if (part.state !== "ok") fail(step, `the part answered ${show(part)}`);
  return part.data;
}

/** Every key and every text an answer holds, at any depth. */
function words(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(words);
  if (isObj(v)) return Object.entries(v).flatMap(([k, x]) => [k, ...words(x)]);
  return typeof v === "string" ? [v] : [];
}

/** The request a console session's read arrives as, past the gateway's middleware (COUPLED: identity.ts). */
function request(team: string | null, query: Obj = {}): Obj {
  return {
    params: {}, query, body: {},
    zzIdentity: { email: "runs@example.test", displayName: "Runs", platformRole: "member", via: "session",
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

const ALL: Params = { skill: null, limit: 100, offset: 0 };

async function cases(db: pg.Client, read: Reads, keyOf: Map<string, string>): Promise<void> {
  const key = (id: string): string => keyOf.get(id) ?? `unknown ${id}`;
  const recentOf = (r: Runs, step: string): RunRow[] => ok(step, r.recent).rows;
  const late = CUTOFFS.late;

  let step = "the tiles";
  const all = await read.runsAt(TEAM, ALL, late);
  const want = RUNS_READ.all;
  const { id: largestId, ...largest } = all.tiles.largest ?? fail(step, "no largest run");
  expect(step, { since: all.since, runs: all.tiles.runs, outputPerRun: all.tiles.outputPerRun, largest, largestKey: key(largestId) }, {
    since: want.since, runs: { value: want.runs, why: null },
    outputPerRun: { value: want.outputPerRun, why: null, unmeasured: want.unmeasured },
    largest: { ...want.largest }, largestKey: "r3",
  });
  pass("the team's 14 runs since r1's first call, 7,375 bytes of observed output a run over the 12 that measured it with r2 and r11 unmeasured, and r3 the largest at 40,000 bytes, runs-plan on alpha");

  step = "overlapping runs counted once each";
  const rows = recentOf(all, step);
  const ids = rows.map((r) => r.id);
  if (rows.length !== want.runs || new Set(ids).size !== ids.length) fail(step, `the recent runs hold ${rows.length} rows, ${new Set(ids).size} distinct`);
  pass("r3, r4 and r5, open together at 11:30, are three runs and three rows, and their output is in the mean once each");

  step = "the coverage, as observedRuns answers it";
  expect(step, all.coverage, { ...want.coverage });
  const observed = await read.observedRuns(TEAM, { from: want.since, to: late }, late);
  expect(step, all.coverage, { coverageMs: observed.coverageMs, summedMs: observed.summedMs, peak: observed.peak, oneCall: observed.zeroLength });
  pass("598 minutes covered, r3 to r5's shared time once, against 702 summed with it counted per run; three open at once at most; r8 and r11 of one call — each what observedRuns answers over the same runs");

  step = "by skill";
  expect(step, { rows: ok(step, all.bySkill).rows }, { rows: want.bySkill.map((r) => ({ ...r })) });
  pass("runs-plan, runs-spec, runs-explore by output per run, runs-review measured by nothing last; each with its calls per run, the share of its calls refused and its median length over the runs of more than one call, their count beside");

  step = "the recent runs and their states";
  const states = (rs: RunRow[]): string[][] => rs.map((r) => [key(r.id), r.state]);
  expect(step, { rows: states(rows), total: ok(step, all.recent).total }, { rows: want.recent.map((r) => [...r]), total: want.runs });
  const first = await read.runsAt(TEAM, { skill: null, limit: 10, offset: 0 }, late);
  const second = await read.runsAt(TEAM, { skill: null, limit: 10, offset: 10 }, late);
  expect(step, { first: states(recentOf(first, step)), second: states(recentOf(second, step)), total: ok(step, second.recent).total },
    { first: want.recent.slice(0, 10).map((r) => [...r]), second: want.recent.slice(10).map((r) => [...r]), total: want.runs });
  const r3 = rows.find((r) => key(r.id) === "r3")!;
  const r5 = rows.find((r) => key(r.id) === "r5")!;
  expect(step, { r3: r3.initiative, r5: r5.initiative }, { r3: "2026-09-01-alpha", r5: null });
  pass("newest first by the last call, ten a page: a3 two minutes back and a1 five are active, a2 six back reads its last call, r8 and r11 one call; each with its initiative, r5 with none");

  step = "skill narrows the tiles, the table, the coverage and the recent runs";
  const spec = await read.runsAt(TEAM, { skill: "runs-spec", limit: 10, offset: 0 }, late);
  const s = RUNS_READ.spec;
  const { id: specLargest, ...specLargestRow } = spec.tiles.largest ?? fail(step, "no largest run");
  expect(step, {
    since: spec.since, runs: spec.tiles.runs, outputPerRun: spec.tiles.outputPerRun, largest: specLargestRow, largestKey: key(specLargest),
    coverage: spec.coverage, bySkill: ok(step, spec.bySkill).rows, recent: recentOf(spec, step).map((r) => key(r.id)), total: ok(step, spec.recent).total,
  }, {
    since: s.since, runs: { value: s.runs, why: null }, outputPerRun: { value: s.outputPerRun, why: null, unmeasured: s.unmeasured },
    largest: { ...s.largest }, largestKey: "r4", coverage: { ...s.coverage }, bySkill: [{ ...want.bySkill[1] }], recent: [...s.recent], total: s.runs,
  });
  const none = await read.runsAt(TEAM, { skill: "runs-never", limit: 10, offset: 0 }, late);
  expect(step, none as unknown as Obj, {
    since: null, tiles: { runs: { value: 0, why: null }, outputPerRun: { value: null, why: "no_data", unmeasured: 0 }, largest: null },
    coverage: { coverageMs: 0, summedMs: 0, peak: 0, oneCall: 0 },
    bySkill: { state: "ok", data: { rows: [] } }, recent: { state: "ok", data: { rows: [], total: 0 } },
  });
  pass("runs-spec answers its five runs since r2, 5,012 bytes a run with r2 unmeasured, r4 the largest, r4 and r5 overlapping, its one row and its five runs newest first; a skill never run answers nothing");

  step = "no field or label says context, tokens or cost";
  const said = [...words(all), ...words(spec)].filter((w) => FORBIDDEN.test(w));
  const source = readFileSync(SOURCE, "utf8").split("\n").filter((l) => FORBIDDEN.test(l));
  if (said.length || source.length) fail(step, `the answer says ${show(said)}; runs.ts says ${show(source)}`);
  pass("no key, no text of the answer and no line of console/runs.ts says context, tokens or cost");

  step = "the route as a console session";
  const routed = await answer(read.route, request(TEAM));
  if (routed.status !== 200) fail(step, `answered ${routed.status}: ${show(routed.body)}`);
  const page = routed.body as unknown as Runs;
  // At the moment the route is called every seeded run is over: c1 to c6 have joined, and none is active.
  const every = ok(step, page.recent);
  if (every.rows.length !== 10 || every.total !== 20 || every.rows.some((r) => r.state === "active")) fail(step, show(every));
  const wide = await answer(read.route, request(TEAM, { limit: "100" }));
  if (wide.status !== 200 || ok(step, (wide.body as unknown as Runs).recent).rows.length !== 20) fail(step, `limit 100 answered ${wide.status}: ${show(wide.body)}`);
  for (const query of [{ limit: "0" }, { limit: "101" }, { limit: "ten" }, { limit: "2.5" }, { offset: "-1" }, { skill: ["runs-spec", "runs-plan"] }]) {
    const refused = await answer(read.route, request(TEAM, query));
    if (refused.status !== 400) fail(step, `${show(query)} answered ${refused.status}: ${show(refused.body)}`);
  }
  const noTeam = await answer(read.route, request(null));
  if (noTeam.status !== 400) fail(step, `a person in no team was answered ${noTeam.status}: ${show(noTeam.body)}`);
  pass("the route answers the team's twenty runs ten a page, none active now, and a hundred at most; limit 0, 101, ten or 2.5, offset -1 and a skill given twice are refused 400, and so is a person in no team");

  step = "the key sets match the console's fake answer";
  let fake: { runs: (who: unknown, q: URLSearchParams) => [number, unknown] };
  try {
    fake = (await import(pathToFileURL(FAKE).href)) as typeof fake;
  } catch (err) {
    return fail(step, `could not read the console's fake answer at ${FAKE}: ${(err as Error).message}`);
  }
  const [fakeStatus, fakeBody] = fake.runs({ activeTeam: "atlas", email: "ava.lindqvist@example.com" }, new URLSearchParams());
  if (fakeStatus !== 200) fail(step, `the fake answered ${fakeStatus}`);
  const diffs = shapeDiffs(page, fakeBody, "", []);
  if (diffs.length) fail(step, diffs.join("; "));
  if (!page.tiles.largest || !(fakeBody as Runs).tiles.largest) fail(step, "a largest run is missing, so its keys were not compared");
  pass("every object of the answer, the largest run, a by-skill row and a recent run among them, has the fake's keys");

  step = "another team's runs change nothing";
  const other = await read.runsAt(OTHER, ALL, late);
  expect(step, { runs: other.tiles.runs.value, recent: recentOf(other, step).map((r) => key(r.id)) },
    { runs: RUNS_READ.other.runs, recent: [...RUNS_READ.other.recent] });
  const before = [all, spec, none];
  await db.query("delete from zz.skill_run r using zz.team t where t.id = r.team_id and t.slug = $1", [OTHER]);
  const after = [
    await read.runsAt(TEAM, ALL, late),
    await read.runsAt(TEAM, { skill: "runs-spec", limit: 10, offset: 0 }, late),
    await read.runsAt(TEAM, { skill: "runs-never", limit: 10, offset: 0 }, late),
  ];
  if (!isDeepStrictEqual(after, before)) fail(step, `an answer changed: ${show(after)}`);
  pass("the other team reads its own o1 and o2; with them deleted every answer is as before, o1's 900,000 bytes never the largest and its overlap with r3 to r5 counted for nobody else");

  step = "a maintenance client's calls are no run";
  await maintenanceCases(db, read, late, all);

  step = "with the run record unreadable the read fails whole";
  await db.query("alter table zz.skill_run rename to skill_run_hidden");
  const quiet = console.error;
  console.error = () => undefined;
  try {
    const outcome = await read.runsAt(TEAM, ALL, late).then(() => "answered", () => "threw");
    if (outcome !== "threw") fail(step, "runsAt answered with its table gone");
    const failed = await answer(read.route, request(TEAM));
    if (failed.status !== 500 || show(failed.body).includes(TEAM)) fail(step, `answered ${failed.status}: ${show(failed.body)}`);
  } finally {
    console.error = quiet;
    await db.query("alter table zz.skill_run_hidden rename to skill_run");
  }
  pass("every part is read from one statement, so with zz.skill_run gone the read throws and the route answers 500 naming no team, never a zero");
}

/** Two runs of the team beside the seed's, each with its events carrying its id: m1, every call a maintenance client's,
 *  the largest output of any and ending a minute before the cutoff; m2, two real-work calls (one refused, 1,000 bytes
 *  each) and two maintenance calls (one refused, 4,000 bytes each). Read, then deleted with their events. */
async function maintenanceCases(db: pg.Client, read: Reads, late: string, before: Runs): Promise<void> {
  const step = "a maintenance client's calls are no run";
  const lateMs = Date.parse(late);
  const at = (minutes: number): string => new Date(lateMs - minutes * 60_000).toISOString();
  const { rows: [team] } = await db.query<{ id: string; version: string }>(
    `select t.id::text as id, (select v.id::text from zz.skill_version v join zz.skill s on s.id = v.skill_id where s.name = 'runs-review') as version
       from zz.team t where t.slug = $1`, [TEAM]);
  const made: string[] = [];
  // [session, calls, refusals, bytes, first, last, events as [origin, ok, bytes]]
  for (const [session, calls, refusals, bytes, first, last, events] of [
    ["maint-m1", 3, 0, 90_000, at(9), at(1), [["platform", true, 30_000], ["platform", true, 30_000], ["platform", true, 30_000]]],
    ["mixed-m2", 4, 2, 10_000, at(200), at(190), [["work", true, 1_000], ["work", false, 1_000], ["platform", true, 4_000], ["platform", false, 4_000]]],
  ] as [string, number, number, number, string, string, [string, boolean, number][]][]) {
    const { rows: [r] } = await db.query<{ id: string }>(
      `insert into zz.skill_run (team_id, skill_version_id, session, calls, refusals, bytes_total, started_at, ended_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id::text as id`, [team.id, team.version, session, calls, refusals, bytes, first, last]);
    made.push(r.id);
    for (const [i, [origin, answered, sent]] of events.entries()) {
      await db.query(
        `insert into zz.event (ts, kind, subject, ok, tool_key, origin, team_id, skill_version_id, session, run_id, response_bytes)
         values ($1, 'tool_call', 'core:document_read', $2, 'core:document_read', $3, $4, $5, $6, $7, $8)`,
        [i === 0 ? first : last, answered, origin, team.id, team.version, session, r.id, sent]);
    }
  }
  try {
    const all = await read.runsAt(TEAM, ALL, late);
    const rows = ok(step, all.recent).rows;
    const m2 = rows.find((r) => r.id === made[1]);
    expect(step, {
      runs: all.tiles.runs.value, m1: rows.some((r) => r.id === made[0]), largest: all.tiles.largest?.id,
      m2: m2 && { calls: m2.calls, refusals: m2.refusals, bytes: m2.bytes },
    }, {
      runs: (before.tiles.runs.value ?? 0) + 1, m1: false, largest: before.tiles.largest?.id,
      m2: { calls: 2, refusals: 1, bytes: 2_000 },
    });
    const observed = await read.observedRuns(TEAM, { from: before.since!, to: late }, late) as unknown as
      { runs: number; lastRunAt: string | null; active: { runs: { skill: string; startedAt: string }[] }[] };
    const m1Start = new Date(Date.parse(at(9))).toISOString().replace(/\.\d{3}Z$/, "Z");
    const m1Active = observed.active.some((g) => g.runs.some((x) => x.skill === "runs-review" && x.startedAt === m1Start));
    expect(step, { runs: observed.runs, m1Active, lastRunAt: observed.lastRunAt },
      { runs: (before.tiles.runs.value ?? 0) + 1, m1Active: false, lastRunAt: ok(step, before.recent).rows[0].lastCallAt });
  } finally {
    await db.query("delete from zz.event where run_id = any($1::uuid[])", [made]);
    await db.query("delete from zz.skill_run where id = any($1::uuid[])", [made]);
  }
  pass("m1, every call a maintenance client's, is no run: not counted, not the largest at 90,000 bytes, not active and not the last; " +
       "m2 counts its two real-work calls, one refused and 2,000 bytes, and none of its two maintenance calls");
}

async function run(db: pg.Client, url: string): Promise<void> {
  const ids = await seedRuns(db);
  const keyOf = new Map([...ids].map(([k, id]) => [id, k]));

  // DELIBERATE: set before the gateway's modules load, which read both once.
  process.env.TEAM_DB_URL = url;
  process.env.ZZ_TZ = TIMEZONE;
  const load = (p: string) => import(pathToFileURL(join(root, "services/gateway/dist", p)).href);
  const dbModule = (await load("db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await dbModule.initPlatformDb();
  const runs = (await load("console/runs.js")) as { runsAt: Reads["runsAt"]; mountRuns: (app: unknown) => void };
  const routes = new Map<string, Route>();
  runs.mountRuns({ get: (p: string, h: Route) => routes.set(p, h) });
  const read: Reads = {
    runsAt: runs.runsAt,
    observedRuns: ((await load("console/runs-observed.js")) as Pick<Reads, "observedRuns">).observedRuns,
    route: routes.get("/api/console/runs") ?? fail("mount", "no route GET /api/console/runs"),
  };

  try {
    await cases(db, read, keyOf);
  } finally {
    await dbModule.platformDb().end().catch(() => undefined);
    delete process.env.TEAM_DB_URL;
    delete process.env.ZZ_TZ;
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
