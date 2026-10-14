#!/usr/bin/env node
/**
 * checks/console-platform-status.ts — the platform's status, its eight measures and the reader's own
 * team's figures, read through the gateway's own identity gate and route on a real database (AC-1.13,
 * AC-8.9, AC-2.3, AC-2.4, AC-2.14, AC-3.2).
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
 *   - over the seed's first rows, nothing needs attention: the superadmin reads `Nothing needs you` and
 *     a member `No known open issues`; the doors count every real-work call the seed placed, core's
 *     one tool failure among them, and the other doors none; the records are answered;
 *   - what is running is `unrecorded` until `zz.release` holds the gateway's own version, and then
 *     names it, the console version recorded with it, its tagged time, the release tagged before it
 *     (the nearer of two) and the migrations `zz.schema_migration` holds;
 *   - the answer agrees in shape with the console's fake one, read from the sibling checkout: where
 *     both hold an object their key sets are equal, where both hold an array their first elements are
 *     compared the same way, each measure with the fake's of the same key, and a null on either side is
 *     compared with nothing; `needs.overflowByKind` is a record whose keys are kinds, so its keys are
 *     data and not compared;
 *   - over the seed's further rows (`seedMeasures`), the eight measures answer in the spec's order,
 *     each week's counts, value and reason, the weeks each names, its judgement and its finding as the
 *     seed writes them out, with the follow-up counts, the calls with no usable duration, the share of
 *     searches widened, the refused searches and the calls with no session beside the measures they
 *     belong to: AC-2.14's follow-up cases (119, 120 and 121 seconds, no session, another team,
 *     session, tool or initiative, three refusals before one success, a running lookahead, a refusal
 *     never followed) reconcile to the seed's counts;
 *   - `own` is team one's malformed calls, refusals put right and sessions, with no sample minimum,
 *     and its real bug reports by how they stand, for the member, whatever team the request names;
 *     the superadmin and the person in no team read it `unavailable` with `no_team`;
 *   - maintenance calls, page views and events of other kinds on every day the rates are read
 *     (`seedNoise`) change no measure and nothing in `own`;
 *   - a measure whose statement fails answers every week unavailable while the others stand, and a
 *     failed read of the bug reports makes the rate unavailable and `own` `query_failed`;
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
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Express, RequestHandler } from "express";
import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import {
  CALLS, EXPECTED, MEASURES, MEMBER, NO_TEAM, SUPERADMIN, TEAM_TWO, seedMeasures, seedNoise, seedStatus, signIn, weekStart,
  type Seeded,
} from "../scripts/schema/status-seed.ts";
import { withThrowawayDb } from "../scripts/schema/throwaway.ts";

const NAME = "console-platform-status";
const DONE = "console-platform-status: the platform's eight measures are answered week by week in the reporting " +
  "timezone, alike to a member, a superadmin and a person in no team, from real work only, beside the reader's own team's, " +
  "with what needs attention, the doors, the records and what is running: ok";
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
 *  at an array both hold, the first elements, the same way; a null on either side, nothing; a record
 *  keyed by data (`needs.overflowByKind`), nothing. */
function shapeDiffs(a: unknown, b: unknown, at: string, out: string[]): string[] {
  if (a === null || b === null || at === "needs.overflowByKind") return out;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length && b.length) shapeDiffs(a[0], b[0], `${at}[0]`, out);
  } else if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    if (ka.join() !== kb.join()) out.push(`${at || "the answer"} has keys {${ka.join(", ")}} where the fake has {${kb.join(", ")}}`);
    for (const k of ka.filter((x) => kb.includes(x))) shapeDiffs(a[k], b[k], at ? `${at}.${k}` : k, out);
  }
  return out;
}

/** The eight measures' keys, in the spec's order. */
const KEYS = ["malformed_per_1000", "same_tool_followup_pct", "call_p50_ms", "call_p95_ms", "searches_with_results_pct",
  "bugs_per_1000", "sessions", "work_finished"];

