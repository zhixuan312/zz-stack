#!/usr/bin/env node
/**
 * checks/console-team-switch.ts — a person in two teams switches the team their browser acts for, and
 * every read then answers the new team alone, beside other callers reading at the same moment (AC-1.16).
 *
 *   node checks/console-team-switch.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL and a real zz-core on it (`withThrowawayCore`), seeds what
 * `scripts/schema/isolation-seed.ts` declares (two teams of the same rows, the second's free text
 * sentinels generated afresh for this run, the first's plain words; a person in both teams; the teams'
 * admins signed in) and what `seedWorkRecord` makes through zz-core (runs of both teams among it), and
 * serves the gateway's built identity middleware, JSON parser, `mountConsole`, `mountConsoleWrite` and
 * `mountSettings` from this process in server.ts's order. The person in both teams, a member and no
 * superadmin, is signed in twice, each browser's session acting for the first team. What it establishes:
 *
 *   - the first browser reads the first team: Home, Record, Approvals, Initiatives, `work/query` asked
 *     with measures (a request naming none is refused), Knowledge and its summary, Activity and its
 *     summary, Runs, Plugins and Skills each answer 200 with the first team's rows and nothing of the
 *     second's, and the first team's initiative, document and lesson open by their deep links;
 *   - it switches through `POST /api/console/settings/me/active-team`, which answers 200 acting for the
 *     second team from the first and writes one `team.switch` event of the person's, `via: web`; every
 *     one of those reads then answers the second team's rows and nothing of the first's, and the first
 *     team's initiative, document and lesson answer 404 by the same links while the second's open;
 *   - a switch to a team the person is not in answers 400, writes no event, and the next read answers
 *     the second team still;
 *   - the first team's admin, the second team's admin and the person's two browsers, now acting for
 *     different teams, send forty reads interleaved in one burst: each `/me` answers its own caller's
 *     address and team, each read its own team's rows, and no answer holds another team's words or the
 *     address of a caller outside the reader's team.
 *
 * The only database it touches is the one it started.
 *
 * Exit 0: every read answered its caller's team alone — one line per case, then the final line.
 * Exit 1: a read answered the wrong team, a switch did what it must not, or an answer reached another
 *         caller — the read, the caller and what it held.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { createHash } from "node:crypto";
import type { Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Express, RequestHandler } from "express";
import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import { seedIsolation, seedWork, seedWorkRecord, type Isolation, type WorkRecord } from "../scripts/schema/isolation-seed.ts";
import { signIn } from "../scripts/schema/status-seed.ts";
import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";

import { leaks, queriesFor, send, tally, type Answer, type Sent } from "./console-isolation-work.ts";

const NAME = "console-team-switch";
const DONE = "console-team-switch: a person in two teams read the first team, switched their browser through the " +
  "console's own route with a team.switch event recorded, and every Work, Knowledge, Activity, Runs and Plugins read " +
  "then answered the second team alone, the first team's initiative, document and lesson 404; a switch to a team " +
  "they are not in was refused and changed nothing; two people and the person's two browsers in different teams, " +
  "reading forty requests interleaved at once, were each answered their own identity and their own team's rows, " +
  "and no answer reached another: ok";
const WORK = "/api/console/work/query";
const SWITCH = "/api/console/settings/me/active-team";
/** How long `logEvent`, which does not wait for its write, is given for its row to land. */
const SETTLE_MS = 300;

type Which = "one" | "two";
/** A read, and the own row it must answer when it lists rows: a text the answer holds, or a test of it. */
interface Read { url: string; own?: (t: Which) => string | ((a: Answer) => boolean) }
/** One caller: their cookie, their address, and the team their session acts for. */
interface Caller { label: string; cookie: string; email: string; team: Which }

/** The first team's rows, by what only they hold: the seed's plain words, its slugs and its people.
 *  COUPLED: isolation-seed.ts's `plain`, whose every word begins `first team `. */
function firstMarks(s: Isolation, w: WorkRecord): string[] {
  return ["first team ", s.one.slug, s.one.initiative, s.one.delivered, s.one.email, w.colleague, w.acting,
    ...w.approvals.one.map((p) => p.split("/")[0])];
}

