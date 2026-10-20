#!/usr/bin/env node
/**
 * checks/console-platform-query-shape.ts — the Platform prepared query, read through the gateway's own built route
 * on a real database, holds the console's fake answer to its shape, measure by measure, for a member and for the
 * superadmin, and the fake refuses what the route refuses with the route's own sentences (AC-1.14, AC-5.2).
 *
 *   node checks/console-platform-query-shape.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL and a real zz-core on it (`withThrowawayCore`), seeds what
 * `checks/console-platform-query-seed.ts` declares, and calls the gateway's own built route
 * (`services/gateway/dist/console/platform-query.js`) the way Express would, as a console session; the fake is the
 * console's `scripts/fake-gateway/platform-query.ts`, read from the sibling checkout and asked the same question as
 * the fake's own two people. What it establishes:
 *
 *   - every measure, grouped by day (or a stock by its first dimension) against the window before and folded by
 *     top, agrees in shape with the fake's answer, as each person who may ask it: where both hold an object their
 *     key sets are equal, where both hold an array their first elements are compared the same way, and a null on
 *     either side is compared with nothing; so each answer must hold a group, a rest and, but for a stock, a previous
 *     on both sides, or its shape would pass unread;
 *   - every measure that is drilled, drilled to its newest rows from the first recorded day, agrees the same way, the
 *     rows non-empty on both sides;
 *   - each question the route refuses, 400 for what it does not take and 403 for what only the superadmin is shown,
 *     the fake refuses with the same status and the same body.
 *
 * The reporting time zone is UTC here, the fake's own, so a day is the same day on both sides.
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

import { SUPERADMIN, seedPlatformQuery } from "./console-platform-query-seed.ts";
import { shapeDiffs } from "../scripts/schema/shape-diffs.ts";

const NAME = "console-platform-query-shape";
const DONE = "console-platform-query-shape: every measure, grouped and drilled, is answered by the console's fake in the " +
  "gateway's shape for a member and for the superadmin, and every refusal with the gateway's own status and sentence: ok";
const TIMEZONE = "UTC";
const ALL = "0001-01-01";
/** COUPLED: the fake answer in the console's checkout, `../zz-stack-dashboard` here and in CI. */
const FAKE = join(root, "..", "zz-stack-dashboard", "scripts", "fake-gateway", "platform-query.ts");
/** The measures the route answers, each a stock or not and drilled or not, and whether only the superadmin asks it.
 *  COUPLED: services/gateway/src/console/platform-query-measures.ts `MEASURES`. */
const MEASURES: Record<string, { stock?: string; drilled: boolean; superadmin?: true; drillSuperadmin?: true }> = {
  calls: { drilled: true }, refusals: { drilled: false }, malformed: { drilled: false }, releases: { drilled: true },
  migrations: { drilled: false }, bugs_filed: { drilled: true }, bugs_resolved: { drilled: true }, findings: { drilled: true },
  scores: { drilled: true }, lessons: { drilled: false }, searches: { drilled: true, drillSuperadmin: true },
  model_calls: { drilled: false }, teams: { stock: "status", drilled: true, superadmin: true },
  people: { stock: "role", drilled: true, superadmin: true }, sign_ins: { drilled: true, superadmin: true },
  audit: { drilled: true, superadmin: true },
};

type Obj = Record<string, unknown>;
type Route = (req: unknown, res: unknown) => void;
type Who = { email: string; role: "member" | "superadmin"; team: string | null };
/** One of the fake's two people, as its route reads a caller. */
type FakeWho = { email: string; superadmin: boolean; activeTeam: string | null };
type Answer = { status: number; body: Obj };
/** A query as Express hands it on: a where repeated is an array. */
type Query = Record<string, string | string[]>;

const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const show = (v: unknown): string => JSON.stringify(v).slice(0, 500);
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

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

/** The same query as the fake's URL reads it. */
function params(query: Query): URLSearchParams {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) for (const x of [v].flat()) p.append(k, x);
  return p;
}

