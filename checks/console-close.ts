#!/usr/bin/env node
/**
 * checks/console-close.ts — the console's close of an initiative and zz-core's `initiative_close`, held
 * to one answer on a real database through a real zz-core (AC-5.6, AC-5.8).
 *
 *   node checks/console-close.ts   # needs Docker and a built tree (`npm run build`)
 *
 * `POST /api/console/initiatives/:team/:slug/close` calls `initiative_close` as the person
 * (services/gateway/src/console-close.ts). It starts a throwaway PostgreSQL and a real zz-core on it
 * (`withThrowawayCore`) and makes every case on two initiatives made the same way: one closed through
 * the tool, called by the person's MCP client, and one through the gateway's own built route handler,
 * called the way Express would by the same person's console session. What it establishes:
 *
 *   - the two agree on the derived outcome, the closer, the acceptor, the reason nobody signed off, the
 *     closing document and the number of closes recorded, for: a finished close with no sign-off field
 *     (accepted by the closer), one naming another acceptor (accepted by them), one with a reason
 *     nobody signed off (delivered), a governed close (on the flow's closing document), a freeform
 *     close naming its document, the abandonment of an initiative with no document (on no document)
 *     and of a partial one (on the furthest document it reached); the route answers 200 with what the
 *     initiative records, and initiative_status reads the same result back for both;
 *   - both sign-off fields, unapproved gates and a freeform finished close with no document are
 *     refused with the same sentence, the route's 400 carrying the tool's text, and nothing closes;
 *   - an initiative already closed is the route's 409 carrying the tool's sentence, and the first
 *     decision stays; two closes through the route at once answer one 200 and one 409, the first
 *     decision standing;
 *   - a body naming `outcome` or `closed_by`, a disposition outside the two, a blank sign-off field and
 *     a document the initiative does not hold are the route's 400, and nothing closes;
 *   - another team's initiative, named under its own team or under the caller's, and a slug no team
 *     holds are the route's 404 before anything is relayed: zz-core is unreachable meanwhile, and a
 *     close that does reach for it is a 502;
 *   - one close records one `initiative_close`, and the route records its act once as the console's
 *     door, `via: "web"`;
 *   - the route's answers have the key sets of the console's fake answer, at 200, 400, 404 and 409.
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

const NAME = "console-close";
const DONE = "console-close: the console and the MCP tool close an initiative to the same outcome, closer, acceptor " +
  "and closing document and refuse it with the same sentence, a closed initiative keeps its first decision, " +
  "another team's is a 404 before zz-core is asked, and one close records one close: ok";
/** COUPLED: the fake answer in the console's checkout, `../zz-stack-dashboard` here and in CI. */
const FAKE = join(root, "..", "zz-stack-dashboard", "scripts", "fake-gateway", "work-initiatives.ts");
const PATH = "/api/console/initiatives/:team/:slug/close";
const ACCEPTOR = "stakeholder@example.test";
const REASON = "the person who asked for it moved on before signing off";
const OTHER_EMAIL = "other@example.test";
const OTHER_TEAM = "other-team";

const EXPLORE = "## Background\nx\n\n## Current state\nx\n\n## Rough direction\nx\n";
/** A spec the spec gate approves: every declared section, one phase, one core statement. */
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

/** What an initiative is made as before its case closes it: freeform with `notes.md`, freeform with
 *  nothing, an sdlc initiative stopped at an unsigned spec, one walked to an unsigned review, one walked
 *  to its close, and `notes` already closed as accepted through the tool. */
type Shape = "notes" | "empty" | "partial" | "reviewed" | "walked" | "closed";

/** The close as the initiative records it. */
interface CloseRecord {
  closed: boolean; outcome: string | null; closed_by: string | null; accepted_by: string | null;
  no_signoff_reason: string | null; document: string | null; closes: number;
}

interface Case {
  step: string;
  key: string;
  shape: Shape;
  body: Obj;
  /** `closed` is a 200 and a close; `refused` a 400 and no close; `conflict` a 409 and the first decision kept. */
  want: "closed" | "refused" | "conflict";
  /** What the initiative records after the case: the outcome, the acceptor (`closer` for the person
   *  closing), the reason and the closing document. */
  record?: { outcome: string; acceptor: string | null; reason: string | null; document: string | null };
  /** What the tool's refusal says, for a refusal or a conflict. */
  says?: RegExp;
}

