#!/usr/bin/env node
/**
 * checks/console-isolation.ts — a member of one team asks everything the console answers and finds
 * nothing of another team's, through the gateway's whole console on a real database and a real zz-core
 * (AC-1.14, AC-1.15).
 *
 *   node checks/console-isolation.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL and a real zz-core on it (`withThrowawayCore`), seeds what
 * `scripts/schema/isolation-seed.ts` declares (two teams of the same rows, the second's free text
 * sentinels generated afresh for this run, and three people signed in with real console sessions),
 * and serves the gateway's built identity middleware, JSON parser, `mountConsole`, `mountConsoleWrite`
 * and `mountSettings` from this process in server.ts's order. The routes are read from that
 * application's own router, so a route added later is asked without editing this file, and every
 * `/api/console` route the gateway's source declares must be among them. What it establishes:
 *
 *   - the first team's member asks every GET route with the second team's slugs and ids in its path
 *     parameters, with `?team=` and `?scope=platform` forged, and with the second team's text as the
 *     question; no answer, error body or stream frame holds any of the second team's sentinels, and
 *     every `href` in those answers is null. A sentinel the request itself carried is not looked for
 *     in its own answer: a refusal that repeats the caller's input discloses nothing new. Instead each
 *     request naming the second team's team, initiative, node, person, plugin or ids is sent again
 *     naming a phantom of the same shape no team holds, and the two answers, those names and every
 *     instant masked, must be alike: a member does not learn that another team's thing exists;
 *   - with each read's table renamed from the map below, each read answers again and its error body
 *     holds no sentinel; a read the map does not name is listed as not reached;
 *   - the member's direct request to every POST, PUT, PATCH and DELETE route, with the second team's
 *     ids, forged parameters and a body naming the second team's rows, is refused, or answers as the
 *     member's own act, and no row of the second team's changes; a refusal answers alike about a
 *     phantom;
 *   - the second team's member reads their own rows, their search by text finding their own document
 *     or node, and the superadmin's reads hold every sentinel but a finding's decision note and owner
 *     reference, which the platform's evaluation never selects; the database holds all of them intact.
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
import { seedIsolation } from "../scripts/schema/isolation-seed.ts";
import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";

const NAME = "console-isolation";
const DONE = "console-isolation: a member of one team asked every route the mounted console answers, with the other " +
  "team's slugs and ids and a forged team and scope, and no answer, error, stream or link held anything of the other " +
  "team's or answered otherwise than about a team nobody has; every write was refused or the member's own and " +
  "changed nothing of the other team's; the other team's " +
  "member and the superadmin still read it: ok";
/** How long a stream is read before it is let go. */
const STREAM_MS = 1500;
/** Fields the platform's evaluation read never selects, so no superadmin read need answer them: the database
 *  is asked for them instead. COUPLED: platform-evaluation.ts. */
const NOBODY_READS = ["decisionNote", "ownerRef"];
/** What the second team's member must find of their own through their own Work reads, and the search that
 *  must find their own document or node by its text: what a member of the first team's would be shown. */
const OWN_READS = ["slug", "initiative", "docTitle", "docBody", "nodeTitle", "eventDetail"];
const SEARCH = "/api/console/search";
const WRITES = ["post", "put", "patch", "delete"];

type Seeded = Awaited<ReturnType<typeof seedIsolation>>;
type Answer = { status: number; text: string };
interface Route { method: string; path: string }
/** One request as sent: the address with its query, and the body. */
interface Sent { method: string; url: string; body: Record<string, unknown> | null }

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object";
/** Answers' statuses as `200 ×4, 400 ×2`. */
const tally = (statuses: (number | string)[]): string =>
  [...statuses.reduce((m, o) => m.set(o, (m.get(o) ?? 0) + 1), new Map<number | string, number>())]
    .sort(([a], [b]) => String(a).localeCompare(String(b))).map(([o, n]) => `${o} ×${n}`).join(", ");

