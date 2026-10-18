#!/usr/bin/env node
/**
 * checks/console-isolation-destinations.ts — the isolation harness's other direction: a member of the second
 * team, and a superadmin acting for it, ask Home, Record, Approvals, Initiatives and Work's two detail routes,
 * Knowledge, Activity, Runs, Plugins, Access and the prepared queries over their measures, and find nothing of
 * the first team's (AC-6.3, AC-6.6, AC-1.16, AC-1.8).
 *
 *   node checks/console-isolation-destinations.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL migrated by the real runner (`withThrowawayDb`), seeds what
 * `scripts/schema/isolation-seed.ts` declares (`seedIsolation`, `seedWork`), a superadmin who is a member of
 * the second team and acts for it, signed in, and a skill the catalog ships, and serves the gateway's built
 * identity middleware, JSON parser, `mountConsole` and `mountSettings` from this process in server.ts's order.
 * The reads (`ROUTES`) must be among the routes that application's router answers. Then it plants, for the
 * first team, fresh sentinels where those reads answer free text: a real-work refusal's message, a question
 * that found nothing, a run's skill and initiative, a document waiting for approval in that initiative (its
 * title and body), a lesson's title and body, and its admin's token label, application name, browser user
 * agent and passkey label; and calls of the shipped skill and runs, which only figures could carry. What it
 * establishes:
 *
 *   - the first team's own member reads every one of those sentinels in these reads, so their absence below
 *     is about who asks and not about what was planted;
 *   - the second team's member and the acting superadmin ask Home, Record, Approvals in both tabs, Initiatives,
 *     the first team's initiative and its document by their addresses, which answer as an initiative nobody
 *     has, Activity's summary and log (by kind, tool,
 *     the first team's initiative and refused), Knowledge's summary, list (by the lesson's and the question's
 *     words), log and the first team's lesson by its address, Runs (by the first team's skill), Plugins, the
 *     skills and a skill, Access, and `work/query` by each of `MEASURES` and every dimension it allows,
 *     against the previous window, each group drilled to its rows but skill_calls', whose groups are its rows,
 *     and drilled to the first team's initiative and skill; each plainly, with the first team named, with the
 *     platform asked for and with both. No answer holds any of the first team's sentinels, the refusal message
 *     among them, and every answer naming the first team's slug, initiative, skill or lesson is alike to the
 *     same request naming a phantom no team holds;
 *   - every one of those answers, its instants masked, is the same before the first team's rows were planted
 *     as after: the team figures of Plugins, the skills, Runs, Activity and the prepared queries count nothing
 *     of the first team's.
 *
 * The first direction, the first team's member asking every route about the second team's sentinels, is
 * `checks/console-isolation.ts`. The only database it touches is the one it started.
 *
 * Exit 0: every reader held for every read — one line per case, then the final line.
 * Exit 1: a sentinel was found, an answer moved, or a case failed — the read, the reader and the field.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Express, RequestHandler } from "express";
import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import { seedIsolation, seedWork, type Isolation } from "../scripts/schema/isolation-seed.ts";
import { signIn } from "../scripts/schema/status-seed.ts";
import { withThrowawayDb } from "../scripts/schema/throwaway.ts";

import { dimensions, routesOf, send, tally, wide, type Answer, type Query } from "./console-isolation-work.ts";

const NAME = "console-isolation-destinations";
const DONE = "console-isolation-destinations: the second team's member and a superadmin acting for it asked Home, Record, " +
  "Approvals, Initiatives, the first team's initiative and document, Activity, " +
  "Knowledge, Runs, Plugins and the skills, Access and the prepared queries over their measures, plainly and with the " +
  "first team and the platform named, and no answer held the first team's refusal message or any other of its " +
  "sentinels, answered otherwise than about a team nobody has, or moved when the first team's rows were planted: ok";
const WORK = "/api/console/work/query";
/** The reads asked: every one must be mounted. */
const ROUTES = ["/api/console/home", "/api/console/record", "/api/console/approvals", "/api/console/initiatives",
  "/api/console/initiatives/:team/:slug", "/api/console/document/:team/:initiative/*",
  "/api/console/activity/summary", "/api/console/activity", "/api/console/knowledge/summary",
  "/api/console/knowledge", "/api/console/knowledge/log", "/api/console/knowledge/:team/*", "/api/console/runs", "/api/console/plugins",
  "/api/console/skills", "/api/console/skills/:name", "/api/console/access", WORK];
