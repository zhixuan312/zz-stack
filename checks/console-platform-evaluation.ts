#!/usr/bin/env node
/**
 * checks/console-platform-evaluation.ts — each plugin's evaluation, its comparability and its
 * findings, read through the gateway's own identity gate and route on a real database (AC-3.7,
 * AC-3.10).
 *
 *   node checks/console-platform-evaluation.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL migrated by the real runner (`withThrowawayDb`), seeds the
 * evaluation `scripts/schema/evaluation-seed.ts` declares, and serves the gateway's own built
 * identity middleware and `GET /api/console/platform/evaluation` from this process, signed in with a
 * real console session cookie per person. What it establishes, against the values the seed writes
 * out by hand:
 *
 *   - the tiles: findings waiting, plugins whose latest score is established, the last scoring, and
 *     the local days in the reporting timezone with a scoring;
 *   - each plugin's latest recorded score with its range, standing, guardrails, protocol and date,
 *     a run never scored named nowhere;
 *   - every score grouped into series: two scores on different dates under one protocol version and
 *     one population kind are one series, a trend, though their plugin versions and their
 *     `scorer_version` differ; scores under two protocol versions, or two population kinds, read
 *     `Not comparable` with that reason;
 *   - findings by decision and by owner, a superseded finding and a strength counted in neither;
 *   - the findings waiting, oldest first, each in its fixed summary;
 *   - for a member, the protocol's and the measure's keys are null and no field and no text of the
 *     answer holds a pattern, a decision note, an owner reference, an evidence reference, a
 *     protocol's or a measure's key, the team or the initiative; the superadmin reads the keys and
 *     each waiting finding's pattern and still none of the rest; a team or scope parameter changes
 *     nothing;
 *   - no session is refused with 401; the route offers no write, and reading changes no row;
 *   - a part whose statement fails is `unavailable` and every other part stands; a failed tile
 *     statement answers 500 with the route's sentence and nothing else;
 *   - the answer agrees in shape with the console's fake one, read from the sibling checkout, for
 *     each person: where both hold an object their key sets are equal, where both hold an array
 *     their first elements are compared the same way, a null on either side is compared with
 *     nothing, and `byOwner`, whose keys are owner categories found in the data, holds numbers.
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
  EXPECTED, FINDING_NAMES, KEYS, MEMBER, NOBODY_READS, SUPERADMIN, patternOf, seedEvaluation,
} from "../scripts/schema/evaluation-seed.ts";
import { signIn } from "../scripts/schema/status-seed.ts";
import { withThrowawayDb } from "../scripts/schema/throwaway.ts";

const NAME = "console-platform-evaluation";
const DONE = "console-platform-evaluation: each plugin's latest score, every score in the series it is comparable " +
  "within, and the findings by decision, by owner and waiting are answered, a member's without the owning team's " +
  "words, from one read that writes nothing: ok";
const TIMEZONE = "Pacific/Auckland";
/** COUPLED: the fake answer in the console's checkout, `../zz-stack-dashboard` here and in CI. */
const FAKE = join(root, "..", "zz-stack-dashboard", "scripts", "fake-gateway", "platform-evaluation.ts");
/** The tables the read selects from; reading must leave each as it was. */
const READ_TABLES = ["eval_run", "eval_finding", "eval_protocol_version", "eval_observation_snapshot",
  "eval_measure", "eval_dimension", "plugin", "plugin_version"] as const;
/** Field names no answer carries, to anybody. */
const NEVER_KEYS = ["decision_note", "decisionNote", "owner_ref", "ownerRef", "evidence_refs", "evidenceRefs",
  "team", "team_id", "teamId", "initiative", "initiative_id", "initiativeId"];

class CaseFailure extends Error {}
function fail(step: string, detail: string): never {
  throw new CaseFailure(`${NAME}: FAILED at "${step}": ${detail}`);
}
const pass = (line: string): void => console.log(`  ok  ${line}`);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

interface Answer { status: number; body: Obj; text: string }

