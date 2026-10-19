#!/usr/bin/env node
/**
 * checks/console-work-knowledge.ts — Knowledge is read for the active team: the inventory, its own questions that found
 * nothing, searches by week, and the shelf paged on the server (AC-6.2).
 *
 *   node checks/console-work-knowledge.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL and a real zz-core on it (`withThrowawayCore`), and makes the record through that
 * zz-core's own tools: twelve lessons on the team's shelf, two of them carried by a maintenance client (`zz-migrate`)
 * and one superseded, a lesson on the shared shelf, a lesson on a second team's shelf, and the searches, each a
 * `knowledge_search` call whose `knowledge.search` row zz-core writes itself. The record is made in phases, each
 * moved, together and by one interval, into the week and hour it names. It calls the gateway's own built routes
 * (`services/gateway/dist/console/knowledge.js` and `knowledge-summary.js`) the way Express would, as a console
 * session. What it establishes, with the expected values written below:
 *
 *   - the tiles: the team's standing lessons with the imported among them, its superseded lessons, and the last whole
 *     week's searches and those that found nothing, out of how many;
 *   - the questions that found nothing are the team's own, normalised by case and spacing, most asked first then the
 *     latest asked, ten with their total; a maintenance client's question and one another team asked are never among
 *     them, and the second team's distinctive question is in no answer, for a member or for a superadmin acting for
 *     the team, whatever team or scope the request names;
 *   - searches with results by week equal searchesWithResults for the team, the running week not complete, over the
 *     weeks from the first search, at most 24 whole weeks and the running one;
 *   - the newest lessons are the team's five most recently made, each said imported or not;
 *   - no tile or line calls a result an answer;
 *   - the list is the team's shelf filtered by q (title, tags or body, case-insensitive) and kind, paged at 10 and at
 *     most 100 in a stable order, with the whole filtered population counted by kind and standing; a bad page, an
 *     unknown kind or a repeated filter is refused;
 *   - a member opens a shared-shelf lesson by its node route, marked shared, and still cannot open another team's;
 *   - each part fails alone, reading records no event, a person in no team is refused, and the key sets match the
 *     console's fake answers.
 *
 * DELIBERATE: the reporting timezone is Asia/Singapore, eight hours ahead of UTC, so a week cut on UTC's calendar
 * moves what the record places before 08:00 on a Monday.
 *
 * DELIBERATE: two searches are made in the running week as the check runs, and the weeks are counted from the
 * running week it began in, so a run that crosses midnight into a Monday in that timezone fails on dates; run it again.
 *
 * The only database it touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Mcp } from "@zz/mcp-client";
import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";
import { OTHER_EMAIL, OTHER_TEAM, TIMEZONE, WEEK, at, runningWeek, type When } from "../scripts/schema/work-seed.ts";

const NAME = "console-work-knowledge";
const DONE = "console-work-knowledge: Knowledge reads the active team's shelf, its own questions that found nothing and its " +
  "searches by week at one cutoff, the shelf filtered and paged on the server, a shared-shelf lesson open to a member and " +
  "another team's question in no answer: ok";
/** COUPLED: the fake answer in the console's checkout, `../zz-stack-dashboard` here and in CI. */
const FAKE = join(root, "..", "zz-stack-dashboard", "scripts", "fake-gateway", "work-knowledge.ts");
/** The shared shelf. COUPLED: PLATFORM_TEAM in services/gateway/src/identity.ts. */
const SHARED = "zz-platform";
const MAINTENANCE = "zz-migrate";

type Obj = Record<string, unknown>;
type Route = (req: unknown, res: unknown) => void;
type Who = { email: string; team: string | null; role?: "member" | "superadmin" };
type Win = { from: string; to: string; observedFrom: string | null; observedThrough: string | null; complete: boolean };
type PF = { window: Win; figure: { value: number | null; why: string | null }; numerator: number | null; denominator: number | null };
type Part = { state: string; data?: unknown; reason?: string };
type Row = { team: string; path: string; title: string; type: string; status: string };

/** The team's lessons, oldest first: `[title, kind, by a maintenance client, body, tags]`. Each phase of three is
 *  made in a week of its own, the four weeks before the running one. */
