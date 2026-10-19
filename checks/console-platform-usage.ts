#!/usr/bin/env node
/**
 * checks/console-platform-usage.ts — the platform's usage, read through the gateway's own identity
 * gate and route on a real database (AC-4.3, AC-4.4).
 *
 *   node checks/console-platform-usage.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL migrated by the real runner (`withThrowawayDb`), seeds the events,
 * teams, people, vocabulary and model calls `scripts/schema/usage-seed.ts` declares, and serves the
 * gateway's own built identity middleware and `GET /api/console/platform/usage` from this process,
 * signed in with a real console session cookie per person. What it establishes:
 *
 *   - every part answers the values the seed writes out by hand: the 26 newest of the record's 29
 *     weeks, Monday to Monday in the reporting timezone, only the running one not complete; the
 *     calls, the share refused, the slowest 5% and the sessions by week with the last whole week
 *     and the one before it; the platform's own traffic and all refusals by population over the
 *     last whole week; refusals put right with the median seconds, the sessions continued and the
 *     unassessable count; each registered tool's median call in its first comparable week and the
 *     last; weekday by hour in the reporting timezone; the tools called most; calls per recorded
 *     approval; and the platform's model calls, their cost `not_recorded`;
 *   - the superadmin's calls by week carry the three teams with the most calls over the weeks shown
 *     and `Other`, a team whose calls lie before the weeks shown not among them; a member's carry no
 *     parts, every other figure is the superadmin's, and no team's slug is anywhere in their answer;
 *     the superadmin's answer is labelled `platform-admin` and the member's `platform-public` (ReadMeta);
 *   - the two maintenance-inclusive parts count maintenance and every other figure does not; a call
 *     that failed with no refusal owner is no refusal; a refusal with no session is unassessable;
 *   - a tool no door registers is counted under `Unregistered tools` and its name, like a refusal's
 *     text, is in no answer; no field ranks, scores or calls a direction better;
 *   - a team or scope parameter changes nothing; page views and events of other kinds change nothing;
 *   - a part whose statement fails is `unavailable` while every other part stands; no session is
 *     refused with 401, a member's token with 403, and a failed read of the weeks answers 500;
 *   - the answers agree in shape with the console's fake ones for both people, read from the sibling
 *     checkout: where both hold an object their key sets are equal, where both hold an array their
 *     first elements are compared the same way, and a null on either side is compared with nothing.
 *
 * DELIBERATE: the reporting timezone is Pacific/Auckland, a day ahead of UTC for most of the
 * morning, so weekday and hour cut on UTC's clock land in other cells.
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
import { signIn, weekStart } from "../scripts/schema/status-seed.ts";
import {
  MEMBER, REFUSAL_TEXT, SUPERADMIN, TEAMS, UNREGISTERED, USAGE, seedUsage, seedUsageNoise, type Seeded, type Week,
} from "../scripts/schema/usage-seed.ts";
import { withThrowawayDb } from "../scripts/schema/throwaway.ts";

const NAME = "console-platform-usage";
const DONE = "console-platform-usage: the platform's usage is answered part by part with its populations named, real work " +
  "unless a part names maintenance, the split by team the superadmin's alone, tools named only from the vocabulary: ok";
const TIMEZONE = "Pacific/Auckland";
/** COUPLED: the fake answer in the console's checkout, `../zz-stack-dashboard` here and in CI. */
const FAKE = join(root, "..", "zz-stack-dashboard", "scripts", "fake-gateway", "platform-usage.ts");
const PARTS = ["tiles", "callsByWeek", "traffic", "refusals", "followup", "tools", "rhythm", "mostUsed", "perApproval", "modelCalls"];
/** Field names that would rank, score or judge a figure. */
const JUDGING = /^(better|best|worst|judgement|rank|ranking|score|scores|direction|improved|worsened|highest|lowest|finding)$/;

class CaseFailure extends Error {}
function fail(step: string, detail: string): never {
  throw new CaseFailure(`${NAME}: FAILED at "${step}": ${detail}`);
}
const pass = (line: string): void => console.log(`  ok  ${line}`);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

interface Answer { status: number; body: Obj; text: string }

/** Where two answers' shapes differ: at an object both hold, the key sets; at an array both hold, the first
 *  elements, the same way; a null on either side, nothing. */
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

/** An answer with the running week's `observedThrough` left out: it is the request's own `asOf`, which moves
 *  between two requests a second apart. */