/** Where two answers' shapes differ, by the contract's rule: at an object both hold, the key sets;
 *  at an array both hold, the first elements, the same way; a null on either side, nothing.
 *  `byOwner.data` is keyed by the data, so its values are held to numbers instead. */
function shapeDiffs(a: unknown, b: unknown, at: string, out: string[]): string[] {
  if (a === null || b === null) return out;
  if (at === "byOwner.data") {
    if (!isObj(a) || !Object.values(a).every((n) => Number.isInteger(n))) out.push(`${at} is ${JSON.stringify(a)}, not counts by owner`);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length && b.length) shapeDiffs(a[0], b[0], `${at}[0]`, out);
  } else if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    if (ka.join() !== kb.join()) out.push(`${at || "the answer"} has keys {${ka.join(", ")}} where the fake has {${kb.join(", ")}}`);
    for (const k of ka.filter((x) => kb.includes(x))) shapeDiffs(a[k], b[k], at ? `${at}.${k}` : k, out);
  }
  return out;
}

/** Every field name anywhere in a value. */
function keysIn(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) keysIn(x, out);
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) { out.add(k); keysIn(x, out); }
  return out;
}

/** A part's data, or a failure naming what came instead. */
function data(step: string, a: Answer, key: string): unknown {
  const p = a.body[key];
  if (a.status !== 200 || !isObj(p) || p.state !== "ok") fail(step, `${key} answered ${a.status}: ${JSON.stringify(p ?? a.text.slice(0, 400))}`);
  return p.data;
}

const same = (step: string, what: string, got: unknown, want: unknown): void => {
  if (JSON.stringify(got) !== JSON.stringify(want)) fail(step, `${what} reads ${JSON.stringify(got)}, not ${JSON.stringify(want)}`);
};

/** The seed's expectation as one person reads it: a member's keys null, the superadmin's pattern added. */
function expected(admin: boolean, ids: Map<string, string>) {
  const key = (p: { key: string; version: number }) => ({ key: admin ? p.key : null, version: p.version });
  return {
    plugins: EXPECTED.plugins.map((p) => ({ ...p, protocol: key(p.protocol) })),
    history: EXPECTED.history.map((h) => ({
      plugin: h.plugin, series: h.series.map((s) => ({ ...s, protocol: key(s.protocol) })), statement: h.statement,
    })),
    waiting: {
      rows: EXPECTED.waiting.map(({ finding, ...w }) => ({
        id: ids.get(finding), ...w, measure: admin ? w.measure : null, ...(admin ? { pattern: patternOf(finding) } : {}),
      })),
      total: EXPECTED.waiting.length,
    },
  };
}

/** Everything a person reads, held to the seed's values. */
function readCases(who: string, a: Answer, admin: boolean, ids: Map<string, string>): void {
  const step = `${who} reads the seeded evaluation`;
  if (a.status !== 200) fail(step, `answered ${a.status}: ${a.text.slice(0, 400)}`);
  const meta = a.body.meta as Obj;
  if (!isObj(meta) || meta.scope !== (admin ? "platform-admin" : "platform-public") || meta.timezone !== TIMEZONE
      || meta.coverageFrom !== EXPECTED.coverageFrom || (meta.period as Obj)?.from !== EXPECTED.coverageFrom
      || (meta.period as Obj)?.to !== meta.asOf || meta.population !== "scored evaluation runs") {
    fail(step, `meta reads ${JSON.stringify(meta)}`);
  }
  same(step, "the tiles", a.body.tiles, EXPECTED.tiles);
  const want = expected(admin, ids);
  same(step, "plugins", data(step, a, "plugins"), want.plugins);
  same(step, "history", data(step, a, "history"), want.history);
  same(step, "byDecision", data(step, a, "byDecision"), EXPECTED.byDecision);
  same(step, "byOwner", data(step, a, "byOwner"), EXPECTED.byOwner);
  same(step, "waiting", data(step, a, "waiting"), want.waiting);
  pass(`${who}: ${EXPECTED.tiles.waiting} waiting, 1 plugin established, last scored 5 Oct, 6 local days scored (4 on UTC's ` +
       "calendar); each plugin's latest score with its range, standing, guardrails, protocol and date, the run never scored " +
       "named nowhere; alpha one series across two plugin versions and two scorer versions, beta not comparable for its " +
       "protocol version, gamma for its population; findings by decision and owner without the superseded one or the " +
       "strength; four waiting, oldest first, in their fixed summaries");
}

