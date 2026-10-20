#!/usr/bin/env node
/**
 * checks/console-work-query.ts — Work's prepared queries: the agent asks the database what a page does not
 * show, and is answered with the figures the pages draw (AC-5.2, AC-5.3, AC-5.5, AC-5.7, AC-6.2 to AC-6.5).
 *
 *   node checks/console-work-query.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL and a real zz-core on it (`withThrowawayCore`), and the gateway's own built
 * door in this process, as `checks/console-work-home.ts` does, so a document a person's session (`zz-plugin`) or a
 * maintenance client (`zz-migrate`) writes through it leaves the rows the import rule reads. The record is made
 * in phases, each moved, together and by one interval, into the week and hour it names; the searches and the runs
 * are written as rows, as their own seeds write them. A second team's work and a maintenance client's lie in the
 * same week. It calls the gateway's own built routes (`services/gateway/dist/console/work-query.js`, and Home's,
 * Initiatives' and Approvals') the way Express would, as a console session, the relay reaching that zz-core.
 * What it establishes, with the expected values written below:
 *
 *   - each measure by each dimension it allows, over the last whole week, answers the record's values, its
 *     groups summing to the total and each share its part of it;
 *   - those values are the figures the pages draw for the same window and filters: Home's closures, words,
 *     approvals and searches, the observed runs by skill and weekday, the writing ledger's transitions,
 *     Approvals' history, and Initiatives' summary under state, flow and q;
 *   - the 20 largest groups are answered and the rest folded, the largest first;
 *   - compare=previous answers each group's value in the previous window of the same length;
 *   - a drill pages one group's rows in a stable order, an initiative's next move what initiative_status says;
 *   - a month-long window and a year-long one answer the grain grainFor chooses, by its periods, never folded;
 *   - over the record's four weeks as dates, every measure answers `checks/console-work-query-harness.ts`'s
 *     cases: dates as their days' instants, every bucket in order and each the sum of its drilled rows, rows
 *     newest first, where as its group's total, and from=0001-01-01 from the record's first day; closures by
 *     week are 0, 0, 1 and 4, top keeps the latest 20 days and the largest outcome, and runs' weekday stays
 *     its own dimension;
 *   - approvals are the caller's alone, and a second team's records, an import-made document and a maintenance
 *     client's lesson change no answer, neither does naming another team or the platform;
 *   - an unknown measure, an unknown dimension, a dimension the measure does not allow, a date and an instant
 *     in one window, a filter it does not take and an argument it cannot read are refused with 400 naming the
 *     allowed values and never echoing a value sent, with every table hidden, so before anything is read; a
 *     read that fails makes the total and the groups unavailable and says so;
 *   - reading it records no event, and the key sets match the console's fake answer.
 *
 * DELIBERATE: the reporting timezone is Asia/Singapore, eight hours ahead of UTC, so a week cut on UTC's
 * calendar moves what the record places before 08:00 on a Monday. Nothing is placed in the running week.
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

import { lastJson } from "@zz/mcp-client";
import type { Request, RequestHandler } from "express";
import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import { shapeDiffs } from "../scripts/schema/shape-diffs.ts";
import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";
import { OTHER_EMAIL, OTHER_TEAM, TIMEZONE, WEEK, at, runningWeek, seedSearches, type When } from "../scripts/schema/work-seed.ts";
import {
  FIRST, answer, bucketCases, bucketsOf, canonical, count, datesCases, firstDayCases, iso, localDay, midnightOf, phase, request, show,
  spelled, whereCases, type Days, type Obj, type Query, type Route, type Who,
} from "./console-work-query-harness.ts";

const NAME = "console-work-query";
const DONE = "console-work-query: each measure by each dimension and bucket it allows answers the figures the pages draw, " +
  "over instants or dates, against the previous window and down to a group's rows, each bucket the sum of its rows, the " +
  "approvals the caller's alone, refused before anything is read and recorded as nothing: ok";
/** COUPLED: the fake answer in the console's checkout, `../zz-stack-dashboard` here and in CI. */
const FAKE = join(root, "..", "zz-stack-dashboard", "scripts", "fake-gateway", "work-query.ts");

/** The client a maintenance command names itself, and the one a person's session does. */
const MAINTENANCE = "zz-migrate";
const WORK = "zz-plugin";
const LESSON = "Close a piece of work only after the person who asked for it has read what the agents wrote for them.";
/** The lesson's words as the contracts count them: Home's words add them, and so do the query's, in a lessons group. */
const LESSON_WORDS = 21;
/** A filter value outside its dimension's vocabulary, which no refusal may echo. */
const SECRET = "quokka-ledger";
const MEASURES: Record<string, string[]> = {
  closures: ["outcome", "flow", "initiative", "period"], opened: ["flow", "period"], words: ["document", "initiative", "period"],
  approvals: ["presentation", "decision_basis", "initiative", "period"], lessons: ["kind", "period"],
  runs: ["skill", "initiative", "weekday", "hour", "period"], searches: ["found", "period"],
};
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

