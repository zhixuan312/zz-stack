#!/usr/bin/env node
/**
 * checks/console-isolation.ts — a member of one team asks everything the console answers and finds
 * nothing of another team's, through the gateway's whole console on a real database and a real zz-core
 * (AC-1.14, AC-1.15, AC-4.4, AC-4.5, AC-4.7, AC-5.10, AC-6.6).
 *
 *   node checks/console-isolation.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL and a real zz-core on it (`withThrowawayCore`), seeds what
 * `scripts/schema/isolation-seed.ts` declares (two teams of the same rows, the second's free text
 * sentinels generated afresh for this run, among them the bodies of the events `PLANTED` names; a person
 * in both teams, who is data and never a reader; real-work calls of both teams, where the record begins;
 * and three people signed in with real console sessions), then what `seedWorkRecord` makes through
 * zz-core for Work (a second person on the first team and a superadmin acting for it, both signed in,
 * approvals and tokens of their own, runs, and initiatives to close), and an application the second team's admin
 * holds a token of, and serves the gateway's built identity
 * middleware, JSON parser, `mountConsole`, `mountConsoleWrite` and `mountSettings` from this process in
 * server.ts's order. The routes are read from that
 * application's own router, so a route added later is asked without editing this file, and every
 * `/api/console` route the gateway's source declares must be among them. What it establishes:
 *
 *   - the first team's member asks every GET route with the second team's slugs and ids in its path
 *     parameters, with `?team=` and `?scope=platform` forged, with their own team named, and with the
 *     second team's text as the question; no answer, error body or stream frame holds any of the second
 *     team's sentinels, and every `href` in those answers is null or one of the released Platform pages every person opens (Bugs, Evaluation, Usage). A sentinel the request itself carried is not looked for
 *     in its own answer: a refusal that repeats the caller's input discloses nothing new. Instead each
 *     request naming the second team's team, initiative, node, person, plugin or ids is sent again
 *     naming a phantom of the same shape no team holds, and the two answers, those names and every
 *     instant masked, must be alike: a member does not learn that another team's thing exists;
 *   - with each read's table renamed from `tableFor`'s map, each read answers again and its error body
 *     holds no sentinel; a read the map does not name is listed as not reached, and the map names every
 *     Fleet read; the reads refused to a member (Teams, a team, People, Audit) answer one body, 403 and
 *     naming nobody, to every request in both rounds; and, in `console-isolation-failures.ts`'s part, the
 *     reads that answer another team's address before reading anything (Work's initiative and document),
 *     the shared lesson, the shelf, the search and each settings read with a table of its own, asked at
 *     the member's own addresses, each answer their own error body with that table renamed while every
 *     read beside them that reads no such table answers as before, and the settings reads with no table
 *     of their own and `live` are listed unreachable with why;
 *   - the member's direct request to every POST, PUT, PATCH and DELETE route, with the second team's
 *     ids (its admin's application and signed-in browser among them, for Access's revokes), forged
 *     parameters and a body naming the second team's rows, is refused, or answers as the member's own
 *     act, and no row of the second team's changes, its admin's tokens, browsers and passkeys among them;
 *     a refusal answers alike about a phantom;
 *   - the second team's member reads their own rows, their search by text finding their own document
 *     or node, their Usage and Knowledge health name no team and no question, not even their own; the
 *     superadmin's reads hold every sentinel but a finding's decision note and owner reference, which the
 *     platform's evaluation never selects, a lesson's title and body and its entry in the knowledge log, which Work
 *     answers to its own team alone, and
 *     the planted event bodies; the database holds all of them intact;
 *   - the superadmin's Audit, reaching every planted row, holds the second team's slug and none of its
 *     other sentinels, and their Knowledge health holds the question that found nothing and, of the
 *     rest, only the slug its shelves and questions are named by;
 *   - Work, in `console-isolation-work.ts`'s rounds: every measure of `work/query` by every dimension,
 *     drilled to rows, and Home, Record, Approvals and Initiatives hold nothing of the second team's for
 *     the member or the superadmin acting for the first team; a close aimed at the second team's
 *     initiative is 404 and closes nothing; each person reads only the approvals signed in their own
 *     name and only their own tokens, a second person on the same team included, who in Access finds
 *     none of the first's tokens, applications, browsers or passkeys and whose revoke of the first's
 *     application or browser is 404 and changes nothing. `work/query` is asked with measures here too,
 *     since a request naming none is refused before anything is read. Over `seedSharedCitations`'s rows,
 *     a superadmin acting for either team reads only their own team's initiative and document however
 *     asked, and every reader of the shared lesson citing both teams' initiatives, the shelf and the search
 *     is named their own team's and counts the other's;
 *   - the Platform prepared query, in `console-platform-query-isolation.ts`'s round: every measure a member is answered,
 *     by every dimension and bucket but the superadmin's, from the first recorded day, against the window before,
 *     every group drilled where the measure is, holds nothing of the second team's and no link for the first team's
 *     member, and every measure, dimension, filter or drill only the superadmin is shown answers them the one 403
 *     body naming nobody. Its failure round asks it a measure, since a request naming none is refused before anything
 *     is read.
 *
 * The other direction, the second team's member and a superadmin acting for that team asking Phase 4's
 * destinations about the first team's sentinels, is `checks/console-isolation-destinations.ts`.
 *
 * What each planted row can move of the figures a seed beside this one asserts is `MOVES`, said once
 * the seed is read back.
 *
 * The only database it touches is the one it started.
 *
 * Exit 0: every route held for every person — one line per route and person, then the final line.
 * Exit 1: a sentinel was found, a write changed the second team's rows, or a case failed — the route,
 *         the person and the field.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Mcp } from "@zz/mcp-client";
import type { Express, RequestHandler } from "express";
import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import { PLANTED, seedIsolation, seedSharedCitations, seedWork, seedWorkRecord } from "../scripts/schema/isolation-seed.ts";
import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";

import { ownFailures, tableFor } from "./console-isolation-failures.ts";
import { failureQuery, hrefs, leaks, queriesFor, routesOf, send, tally, workRounds, type Answer, type Route, type Sent } from "./console-isolation-work.ts";
import { PLATFORM_QUERY, platformFailureQuery, platformQueryRound } from "./console-platform-query-isolation.ts";

const NAME = "console-isolation";
const DONE = "console-isolation: a member of one team asked every route the mounted console answers, with the other " +
  "team's slugs and ids and a forged team and scope, and no answer, error, stream or link held anything of the other " +
  "team's, a colleague in both teams included, or answered otherwise than about a team nobody has; the reads refused " +
  "to a member answered one body naming nobody; every write was refused or the member's own and " +
  "changed nothing of the other team's; the other team's member and the superadmin still read it, and the " +
  "superadmin's Audit and Knowledge health held no body but the question that found nothing; Work, every measure by " +
  "every dimension drilled to rows but skill_calls, a close and a superadmin acting for their own team included, held nothing of the " +
  "other team's, and a second person on the same team read only their own approvals and tokens and, in Access, none of " +
  "the first's tokens, applications, browsers or passkeys, their revokes of the first's 404; a superadmin acting for either team " +
  "read only their own team's initiative and document, and every reader of a shared lesson citing both teams was named their own " +
  "team's initiative alone; the platform query, every measure " +
  "a member is answered by every dimension drilled, held nothing of the other team's and refused the superadmin's alike: ok";
/** Fields the platform's evaluation read never selects, so no superadmin read need answer them: the database
 *  is asked for them instead. COUPLED: platform-evaluation.ts. */