/** The second team's rows, by what only they hold: its sentinels and its admin. */
function secondMarks(s: Isolation, w: WorkRecord): string[] {
  return [...Object.values(s.sentinels), s.two.email, ...w.approvals.two.map((p) => p.split("/")[0])];
}

/** The marks an answer holds that its request did not carry: a refusal that repeats its input discloses nothing. */
function holds(marks: string[], r: Sent, a: Answer): string[] {
  const carried = decodeURIComponent(`${r.url} ${r.body ? JSON.stringify(r.body) : ""}`);
  return marks.filter((m) => a.text.includes(m) && !carried.includes(m));
}

/** The rows a drilled `work/query` answers, or null when it answered none. */
function drilled(a: Answer): number | null {
  try {
    const q = JSON.parse(a.text) as { rows?: { data?: { rows?: unknown[] } } | null };
    return q.rows?.data?.rows?.length ?? null;
  } catch { return null; }
}

/** Every read the switch must move, each with the own row it must answer when it lists rows. */
function reads(s: Isolation): Read[] {
  const team = (t: Which) => (t === "one" ? s.one : s.two);
  // `work/query` refuses a request naming no measure, so it is asked the isolation harness's own questions.
  const [byOutcome, byDocument, byInitiative, drillTwo, drillOne] = queriesFor(WORK, [""], s);
  return [
    { url: "/api/console/home" },
    { url: "/api/console/record?period=all&limit=100" },
    { url: "/api/console/approvals?tab=waiting&limit=100", own: (t) => team(t).initiative },
    { url: "/api/console/approvals?tab=history&limit=100" },
    { url: "/api/console/initiatives?limit=100", own: (t) => team(t).initiative },
    { url: `${WORK}${byOutcome}` },
    { url: `${WORK}${byDocument}` },
    { url: `${WORK}${byInitiative}` },
    // A team's delivered initiative drilled to its rows: one row to its own team, none to the other.
    { url: `${WORK}${drillOne}`, own: (t) => (a) => (drilled(a) ?? 0) === (t === "one" ? 1 : 0) },
    { url: `${WORK}${drillTwo}`, own: (t) => (a) => (drilled(a) ?? 0) === (t === "two" ? 1 : 0) },
    { url: "/api/console/knowledge/summary" },
    { url: "/api/console/knowledge", own: (t) => team(t).node.replace(/^nodes\/1-|\.md$/g, "") },
    { url: "/api/console/activity/summary" },
    { url: "/api/console/activity" },
    { url: "/api/console/runs", own: (t) => team(t).initiative },
    { url: "/api/console/plugins" },
    { url: "/api/console/skills" },
  ];
}

/** A team's initiative, document and lesson, by the links the console opens them at. */
function deepLinks(t: Isolation["one"]): string[] {
  return [`/api/console/initiatives/${t.slug}/${t.initiative}`, `/api/console/document/${t.slug}/${t.initiative}/${t.docPath}`,
    `/api/console/knowledge/${t.slug}/${t.node}`].map((u) => u.split("/").map(encodeURIComponent).join("/"));
}

/** A second console session of `email`'s, acting for `team`: a browser signed in, its team chosen. */
async function sessionFor(sql: pg.Client, email: string, team: string): Promise<string> {
  const secret = await signIn(sql, email);
  await sql.query(
    "update zz.console_session s set team_id = t.id from zz.team t where s.token_hash = $1 and t.slug = $2",
    [createHash("sha256").update(secret, "utf8").digest("hex"), team]);
  return secret;
}

/** The `/api/console` routes the application mounts, from its router, as `<method> <path>`. */
function mounted(app: Express): Set<string> {
  const stack = (app as unknown as { _router: { stack: { route?: { path: unknown; methods: Record<string, boolean> } }[] } })._router.stack;
  const out = new Set<string>();
  for (const { route } of stack) {
    if (!route || typeof route.path !== "string") continue;
    for (const [method, on] of Object.entries(route.methods)) if (on) out.add(`${method} ${route.path}`);
  }
  return out;
}