const CASES: Case[] = [
  { step: "finished with no sign-off field", key: "plain", shape: "notes", body: { disposition: "finished", document: "notes.md" },
    want: "closed", record: { outcome: "accepted", acceptor: "closer", reason: null, document: "notes.md" } },
  { step: "finished with another acceptor", key: "named", shape: "notes",
    body: { disposition: "finished", accepted_by: ACCEPTOR, document: "notes.md" },
    want: "closed", record: { outcome: "accepted", acceptor: ACCEPTOR, reason: null, document: "notes.md" } },
  { step: "finished with a reason nobody signed off", key: "unsigned", shape: "notes",
    body: { disposition: "finished", no_signoff_reason: REASON, document: "notes.md" },
    want: "closed", record: { outcome: "delivered", acceptor: null, reason: REASON, document: "notes.md" } },
  { step: "both sign-off fields", key: "both", shape: "notes",
    body: { disposition: "finished", accepted_by: ACCEPTOR, no_signoff_reason: REASON, document: "notes.md" },
    want: "refused", says: /^ERROR: `accepted_by` and `no_signoff_reason` are contradictory/ },
  { step: "a gate not approved", key: "ungated", shape: "reviewed", body: { disposition: "finished" },
    want: "refused", says: /^ERROR: \S+ cannot claim close:initiative — sdlc-review needs 1 approval about a recorded document/ },
  { step: "a governed close lands on the flow's closing document", key: "governed", shape: "walked",
    body: { disposition: "finished" },
    want: "closed", record: { outcome: "accepted", acceptor: "closer", reason: null, document: "review.md" } },
  { step: "a freeform finished close with no document", key: "nameless", shape: "notes", body: { disposition: "finished" },
    want: "refused", says: /^ERROR: no flow governs '[^']+', so nothing declares which document records the close/ },
  { step: "abandoning an initiative with no document", key: "empty", shape: "empty", body: { disposition: "abandoned" },
    want: "closed", record: { outcome: "abandoned", acceptor: null, reason: null, document: null } },
  { step: "abandoning a partial initiative", key: "partial", shape: "partial", body: { disposition: "abandoned" },
    want: "closed", record: { outcome: "abandoned", acceptor: null, reason: null, document: "spec.md" } },
  { step: "an initiative already closed", key: "again", shape: "closed",
    body: { disposition: "finished", no_signoff_reason: REASON, document: "notes.md" },
    want: "conflict", says: /^ERROR: a closing record already exists for this work/,
    record: { outcome: "accepted", acceptor: "closer", reason: null, document: "notes.md" } },
];

const show = (v: unknown): string => JSON.stringify(v).slice(0, 600);
const keysOf = (v: unknown): string => Object.keys(v as Obj).sort().join(", ");

/** The request a console session's call arrives as, past the gateway's middleware: its resolved
 *  identity, and the `x-zz-*` headers it stamps (COUPLED: identity.ts, where a resolved identity is
 *  written onto the request — the route forwards exactly these to zz-core). */
function request(c: Core, team: string, slug: string, body: Obj): Obj {
  return {
    params: { team, slug }, query: {}, body,
    zzIdentity: { email: c.email, displayName: "Skeleton", platformRole: "member", via: "session", origin: "work",
                  teams: [{ slug: c.team, role: "admin" }], activeTeam: c.team, patTeam: null, sessionTeam: c.team },
    headers: {
      "x-zz-user-email": c.email, "x-zz-user-name": "Skeleton", "x-zz-user-id": "",
      "x-zz-user-role": "user", "x-zz-via": "session", "x-zz-pat-team": "", "x-zz-session-team": c.team,
    },
  };
}

/** Calls the mounted route as Express would, and waits for the answer it sends. */
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

/** An initiative made as `shape` through zz-core as the seeded person: its dated name. The sdlc walk is
 *  `checks/document-version.ts`'s, the one a governed close is known to be granted on. */