/** An answer's eight measures, or a failure naming what came instead. */
function measuresOf(step: string, a: Answer): Obj[] {
  const measures = a.body.measures;
  if (a.status !== 200 || !Array.isArray(measures) || measures.map((m) => (isObj(m) ? m.key : m)).join() !== KEYS.join()) {
    fail(step, `answered ${a.status}, not the eight measures in order: ${a.text.slice(0, 400)}`);
  }
  return measures as Obj[];
}
/** The malformed-call measure of an answer, the first of the eight. */
const measureOf = (step: string, a: Answer): Obj => measuresOf(step, a)[0];

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
async function thinLastWeek(db: pg.Client, seeded: Seeded, as: (email: string) => Promise<Answer>, added: Added): Promise<void> {
  const step = "a last whole week under 30 calls";
  const removed = await db.query(
    `delete from zz.event
      where kind = 'tool_call' and origin = 'work' and refusal_owner is distinct from 'ours'
        and ts >= $1::timestamptz and ts < $2::timestamptz`,
    [new Date(seeded.starts.get(1)!).toISOString(), new Date(seeded.starts.get(0)!).toISOString()]);
  // What L holds now, counted from the seed's own lists: its malformed calls, and nothing else.
  const inL = added.filter((c) => c.origin === "work" && c.ts >= seeded.starts.get(1)! && c.ts < seeded.starts.get(0)!);
  const ours = CALLS.filter((c) => c.back === 1 && c.origin === "work").reduce((n, c) => n + c.ours, 0)
    + inL.filter((c) => c.owner === "ours").length;
  const before = CALLS.filter((c) => c.back === 1 && c.origin === "work").reduce((n, c) => n + c.calls, 0) + inL.length;
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

/** The work calls `seedMeasures` wrote. */
type Added = Awaited<ReturnType<typeof seedMeasures>>;
type Week = (typeof MEASURES.widened)[number];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Where a week differs from `[numerator, denominator, value, why]`, or null. */
function weekDiff(w: Obj, want: Week): string | null {
  const fig = w.figure as Obj;
  return w.numerator === want[0] && w.denominator === want[1] && fig.value === want[2] && fig.why === want[3]
    ? null : `${JSON.stringify([w.numerator, w.denominator, fig.value, fig.why])}, not ${JSON.stringify(want)}`;
}
/** Where L-4 to L of `weeks` differ from `want`, each named by its `back`. */
function weeksDiff(weeks: Obj[], want: Week[]): string[] {
  return want.flatMap((x, i) => { const d = weekDiff(weeks[i], x); return d ? [`back ${5 - i} reads ${d}`] : []; });
}
const unavailable = (weeks: Obj[]): boolean => weeks.length === 6 && weeks.every((w) => weekDiff(w, [null, null, null, "unavailable"]) === null);

/** Every measure and `own`, held against what the seed writes out: weeks, the weeks named, the judgement, the finding
 *  with its local dates, and what each measure carries beside its weeks. */
function heldToSeed(step: string, seeded: Seeded, a: Answer): void {
  const local = (back: number): string =>
    new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(new Date(seeded.starts.get(back)!));
  const said = (back: number): string => `${Number(local(back).slice(8))} ${MONTHS[Number(local(back).slice(5, 7)) - 1]}`;
  const problems: string[] = [];
  const measures = measuresOf(step, a);
  for (const [i, want] of MEASURES.measures.entries()) {
    const m = measures[i], weeks = m.weeks as Obj[];
    const out = (what: string) => problems.push(`${want.key}: ${what}`);
    if (weeks.length !== 6 || weeks.some((w, j) => (w.window as Obj).complete !== j < 5)) out(`weeks ${JSON.stringify(weeks.map((w) => w.window))}`);
    for (const d of weeksDiff(weeks, want.weeks)) out(d);
    for (const k of ["first", "best", "last", "previous", "highest", "lowest"] as const) {
      const at = weeks.findIndex((w) => JSON.stringify(w) === JSON.stringify(m[k]));
      const back = m[k] === null ? null : at < 0 ? "a week not in weeks" : 5 - at;
      if (back !== want[k]) out(`${k} is back ${back}, not ${want[k]}`);
    }
    if (m.better !== want.better || m.judgement !== want.judgement) out(`${String(m.better)}, ${String(m.judgement)}`);
    const text = want.finding?.text.replace(/\{(\d)\}/g, (_x, n: string) => said(Number(n)));
    const f = m.finding as Obj | null;
    if ((f?.kind ?? null) !== (want.finding?.kind ?? null) || (f?.text ?? null) !== (text ?? null) || (f && (f.dates as string[])[0] !== local(1))) {
      out(`finding ${JSON.stringify(f)}, not ${want.finding?.kind} "${text}" from ${local(1)}`);
    }
    // What each measure carries beside its weeks, and on no other measure.
    const beside: Record<string, string[]> = { same_tool_followup_pct: ["followupCounts"], call_p50_ms: ["missingDuration"],
      call_p95_ms: ["missingDuration"], searches_with_results_pct: ["widened", "failed"], sessions: ["withoutSession"] };
    const extra = Object.keys(m).filter((k) => !["key", "weeks", "first", "best", "last", "previous", "highest", "lowest", "better", "judgement", "finding"].includes(k));
    if (extra.sort().join() !== (beside[want.key] ?? []).sort().join()) out(`carries ${extra.join(", ") || "nothing"} beside its weeks`);
  }
  const by = Object.fromEntries(measures.map((m) => [m.key, m]));
  const same = (what: string, got: unknown, want: unknown) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`${what} reads ${JSON.stringify(got)}, not ${JSON.stringify(want)}`);
  };
  same("followupCounts", by.same_tool_followup_pct.followupCounts, MEASURES.followupCounts);
  for (const k of ["call_p50_ms", "call_p95_ms"]) same(`${k}'s missingDuration`, (by[k].missingDuration as number[]).slice(0, 5), MEASURES.missingDuration);
  for (const d of weeksDiff(by.searches_with_results_pct.widened as Obj[], MEASURES.widened)) problems.push(`widened: ${d}`);
  same("failed", by.searches_with_results_pct.failed, MEASURES.failed);
  same("withoutSession", (by.sessions.withoutSession as number[]).slice(0, 5), MEASURES.withoutSession);

  const own = a.body.own as Obj;
  if (own?.state !== "ok") problems.push(`own reads ${JSON.stringify(own)}`);
  else {
    const data = own.data as Record<string, Obj[]>;
    for (const k of ["malformed", "followup", "sessions"] as const) {
      if ((data[k] ?? []).length !== 6) problems.push(`own.${k} has ${(data[k] ?? []).length} weeks`);
      else for (const d of weeksDiff(data[k], MEASURES.own[k])) problems.push(`own.${k}: ${d}`);
      const of = { malformed: "malformed_per_1000", followup: "same_tool_followup_pct", sessions: "sessions" }[k];
      same(`own.${k}'s windows`, data[k]?.map((w) => w.window), (by[of].weeks as Obj[]).map((w) => w.window));
    }
    same("own.bugs", data.bugs, MEASURES.own.bugs);
  }
  if (problems.length) fail(step, problems.join("; "));
}