/** The prepared queries' measures over Phase 4's destinations, and the searches, whose drill now answers the
 *  questions that found nothing. */
const MEASURES = ["calls", "refusals", "output", "skill_calls", "shelf", "searches"];
/** A skill the catalog ships, so its calls are a plugin's team figure. COUPLED: catalog/sdlc. */
const SHIPPED = "sdlc-spec";
/** The first team's fields that carry a sentinel. */
const FIELDS = ["refusal", "question", "skill", "initiative", "docTitle", "docBody", "nodeTitle", "nodeBody", "tokenLabel",
  "application", "userAgent", "passkey"] as const;
type Field = (typeof FIELDS)[number];

class CaseFailure extends Error {}
const fail = (step: string, detail: string): never => { throw new CaseFailure(`${NAME}: FAILED at "${step}": ${detail}`); };
const pass = (step: string): void => console.log(`  ${step}: ok`);
const hex = (): string => randomBytes(8).toString("hex");

/** A fresh sentinel per field, its random half led by a letter, as the seed's are. COUPLED: isolation-seed.ts. */
function sentinels(): Record<Field, string> {
  const half = (): string => hex().replace(/^\d/, (d) => "abcdef"[Number(d) % 6]);
  return Object.fromEntries(FIELDS.map((f) => [f, `${f.toLowerCase()}-${half()}`])) as Record<Field, string>;
}

/** The document planted in the first team's initiative. */
const DOC = "spec.md";

/** What the first team's rows are named by in a request: its initiative's dated slug and its lesson's address. */
interface Planted { initiative: string; node: string }

/** A superadmin who is a member of the second team and acts for it, signed in: their cookie. Then the skill the
 *  catalog ships and a version of it, platform rows both teams' calls name, made before anything is asked. */
async function prepare(sql: pg.Client, s: Isolation): Promise<{ acting: string; shipped: string }> {
  const acting = "acting-two@isolation.example.test";
  await sql.query("insert into zz.principal (email, display_name, role) values ($1, 'Isolation superadmin for two', 'superadmin')", [acting]);
  await sql.query(
    `insert into zz.membership (team_id, principal_id, role, added_by)
     select t.id, p.id, 'member', a.id from zz.team t, zz.principal p, zz.principal a where t.slug = $1 and p.email = $2 and a.email = $3`,
    [s.two.slug, acting, s.two.email]);
  await sql.query("update zz.principal set active_team_id = (select id from zz.team where slug = $2) where email = $1", [acting, s.two.slug]);
  const { rows: [v] } = await sql.query<{ id: string }>(
    `with k as (insert into zz.skill (name, flow) values ($1, 'sdlc-flow') returning id)
     insert into zz.skill_version (skill_id, version, content_hash) select id, '1.0.0', $2 from k returning id::text as id`, [SHIPPED, randomBytes(32).toString("hex")]);
  return { acting: await signIn(sql, acting), shipped: v.id };
}

/** The first team's rows that carry `x`, each laid out as its writer lays it out, dated ten minutes and a week
 *  back so the last whole week and the running one both hold them: a real-work refusal of `core:document_write`
 *  in its initiative and under its skill, three real-work calls of the shipped skill, a search that found
 *  nothing, a run of each skill, a document presented and waiting in the initiative, a lesson, and its admin's
 *  labelled token, application, browser and passkey. */