/** What neither person may read, and what only the superadmin may. */
function privacyCases(member: Answer, admin: Answer): void {
  const step = "the owning team's words";
  const patterns = FINDING_NAMES.map(patternOf);
  const memberHidden = [...patterns, ...KEYS.protocols, ...Object.values(KEYS.measures), ...NOBODY_READS];
  const leaked = memberHidden.filter((s) => member.text.includes(s));
  if (leaked.length) fail(step, `the member's answer holds ${leaked.join(", ")}`);
  const memberKeys = [...keysIn(member.body)].filter((k) => k === "pattern" || NEVER_KEYS.includes(k));
  if (memberKeys.length) fail(step, `the member's answer carries the fields ${memberKeys.join(", ")}`);

  const waiting = new Set(EXPECTED.waiting.map((w) => patternOf(w.finding)));
  const adminHidden = [...patterns.filter((p) => !waiting.has(p)), ...NOBODY_READS].filter((s) => admin.text.includes(s));
  if (adminHidden.length) fail(step, `the superadmin's answer holds ${adminHidden.join(", ")}`);
  const adminKeys = [...keysIn(admin.body)].filter((k) => NEVER_KEYS.includes(k));
  if (adminKeys.length) fail(step, `the superadmin's answer carries the fields ${adminKeys.join(", ")}`);
  const missing = [...waiting, ...KEYS.protocols, KEYS.measures.alpha, KEYS.measures.beta, KEYS.measures.gamma]
    .filter((s) => !admin.text.includes(s));
  if (missing.length) fail(step, `the superadmin's answer lacks ${missing.join(", ")}`);
  pass("a member's answer holds no pattern, decision note, owner reference, evidence reference, protocol or measure key, " +
       "team or initiative, in any field or any text; the superadmin's holds the keys and the waiting findings' patterns " +
       "and none of the rest");
}

/** An answer with its read's moment left out, which moves between two requests. */
const settled = (a: Answer): string => JSON.stringify({ ...a.body, meta: { ...(a.body.meta as Obj), asOf: null, period: null } });

/** One hash over every row of every table the read selects from. */
async function rowsHash(db: pg.Client): Promise<string> {
  const out: string[] = [];
  for (const t of READ_TABLES) {
    out.push((await db.query<{ h: string }>(
      `select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as h from zz.${t} x`)).rows[0].h);
  }
  return out.join(",");
}