async function make(c: Core, key: string, shape: Shape): Promise<string> {
  const step = `make ${key}`;
  const slug = await c.open(key, ["partial", "reviewed", "walked"].includes(shape) ? "sdlc-flow" : undefined);
  if (shape === "notes" || shape === "closed") {
    await c.ok(step, "document_write", { path: `${slug}/notes.md`, content: "# Notes\n\nwritten\n" });
  }
  if (shape === "closed") await c.ok(step, "initiative_close", { initiative: slug, disposition: "finished", document: "notes.md" });
  if (shape !== "partial" && shape !== "reviewed" && shape !== "walked") return slug;
  await c.ok(step, "document_write", { path: `${slug}/explore.md`, content: EXPLORE });
  await c.ok(step, "document_write", { path: `${slug}/spec.md`, content: SPEC });
  if (shape === "partial") return slug;
  await c.sign(`${slug}/spec.md`);
  await c.source(step, { initiative: slug, title: "spec audit", content: "no blocking findings", supports: ["spec.md"], stage: "sdlc-spec-audit" });
  await c.ok(step, "document_write", { path: `${slug}/plan.md`, content: "## Full-suite gate\nRun the gate.\n" });
  await c.sign(`${slug}/plan.md`);
  await c.source(step, { initiative: slug, title: "plan audit", content: "no blocking findings", supports: ["plan.md"], stage: "sdlc-plan-audit" });
  await c.ok(step, "document_write", { path: `${slug}/review.md`, content: "## Verdict\nShip it.\n" });
  await c.source(step, { initiative: slug, title: "review round", supports: ["review.md"], stage: "sdlc-review",
    content: "no blocking findings\n\n```json\n" +
      JSON.stringify({ round: 1, scope: { base: "HEAD~1", head: "HEAD" }, findings: [], resolved: [] }) + "\n```\n" });
  if (shape === "walked") await c.sign(`${slug}/review.md`);
  return slug;
}

/** The close of `slug` as the initiative and the ledger record it. */
async function recordOf(c: Core, team: string, slug: string): Promise<CloseRecord> {
  const { rows } = await c.sql.query<CloseRecord>(
    `select i.closed_at is not null as closed, i.outcome, p.email as closed_by, i.accepted_by, i.no_signoff_reason,
            (select d.path from zz.doc d
               join zz.doc_revision r on r.doc_id = d.id
              where d.initiative_id = i.id and r.fields->>'outcome' is not null
              order by r.revision desc limit 1) as document,
            (select count(*)::int from zz.event e where e.initiative_id = i.id and e.kind = 'initiative_close') as closes
       from zz.initiative i
       join zz.team t on t.id = i.team_id
       left join zz.principal p on p.id = i.closed_by
      where t.slug = $1 and i.slug = $2`, [team, slug]);
  return rows[0] ?? c.fail(`record of ${slug}`, "no such initiative");
}

/** The record once nothing more lands: the close's own ledger event is written after the reply, so a
 *  record read at once can be a row short — the same three reads in a row, as document-version.ts waits. */
async function settled(c: Core, slug: string, team = c.team): Promise<CloseRecord> {
  let last = JSON.stringify(await recordOf(c, team, slug));
  for (let same = 0, i = 0; same < 3; i++) {
    if (i > 100) c.fail(`record of ${slug}`, "the record never settled");
    await new Promise((r) => setTimeout(r, 200));
    const now = JSON.stringify(await recordOf(c, team, slug));
    same = now === last ? same + 1 : 0;
    last = now;
  }
  return JSON.parse(last) as CloseRecord;
}

/** How many `initiative.console_close` rows name `slug` as the person's act through the web, waited on
 *  briefly where one is expected: `logEvent` does not wait for its write. */
