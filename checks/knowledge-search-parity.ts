#!/usr/bin/env node
/**
 * checks/knowledge-search-parity.ts — one question ranks the same through the console's page, its
 * assistant and MCP, in English and in Chinese, through a real zz-core on a throwaway database.
 *
 *   node checks/knowledge-search-parity.ts   # needs Docker and a built tree (`npm run build`)
 *
 * The page and the assistant's `view_search` both call the gateway's `GET /api/console/search`
 * (services/gateway/src/console/search.ts), which relays to zz-core's `knowledge_search` as the
 * person signed in; an agent calls the same tool over MCP. One seeded snapshot holds English and
 * Chinese documents and lessons, a lesson on the shared shelf whose address is the same as one on
 * the team's, and rows that tie in each of the search's three lanes: identical text, identical
 * tags, one citation, and one `updated_at` for every row. What it establishes, for each of six
 * questions, three English and three Chinese, one of them answered only by widening:
 *
 *   - the route called as a session with `view_search`'s arguments (`q`, `limit` 5), the same route
 *     with fifteen, and `knowledge_search` over MCP as the same person in the same team with five
 *     and with fifteen answer the same rows in the same order at equal limits, the five being the
 *     fifteen's first five;
 *   - ten repeated calls answer the same order;
 *   - rewriting every seeded row in place, which changes nothing they hold but the order PostgreSQL
 *     stores them in, changes no answer: a tie is ordered by the row's key, not by where it sits;
 *   - the lesson on the shared shelf and the team's lesson at the same address both come back;
 *   - the widened question answers its rows as `lexical-broad` with the widening note, and one
 *     call writes one `knowledge.search` event recording `broadened`, not two.
 *
 * The only database it touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Mcp } from "@zz/mcp-client";
import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";

const NAME = "knowledge-search-parity";
const DONE = "knowledge-search-parity: the console's page, its assistant and MCP answer one question with the " +
  "same rows in the same order, in English and in Chinese, on every call and however the rows are stored: ok";

/** The six questions. `wide` is the one no row answers whole, so only widening answers it. */
const QUESTIONS: { q: string; wide?: true }[] = [
  { q: "quokka ledger" },
  { q: "wombat cache" },
  { q: "quokka zeppelin", wide: true },
  { q: "迁移" },
  { q: "缓存 过期" },
  { q: "火箭 发射" },
];
/** `view_search`'s default limit (zz-stack-dashboard src/views/tools.ts), and MCP's. */
const VIEW_LIMIT = 5;
const FULL_LIMIT = 15;
const REPEATS = 10;
/** The shared shelf's team. */
const SHARED_SHELF = "zz-platform";
/** Every seeded row's `updated_at`, so the lanes that order by it tie. */
const ONE_INSTANT = "2026-10-01T00:00:00Z";
/** The widening note's opening words (services/zz-core/src/tools/knowledge-search.ts). */
const WIDENED_NOTE = /^No document contains all of those terms together/;

type Answer = { status: number; body: Record<string, unknown> };
type Route = (req: unknown, res: unknown) => void;
type Row = Record<string, unknown>;

/** The request a console session's call arrives as, past the gateway's middleware (COUPLED:
 *  checks/console-search.ts, whose request this is). */
function request(c: Core, query: Record<string, string>): Record<string, unknown> {
  return {
    params: {}, query,
    zzIdentity: { email: c.email, displayName: "Skeleton", platformRole: "member", via: "session",
                  teams: [{ slug: c.team, role: "admin" }], activeTeam: c.team, patTeam: null,
                  sessionTeam: c.team },
    headers: {
      "x-zz-user-email": c.email, "x-zz-user-name": "Skeleton", "x-zz-user-id": "",
      "x-zz-user-role": "user", "x-zz-via": "session", "x-zz-pat-team": "", "x-zz-session-team": c.team,
    },
  };
}

/** Calls the mounted route as Express would, and waits for the answer it sends. */
function answer(route: Route, req: Record<string, unknown>): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200, headersSent: false,
      status(code: number) { this.statusCode = code; return this; },
      json(body: Record<string, unknown>) { this.headersSent = true; resolve({ status: this.statusCode, body }); },
    };
    try { route(req, res); } catch (err) { reject(err); }
  });
}