/** The eight measures and `own` over `seedMeasures`, then with `seedNoise` beside them, then with one statement
 *  failing at a time. Answers the work calls `seedMeasures` wrote. */
async function measureCases(db: pg.Client, seeded: Seeded, as: (email: string, query?: string) => Promise<Answer>, pool: pg.Pool): Promise<Added> {
  const added = await seedMeasures(db, seeded);
  let step = "the eight measures as the seed writes them out";
  const good = await as(MEMBER);
  heldToSeed(step, seeded, good);
  pass("the eight measures answer in the spec's order, every week, the weeks each names, its judgement and its finding as the seed " +
       "writes them; 119 seconds puts a refusal right and 120 does not, a refusal with no session, one followed only in another team, " +
       "session, tool or initiative, or never followed, is not put right, three refusals before one success are, and one inside the " +
       "lookahead waits in the running week");
  pass("own is team one's malformed calls, refusals put right and sessions with no sample minimum, and its bug reports by how they stand");

  step = "own comes from the identity alone";
  for (const [who, a] of [["the superadmin", await as(SUPERADMIN)], ["the person in no team", await as(NO_TEAM)],
                          ["the superadmin sending ?team=", await as(SUPERADMIN, "?team=kestrel-works")]] as const) {
    if (JSON.stringify(a.body.own) !== JSON.stringify({ state: "unavailable", reason: "no_team" })) fail(step, `${who} reads own ${JSON.stringify(a.body.own)}`);
  }
  const elsewhere = await as(MEMBER, `?team=${TEAM_TWO}&scope=platform`);
  if (settled(elsewhere.body.own) !== settled(good.body.own)) fail(step, `the member sending ?team=${TEAM_TWO} reads own ${settled(elsewhere.body.own)}`);
  if (good.text.includes(TEAM_TWO)) fail(step, `the member's answer holds ${TEAM_TWO}`);
  pass("the superadmin and the person in no team read own as unavailable, no_team, and a team in the request moves nobody's own");

  step = "noise changes nothing";
  await seedNoise(db, seeded);
  const noisy = await as(MEMBER);
  heldToSeed(step, seeded, noisy);
  if (settled([noisy.body.measures, noisy.body.own]) !== settled([good.body.measures, good.body.own])
      || (noisy.body.meta as Obj).coverageFrom !== (good.body.meta as Obj).coverageFrom) {
    fail(step, "the answer moved when maintenance calls, page views and other kinds of event were added");
  }
  pass("maintenance calls, page views, maintenance searches and events of other kinds on every day the rates are read change no measure and nothing in own");

  step = "a measure that cannot be counted";
  const real = pool.query.bind(pool) as (text: unknown, params?: unknown[]) => Promise<unknown>;
  const failing = async (when: (sql: string) => boolean): Promise<Answer> => {
    (pool as unknown as { query: unknown }).query = (text: unknown, params?: unknown[]) =>
      typeof text === "string" && when(text) ? Promise.reject(new Error("injected by the check")) : real(text, params);
    try { return await as(MEMBER); } finally { (pool as unknown as { query: unknown }).query = real; }
  };
  const others = (a: Answer, but: string): string => settled(measuresOf(step, a).filter((m) => m.key !== but));
  let a = await failing((sql) => sql.includes("interval '120 seconds'"));
  let m = measuresOf(step, a)[1], own = (a.body.own as Obj).data as Record<string, Obj[]>;
  if (!unavailable(m.weeks as Obj[]) || JSON.stringify(m.followupCounts) !== "[]" || !unavailable(own.followup)
      || others(a, "same_tool_followup_pct") !== others(noisy, "same_tool_followup_pct") || settled(own.malformed) !== settled(((noisy.body.own as Obj).data as Obj).malformed)) {
    fail(step, `answered ${a.status}: ${a.text.slice(0, 600)}`);
  }
  pass("a follow-up statement that fails answers that measure's weeks and own's as unavailable, and every other measure stands");

  a = await failing((sql) => sql.includes("chain-check probe"));
  m = measuresOf(step, a)[5];
  if (!unavailable(m.weeks as Obj[]) || JSON.stringify(a.body.own) !== JSON.stringify({ state: "unavailable", reason: "query_failed" })
      || others(a, "bugs_per_1000") !== others(noisy, "bugs_per_1000")) {
    fail(step, `answered ${a.status}: ${a.text.slice(0, 600)}`);
  }
  pass("bug reports that cannot be read make the rate's weeks unavailable and own query_failed, and every other measure stands");
  return added;
}