async function run(c: Core): Promise<void> {
  process.env.TEAM_DB_URL = c.url;
  process.env.ZZ_TZ = TIMEZONE;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  const load = (p: string) => import(pathToFileURL(join(root, "services/gateway/dist", p)).href);
  const db = (await load("db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await db.initPlatformDb();
  const routes = new Map<string, Route>();
  ((await load("console/platform-query.js")) as { mountPlatformQuery: (app: unknown) => void })
    .mountPlatformQuery({ get: (p: string, h: Route) => routes.set(p, h) });
  try {
    const route = routes.get("/api/console/platform/query") ?? c.fail("mount", "no route GET /api/console/platform/query");
    await seedPlatformQuery(c, TIMEZONE);
    await cases(c, route);
  } finally {
    await db.platformDb().end().catch(() => undefined);
    for (const k of ["TEAM_DB_URL", "ZZ_TZ", "ZZ_CATALOG_DIR"]) delete process.env[k];
  }
}

async function cases(c: Core, route: Route): Promise<void> {
  let step = "the console's fake answer";
  let fake: (who: FakeWho, q: URLSearchParams) => [number, unknown];
  try {
    fake = ((await import(pathToFileURL(FAKE).href)) as { platformQuery: typeof fake }).platformQuery;
  } catch (err) {
    return c.fail(step, `could not read the console's fake answer at ${FAKE}: ${(err as Error).message}`);
  }
  if (typeof fake !== "function") c.fail(step, `${FAKE} exports no platformQuery function`);

  // Each person on both sides: the gateway's seeded member and superadmin, and the fake's two people.
  const PEOPLE: { name: string; ours: Who; theirs: FakeWho }[] = [
    { name: "the member", ours: { email: c.email, role: "member", team: c.team }, theirs: { email: "noah.okafor@example.com", superadmin: false, activeTeam: "atlas" } },
    { name: "the superadmin", ours: { email: SUPERADMIN, role: "superadmin", team: null }, theirs: { email: "ava.lindqvist@example.com", superadmin: true, activeTeam: "atlas" } },
  ];
  const both = async (who: (typeof PEOPLE)[number], query: Query): Promise<[Answer, Answer]> => {
    const ours = await answer(route, request(who.ours, query));
    const [status, body] = fake(who.theirs, params(query));
    return [ours, { status, body: body as Obj }];
  };
  const today = day(Date.now());
  const window = { from: day(Date.now() - 27 * 86_400_000), to: today };
  /** The parts of an answer a shape is held through, each of which must hold something on both sides. */
  const held = (a: Obj, parts: string[]): string[] => parts.filter((p) => {
    if (p === "groups") return !(a.groups as unknown[] | undefined)?.length;
    if (p === "previous") return !isObj((a.groups as Obj[] | undefined)?.[0]?.previous);
    if (p === "rows") return !(((a.rows as Obj | null)?.data as Obj | undefined)?.rows as unknown[] | undefined)?.length;
    return !isObj(a[p]);
  });
  const agree = (st: string, label: string, ours: Answer, theirs: Answer, parts: string[]): void => {
    if (ours.status !== 200 || theirs.status !== 200) c.fail(st, `${label} answered ${ours.status}: ${show(ours.body)}; the fake ${theirs.status}: ${show(theirs.body)}`);
    const empty = [...held(ours.body, parts).map((p) => `the gateway's ${p}`), ...held(theirs.body, parts).map((p) => `the fake's ${p}`)];
    if (empty.length) c.fail(st, `${label}: ${empty.join(", ")} holds nothing, so its shape would pass unread`);
    const diffs = shapeDiffs(ours.body, theirs.body, "", []);
    if (diffs.length) c.fail(st, `${label}: ${diffs.join("; ")}`);
  };

  step = "every measure, grouped, agrees in shape with the fake's answer";
  for (const [measure, m] of Object.entries(MEASURES)) {
    for (const who of PEOPLE.filter((p) => !m.superadmin || p.ours.role === "superadmin")) {
      const query: Query = m.stock ? { measure, by: m.stock, ...window, top: "1" } : { measure, by: "day", ...window, compare: "previous", top: "1" };
      const [ours, theirs] = await both(who, query);
      agree(step, `${measure} for ${who.name}`, ours, theirs, m.stock ? ["groups", "rest", "total", "window", "meta"] : ["groups", "rest", "previous", "total", "window", "meta"]);
    }
  }
  c.pass(step);

  step = "every measure that is drilled agrees in shape with the fake's rows";
  for (const [measure, m] of Object.entries(MEASURES).filter(([, x]) => x.drilled)) {
    for (const who of PEOPLE.filter((p) => !(m.superadmin || m.drillSuperadmin) || p.ours.role === "superadmin")) {
      const [ours, theirs] = await both(who, { measure, rows: "5", from: ALL, to: today });
      agree(step, `${measure}'s rows for ${who.name}`, ours, theirs, ["rows"]);
    }
  }
  c.pass(step);

  step = "the fake refuses what the route refuses, with its status and sentence";
  const [member, admin] = PEOPLE;
  for (const [who, query] of [
    [admin, { measure: "bytes" }], [admin, { measure: "calls", by: "skill" }], [admin, { measure: "releases", by: "tool" }],
    [admin, { measure: "teams", by: "day" }], [admin, { measure: "calls", from: "2026-10-01" }],
    [admin, { measure: "calls", from: "2026-10-01", to: "2026-10-02T00:00:00Z" }], [admin, { measure: "teams", compare: "previous" }],
    [admin, { measure: "calls", where: "tool" }], [admin, { measure: "calls", where: "owner=ours" }], [admin, { measure: "releases", where: "kind=x" }],
    [admin, { measure: "calls", where: ["refused=refused", "refused=answered", "refused=refused", "refused=answered", "refused=refused"] }],
    [admin, { measure: "calls", where: "refused=SENTINEL" }], [admin, { measure: "bugs_filed", where: "impact=SENTINEL" }],
    [admin, { measure: "calls", group: "x" }], [admin, { measure: "calls", by: "week", group: "2026-10-07" }],
    [admin, { measure: "calls", rows: "5", limit: "5" }], [admin, { measure: "refusals", rows: "5" }], [admin, { measure: "lessons", by: "kind", group: "decision" }],
    [admin, { measure: "calls", rows: "21" }], [admin, { measure: "calls", by: "tool", top: "51" }], [admin, { measure: "calls", by: ["tool", "week"] }],
    [member, { measure: "teams" }], [member, { measure: "audit", by: "kind" }], [member, { measure: "calls", by: "team" }],
    [member, { measure: "bugs_filed", where: "team=x" }], [member, { measure: "searches", rows: "5" }], [member, { measure: "lessons", where: "shelf=x" }],
  ] as [(typeof PEOPLE)[number], Query][]) {
    const [ours, theirs] = await both(who, query);
    if (ours.status === 200 || ours.status !== theirs.status || JSON.stringify(ours.body) !== JSON.stringify(theirs.body)) {
      c.fail(step, `${show(query)} for ${who.name}: the gateway answered ${ours.status} ${show(ours.body)}, the fake ${theirs.status} ${show(theirs.body)}`);
    }
  }
  c.pass(step);
}

process.exitCode = await withThrowawayCore(NAME, DONE, run);
