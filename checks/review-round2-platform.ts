#!/usr/bin/env node
/**
 * checks/review-round2-platform.ts — review round 2's three platform defects, held on a real database
 * through a real zz-core and the gateway's own built settings routes (R2-C134, R2-C129, R2-C130).
 *
 *   node checks/review-round2-platform.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL and a real zz-core on it (`withThrowawayCore`), with no typed-service
 * key, so every family answers `unavailable` and still writes its `zz.assessment` row. What it establishes:
 *
 *   - an assessment whose row cannot be written fails the call that asked for it: with a trigger refusing
 *     every `zz.assessment` insert, `assess` is refused in the platform's words, naming the reading that
 *     was not kept, and no row lands; an audit round's `source_add` on an approved spec is refused the
 *     same way, since `initiative_status` routes that audit on the row, and the source it wrote before
 *     asking stands, as the refusal says; with the trigger gone, the same `assess` answers its reading
 *     and its row lands;
 *   - a token issued while the settings hint throws is answered as issued: `POST /me/tokens` answers 200
 *     with the token, whose `zz.pat` row is live, and `DELETE /me/tokens/:id` of it answers 200 with the
 *     row revoked — the hint is told to the person's other tabs, and its failure is not the token's;
 *   - a token id that is not a uuid is answered 404 with the route's own sentence, and changes no token.
 *
 * The only database it touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — every failing case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";

const NAME = "review-round2-platform";
const DONE = "review-round2-platform: an assessment the platform cannot keep fails the call that asked, a token " +
  "is answered by its own outcome whatever the settings hint does, and a token id that is not a uuid is a 404: ok";

/** The family both callers ask, and the one an audit round's routing reads. */
const FAMILY = "changes_commitment";
/** COUPLED: the route's sentence for a token that is not the caller's (services/gateway/src/settings/me.ts). */
const NO_TOKEN = "no such active token of yours";

const EXPLORE = "## Background\nx\n\n## Current state\nx\n\n## Rough direction\nx\n";
/** A spec the spec gate approves with no reading asked: every declared section, one phase, one core
 *  statement that fails, so no `evidence_relation` question is due. */
const SPEC =
  "## Context\nx\n\n## Problem\nx\n\n## Goals & Requirements\nx\n\n## Alternatives\nx\n\n" +
  "## Approach, Method & Structure\nx\n\n## Verification Plan\nx\n\n## Risks & Mitigations\nx\n\n" +
  "## Stakeholders & Work\nx\n\n" +
  "## Phase outline\n- **Phase 0 — Loop:** the control loop runs end to end.\n\n" +
  "## Core statements\n| ID | Statement | If false | Status | Evidence | Note |\n|---|---|---|---|---|---|\n" +
  "| CS-1 | The loop runs. | Nothing is checked. | fails | run:control-loop-e2e — `loop` | resolved-by-design-change: a probe has no design |\n";

type Obj = Record<string, unknown>;
type Answer = { status: number; body: Obj };
type Route = (req: unknown, res: unknown) => void;

const show = (v: unknown): string => JSON.stringify(v).slice(0, 400);
/** What `assessFamily`'s refusal opens with, for a reading asked about `about`. */
const unkept = (about: string): RegExp =>
  new RegExp(`^ERROR: the ${FAMILY} reading of ${about.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} was taken but could not be recorded`);

/** Calls one mounted route as Express would, and waits for the answer it sends. */
function answer(route: Route, req: Obj): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200, headersSent: false,
      status(code: number) { this.statusCode = code; return this; },
      json(body: Obj) { this.headersSent = true; resolve({ status: this.statusCode, body }); },
    };
    try { route(req, res); } catch (err) { reject(err); }
  });
}

/** How many `zz.assessment` rows were asked about `about`. */
async function rows(c: Core, about: string): Promise<number> {
  return (await c.sql.query<{ n: number }>(
    "select count(*)::int as n from zz.assessment where about = $1", [about])).rows[0].n;
}

