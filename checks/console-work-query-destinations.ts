#!/usr/bin/env node
/**
 * checks/console-work-query-destinations.ts — the agent's prepared queries reach Knowledge, Activity, Runs and the
 * team's use of plugins, and answer the figures those pages draw (AC-6.2, AC-6.3, AC-6.4, AC-6.5).
 *
 *   node checks/console-work-query-destinations.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL and a real zz-core on it (`withThrowawayCore`), and the gateway's own built door in
 * this process, as `checks/console-work-activity.ts` does, so a call a person's session (`zz-plugin`) or a maintenance
 * client (`zz-migrate`) makes through it is recorded and its refusal owned as the gateway records it. The lessons and
 * the searches are made through zz-core's own tools, an imported lesson by the maintenance client; the refusals the
 * door cannot be made to give, the runs and the calls of a plugin's skills are written as rows, as their seeds write
 * them. Each phase is moved, together and by one interval, into the week and hour it names; a second team's work and a
 * maintenance client's lie in the same weeks. It calls the gateway's own built routes the way Express would, as a
 * console session. What it establishes, with the expected values written below:
 *
 *   - calls by tool, initiative, refused or period, and refusals by owner, tool, initiative or period, over the last
 *     whole week, the four owners always answered and summing to the total; they equal Activity's tiles, its weeks,
 *     its most refused tool and its log's totals under the same filters, and a drilled call is the log's row;
 *   - output by skill, initiative or period sums the observed bytes, the runs that measured none counted beside it
 *     and a group that measured nothing no_data; it equals Runs' rows, and a drilled run is Runs' row;
 *   - skill_calls by plugin, skill or period counts the team's real-work calls of each plugin's skills, a maintenance
 *     client's call of one left out, equal to Plugins' team figures, and is not drilled;
 *   - shelf by kind or standing is the team's shelf as of the window's end, standing and superseded with the imported
 *     beside, equal to Knowledge's tiles at the cutoff; period is not its dimension and compare=previous answers
 *     previous null; a drilled lesson is the list's row;
 *   - searches drills the group that found nothing to its questions, normalised as Knowledge lists them, the team's
 *     own; the second team's question and its refusal message are in no answer;
 *   - compare=previous answers each group's value in the previous window, and the groups with any folded rest sum to
 *     the total in every answer;
 *   - over five weeks as dates, every measure answers `checks/console-work-query-harness.ts`'s cases: dates as their
 *     days' instants, every bucket in order and each the sum of its drilled rows but skill_calls', rows newest first,
 *     where as its group's total, and from=0001-01-01 from the record's first day; calls, refusals, output and
 *     skill_calls by week are the record's;
 *   - a dimension a measure does not allow, a bucket of the shelf, a filter it does not take, or a drill or rows of
 *     skill_calls, is refused with 400 before anything is read, never echoing a value sent;
 *     reading records no event; another team's records and maintenance change no answer; the key sets match the fake's.
 *
 * DELIBERATE: the reporting timezone is Asia/Singapore, eight hours ahead of UTC, and nothing is placed in the running
 * week, so the expected values do not depend on the day the check runs.
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
import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";
import { OTHER_EMAIL, OTHER_TEAM, TIMEZONE, WEEK, at, runningWeek, type When } from "../scripts/schema/work-seed.ts";
import {
  FIRST, answer, bucketCases, canonical, count, datesCases, firstDayCases, iso, localDay, midnightOf, phase, request, shapeDiffs, show,
  spelled, whereCases, type Days, type Obj, type Query, type Route, type Who,
} from "./console-work-query-harness.ts";

const NAME = "console-work-query-destinations";
const DONE = "console-work-query-destinations: calls, refusals, output, the calls of each plugin's skills and the shelf, " +
  "and the questions that found nothing, answer the figures Activity, Runs, Plugins and Knowledge draw, over instants or " +
  "dates and by every bucket, each bucket the sum of its rows, the team's own alone: ok";
/** COUPLED: the fake answer in the console's checkout, `../zz-stack-dashboard` here and in CI. */
const FAKE = join(root, "..", "zz-stack-dashboard", "scripts", "fake-gateway", "work-query.ts");

const WORK = "zz-plugin";
const MAINTENANCE = "zz-migrate";
const STATUS = "core:initiative_status";
/** The second team's refusal and question: no answer to the first team may hold either. */
const SENTINEL = "ERROR: the beacon ledger is locked by the chargeback review";
const THEIRS = "xyzzy frumious bandersnatch";
const MEASURES: Record<string, string[]> = {
  calls: ["tool", "initiative", "refused", "period"], refusals: ["owner", "tool", "initiative", "period"],
  output: ["skill", "initiative", "period"], skill_calls: ["plugin", "skill", "period"], shelf: ["kind", "standing"],
};