/** A route row as one comparable line. A node has no initiative on the route. */
function routeLine(r: Row): string {
  return [r.shelf, r.initiative ?? "", r.path, r.title, r.score, (r.via as string[]).join(","), r.excerpt].join(" | ");
}

/** An MCP row as the same line. COUPLED: services/gateway/src/console/search.ts, which answers a
 *  node's `_knowledge` initiative as none. */
function mcpLine(r: Row): string {
  const initiative = r.initiative === "_knowledge" ? "" : r.initiative;
  return [r.shelf, initiative, r.path, r.title, r.score, (r.via as string[]).join(","), r.snippet].join(" | ");
}

/** The `knowledge.search` events zz-core recorded for `question` under this person, and how many
 *  of them say the search was widened. */
async function eventsFor(c: Core, question: string): Promise<{ n: number; broadened: number }> {
  const { rows } = await c.sql.query<{ n: number; broadened: number }>(
    `select count(*)::int as n, count(*) filter (where e.detail->>'broadened' = 'true')::int as broadened
       from zz.event e join zz.principal p on p.id = e.actor_id
      where e.kind = 'knowledge.search' and e.subject = $1 and p.email = $2`, [question, c.email]);
  return rows[0];
}

/** The events after one call: waited on until the first lands, then a while longer, so a second
 *  one written by the same call is counted too. */
async function eventsAfter(c: Core, question: string, before: number): Promise<{ n: number; broadened: number }> {
  const until = Date.now() + 5000;
  while ((await eventsFor(c, question)).n <= before && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 1000));
  return eventsFor(c, question);
}

async function seed(c: Core): Promise<void> {
  const ledger = await c.open("search-parity");
  const launch = await c.open("search-parity-launch");
  // Three documents alike but for their names: they tie in the word lane, on `ledger` in the tag
  // lane, and as neighbours of anything citing their initiative.
  for (const name of ["a", "b", "c"]) {
    await c.ok(`an agent writes ledger ${name}`, "document_write", {
      path: `${ledger}/ledger-${name}.md`, title: `Ledger ${name.toUpperCase()}`, tags: ["ledger"],
      content: "The quokka ledger reconciles nightly, after the vendor export lands.\n\n这个迁移会破坏旧的模式。\n",
    });
    await c.ok(`an agent writes rocket ${name}`, "document_write", {
      path: `${launch}/rocket-${name}.md`, title: `Rocket ${name.toUpperCase()}`, tags: ["zeppelin"],
      content: "The zeppelin launch slipped a week.\n\n火箭发射推迟到下周。\n",
    });
  }
  // The shared shelf is a team's store that no person here belongs to. The team's first lesson and
  // that shelf's first carry one address, nodes/0001-<slug>.md; only their shelf tells them apart.
  await c.sql.query("insert into zz.team (slug, name, created_by) select $2, 'Platform', id from zz.principal where email = $1",
                    [c.email, SHARED_SHELF]);
  const cache = "The wombat cache expires an entry ninety seconds after it was last read.\n\n缓存在最后一次读取九十秒后过期。\n";
  for (const l of [
    { title: "Wombat cache expiry", scope: "team", tags: ["cache"] },
    { title: "Wombat cache ceiling", scope: "team", tags: ["cache"] },
    { title: "Wombat cache expiry", scope: "platform", tags: ["cache", "platform:guardrail"] },
  ]) {
    await c.ok(`an agent records ${l.title} on the ${l.scope} shelf`, "knowledge_add", {
      title: l.title, type: "decision", scope: l.scope, evidence: [ledger], tags: l.tags, body: cache,
    });
  }
  for (const title of ["Launch window", "Launch checklist"]) {
    await c.ok(`an agent records ${title}`, "knowledge_add", {
      title, type: "process", scope: "team", evidence: [launch], tags: ["launch"],
      body: "The launch window opens at dawn and closes an hour later.\n\n发射窗口在黎明打开。\n",
    });
  }
  await c.sql.query("update zz.doc set updated_at = $1", [ONE_INSTANT]);
  await c.sql.query("update zz.knowledge_node set updated_at = $1", [ONE_INSTANT]);
}