/** Over `seedStatus` alone nothing needs attention, and the doors and records count what it placed. */
function attentionCases(member: Answer, admin: Answer): void {
  const step = "nothing needs attention, and the doors count what was seeded";
  const empty = { state: "complete", rows: [], total: 0, knownCount: 0, unavailableKinds: [], overflowByKind: {} };
  for (const [a, headline] of [[admin, "Nothing needs you"], [member, "No known open issues"]] as const) {
    if (JSON.stringify(a.body.needs) !== JSON.stringify({ ...empty, headline })) fail(step, `needs reads ${JSON.stringify(a.body.needs)}`);
  }
  const doors = admin.body.doors as { state: string; data: Obj[] };
  const work = CALLS.filter((c) => c.origin === "work");
  const want = [["core", work.reduce((n, c) => n + c.calls, 0), work.reduce((n, c) => n + (c.theirs ?? 0), 0)], ["manage", 0, 0], ["eval", 0, 0]];
  const got = doors.state === "ok" ? doors.data.map((d) => [d.door, (d.totals as Obj).calls, (d.totals as Obj).toolFailures]) : doors;
  if (JSON.stringify(got) !== JSON.stringify(want)) fail(step, `doors read ${JSON.stringify(got)}, not ${JSON.stringify(want)}`);
  const today = (doors.data[0].days as Obj[]).at(-1)!;
  const local = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(new Date(String((admin.body.meta as Obj).asOf)));
  if (today.date !== local || today.complete !== false) fail(step, `the last day reads ${JSON.stringify(today)}, not ${local}, not complete`);
  if ((admin.body.records as Obj).state !== "ok") fail(step, `records read ${JSON.stringify(admin.body.records)}`);
  // The records' values are held to a seed of their own in console-platform-needs.
  pass(`nothing needs attention (Nothing needs you; No known open issues), the core door counts the ${want[0][1]} real-work calls ` +
       "seeded and its one tool failure, the other doors none, through today, which is not complete");
}