const LESSONS: [title: string, kind: string, carried: boolean, body: string, tags: string[]][] = [
  ["Quokka ledgers reconcile nightly", "decision", false, "Reconcile the quokka ledger once a night, after the export lands.", ["ledger"]],
  ["Draw a figure before its table", "design", false, "A reader sees the shape first and the rows second.", []],
  ["Review before release", "process", false, "Somebody other than the author reads the change.", []],
  ["Indexes are rebuilt offline", "knowledge", true, "The rebuild runs against a copy and swaps in at the end.", []],
  ["People skim the first screen", "behavior", false, "What is below the fold is read by few.", []],
  ["Name the export by its date", "style", false, "A file named by its date sorts itself.", ["vendor-export"]],
  ["Ledgers reconcile at the close of day", "decision", false, "The close of day is when every entry has landed.", ["ledger"]],
  ["One chart per question", "design", false, "A chart that answers two questions answers neither well.", []],
  ["Pair on the risky change", "process", false, "Two people catch what one misses; the wombat incident showed it.", []],
  ["Caches expire after the last read", "knowledge", false, "Expiry counts from the last read, not the write.", []],
  ["Readers return to a bookmarked page", "behavior", true, "A page kept is a page read again.", []],
  ["Say the unit beside the number", "style", false, "A number without its unit is read in the wrong one.", []],
];
/** Questions nothing on any shelf holds a word of, so every search of them finds nothing. */
const ROTATED = ["glorp vexmorn zibbet", "Glorp  VEXMORN zibbet", "  glorp vexmorn   Zibbet "];
const SNARF = ["plindle snarf quazzle", "PLINDLE snarf quazzle"];
const ONCE = ["frabjous wibble", "mimsy borogove", "tulgey vorpal", "jubjub slithy", "tove outgrabe", "mome rath",
  "burbled whiffling", "galumphing uffish", "callooh callay"];
const RUNNING_ONCE = "brillig wabe";
const MAINTAINED = "snorkack crumple";
/** The second team's question that found nothing: distinctive, so its absence from every answer is a fact. */
const THEIRS = "xyzzy frumious bandersnatch";
const OLD = "ancient zorkmid";
/** Questions that find something on the team's shelf. */
const FOUND = ["quokka ledgers", "wombat", "nightly reconcile"];

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
/** Its value with every object's keys in order: an answer's key order is no part of its contract. */
const canonical = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canonical)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Obj)[k])])) : v;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const show = (v: unknown): string => JSON.stringify(v).slice(0, 700);

/** Where two answers' shapes differ: at an object both hold, the key sets; at an array both hold, the first elements,
 *  the same way; a null on either side, nothing. A record whose keys are data, the list's count by kind, is not a shape. */
function shapeDiffs(a: unknown, b: unknown, path: string, out: string[]): string[] {
  if (a === null || b === null || path.endsWith("summary.byKind")) return out;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length && b.length) shapeDiffs(a[0], b[0], `${path}[0]`, out);
  } else if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    if (ka.join() !== kb.join()) out.push(`${path || "the answer"} has keys {${ka.join(", ")}} where the fake has {${kb.join(", ")}}`);
    for (const k of ka.filter((x) => kb.includes(x))) shapeDiffs(a[k], b[k], path ? `${path}.${k}` : k, out);
  }
  return out;
}

/** The request a console session's read arrives as, past the gateway's middleware (COUPLED: identity.ts). */
function request(who: Who, query: Obj = {}, params: Obj = {}): Obj {
  const role = who.role ?? "member";
  return {
    params, query, body: {},
    zzIdentity: { email: who.email, displayName: "Knowledge", platformRole: role, via: "session",
                  teams: who.team ? [{ slug: who.team, role: "admin" }] : [], activeTeam: who.team, patTeam: null, sessionTeam: who.team },
    headers: {
      "x-zz-user-email": who.email, "x-zz-user-name": "Knowledge", "x-zz-user-id": "", "x-zz-user-role": role === "superadmin" ? "admin" : "user",
      "x-zz-via": "session", "x-zz-pat-team": "", "x-zz-session-team": who.team ?? "",
    },
  };
}