type Figure = { value: number | null; why: string | null };
type Win = { from: string; to: string; observedFrom: string | null; observedThrough: string | null; complete: boolean };
type Group = { key: string; label: string; value: Figure; share: number | null; previous: Figure | null };
type WQ = {
  meta: Obj; measure: string; by: string; window: Win; grain: string | null; groups: Group[];
  rest: { groups: number; value: number } | null; total: Figure; rows: { state: string; data?: { rows: Obj[]; total: number } } | null;
};
type PF = { window: Win; figure: Figure; numerator: number | null; denominator: number | null };
type Span = { from: string; to: string };
interface Built {
  query: Route; home: Route; initiatives: Route; approvals: Route;
  grainFor: (w: Span) => string;
  periodsOf: (w: Span, asOf: string, grain: string) => Promise<{ window: Win }[]>;
  closuresByWeek: (team: string, w: Span, asOf: string, grain: string) => Promise<{ window: Win; accepted: Figure; delivered: Figure; abandoned: Figure }[]>;
  observedRuns: (team: string, w: Span, asOf: string) => Promise<{ runs: number; bySkill: { skill: string; runs: number }[]; weekdayHour: number[][] }>;
  transitions: (team: string, w: Span, asOf: string) => Promise<{ initiative: string; path: string; added: number }[]>;
}

/** `n` words: a heading of two, then `tag` words, twenty to a line. */
function text(n: number, tag: string): string {
  const words = Array.from({ length: n - 2 }, (_, i) => (i === 0 ? `${tag}-start` : tag));
  const lines: string[] = [];
  for (let i = 0; i < words.length; i += 20) lines.push(words.slice(i, i + 20).join(" "));
  return `# ${tag}\n\n${lines.join("\n")}\n`;
}

/** The gateway's door to zz-core as server.ts mounts it, a PAT of the seeded person's, and the routes and figures
 *  read here, loaded once the reporting timezone is set. */
interface Gateway { url: string; token: string; built: Built; stop(): Promise<void> }

async function listen(c: Core): Promise<Gateway> {
  process.env.TEAM_DB_URL = c.url;
  process.env.ZZ_TZ = TIMEZONE;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  process.env.CORE_MCP_URL = c.mcp.url;
  const load = (p: string) => import(pathToFileURL(join(root, "services/gateway/dist", p)).href);
  const express = (await import("express")).default;
  const db = (await load("db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await db.initPlatformDb();
  const { identityMiddleware } = (await load("identity.js")) as { identityMiddleware: () => RequestHandler };
  const { toolCallTelemetry, doorSurface } = (await load("tool-telemetry.js")) as
    { toolCallTelemetry: (surface: (req: Request) => string) => RequestHandler; doorSurface: (url: string) => string };
  const { passThrough } = (await load("relay.js")) as { passThrough: (url: string, what: string, refusal: string) => RequestHandler };
  const routes = new Map<string, Route>();
  const fake = { get: (p: string, h: Route) => routes.set(p, h), post: () => undefined };
  ((await load("console/work-query.js")) as { mountWorkQuery: (app: unknown) => void }).mountWorkQuery(fake);
  ((await load("console/home.js")) as { mountHome: (app: unknown) => void }).mountHome(fake);
  ((await load("console/initiatives.js")) as { mountInitiatives: (app: unknown) => void }).mountInitiatives(fake);
  ((await load("console/approvals.js")) as { mountApprovals: (app: unknown) => void }).mountApprovals(fake);
  const route = (p: string): Route => routes.get(p) ?? c.fail("mount", `no route GET ${p}`);
  const built: Built = {
    query: route("/api/console/work/query"), home: route("/api/console/home"),
    initiatives: route("/api/console/initiatives"), approvals: route("/api/console/approvals"),
    ...(await load("console/work-figures.js")), ...(await load("console/runs-observed.js")), ...(await load("console/writing.js")),
  };

  const app = express();
  // COUPLED: services/gateway/src/server.ts — the identity gate, the JSON parser, the telemetry on the door and
  // then the door's relay to zz-core, in the order server.ts mounts them.
  app.use(identityMiddleware());
  app.use(express.json({ limit: "20mb" }));
  app.use(["/core/mcp"], toolCallTelemetry((req) => doorSurface(req.originalUrl)));
  app.all("/core/mcp", passThrough(c.mcp.url, "core proxy", "zz-core is not reachable"));
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const token = `zzp_${randomBytes(24).toString("hex")}`;
  await c.sql.query(
    `insert into zz.pat (principal_id, token_hash, team_id) select p.id, $2, null from zz.principal p where p.email = $1`,
    [c.email, createHash("sha256").update(token, "utf8").digest("hex")]);
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token, built,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.platformDb().end().catch(() => undefined);
      for (const k of ["TEAM_DB_URL", "ZZ_TZ", "ZZ_CATALOG_DIR", "CORE_MCP_URL"]) delete process.env[k];
    },
  };
}