async function plant(sql: pg.Client, s: Isolation, x: Record<Field, string>, shipped: string): Promise<Planted> {
  const one = async (q: string, args: unknown[]): Promise<string> => (await sql.query<{ id: string }>(q, args)).rows[0].id;
  const { rows: [who] } = await sql.query<{ team: string; admin: string }>(
    "select t.id::text as team, p.id::text as admin from zz.team t, zz.principal p where t.slug = $1 and p.email = $2", [s.one.slug, s.one.email]);
  const slug = `2026-10-01-${x.initiative}`;
  const initiative = await one(
    `insert into zz.initiative (team_id, slug, flow, opened_by, opened_at) values ($1, $2, 'sdlc-flow', $3, now() - interval '20 days')
     returning id`, [who.team, slug, who.admin]);
  const skill = await one(
    `with k as (insert into zz.skill (name) values ($1) returning id)
     insert into zz.skill_version (skill_id, version, content_hash) select id, '1.0.0', $2 from k returning id`, [x.skill, randomBytes(32).toString("hex")]);
  for (const back of ["10 minutes", "7 days"]) {
    await sql.query(
      `insert into zz.event (ts, kind, subject, tool_key, ok, refusal, refusal_owner, origin, detail, team_id, actor_id,
                             initiative_id, skill_version_id, duration_ms)
       values (now() - $1::interval, 'tool_call', 'core:document_write', 'core:document_write', false, $2, 'ours', 'work', '{}'::jsonb,
               $3, $4, $5, $6, 40)`, [back, `ERROR: SECTION_MISSING — ${x.refusal}`, who.team, who.admin, initiative, skill]);
    await sql.query(
      `insert into zz.event (ts, kind, subject, tool_key, ok, origin, detail, team_id, actor_id, initiative_id, skill_version_id, duration_ms)
       select now() - $1::interval - n * interval '1 minute', 'tool_call', 'core:document_read', 'core:document_read', true, 'work',
              '{}'::jsonb, $2, $3, $4, $5, 30
         from generate_series(1, 3) n`, [back, who.team, who.admin, initiative, shipped]);
    await sql.query(
      `insert into zz.event (ts, kind, subject, origin, detail, team_id, actor_id)
       values (now() - $1::interval, 'knowledge.search', $2, 'work', $3::jsonb, $4, $5)`,
      [back, x.question, JSON.stringify({ returned: [], ranked_total: 0, broadened: false, filters: {} }), who.team, who.admin]);
  }
  for (const version of [skill, shipped]) {
    await sql.query(
      `insert into zz.skill_run (team_id, initiative_id, skill_version_id, session, calls, refusals, bytes_total, started_at, ended_at)
       values ($1, $2, $3, $4, 4, 1, 4096, now() - interval '1 day', now() - interval '1 day' + interval '10 minutes')`,
      [who.team, initiative, version, `isolation-${hex()}`]);
  }
  // The document and its one revision, presented and not approved, as the seed's own: it waits.
  await sql.query("begin");
  await sql.query("set constraints all deferred");
  const doc = await one(
    `insert into zz.doc (initiative_id, path, type, status, updated_at, title, body, current_revision, current_version)
     values ($1, $2, 'spec', 'draft', now() - interval '1 day', $3, $4, 1, 1) returning id`, [initiative, DOC, x.docTitle, x.docBody]);
  await sql.query(
    `insert into zz.doc_revision (doc_id, revision, version, content_state, title, body, tags, content_hash, written_by,
                                  written_at, presented_at)
     values ($1, 1, 1, 'retained', $2, $3, '{}', $4, $5, now() - interval '1 day', now() - interval '1 day')`,
    [doc, x.docTitle, x.docBody, `hash-${doc}`, who.admin]);
  await sql.query("commit");
  const lesson = "first-team-kept-lesson";
  await sql.query(
    `insert into zz.knowledge_node (kind, title, body, team_id, node_ordinal, slug) values ('decision', $1, $2, $3, 2, $4)`,
    [x.nodeTitle, x.nodeBody, who.team, lesson]);
  // The lesson's entry in the knowledge log, as `knowledge_add` writes it: its title is in the log's own words.
  await sql.query(
    `insert into zz.event (ts, kind, subject, origin, detail, team_id, actor_id)
     values (now() - interval '10 minutes', 'knowledge.add', '2', 'work', $1::jsonb, $2, $3)`,
    [JSON.stringify({ title: x.nodeTitle }), who.team, who.admin]);
  const client = `isolation-client-${hex()}`;
  await sql.query("insert into zz.mcp_oauth_client (client_id, redirect_uris, name) values ($1, '[]'::jsonb, $2)", [client, x.application]);
  await sql.query(
    `insert into zz.pat (principal_id, token_hash, label, oauth_client_id)
     values ($1, $2, $3, null), ($1, $4, 'mcp oauth isolation', $5)`, [who.admin, hex() + hex(), x.tokenLabel, hex() + hex(), client]);
  await sql.query(
    `insert into zz.console_session (principal_id, token_hash, expires_at, user_agent) values ($1, $2, now() + interval '1 hour', $3)`,
    [who.admin, hex() + hex(), x.userAgent]);
  await sql.query(
    `insert into zz.passkey (id, principal_id, public_key, transports, label) values ($1, $2, '\\x00'::bytea, '{internal}', $3)`,
    [`credential-${hex()}`, who.admin, x.passkey]);
  return { initiative: slug, node: `nodes/2-${lesson}.md` };
}