/** Rewrites every row of the tables the search reads, last stored first, each to the values it
 *  already holds: PostgreSQL stores each new version after the others, which moves the stored order
 *  and nothing a search ranks by.
 *
 *  DELIBERATE: a perturbation, not a promise that the order reverses. PostgreSQL may place a new
 *  version elsewhere; a scan reading ties in stored order, with no key to end on, answered "quokka
 *  ledger" differently after this rewrite, which is what it is here to catch. */
async function rewriteInPlace(c: Core): Promise<void> {
  for (const [table, column] of [["zz.doc", "updated_at"], ["zz.doc_revision", "title"],
                                 ["zz.knowledge_node", "updated_at"], ["zz.initiative", "slug"]]) {
    const { rows } = await c.sql.query<{ at: string }>(`select ctid::text as at from ${table} order by ctid desc`);
    for (const { at } of rows) {
      await c.sql.query(`update ${table} set ${column} = ${column} where ctid = $1::tid`, [at]);
    }
  }
}

async function run(c: Core): Promise<void> {
  await seed(c);

  // `withThrowawayDb` ended the gateway's pool after migrating; a fresh one on the same container.
  process.env.TEAM_DB_URL = c.url;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  process.env.CORE_MCP_URL = c.mcp.url;
  const load = (p: string) => import(pathToFileURL(join(root, p)).href);
  const dbModule = (await load("services/gateway/dist/db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await dbModule.initPlatformDb();
  const { mountSearch } = (await load("services/gateway/dist/console/search.js")) as { mountSearch: (app: unknown) => void };
  const routes = new Map<string, Route>();
  mountSearch({ get: (path: string, h: Route) => routes.set(`GET ${path}`, h) });
  const search = routes.get("GET /api/console/search") ?? c.fail("mount", "no route GET /api/console/search");

  // The same person, in the team the session acts for: a token bound to it, as the gateway's
  // `/core` door stamps one.
  const agent = new Mcp(c.mcp.url, {
    client: NAME, timeoutMs: 60_000,
    headers: {
      "x-zz-user-email": c.email, "x-zz-user-name": "Skeleton", "x-zz-user-id": "", "x-zz-user-role": "user",
      "x-zz-via": "pat", "x-zz-pat-team": c.team, "x-zz-session-team": "",
    },
  });

  const viaRoute = async (q: string, limit: number): Promise<{ body: Row; lines: string[] }> => {
    const a = await answer(search, request(c, { q, limit: String(limit) }));
    if (a.status !== 200 || a.body.team !== c.team || !Array.isArray(a.body.results)) {
      c.fail(`the route answers ${JSON.stringify(q)}`, `answered ${a.status}: ${JSON.stringify(a.body)}`);
    }
    return { body: a.body, lines: (a.body.results as Row[]).map(routeLine) };
  };
  const viaMcp = async (q: string, limit: number): Promise<{ body: Row; lines: string[] }> => {
    const reply = await c.ok(`MCP answers ${JSON.stringify(q)}`, "knowledge_search", { query: q, limit }, agent);
    let body: Row;
    try { body = JSON.parse(reply) as Row; } catch { return c.fail(`MCP answers ${JSON.stringify(q)}`, `reply was not JSON: ${reply}`); }
    if (body.team !== c.team) c.fail(`MCP answers ${JSON.stringify(q)}`, `searched ${String(body.team)}, not ${c.team}`);
    return { body, lines: (body.results as Row[]).map(mcpLine) };
  };
  const same = (step: string, a: string[], b: string[], what: string): void => {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      c.fail(step, `${what} differ:\n    ${a.join("\n    ")}\n  against\n    ${b.join("\n    ")}`);
    }
  };

  try {
    const answered = new Map<string, string[]>();
    let step = "the page, the assistant and MCP answer alike";
    for (const { q } of QUESTIONS) {
      const page = await viaRoute(q, FULL_LIMIT);
      const view = await viaRoute(q, VIEW_LIMIT);
      const full = await viaMcp(q, FULL_LIMIT);
      const five = await viaMcp(q, VIEW_LIMIT);
      if (page.lines.length < 2) c.fail(step, `${JSON.stringify(q)} answered ${page.lines.length} row(s); the seed gives it more`);
      same(step, page.lines, full.lines, `${JSON.stringify(q)}: the route's ${FULL_LIMIT} and MCP's ${FULL_LIMIT}`);
      same(step, view.lines, five.lines, `${JSON.stringify(q)}: view_search's ${VIEW_LIMIT} and MCP's ${VIEW_LIMIT}`);
      same(step, view.lines, page.lines.slice(0, VIEW_LIMIT), `${JSON.stringify(q)}: the ${VIEW_LIMIT} and the ${FULL_LIMIT}'s first ${VIEW_LIMIT}`);
      if (page.body.ranked_total !== full.body.ranked_total) {
        c.fail(step, `${JSON.stringify(q)}: ranked_total ${String(page.body.ranked_total)} on the route, ${String(full.body.ranked_total)} on MCP`);
      }
      answered.set(q, page.lines);
    }
    c.pass(`six questions, three English and three Chinese, answer the same rows in the same order through the route at ${VIEW_LIMIT} and ` +
           `${FULL_LIMIT} and MCP at ${VIEW_LIMIT} and ${FULL_LIMIT}, the ${VIEW_LIMIT} being the ${FULL_LIMIT}'s first`);

    step = "a repeated question answers the same order";
    for (const { q } of QUESTIONS) {
      for (let i = 0; i < REPEATS; i++) {
        same(step, (await viaMcp(q, FULL_LIMIT)).lines, answered.get(q) ?? [], `${JSON.stringify(q)}: call ${i + 1} and the first`);
      }
    }
    c.pass(`${REPEATS} repeated calls of each question answer the same order`);

    step = "the stored order decides no tie";
    await rewriteInPlace(c);
    for (const { q } of QUESTIONS) {
      same(step, (await viaRoute(q, FULL_LIMIT)).lines, answered.get(q) ?? [], `${JSON.stringify(q)}: after the rewrite and before`);
      same(step, (await viaMcp(q, FULL_LIMIT)).lines, answered.get(q) ?? [], `${JSON.stringify(q)}: MCP after the rewrite and before`);
    }
    c.pass("every seeded row rewritten in reverse stored order, nothing it holds changed, and every question answers as before");

    step = "the shared shelf's lesson stands beside the team's";
    const lessons = (answered.get("wombat cache") ?? []).filter((l) => / \| nodes\/\d+-wombat-cache-expiry\.md \| /.test(l));
    const shelves = lessons.map((l) => l.split(" | ")[0]).sort();
    if (JSON.stringify(shelves) !== JSON.stringify(["platform", "team"])
        || new Set(lessons.map((l) => l.split(" | ")[2])).size !== 1) {
      c.fail(step, `"wombat cache" answered ${JSON.stringify(answered.get("wombat cache"))}`);
    }
    c.pass("the shared shelf's lesson and the team's lesson at the same address both come back, each on its shelf");

    step = "a widened search is one search";
    for (const { q, wide } of QUESTIONS) {
      for (const [where, call] of [["the route", () => viaRoute(q, VIEW_LIMIT)], ["MCP", () => viaMcp(q, VIEW_LIMIT)]] as const) {
        const before = await eventsFor(c, q);
        const { body } = await call();
        const after = await eventsAfter(c, q, before.n);
        if (after.n !== before.n + 1 || after.broadened - before.broadened !== (wide ? 1 : 0)) {
          c.fail(step, `${JSON.stringify(q)} through ${where} wrote ${after.n - before.n} knowledge.search event(s), ` +
                       `${after.broadened - before.broadened} of them broadened`);
        }
        const vias = (body.results as Row[]).flatMap((r) => r.via as string[]);
        const broad = vias.includes("lexical-broad") && !vias.includes("lexical") && WIDENED_NOTE.test(String(body.note));
        const exact = !vias.includes("lexical-broad") && vias.includes("lexical") && !WIDENED_NOTE.test(String(body.note));
        if (wide ? !broad : !exact) {
          c.fail(step, `${JSON.stringify(q)} through ${where} answered via ${JSON.stringify(vias)} with note ${JSON.stringify(body.note)}`);
        }
      }
    }
    c.pass("the widened question answers lexical-broad with the widening note and writes one broadened event per call; " +
           "the other five write one event, not broadened");
  } finally {
    await dbModule.platformDb().end();
    delete process.env.TEAM_DB_URL;
    delete process.env.CORE_MCP_URL;
  }
}

process.exitCode = await withThrowawayCore(NAME, DONE, run);