/** The `/api/console` routes the application answers, from its router: one per method and path. */
function routesOf(app: Express): Route[] {
  const stack = (app as unknown as { _router: { stack: { route?: { path: unknown; methods: Record<string, boolean> } }[] } })._router.stack;
  const out: Route[] = [];
  for (const layer of stack) {
    const r = layer.route;
    if (!r || typeof r.path !== "string" || !r.path.startsWith("/api/console")) continue;
    for (const [method, on] of Object.entries(r.methods)) if (on && method !== "_all") out.push({ method, path: r.path });
  }
  return out;
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
 *  initiative, a document or node address, a report, token or finding id, a plugin. A parameter this does
 *  not know by name takes every one of them. */
function addresses(path: string, s: Seeded): string[] {
  const { one, two } = s;
  const fill: Record<string, string[]> = {
    team: [two.slug, one.slug],
    slug: [two.slug, two.initiative, two.delivered],
    initiative: [two.initiative, two.delivered],
    "*": [two.docPath, two.node, `${two.initiative}/${two.docPath}`],
    id: [two.bugs.fixed, two.bugs.open, two.tokenId, two.finding],
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

/** The queries every read is asked with: none, a forged team, a forged scope, both, and the second team's
 *  text as the question, alongside its initiative and plugin. The question is a sentinel's random half, which
 *  a search matches as a word of it, so the question a search records is never a whole sentinel itself. */
function readQueries(s: Seeded): string[] {
  const { two, sentinels: x } = s;
  const probe = (v: string) => `?q=${v.slice(v.indexOf("-") + 1)}&initiative=${encodeURIComponent(two.initiative)}` +
    `&plugin=${two.plugin}&kind=knowledge.add&collections=knowledge,initiatives,document,teams,activity`;
  return ["", `?team=${two.slug}`, "?scope=platform", `?team=${two.slug}&scope=platform`, probe(x.docBody), probe(x.nodeBody)];
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

/** Sends one request as a signed-in person and reads its answer; a stream is read for `STREAM_MS`, with
 *  `during` run once it opens. */
async function send(base: string, cookie: string, r: Sent, during?: () => Promise<void>): Promise<Answer> {
  const res = await fetch(`${base}${r.url}`, {
    method: r.method.toUpperCase(), signal: AbortSignal.timeout(60_000),
    headers: { cookie: `zz_console=${cookie}`, ...(r.body ? { "content-type": "application/json" } : {}) },
    ...(r.body ? { body: JSON.stringify(r.body) } : {}),
  });
  if (!(res.headers.get("content-type") ?? "").includes("text/event-stream") || !res.body) {
    return { status: res.status, text: await res.text() };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const until = Date.now() + STREAM_MS;
  const poke = during?.();
  try {
    for (;;) {
      const left = until - Date.now();
      if (left <= 0) break;
      const got = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), left))]);
      if (!got || got.done) break;
      text += decoder.decode(got.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    await poke;
  }
  return { status: res.status, text };
}

/** Where `needle` sits in an answer: the JSON path of the first string or key holding it, or its offset. */
function where(text: string, needle: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return `character ${text.indexOf(needle)} of a body that is not JSON`; }
  const walk = (v: unknown, at: string): string | null => {
    if (typeof v === "string") return v.includes(needle) ? at || "the whole body" : null;
    if (!isObj(v)) return null;
    for (const [k, child] of Object.entries(v)) {
      const here = Array.isArray(v) ? `${at}[${k}]` : at ? `${at}.${k}` : k;
      if (k.includes(needle)) return `the key ${here}`;
      const found = walk(child, here);
      if (found) return found;
    }
    return null;
  };
  return walk(parsed, "") ?? `character ${text.indexOf(needle)}`;
}

/** Every `href` in a JSON answer: how many there are, and those that are not null, by path. */
function hrefs(text: string): { count: number; set: string[] } {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { count: 0, set: [] }; }
  const out = { count: 0, set: [] as string[] };
  const walk = (v: unknown, at: string): void => {
    if (!isObj(v)) return;
    for (const [k, child] of Object.entries(v)) {
      const here = Array.isArray(v) ? `${at}[${k}]` : at ? `${at}.${k}` : k;
      if (k === "href") out.count++;
      if (k === "href" && child !== null) out.set.push(`${here} = ${JSON.stringify(child)}`);
      walk(child, here);
    }
  };
  walk(parsed, "");
  return out;
}