/** Every request a reader sends, but work/query's drills, which depend on what it answers. */
function requests(s: Isolation, x: Record<Field, string>, p: Planted): string[] {
  const forged = ["", `team=${s.one.slug}`, "scope=platform", `team=${s.one.slug}&scope=platform`];
  const each = (path: string, queries: string[]): string[] =>
    forged.flatMap((f) => queries.map((q) => [f, q].filter(Boolean).join("&")).map((q) => (q ? `${path}?${q}` : path)));
  const words = (v: string): string => v.slice(v.indexOf("-") + 1);
  const node = (team: string): string => `/api/console/knowledge/${team}/${p.node}`;
  const initiative = `/api/console/initiatives/${s.one.slug}/${p.initiative}`;
  return [
    ...each("/api/console/home", [""]),
    ...each("/api/console/record", ["period=all&limit=100"]),
    ...each("/api/console/approvals", ["tab=waiting&limit=100", "tab=history&limit=100"]),
    ...each("/api/console/initiatives", ["limit=100"]),
    ...each(initiative, [""]), ...each(`/api/console/document/${s.one.slug}/${p.initiative}/${DOC}`, [""]),
    ...each("/api/console/activity/summary", [""]),
    ...each("/api/console/activity", ["", "limit=100", `initiative=${p.initiative}`, "kind=tool_call&refused=true&limit=100",
      "kind=knowledge.search&limit=100", "tool=core:document_write&limit=100"]),
    ...each("/api/console/knowledge/summary", [""]),
    ...each("/api/console/knowledge", ["", "limit=100", `q=${words(x.nodeTitle)}`, `q=${words(x.nodeBody)}`, "kind=decision&limit=100"]),
    ...each("/api/console/knowledge/log", [""]),
    ...each(node(s.one.slug), [""]), ...each(node(s.two.slug), [""]),
    ...each("/api/console/runs", ["", "limit=100", `skill=${x.skill}`]),
    ...each("/api/console/plugins", [""]),
    ...each("/api/console/skills", ["", "plugin=sdlc"]),
    ...each(`/api/console/skills/${x.skill}`, [""]), ...each(`/api/console/skills/${SHIPPED}`, [""]),
    ...each("/api/console/access", [""]),
  ];
}

/** The first team's identifiers a request names, each paired with a phantom of the same shape no team holds. */
function phantoms(s: Isolation, x: Record<Field, string>, p: Planted): [string, string][] {
  return [[p.node, "nodes/2-nobodys-kept-lesson.md"], [p.initiative, `2026-10-01-initiative-${hex()}`],
    [x.skill, `skill-${hex()}`], [s.one.slug, `slug-${hex()}`]];
}

/** An answer with every instant masked, and the given names: what is left is what it says. */
function masked(a: Answer, names: string[] = []): string {
  const text = names.reduce((t, n) => t.replaceAll(n, "[name]"), a.text);
  return `${a.status} ${text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<instant>")}`;
}