async function doors(c: Core, slug: string, expect: number): Promise<number> {
  const until = Date.now() + 5000;
  for (;;) {
    const { rows } = await c.sql.query<{ n: number }>(
      `select count(*)::int as n from zz.event e join zz.principal p on p.id = e.actor_id
        where e.kind = 'initiative.console_close' and e.subject = $1 and e.detail->>'via' = 'web' and p.email = $2
          and e.team_id = (select id from zz.team where slug = $3)`, [slug, c.email, c.team]);
    if (rows[0].n >= expect || Date.now() > until) return rows[0].n;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function run(c: Core): Promise<void> {
  await c.sql.query(
    `with p as (insert into zz.principal (email, display_name, role) values ($1, 'Other', 'member') returning id),
          t as (insert into zz.team (slug, name, created_by) select $2, 'Other team', id from p returning id),
          m as (insert into zz.membership (team_id, principal_id, role, added_by) select t.id, p.id, 'admin', p.id from t, p)
     update zz.principal set active_team_id = (select id from t) where id = (select id from p)`, [OTHER_EMAIL, OTHER_TEAM]);
  const theirs = JSON.parse(await c.ok("make the other team's", "initiative_open", { slug: "other-work" },
    c.client({ email: OTHER_EMAIL }))) as { initiative: string };
  await c.ok("make the other team's", "document_write", { path: `${theirs.initiative}/notes.md`, content: "# Notes\n" },
    c.client({ email: OTHER_EMAIL }));

  // `withThrowawayDb` ended the gateway's pool after migrating; a fresh one on the same container.
  process.env.TEAM_DB_URL = c.url;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  // The route reaches zz-core here, the harness's own child.
  process.env.CORE_MCP_URL = c.mcp.url;
  const load = (p: string) => import(pathToFileURL(join(root, "services/gateway/dist", p)).href);
  const dbModule = (await load("db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await dbModule.initPlatformDb();
  const { mountConsoleClose } = (await load("console-close.js")) as { mountConsoleClose: (app: unknown) => void };
  const routes = new Map<string, Route>();
  mountConsoleClose({ post: (path: string, h: Route) => routes.set(`POST ${path}`, h) });
  const route = routes.get(`POST ${PATH}`) ?? c.fail("mount", `no route POST ${PATH}`);
  const post = (team: string, slug: string, body: Obj) => answer(route, request(c, team, slug, body));
  const answers: Record<number, Obj> = {};

  try {
    for (const k of CASES) {
      const a = await make(c, `${k.key}-tool`, k.shape);
      const b = await make(c, `${k.key}-web`, k.shape);
      const said = await c.call(k.step, "initiative_close", { initiative: a, ...k.body });
      const got = await post(c.team, b, k.body);
      answers[got.status] ??= got.body;
      const [ra, rb] = [await settled(c, a), await settled(c, b)];
      const shown = `the tool said ${show(said)}; the route answered ${got.status} ${show(got.body)}`;
      if (JSON.stringify(ra) !== JSON.stringify(rb)) {
        c.fail(k.step, `the two adapters left different records — tool ${show(ra)}, route ${show(rb)}; ${shown}`);
      }
      const [sa, sb] = [await c.status(a), await c.status(b)] as { outcome?: string | null; closed_by?: string | null }[];
      if (k.record) {
        const r = k.record;
        const want = { closed: true, outcome: r.outcome, closed_by: c.email, accepted_by: r.acceptor === "closer" ? c.email : r.acceptor,
                       no_signoff_reason: r.reason, document: r.document, closes: 1 };
        if (JSON.stringify(rb) !== JSON.stringify(want)) c.fail(k.step, `the record is ${show(rb)}, not ${show(want)}; ${shown}`);
        for (const s of [sa, sb]) {
          if (s.outcome !== r.outcome || s.closed_by !== c.email) c.fail(k.step, `initiative_status read ${show(s)}; ${shown}`);
        }
      }
      if (k.want === "closed") {
        const result = { outcome: k.record!.outcome, closedBy: c.email, document: k.record!.document };
        if (!new RegExp(`^${a} (closed as ${k.record!.outcome}, recorded by|abandoned — )`).test(said)
            || got.status !== 200 || JSON.stringify(got.body) !== JSON.stringify(result)) {
          c.fail(k.step, `${shown}, not 200 ${show(result)}`);
        }
        if (await doors(c, b, 1) !== 1 || await doors(c, a, 0) !== 0) {
          c.fail(k.step, "the route's close is not recorded once as initiative.console_close, via: web, under the person");
        }
        c.pass(`${k.step}: both adapters close to the same record, read back by initiative_status, the route with a 200`);
        continue;
      }
      // The route's refusal read as if it named the tool's initiative: the two differ only in which one they name.
      const same = String(got.body.error).replaceAll(b, a) === said;
      if (!k.says?.test(said) || !same) c.fail(k.step, `${shown}; the tool's refusal should match ${k.says}`);
      if (k.want === "refused") {
        if (got.status !== 400 || rb.closed || sb.outcome) c.fail(k.step, `${shown}; the record is ${show(rb)}`);
        c.pass(`${k.step}: the route answers 400 with the tool's own sentence, and nothing closes`);
        continue;
      }
      if (got.status !== 409 || got.body.conflict !== "closed") c.fail(k.step, shown);
      c.pass(`${k.step}: the route answers 409 with the tool's own sentence, and the first decision stays`);
    }

    let step = "two closes through the route at once";
    const raced = await make(c, "raced-web", "notes");
    const bodies = [{ disposition: "finished", document: "notes.md" },
                    { disposition: "finished", no_signoff_reason: REASON, document: "notes.md" }];
    const both = await Promise.all(bodies.map((body) => post(c.team, raced, body)));
    const won = both.findIndex((x) => x.status === 200);
    const lost = both[1 - won];
    const held = await settled(c, raced);
    if (won < 0 || lost.status !== 409 || lost.body.conflict !== "closed" || held.closes !== 1
        || held.outcome !== both[won].body.outcome || held.outcome !== (won === 0 ? "accepted" : "delivered")) {
      c.fail(step, `answered ${show(both)}; the record is ${show(held)}`);
    }
    c.pass(`${step}: one 200, one 409, and the record holds the first decision once`);

    step = "the route refuses what the platform records and what is not a close, before zz-core is asked";
    // zz-core is unreachable from here on: a request the route relayed would answer 502.
    process.env.CORE_MCP_URL = `http://127.0.0.1:${await c.freePort()}/mcp`;
    const kept = await make(c, "kept-web", "notes");
    const refusals: [Obj, RegExp][] = [
      [{ disposition: "finished", document: "notes.md", outcome: "accepted" }, /^outcome is the platform's to record/],
      [{ disposition: "finished", document: "notes.md", closed_by: ACCEPTOR }, /^closed_by is the platform's to record/],
      [{ disposition: "done", document: "notes.md" }, /^disposition must be finished or abandoned$/],
      [{ document: "notes.md" }, /^disposition must be finished or abandoned$/],
      [{ disposition: "finished", document: "notes.md", no_signoff_reason: "   " }, /^ERROR: no_signoff_reason must be a non-empty string/],
      [{ disposition: "finished", document: "notes.md", accepted_by: "" }, /^ERROR: accepted_by must be a non-empty string/],
      [{ disposition: "abandoned", document: "nothing.md" }, new RegExp(`^ERROR: nothing\\.md is not a document of ${kept}\\.$`)],
    ];
    for (const [body, says] of refusals) {
      const got = await post(c.team, kept, body);
      if (got.status !== 400 || !says.test(String(got.body.error))) c.fail(step, `${show(body)} answered ${got.status} ${show(got.body)}`);
    }
    const untouched = await settled(c, kept);
    if (untouched.closed || untouched.closes !== 0 || await doors(c, kept, 0) !== 0) c.fail(step, `the record is ${show(untouched)}`);
    c.pass(`${step}: outcome, closed_by, a disposition outside the two, a blank sign-off and a document it does not hold are 400s`);

    step = "another team's initiative is 404 before anything is relayed";
    const theirSlug = theirs.initiative;
    const missing: [string, string][] = [[OTHER_TEAM, theirSlug], [c.team, theirSlug], [c.team, "2026-01-01-no-such-work"]];
    for (const [team, slug] of missing) {
      const got = await post(team, slug, { disposition: "abandoned" });
      if (got.status !== 404 || got.body.error !== `initiative ${team}/${slug} does not exist on this deployment`) {
        c.fail(step, `${team}/${slug} answered ${got.status} ${show(got.body)}`);
      }
      answers[404] ??= got.body;
    }
    const theirRecord = await settled(c, theirSlug, OTHER_TEAM);
    if (theirRecord.closed) c.fail(step, `the other team's initiative reads ${show(theirRecord)}`);
    c.pass(`${step}: under its own team, under the caller's, and a slug no team holds`);

    step = "a close that cannot reach zz-core is a 502";
    const unreached = await post(c.team, kept, { disposition: "abandoned" });
    if (unreached.status !== 502 || (await settled(c, kept)).closed) c.fail(step, `answered ${unreached.status} ${show(unreached.body)}`);
    c.pass(`${step}, and nothing closes`);
    process.env.CORE_MCP_URL = c.mcp.url;

    step = "the route's answers have the console's fake's key sets";
    let fake: { close: (who: unknown, team: string, slug: string, body: Obj) => [number, unknown] };
    try {
      fake = (await import(pathToFileURL(FAKE).href)) as typeof fake;
    } catch (err) {
      return c.fail(step, `could not read the console's fake answer at ${FAKE}: ${(err as Error).message}`);
    }
    const who = { email: "ava.lindqvist@example.com", activeTeam: "atlas" };
    const fakes: [number, Obj][] = [
      [200, { disposition: "abandoned" }], [400, { disposition: "finished", outcome: "accepted" }],
      [404, { disposition: "abandoned" }], [409, { disposition: "finished" }],
    ];
    for (const [status, body] of fakes) {
      const slug = status === 409 ? "2026-09-12-onboarding-revamp" : "2026-10-08-result-explanations";
      const [fakeStatus, fakeBody] = fake.close(who, status === 404 ? "beacon" : "atlas", slug, body);
      const ours = answers[status] ?? c.fail(step, `no case of this check answered ${status}`);
      if (fakeStatus !== status || keysOf(fakeBody) !== keysOf(ours)) {
        c.fail(step, `at ${status} the route answers {${keysOf(ours)}} where the fake answers ${fakeStatus} {${keysOf(fakeBody)}}`);
      }
    }
    c.pass(`${step} at 200, 400, 404 and 409`);
  } finally {
    await dbModule.platformDb().end();
    delete process.env.TEAM_DB_URL;
    delete process.env.CORE_MCP_URL;
  }
}

process.exitCode = await withThrowawayCore(NAME, DONE, run);
