#!/usr/bin/env node
/**
 * checks/console-cache-boundary.ts — an answer that changes with the clock alone is not served past the
 * instant it changes, and the follow-up window's two halves stay what they are (AC-11.4, AC-16.6).
 *
 *   node checks/console-cache-boundary.ts   # needs Docker and a built tree (npm run build)
 *
 * The cache's 60-second lifetime is a backstop for a write no trigger raised. It cannot cover an answer
 * whose value moves with nothing written at all, and the console serves two of those: a refusal's
 * classification turns from `within_lookahead` to `eligible` at `ts + 120 s`, and a running week turns
 * complete at its end. Serving either past that instant is a page telling a reader what the rows stopped
 * saying, with every other check on the way green — the marker never moves, because nothing was written.
 *
 * Two arms, and they are different kinds of evidence.
 *
 * The CLOCK arm is the change. It reads an answer through the cache, reads it again to show the same
 * answer was kept, moves the clock past the boundary with NOTHING written, and reads a third time: the
 * third read must be a fresh computation and must say what the rows say at that instant. Three times —
 * a refusal's lookahead, a week's completeness, and the local day turning over, which Status draws as
 * "today" and "through the latest complete day". On the tree before this task the third read is the kept
 * answer and still says `within_lookahead`, which is the defect.
 *
 * DELIBERATE: the clock is supplied, not slept. Both reads take the read's cutoff as an argument
 * (`usageServed(…, asOfMs)`), and the cache's own lifetime is measured against `Date.now()`, so the
 * process clock is faked for the length of this check (restored in `finally`). Advancing only the cutoff
 * would leave the entry live and the arm would fail for the wrong reason — and, worse, a check that
 * only advanced the cutoff would pass on a tree that kept the entry, which is exactly the failure this
 * file exists to catch. The `Date.now()` override works because the cache calls it at use, not at load.
 *
 * The WINDOW arm is a GUARD, and is described as one: it holds on the tree before this task and must
 * hold after, which is what stops a later change to either predicate. A call inside the 120 seconds
 * after a refusal puts it right; a call after them does not; a call at any distance continues the
 * session; and a refusal with no session is `unassessable` in neither. It is not evidence that this task
 * moved anything, and this file does not present it as such.
 *
 * DELIBERATE: the refusal arm's two reads are two seconds apart, at `t + 119 s` and `t + 121 s`, not at
 * `t + 5 s` and `t + 121 s`. The 60-second backstop alone would strand an answer after 116 seconds of
 * clock, so a wide gap passes on a tree that keeps the answer — it would pass for the wrong reason. Two
 * seconds is inside the backstop, so the only thing that can turn the third read into a miss is the
 * boundary the refusal reports.
 *
 * DELIBERATE: the refusal arm's boundary is the refusal's and not the week's. The seeded refusal is
 * one second short of its own boundary while the running week lasts longer, so the earlier of the two
 * boundaries is the one that must strand the answer. A check that let the week's boundary govern would
 * pass while the refusal half did nothing.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import { withThrowawayDb } from "../scripts/schema/throwaway.ts";

const NAME = "console-cache-boundary";
const DONE = "console-cache-boundary: an answer whose value turns with the clock alone is not served past " +
  "the instant it turns, with nothing written between the reads, and the follow-up window's two halves hold: ok";

const TIMEZONE = "Asia/Singapore";
const DAY = 86_400_000;
/** The window a refusal's classification turns at. Spelled here as the plan spells it; the gateway's own
 *  `LOOKAHEAD_MS` is the same 120 seconds and the seeded instants are what the arm rests on. */
const LOOKAHEAD_MS = 120_000;

type Week = { window: { from: string; to: string; complete: boolean }; putRight: { denominator: number; figure: { value: number | null } }; unassessable: number };
type Answer = { followup?: { state: string; data?: { weeks: Week[] } }; tiles?: { state: string; data?: { calls: { weeks: { window: { from: string; complete: boolean } }[] } } } };
type Served<T> = { value: T; hit: boolean };
type Grid = { asOfMs: number; coverageMs: number | null; weeks: { fromMs: number; toMs: number }[] };
type FollowupRow = { from_ms: number; refusals: number; eligible: number; matched: number; missing_session: number; continued_sessions: number; next_boundary_ms: number | null };
type Modules = {
  readGrid: (db: pg.Pool, asOfMs?: number) => Promise<Grid>;
  followupWeeks: (db: pg.Pool, grid: Grid, team: string | null) => Promise<FollowupRow[]>;
  usageAnswer: (superadmin: boolean, asOfMs?: number) => Promise<{ answer: Answer; boundary: number | null }>;
  usageServed: (superadmin: boolean, key: string, prefix: string | null, asOfMs?: number) => Promise<Served<Answer>>;
  statusServed: (caller: Caller, tool: string | null, key: string, prefix: string | null, asOfMs?: number) => Promise<Served<Answer>>;
};
type Caller = { superadmin: boolean; activeTeam: string | null };
/** The superadmin acting for no team: Status's widest answer, and the one every clock arm can read. */
const CALLER: Caller = { superadmin: true, activeTeam: null };