/** The seeded person's tokens, as one text to compare before and after. */
async function tokens(c: Core): Promise<string> {
  return JSON.stringify((await c.sql.query(
    `select t.id, t.label, t.revoked_at is not null as revoked from zz.pat t
       join zz.principal p on p.id = t.principal_id where p.email = $1 order by t.created_at, t.id`, [c.email])).rows);
}

/** R2-C134: the assessment row refused by a trigger, then allowed again. */
async function assessments(c: Core, found: string[]): Promise<void> {
  const slug = await c.open("round2-audit", "sdlc-flow");
  await c.ok("make the audit", "document_write", { path: `${slug}/explore.md`, content: EXPLORE });
  await c.ok("make the audit", "document_write", { path: `${slug}/spec.md`, content: SPEC });
  await c.sign(`${slug}/spec.md`);

  await c.sql.query(
    `create function zz.review_round2_refuse() returns trigger language plpgsql as $$
     begin raise exception 'this check refuses every assessment row'; end $$`);
  await c.sql.query(
    `create trigger review_round2_refuse before insert on zz.assessment
       for each row execute function zz.review_round2_refuse()`);
  try {
    let step = "an assessment whose row cannot be written fails `assess`";
    const said = await c.call(step, "assess", { family: FAMILY, subject: "x", initiative: slug, about: "probe" });
    if (!unkept("probe").test(said)) found.push(`${step}: it answered ${show(said)}`);
    else if (await rows(c, "probe") !== 0) found.push(`${step}: a row about probe landed`);
    else c.pass(`${step}, in its words, and no row lands`);

    step = "an audit round whose reading cannot be written fails `source_add`";
    const round = await c.call(step, "source_add", {
      initiative: slug, title: "spec audit", content: "no blocking findings", supports: ["spec.md"], stage: "sdlc-spec-audit" });
    const kept = (await c.sql.query<{ n: number }>(
      `select count(*)::int as n from zz.doc d join zz.initiative i on i.id = d.initiative_id
        where i.slug = $1 and d.path like 'sources/%'`, [slug])).rows[0].n;
    if (!/^ERROR: the changes_commitment reading of sources\/\S+ was taken but could not be recorded.* Anything it wrote before asking stands\./.test(round)) {
      found.push(`${step}: it answered ${show(round)}`);
    } else if (kept !== 1) {
      found.push(`${step}: the refusal says the source stands, and the initiative holds ${kept} source(s)`);
    } else c.pass(`${step}, naming the round's reading that was not kept, and the source it wrote stands`);
  } finally {
    await c.sql.query("drop trigger review_round2_refuse on zz.assessment");
    await c.sql.query("drop function zz.review_round2_refuse()");
  }

  const step = "the same `assess` with its row allowed answers the reading";
  const again = await c.call(step, "assess", { family: FAMILY, subject: "x", initiative: slug, about: "probe" });
  let reading: unknown;
  try { reading = (JSON.parse(again) as Obj).reading; } catch { reading = undefined; }
  if (reading !== "unavailable" || await rows(c, "probe") !== 1) {
    found.push(`${step}: it answered ${show(again)} with ${await rows(c, "probe")} row(s) about probe`);
  } else c.pass(`${step} and its row lands`);
}