/** The table a read is answered from, renamed for its failure round, or null for a read the map does not
 *  name: `zz.event` for the status, releases and bugs list reads and the Work reads, `zz.eval_run` for
 *  evaluation, `zz.bug` for a report and its duplicates. */
function tableFor(path: string): string | null {
  if (/^\/api\/console\/platform\/(status|releases|releases\/:version|bugs)$/.test(path)) return "event";
  if (path === "/api/console/platform/evaluation") return "eval_run";
  if (/^\/api\/console\/platform\/bugs\/:id(\/duplicates)?$/.test(path)) return "bug";
  if (/^\/api\/console\/(platform|settings)\//.test(path) || path === "/api/console/live") return null;
  return "event";
}

/** Every row of the second team's, hashed: the team, its admin and their tokens and memberships, its
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
    `select concat_ws(' ', t.slug, t.name, i.slug, d.title, d.body, r.title, r.body, b.title, b.detail, b.surface, b.resolution,
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
      where t.slug = $1
      order by e.ts limit 1`, [s.two.slug]);
  return rows[0]?.all ?? "";
}

/** The sentinels an answer holds that its request did not carry, each with where it sits. */
function leaks(s: Seeded, r: Sent, a: Answer): { field: string; at: string }[] {
  const carried = `${r.url} ${r.body ? JSON.stringify(r.body) : ""}`;
  return Object.entries(s.sentinels)
    .filter(([, v]) => a.text.includes(v) && !carried.includes(v) && !decodeURIComponent(carried).includes(v))
    .map(([field, v]) => ({ field, at: where(a.text, v) }));
}

/** The second team's identifiers a request can name, its plugin's among them, each paired with a phantom of the
 *  same shape that no team holds and the label both are masked by. */
function phantoms(s: Seeded): [string, string, string][] {
  const hex = (): string => randomBytes(8).toString("hex");
  return [
    [s.two.slug, `slug-${hex()}`, "[team]"],
    [s.sentinels.initiative, `initiative-${hex()}`, "[initiative]"],
    [s.two.node, "nodes/1-nobodys-lesson.md", "[node]"],
    [s.two.email, "nobody@isolation.example.test", "[person]"],
    [s.two.plugin, `isolation-${hex()}-plugin`, "[plugin]"],
    ...[s.two.bugs.fixed, s.two.bugs.open, s.two.tokenId, s.two.finding].map((id): [string, string, string] => [id, randomUUID(), "[id]"]),
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
  const text = pairs.reduce((t, [real, ghost, label]) => t.replaceAll(real, label).replaceAll(ghost, label), a.text);
  return `${a.status} ${text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<instant>")}`;
}

async function run(c: Core): Promise<void> {
  const s = await seedIsolation(c.sql);
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
  const pairs = phantoms(s);
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
    c.pass(`${step}: ${reads.length} reads and ${writes.length} writes read from the mounted application, every one the gateway's source declares`);

    step = "the second team's rows as seeded";
    const stored = await storedText(c.sql, s);
    const absent = Object.entries(s.sentinels).filter(([, v]) => !stored.includes(v)).map(([f]) => f);
    if (absent.length) c.fail(step, `the seed did not store ${absent.join(", ")}`);
    c.pass(`${step}: every one of ${Object.keys(s.sentinels).length} sentinels is stored in its field`);

    // The first team's member: nothing of the second team's, in any read, however asked.
    let links = 0;
    for (const r of reads) {
      const statuses: number[] = [];
      const bad: string[] = [];
      let compared = 0;
      for (const address of addresses(r.path, s)) {
        for (const query of readQueries(s)) {
          const req: Sent = { method: r.method, url: `${address}${query}`, body: null };
          const a = await send(base, who.one.cookie, req, poke);
          statuses.push(a.status);
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
    c.pass(`every link in the first team's member's answers is null: ${links} of them`);
    step = "the comparison tells existence apart";
    const team: Sent = { method: "get", url: `/api/console/teams/${s.two.slug}?scope=platform`, body: null };
    const told = await oracle(team, await send(base, who.superadmin.cookie, team), undefined, who.superadmin.cookie);
    if (!told) c.fail(step, `the superadmin's ${team.url} and a team nobody has answered alike, so a member's alike answers prove nothing`);
    c.pass(`${step}: the superadmin, who may know, is answered differently about the second team and a team nobody has`);

    // The same reads with their table gone: an error body holds nothing either.
    for (const r of reads) {
      const table = tableFor(r.path);
      if (!table) { line(who.one.label, r, "not reached by the failure round: the map names no table for it"); continue; }
      const statuses: number[] = [];
      const bad: string[] = [];
      await c.sql.query(`alter table zz.${table} rename to ${table}_isolation_hidden`);
      // The gateway logs each failed read's cause; what matters here is what the member was answered.
      const quiet = console.error;
      console.error = () => undefined;
      try {
        for (const address of addresses(r.path, s)) {
          const req: Sent = { method: r.method, url: address, body: null };
          const a = await send(base, who.one.cookie, req);
          statuses.push(a.status);
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

    // Every write, sent directly: refused, or the member's own, and the second team's rows unchanged. Read
    // after the rounds above, whose streams were told of one more event of the second team's each.
    const before = await secondTeamRows(c.sql, s);
    const member = (await c.sql.query<{ id: string; team: string }>(
      "select id::text as id, active_team_id::text as team from zz.principal where email = $1", [s.one.email])).rows[0];
    for (const r of writes) {
      const outcomes: string[] = [];
      const bad: string[] = [];
      let compared = 0;
      for (const address of addresses(r.path, s)) {
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
    let searched = new Set<string>();
    for (const r of reads) {
      for (const person of ["two", "superadmin"] as const) {
        const held = new Set<string>();
        const queries = person === "two" ? readQueries(s) : ["", `?team=${s.two.slug}`, "?scope=platform"];
        for (const address of addresses(r.path, s)) {
          for (const query of queries) {
            const a = await send(base, who[person].cookie, { method: r.method, url: `${address}${query}`, body: null });
            for (const [field, v] of Object.entries(s.sentinels)) if (a.text.includes(v)) held.add(field);
          }
        }
        held.forEach((f) => seen[person].add(f));
        if (person === "two" && r.path === SEARCH) searched = held;
        line(who[person].label, r, `ok, holds ${held.size ? [...held].join(", ") : "no sentinel"}`);
      }
    }
    step = "the second team's member reads their own";
    const ownMissing = OWN_READS.filter((f) => !seen.two.has(f));
    if (ownMissing.length) found.push(`${step}: no read answered them ${ownMissing.join(", ")}`);
    else c.pass(`${step}: ${OWN_READS.join(", ")}`);
    step = "the second team's member's search finds their own";
    if (!searched.has("docTitle") && !searched.has("nodeTitle")) found.push(`${step}: their search by text found neither document nor node`);
    else c.pass(`${step}: the search by a document's or a node's text answers ${[...searched].join(", ")}`);
    step = "the superadmin's reads hold the sentinels intact";
    const unread = Object.keys(s.sentinels).filter((f) => !NOBODY_READS.includes(f) && !seen.superadmin.has(f));
    if (unread.length) found.push(`${step}: no read answered them ${unread.join(", ")}`);
    else c.pass(`${step}: every field but ${NOBODY_READS.join(" and ")}, which the platform's evaluation never selects`);
    step = "the database holds every sentinel intact";
    const after = await storedText(c.sql, s);
    const lost = Object.entries(s.sentinels).filter(([, v]) => !after.includes(v)).map(([f]) => f);
    if (lost.length) found.push(`${step}: ${lost.join(", ")} no longer stored`);
    else c.pass(`${step}, ${NOBODY_READS.join(" and ")} among them`);

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