function settled(v: unknown): string {
  return JSON.stringify(v, function (this: Obj, k: string, x: unknown) {
    return (k === "observedThrough" && this.complete === false) || k === "asOf" || (k === "to" && this.from !== undefined && !("complete" in this))
      ? undefined : x;
  });
}

/** A part's data, or a failure naming what came instead. */
function data(step: string, a: Answer, part: string): Obj {
  const p = a.body[part] as Obj | undefined;
  if (a.status !== 200 || !isObj(p) || p.state !== "ok" || !isObj(p.data)) fail(step, `${part} reads ${JSON.stringify(p)} (status ${a.status})`);
  return p.data as Obj;
}

/** Where a period figure differs from `[numerator, denominator, value, why]`, or null. */
function weekDiff(w: unknown, want: Week): string | null {
  const o = (w ?? {}) as Obj, fig = (o.figure ?? {}) as Obj;
  const got = [o.numerator, o.denominator, fig.value, fig.why];
  return same(got, want) ? null : `${JSON.stringify(got)}, not ${JSON.stringify(want)}`;
}

/** Every part held to what the seed writes out; the superadmin's calls by week carry the parts, a member's none. */
function heldToSeed(step: string, s: Seeded, a: Answer, admin: boolean): void {
  const start = (back: number): number => s.starts.get(back) ?? weekStart(s.now, back, TIMEZONE);
  const backs = Array.from({ length: 26 }, (_, i) => USAGE.oldestShownBack - i);
  const problems: string[] = [];
  const out = (what: string) => problems.push(what);
  const asOf = String((a.body.meta as Obj | undefined)?.asOf);
  const windowAt = (what: string, win: unknown, back: number, complete = back !== 0) => {
    const w = (win ?? {}) as Obj;
    const through = back === 0 ? asOf : iso(start(back - 1));
    if (w.from !== iso(start(back)) || w.to !== iso(start(back - 1)) || w.complete !== complete || w.observedThrough !== through
        || w.observedFrom !== iso(start(back))) {
      out(`${what} runs ${JSON.stringify(w)}, not back ${back}: ${iso(start(back))} to ${iso(start(back - 1))}, complete ${complete}`);
    }
  };
  const weeksAt = (what: string, weeks: unknown, want: (back: number) => Week) => {
    if (!Array.isArray(weeks) || weeks.length !== 26) return out(`${what} has ${Array.isArray(weeks) ? weeks.length : "no"} weeks, not 26`);
    weeks.forEach((w, i) => {
      windowAt(`${what}[${i}]`, (w as Obj).window, backs[i]);
      const d = weekDiff(w, want(backs[i]));
      if (d) out(`${what} back ${backs[i]} reads ${d}`);
    });
  };

  const meta = a.body.meta as Obj;
  if (meta?.scope !== (admin ? "platform-admin" : "platform-public") || meta.timezone !== TIMEZONE || meta.coverageFrom !== iso(start(USAGE.coverageBack))
      || !isObj(meta.period) || meta.period.from !== iso(start(USAGE.oldestShownBack)) || meta.period.to !== meta.asOf
      || typeof meta.population !== "string" || !/real-work/.test(meta.population) || !/maintenance/.test(meta.population)) {
    out(`meta reads ${JSON.stringify(meta)}`);
  }

  const tiles = data(step, a, "tiles");
  const tileWant: Record<string, (back: number) => Week> = {
    calls: (b) => { const n = USAGE.calls[b] ?? 0; return [n, null, n, null]; },
    refusedShare: (b) => USAGE.refusedShare[b] ?? USAGE.refusedShare.quiet,
    p95Ms: (b) => USAGE.p95Ms[b] ?? USAGE.p95Ms.quiet,
    sessions: (b) => { const n = USAGE.sessions[b] ?? 0; return [n, null, n, null]; },
  };
  for (const [k, want] of Object.entries(tileWant)) {
    const t = tiles[k] as Obj;
    weeksAt(`tiles.${k}`, t?.weeks, want);
    if (!same(t?.last, (t?.weeks as Obj[])?.[24]) || !same(t?.previous, (t?.weeks as Obj[])?.[23])) {
      out(`tiles.${k}: last and previous are not L and L-1 (${JSON.stringify([t?.last, t?.previous])})`);
    }
  }

  const byWeek = data(step, a, "callsByWeek").weeks as Obj[];
  if (!Array.isArray(byWeek) || byWeek.length !== 26) out(`callsByWeek has ${byWeek?.length} weeks`);
  else byWeek.forEach((w, i) => {
    const b = backs[i];
    windowAt(`callsByWeek[${i}]`, w.window, b);
    if (!same(w.calls, { value: USAGE.calls[b] ?? 0, why: null })) out(`callsByWeek back ${b} counts ${JSON.stringify(w.calls)}`);
    const want = admin ? USAGE.labels.map((label, j) => ({ label, calls: (USAGE.parts[b] ?? [0, 0, 0, 0])[j] })) : null;
    if (!same(w.parts, want)) out(`callsByWeek back ${b} parts ${JSON.stringify(w.parts)}, not ${JSON.stringify(want)}`);
  });

  const traffic = data(step, a, "traffic");
  windowAt("traffic", traffic.window, 1);
  if (traffic.work !== USAGE.traffic.work || traffic.maintenance !== USAGE.traffic.maintenance) out(`traffic reads ${JSON.stringify(traffic)}`);
  const refusals = data(step, a, "refusals");
  windowAt("refusals", refusals.window, 1);
  if (!same({ ...refusals, window: undefined }, { ...USAGE.refusals, window: undefined })
      || Object.keys(refusals).sort().join() !== "guardrail,maintenance,other,ours,theirs,window") {
    out(`refusals read ${JSON.stringify(refusals)}`);
  }

  const followup = data(step, a, "followup").weeks as Obj[];
  if (!Array.isArray(followup) || followup.length !== 26) out(`followup has ${followup?.length} weeks`);
  else followup.forEach((w, i) => {
    const b = backs[i], want = USAGE.followup[b] ?? USAGE.followup.quiet;
    windowAt(`followup[${i}]`, w.window, b);
    for (const k of ["putRight", "sessionsContinued"] as const) {
      windowAt(`followup[${i}].${k}`, (w[k] as Obj)?.window, b);
      const d = weekDiff(w[k], want[k]);
      if (d) out(`followup back ${b} ${k} reads ${d}`);
    }
    const m = w.medianSeconds as Obj;
    if (!same([m?.value, m?.why], want.medianSeconds)) out(`followup back ${b} medianSeconds reads ${JSON.stringify(m)}`);
    if (w.unassessable !== want.unassessable) out(`followup back ${b} unassessable ${String(w.unassessable)}, not ${want.unassessable}`);
  });

  const tools = data(step, a, "tools");
  const rows = (tools.rows ?? []) as Obj[];
  if (rows.length !== USAGE.tools.rows.length || tools.total !== USAGE.tools.total) out(`tools read ${JSON.stringify(tools)}`);
  USAGE.tools.rows.forEach(([tool, [firstBack, firstMs, firstWhy, firstCalls], [lastMs, lastWhy, lastCalls]], i) => {
    const r = rows[i] ?? {}, first = (r.first ?? {}) as Obj, last = (r.last ?? {}) as Obj;
    windowAt(`tools ${tool} first`, first.window, firstBack);
    windowAt(`tools ${tool} last`, last.window, 1);
    if (r.tool !== tool || !same(first.medianMs, { value: firstMs, why: firstWhy }) || first.calls !== firstCalls
        || !same(last.medianMs, { value: lastMs, why: lastWhy }) || last.calls !== lastCalls) {
      out(`tools row ${i} reads ${JSON.stringify(r)}, not ${tool} ${firstMs}/${firstWhy}/${firstCalls} then ${lastMs}/${lastWhy}/${lastCalls}`);
    }
  });

  const rhythm = data(step, a, "rhythm");
  const grid = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  for (const [d, h, n] of USAGE.rhythm) grid[d][h] = n;
  const rw = rhythm.window as Obj;
  if (rhythm.timezone !== TIMEZONE || !same(rhythm.values, grid) || rw?.from !== iso(start(USAGE.oldestShownBack)) || rw.to !== iso(start(0))
      || rw.observedFrom !== rw.from || rw.observedThrough !== rw.to || rw.complete !== true) {
    out(`rhythm reads ${JSON.stringify(rhythm)}`);
  }

  const mostUsed = data(step, a, "mostUsed");
  if (!same(mostUsed, USAGE.mostUsed)) out(`mostUsed reads ${JSON.stringify(mostUsed)}, not ${JSON.stringify(USAGE.mostUsed)}`);

  const perApproval = data(step, a, "perApproval");
  for (const [k, back] of [["last", 1], ["previous", 2]] as const) {
    windowAt(`perApproval.${k}`, (perApproval[k] as Obj)?.window, back);
    const d = weekDiff(perApproval[k], USAGE.perApproval[k]);
    if (d) out(`perApproval.${k} reads ${d}`);
  }

  const model = data(step, a, "modelCalls");
  for (const [k, back] of [["last", 1], ["previous", 2]] as const) {
    const w = (model[k] ?? {}) as Obj;
    windowAt(`modelCalls.${k}`, w.window, back);
    if (!same({ ...w, window: undefined }, { ...USAGE.modelCalls[k], window: undefined })) out(`modelCalls.${k} reads ${JSON.stringify(w)}`);
  }
  if (!same(model.byPurpose, USAGE.modelCalls.byPurpose) || model.cost !== "not_recorded") {
    out(`modelCalls reads ${JSON.stringify({ byPurpose: model.byPurpose, cost: model.cost })}`);
  }
  if (problems.length) fail(step, problems.join("; "));
}