/** R2-C129 and R2-C130: the settings routes, with the settings hint refused and with an id no token has. */
async function settings(c: Core, found: string[]): Promise<void> {
  // `withThrowawayDb` ended the gateway's pool after migrating; a fresh one on the same container.
  process.env.TEAM_DB_URL = c.url;
  const load = (p: string) => import(pathToFileURL(join(root, "services/gateway/dist", p)).href);
  const db = (await load("db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await db.initPlatformDb();
  try {
    await routes(c, found, load);
  } finally {
    await db.platformDb().end();
    delete process.env.TEAM_DB_URL;
  }
}

async function routes(c: Core, found: string[], load: (p: string) => Promise<unknown>): Promise<void> {
  const { mountMySettings } = (await load("settings/me.js")) as { mountMySettings: (app: unknown, deps: unknown) => void };
  const credentials = (await load("credentials.js")) as Record<string, unknown>;
  const mounted = new Map<string, Route>();
  const on = (method: string) => (path: string, h: Route) => mounted.set(`${method} ${path}`, h);
  mountMySettings({ get: on("GET"), post: on("POST"), delete: on("DELETE") }, {
    myAccessTokensFor: credentials.myAccessTokensFor, issueMyAccessTokenFor: credentials.issueMyAccessTokenFor,
    revokeMyAccessTokenFor: credentials.revokeMyAccessTokenFor });
  const route = (key: string): Route => mounted.get(key) ?? c.fail("mount", `no route ${key}`);
  /** As the seeded person's signed-in browser, past the gateway's identity gate. */
  const ask = (key: string, params: Obj, body: Obj = {}) => answer(route(key), {
    params, query: {}, body, headers: {},
    zzIdentity: { email: c.email, displayName: "Skeleton", platformRole: "member", via: "session", origin: "work",
                  teams: [{ slug: c.team, role: "admin" }], activeTeam: c.team, patTeam: null, sessionTeam: c.team },
  });

  const { rows: [held] } = await c.sql.query<{ def: string }>(
    "select pg_get_functiondef('zz.console_hint(text, text)'::regprocedure) as def");
  // Only the person-wide hint the settings routes send is refused; a team's hints go on as before.
  await c.sql.query(
    `create or replace function zz.console_hint(team_slug text, collection text) returns void
     language plpgsql as $$
     begin
       if team_slug = '' and collection = 'settings' then raise exception 'this check refuses the settings hint'; end if;
     end $$`);
  try {
    let step = "a token issued while the settings hint throws is answered as issued";
    const issued = await ask("POST /api/console/settings/me/tokens", {}, { label: "issued under a failing hint" });
    const mine = (await c.sql.query<{ id: string; revoked: boolean }>(
      `select t.id, t.revoked_at is not null as revoked from zz.pat t join zz.principal p on p.id = t.principal_id
        where p.email = $1 and t.label = 'issued under a failing hint'`, [c.email])).rows;
    if (issued.status !== 200 || typeof issued.body.token !== "string" || mine.length !== 1 || mine[0].revoked) {
      found.push(`${step}: the route answered ${issued.status} ${show(issued.body)} with ${mine.length} such token(s)`);
    } else c.pass(`${step}: 200 with the token, and its row is live`);

    step = "a token revoked while the settings hint throws is answered as revoked";
    if (mine.length === 1) {
      const revoked = await ask("DELETE /api/console/settings/me/tokens/:id", { id: mine[0].id });
      const now = (await c.sql.query<{ revoked: boolean }>(
        "select revoked_at is not null as revoked from zz.pat where id = $1", [mine[0].id])).rows[0];
      if (revoked.status !== 200 || revoked.body.revoked !== mine[0].id || !now?.revoked) {
        found.push(`${step}: the route answered ${revoked.status} ${show(revoked.body)}, the row revoked: ${now?.revoked}`);
      } else c.pass(`${step}: 200, and the row is revoked`);
    } else found.push(`${step}: no token was issued to revoke`);
  } finally {
    await c.sql.query(held.def);
  }

  const step = "a token id that is not a uuid is a 404";
  const before = await tokens(c);
  const odd = await ask("DELETE /api/console/settings/me/tokens/:id", { id: "not-a-token" });
  if (odd.status !== 404 || odd.body.error !== NO_TOKEN || await tokens(c) !== before) {
    found.push(`${step}: the route answered ${odd.status} ${show(odd.body)}`);
  } else c.pass(`${step} with the route's own sentence, and no token changes`);
}

async function run(c: Core): Promise<void> {
  const found: string[] = [];
  await assessments(c, found);
  await settings(c, found);
  if (found.length) c.fail(`${found.length} case(s)`, `\n  ${found.join("\n  ")}`);
}

// No typed-service key, here or in the zz-core child that inherits this environment: every family
// answers `unavailable` and writes its row, so the row is the only thing a case changes.
delete process.env.TYPESAFE_API_KEY;
process.exitCode = await withThrowawayCore(NAME, DONE, run);