const NOBODY_READS = ["decisionNote", "ownerRef"];
/** What the second team's member must find of their own through their own Work reads, and the search that
 *  must find their own document or node by its text: what a member of the first team's would be shown. */
const OWN_READS = ["slug", "initiative", "docTitle", "docBody", "nodeTitle", "nodeBody", "eventDetail"];
/** Fields only Work answers, the active team's for a superadmin too: the superadmin, who acts for no team, need
 *  not read them, and the second team's own member does (OWN_READS). The open initiative's slug and its
 *  document's title and body are among them: Work's detail routes were where the superadmin read them, and no
 *  Platform read names them. */
const WORK_ONLY = ["nodeTitle", "nodeBody", "eventDetail", "initiative", "docTitle", "docBody"];
const SEARCH = "/api/console/search";
const WRITES = ["post", "put", "patch", "delete"];
/** Fleet's reads, each of which the failure round must reach. */
const FLEET = ["/api/console/teams", "/api/console/teams/:slug", "/api/console/people", "/api/console/platform/usage",
  "/api/console/platform/audit", "/api/console/platform/knowledge"];
/** The reads a member is refused before anything is read, with one body for every request. */
const REFUSED = ["/api/console/teams", "/api/console/teams/:slug", "/api/console/people", "/api/console/platform/audit"];
/** The member's projections that name no team and no question, the member's own included. */
const NAMES_NONE = ["/api/console/platform/usage", "/api/console/platform/knowledge"];
const AUDIT = "/api/console/platform/audit";
const HEALTH = "/api/console/platform/knowledge";
/** What each planted row can move of the figures a seed beside this one asserts (the skeleton's malformed-call
 *  rate for the last whole week among them), and what it cannot. Every row is dated in the running week. */
const MOVES: Record<(typeof PLANTED)[number]["kind"], string> = {
  "knowledge.search": "a real-work search that found nothing: the searches figures, Status's share that found " +
    "something and Knowledge health's, and never the malformed-call rate, which counts calls",
  tool_call: "a refused maintenance call: Usage's maintenance traffic and refusals and the team's own Work overview, " +
    "which counts every call, and no real-work figure, the malformed-call rate among them",
  bug_report: "no figure, which count the reports themselves",
  "bug.delete": "an act Audit lists, and no figure",
  "knowledge.create": "no figure, which count the lessons and their knowledge.add events",
  "document.write": "no figure, which read the revisions waiting from the revisions",
  "upload.start": "no figure",
  "admin.issue_pat": "an act Audit lists, and no figure",
};