class CaseFailure extends Error {}
function fail(step: string, detail: string): never {
  throw new CaseFailure(`${NAME}: FAILED at "${step}": ${detail}`);
}
const pass = (line: string): void => console.log(`  ok  ${line}`);
const show = (v: unknown): string => JSON.stringify(v).slice(0, 900);
const same = (step: string, found: unknown, want: unknown): void => {
  if (JSON.stringify(found) !== JSON.stringify(want)) fail(step, `found ${show(found)}, expected ${show(want)}`);
};
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** The instant this check calls "now". Faked into the process for the length of the run — see the
 *  module doc — and restored however the run ends. */
const realNow = Date.now.bind(Date);
let clock = realNow();

/** The refusal's week as the Usage answer draws it, or the reason there is none. */
function followupAt(answer: Answer, from: number): unknown {
  if (answer.followup?.state !== "ok" || !answer.followup.data) return { state: answer.followup?.state };
  const week = answer.followup.data.weeks.find((w) => Date.parse(w.window.from) <= from && from < Date.parse(w.window.to));
  return week === undefined
    ? "the refusal's week is not in the answer"
    : { unassessable: week.unassessable, denominator: week.putRight.denominator, eligibleShare: week.putRight.figure.value };
}

/** Whether the Usage answer draws the week beginning `from` as a complete one. */
function completeAt(answer: Answer, from: number): unknown {
  if (answer.tiles?.state !== "ok" || !answer.tiles.data) return `tiles ${answer.tiles?.state}`;
  const week = answer.tiles.data.calls.weeks.find((w) => w.window.from === iso(from));
  return week === undefined ? "the week is not drawn" : week.window.complete;
}

/** Whether the REFUSAL week starting at `from` is drawn complete — the family `followupOf` settles at
 *  LOOKAHEAD_MS, which a boundary taken at the week's own end would let the cache serve past. */
function refusalWeekComplete(answer: Answer, from: number): unknown {
  if (answer.followup?.state !== "ok" || !answer.followup.data) return `followup ${answer.followup?.state}`;
  const week = answer.followup.data.weeks.find((w) => w.window.from === iso(from));
  return week === undefined ? "the refusal week is not drawn" : week.window.complete;
}