async function run(db: pg.Client, url: string): Promise<void> {
  const ids = await seedEvaluation(db);
  const cookie = new Map<string, string>();
  for (const email of [MEMBER, SUPERADMIN]) cookie.set(email, await signIn(db, email));

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
  const { mountPlatformEvaluation } = (await load("services/gateway/dist/console/platform-evaluation.js")) as
    { mountPlatformEvaluation: (app: Express) => void };
  const app = express();
  // COUPLED: services/gateway/src/server.ts — the identity gate before every console route.
  app.use(identityMiddleware());
  mountPlatformEvaluation(app);
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/console/platform/evaluation`;
  const ask = async (method: string, headers: Record<string, string>, query = ""): Promise<Answer> => {
    const res = await fetch(`${base}${query}`, { method, headers, signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    let body: Obj = {};
    try { const v: unknown = JSON.parse(text); if (isObj(v)) body = v; } catch { /* not JSON: body stays empty */ }
    return { status: res.status, body, text };
  };
  const as = (email: string, query = "", method = "GET"): Promise<Answer> =>
    ask(method, { cookie: `zz_console=${cookie.get(email)}` }, query);

  try {
    const before = await rowsHash(db);
    const member = await as(MEMBER);
    const admin = await as(SUPERADMIN);
    readCases("a member", member, false, ids);
    readCases("the superadmin", admin, true, ids);
    privacyCases(member, admin);

    let step = "a team or scope parameter";
    for (const [who, a, ref] of [
      ["the member sending ?team= and ?scope=", await as(MEMBER, "?team=eval-sentinel-team&scope=platform"), member],
      ["the superadmin sending ?scope=platform", await as(SUPERADMIN, "?scope=platform"), admin],
    ] as const) {
      if (settled(a) !== settled(ref)) fail(step, `${who} receives ${settled(a).slice(0, 400)}`);
    }
    pass("a team or scope parameter changes nothing a member or the superadmin reads");

    step = "refusals and writes";
    const none = await ask("GET", {});
    if (none.status !== 401) fail(step, `no session answered ${none.status}: ${none.text.slice(0, 300)}`);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const w = await as(SUPERADMIN, "", method);
      if (w.status !== 404) fail(step, `${method} as the superadmin answered ${w.status}: ${w.text.slice(0, 300)}`);
    }
    const after = await rowsHash(db);
    if (after !== before) fail(step, "a row of a table the read selects from changed while it was read");
    pass("no session is refused with 401, no write method is answered, and reading changed no row");

    step = "a part that fails";
    const stands = (a: Answer, fallen: string, ref: Answer): void => {
      for (const k of ["plugins", "history", "byDecision", "byOwner", "waiting"]) {
        const p = a.body[k] as Obj;
        if (k === fallen) {
          if (a.status !== 200 || !isObj(p) || p.state !== "unavailable" || typeof p.reason !== "string") {
            fail(step, `with ${fallen}'s statement failing, ${k} reads ${a.status} ${JSON.stringify(p)}`);
          }
        } else if (JSON.stringify(p) !== JSON.stringify(ref.body[k])) {
          fail(step, `with ${fallen}'s statement failing, ${k} reads ${JSON.stringify(p)}`);
        }
      }
      if (JSON.stringify(a.body.tiles) !== JSON.stringify(ref.body.tiles)) fail(step, `the tiles read ${JSON.stringify(a.body.tiles)}`);
    };
    await db.query("alter table zz.eval_measure rename to eval_measure_hidden");
    const noMeasure = await as(MEMBER).finally(() => db.query("alter table zz.eval_measure_hidden rename to eval_measure"));
    stands(noMeasure, "waiting", member);
    await db.query("alter table zz.eval_observation_snapshot rename to eval_observation_snapshot_hidden");
    const noSnapshot = await as(MEMBER)
      .finally(() => db.query("alter table zz.eval_observation_snapshot_hidden rename to eval_observation_snapshot"));
    stands(noSnapshot, "history", member);
    await db.query("alter table zz.eval_run rename to eval_run_hidden");
    const broken = await as(MEMBER).finally(() => db.query("alter table zz.eval_run_hidden rename to eval_run"));
    if (broken.status !== 500 || broken.body.error !== "could not read the platform's evaluation" || Object.keys(broken.body).length !== 1) {
      fail(step, `with every statement failing, answered ${broken.status}: ${broken.text.slice(0, 300)}`);
    }
    pass("a failing measure lookup leaves only waiting unavailable, a failing snapshot only history, the other parts and " +
         "the tiles standing; a failing tile statement answers 500, could not read the platform's evaluation, and nothing else");

    step = "the shape the console's fake answers";
    let fake: (admin: boolean) => unknown;
    try {
      fake = ((await import(pathToFileURL(FAKE).href)) as { evaluation: (admin: boolean) => unknown }).evaluation;
    } catch (err) {
      fail(step, `could not read the console's fake answer at ${FAKE}: ${(err as Error).message}`);
    }
    if (typeof fake !== "function") fail(step, `${FAKE} exports no evaluation function`);
    const diffs = [
      ...shapeDiffs(member.body, fake(false), "", []).map((d) => `the member's: ${d}`),
      ...shapeDiffs(admin.body, fake(true), "", []).map((d) => `the superadmin's: ${d}`),
    ];
    if (diffs.length) fail(step, diffs.join("; "));
    pass("each person's answer agrees in shape with the console's fake one, key set by key set");
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