type Counted = { value: number | null; why: string | null; unmeasured?: number; imported?: number };
type Group = { key: string; label: string; value: Counted; share: number | null; previous: Counted | null };
type WQ = {
  meta: Obj; measure: string; by: string; window: { from: string; to: string }; grain: string | null; groups: Group[];
  rest: { groups: number; value: number } | null; total: Counted; rows: { state: string; data?: { rows: Obj[]; total: number } } | null;
};

/** A PAT of the person's, acting for their active team. */
async function patOf(c: Core, email: string): Promise<string> {
  const token = `zzp_${randomBytes(24).toString("hex")}`;
  await c.sql.query(
    "insert into zz.pat (principal_id, token_hash, team_id) select p.id, $2, null from zz.principal p where p.email = $1",
    [email, createHash("sha256").update(token, "utf8").digest("hex")]);
  return token;
}

interface Gateway {
  url: string; mine: string; theirs: string; routes: Map<string, Route>;
  refusalWeeks: (team: string, w: { from: string; to: string }, asOf: string, grain: string) => Promise<{ periods: Obj[] }>;
  stop(): Promise<void>;
}

/** The gateway's door to zz-core as server.ts mounts it, a PAT for each team's person, and the routes read here, loaded
 *  once the reporting timezone, the catalog and the skills are set. */
async function listen(c: Core): Promise<Gateway> {
  process.env.TEAM_DB_URL = c.url;
  process.env.ZZ_TZ = TIMEZONE;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  process.env.ZZ_SKILLS_DIR = join(root, "skills");
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
  const fake = { get: (p: string, h: Route) => routes.set(p, h), post: () => undefined, delete: () => undefined };
  for (const [file, mount] of [["work-query", "mountWorkQuery"], ["activity", "mountActivity"], ["knowledge-summary", "mountKnowledgeSummary"],
    ["knowledge", "mountKnowledge"], ["runs", "mountRuns"], ["catalog", "mountCatalog"]]) {
    ((await load(`console/${file}.js`)) as Record<string, (app: unknown) => void>)[mount](fake);
  }

  const app = express();
  // COUPLED: services/gateway/src/server.ts — the identity gate, the JSON parser, the telemetry on the door and
  // then the door's relay to zz-core, in the order server.ts mounts them.
  app.use(identityMiddleware());
  app.use(express.json({ limit: "20mb" }));
  app.use(["/core/mcp"], toolCallTelemetry((req) => doorSurface(req.originalUrl)));
  app.all("/core/mcp", passThrough(c.mcp.url, "core proxy", "zz-core is not reachable"));
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    mine: await patOf(c, c.email), theirs: await patOf(c, OTHER_EMAIL), routes,
    refusalWeeks: ((await load("console/refusals.js")) as Pick<Gateway, "refusalWeeks">).refusalWeeks,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.platformDb().end().catch(() => undefined);
      for (const k of ["TEAM_DB_URL", "ZZ_TZ", "ZZ_CATALOG_DIR", "ZZ_SKILLS_DIR", "CORE_MCP_URL"]) delete process.env[k];
    },
  };
}

/** Tool calls through the gateway's door, each expected to be answered or refused, counted so the rows they leave can
 *  be waited for. */