type Seeded = Awaited<ReturnType<typeof seedIsolation>>;
/** The second team's admin's application and signed-in browser: what Access's two revokes are aimed at. */
interface Holdings { client: string; browser: string }

/** An OAuth client the second team's admin holds a token of, and the id of their signed-in browser. */
async function secondTeamHoldings(sql: pg.Client, s: Seeded): Promise<Holdings> {
  const client = `isolation-client-${randomBytes(8).toString("hex")}`;
  await sql.query("insert into zz.mcp_oauth_client (client_id, redirect_uris, name) values ($1, '[]'::jsonb, 'Isolation client')", [client]);
  await sql.query(
    `insert into zz.pat (principal_id, token_hash, label, oauth_client_id)
     select id, $2, 'mcp oauth isolation', $3 from zz.principal where email = $1`, [s.two.email, randomBytes(32).toString("hex"), client]);
  const { rows: [b] } = await sql.query<{ id: string }>(
    `select c.id::text as id from zz.console_session c join zz.principal p on p.id = c.principal_id
      where p.email = $1 order by c.issued_at limit 1`, [s.two.email]);
  return { client, browser: b.id };
}

/** Every `/api/console` route the gateway's source declares, as `<method> <path>`. */
function declared(): string[] {
  const dir = join(root, "services/gateway/src");
  const out: string[] = [];
  for (const f of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    if (!f.endsWith(".ts")) continue;
    const text = readFileSync(join(dir, f), "utf8");
    for (const m of text.matchAll(/\bapp\.(get|post|put|patch|delete)\(\s*"(\/api\/console[^"]*)"/g)) out.push(`${m[1]} ${m[2]}`);
  }
  return out;
}

/** Each address a route's path takes with the second team's values in its parameters: a team slug, an
 *  initiative, a document or node address, a report, token, finding or browser id, an application, a plugin.
 *  A parameter this does not know by name takes every one of them. */
function addresses(path: string, s: Seeded, h: Holdings): string[] {
  const { one, two } = s;
  const fill: Record<string, string[]> = {
    team: [two.slug, one.slug],
    slug: [two.slug, two.initiative, two.delivered],
    initiative: [two.initiative, two.delivered],
    "*": [two.docPath, two.node, `${two.initiative}/${two.docPath}`],
    id: [two.bugs.fixed, two.bugs.open, two.tokenId, two.finding, h.browser],
    client: [h.client],
    plugin: [two.plugin],
    version: ["0.99.0"],
  };
  const every = [...new Set(Object.values(fill).flat())];
  let out = [""];
  for (const part of path.split(/(:\w+|\*)/).filter(Boolean)) {
    const name = part === "*" ? "*" : part.startsWith(":") ? part.slice(1) : null;
    const values = name === null ? [part] : (fill[name] ?? every).map((v) => (name === "*" ? v : encodeURIComponent(v)));
    out = out.flatMap((head) => values.map((v) => head + v));
  }
  return out;
}

/** The queries every read is asked with: none, a forged team, a forged scope, both, the asker's own team
 *  named, which reaches the reads that list a team's people, and the second team's text as the question,
 *  alongside its initiative and plugin. The question is a sentinel's random half, which a search matches as a
 *  word of it, so the question a search records is never a whole sentinel itself; the seed begins that half with
 *  a letter, which is what makes the match certain. COUPLED: isolation-seed.ts's `sentinels`. */
function readQueries(s: Seeded): string[] {
  const { one, two, sentinels: x } = s;
  const probe = (v: string) => `?q=${v.slice(v.indexOf("-") + 1)}&initiative=${encodeURIComponent(two.initiative)}` +
    `&plugin=${two.plugin}&kind=knowledge.add&collections=knowledge,initiatives,document,teams,activity`;
  return ["", `?team=${two.slug}`, "?scope=platform", `?team=${two.slug}&scope=platform`, `?team=${one.slug}`,
    probe(x.docBody), probe(x.nodeBody)];
}

/** The body every write is sent: each field a route might read, naming the second team's rows. */
function forgedBody(s: Seeded): Record<string, unknown> {
  const { two } = s;
  return {
    team: two.slug, slug: two.slug, initiative: two.initiative, path: two.docPath, email: two.email,
    id: two.bugs.open, token: two.tokenId, label: "forged", name: "forged", role: "admin",
    content_revision: "1", expected_revision: "1", review_context: `rc_${"a".repeat(26)}`,
    status: "fixed", resolution: "Closed by another team.", duplicate_of: two.bugs.fixed,
    feature: "platform-status", workspace: "platform",
  };
}

/** Every row of the second team's, hashed: the team, its admin and their tokens, browsers, passkeys and memberships, its
 *  initiatives, documents and revisions, reports, plugins, protocols, measures, runs and findings, nodes,
 *  and every event naming the team or its admin. */
async function secondTeamRows(sql: pg.Client, s: Seeded): Promise<string> {
  const { rows } = await sql.query<{ h: string }>(
    `with t as (select id from zz.team where slug = $1), p as (select id from zz.principal where email = $2),
          i as (select id from zz.initiative where team_id = (select id from t)),
          pl as (select id from zz.plugin where owner_team_id = (select id from t)),
          pv as (select id from zz.eval_protocol_version where plugin_id in (select id from pl)),
          r as (select id from zz.eval_run where team_id = (select id from t))
     select md5(coalesce(string_agg(x, '|' order by x), '')) as h from (
       select 'team ' || x::text from zz.team x where x.id = (select id from t)
       union all select 'principal ' || x::text from zz.principal x where x.id = (select id from p)
       union all select 'membership ' || x::text from zz.membership x where x.team_id = (select id from t) or x.principal_id = (select id from p)
       union all select 'pat ' || x::text from zz.pat x where x.principal_id = (select id from p)
       union all select 'session ' || x::text from zz.console_session x where x.principal_id = (select id from p)
       union all select 'passkey ' || x::text from zz.passkey x where x.principal_id = (select id from p)
       union all select 'initiative ' || x::text from zz.initiative x where x.id in (select id from i)
       union all select 'doc ' || x::text from zz.doc x where x.initiative_id in (select id from i)
       union all select 'revision ' || x::text from zz.doc_revision x join zz.doc d on d.id = x.doc_id where d.initiative_id in (select id from i)
       union all select 'bug ' || x::text from zz.bug x where x.team_id = (select id from t)
       union all select 'plugin ' || x::text from zz.plugin x where x.id in (select id from pl)
       union all select 'protocol ' || x::text from zz.eval_protocol_version x where x.id in (select id from pv)
       union all select 'measure ' || x::text from zz.eval_measure x where x.protocol_version_id in (select id from pv)
       union all select 'run ' || x::text from zz.eval_run x where x.id in (select id from r)
       union all select 'finding ' || x::text from zz.eval_finding x where x.eval_run_id in (select id from r)
       union all select 'node ' || x::text from zz.knowledge_node x where x.team_id = (select id from t)
       union all select 'event ' || x::text from zz.event x where x.team_id = (select id from t) or x.actor_id = (select id from p)
     ) s(x)`, [s.two.slug, s.two.email]);
  return rows[0].h;
}

/** Every sentinel the second team's rows hold, read back from the database as one text. */
async function storedText(sql: pg.Client, s: Seeded): Promise<string> {
  const { rows } = await sql.query<{ all: string }>(
    // `zz.doc` keeps no copy of a document's bytes: the body is the revision's, and `r` below is
    // every revision of the document, so `r.body` covers what `d.body` used to add.
    `select concat_ws(' ', t.slug, t.name, i.slug, d.title, r.title, r.body, b.title, b.detail, b.surface, b.resolution,
                      f.pattern, f.decision_note, f.owner_ref, pv.protocol_key, m.key, e.detail::text, k.title, k.body) as all
       from zz.team t
       join zz.initiative i on i.team_id = t.id and i.closed_at is null
       join zz.doc d on d.initiative_id = i.id
       join zz.doc_revision r on r.doc_id = d.id
       join zz.bug b on b.team_id = t.id and b.status = 'fixed'
       join zz.eval_run er on er.team_id = t.id
       join zz.eval_finding f on f.eval_run_id = er.id
       join zz.eval_protocol_version pv on pv.id = er.protocol_version_id
       join zz.eval_measure m on m.id = f.measure_id
       join zz.knowledge_node k on k.team_id = t.id
       join zz.event e on e.team_id = t.id and e.kind = 'knowledge.add' and e.subject = '1'
      where t.slug = $1 and i.slug = $2
      order by e.ts limit 1`, [s.two.slug, s.two.initiative]);
  // The planted rows' free text, in the column or detail key each kind keeps it in.
  const planted = await sql.query<{ all: string | null }>(
    `select string_agg(concat_ws(' ', e.subject, e.refusal, e.detail->>'title', e.detail->>'detail', e.detail->>'details',
                                 e.detail->>'filename', e.detail->>'label'), ' ') as all
       from zz.event e where e.kind = any($1::text[])`, [PLANTED.map((p) => p.kind)]);
  return `${rows[0]?.all ?? ""} ${planted.rows[0]?.all ?? ""}`;
}

/** The second team's identifiers a request can name, its plugin's and its admin's application among them, each
 *  paired with a phantom of the same shape that no team holds and the label both are masked by. */
function phantoms(s: Seeded, h: Holdings): [string, string, string][] {
  const hex = (): string => randomBytes(8).toString("hex");
  return [
    [s.two.slug, `slug-${hex()}`, "[team]"],
    [s.sentinels.initiative, `initiative-${hex()}`, "[initiative]"],
    [s.two.node, "nodes/1-nobodys-lesson.md", "[node]"],
    [s.two.email, "nobody@isolation.example.test", "[person]"],
    [s.two.plugin, `isolation-${hex()}-plugin`, "[plugin]"],
    [h.client, `isolation-client-${hex()}`, "[client]"],
    ...[s.two.bugs.fixed, s.two.bugs.open, s.two.tokenId, s.two.finding, h.browser].map((id): [string, string, string] => [id, randomUUID(), "[id]"]),
  ];
}

/** The request with every one of the second team's identifiers swapped for its phantom, or null when it names
 *  none of them. */
function ghostOf(r: Sent, pairs: [string, string, string][]): Sent | null {
  const swap = (text: string): string => pairs.reduce((t, [real, ghost]) => t.replaceAll(real, ghost), text);
  const url = swap(r.url);
  const body = r.body ? JSON.parse(swap(JSON.stringify(r.body))) as Record<string, unknown> : null;
  return url === r.url && JSON.stringify(body) === JSON.stringify(r.body) ? null : { method: r.method, url, body };
}

/** An answer with the request's own identifiers, real or phantom, and every instant masked: what is left is
 *  what the answer says about whether the thing named exists. */
function masked(a: Answer, pairs: [string, string, string][]): string {
  // The five fields `read-envelope.ts` stamps describe the request that asked: two requests legitimately differ in
  // them — `revision` moves when a hint arrives between the two — so an existence oracle is compared on what the
  // answers SAY. Their values are proven by checks/console-read-envelope.ts and console-read-contract.ts.
  const text = pairs.reduce((t, [real, ghost, label]) => t.replaceAll(real, label).replaceAll(ghost, label), a.text)
    .replace(/"(?:observedAt|revision|cacheHit|builtAt|sourceRevision)":(?:"(?:[^"\\]|\\.)*"|true|false|null)/g, "");
  return `${a.status} ${text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<instant>")}`;
}

async function run(c: Core): Promise<void> {
  const s = await seedIsolation(c.sql);
  await seedWork(c.sql, s);
  const w = await seedWorkRecord(c, s);
  const cited = await seedSharedCitations(c.sql, s);
  const holds = await secondTeamHoldings(c.sql, s);
  const who = {
    one: { label: "the first team's member", cookie: s.cookies.one },
    two: { label: "the second team's member", cookie: s.cookies.two },
    superadmin: { label: "the superadmin", cookie: s.cookies.superadmin },
  };
  // The documents and nodes indexed as zz-core indexes them, so a search can find them: the reindex is the
  // superadmin's, through the door's own admin headers.
  const admin = new Mcp(c.mcp.url, { client: NAME, timeoutMs: 60_000, headers: {
    "x-zz-user-email": s.superadmin, "x-zz-user-name": "Isolation superadmin", "x-zz-user-id": "",
    "x-zz-user-role": "admin", "x-zz-via": "forwarded", "x-zz-pat-team": "", "x-zz-session-team": "" } });
  await c.ok("reindex", "knowledge_reindex", { force: true }, admin);

  process.env.TEAM_DB_URL = c.url;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  // The console's acts and its search reach zz-core here, the harness's own child.
  process.env.CORE_MCP_URL = c.mcp.url;
  // The client setup names the address people reach the gateway at; without one it answers 500.
  process.env.GATEWAY_PUBLIC_URL = "https://gateway.isolation.example.test";
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
  const pairs = phantoms(s, holds);
  /** The same request about a team nobody has: a refusal that differs tells the member the second team's
   *  thing exists. Answers the difference, or null. */
  const oracle = async (r: Sent, a: Answer, during?: () => Promise<void>, cookie = who.one.cookie): Promise<string | null> => {
    const ghost = ghostOf(r, pairs);
    if (!ghost) return null;
    const g = await send(base, cookie, ghost, during);
    const [real, none] = [masked(a, pairs), masked(g, pairs)];
    return real === none ? "" : `an existence oracle: ${r.url} answered ${real.slice(0, 240)}; the same about nothing ` +
      `that exists, ${ghost.url}, answered ${none.slice(0, 240)}`;
  };
  const line = (person: string, r: Route, verdict: string): void => console.log(`  ${person} ${r.method.toUpperCase()} ${r.path}: ${verdict}`);
  /** Another `knowledge.add` of the second team's, while a stream is open: what a change hint would carry. */
  const poke = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 300));
    await c.sql.query(
      `insert into zz.event (ts, kind, subject, detail, origin, team_id, actor_id)
       select now(), 'knowledge.add', '1', $2::jsonb, 'work', t.id, p.id from zz.team t, zz.principal p where t.slug = $1 and p.email = $3`,
      [s.two.slug, JSON.stringify({ title: s.sentinels.eventDetail }), s.two.email]);
  };

  try {
    let step = "the routes";
    const routes = routesOf(app);
    const mounted = new Set(routes.map((r) => `${r.method} ${r.path}`));
    const missing = declared().filter((d) => !mounted.has(d));
    if (missing.length) c.fail(step, `the gateway's source declares routes this application does not mount: ${missing.join(", ")}`);
    const reads = routes.filter((r) => r.method === "get");
    const writes = routes.filter((r) => WRITES.includes(r.method));
    if (reads.length < 30 || writes.length < 10) c.fail(step, `${reads.length} reads and ${writes.length} writes read from the router`);
    if (!reads.some((r) => r.path === PLATFORM_QUERY)) c.fail(step, `${PLATFORM_QUERY} is not among the reads the router answers`);
    c.pass(`${step}: ${reads.length} reads and ${writes.length} writes read from the mounted application, every one the gateway's source declares`);

    step = "the second team's rows as seeded";
    const stored = await storedText(c.sql, s);
    const absent = Object.entries(s.sentinels).filter(([, v]) => !stored.includes(v)).map(([f]) => f);
    if (absent.length) c.fail(step, `the seed did not store ${absent.join(", ")}`);
    const teamsOf = (await c.sql.query<{ slug: string }>(
      `select t.slug from zz.membership m join zz.team t on t.id = m.team_id join zz.principal p on p.id = m.principal_id
        where p.email = $1 order by t.slug`, [s.both])).rows.map((r) => r.slug);
    if (![s.one.slug, s.two.slug].every((t) => teamsOf.includes(t))) c.fail(step, `${s.both} is in ${teamsOf.join(", ") || "no team"}, not both`);
    c.pass(`${step}: every one of ${Object.keys(s.sentinels).length} sentinels is stored in its field, and ${s.both} is in both teams`);
    c.pass(`the planted rows, dated in the running week, and what each can move: ` +
      PLANTED.map((p) => `${p.kind}'s ${p.at} (${MOVES[p.kind]})`).join("; "));

    // The first team's member: nothing of the second team's, in any read, however asked.
    let links = 0;
    /** Every answer a refused read gave the member, in both rounds, as `<status> <body>`. */
    const refusals = new Map<string, Set<string>>();
    const refused = (r: Route, a: Answer): void => {
      if (REFUSED.includes(r.path)) refusals.set(r.path, (refusals.get(r.path) ?? new Set()).add(`${a.status} ${a.text}`));
    };
    for (const r of reads) {
      const statuses: number[] = [];
      const bad: string[] = [];
      let compared = 0;
      for (const address of addresses(r.path, s, holds)) {
        for (const query of queriesFor(r.path, readQueries(s), s)) {
          const req: Sent = { method: r.method, url: `${address}${query}`, body: null };
          const a = await send(base, who.one.cookie, req, poke);
          statuses.push(a.status);
          refused(r, a);
          for (const l of leaks(s, req, a)) bad.push(`the ${l.field} sentinel in ${req.url} (${a.status}) at ${l.at}`);
          const h = hrefs(a.text);
          links += h.count;
          for (const set of h.set) bad.push(`a link in ${req.url}: ${set}`);
          const differs = await oracle(req, a, poke);
          if (differs !== null) compared++;
          if (differs) bad.push(differs);
        }
      }
      line(who.one.label, r, bad.length ? bad.join("; ")
        : `ok, ${statuses.length} requests answered ${tally(statuses)}, ${compared} answered alike about a team nobody has`);
      found.push(...bad.map((b) => `${who.one.label} GET ${r.path}: ${b}`));
    }
    c.pass(`every link in the first team's member's answers is null or opens Bugs, Evaluation or Usage, which name no team: ${links} of them`);
    step = "the comparison tells existence apart";
    const team: Sent = { method: "get", url: `/api/console/teams/${s.two.slug}?scope=platform`, body: null };
    const told = await oracle(team, await send(base, who.superadmin.cookie, team), undefined, who.superadmin.cookie);
    if (!told) c.fail(step, `the superadmin's ${team.url} and a team nobody has answered alike, so a member's alike answers prove nothing`);
    c.pass(`${step}: the superadmin, who may know, is answered differently about the second team and a team nobody has`);

    // The same reads with their table gone: an error body holds nothing either.
    step = "the failure round reaches every Fleet read";
    const unreached = FLEET.filter((p) => !reads.some((r) => r.path === p) || tableFor(p, PLATFORM_QUERY) === null);
    if (unreached.length) c.fail(step, `${unreached.join(", ")} not mounted or named by no table`);
    c.pass(`${step}: ${FLEET.map((p) => `${p} by zz.${tableFor(p, PLATFORM_QUERY)}`).join(", ")}`);
    for (const r of reads) {
      const table = tableFor(r.path, PLATFORM_QUERY);
      if (!table) { line(who.one.label, r, "not reached by the failure round: the map names no table for it"); continue; }
      const statuses: number[] = [];
      const bad: string[] = [];
      await c.sql.query(`alter table zz.${table} rename to ${table}_isolation_hidden`);
      // The gateway logs each failed read's cause; what matters here is what the member was answered.
      const quiet = console.error;
      console.error = () => undefined;
      try {
        for (const address of addresses(r.path, s, holds)) {
          const req: Sent = { method: r.method, url: `${address}${r.path === PLATFORM_QUERY ? platformFailureQuery() : failureQuery(r.path, s)}`, body: null };
          const a = await send(base, who.one.cookie, req);
          statuses.push(a.status);
          refused(r, a);
          for (const l of leaks(s, req, a)) bad.push(`the ${l.field} sentinel in ${req.url} (${a.status}) at ${l.at}`);
        }
      } finally {
        console.error = quiet;
        await c.sql.query(`alter table zz.${table}_isolation_hidden rename to ${table}`);
      }
      line(who.one.label, r, bad.length ? bad.join("; ")
        : `ok with zz.${table} renamed, answered ${tally(statuses)}`);
      found.push(...bad.map((b) => `${who.one.label} GET ${r.path} with zz.${table} renamed: ${b}`));
    }
    await ownFailures({ s, cited, base, sql: c.sql, reads, found, pass: c.pass });
    step = "the member's refused reads answer one body";
    const bodies = new Set([...refusals.values()].flatMap((b) => [...b]));
    const [body] = bodies;
    const names = [s.one.slug, s.two.slug, s.one.email, s.two.email, s.both, s.superadmin, ...Object.values(s.sentinels)];
    const unasked = REFUSED.filter((p) => !refusals.has(p));
    if (unasked.length || bodies.size !== 1 || !body.startsWith("403 ") || names.some((n) => body.includes(n))) {
      found.push(`${step}: ${unasked.length ? `${unasked.join(", ")} never asked; ` : ""}answered ${[...bodies].join(" | ").slice(0, 600)}`);
    } else c.pass(`${step}: ${REFUSED.join(", ")} answered ${body} to every request, the failure round's included, naming nobody`);

    // Every write, sent directly: refused, or the member's own, and the second team's rows unchanged. Read
    // after the rounds above, whose streams were told of one more event of the second team's each.
    const before = await secondTeamRows(c.sql, s);
    const member = (await c.sql.query<{ id: string; team: string }>(
      "select id::text as id, active_team_id::text as team from zz.principal where email = $1", [s.one.email])).rows[0];
    for (const r of writes) {
      const outcomes: string[] = [];
      const bad: string[] = [];
      let compared = 0;
      for (const address of addresses(r.path, s, holds)) {
        for (const query of ["", `?team=${s.two.slug}`, "?scope=platform"]) {
          const req: Sent = { method: r.method, url: `${address}${query}`, body: forgedBody(s) };
          const from = (await c.sql.query<{ now: string }>("select clock_timestamp()::text as now")).rows[0].now;
          const a = await send(base, who.one.cookie, req);
          for (const l of leaks(s, req, a)) bad.push(`the ${l.field} sentinel in ${req.url} (${a.status}) at ${l.at}`);
          if (a.status < 300) {
            // `logEvent` does not wait for its write: the act's row is given a moment to land.
            await new Promise((resolve) => setTimeout(resolve, 300));
            const { rows } = await c.sql.query<{ n: number }>(
              `select count(*)::int as n from zz.event where ts >= $1::timestamptz
                 and (actor_id is distinct from $2::uuid or (team_id is not null and team_id <> $3::uuid))`, [from, member.id, member.team]);
            if (rows[0].n) bad.push(`${req.url} answered ${a.status} and recorded ${rows[0].n} event(s) not the member's own`);
          }
          outcomes.push(a.status < 300 ? `${a.status} as the member's own` : `refused ${a.status}`);
          // A refusal only: an act the member may make answers with what it made, which no phantom repeats.
          const differs = a.status < 300 ? null : await oracle(req, a);
          if (differs !== null) compared++;
          if (differs) bad.push(differs);
          if (await secondTeamRows(c.sql, s) !== before) bad.push(`${req.url} (${a.status}) changed the second team's rows`);
        }
      }
      line(who.one.label, r, bad.length ? bad.join("; ")
        : `ok, ${tally(outcomes)}, ${compared} refused alike about a team nobody has, nothing of the second team's changed`);
      found.push(...bad.map((b) => `${who.one.label} ${r.method.toUpperCase()} ${r.path}: ${b}`));
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (await secondTeamRows(c.sql, s) !== before) found.push(`${who.one.label}: the second team's rows changed once every write had landed`);

    // The second team's member and the superadmin: the sentinels are there to be read.
    const seen = { two: new Set<string>(), superadmin: new Set<string>() };
    // AC-4.6: Knowledge health is the one cross-team page that gives a search's question to the superadmin.
    const questionAt = new Set<string>();
    let searched = new Set<string>();
    for (const r of reads) {
      for (const person of ["two", "superadmin"] as const) {
        const held = new Set<string>();
        const named: string[] = [];
        const queries = queriesFor(r.path, person === "two" ? readQueries(s) : ["", `?team=${s.two.slug}`, "?scope=platform"], s);
        for (const address of addresses(r.path, s, holds)) {
          for (const query of queries) {
            const req: Sent = { method: r.method, url: `${address}${query}`, body: null };
            const a = await send(base, who[person].cookie, req);
            for (const [field, v] of Object.entries(s.sentinels)) if (a.text.includes(v)) held.add(field);
            if (person === "two" && NAMES_NONE.includes(r.path)) named.push(...leaks(s, req, a).map((l) => `${l.field} in ${req.url} at ${l.at}`));
          }
        }
        if (named.length) found.push(`${who.two.label} GET ${r.path}: a member's answer names no team and no question, their own neither, ` +
          `and holds ${named.join("; ")}`);
        held.forEach((f) => seen[person].add(f));
        if (person === "superadmin" && held.has("question")) questionAt.add(r.path);
        if (person === "two" && r.path === SEARCH) searched = held;
        line(who[person].label, r, `ok, holds ${held.size ? [...held].join(", ") : "no sentinel"}`);
      }
    }
    step = "the superadmin reads the second team's question on Knowledge health and on no other page";
    const elsewhere = [...questionAt].filter((p) => p !== HEALTH);
    if (elsewhere.length) found.push(`${step}: ${elsewhere.join(", ")} answered it`);
    else c.pass(step);
    step = "the second team's member reads their own";
    const ownMissing = OWN_READS.filter((f) => !seen.two.has(f));
    if (ownMissing.length) found.push(`${step}: no read answered them ${ownMissing.join(", ")}`);
    else c.pass(`${step}: ${OWN_READS.join(", ")}`);
    step = "the second team's member's search finds their own";
    if (!searched.has("docTitle") && !searched.has("nodeTitle")) found.push(`${step}: their search by text found neither document nor node`);
    else c.pass(`${step}: the search by a document's or a node's text answers ${[...searched].join(", ")}`);
    step = "the superadmin's reads hold the sentinels intact";
    const withheld: string[] = PLANTED.map((p) => p.field);
    const unread = Object.keys(s.sentinels).filter((f) => ![...NOBODY_READS, ...WORK_ONLY, ...withheld].includes(f) && !seen.superadmin.has(f));
    if (unread.length) found.push(`${step}: no read answered them ${unread.join(", ")}`);
    else c.pass(`${step}: every field but ${NOBODY_READS.join(" and ")}, which the platform's evaluation never selects, ` +
      `${WORK_ONLY.join(" and ")}, which Work answers its own team alone, and the planted event bodies, which no read need answer`);

    // Where the superadmin reads metadata and no body: Audit, reaching every planted row by its kind, holds the
    // second team's slug and nothing else of its; Knowledge health holds the question that found nothing, and
    // of the rest only the slug its shelves and questions are named by.
    const superadminHolds = async (path: string, queries: string[], may: string[], must: string[], rowsOf?: (q: string) => boolean): Promise<void> => {
      const rest = may.filter((f) => !must.includes(f));
      step = `the superadmin's ${path} holds the second team's ${must.join(" and ")} and, of its other sentinels, ` +
        (rest.length ? `only ${rest.join(" and ")}` : "none");
      const held = new Set<string>();
      const bad: string[] = [];
      for (const query of queries) {
        const req: Sent = { method: "get", url: `${path}${query}`, body: null };
        const a = await send(base, who.superadmin.cookie, req);
        if (a.status !== 200) bad.push(`${req.url} answered ${a.status}: ${a.text.slice(0, 200)}`);
        for (const l of leaks(s, req, a)) {
          if (may.includes(l.field)) held.add(l.field);
          else bad.push(`the ${l.field} sentinel in ${req.url} at ${l.at}`);
        }
        const rows = a.status === 200 ? (JSON.parse(a.text) as { rows?: unknown[] }).rows : undefined;
        if (rowsOf?.(query) && (rows?.length ?? 0) < 2) bad.push(`${req.url} reached ${rows?.length ?? 0} rows, not both teams' planted rows`);
      }
      const missing = must.filter((f) => !held.has(f));
      if (missing.length) bad.push(`no answer held ${missing.join(", ")}`);
      if (bad.length) found.push(`${step}: ${bad.join("; ")}`);
      else c.pass(`${step}: ${queries.length} requests`);
    };
    const kinds = PLANTED.map((p) => `?filter=all&kind=${encodeURIComponent(p.kind)}&limit=100`);
    await superadminHolds(AUDIT, ["", "?limit=100", "?filter=all&limit=100", ...kinds], ["slug"], ["slug"], (q) => kinds.includes(q));
    await superadminHolds(HEALTH, ["", "?scope=platform"], ["slug", "question"], ["question"]);
    step = "the database holds every sentinel intact";
    const after = await storedText(c.sql, s);
    const lost = Object.entries(s.sentinels).filter(([, v]) => !after.includes(v)).map(([f]) => f);
    if (lost.length) found.push(`${step}: ${lost.join(", ")} no longer stored`);
    else c.pass(`${step}, ${NOBODY_READS.join(" and ")} among them`);

    await workRounds({ s, w, cited, base, sql: c.sql, found, pass: c.pass, oracle: (r, a, cookie) => oracle(r, a, undefined, cookie) });
    await platformQueryRound({ s, base, found, pass: c.pass });

    if (found.length) c.fail("isolation", `\n    ${found.join("\n    ")}`);
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