/** Tool calls through the gateway's door as a client, counted so the rows they leave can be waited for. */
function door(c: Core, g: Gateway) {
  let sent = 0;
  const call = async (step: string, client: string, name: string, args: Obj): Promise<string> => {
    const res = await fetch(`${g.url}/core/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${g.token}`, "content-type": "application/json",
                 accept: "application/json, text/event-stream", "x-zz-client": client },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(60_000),
    });
    const raw = await res.text();
    sent++;
    const env = lastJson(raw);
    const reply = env?.result?.content?.map((p) => p.text ?? "").join("") ?? env?.error?.message ?? raw.slice(0, 300);
    if (res.status !== 200 || reply.startsWith("ERROR")) c.fail(step, `${name} as ${client} answered ${res.status}: ${reply.slice(0, 300)}`);
    return reply;
  };
  return { call, sent: () => sent };
}

/** The runs, written as zz.skill_run rows as runs-seed.ts writes them: three whose first call is in the last whole
 *  week, on a Tuesday at 10:00 and 11:00 and a Wednesday at 10:00; one begun the Sunday before it and ending in it,
 *  which counts in the week before; one of the second team's; and 24 in the third week back over 23 skills. */
async function seedRuns(c: Core, w0: number, slug: (key: string) => string): Promise<void> {
  const one = async (sql: string, args: unknown[]): Promise<string> => (await c.sql.query<{ id: string }>(sql, args)).rows[0].id;
  const version = new Map<string, string>();
  const fold = Array.from({ length: 23 }, (_, i) => `fold-${String(i + 1).padStart(2, "0")}`);
  for (const name of ["q-spec", "q-plan", ...fold]) {
    const skill = await one("insert into zz.skill (name) values ($1) returning id", [name]);
    version.set(name, await one("insert into zz.skill_version (skill_id, version, content_hash) values ($1, '1.0.0', $2) returning id",
                                [skill, createHash("sha256").update(name).digest("hex")]));
  }
  const runs: [string, string | null, string, When, When][] = [
    [c.team, "gamma", "q-spec", [1, 34], [1, 36]], [c.team, "delta", "q-plan", [1, 35], [1, 37]], [c.team, null, "q-spec", [1, 58], [1, 59]],
    [c.team, "alpha", "q-plan", [2, 166], [1, 1]], [OTHER_TEAM, null, "q-spec", [1, 40], [1, 41]],
    ...fold.map((s, i): [string, null, string, When, When] => [c.team, null, s, [3, 20 + i], [3, 20 + i]]),
    [c.team, null, "fold-23", [3, 50], [3, 50]],
  ];
  for (const [i, [team, key, skill, started, ended]] of runs.entries()) {
    await c.sql.query(
      `insert into zz.skill_run (team_id, initiative_id, skill_version_id, session, calls, bytes_total, started_at, ended_at)
       values ((select id from zz.team where slug = $1), (select id from zz.initiative where slug = $2), $3, $4, 3, 100, $5::timestamptz, $6::timestamptz)`,
      [team, key && slug(key), version.get(skill), `query-r${i}`, iso(at(w0, started)), iso(at(w0, ended))]);
  }
}

async function run(c: Core): Promise<void> {
  const g = await listen(c);
  try {
    await cases(c, g);
  } finally {
    await g.stop();
  }
}