async function run(c: Core): Promise<void> {
  const s = await seedIsolation(c.sql);
  await seedWork(c.sql, s);
  const w = await seedWorkRecord(c, s);
  const both = (await c.sql.query<{ id: string }>("select id::text as id from zz.principal where email = $1", [s.both])).rows[0].id;
  const browser = { switched: await sessionFor(c.sql, s.both, s.one.slug), stayed: await sessionFor(c.sql, s.both, s.one.slug) };

  process.env.TEAM_DB_URL = c.url;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  process.env.CORE_MCP_URL = c.mcp.url;
  process.env.GATEWAY_PUBLIC_URL = "https://gateway.team-switch.example.test";
  const load = (p: string) => import(pathToFileURL(join(root, "services/gateway/dist", p)).href);
  const express = (await import("express")).default;
  const dbModule = (await load("db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await dbModule.initPlatformDb();
  const { identityMiddleware } = (await load("identity.js")) as { identityMiddleware: () => RequestHandler };
  const { mountConsole } = (await load("console.js")) as { mountConsole: (app: Express) => void };
  const { mountConsoleWrite } = (await load("console-write.js")) as { mountConsoleWrite: (app: Express) => void };
  const { mountSettings } = (await load("settings.js")) as { mountSettings: (app: Express, deps: unknown) => void };
  const credentials = (await load("credentials.js")) as Record<string, unknown>;
  const app = express();
  // COUPLED: services/gateway/src/server.ts — the identity gate, the JSON parser, then the console's
  // reads, its acts and its settings, in that order.
  app.use(identityMiddleware());
  app.use(express.json({ limit: "20mb" }));
  mountConsole(app);
  mountConsoleWrite(app);
  mountSettings(app, { myAccessTokensFor: credentials.myAccessTokensFor, issueMyAccessTokenFor: credentials.issueMyAccessTokenFor,
                       revokeMyAccessTokenFor: credentials.revokeMyAccessTokenFor });
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const found: string[] = [];
  const marks: Record<Which, string[]> = { one: firstMarks(s, w), two: secondMarks(s, w) };
  const sentinels = new Set(Object.values(s.sentinels));
  const other = (t: Which): Which => (t === "one" ? "two" : "one");
  const get = (cookie: string, url: string): Promise<Answer> => send(base, cookie, { method: "get", url, body: null });
  const me = async (cookie: string): Promise<{ email?: string; activeTeam?: string | null }> => {
    const a = await get(cookie, "/api/console/me");
    return a.status === 200 ? JSON.parse(a.text) as { email: string; activeTeam: string | null } : {};
  };
  const switches = async (): Promise<number> => (await c.sql.query<{ n: number }>(
    "select count(*)::int as n from zz.event where kind = 'team.switch' and actor_id = $1::uuid", [both])).rows[0].n;
  const all = reads(s);
  const slug = (t: Which): string => (t === "one" ? s.one.slug : s.two.slug);

  /** Every read as `cookie`, which acts for `t`: 200, the team's own rows, nothing of the other team's. */
  const readsAnswer = async (who: string, cookie: string, t: Which): Promise<void> => {
    const bad: string[] = [];
    const statuses: number[] = [];
    for (const r of all) {
      const req: Sent = { method: "get", url: r.url, body: null };
      const a = await send(base, cookie, req);
      statuses.push(a.status);
      if (a.status !== 200) { bad.push(`${r.url} answered ${a.status}: ${a.text.slice(0, 200)}`); continue; }
      // The second team's sentinels are looked for by `leaks`, which says where each sits.
      const theirs = holds(t === "one" ? marks.two.filter((m) => !sentinels.has(m)) : marks.one, req, a);
      if (theirs.length) bad.push(`${r.url} holds the ${t === "one" ? "second" : "first"} team's ${theirs.join(", ")}`);
      if (t === "one") for (const l of leaks(s, req, a)) bad.push(`${r.url} holds the ${l.field} sentinel at ${l.at}`);
      const own = r.own?.(t);
      if (typeof own === "string" && !a.text.includes(own)) bad.push(`${r.url} does not answer the team's own ${own}`);
      if (typeof own === "function" && !own(a)) bad.push(`${r.url} answered ${a.text.slice(0, 300)}, not the team's own rows alone`);
    }
    if (bad.length) found.push(...bad.map((b) => `${who}: ${b}`));
    else c.pass(`${who}: ${all.length} reads answered ${tally(statuses)}, each ${t === "one" ? "the first" : "the second"} ` +
      "team's own rows and nothing of the other team's");
  };
  /** A team's deep links as `cookie`, each answering `status`. */
  const links = async (who: string, cookie: string, t: Isolation["one"], status: number): Promise<void> => {
    const answered: string[] = [];
    for (const url of deepLinks(t)) {
      const a = await get(cookie, url);
      answered.push(`${url} ${a.status}`);
      if (a.status !== status) found.push(`${who}: ${url} answered ${a.status}, not ${status}: ${a.text.slice(0, 200)}`);
    }
    if (answered.every((x) => x.endsWith(` ${status}`))) c.pass(`${who}: the initiative, document and lesson of ${t.slug} answer ${status}`);
  };

  try {
    let step = "the reads are mounted";
    const routes = mounted(app);
    const paths = [...all.map((r) => r.url), "/api/console/me", "/api/console/initiatives/:team/:slug",
      "/api/console/document/:team/:initiative/*", "/api/console/knowledge/:team/*"].map((u) => `get ${u.split("?")[0]}`);
    const unmounted = [...new Set([...paths, `post ${SWITCH}`])].filter((p) => !routes.has(p));
    if (unmounted.length) c.fail(step, `the application mounts none of ${unmounted.join(", ")}`);
    c.pass(`${step}: ${new Set(paths).size} reads and the switch, each among the application's own routes`);

    step = "work/query naming no measure is refused";
    const none = await get(browser.switched, WORK);
    if (none.status !== 400) found.push(`${step}: answered ${none.status} ${none.text.slice(0, 200)}`);
    else c.pass(`${step}: 400 before anything is read`);

    // Before the switch: both browsers act for the first team, which each session carries itself.
    step = "both of the person's browsers act for the first team";
    const before = await Promise.all([me(browser.switched), me(browser.stayed)]);
    if (before.some((m) => m.email !== s.both || m.activeTeam !== s.one.slug)) c.fail(step, `/me answered ${JSON.stringify(before)}`);
    c.pass(`${step}: /me answers ${s.both} acting for ${s.one.slug} to each`);
    await readsAnswer(`${s.both} before the switch`, browser.switched, "one");
    await links(`${s.both} before the switch`, browser.switched, s.one, 200);

    step = "the switch";
    const from = await switches();
    const switched = await send(base, browser.switched, { method: "post", url: SWITCH, body: { team: s.two.slug } });
    const said = switched.status === 200 ? JSON.parse(switched.text) as Record<string, unknown> : {};
    if (switched.status !== 200 || said.ok !== true || said.actingFor !== s.two.slug || said.from !== s.one.slug) {
      c.fail(step, `answered ${switched.status} ${switched.text.slice(0, 300)}, not acting for ${s.two.slug} from ${s.one.slug}`);
    }
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    const { rows: events } = await c.sql.query<{ subject: string; team: string | null; via: string | null; was: string | null }>(
      `select e.subject, t.slug as team, e.detail->>'via' as via, e.detail->>'from' as was
         from zz.event e left join zz.team t on t.id = e.team_id
        where e.kind = 'team.switch' and e.actor_id = $1::uuid order by e.ts`, [both]);
    const event = events.at(-1);
    if (events.length !== from + 1 || event?.subject !== s.two.slug || event.team !== s.two.slug || event.via !== "web" || event.was !== s.one.slug) {
      c.fail(step, `${events.length - from} team.switch event(s) written, the last ${JSON.stringify(event)}`);
    }
    c.pass(`${step}: 200 acting for the second team from ${s.one.slug}, and one team.switch event of the person's, via web, ` +
      "under the second team");

    // After the switch: the switched browser reads the second team alone, the other browser the first still.
    step = "the switched browser acts for the second team and the other for the first";
    const after = await Promise.all([me(browser.switched), me(browser.stayed)]);
    if (after[0].activeTeam !== s.two.slug || after[1].activeTeam !== s.one.slug) c.fail(step, `/me answered ${JSON.stringify(after)}`);
    c.pass(`${step}: a switch moves the session it was made in and no other`);
    await readsAnswer(`${s.both} after the switch`, browser.switched, "two");
    await links(`${s.both} after the switch`, browser.switched, s.one, 404);
    await links(`${s.both} after the switch`, browser.switched, s.two, 200);
    await readsAnswer(`${s.both}'s other browser`, browser.stayed, "one");

    step = "a switch to a team the person is not in";
    const refused = await send(base, browser.switched, { method: "post", url: SWITCH, body: { team: c.team } });
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    const still = await me(browser.switched);
    const written = await switches();
    if (refused.status !== 400 || still.activeTeam !== s.two.slug || written !== from + 1) {
      found.push(`${step}: answered ${refused.status} ${refused.text.slice(0, 200)}, /me then acting for ${still.activeTeam}, ` +
        `${written - from} team.switch event(s) in all`);
    } else c.pass(`${step}, ${c.team}: 400, no event written, and the next read still acts for the second team`);

    // Forty reads at once, round-robin across four callers in two teams.
    step = "forty reads interleaved";
    const callers: Caller[] = [
      { label: "the first team's admin", cookie: s.cookies.one, email: s.one.email, team: "one" },
      { label: "the second team's admin", cookie: s.cookies.two, email: s.two.email, team: "two" },
      { label: `${s.both}'s switched browser`, cookie: browser.switched, email: s.both, team: "two" },
      { label: `${s.both}'s other browser`, cookie: browser.stayed, email: s.both, team: "one" },
    ];
    const mixed = ["/api/console/me", ...["/api/console/initiatives?limit=100", "/api/console/knowledge", "/api/console/activity",
      "/api/console/runs", `${WORK}${queriesFor(WORK, [""], s)[2]}`, "/api/console/knowledge/summary",
      "/api/console/activity/summary", "/api/console/home", "/api/console/approvals?tab=waiting&limit=100"]];
    const burst = Array.from({ length: 40 }, (_, i) => ({ caller: callers[i % callers.length], url: mixed[Math.floor(i / callers.length) % mixed.length] }));
    const answers = await Promise.all(burst.map(({ caller, url }) => send(base, caller.cookie, { method: "get", url, body: null })));
    const bad: string[] = [];
    burst.forEach(({ caller, url }, i) => {
      const a = answers[i];
      const req: Sent = { method: "get", url, body: null };
      if (a.status !== 200) { bad.push(`${caller.label} ${url} answered ${a.status}: ${a.text.slice(0, 200)}`); return; }
      // An address of a caller outside the reader's team. The person in both teams is in either, and their
      // switch is the second team's activity, so either team's reads may name them.
      const strangers = callers.filter((o) => o.email !== s.both && o.team !== caller.team).map((o) => o.email);
      const seen = holds(strangers, req, a);
      if (seen.length) bad.push(`${caller.label} ${url} holds ${seen.join(", ")}`);
      if (url === "/api/console/me") {
        const m = JSON.parse(a.text) as Record<string, unknown>;
        if (m.email !== caller.email || m.activeTeam !== slug(caller.team)) {
          bad.push(`${caller.label} /me answered ${String(m.email)} acting for ${String(m.activeTeam)}`);
        }
        return;
      }
      const theirs = holds(marks[other(caller.team)], req, a);
      if (theirs.length) bad.push(`${caller.label} ${url} holds the other team's ${theirs.join(", ")}`);
      const own = (caller.team === "one" ? s.one : s.two).initiative;
      if (url.startsWith("/api/console/initiatives") && !a.text.includes(own)) bad.push(`${caller.label} ${url} does not answer ${own}`);
    });
    if (bad.length) found.push(...bad.map((b) => `${step}: ${b}`));
    else c.pass(`${step}: ${answers.length} answered ${tally(answers.map((a) => a.status))}, each /me its own caller's address ` +
      "and team, each read its own team's rows, none holding another team's words or a stranger's address");

    if (found.length) c.fail("team switch", `\n    ${found.join("\n    ")}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await dbModule.platformDb().end().catch(() => undefined);
    delete process.env.TEAM_DB_URL;
    delete process.env.CORE_MCP_URL;
    delete process.env.ZZ_CATALOG_DIR;
    delete process.env.GATEWAY_PUBLIC_URL;
  }
}

process.exitCode = await withThrowawayCore(NAME, DONE, run);