async function run(sql: pg.Client, url: string): Promise<void> {
  const s = await seedIsolation(sql);
  await seedWork(sql, s);
  const { acting, shipped } = await prepare(sql, s);
  const x = sentinels();

  process.env.TEAM_DB_URL = url;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  // Access answers the client setup, which names the address people reach the gateway at.
  process.env.GATEWAY_PUBLIC_URL = "https://gateway.isolation.example.test";
  const load = (f: string) => import(pathToFileURL(join(root, "services/gateway/dist", f)).href);
  const express = (await import("express")).default;
  const dbModule = (await load("db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await dbModule.initPlatformDb();
  const { identityMiddleware } = (await load("identity.js")) as { identityMiddleware: () => RequestHandler };
  const { mountConsole } = (await load("console.js")) as { mountConsole: (app: Express) => void };
  const { mountSettings } = (await load("settings.js")) as { mountSettings: (app: Express, deps: unknown) => void };
  const credentials = (await load("credentials.js")) as Record<string, unknown>;
  const app = express();
  // COUPLED: services/gateway/src/server.ts — the identity gate, the JSON parser, then the console's reads
  // and its settings, in that order.
  app.use(identityMiddleware());
  app.use(express.json({ limit: "20mb" }));
  mountConsole(app);
  mountSettings(app, { myAccessTokensFor: credentials.myAccessTokensFor, issueMyAccessTokenFor: credentials.issueMyAccessTokenFor,
                       revokeMyAccessTokenFor: credentials.revokeMyAccessTokenFor });
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const get = (cookie: string, u: string): Promise<Answer> => send(base, cookie, { method: "get", url: u, body: null });

  try {
    let step = "Phase 4's reads are mounted";
    const mounted = new Set(routesOf(app).filter((r) => r.method === "get").map((r) => r.path));
    const unmounted = ROUTES.filter((r) => !mounted.has(r));
    if (unmounted.length) fail(step, `the application answers no ${unmounted.join(", ")}`);
    pass(`${step}: ${ROUTES.join(", ")}`);
    const found: string[] = [];
    const dims = (await dimensions(base, s.cookies.two, found)).filter(([m]) => MEASURES.includes(m));
    const missing = MEASURES.filter((m) => !dims.some(([d]) => d === m));
    if (found.length || missing.length) fail("the prepared queries' measures", [...found, ...missing.map((m) => `no measure ${m}`)].join("; "));
    const window = wide();

    /** Every answer a reader is given, by address: the fixed requests, then work/query by each measure and
     *  dimension, plainly and forged, its groups above 0 drilled but skill_calls', and drilled to the first
     *  team's initiative and skill, which a drill must find as empty as a group nobody has. */
    const sweep = async (cookie: string, fixed: string[], groups: { initiative: string; skill: string }): Promise<Map<string, Answer>> => {
      const out = new Map<string, Answer>();
      for (const u of fixed) out.set(u, await get(cookie, u));
      for (const [measure, bys] of dims) {
        for (const by of bys) {
          for (const f of ["", `&team=${s.one.slug}&scope=platform`]) {
            const u = `${WORK}?measure=${measure}&by=${by}&compare=previous&${window}${f}`;
            const a = await get(cookie, u);
            out.set(u, a);
            if (a.status !== 200 || measure === "skill_calls") continue;
            const keys = (JSON.parse(a.text) as Query).groups.filter((g) => (g.value.value ?? 0) > 0).map((g) => g.key);
            if (by === "initiative") keys.push(groups.initiative);
            if (by === "skill") keys.push(groups.skill);
            for (const k of keys) out.set(`${u}&group=${encodeURIComponent(k)}&limit=100`, await get(cookie, `${u}&group=${encodeURIComponent(k)}&limit=100`));
          }
        }
      }
      return out;
    };

    // The second team's answers before the first team's rows are planted: what nothing of the first team's may move.
    const pairs: [string, string][] = [];
    const readers = [{ label: "the second team's member", cookie: s.cookies.two },
                     { label: "the superadmin acting for the second team", cookie: acting }];
    // The addresses name the planted rows, so they are known before the rows are: an initiative's slug and a lesson's address are the seed's own shape.
    const p: Planted = { initiative: `2026-10-01-${x.initiative}`, node: "nodes/2-first-team-kept-lesson.md" };
    const fixed = requests(s, x, p);
    const before = new Map<string, Map<string, Answer>>();
    for (const r of readers) before.set(r.label, await sweep(r.cookie, fixed, { initiative: p.initiative, skill: x.skill }));

    step = "the first team's rows as planted";
    const planted = await plant(sql, s, x, shipped);
    if (planted.initiative !== p.initiative || planted.node !== p.node) fail(step, `planted ${JSON.stringify(planted)}, asked about ${JSON.stringify(p)}`);
    pairs.push(...phantoms(s, x, p));
    // The first team's own member reads every sentinel, so their absence is about who asks.
    const own = await sweep(s.cookies.one, requests(s, x, p).filter((u) => !u.includes("?") || u.includes("limit=100")),
                            { initiative: p.initiative, skill: x.skill });
    // Access is a person's own, so the first team's admin, who holds the planted ones, reads them there.
    const seen = new Set(FIELDS.filter((f) => [...own.values()].some((a) => a.status === 200 && a.text.includes(x[f]))));
    const unseen = FIELDS.filter((f) => !seen.has(f));
    if (unseen.length) fail(step, `the first team's member read no answer holding ${unseen.join(", ")}`);
    pass(`${step}: the first team's member reads all ${FIELDS.length} of its sentinels in ${own.size} answers`);

    for (const r of readers) {
      const answers = await sweep(r.cookie, fixed, { initiative: p.initiative, skill: x.skill });
      const prior = before.get(r.label)!;
      const bad: string[] = [];
      let compared = 0;
      for (const [u, a] of answers) {
        const carried = decodeURIComponent(u);
        for (const f of FIELDS) if (a.text.includes(x[f]) && !carried.includes(x[f])) bad.push(`the ${f} sentinel in ${u} (${a.status})`);
        // A read naming the first team's lesson, initiative or document by its address is answered as one nobody has.
        const plain = !u.includes("team=") && !u.includes("scope=") && !u.includes(p.node) && !u.includes(`/${s.one.slug}/${p.initiative}`);
        if (plain && a.status !== 200) bad.push(`${u} answered ${a.status}: ${a.text.slice(0, 200)}`);
        const was = prior.get(u);
        if (!was) bad.push(`${u} was not asked before the first team's rows were planted`);
        else if (masked(was) !== masked(a)) bad.push(`${u} moved once the first team's rows were planted: ${masked(was).slice(0, 300)} became ${masked(a).slice(0, 300)}`);
        const ghost = pairs.reduce((t, [real, g]) => t.replaceAll(real, g), u);
        if (ghost === u) continue;
        compared++;
        const g = await get(r.cookie, ghost);
        const names = pairs.flat();
        if (masked(a, names) !== masked(g, names)) bad.push(`an existence oracle: ${u} answered ${masked(a, names).slice(0, 240)}; ${ghost}, ${masked(g, names).slice(0, 240)}`);
      }
      for (const u of prior.keys()) if (!answers.has(u)) bad.push(`${u} was asked before the first team's rows were planted and not after`);
      if (bad.length) found.push(...bad.map((b) => `${r.label}: ${b}`));
      else pass(`${r.label} asked ${answers.size} reads of Home, Record, Approvals, Initiatives and its detail routes, Activity, ` +
        "Knowledge, Runs, Plugins and the skills, Access and " +
        `${dims.length} prepared queries, answered ${tally([...answers.values()].map((a) => a.status))}: none held the first ` +
        `team's refusal message or another of its sentinels, ${compared} answered alike about a team nobody has, and none moved ` +
        "when the first team's rows were planted");
    }
    if (found.length) fail("isolation", `\n    ${found.join("\n    ")}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await dbModule.platformDb().end().catch(() => undefined);
    delete process.env.TEAM_DB_URL;
    delete process.env.ZZ_CATALOG_DIR;
    delete process.env.GATEWAY_PUBLIC_URL;
  }
}

let url = "";
try {
  await withThrowawayDb((sql) => run(sql, url), async (u) => { url = u; });
  console.log(DONE);
} catch (err) {
  if (err instanceof CaseFailure) { console.error(err.message); process.exitCode = 1; }
  else if (/Docker is not running/.test(String(err))) { console.error(`${NAME}: SKIPPED — ${String(err)}`); process.exitCode = 2; }
  else { console.error(`${NAME}: FAILED — ${err instanceof Error ? err.stack : String(err)}`); process.exitCode = 1; }
}