async function run(sql: pg.Client, url: string, load: (p: string) => Promise<unknown>): Promise<void> {
  process.env.TEAM_DB_URL = url;
  process.env.ZZ_TZ = TIMEZONE;
  const dbModule = (await load("db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await dbModule.initPlatformDb();
  const db = dbModule.platformDb();
  try {
    const m = {
      ...((await load("console/platform-measures.js")) as Pick<Modules, "readGrid">),
      ...((await load("console/usage-figures.js")) as Pick<Modules, "followupWeeks">),
      ...((await load("console/platform-usage.js")) as Pick<Modules, "usageAnswer" | "usageServed">),
      ...((await load("console/platform-status.js")) as Pick<Modules, "statusServed">),
    } as Modules;

    // A real-work call: what puts a refusal right inside its window and continues a session at any distance.
    const call = (ts: number, session: string): Promise<unknown> => sql.query(
      `insert into zz.event (ts, kind, origin, ok, session, tool_key, duration_ms)
       values ($1, 'tool_call', 'work', true, $2, 'core:write-guards', 42)`, [new Date(ts).toISOString(), session]);
    // A refusal: `ok` is false and `refusal_owner` is set, as the event CHECK requires.
    const refuse = (ts: number, session: string): Promise<unknown> => sql.query(
      `insert into zz.event (ts, kind, origin, ok, session, tool_key, duration_ms, refusal_owner)
       values ($1, 'tool_call', 'work', false, $2, 'core:write-guards', 42, 'guardrail')`,
      [new Date(ts).toISOString(), session]);

    const weekStart = Number((await sql.query(
      `select (extract(epoch from (date_trunc('week', now() at time zone $1) at time zone $1)) * 1000)::float8 as ms`,
      [TIMEZONE])).rows[0].ms);
    // Four weeks that the clock arm's refusal is NOT in: the clock arm reads the running week's row, and a
    // refusal of this arm seeded into the same week would be counted in it and turn the absolute numbers
    // this check asserts into sums it would have to subtract.
    const weeks = [4, 5, 6, 7].map((n) => weekStart - n * 7 * DAY);

    // ---- The window arm: four refusals in four weeks, each with the call shape the plan names.
    await refuse(weeks[0] + 3_600_000, "near");
    await call(weeks[0] + 3_600_000 + 100_000, "near");            // inside the 120 seconds
    await refuse(weeks[1] + 3_600_000, "late");
    await call(weeks[1] + 3_600_000 + 121_000, "late");             // one second past them
    await refuse(weeks[2] + 3_600_000, "far");
    await call(weeks[2] + 3_600_000 + 600_000, "far");              // far past them
    await refuse(weeks[3] + 3_600_000, "");                         // no session: unassessable in both

    const step = "the follow-up window's two halves";
    const rows = await m.followupWeeks(db, await m.readGrid(db, realNow()), null);
    const row = (ms: number): FollowupRow => {
      const found = rows.find((r) => r.from_ms === ms);
      if (!found) fail(step, `no row for the week beginning ${iso(ms)}; the answer holds ${show(rows.map((r) => r.from_ms))}`);
      return found;
    };
    const shapes = [
      ["a call at +100 s", weeks[0], { refusals: 1, eligible: 1, matched: 1, continued_sessions: 1, missing_session: 0 }],
      ["a call at +121 s", weeks[1], { refusals: 1, eligible: 1, matched: 0, continued_sessions: 1, missing_session: 0 }],
      ["a call at +600 s", weeks[2], { refusals: 1, eligible: 1, matched: 0, continued_sessions: 1, missing_session: 0 }],
      ["no session", weeks[3], { refusals: 1, eligible: 0, matched: 0, continued_sessions: 0, missing_session: 1 }],
    ] as const;
    for (const [what, ms, want] of shapes) {
      const found = row(ms);
      same(step, {
        refusals: found.refusals, eligible: found.eligible, matched: found.matched,
        continued_sessions: found.continued_sessions, missing_session: found.missing_session,
      }, want);
      pass(`${what}: ${show(want)}`);
    }

    // ---- The clock arm, a refusal's lookahead.
    const t = clock;
    await refuse(t, "turning");
    const keyC = "console-cache-boundary|refusal";
    const prefixC = "console-cache-boundary";
    const A = t + LOOKAHEAD_MS - 1_000;
    const B = t + LOOKAHEAD_MS + 1_000;

    clock = A;
    const boundary = (await m.usageAnswer(false, A)).boundary;
    const first = await m.usageServed(false, keyC, prefixC, A);
    const second = await m.usageServed(false, keyC, prefixC, A);
    const atA = followupAt(first.value, t);
    same("the refusal's answer is kept while it is still the same answer", [first.hit, second.hit], [false, true]);
    same("read before the boundary, the refusal is still within the lookahead", atA,
      { unassessable: 1, denominator: 0, eligibleShare: null });
    if (boundary === null) fail("the refusal's answer reports a boundary", "it reports none, so nothing would ever strand it");
    if (boundary > B) fail("the refusal's answer reports a boundary", `it reports ${boundary}, later than the ${iso(B)} the arm advances to`);
    pass(`a refusal at ${iso(t)} is kept at ${iso(A)} and reports a boundary of ${iso(boundary)}`);

    clock = B;
    const third = await m.usageServed(false, keyC, prefixC, B);
    if (third.hit) {
      fail("nothing written, the clock past the boundary: the answer is computed again",
        `the cache served the answer it computed at ${iso(A)}, which says ${show(atA)}; at ${iso(B)} nothing was written, ` +
        "and the rows say the refusal is now eligible");
    }
    same("the answer now says what the rows say", followupAt(third.value, t),
      { unassessable: 0, denominator: 1, eligibleShare: 0 });
    pass(`nothing written and the clock at ${iso(B)}: a miss, and the refusal has turned from within_lookahead to eligible`);

    // ---- The clock arm, a week's completeness.
    await refuse(weekStart - 20 * DAY, "record");                   // three weeks of record for the tiles
    const W = weekStart + 7 * DAY;                                  // the running week ends at the next local Monday
    const keyW = "console-cache-boundary|week";
    clock = W - 30_000;
    const prime = await m.usageServed(false, keyW, prefixC, W - 30_000);
    const again = await m.usageServed(false, keyW, prefixC, W - 30_000);
    same("the week's answer is kept while the week is still running", [prime.hit, again.hit], [false, true]);
    same("before its end the running week is not complete", completeAt(prime.value, W - 7 * DAY), false);

    clock = W + 1_000;
    const after = await m.usageServed(false, keyW, prefixC, W + 1_000);
    if (after.hit) {
      fail("nothing written, the clock past the week's end: the answer is computed again",
        `the cache served the answer it computed at ${iso(W - 30_000)}, which draws the week as running`);
    }
    same("the week is complete once its end has passed", completeAt(after.value, W - 7 * DAY), true);
    pass(`nothing written and the clock at ${iso(W + 1_000)}: a miss, and the week ending ${iso(W)} is complete`);

    // ---- The clock arm, the REFUSAL week's completeness, which settles 120 seconds later than the tiles' do.
    // The same week, read by the family `followupOf` draws at LOOKAHEAD_MS: its window turns complete only once
    // the 120 seconds after its end have been read, so an answer bounded by the tiles' end alone would be served
    // for up to its 60 seconds with a refusal week it says is still running. This arm primes INSIDE that minute
    // and reads again past it with nothing written — the case the tiles' arm cannot see, and the reason both
    // routes hand `nextWeekBoundary` the settle rather than the week's own end.
    clock = W + 90_000;
    const keyF = "console-cache-boundary|refusal-week";
    const fPrime = await m.usageServed(false, keyF, prefixC, W + 90_000);
    same("90 seconds past the week's end its refusal week is still running",
      refusalWeekComplete(fPrime.value, W - 7 * DAY), false);

    clock = W + 121_000;
    const fAfter = await m.usageServed(false, keyF, prefixC, W + 121_000);
    if (fAfter.hit) {
      fail("nothing written, the clock past the refusal week's settle: the answer is computed again",
        `the cache served the answer it computed at ${iso(W + 90_000)}, whose refusal week reads still running; at ` +
        `${iso(W + 121_000)} the 120 seconds after the week's end have been read, so it is complete`);
    }
    same("121 seconds past the week's end its refusal week is complete",
      refusalWeekComplete(fAfter.value, W - 7 * DAY), true);
    pass(`nothing written and the clock at ${iso(W + 121_000)}: a miss, and the refusal week ending ${iso(W)} is complete`);

    // ---- The clock arm, the local day turning over. Status draws "today" and "through the latest complete
    // day" by the reporting timezone's calendar date, so an answer computed a second before midnight is
    // wrong a second after it, with nothing written.
    const midnight = ((): number => {
      const local = new Date(clock + 8 * 3_600_000);                       // the zone's own wall clock
      const dayStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
      const nextLocalMidnight = dayStart + DAY - 8 * 3_600_000;            // the UTC instant local midnight falls at
      return nextLocalMidnight > clock + 2_000 ? nextLocalMidnight : nextLocalMidnight + DAY;
    })();
    clock = midnight - 1_000;
    const keyD = "console-cache-boundary|day";
    const dPrime = await m.statusServed(CALLER, null, keyD, prefixC, clock);
    const dAgain = await m.statusServed(CALLER, null, keyD, prefixC, clock);
    same("the day's answer is kept while the local date is still the same one", [dPrime.hit, dAgain.hit], [false, true]);

    clock = midnight + 1_000;
    const dAfter = await m.statusServed(CALLER, null, keyD, prefixC, clock);
    if (dAfter.hit) {
      fail("nothing written, the clock past the local midnight: the answer is computed again",
        `the cache served the answer it computed a second before ${iso(midnight)}, whose doors and records are that day's`);
    }
    pass(`nothing written and the clock at ${iso(midnight + 1_000)}: a miss, and the local date is the next one`);
  } finally {
    await db.end().catch(() => undefined);
    delete process.env.TEAM_DB_URL;
    delete process.env.ZZ_TZ;
  }
}

async function main(): Promise<number> {
  let dbUrl = "";
  const load = (p: string): Promise<unknown> => import(pathToFileURL(join(root, "services/gateway/dist", p)).href);
  Date.now = () => clock;
  try {
    await withThrowawayDb((sql) => run(sql, dbUrl, load), async (u) => { dbUrl = u; });
  } catch (err) {
    if (err instanceof Error && /Docker is not running/.test(err.message)) {
      console.error(`${NAME}: Docker is not available — the check could not run, which is not a pass`);
      return 2;
    }
    console.error(err instanceof CaseFailure ? err.message : `${NAME}: ${String((err as Error)?.stack ?? err)}`);
    return 1;
  } finally {
    Date.now = realNow;
  }
  console.log(DONE);
  return 0;
}

process.exitCode = await main();