function door(c: Core, g: Gateway) {
  let sent = 0;
  const send = async (step: string, token: string, client: string, name: string, args: Obj, refused = false): Promise<void> => {
    const res = await fetch(`${g.url}/core/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json",
                 accept: "application/json, text/event-stream", "x-zz-client": client },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(60_000),
    });
    const raw = await res.text();
    sent++;
    const env = lastJson(raw);
    const reply = env?.result?.content?.map((p) => p.text ?? "").join("") ?? env?.error?.message ?? raw.slice(0, 300);
    const wasRefused = Boolean(env?.error) || Boolean((env?.result as { isError?: boolean } | undefined)?.isError) || reply.startsWith("ERROR");
    if (res.status !== 200 || wasRefused !== refused) c.fail(step, `${name} as ${client} answered ${res.status}, ${wasRefused ? "refused" : "not refused"}: ${reply.slice(0, 300)}`);
  };
  return { send, sent: () => sent };
}

/** The rows the door cannot be made to give, as their seeds write them: tool calls (a skill's among them), and runs. */
async function seedRows(c: Core, w0: number, alpha: string): Promise<void> {
  const one = async (sql: string, args: unknown[]): Promise<string> => (await c.sql.query<{ id: string }>(sql, args)).rows[0].id;
  const version = new Map<string, string>();
  for (const name of ["sdlc-spec", "zz-platform", "q-spec", "q-plan"]) {
    const skill = await one("insert into zz.skill (name) values ($1) returning id", [name]);
    version.set(name, await one("insert into zz.skill_version (skill_id, version, content_hash) values ($1, '1.0.0', $2) returning id",
                                [skill, createHash("sha256").update(name).digest("hex")]));
  }
  // [team, when, tool, ok, owner, message, initiative, skill]
  const calls: [string, When, string, boolean, string | null, string | null, string | null, string | null][] = [
    [c.team, [1, 60], "core:knowledge_search", false, "theirs", "upstream answered status 502: Bad Gateway", alpha, null],
    [c.team, [1, 61], "core:document_read", false, null, null, null, null],
    [c.team, [1, 62], "core:document_write", true, null, null, alpha, null],
    [OTHER_TEAM, [1, 63], "core:bug_report", false, "guardrail", SENTINEL, null, null],
    [c.team, [2, 30], STATUS, false, "guardrail", "ERROR: an older refusal", null, null],
    [c.team, [2, 31], "core:session_whoami", true, null, null, null, null],
    // The calls of a plugin's skills, three weeks back: sdlc-spec is sdlc's, zz-platform zz-core's, q-spec no plugin's.
    ...[20, 21, 22].map((h): [string, When, string, boolean, null, null, null, string] => [c.team, [3, h], "core:document_read", h !== 22, null, null, null, "sdlc-spec"]),
    [c.team, [3, 30], "core:skill_read", true, null, null, null, "zz-platform"], [c.team, [3, 31], "core:skill_read", true, null, null, null, "zz-platform"],
    [c.team, [3, 32], "core:skill_read", true, null, null, null, "q-spec"], [c.team, [4, 20], "core:document_read", true, null, null, null, "sdlc-spec"],
    ...[25, 26, 27, 28].map((h): [string, When, string, boolean, null, null, null, string] => [OTHER_TEAM, [3, h], "core:document_read", true, null, null, null, "sdlc-spec"]),
  ];
  for (const [team, when, tool, ok, owner, message, initiative, skill] of calls) {
    await c.sql.query(
      `insert into zz.event (ts, kind, subject, ok, tool_key, refusal, refusal_owner, origin, team_id, initiative_id, skill_version_id)
       select $2::timestamptz, 'tool_call', $3, $4, $3, $5, $6, 'work', t.id, (select i.id from zz.initiative i where i.team_id = t.id and i.slug = $7), $8
         from zz.team t where t.slug = $1`,
      [team, iso(at(w0, when)), tool, ok, message, owner, initiative, skill && version.get(skill)]);
  }
  // A maintenance client's call carrying the team's skill version, which no use of a plugin counts.
  await c.sql.query(
    `insert into zz.event (ts, kind, subject, ok, tool_key, origin, team_id, skill_version_id)
     select $2::timestamptz, 'tool_call', 'core:document_read', true, 'core:document_read', 'platform', t.id, $3 from zz.team t where t.slug = $1`,
    [c.team, iso(at(w0, [3, 23])), version.get("sdlc-spec")]);
  // [team, initiative, skill, first call, last call, calls, refusals, bytes]
  const runs: [string, string | null, string, When, When, number, number, number | null][] = [
    [c.team, alpha, "q-spec", [1, 34], [1, 36], 3, 1, 1000], [c.team, null, "q-plan", [1, 35], [1, 37], 4, 0, 3000],
    [c.team, null, "q-spec", [1, 58], [1, 58], 1, 0, null], [c.team, null, "q-spec", [2, 40], [2, 41], 2, 0, 500],
    [OTHER_TEAM, null, "q-spec", [1, 40], [1, 41], 5, 0, 900_000],
  ];
  for (const [i, [team, initiative, skill, first, last, n, refused, bytes]] of runs.entries()) {
    await c.sql.query(
      `insert into zz.skill_run (team_id, initiative_id, skill_version_id, session, calls, refusals, bytes_total, started_at, ended_at)
       values ((select id from zz.team where slug = $1), (select id from zz.initiative where slug = $2), $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz)`,
      [team, initiative, version.get(skill), `dest-r${i}`, n, refused, bytes, iso(at(w0, first)), iso(at(w0, last))]);
  }
}

async function run(c: Core): Promise<void> {
  await c.sql.query(
    `with p as (insert into zz.principal (email, display_name, role) values ($1, 'Other', 'member') returning id),
          t as (insert into zz.team (slug, name, created_by) select $2, 'Other team', id from p returning id),
          m as (insert into zz.membership (team_id, principal_id, role, added_by) select t.id, p.id, 'admin', p.id from t, p)
     update zz.principal set active_team_id = (select id from t) where id = (select id from p)`, [OTHER_EMAIL, OTHER_TEAM]);
  const g = await listen(c);
  try {
    await cases(c, g);
  } finally {
    await g.stop();
  }
}

async function cases(c: Core, g: Gateway): Promise<void> {
  const d = door(c, g);
  const w0 = runningWeek(Date.now());
  const when = (w: When): number => at(w0, w);
  const maintenance = c.client({ client: MAINTENANCE });
  const other = c.client({ email: OTHER_EMAIL });
  let step = "the record made";
  const mine = (client: string, name: string, args: Obj, refused = false) => d.send(step, g.mine, client, name, args, refused);
  const search = async (query: string, finds: boolean, via?: ReturnType<Core["client"]>) => {
    const reply = JSON.parse(await c.ok(step, "knowledge_search", { query }, via)) as { returned: number };
    if ((reply.returned > 0) !== finds) c.fail(step, `"${query}" returned ${reply.returned}, where the seed needs ${finds ? "some" : "none"}`);
  };

  let alpha = "";
  // Three weeks back: the team's shelf, one lesson carried by a maintenance client and one superseded, and the second
  // team's own lesson.
  await phase(c, d, when([3, 10]), async () => {
    alpha = await c.open("dest-alpha");
    const add = (title: string, type: string, via?: ReturnType<Core["client"]>) =>
      c.ok(step, "knowledge_add", { title, type, body: `${title}, as the work found it.`, evidence: [alpha], scope: "team" }, via);
    await add("Quokka ledgers reconcile nightly", "decision");
    await add("Ledgers reconcile at the close of day", "decision");
    await add("Review before release", "process");
    await add("Indexes are rebuilt offline", "knowledge", maintenance);
    await c.ok(step, "knowledge_supersede", { old_id: "0001", new_id: "0002", shelf: "team" });
    const theirs = JSON.parse(await c.ok(step, "initiative_open", { slug: "dest-theirs" }, other)) as { initiative: string };
    await c.ok(step, "knowledge_add", { title: "Their private lesson", type: "process", scope: "team", evidence: [theirs.initiative],
      body: "Only the second team may read this lesson." }, other);
  });
  // The last whole week: calls answered and refused through the door, the maintenance client's and the second team's
  // beside them; and the searches, three of them finding nothing, beside a maintenance client's and the second team's.
  await phase(c, d, when([1, 20]), async () => {
    await search("Glorp VEXMORN  zibbet", false); await search("glorp vexmorn zibbet", false); await search("plindle snarf quazzle", false);
    await search("ledgers reconcile", true); await search("snorkack crumple", false, maintenance); await search(THEIRS, false, other);
  });
  await phase(c, d, when([1, 34]), async () => {
    await mine(WORK, "session_whoami", {}); await mine(WORK, "session_whoami", {});
    for (let i = 0; i < 3; i++) await mine(WORK, "initiative_status", { initiatives: [] }, true);
    await mine(WORK, "document_read", {}, true);
    await mine(MAINTENANCE, "initiative_status", { initiatives: [] }, true); await mine(MAINTENANCE, "session_whoami", {});
    await d.send(step, g.theirs, WORK, "initiative_status", { initiatives: [] }, true);
  });
  await seedRows(c, w0, alpha);
  for (const [what, where] of [["refusal message", `refusal = '${SENTINEL}'`], ["question", `subject = '${THEIRS}'`]]) {
    if (await count(c, `${where} and team_id = (select id from zz.team where slug = '${OTHER_TEAM}')`) !== 1) {
      c.fail(step, `the second team's ${what} was not recorded as its own, so its absence would prove nothing`);
    }
  }
  c.pass(`${step}: four lessons and six searches through zz-core, ten calls through the door, and the rows beside them`);

  const ME: Who = { email: c.email, team: c.team };
  const route = (p: string): Route => g.routes.get(p) ?? c.fail("mount", `no route GET ${p}`);
  const everything: string[] = [];
  const read = async (s: string, path: string, query: Query = {}, who: Who = ME): Promise<Obj> => {
    const a = await answer(route(path), request(who, query));
    everything.push(JSON.stringify(a.body));
    if (a.status !== 200) c.fail(s, `${path}?${spelled(query)} answered ${a.status}: ${show(a.body)}`);
    return a.body;
  };
  /** One prepared question, its groups and any folded rest summing to its total, as every answer must. */
  const ask = async (s: string, query: Query, who: Who = ME): Promise<WQ> => {
    const w = await read(s, "/api/console/work/query", query, who) as unknown as WQ;
    const sum = w.groups.reduce((n, x) => n + (x.value.value ?? 0), 0) + (w.rest?.value ?? 0);
    if (sum !== (w.total.value ?? 0)) c.fail(s, `?${spelled(query)}: the groups sum to ${sum}, the total is ${show(w.total)}`);
    return w;
  };
  const same = (s: string, found: unknown, expected: unknown): void => {
    if (JSON.stringify(canonical(found)) !== JSON.stringify(canonical(expected))) c.fail(s, `found ${show(found)}, expected ${show(expected)}`);
  };
  const values = (w: WQ): Record<string, unknown> =>
    Object.fromEntries(w.groups.map((x) => [x.key, x.value.unmeasured === undefined && x.value.imported === undefined ? x.value.value : x.value]));
  const previous = (w: WQ): Record<string, unknown> => Object.fromEntries(w.groups.map((x) => [x.key, x.previous === null ? null : x.previous.value]));
  const range = (from: number, to: number): Record<string, string> => ({ from: iso(from), to: iso(to) });
  const rows = (w: WQ): Obj[] => w.rows?.data?.rows ?? c.fail(step, `no rows drilled: ${show(w.rows)}`);
  const W1 = iso(w0 - WEEK), W3 = iso(w0 - 3 * WEEK);
  /** Every record, through a week past the cutoff, so a stock is read as of the cutoff. */
  const RECORD = range(w0 - 6 * WEEK, w0 + WEEK);
  const WEEK3 = range(w0 - 3 * WEEK, w0 - 2 * WEEK);
  const n = (value: number, beside: Obj = {}): Counted => ({ value, why: null, ...beside });

  step = "each new measure by each dimension it allows answers the record's values";
  const EXPECTED: Record<string, Record<string, [Record<string, string>, Record<string, unknown>]>> = {
    calls: {
      tool: [{}, { [STATUS]: 3, "core:document_read": 2, "core:session_whoami": 2, "core:knowledge_search": 1, "core:document_write": 1 }],
      initiative: [{}, { none: 7, [alpha]: 2 }], refused: [{}, { refused: 6, answered: 3 }], period: [{}, { [W1]: 9 }],
    },
    refusals: {
      owner: [{}, { guardrail: 3, ours: 1, theirs: 1, other: 1 }], tool: [{}, { [STATUS]: 3, "core:document_read": 2, "core:knowledge_search": 1 }],
      initiative: [{}, { none: 5, [alpha]: 1 }], period: [{}, { [W1]: 6 }],
    },
    output: {
      skill: [{}, { "q-plan": n(3000, { unmeasured: 0 }), "q-spec": n(1000, { unmeasured: 1 }) }],
      initiative: [{}, { none: n(3000, { unmeasured: 1 }), [alpha]: n(1000, { unmeasured: 0 }) }], period: [{}, { [W1]: n(4000, { unmeasured: 1 }) }],
    },
    skill_calls: { plugin: [WEEK3, { sdlc: 3, "zz-core": 2 }], skill: [WEEK3, { "sdlc-spec": 3, "zz-platform": 2 }], period: [WEEK3, { [W3]: 5 }] },
    shelf: {
      kind: [RECORD, { decision: n(2, { imported: 0 }), knowledge: n(1, { imported: 1 }), process: n(1, { imported: 0 }) }],
      standing: [RECORD, { standing: n(3, { imported: 1 }), superseded: n(1, { imported: 0 }) }],
    },
  };
  const answers: Record<string, Record<string, WQ>> = {};
  for (const [measure, dims] of Object.entries(MEASURES)) {
    answers[measure] = {};
    for (const by of dims) {
      const [window, want] = EXPECTED[measure][by];
      const w = answers[measure][by] = await ask(step, { measure, by, ...window });
      same(`${step}: ${measure} by ${by}`, [values(w), w.rest, w.rows, w.grain], [want, null, null, by === "period" ? "week" : null]);
      // The owners and the standings are always answered, so none falls out of a chart.
      if (by === "owner" && w.groups.map((x) => x.key).sort().join() !== "guardrail,other,ours,theirs") c.fail(step, `owners ${show(w.groups)}`);
    }
  }
  same(`${step}: totals`, ["calls", "refusals", "output", "skill_calls", "shelf"].map((m) => answers[m][MEASURES[m][0]].total),
    [n(9), n(6), n(4000, { unmeasured: 1 }), n(5), n(4, { imported: 1 })]);
  c.pass(`${step}: 16 questions, the maintenance client's calls and the second team's work in none of them`);

  step = "calls and refusals are Activity's figures for the same window and filters";
  const summary = await read(step, "/api/console/activity/summary");
  const asOf = String((summary.meta as Obj).asOf);
  const tiles = summary.tiles as { calls: { figure: Counted }; refused: { figure: Counted; owners: Obj }; mostRefused: Obj };
  const top = answers.refusals.tool.groups[0];
  same(step, [tiles.calls.figure.value, tiles.refused.figure.value, tiles.refused.owners, tiles.mostRefused],
    [answers.calls.tool.total.value, answers.refusals.owner.total.value, values(answers.refusals.owner),
     { tool: top.key, count: top.value.value, of: answers.refusals.owner.total.value }]);
  const weeks = (await g.refusalWeeks(c.team, { from: RECORD.from, to: RECORD.to }, asOf, "week")).periods as { window: { from: string }; calls: number; owners: Obj }[];
  for (const [b, from] of [[1, W1], [2, iso(w0 - 2 * WEEK)]] as [number, string][]) {
    const span = range(w0 - b * WEEK, w0 - (b - 1) * WEEK);
    const week = weeks.find((p) => p.window.from === from) ?? c.fail(step, `refusalWeeks has no week from ${from}`);
    same(`${step}: refusalWeeks, ${b} weeks back`, [week.calls, week.owners],
      [(await ask(step, { measure: "calls", by: "period", ...span })).total.value, values(await ask(step, { measure: "refusals", by: "owner", ...span }))]);
  }
  const log = async (query: Record<string, string>) =>
    (await read(step, "/api/console/activity", { kind: "tool_call", limit: "100", ...query })) as { rows: Obj[]; total: number };
  const callsAll = await ask(step, { measure: "calls", by: "tool", ...RECORD });
  for (const x of callsAll.groups) same(`${step}: the log's ${x.key}`, x.value.value, (await log({ tool: x.key })).total);
  same(`${step}: the log's ${alpha}`, values(await ask(step, { measure: "calls", by: "initiative", ...RECORD }))[alpha], (await log({ initiative: alpha })).total);
  same(`${step}: the log's refusals`, (await ask(step, { measure: "refusals", by: "owner", ...RECORD })).total.value, (await log({ refused: "true" })).total);
  const theirsRow = rows(await ask(step, { measure: "refusals", by: "owner", group: "theirs" }));
  same(`${step}: a drilled refusal is the log's row`, theirsRow, (await log({ refused: "true" })).rows.filter((r) => r.owner === "theirs"));
  const [all, first, second] = await Promise.all(["3", "2", "2"].map((limit, i) =>
    ask(step, { measure: "calls", by: "tool", group: STATUS, limit, offset: i === 2 ? "2" : "0" })));
  same(`${step}: a drill pages in a stable order`, [rows(all).length, all.rows?.data?.total, [...rows(first), ...rows(second)]], [3, 3, rows(all)]);
  const byId = (rs: Obj[]) => [...rs].sort((x, y) => String(x.id).localeCompare(String(y.id)));
  same(`${step}: each drilled call is the log's row`, byId(rows(all)), byId((await log({ tool: STATUS })).rows.filter((r) => rows(all).some((x) => x.id === r.id))));
  c.pass(`${step}: the tiles, the weeks two and one back, the most refused tool, the log's totals by tool, initiative and refused, and its rows`);

  step = "output is Runs' observed output, the runs that measured none counted beside it";
  const runs = (await read(step, "/api/console/runs", { limit: "100" })) as { recent: { data: { rows: Obj[] } } };
  const bySkill: Record<string, Counted> = {};
  for (const r of runs.recent.data.rows) {
    const s = (bySkill[String(r.skill)] ??= n(0, { unmeasured: 0 }));
    if (r.bytes === null) s.unmeasured! += 1; else s.value! += Number(r.bytes);
  }
  same(step, values(await ask(step, { measure: "output", by: "skill", ...RECORD })), bySkill);
  same(`${step}: a drilled run is Runs' row`, rows(await ask(step, { measure: "output", by: "skill", group: "q-plan" })),
    runs.recent.data.rows.filter((r) => r.skill === "q-plan" && Date.parse(String(r.startedAt)) >= w0 - WEEK));
  const unmeasured = await ask(step, { measure: "output", by: "skill", ...range(when([1, 57]), when([1, 59])) });
  same(`${step}: a group that measured nothing`, [unmeasured.total, values(unmeasured)],
    [{ value: null, why: "no_data", unmeasured: 1 }, { "q-spec": { value: null, why: "no_data", unmeasured: 1 } }]);
  c.pass(`${step}: by skill over every run equal to Runs' rows, 1,500 and 3,000 bytes; a window of the one run that measured none no_data`);

  step = "skill_calls are Plugins' team figures";
  const plugins = ((await read(step, "/api/console/plugins")).plugins as { plugin: string; yourTeam: { calls: number } }[]);
  const used = Object.fromEntries(plugins.filter((p) => p.yourTeam.calls).map((p) => [p.plugin, p.yourTeam.calls]));
  same(step, [values(await ask(step, { measure: "skill_calls", by: "plugin", ...RECORD })), used], [used, { sdlc: 4, "zz-core": 2 }]);
  c.pass(`${step}: sdlc 4 and zz-core 2 over every call, the skill no plugin ships, the maintenance client's and the second team's in neither`);

  step = "the shelf is Knowledge's tiles at the cutoff, a stock with no previous";
  const kt = (await read(step, "/api/console/knowledge/summary")).tiles as { standing: Counted; superseded: Counted; searches: { figure: Counted }; noResult: { figure: Counted } };
  const standing = (key: string) => answers.shelf.standing.groups.find((x) => x.key === key)!.value;
  same(step, [kt.standing, kt.superseded.value], [standing("standing"), standing("superseded").value]);
  const compared = await ask(step, { measure: "shelf", by: "kind", compare: "previous", ...RECORD });
  same(step, [values(compared), previous(compared)], [values(answers.shelf.kind), { decision: null, knowledge: null, process: null }]);
  same(`${step}: as of a window's end before any lesson`, values(await ask(step, { measure: "shelf", by: "standing", ...range(w0 - 6 * WEEK, w0 - 4 * WEEK) })),
    { standing: n(0, { imported: 0 }), superseded: n(0, { imported: 0 }) });
  const listed = ((await read(step, "/api/console/knowledge", { kind: "knowledge" })).rows as Obj[]);
  same(`${step}: a drilled lesson is the list's row`, rows(await ask(step, { measure: "shelf", by: "kind", group: "knowledge", ...RECORD })), listed);
  c.pass(`${step}: 3 standing with 1 imported and 1 superseded; nothing as of four weeks back; previous null`);

  step = "searches drill the group that found nothing to its questions, the team's own";
  const searches = await ask(step, { measure: "searches", by: "found", group: "none" });
  const questions = ((await read(step, "/api/console/knowledge/summary")).questions as { data: { rows: { question: string; asked: number }[] } }).data.rows;
  const asked = (qs: unknown[]) => Object.fromEntries([...new Set(qs.map(String))].map((q) => [q, qs.filter((x) => x === q).length]));
  same(step, [values(searches), kt.searches.figure.value, kt.noResult.figure.value, rows(searches).every((r) => r.found === false)], [{ found: 1, none: 3 }, 4, 3, true]);
  same(step, [asked(rows(searches).map((r) => r.question)), Object.fromEntries(questions.map((q) => [q.question, q.asked]))],
    [{ "glorp vexmorn zibbet": 2, "plindle snarf quazzle": 1 }, { "glorp vexmorn zibbet": 2, "plindle snarf quazzle": 1 }]);
  same(`${step}: one that found something has none`, rows(await ask(step, { measure: "searches", by: "found", group: "found" })).map((r) => r.question), [null]);
  c.pass(`${step}: three questions, two of them one normalised, equal to Knowledge's; the found search's question unanswered`);

  step = "compare=previous answers each group's value in the previous window";
  same(step, previous(await ask(step, { measure: "refusals", by: "owner", compare: "previous" })), { guardrail: 1, ours: 0, theirs: 0, other: 0 });
  same(step, previous(await ask(step, { measure: "calls", by: "refused", compare: "previous" })), { refused: 1, answered: 1 });
  same(step, (await ask(step, { measure: "output", by: "skill", compare: "previous" })).groups.map((x) => [x.key, x.previous]),
    [["q-plan", n(0, { unmeasured: 0 })], ["q-spec", n(500, { unmeasured: 0 })]]);
  same(step, previous(await ask(step, { measure: "skill_calls", by: "plugin", compare: "previous", ...WEEK3 })), { sdlc: 1, "zz-core": 0 });
  c.pass(step);

  const k = { c, ask: (s: string, q: Query) => ask(s, q) };
  // Five weeks to the last whole one, Monday to Sunday, as inclusive dates: every record but the second team's.
  const DAYS: Days = { from: localDay(w0 - 5 * WEEK), to: localDay(w0 - 1) };
  const weekly = async (measure: string): Promise<(number | null)[]> =>
    (await ask(step, { measure, by: "week", ...DAYS })).groups.map((x) => x.value.value);

  step = "a window of dates answers what the instants of its days' start and the next day's start answer";
  c.pass(`${step}: ${await datesCases(k, step, MEASURES, DAYS)} questions, every measure by every dimension and bucket`);

  step = "day, week, month and weekday answer every bucket in order, each the sum of the rows its drill answers";
  const buckets = await bucketCases(k, step, MEASURES, DAYS);
  same(step, await Promise.all(["calls", "refusals", "output", "skill_calls"].map(weekly)),
    [[0, 1, 6, 2, 9], [0, 0, 1, 1, 6], [0, 0, 0, 500, 4000], [0, 1, 5, 0, 0]]);
  c.pass(`${step}: ${buckets} buckets drilled, skill_calls' none; calls, refusals, output and skill_calls by week as the record holds them`);

  step = "where filters on the measure's own dimensions, equality alone, at most four";
  const filters = await whereCases(k, step, MEASURES, DAYS);
  same(step, [(await ask(step, { measure: "calls", by: "tool", where: "refused=refused" })).total.value,
    values(await ask(step, { measure: "refusals", by: "tool", where: ["owner=guardrail", `tool=${STATUS}`] }))], [6, { [STATUS]: 3 }]);
  c.pass(`${step}: ${filters} filters, each its group's total; the refused calls are the refusals`);

  step = "from=0001-01-01 answers from the first day the record holds";
  const held = await firstDayCases(k, step, MEASURES, DAYS.to);
  same(step, [(await ask(step, { measure: "skill_calls", by: "plugin", from: FIRST, to: DAYS.to })).window.from,
    (await ask(step, { measure: "shelf", by: "kind", from: FIRST, to: DAYS.to })).window.from],
    [iso(midnightOf(localDay(when([4, 20])))), iso(midnightOf(localDay(when([3, 10]))))]);
  c.pass(`${step}: ${held} measures, skill_calls from its first call and the shelf from its first lesson`);

  step = "the second team's refusal message and question are in no answer";
  const leaked = everything.filter((t) => t.includes(SENTINEL) || t.includes("beacon ledger") || t.includes(THEIRS));
  if (leaked.length) c.fail(step, `${leaked.length} answers hold one: ${leaked[0].slice(0, 300)}`);
  c.pass(`${step}: ${everything.length} answers`);

  step = "another team's records and the maintenance change no answer";
  const QUESTIONS: Record<string, string>[] = Object.entries(MEASURES).flatMap(([measure, dims]) => dims.map((by) => ({ measure, by, ...EXPECTED[measure][by][0] })));
  const before = await Promise.all(QUESTIONS.map((q) => ask(step, q)));
  // The maintenance's calls and searches; its knowledge.add stays, because it is what makes a lesson imported.
  await c.sql.query(`delete from zz.event where (origin <> 'work' and kind in ('tool_call', 'knowledge.search'))
                        or team_id = (select id from zz.team where slug = $1)`, [OTHER_TEAM]);
  await c.sql.query("delete from zz.skill_run where team_id = (select id from zz.team where slug = $1)", [OTHER_TEAM]);
  const after = await Promise.all(QUESTIONS.map((q) => ask(step, q)));
  QUESTIONS.forEach((q, i) => same(`${step}: ${show(q)}`, [before[i].groups, before[i].total], [after[i].groups, after[i].total]));
  c.pass(`${step}: ${QUESTIONS.length} questions`);

  step = "what a measure does not allow is refused with the allowed values, before anything is read";
  await c.sql.query("alter table zz.team rename to team_hidden");
  try {
    for (const [query, says] of [
      [{ measure: "bytes", by: "period" }, "searches, calls, refusals, output, skill_calls, shelf"],
      [{ measure: "shelf", by: "period" }, "shelf is grouped by one of kind, standing"],
      [{ measure: "calls", by: "owner" }, "tool, initiative, refused, period"],
      [{ measure: "refusals", by: "refused" }, "owner, tool, initiative, period"],
      [{ measure: "output", by: "hour" }, "skill, initiative, period"],
      [{ measure: "skill_calls", by: "plugin", group: "sdlc" }, "its groups are its rows"],
      [{ measure: "skill_calls", by: "plugin", rows: "5" }, "its groups are its rows"],
      [{ measure: "shelf", by: "day" }, "shelf is grouped by one of kind, standing"],
      [{ measure: "shelf", by: "week", from: "2026-10-01", to: "2026-10-07" }, "shelf is grouped by one of kind, standing"],
      [{ measure: "calls", by: "tool", where: "owner=ours" }, "calls is filtered by one of tool, initiative, refused"],
      [{ measure: "refusals", by: "tool", where: `owner=${THEIRS}` }, "a filter on owner takes one of guardrail, ours, theirs, other"],
      [{ measure: "output", by: "skill", rows: "0" }, "1 to 20"],
    ] as [Query, string][]) {
      const a = await answer(route("/api/console/work/query"), request(ME, query));
      if (a.status !== 400 || !String(a.body.error).includes(says) || show(a.body).includes(THEIRS)) {
        c.fail(step, `${show(query)} answered ${a.status}: ${show(a.body)}`);
      }
    }
  } finally {
    await c.sql.query("alter table zz.team_hidden rename to team");
  }
  c.pass(step);

  step = "reading it records no event";
  const events = await count(c, "true");
  for (const [measure, dims] of Object.entries(MEASURES)) {
    const w = await ask(step, { measure, by: dims[0], compare: "previous", ...RECORD });
    if (measure !== "skill_calls") await ask(step, { measure, by: dims[0], group: w.groups[0].key, ...RECORD });
  }
  await new Promise((r) => setTimeout(r, 1500));
  if (await count(c, "true") !== events) c.fail(step, `${(await count(c, "true")) - events} events were recorded by reading the queries`);
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
  for (const [measure, by] of [...Object.entries(MEASURES).map(([m, dims]) => [m, dims[0]]), ["searches", "found"]]) {
    const drill = measure === "skill_calls" ? null : measure === "searches" ? "none" : null;
    const ours = await ask(step, { measure, by, compare: "previous", ...RECORD });
    const group = measure === "skill_calls" ? null : drill ?? ours.groups[0].key;
    const [, broad] = fake.workQuery(ava, new URLSearchParams({ measure, by, ...year, compare: "previous" })) as [number, WQ];
    const fakeGroup = group === null ? null : drill ?? broad.groups.find((x) => x.value.value)?.key ?? c.fail(step, `the fake answers no ${measure}`);
    const [, theirs] = fake.workQuery(ava, new URLSearchParams({ measure, by, ...year, compare: "previous", ...(fakeGroup === null ? {} : { group: fakeGroup }) }));
    const drilled = group === null ? ours : await ask(step, { measure, by, compare: "previous", group, ...RECORD });
    if (group !== null && !drilled.rows?.data?.rows.length) c.fail(step, `${measure} drilled no rows to compare`);
    const diffs = shapeDiffs(drilled, theirs, "", []);
    if (diffs.length) c.fail(step, `${measure}: ${diffs.join("; ")}`);
  }
  c.pass(step);
}

process.exitCode = await withThrowawayCore(NAME, DONE, run);