async function cases(c: Core, g: Gateway): Promise<void> {
  const d = door(c, g);
  const f = g.built;
  const member = await c.member();
  const memberClient = c.client({ email: member });
  await c.sql.query(
    `with p as (insert into zz.principal (email, display_name, role) values ($1, 'Other', 'member') returning id),
          t as (insert into zz.team (slug, name, created_by) select $2, 'Other team', id from p returning id),
          m as (insert into zz.membership (team_id, principal_id, role, added_by) select t.id, p.id, 'admin', p.id from t, p)
     update zz.principal set active_team_id = (select id from t) where id = (select id from p)`, [OTHER_EMAIL, OTHER_TEAM]);
  const otherClient = c.client({ email: OTHER_EMAIL });
  const w0 = runningWeek(Date.now());
  const when = (w: When): number => at(w0, w);
  const S = new Map<string, string>();
  const slug = (key: string): string => S.get(key) ?? c.fail("the record", `no initiative ${key}`);
  const open = async (key: string, flow?: string) => { S.set(key, await c.open(`query-${key}`, flow)); };
  let step = "the record made";
  const write = (client: string, key: string, path: string, n: number) =>
    d.call(step, client, "document_write", { path: `${slug(key)}/${path}`, content: text(n, key) });
  const closeOne = (key: string, args: Obj = { disposition: "abandoned" }) => c.ok(step, "initiative_close", { initiative: slug(key), ...args });

  // The record, a week and an hour a phase: weeks back from the running one, hours into the week.
  await phase(c, d, when([3, 2]), async () => { await open("alpha"); await open("epsilon", "sdlc-flow"); await write(WORK, "alpha", "notes.md", 300); });
  await phase(c, d, when([2, 34]), async () => { await open("beta"); await write(WORK, "beta", "notes.md", 200); await c.sign(`${slug("alpha")}/notes.md`); });
  await phase(c, d, when([2, 50]), () => closeOne("epsilon"));
  let theirs = "";
  await phase(c, d, when([1, 10]), async () => {
    await open("gamma"); await open("delta"); await open("zeta", "sdlc-flow");
    await write(WORK, "gamma", "notes.md", 500);
    await write(WORK, "delta", "notes.md", 100);
    await d.call(step, WORK, "knowledge_add", { title: "Close after reading", type: "decision", scope: "team", evidence: [slug("gamma")], body: LESSON });
    // The second team's work in the same week, which no answer of the first team's may show.
    theirs = (JSON.parse(await c.ok(step, "initiative_open", { slug: "other-work" }, otherClient)) as { initiative: string }).initiative;
    await c.ok(step, "initiative_close", { initiative: theirs, disposition: "abandoned" }, otherClient);
  });
  await phase(c, d, when([1, 34]), async () => {
    await c.ok(step, "document_present", { path: `${slug("beta")}/notes.md` });
    await c.ok(step, "document_approve", { path: `${slug("beta")}/notes.md`, decision_basis: "explicit" });
    await c.sign(`${slug("gamma")}/notes.md`);
  });
  // A maintenance client's day: an import-made document and a lesson it carried; and the member's own approval.
  await phase(c, d, when([1, 82]), async () => {
    await write(MAINTENANCE, "gamma", "imported.md", 1000);
    await d.call(step, MAINTENANCE, "knowledge_add", { title: "Carried lesson", type: "knowledge", scope: "team",
      evidence: [slug("gamma")], body: Array(40).fill("carried").join(" ") });
    await c.ok(step, "document_present", { path: `${slug("gamma")}/imported.md` }, memberClient);
    await c.ok(step, "document_approve", { path: `${slug("gamma")}/imported.md` }, memberClient);
  });
  await phase(c, d, when([1, 106]), async () => {
    await closeOne("alpha", { disposition: "finished", document: "notes.md" });
    await closeOne("delta", { disposition: "finished", document: "notes.md", no_signoff_reason: "the person who asked for it moved on" });
    await closeOne("beta", { disposition: "abandoned", document: "notes.md" });
    await closeOne("zeta");
  });
  await seedSearches(c.sql, c.team, OTHER_TEAM, w0);
  await seedRuns(c, w0, slug);

  const OWNER: Who = { email: c.email, team: c.team };
  const MEMBER: Who = { email: member, team: c.team };
  const ask = async (s: string, query: Query, who: Who = OWNER): Promise<WQ> => {
    const a = await answer(f.query, request(who, query));
    if (a.status !== 200) c.fail(s, `?${spelled(query)} answered ${a.status}: ${show(a.body)}`);
    return a.body as unknown as WQ;
  };
  const read = async (s: string, route: Route, query: Record<string, string> = {}, who: Who = OWNER): Promise<Obj> => {
    const a = await answer(route, request(who, query));
    if (a.status !== 200) c.fail(s, `a page answered ${a.status}: ${show(a.body)}`);
    return a.body;
  };
  const same = (s: string, found: unknown, expected: unknown): void => {
    if (JSON.stringify(canonical(found)) !== JSON.stringify(canonical(expected))) c.fail(s, `found ${show(found)}, expected ${show(expected)}`);
  };
  const values = (w: WQ): Record<string, number | null> => Object.fromEntries(w.groups.map((x) => [x.key, x.value.value]));
  const previous = (w: WQ): Record<string, number | null> => Object.fromEntries(w.groups.map((x) => [x.key, x.previous?.value ?? null]));
  const range = (from: number, to: number): Record<string, string> => ({ from: iso(from), to: iso(to) });

  // The last whole week, and the record from its first week through a week past the cutoff.
  const W1 = iso(w0 - WEEK);
  const lastWeek: Span = { from: W1, to: iso(w0) };
  const RECORD = range(w0 - 4 * WEEK, w0 + WEEK);
  const home = await read("Home", f.home);
  const asOf = String((home.meta as Obj).asOf);

  step = "each measure by each dimension it allows, over the last whole week, sums to its total";
  const EXPECTED: Record<string, Record<string, Record<string, number>>> = {
    closures: { outcome: { abandoned: 2, accepted: 1, delivered: 1 }, flow: { none: 3, "sdlc-flow": 1 },
                initiative: Object.fromEntries(["alpha", "beta", "delta", "zeta"].map((k) => [slug(k), 1])), period: { [W1]: 4 } },
    opened: { flow: { none: 2, "sdlc-flow": 1 }, period: { [W1]: 3 } },
    words: { document: { [`${slug("gamma")}/notes.md`]: 500, [`${slug("delta")}/notes.md`]: 100, lessons: LESSON_WORDS },
             initiative: { [slug("gamma")]: 500, [slug("delta")]: 100, lessons: LESSON_WORDS }, period: { [W1]: 600 + LESSON_WORDS } },
    approvals: { presentation: { agent_context_covered: 2 }, decision_basis: { explicit_recorded: 1, unknown: 1 },
                 initiative: { [slug("beta")]: 1, [slug("gamma")]: 1 }, period: { [W1]: 2 } },
    lessons: { kind: { decision: 1 }, period: { [W1]: 1 } },
    runs: { skill: { "q-spec": 2, "q-plan": 1 }, initiative: { [slug("gamma")]: 1, [slug("delta")]: 1, none: 1 },
            weekday: { Tuesday: 2, Wednesday: 1 }, hour: { 10: 2, 11: 1 }, period: { [W1]: 3 } },
    searches: { found: { found: 2, none: 1 }, period: { [W1]: 3 } },
  };
  const week: Record<string, Record<string, WQ>> = {};
  for (const [measure, dims] of Object.entries(MEASURES)) {
    week[measure] = {};
    for (const by of dims) {
      const w = week[measure][by] = await ask(step, { measure, by });
      const s = `${step}: ${measure} by ${by}`;
      same(s, values(w), EXPECTED[measure][by]);
      const total = Object.values(EXPECTED[measure][by]).reduce((n, v) => n + v, 0);
      same(s, [w.measure, w.by, w.total, w.rest, w.rows, w.grain, w.window.from, w.window.to, w.window.complete],
        [measure, by, { value: total, why: null }, null, null, by === "period" ? "week" : null, W1, iso(w0), true]);
      if (w.groups.some((x) => x.share !== (x.value.value ?? 0) / total || x.previous !== null)) c.fail(s, show(w.groups));
      if ((w.meta.scope === "caller-in-active-team") !== (measure === "approvals")) c.fail(s, `scope ${String(w.meta.scope)}`);
    }
  }
  c.pass(`${step}: 22 questions, the import-made document, the carried lesson and the second team's work in none of them`);

  step = "the values are the figures the pages draw for the same window and filters";
  const tiles = home.tiles as Record<string, PF>;
  const homeWeek = (part: string): number | null =>
    (((home[part] as Obj).data as Obj).weeks as PF[]).find((p) => p.window.from === W1)?.figure.value ?? null;
  same(`${step}: Home`, [tiles.closed.figure.value, tiles.searchesWithResults.numerator, tiles.searchesWithResults.denominator,
    homeWeek("approvals"), homeWeek("words")], [week.closures.outcome.total.value, week.searches.found.groups.find((x) => x.key === "found")?.value.value,
    week.searches.found.total.value, week.approvals.period.total.value, week.words.period.total.value]);
  const theirHome = await read(step, f.home, {}, MEMBER);
  same(`${step}: Home's approvals for the member`, ((theirHome.approvals as Obj).data as { weeks: PF[] }).weeks.find((p) => p.window.from === W1)?.figure.value,
    (await ask(step, { measure: "approvals", by: "period" }, MEMBER)).total.value);
  const observed = await f.observedRuns(c.team, lastWeek, asOf);
  same(`${step}: observed runs`, [observed.runs, Object.fromEntries(observed.bySkill.map((x) => [x.skill, x.runs])),
    Object.fromEntries(observed.weekdayHour.map((h, i) => [WEEKDAYS[i], h.reduce((n, x) => n + x, 0)]).filter(([, n]) => n))],
    [week.runs.skill.total.value, values(week.runs.skill), values(week.runs.weekday)]);
  const ledger = new Map<string, number>();
  for (const t of await f.transitions(c.team, lastWeek, asOf)) ledger.set(`${t.initiative}/${t.path}`, (ledger.get(`${t.initiative}/${t.path}`) ?? 0) + t.added);
  same(`${step}: the writing ledger`, Object.fromEntries(ledger), Object.fromEntries(Object.entries(values(week.words.document)).filter(([k]) => k !== "lessons")));
  const history = ((await read(step, f.approvals, { tab: "history" })).history as Obj).data as { total: number; summary: Record<string, Record<string, number>> };
  const nonzero = (r: Record<string, number>) => Object.fromEntries(Object.entries(r).filter(([, n]) => n));
  same(`${step}: Approvals' history`, [history.total, nonzero(history.summary.byPresentation), nonzero(history.summary.byDecisionBasis)],
    [(await ask(step, { measure: "approvals", by: "period", ...RECORD })).total.value,
     values(await ask(step, { measure: "approvals", by: "presentation", ...RECORD })), values(await ask(step, { measure: "approvals", by: "decision_basis", ...RECORD }))]);
  for (const filter of [{ flow: "sdlc-flow" }, { q: "ALPHA " }, { state: "abandoned" }, { state: "open" }] as Record<string, string>[]) {
    const s = `${step}: Initiatives under ${show(filter)}`;
    const list = await read(s, f.initiatives, { ...filter, limit: "100" });
    const summary = (list.summary as Obj).data as { byState: Record<string, number>; byFlow: { flow: string | null; count: number }[] };
    const outcomes = Object.fromEntries(["accepted", "delivered", "abandoned"].map((o) => [o, summary.byState[o]]).filter(([, n]) => n));
    same(s, values(await ask(s, { measure: "closures", by: "outcome", ...RECORD, ...filter })), outcomes);
    same(s, (await ask(s, { measure: "opened", by: "period", ...RECORD, ...filter })).total.value, list.total);
    if (filter.state === "abandoned") {
      same(s, values(await ask(s, { measure: "closures", by: "flow", ...RECORD, ...filter })),
        Object.fromEntries(summary.byFlow.map((x) => [x.flow ?? "none", x.count])));
    }
  }
  c.pass(step);

  step = "the 20 largest groups are answered and the rest folded";
  const folded = await ask(step, { measure: "runs", by: "skill", ...range(w0 - 3 * WEEK, w0 - 2 * WEEK) });
  same(step, [folded.groups.length, folded.groups[0].key, folded.groups[0].value.value, folded.groups[1].key, folded.groups[19].key, folded.rest, folded.total.value],
    [20, "fold-23", 2, "fold-01", "fold-19", { groups: 3, value: 3 }, 24]);
  c.pass(step);

  step = "compare=previous answers each group's value in the previous window of the same length";
  const compared = await ask(step, { measure: "closures", by: "outcome", compare: "previous" });
  same(step, previous(compared), { abandoned: 1, accepted: 0, delivered: 0 });
  same(step, previous(await ask(step, { measure: "opened", by: "flow", compare: "previous" })), { none: 1, "sdlc-flow": 0 });
  same(step, previous(await ask(step, { measure: "runs", by: "skill", compare: "previous" })), { "q-spec": 0, "q-plan": 1 });
  same(step, previous(await ask(step, { measure: "closures", by: "period", compare: "previous" })), { [W1]: 1 });
  const before = values(await ask(step, { measure: "closures", by: "outcome", ...range(w0 - 2 * WEEK, w0 - WEEK) }));
  for (const x of compared.groups) if ((before[x.key] ?? 0) !== x.previous?.value) c.fail(step, `${x.key} previous ${show(x.previous)}, asked alone ${before[x.key]}`);
  c.pass(step);

  step = "a drill pages one group's rows in a stable order, each initiative's next move zz-core's";
  const drill = async (q: Record<string, string>) => (await ask(step, { measure: "closures", by: "outcome", group: "abandoned", ...q })).rows?.data
    ?? c.fail(step, "no rows");
  const [all, first, second, again] = [await drill({}), await drill({ limit: "1" }), await drill({ limit: "1", offset: "1" }), await drill({})];
  same(step, [all.total, first.total, all.rows.map((r) => String(r.slug)).sort()], [2, 2, [slug("beta"), slug("zeta")].sort()]);
  if (all.rows[0].closed! < all.rows[1].closed!) c.fail(step, `not the newest first: ${show(all.rows)}`);
  same(step, [...first.rows, ...second.rows], all.rows);
  same(step, again, all);
  for (const r of all.rows) {
    const want = (await c.status(String(r.slug))).next_move?.action;
    if ((r.nextMove as Obj | null)?.action !== want) c.fail(step, `${String(r.slug)} reads ${show(r.nextMove)}, initiative_status ${want}`);
  }
  same(step, (await ask(step, { measure: "words", by: "initiative", group: slug("gamma") })).rows?.data,
    { rows: [{ initiative: slug("gamma"), path: "notes.md", added: 500 }], total: 1 });
  // A lesson is no document: its words are drilled to as a row with neither initiative nor path.
  same(step, (await ask(step, { measure: "words", by: "document", group: "lessons" })).rows?.data,
    { rows: [{ initiative: null, path: null, added: LESSON_WORDS }], total: 1 });
  c.pass(step);

  step = "a month-long and a year-long window answer the grain grainFor chooses, by its periods";
  for (const [span, wantGrain, weekly] of [[range(w0 - 4 * WEEK, w0), "week", [0, 0, 1, 4]], [range(w0 - 52 * WEEK, w0), "month", null]] as [Span, string, number[] | null][]) {
    const w = await ask(step, { measure: "closures", by: "period", ...span });
    const closures = await f.closuresByWeek(c.team, span, asOf, wantGrain);
    const perPeriod = closures.map((p) => (p.accepted.value ?? 0) + (p.delivered.value ?? 0) + (p.abandoned.value ?? 0));
    if (weekly) same(step, perPeriod, weekly);
    same(step, [w.grain, f.grainFor(span), w.groups.map((x) => x.key), w.groups.map((x) => x.value.value), w.total.value],
      [wantGrain, wantGrain, (await f.periodsOf(span, asOf, wantGrain)).map((p) => p.window.from), weekly ?? perPeriod, 5]);
  }
  c.pass(step);

  const k = { c, ask: (s: string, q: Query) => ask(s, q) };
  // The record's four weeks, Monday to Sunday, as inclusive dates.
  const DAYS: Days = { from: localDay(w0 - 4 * WEEK), to: localDay(w0 - 1) };
  const keyed = (w: WQ): [string, number | null][] => w.groups.map((x) => [x.key, x.value.value]);

  step = "a window of dates answers what the instants of its days' start and the next day's start answer";
  c.pass(`${step}: ${await datesCases(k, step, MEASURES, DAYS)} questions, every measure by every dimension and bucket`);

  step = "day, week, month and weekday answer every bucket in order, each the sum of the rows its drill answers";
  const buckets = await bucketCases(k, step, MEASURES, DAYS);
  same(step, [keyed(await ask(step, { measure: "closures", by: "week", ...DAYS })), (await ask(step, { measure: "words", by: "day", ...DAYS, top: "1" })).groups],
    [[0, 1, 2, 3].map((b) => [localDay(w0 - (4 - b) * WEEK), [0, 0, 1, 4][b]]), [{ key: DAYS.to, label: DAYS.to, value: { value: 0, why: null }, share: 0, previous: null }]]);
  // runs' weekday is its own dimension, as it was before the buckets: the weekdays it ran on, the most runs first.
  same(step, [(await ask(step, { measure: "runs", by: "weekday", ...DAYS })).grain, keyed(await ask(step, { measure: "runs", by: "weekday" }))],
    [null, [["Tuesday", 2], ["Wednesday", 1]]]);
  c.pass(`${step}: ${buckets} buckets drilled; closures by week 0, 0, 1 and 4; runs' weekday still its dimension`);

  step = "top keeps the latest buckets and the largest groups, folding the rest; period keeps every period";
  const daily = await ask(step, { measure: "runs", by: "day", ...DAYS });
  same(step, [daily.groups.map((x) => x.key), daily.rest, daily.total.value], [bucketsOf("day", DAYS).slice(8), { groups: 8, value: 4 }, 28]);
  const largest = await ask(step, { measure: "closures", by: "outcome", top: "1" });
  same(step, [keyed(largest), largest.rest], [[["abandoned", 2]], { groups: 2, value: 2 }]);
  const yearly = await ask(step, { measure: "closures", by: "period", ...range(w0 - 52 * WEEK, w0) });
  same(step, [yearly.grain, yearly.rest, yearly.groups.length > 12], ["month", null, true]);
  c.pass(`${step}: 20 of 28 days with 4 runs folded, 1 of 3 outcomes, 13 months none folded`);

  step = "where filters on the measure's own dimensions, equality alone, at most four";
  const filters = await whereCases(k, step, MEASURES, DAYS);
  same(step, [keyed(await ask(step, { measure: "runs", by: "skill", where: "weekday=Tuesday" })),
    keyed(await ask(step, { measure: "runs", by: "skill", where: ["weekday=Tuesday", "hour=10"] }))], [[["q-plan", 1], ["q-spec", 1]], [["q-spec", 1]]]);
  c.pass(`${step}: ${filters} filters, each its group's total; runs on a Tuesday, and at 10:00 on one`);

  step = "from=0001-01-01 answers from the first day the record holds";
  const held = await firstDayCases(k, step, MEASURES, DAYS.to);
  same(step, [(await ask(step, { measure: "closures", by: "outcome", from: FIRST, to: DAYS.to })).window.from,
    (await ask(step, { measure: "opened", by: "flow", from: FIRST, to: DAYS.to })).window.from],
    [iso(midnightOf(localDay(when([2, 50])))), iso(midnightOf(localDay(when([3, 2]))))]);
  c.pass(`${step}: ${held} measures, closures from the first close and opened from the first opening`);

  step = "approvals are the caller's alone";
  const theirs1 = await ask(step, { measure: "approvals", by: "initiative", group: slug("gamma") }, MEMBER);
  const mine = await ask(step, { measure: "approvals", by: "initiative", group: slug("gamma") });
  same(step, [values(theirs1), theirs1.rows?.data?.rows.map((r) => r.path), mine.rows?.data?.rows.map((r) => r.path)],
    [{ [slug("gamma")]: 1 }, ["imported.md"], ["notes.md"]]);
  c.pass(step);

  step = "a second team's records change no answer, and naming another team or the platform widens nothing";
  for (const [measure, by] of [["closures", "outcome"], ["runs", "skill"], ["searches", "found"]]) {
    const widened = await ask(step, { measure, by, team: OTHER_TEAM, scope: "platform" }, MEMBER);
    same(step, values(widened), values(week[measure][by]));
  }
  same(step, values(await ask(step, { measure: "closures", by: "initiative" }, { email: OTHER_EMAIL, team: OTHER_TEAM })), { [theirs]: 1 });
  const everything = JSON.stringify(week);
  if (everything.includes(OTHER_TEAM) || everything.includes(theirs)) c.fail(step, "an answer names the second team's work");
  c.pass(step);

  step = "reading it records no event";
  const events = await count(c, "true");
  for (const [measure, dims] of Object.entries(MEASURES)) {
    const w = await ask(step, { measure, by: dims[0], compare: "previous" });
    if (w.groups.length) await ask(step, { measure, by: dims[0], group: w.groups[0].key });
  }
  await new Promise((r) => setTimeout(r, 1500));
  if (await count(c, "true") !== events) c.fail(step, `${(await count(c, "true")) - events} events were recorded by reading the queries`);
  c.pass(step);

  step = "what it cannot answer is refused with the allowed values, before anything is read";
  await c.sql.query("alter table zz.team rename to team_hidden");
  try {
    for (const [query, says] of [
      [{ measure: "bytes", by: "period" }, "closures, opened, words, approvals, lessons, runs, searches"],
      [{ measure: "words", by: "skill" }, "document, initiative, period"],
      [{ measure: "runs", by: "nothing" }, "skill, initiative, weekday, hour, period"],
      [{ measure: "closures", by: "outcome", compare: "next" }, "previous"],
      [{ measure: "closures", by: "outcome", state: "stale" }, "open, waiting, quiet"],
      [{ measure: "closures", by: "outcome", limit: "101" }, "1 to 100"],
      [{ measure: "closures", by: "outcome", from: iso(w0), to: iso(w0 - WEEK) }, "from before to"],
      [{ measure: "closures", by: "outcome", from: iso(w0 + WEEK) }, "from before to"],
      [{ measure: "closures", by: "outcome", from: "2026-02-30", to: DAYS.to }, "from before to"],
      [{ measure: "closures", by: "outcome", from: DAYS.from, to: iso(w0) }, "both dates or both instants"],
      [{ measure: "closures", by: "outcome", from: FIRST, to: iso(w0) }, "both dates or both instants"],
      [{ measure: "closures", by: "quarter" }, "outcome, flow, initiative, period, day, week, month, weekday"],
      [{ measure: "closures", by: "outcome", where: "skill=q-spec" }, "closures is filtered by one of outcome, flow, initiative"],
      [{ measure: "closures", by: "outcome", where: "period=x" }, "closures is filtered by one of outcome, flow, initiative"],
      [{ measure: "closures", by: "outcome", where: `outcome=${SECRET}` }, "a filter on outcome takes one of delivered, accepted, abandoned"],
      [{ measure: "runs", by: "skill", where: `hour=${SECRET}` }, "a filter on hour takes one of 00, 01"],
      [{ measure: "closures", by: "outcome", where: ["flow=a", "flow=b", "flow=c", "flow=d", "flow=e"] }, "at most 4 filters"],
      [{ measure: "closures", by: "outcome", where: "flow" }, "a dimension, an equals sign and a value"],
      [{ measure: "closures", by: "outcome", top: "51" }, "1 to 50"],
      [{ measure: "closures", by: "outcome", top: "0" }, "1 to 50"],
      [{ measure: "closures", by: "period", top: "5" }, "so it takes no top"],
      [{ measure: "closures", by: "outcome", rows: "21" }, "1 to 20"],
      [{ measure: "closures", by: "outcome", rows: "5", group: "abandoned" }, "given without group, limit or offset"],
    ] as [Query, string][]) {
      const a = await answer(f.query, request(OWNER, query));
      if (a.status !== 400 || !String(a.body.error).includes(says) || show(a.body).includes(SECRET)) {
        c.fail(step, `${show(query)} answered ${a.status}: ${show(a.body)}`);
      }
    }
  } finally {
    await c.sql.query("alter table zz.team_hidden rename to team");
  }
  const none = await answer(f.query, request({ email: c.email, team: null }, { measure: "closures", by: "outcome" }));
  if (none.status !== 400) c.fail(step, `a person in no team was answered ${none.status}`);
  c.pass(step);

  step = "a read that fails makes the total and the groups unavailable and says so";
  await c.sql.query("alter table zz.skill_run rename to skill_run_hidden");
  const failed = await ask(step, { measure: "runs", by: "skill", group: "q-spec" })
    .finally(() => c.sql.query("alter table zz.skill_run_hidden rename to skill_run"));
  same(step, [failed.total, failed.groups, failed.rest, failed.rows], [{ value: null, why: "unavailable" }, [], null, { state: "unavailable", reason: "query_failed" }]);
  c.pass(step);

  step = "the key sets match the console's fake answer";
  let fake: { workQuery: (who: unknown, q: URLSearchParams) => [number, unknown] };
  try {
    fake = (await import(pathToFileURL(FAKE).href)) as typeof fake;
  } catch (err) {
    return c.fail(step, `could not read the console's fake answer at ${FAKE}: ${(err as Error).message}`);
  }
  const ava = { activeTeam: "atlas", email: "ava.lindqvist@example.com" };
  const year = { from: new Date(Date.now() - 365 * 24 * 3_600_000).toISOString(), to: new Date().toISOString() };
  for (const [measure, dims] of Object.entries(MEASURES)) {
    const [, broad] = fake.workQuery(ava, new URLSearchParams({ measure, by: dims[0], ...year, compare: "previous" })) as [number, WQ];
    const group = broad.groups[0]?.key ?? c.fail(step, `the fake answers no ${measure}`);
    const [, theirsFake] = fake.workQuery(ava, new URLSearchParams({ measure, by: dims[0], ...year, compare: "previous", group }));
    const ours = await ask(step, { measure, by: dims[0], compare: "previous", group: week[measure][dims[0]].groups[0].key });
    if (!ours.rows?.data?.rows.length) c.fail(step, `${measure} drilled no rows to compare`);
    const diffs = shapeDiffs(ours, theirsFake, "", []);
    if (diffs.length) c.fail(step, `${measure}: ${diffs.join("; ")}`);
  }
  c.pass(step);
}

process.exitCode = await withThrowawayCore(NAME, DONE, run);