/** `running` is `unrecorded` until a release row names the gateway's own version; then it reads that row, the release
 *  tagged before it and the migrations applied. */
async function runningCases(db: pg.Client, as: (email: string) => Promise<Answer>): Promise<void> {
  const step = "what is running";
  const before = (await as(MEMBER)).body.running;
  if (JSON.stringify(before) !== JSON.stringify({ state: "unavailable", reason: "unrecorded" })) fail(step, `with no release recorded: ${JSON.stringify(before)}`);
  // COUPLED: services/gateway/src/client-package.ts — PLATFORM_VERSION is the gateway's own package version.
  const version = (JSON.parse(readFileSync(join(root, "services", "gateway", "package.json"), "utf8")) as { version: string }).version;
  const now = Date.now();
  const at = (days: number): string => iso(now - days * 86_400_000);
  await db.query(
    `insert into zz.release (version, console_version, released_at, summary, changelog)
     values ($1, '0.27.0', $2, 'seeded', 'seeded'), ('0.0.2', null, $3, 'seeded', 'seeded'), ('0.0.1', null, $4, 'seeded', 'seeded')`,
    [version, at(2), at(9), at(20)]);
  const migrations = (await db.query<{ n: number }>("select count(*)::int as n from zz.schema_migration")).rows[0].n;
  const after = (await as(MEMBER)).body.running;
  const want = { state: "ok", data: { platform: version, console: "0.27.0", releasedAt: at(2), previous: "0.0.2", migrations } };
  if (JSON.stringify(after) !== JSON.stringify(want)) fail(step, `${JSON.stringify(after)}, not ${JSON.stringify(want)}`);
  pass(`what is running is unrecorded until zz.release names ${version}, then reads its console version, its tagged time, ` +
       `the release tagged before it and the ${migrations} migrations applied`);
}

/** A measure with the running week's `observedThrough` left out: it is the request's own `asOf`,
 *  which moves between two requests a second apart. Everything else must be identical. */
function settled(m: unknown): string {
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

    let step = "the same measures for everybody";
    const ref = settled(measuresOf(step, member));
    for (const [who, a] of [
      ["the superadmin", await as(SUPERADMIN)],
      ["the person in no team", await as(NO_TEAM)],
      ["the member sending ?team= and ?scope=", await as(MEMBER, `?team=${TEAM_TWO}&scope=platform`)],
      ["the superadmin sending ?scope=platform", await as(SUPERADMIN, "?scope=platform")],
    ] as const) {
      if (settled(measuresOf(step, a)) !== ref) fail(step, `${who} receives ${settled(measuresOf(step, a))}, the member ${ref}`);
      if (a.body.meta === undefined || (a.body.meta as Obj).scope !== "platform-public") fail(step, `${who} reads meta ${JSON.stringify(a.body.meta)}`);
    }
    pass("a member of team one, a superadmin and a person in no team receive the same eight measures, and a team or scope parameter changes nothing");

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

    attentionCases(member, await as(SUPERADMIN));
    await runningCases(db, as);

    step = "the shape the console's fake answers";
    let fake: unknown;
    try {
      fake = ((await import(pathToFileURL(FAKE).href)) as { PLATFORM_STATUS: unknown }).PLATFORM_STATUS;
    } catch (err) {
      fail(step, `could not read the console's fake answer at ${FAKE}: ${(err as Error).message}`);
    }
    if (!isObj(fake)) fail(step, `${FAKE} exports no PLATFORM_STATUS object`);
    // Read again: what is running is recorded now.
    const recorded = await as(MEMBER);
    const diffs = shapeDiffs(recorded.body, fake, "", []);
    const theirs = (fake as Obj).measures as Obj[];
    for (const m of measuresOf(step, recorded)) shapeDiffs(m, theirs.find((f) => f.key === m.key) ?? {}, `measures.${String(m.key)}`, diffs);
    if (diffs.length) fail(step, diffs.join("; "));
    pass("the answer agrees in shape with the console's fake one, key set by key set and measure by measure, its own part, " +
         "the doors, the records and what is running included");

    const added = await measureCases(db, seeded, as, dbModule.platformDb());

    await thinLastWeek(db, seeded, as, added);
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