/** Every key an answer holds, at any depth. */
function keysOf(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) keysOf(x, out);
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out); }
  return out;
}

/** A member's answer with no parts is the superadmin's with none. */
const unsplit = (body: Obj): string => settled({
  ...body, meta: { ...(body.meta as Obj), asOf: undefined, scope: undefined },
  callsByWeek: { ...(body.callsByWeek as Obj), data: { weeks: ((((body.callsByWeek as Obj).data as Obj)?.weeks ?? []) as Obj[]).map((w) => ({ ...w, parts: null })) } },
});

async function run(db: pg.Client, url: string): Promise<void> {
  const seeded = await seedUsage(db, TIMEZONE);
  const cookie = new Map<string, string>();
  for (const email of [MEMBER, SUPERADMIN]) cookie.set(email, await signIn(db, email));
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
  const { mountPlatformUsage } = (await load("services/gateway/dist/console/platform-usage.js")) as
    { mountPlatformUsage: (app: Express) => void };
  const app = express();
  // COUPLED: services/gateway/src/server.ts — the identity gate before every console route.
  app.use(identityMiddleware());
  mountPlatformUsage(app);
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/console/platform/usage`;
  const get = async (headers: Record<string, string>, query = ""): Promise<Answer> => {
    const res = await fetch(`${base}${query}`, { headers, signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    let body: Obj = {};
    try { const v: unknown = JSON.parse(text); if (isObj(v)) body = v; } catch { /* not JSON: body stays empty */ }
    return { status: res.status, body, text };
  };
  const as = (email: string, query = ""): Promise<Answer> => get({ cookie: `zz_console=${cookie.get(email)}` }, query);

  try {
    const admin = await as(SUPERADMIN);
    const member = await as(MEMBER);
    let step = "the superadmin's usage as the seed writes it out";
    heldToSeed(step, seeded, admin, true);
    pass("the superadmin reads every part as the seed writes it out: 26 of the 29 weeks recorded, the running one not complete; " +
         "calls by week split into kestrel-works, osprey-works, heron-works and Other, wren-works's calls before the weeks shown " +
         "not counted; maintenance only in the traffic and refusals parts; refusals put right 30 of 30 and 2 of 5, in a median " +
         "45 and 60 seconds, sessions continued 30 of 30 and 4 of 5, a refusal with no session and one in its lookahead unassessable; " +
         "each tool's first comparable week, skill_read's outside the weeks shown; weekday by hour in Pacific/Auckland; 120 calls " +
         "over 5 recorded approvals and none the week before; model calls with their cost not recorded");

    step = "the member's usage";
    heldToSeed(step, seeded, member, false);
    if (unsplit(member.body) !== unsplit(admin.body)) fail(step, "the member's figures differ from the superadmin's beyond the parts");
    for (const slug of TEAMS) if (member.text.includes(slug)) fail(step, `the member's answer holds ${slug}`);
    pass("a member reads the same figures with no split by team, and no team's slug anywhere in the answer; the superadmin's " +
         "answer is labelled platform-admin and the member's platform-public");

    step = "names and text no answer carries";
    const word = UNREGISTERED.split(":")[1];
    for (const [who, a] of [["the superadmin", admin], ["the member", member]] as const) {
      if (a.text.includes(word)) fail(step, `${who}'s answer names ${UNREGISTERED}`);
      if (a.text.includes(REFUSAL_TEXT)) fail(step, `${who}'s answer carries a refusal's text`);
      const judging = [...keysOf(a.body)].filter((k) => JUDGING.test(k));
      if (judging.length) fail(step, `${who}'s answer holds ${judging.join(", ")}`);
      if (/"(improved|worsened|favourable)"/.test(a.text)) fail(step, `${who}'s answer judges a direction`);
    }
    pass("a tool no door registers is counted as Unregistered tools and named nowhere, no refusal's text is answered, and " +
         "no field ranks, scores or judges a direction");

    step = "a parameter changes nothing";
    for (const [who, a, ref] of [
      ["the member sending ?team= and ?scope=", await as(MEMBER, `?team=${TEAMS[1]}&scope=platform`), member],
      ["the superadmin sending ?scope=platform", await as(SUPERADMIN, "?scope=platform&team=kestrel-works"), admin],
    ] as const) {
      if (settled(a.body) !== settled(ref.body)) fail(step, `${who} reads ${a.text.slice(0, 400)}`);
    }
    pass("a team or scope parameter changes neither person's answer");

    step = "refusals";
    const none = await get({});
    if (none.status !== 401) fail(step, `no session answered ${none.status}: ${none.text.slice(0, 300)}`);
    const token = await get({ authorization: `Bearer ${pat}` });
    if (token.status !== 403 || "tiles" in token.body) fail(step, `a member's token answered ${token.status}: ${token.text.slice(0, 300)}`);
    pass("no session is refused with 401, and a member's token, which the console does not let in, with 403");

    step = "a query that fails";
    await db.query("alter table zz.event rename to event_hidden");
    const broken = await as(MEMBER).finally(() => db.query("alter table zz.event_hidden rename to event"));
    if (broken.status !== 500 || broken.body.error !== "could not read the platform's usage" || Object.keys(broken.body).length !== 1) {
      fail(step, `answered ${broken.status}: ${broken.text.slice(0, 300)}`);
    }
    pass("a failed read of the weeks answers 500, could not read the platform's usage, and nothing else");

    step = "a part that cannot be read";
    const pool = dbModule.platformDb();
    const real = pool.query.bind(pool) as (text: unknown, params?: unknown[]) => Promise<unknown>;
    const failing = async (when: (sql: string) => boolean): Promise<Answer> => {
      (pool as unknown as { query: unknown }).query = (text: unknown, params?: unknown[]) =>
        typeof text === "string" && when(text) ? Promise.reject(new Error("injected by the check")) : real(text, params);
      try { return await as(SUPERADMIN); } finally { (pool as unknown as { query: unknown }).query = real; }
    };
    const fresh = await as(SUPERADMIN);
    for (const [part, marker] of [["modelCalls", "zz.model_call"], ["followup", "interval '120 seconds'"], ["rhythm", "isodow"],
                                  ["callsByWeek", "t.slug, count(*)"]] as const) {
      const a = await failing((sql) => sql.includes(marker));
      if (!same(a.body[part], { state: "unavailable", reason: "query_failed" })) fail(step, `${part} reads ${JSON.stringify(a.body[part])}`);
      for (const other of PARTS.filter((p) => p !== part)) {
        if (settled(a.body[other]) !== settled(fresh.body[other])) fail(step, `with ${part} failing, ${other} moved: ${settled(a.body[other]).slice(0, 300)}`);
      }
    }
    pass("a part whose statement fails (model calls, refusals put right, weekday by hour, the superadmin's split) is unavailable " +
         "and every other part stands");

    step = "the shape the console's fake answers";
    let usage: ((admin: boolean) => unknown) | undefined;
    try {
      usage = ((await import(pathToFileURL(FAKE).href)) as { usage?: (admin: boolean) => unknown }).usage;
    } catch (err) {
      fail(step, `could not read the console's fake answer at ${FAKE}: ${(err as Error).message}`);
    }
    if (typeof usage !== "function") fail(step, `${FAKE} exports no usage function`);
    const diffs = [...shapeDiffs(admin.body, usage(true), "", []).map((d) => `the superadmin's: ${d}`),
                   ...shapeDiffs(member.body, usage(false), "", []).map((d) => `the member's: ${d}`)];
    if (diffs.length) fail(step, diffs.join("; "));
    pass("both people's answers agree in shape with the console's fake ones, key set by key set, every part included");

    step = "page views and other kinds change nothing";
    await seedUsageNoise(db, seeded);
    const noisy = await as(SUPERADMIN);
    heldToSeed(step, seeded, noisy, true);
    if (settled(noisy.body) !== settled(fresh.body)) fail(step, "the answer moved when page views and other kinds of event were added");
    pass("page views and events of other kinds in every week with calls change nothing");
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