/** Calls a mounted route as Express would, and waits for what it sends. */
function answer(route: Route, req: Obj): Promise<{ status: number; body: Obj }> {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200, headersSent: false,
      status(code: number) { this.statusCode = code; return this; },
      json(body: Obj) { this.headersSent = true; resolve({ status: this.statusCode, body }); },
    };
    try { route(req, res); } catch (err) { reject(err); }
  });
}

type Weekly = (team: string, window: { from: string; to: string }, asOf: string, grain: "week") => Promise<PF[]>;
interface Gateway { summary: Route; list: Route; node: Route; log: Route; weekly: Weekly; stop(): Promise<void> }

/** The gateway's Knowledge routes and searchesWithResults, loaded once the reporting timezone is set. */
async function listen(c: Core): Promise<Gateway> {
  process.env.TEAM_DB_URL = c.url;
  process.env.ZZ_TZ = TIMEZONE;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  process.env.CORE_MCP_URL = c.mcp.url;
  const load = (p: string) => import(pathToFileURL(join(root, "services/gateway/dist", p)).href);
  const db = (await load("db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await db.initPlatformDb();
  const routes = new Map<string, Route>();
  const app = { get: (p: string, h: Route) => routes.set(`GET ${p}`, h) };
  ((await load("console/knowledge-summary.js")) as { mountKnowledgeSummary: (a: unknown) => void }).mountKnowledgeSummary(app);
  ((await load("console/knowledge.js")) as { mountKnowledge: (a: unknown) => void }).mountKnowledge(app);
  const route = (p: string): Route => routes.get(`GET ${p}`) ?? c.fail("mount", `no route GET ${p}`);
  return {
    summary: route("/api/console/knowledge/summary"),
    list: route("/api/console/knowledge"),
    node: route("/api/console/knowledge/:team/*"),
    log: route("/api/console/knowledge/log"),
    weekly: ((await load("console/work-figures.js")) as { searchesWithResults: Weekly }).searchesWithResults,
    stop: async () => {
      await db.platformDb().end().catch(() => undefined);
      for (const k of ["TEAM_DB_URL", "ZZ_TZ", "ZZ_CATALOG_DIR", "CORE_MCP_URL"]) delete process.env[k];
    },
  };
}

const count = async (c: Core, where: string): Promise<number> =>
  (await c.sql.query<{ n: number }>(`select count(*)::int as n from zz.event where ${where}`)).rows[0].n;

/**
 * Runs `make` and waits until every row it leaves has landed (zz-core writes a search's row after it answers); then,
 * with a `target`, moves every timestamp the phase wrote by one interval, so its first instant lands there.
 */
async function phase(c: Core, target: number | null, make: () => Promise<void>): Promise<void> {
  const start = (await c.sql.query<{ t: string }>("select clock_timestamp()::text as t")).rows[0].t;
  await make();
  const until = Date.now() + 15_000;
  let seen = -1;
  for (;;) {
    await new Promise((r) => setTimeout(r, 400));
    const all = await count(c, "true");
    if (all === seen) break;
    if (Date.now() > until) c.fail("a phase settles", "events still moving");
    seen = all;
  }
  if (target === null) return;
  const to = new Date(target).toISOString();
  const move = (table: string, columns: string[]) => c.sql.query(
    `update ${table} set ${columns.map((k) => `${k} = case when ${k} >= $1::timestamptz then ${k} + ($2::timestamptz - $1::timestamptz) else ${k} end`).join(", ")}
      where ${columns.map((k) => `${k} >= $1::timestamptz`).join(" or ")}`, [start, to]);
  await move("zz.event", ["ts"]);
  await move("zz.initiative", ["opened_at", "closed_at"]);
  await move("zz.knowledge_node", ["created_at", "updated_at"]);
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
  // The shared shelf, and a second team with a person acting for it.
  await c.sql.query("insert into zz.team (slug, name, created_by) select $1, 'Platform', id from zz.principal where email = $2", [SHARED, c.email]);
  await c.sql.query(
    `with p as (insert into zz.principal (email, display_name, role) values ($1, 'Other', 'member') returning id),
          t as (insert into zz.team (slug, name, created_by) select $2, 'Other team', id from p returning id)
     insert into zz.membership (team_id, principal_id, role, added_by) select t.id, p.id, 'admin', p.id from p, t`, [OTHER_EMAIL, OTHER_TEAM]);
  await c.sql.query("update zz.principal set active_team_id = (select id from zz.team where slug = $2) where email = $1", [OTHER_EMAIL, OTHER_TEAM]);
  const maintenance = c.client({ client: MAINTENANCE });
  const other = c.client({ email: OTHER_EMAIL });
  const w0 = runningWeek(Date.now());
  const when = (w: When): number => at(w0, w);

  let step = "the record made";
  let source = "";
  const add = async (i: number) => {
    const [title, type, carried, body, tags] = LESSONS[i];
    await c.ok(step, "knowledge_add", { title, type, body, tags, evidence: [source], scope: "team" }, carried ? maintenance : undefined);
  };
  /** One search, and whether it found anything as the seed says it must. */
  const ask = async (query: string, finds: boolean, via?: Mcp) => {
    const reply = JSON.parse(await c.ok(step, "knowledge_search", { query }, via)) as { returned: number };
    if ((reply.returned > 0) !== finds) c.fail(step, `"${query}" returned ${reply.returned}, where the seed needs ${finds ? "some" : "none"}`);
  };
  await phase(c, when([4, 10]), async () => {
    source = await c.open("knowledge-source");
    for (const i of [0, 1, 2]) await add(i);
  });
  await phase(c, when([3, 10]), async () => { for (const i of [3, 4, 5]) await add(i); });
  await phase(c, when([2, 10]), async () => {
    for (const i of [6, 7, 8]) await add(i);
    await c.ok(step, "knowledge_supersede", { old_id: "0001", new_id: "0007", shelf: "team" });
  });
  await phase(c, when([1, 10]), async () => {
    for (const i of [9, 10, 11]) await add(i);
    await c.ok(step, "knowledge_add", { title: "A gate is a person approving", type: "decision", scope: "platform", tags: ["platform:guardrail"],
      evidence: [source], body: "A check passing is evidence for the person; it is never the approval." });
    // The second team's own lesson, on its own shelf, made as its own person.
    const theirs = JSON.parse(await c.ok(step, "initiative_open", { slug: "knowledge-theirs" }, other)) as { initiative: string };
    await c.ok(step, "knowledge_add", { title: "Their private lesson", type: "process", scope: "team", evidence: [theirs.initiative],
      body: "Only the second team may read this lesson." }, other);
  });
  await phase(c, when([3, 20]), async () => { await ask(ROTATED[0], false); await ask(FOUND[0], true); });
  await phase(c, when([2, 20]), async () => {
    await ask(ROTATED[1], false); await ask(SNARF[0], false); await ask(FOUND[0], true); await ask(FOUND[1], true);
  });
  await phase(c, when([1, 20]), async () => {
    await ask(ROTATED[2], false); await ask(SNARF[1], false);
    for (const q of ONCE) await ask(q, false);
    for (const q of FOUND) await ask(q, true);
    await ask(MAINTAINED, false, maintenance);
    await ask(THEIRS, false, other);
  });
  await phase(c, null, async () => { await ask(RUNNING_ONCE, false); await ask(FOUND[2], true); });
  if (await count(c, `kind = 'knowledge.search' and subject = '${THEIRS}' and team_id = (select id from zz.team where slug = '${OTHER_TEAM}')`) !== 1) {
    c.fail(step, "the second team's question was not recorded as its own, so its absence would prove nothing");
  }
  c.pass(`${step}: twelve lessons, one on the shared shelf and one of another team's, and 24 searches through zz-core`);

  const ME: Who = { email: c.email, team: c.team };
  const SUPER: Who = { email: c.email, team: c.team, role: "superadmin" };
  const summaryOf = async (s: string, who: Who = ME, query: Obj = {}): Promise<Obj> => {
    const a = await answer(g.summary, request(who, query));
    if (a.status !== 200) c.fail(s, `the summary answered ${a.status}: ${show(a.body)}`);
    return a.body;
  };
  const listOf = async (s: string, query: Obj = {}, who: Who = ME): Promise<Obj> => {
    const a = await answer(g.list, request(who, query));
    if (a.status !== 200) c.fail(s, `the list answered ${a.status} to ${show(query)}: ${show(a.body)}`);
    return a.body;
  };
  const ok = (s: string, part: unknown): unknown => {
    const p = part as Part;
    if (p?.state !== "ok") c.fail(s, `a part read ${show(part)}`);
    return p.data;
  };
  const same = (s: string, found: unknown, expected: unknown): void => {
    if (JSON.stringify(canonical(found)) !== JSON.stringify(canonical(expected))) c.fail(s, `found ${show(found)}, expected ${show(expected)}`);
  };
  /** An answer with its cutoff blanked, which a later read moves and nothing else about it does. */
  const masked = (x: Obj) => JSON.stringify(x).replaceAll(String((x.meta as Obj).asOf), "<asOf>");
  /** An instant inside the minute that starts where the seed placed it. */
  const near = (s: string, found: unknown, w: When) => {
    const ms = Date.parse(String(found)), from = when(w);
    if (!(ms >= from && ms < from + 60_000)) c.fail(s, `${String(found)} is not within the minute from ${iso(from)}`);
  };

  const summary = await summaryOf("the summary");
  const asOf = String((summary.meta as Obj).asOf);
  const window = (b: number): Win => ({ from: iso(w0 - b * WEEK), to: iso(w0 - (b - 1) * WEEK), observedFrom: iso(w0 - b * WEEK),
                                        observedThrough: b === 0 ? asOf : iso(w0 - (b - 1) * WEEK), complete: b > 0 });

  step = "the meta: the team's searches from the week of its first, the shared shelf left out";
  const meta = summary.meta as Obj;
  same(step, { ...meta, coverageFrom: null }, { asOf, timezone: TIMEZONE, period: { from: iso(w0 - 3 * WEEK), to: asOf }, scope: "active-team",
    population: `${c.team}'s knowledge shelf and its own searches, the shared shelf left out`, coverageFrom: null });
  near(step, meta.coverageFrom, [3, 20]);
  c.pass(step);

  step = "the tiles: standing with the imported among them, superseded, and last week's searches and those that found nothing";
  const tiles = summary.tiles as Obj;
  same(step, tiles, {
    standing: { value: 11, why: null, imported: 2 }, superseded: { value: 1, why: null },
    searches: { window: window(1), figure: { value: 14, why: null }, numerator: 14, denominator: null },
    noResult: { window: window(1), figure: { value: 11, why: null }, numerator: 11, denominator: 14 },
  });
  c.pass(`${step}: 11 standing, 2 imported, 1 superseded, 11 of last week's 14 searches found nothing`);

  step = "the questions that found nothing: the team's own, normalised, most asked then latest, ten of their total";
  const questions = ok(step, summary.questions) as { rows: { question: string; asked: number; lastAsked: string }[]; total: number };
  same(step, [questions.rows.map((r) => [r.question, r.asked]), questions.total], [[
    ["glorp vexmorn zibbet", 3], ["plindle snarf quazzle", 2], [RUNNING_ONCE, 1],
    ...ONCE.slice(2).reverse().map((q) => [q, 1]),
  ], 12]);
  near(step, questions.rows[0].lastAsked, [1, 20]);
  near(step, questions.rows[1].lastAsked, [1, 20]);
  if (!(Date.parse(questions.rows[2].lastAsked) >= w0 && questions.rows[2].lastAsked <= asOf)) c.fail(step, `the running week's question ${show(questions.rows[2])}`);
  if (questions.rows.some((r) => r.question === MAINTAINED || r.question === THEIRS)) c.fail(step, "a maintenance or another team's question is among them");
  c.pass(step);

  step = "searches with results by week: searchesWithResults for the team, the running week not complete";
  const weeks = ok(step, summary.weeks) as PF[];
  same(step, weeks.map((p) => [p.window, p.numerator, p.denominator]),
    [[window(3), 1, 2], [window(2), 2, 4], [window(1), 3, 14], [window(0), 1, 2]]);
  same(step, weeks, await g.weekly(c.team, meta.period as { from: string; to: string }, asOf, "week"));
  c.pass(step);

  step = "the newest lessons: the team's five most recently made, each said imported or not";
  const newest = ok(step, summary.newest) as { team: string; path: string; title: string; kind: string; createdAt: string; imported: boolean }[];
  same(step, newest.map((n) => [n.team, n.path.slice(0, 11), n.title, n.kind, n.imported]), [11, 10, 9, 8, 7].map((i) =>
    [c.team, `nodes/${String(i + 1).padStart(4, "0")}-`, LESSONS[i][0], LESSONS[i][1], LESSONS[i][2]]));
  for (const n of newest) near(step, n.createdAt, [newest.indexOf(n) < 3 ? 1 : 2, 10]);
  c.pass(step);

  step = "no tile or line calls a result an answer";
  if (/\banswer/i.test(JSON.stringify(summary))) c.fail(step, show(JSON.stringify(summary).match(/.{60}\banswer.{60}/i)));
  c.pass(step);

  step = "the second team's question is in no answer, for a member or a superadmin acting for the team";
  for (const [who, query] of [[ME, {}], [SUPER, {}], [SUPER, { scope: "platform" }], [SUPER, { team: OTHER_TEAM }], [ME, { team: OTHER_TEAM }]] as [Who, Obj][]) {
    const s = await summaryOf(step, who, query);
    const l = await listOf(step, { ...query, limit: "100" }, who);
    const both = JSON.stringify([s, l]);
    if (both.includes(THEIRS) || both.includes(MAINTAINED) || both.includes("Their private lesson")) c.fail(step, `${who.role ?? "member"} with ${show(query)} read it`);
    if (masked(s) !== masked(summary)) c.fail(step, `${who.role ?? "member"} with ${show(query)} read another summary`);
  }
  c.pass(step);

  // The list's order: the most recently changed first, each phase's lessons in the order they were made.
  const ORDER = [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map((i) => LESSONS[i][0]);
  const titles = (l: Obj) => (l.rows as Row[]).map((r) => r.title);
  const byKind = Object.fromEntries(["decision", "design", "process", "knowledge", "behavior", "style"].map((k) => [k, 2]));

  step = "the list: the team's shelf, ten a page, the whole population counted by kind and standing";
  const first = await listOf(step);
  same(step, [titles(first), first.total, first.summary], [ORDER.slice(0, 10), 12, { byKind, standing: 11, superseded: 1 }]);
  const second = await listOf(step, { offset: "10" });
  same(step, [titles(second), second.total, second.summary], [ORDER.slice(10), 12, first.summary]);
  if ((first.rows as Row[]).some((r) => r.team !== c.team)) c.fail(step, "a row of another shelf");
  same(step, (first.rows as Row[]).find((r) => r.title === LESSONS[0][0]) ?? null, null);
  same(step, (second.rows as Row[]).map((r) => r.status), ["adopted", "superseded"]);
  same(step, (first.meta as Obj).scope, "active-team");
  c.pass(step);

  step = "a stable order: every page of one, and two reads, are the same rows";
  const walked: string[] = [];
  for (let offset = 0; offset < 13; offset++) {
    const page = await listOf(step, { limit: "1", offset: String(offset) });
    if (page.total !== 12 || (page.rows as Row[]).length !== (offset < 12 ? 1 : 0)) c.fail(step, `offset ${offset}: ${show(page)}`);
    walked.push(...titles(page));
  }
  same(step, walked, ORDER);
  same(step, titles(await listOf(step, { limit: "100" })), ORDER);
  same(step, titles(await listOf(step, { limit: "3", offset: "3" })), ORDER.slice(3, 6));
  c.pass(step);

  step = "filtered by q in a title, a tag or the body, case-insensitive, and by kind, before paging";
  const filtered = async (query: Obj) => { const l = await listOf(step, query); return [titles(l), l.total, l.summary]; };
  same(step, await filtered({ q: "QUOKKA" }), [[LESSONS[0][0]], 1, { byKind: { decision: 1 }, standing: 0, superseded: 1 }]);
  same(step, await filtered({ q: "Vendor-Export" }), [[LESSONS[5][0]], 1, { byKind: { style: 1 }, standing: 1, superseded: 0 }]);
  same(step, await filtered({ q: "wombat" }), [[LESSONS[8][0]], 1, { byKind: { process: 1 }, standing: 1, superseded: 0 }]);
  same(step, await filtered({ kind: "decision" }), [[LESSONS[6][0], LESSONS[0][0]], 2, { byKind: { decision: 2 }, standing: 1, superseded: 1 }]);
  same(step, await filtered({ q: "ledger", kind: "decision", limit: "1" }), [[LESSONS[6][0]], 2, { byKind: { decision: 2 }, standing: 1, superseded: 1 }]);
  same(step, await filtered({ q: "wombat", kind: "decision" }), [[], 0, { byKind: {}, standing: 0, superseded: 0 }]);
  c.pass(step);

  step = "a bad page, an unknown kind and a repeated filter are refused";
  const PAGE = "limit must be a whole number from 1 to 100, and offset one from 0";
  const ONCE_ONLY = "each filter and the page are given at most once";
  const KINDS = "kind must be one of decision, design, process, knowledge, behavior, style";
  for (const [query, error] of [
    [{ limit: "0" }, PAGE], [{ limit: "101" }, PAGE], [{ limit: "2.5" }, PAGE], [{ offset: "-1" }, PAGE], [{ offset: "x" }, PAGE],
    [{ kind: "opinion" }, KINDS], [{ kind: ["decision", "design"] }, ONCE_ONLY], [{ q: ["a", "b"] }, ONCE_ONLY],
  ] as [Obj, string][]) {
    const a = await answer(g.list, request(ME, query));
    if (a.status !== 400 || a.body.error !== error) c.fail(step, `${show(query)} answered ${a.status}: ${show(a.body)}`);
  }
  c.pass(step);

  step = "a member opens a shared-shelf lesson, marked shared, and their own marked team, and never another team's";
  const address = async (team: string, title: string): Promise<string> => (await c.sql.query<{ a: string }>(
    `select 'nodes/' || k.node_ordinal || '-' || k.slug || '.md' as a from zz.knowledge_node k join zz.team t on t.id = k.team_id
      where t.slug = $1 and k.title = $2`, [team, title])).rows[0]?.a ?? c.fail(step, `no lesson ${title} on ${team}`);
  const open = (team: string, path: string, who: Who = ME) => answer(g.node, request(who, {}, { team, 0: path }));
  const shared = await open(SHARED, await address(SHARED, "A gate is a person approving"));
  if (shared.status !== 200 || shared.body.shelf !== "shared" || shared.body.team !== SHARED) c.fail(step, `the shared lesson: ${shared.status} ${show(shared.body)}`);
  const own = await open(c.team, await address(c.team, LESSONS[11][0]));
  if (own.status !== 200 || own.body.shelf !== "team") c.fail(step, `the team's own lesson: ${own.status} ${show(own.body)}`);
  const theirs = await open(OTHER_TEAM, await address(OTHER_TEAM, "Their private lesson"));
  if (theirs.status !== 404 || JSON.stringify(theirs.body).includes("Their private lesson")) c.fail(step, `another team's lesson: ${theirs.status} ${show(theirs.body)}`);
  c.pass(step);

  step = "the knowledge log names a lesson's address while it is on the shelf, and that address opens it";
  const log = await answer(g.log, request(ME, {}, {}));
  if (log.status !== 200) c.fail(step, `the log answered ${log.status}: ${show(log.body)}`);
  const entries = log.body.entries as { node: string; node_title: string | null; path: string | null }[];
  for (const e of entries) if ((e.path === null) !== (e.node_title === null)) c.fail(step, `${show(e)}: an address without its lesson, or a lesson without its address`);
  const shelved = entries.find((e) => e.path !== null) ?? c.fail(step, "no entry names a lesson on the shelf, so an address proves nothing");
  const opened = await open(c.team, shelved.path!);
  if (opened.status !== 200 || opened.body.title !== shelved.node_title) c.fail(step, `${shelved.path} opened ${opened.status} ${show(opened.body)}`);
  c.pass(`${step}: ${entries.length} entries, ${shelved.path} among them`);

  step = "reading Knowledge records no event";
  const before = await count(c, "true");
  await summaryOf(step);
  await listOf(step);
  await new Promise((r) => setTimeout(r, 1500));
  if (await count(c, "true") !== before) c.fail(step, `${(await count(c, "true")) - before} events were recorded by reading Knowledge`);
  c.pass(step);

  step = "the shelf missing: its tiles and the newest lessons are said unavailable, never zero, and the searches stand";
  await c.sql.query("alter table zz.knowledge_node rename to knowledge_node_hidden");
  const blind = await summaryOf(step).finally(() => c.sql.query("alter table zz.knowledge_node_hidden rename to knowledge_node"));
  const blindTiles = blind.tiles as Obj;
  same(step, [blindTiles.standing, blindTiles.superseded, (blind.newest as Part).state],
    [{ value: null, why: "unavailable", imported: 0 }, { value: null, why: "unavailable" }, "unavailable"]);
  const parts = (x: Obj) => masked({ ...(x.tiles as Obj), standing: null, superseded: null, questions: x.questions, weeks: x.weeks, meta: x.meta });
  if (parts(blind) !== parts(summary)) c.fail(step, `the searches read otherwise: ${show(parts(blind))}`);
  c.pass(step);

  step = "a person in no team is refused before anything is read";
  for (const route of [g.summary, g.list]) {
    const none = await answer(route, request({ email: c.email, team: null }));
    if (none.status !== 400) c.fail(step, `answered ${none.status}: ${show(none.body)}`);
  }
  c.pass(step);

  step = "a first search older than the weeks drawn: the newest 24 whole weeks, and its question outside them";
  await phase(c, when([30, 10]), () => ask(OLD, false));
  const long = await summaryOf(step);
  const drawn = ok(step, long.weeks) as PF[];
  if (drawn.length !== 25 || drawn[0].window.from !== iso(w0 - 24 * WEEK) || ((long.meta as Obj).period as Obj).from !== drawn[0].window.from) {
    c.fail(step, `the weeks drawn from ${show(drawn[0]?.window)}, ${drawn.length} of them`);
  }
  near(step, (long.meta as Obj).coverageFrom, [30, 10]);
  const longQuestions = ok(step, long.questions) as typeof questions;
  same(step, [longQuestions.total, longQuestions.rows.some((r) => r.question === OLD)], [12, false]);
  c.pass(step);

  step = "the key sets match the console's fake answers";
  type Fake = {
    knowledgeSummary: (who: unknown) => [number, unknown]; knowledgeList: (who: unknown, q: URLSearchParams) => [number, unknown];
    lesson: (team: string, path: string, own?: string | null) => unknown; SHELF: { team: string; path: string }[]; SHARED_TEAM: string;
  };
  let fake: Fake;
  try {
    fake = (await import(pathToFileURL(FAKE).href)) as Fake;
  } catch (err) {
    return c.fail(step, `could not read the console's fake answer at ${FAKE}: ${(err as Error).message}`);
  }
  const persona = { activeTeam: "atlas", email: "ava.lindqvist@example.com", superadmin: false };
  const sharedPath = fake.SHELF.find((n) => n.team === fake.SHARED_TEAM)?.path ?? c.fail(step, "the fake has no shared-shelf lesson");
  const diffs = [
    ...shapeDiffs(summary, fake.knowledgeSummary(persona)[1], "summary", []),
    ...shapeDiffs(first, fake.knowledgeList(persona, new URLSearchParams())[1], "list", []),
    ...shapeDiffs(shared.body, fake.lesson(fake.SHARED_TEAM, sharedPath, "atlas"), "shared lesson", []),
    ...shapeDiffs(own.body, fake.lesson("atlas", fake.SHELF.find((n) => n.team === "atlas")!.path, "atlas"), "lesson", []),
  ];
  if (diffs.length) c.fail(step, diffs.join("; "));
  const fakeShared = fake.lesson(fake.SHARED_TEAM, sharedPath, "atlas") as Obj | null;
  if (fakeShared?.shelf !== "shared") c.fail(step, `the fake answers a member's shared-shelf lesson as ${show(fakeShared)}`);
  c.pass(step);
}

process.exitCode = await withThrowawayCore(NAME, DONE, run);
