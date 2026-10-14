#!/usr/bin/env node
/**
 * checks/console-bug-resolve.ts — the console's bug resolution and zz-core's `bug_resolve`, held to
 * one answer on a real database through a real zz-core.
 *
 *   node checks/console-bug-resolve.ts   # needs Docker and a built tree (`npm run build`)
 *
 * `POST /api/console/platform/bugs/:id/resolve` calls `bug_resolve` as the person
 * (services/gateway/src/console/platform-bug-resolve.ts). It starts a throwaway PostgreSQL and a
 * real zz-core on it (`withThrowawayCore`), and runs every case twice from the same starting rows,
 * fixed ids included: once as the tool, called by a superadmin's MCP client, and once as the
 * gateway's own built route handler, called the way Express would by a superadmin's console
 * session. What it establishes:
 *
 *   - `fixed`, `not_a_bug` and `duplicate` leave the same rows through both, the route answering
 *     204 where the tool answers its JSON, and a report filed in no team may duplicate another in
 *     none;
 *   - a duplicate with no target, a foreign, self or nonexistent target, a target given with
 *     another status, and an empty or whitespace resolution are refused with the same sentence,
 *     the route's 400 carrying the tool's text, and change nothing;
 *   - a second close is the route's 409 carrying the tool's sentence, which still opens `already
 *     closed as` as the release's chain check expects, and the first decision stays;
 *   - a path id that is not a UUID, or a UUID naming no report, is the route's 404 with no body,
 *     answered before zz-core is asked, where the tool refuses; nothing changes;
 *   - two resolves started together, through either adapter, leave the first decision and refuse
 *     the other, the route answering one 204 and one 409;
 *   - a member's request to the route is 403 with no name in the body, and changes nothing;
 *   - `bug_report` refuses a title or a detail that is blank after trimming;
 *   - the route records its act as the console's door, `via: "web"`.
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

const NAME = "console-bug-resolve";
const DONE = "console-bug-resolve: the console and the MCP tool close a report to the same row and refuse " +
  "it with the same sentence, a second or simultaneous close keeps the first decision, a member " +
  "changes nothing, and a blank report is not filed: ok";

type Answer = { status: number; body: unknown };
type Route = (req: unknown, res: unknown) => void;

/** The reports every case starts from, by fixed id, so both adapters see the same ids and say them
 *  in the same sentences. */
const S = "00000000-0000-4000-8000-000000000001";   // open, the case's subject
const T = "00000000-0000-4000-8000-000000000002";   // open, same team: a target that holds
const F = "00000000-0000-4000-8000-000000000003";   // open, another team: a foreign target
const N1 = "00000000-0000-4000-8000-000000000004";  // open, no team
const N2 = "00000000-0000-4000-8000-000000000005";  // open, no team: N1's target
const C = "00000000-0000-4000-8000-000000000006";   // already closed
const NONE = "00000000-0000-4000-8000-000000000099"; // carried by no report
const SEEDED_AT = "2026-10-02T00:00:00Z";
const FIRST = "Fixed by the first operator.";
const OTHER_TEAM = "other-team";

/** The request a console session's call arrives as, past the gateway's middleware: its resolved
 *  identity, and the `x-zz-*` headers it stamps (COUPLED: identity.ts, where a resolved identity is
 *  written onto the request — the route forwards exactly these to zz-core). */
function request(c: Core, who: { email: string; role: "superadmin" | "member" }, id: string,
                 body: Record<string, unknown>): Record<string, unknown> {
  return {
    params: { id }, query: {}, body,
    zzIdentity: { email: who.email, displayName: "Skeleton", platformRole: who.role, via: "session",
                  teams: [{ slug: c.team, role: "admin" }], activeTeam: c.team, patTeam: null,
                  sessionTeam: c.team },
    headers: {
      "x-zz-user-email": who.email, "x-zz-user-name": "Skeleton", "x-zz-user-id": "",
      "x-zz-user-role": who.role === "superadmin" ? "admin" : "user", "x-zz-via": "session",
      "x-zz-pat-team": "", "x-zz-session-team": c.team,
    },
  };
}

/** Calls the mounted route as Express would, and waits for the answer it sends: a JSON body, or
 *  none at all (`end()`), which is how a 204 and a 404 arrive. */
function answer(route: Route, req: Record<string, unknown>): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200, headersSent: false,
      status(code: number) { this.statusCode = code; return this; },
      json(body: unknown) { this.headersSent = true; resolve({ status: this.statusCode, body }); },
      end() { this.headersSent = true; resolve({ status: this.statusCode, body: undefined }); },
    };
    try { route(req, res); } catch (err) { reject(err); }
  });
}

/** A superadmin's MCP client: the harness's own carry `x-zz-user-role: user`, and zz-core offers
 *  `bug_resolve` only behind `if (sup)`. */
function adminClient(c: Core): Mcp {
  return new Mcp(c.mcp.url, {
    client: NAME, timeoutMs: 60_000,
    headers: {
      "x-zz-user-email": c.email, "x-zz-user-name": "Skeleton", "x-zz-user-id": "",
      "x-zz-user-role": "admin", "x-zz-via": "forwarded", "x-zz-pat-team": "", "x-zz-session-team": "",
    },
  });
}

/** The tool's success reply, or null for anything else. */
function closed(reply: string): { id: string; status: string; resolution: string } | null {
  try {
    const v = JSON.parse(reply) as { id?: unknown; status?: unknown; resolution?: unknown };
    return typeof v.id === "string" && typeof v.status === "string" && typeof v.resolution === "string"
      ? { id: v.id, status: v.status, resolution: v.resolution } : null;
  } catch {
    return null;
  }
}

interface Case {
  step: string;
  /** The path's id: the report being closed. */
  id: string;
  body: Record<string, unknown>;
  /** `ok` closes `id`; `refused` is a 400; `conflict` a 409; `missing` the route's 404. */
  want: "ok" | "refused" | "conflict" | "missing";
  /** What the tool's refusal says, for every outcome but `ok`. */
  says?: RegExp;
}

const CASES: Case[] = [
  { step: "fixed", id: S, body: { status: "fixed", resolution: "Fixed in the next release. " }, want: "ok" },
  { step: "not_a_bug", id: S, body: { status: "not_a_bug", resolution: "Intended: the refusal names the rule." }, want: "ok" },
  { step: "duplicate", id: S, body: { status: "duplicate", resolution: "Same as the earlier report.", duplicate_of: T }, want: "ok" },
  { step: "duplicate in no team", id: N1, body: { status: "duplicate", resolution: "Same as the other one.", duplicate_of: N2 }, want: "ok" },
  { step: "duplicate with no target", id: S, body: { status: "duplicate", resolution: "Same." },
    want: "refused", says: /has to name the report it duplicates/ },
  { step: "foreign target", id: S, body: { status: "duplicate", resolution: "Same.", duplicate_of: F },
    want: "refused", says: /filed by another team/ },
  { step: "self target", id: S, body: { status: "duplicate", resolution: "Same.", duplicate_of: S },
    want: "refused", says: /cannot duplicate itself/ },
  { step: "nonexistent target", id: S, body: { status: "duplicate", resolution: "Same.", duplicate_of: NONE },
    want: "refused", says: new RegExp(`no bug with id ${NONE}`) },
  { step: "target on another status", id: S, body: { status: "fixed", resolution: "Done.", duplicate_of: T },
    want: "refused", says: /is only for a `duplicate` resolution/ },
  { step: "empty resolution", id: S, body: { status: "fixed", resolution: "" }, want: "refused", says: /resolution/ },
  { step: "whitespace resolution", id: S, body: { status: "fixed", resolution: "   " },
    want: "refused", says: /^ERROR: a resolution says what was decided and why — it cannot be blank/ },
  { step: "second close", id: C, body: { status: "not_a_bug", resolution: "A second opinion." },
    want: "conflict", says: /^ERROR: that report was already closed as `fixed` by .* — "Fixed by the first operator\."/ },
  { step: "path id not a UUID", id: "not-a-uuid", body: { status: "fixed", resolution: "Done." }, want: "missing", says: /id/ },
  { step: "path id naming no report", id: NONE, body: { status: "fixed", resolution: "Done." },
    want: "missing", says: new RegExp(`^ERROR: no bug with id ${NONE}$`) },
];

async function run(c: Core): Promise<void> {
  const member = await c.member();
  const ids = (await c.sql.query<{ principal: string; other: string }>(
    `with t as (insert into zz.team (slug, name, created_by)
                select $2, 'Other team', id from zz.principal where email = $1 returning id)
     select (select id::text from zz.principal where email = $1) as principal, (select id::text from t) as other`,
    [c.email, OTHER_TEAM])).rows[0];

  /** Every report back to where every case starts. */
  const reset = async (): Promise<void> => {
    await c.sql.query("delete from zz.bug");
    await c.sql.query(
      `insert into zz.bug (id, title, detail, team_id, reported_by, reported_at, status, resolution, resolved_by, resolved_at)
       values ($1::uuid, 'Source', 'The report being closed.', (select id from zz.team where slug = $7), $8::uuid, $9::timestamptz, 'open', null, null, null),
              ($2::uuid, 'Target', 'An earlier report.', (select id from zz.team where slug = $7), $8::uuid, $9::timestamptz, 'open', null, null, null),
              ($3::uuid, 'Foreign', 'Another team''s report.', $10::uuid, $8::uuid, $9::timestamptz, 'open', null, null, null),
              ($4::uuid, 'Teamless', 'Filed in no team.', null, $8::uuid, $9::timestamptz, 'open', null, null, null),
              ($5::uuid, 'Teamless target', 'Also filed in no team.', null, $8::uuid, $9::timestamptz, 'open', null, null, null),
              ($6::uuid, 'Closed', 'Already decided.', (select id from zz.team where slug = $7), $8::uuid, $9::timestamptz, 'fixed', $11, $8::uuid, $9::timestamptz)`,
      [S, T, F, N1, N2, C, c.team, ids.principal, SEEDED_AT, ids.other, FIRST]);
  };
  /** Every report as a case compares it: a close made now reads `now`, the seeded one `seeded`. */
  const rows = async (): Promise<string> => JSON.stringify((await c.sql.query(
    `select id::text as id, team_id::text as team_id, status, resolution, resolved_by::text as resolved_by,
            duplicate_of::text as duplicate_of,
            case when resolved_at is null then null when resolved_at = $1::timestamptz then 'seeded' else 'now' end as resolved_at
       from zz.bug order by id`, [SEEDED_AT])).rows);

  // `withThrowawayDb` ended the gateway's pool after migrating; a fresh one on the same container.
  process.env.TEAM_DB_URL = c.url;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  // The route reaches zz-core here, the harness's own child.
  process.env.CORE_MCP_URL = c.mcp.url;
  const load = (p: string) => import(pathToFileURL(join(root, p)).href);
  const dbModule = (await load("services/gateway/dist/db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await dbModule.initPlatformDb();
  const { mountPlatformBugResolve } = (await load("services/gateway/dist/console/platform-bug-resolve.js")) as
    { mountPlatformBugResolve: (app: unknown) => void };
  const routes = new Map<string, Route>();
  mountPlatformBugResolve({ post: (path: string, h: Route) => routes.set(`POST ${path}`, h) });
  const PATH = "/api/console/platform/bugs/:id/resolve";
  const route = routes.get(`POST ${PATH}`) ?? c.fail("mount", `no route POST ${PATH}`);
  const admin = { email: c.email, role: "superadmin" as const };
  const post = (id: string, body: Record<string, unknown>, who: { email: string; role: "superadmin" | "member" } = admin) =>
    answer(route, request(c, who, id, body));
  const tool = adminClient(c);
  const resolve = (id: string, body: Record<string, unknown>, via: Mcp = tool): Promise<string> =>
    c.call(`bug_resolve ${id}`, "bug_resolve", { id, ...body }, via);

  try {
    await reset();
    const start = await rows();
    for (const k of CASES) {
      await reset();
      const said = await resolve(k.id, k.body);
      const toolRows = await rows();
      await reset();
      const got = await post(k.id, k.body);
      const routeRows = await rows();
      const shown = `the tool said ${JSON.stringify(said)}; the route answered ${got.status} ${JSON.stringify(got.body)}`;
      if (toolRows !== routeRows) {
        c.fail(k.step, `the two adapters left different rows — tool ${toolRows}, route ${routeRows}`);
      }
      if (k.want === "ok") {
        const done = closed(said);
        const row = (JSON.parse(routeRows) as Record<string, unknown>[]).find((r) => r.id === k.id);
        const resolution = String(k.body.resolution).trim();
        if (!done || done.status !== k.body.status || done.resolution !== resolution || got.status !== 204
            || got.body !== undefined || !row || row.status !== k.body.status || row.resolution !== resolution
            || row.resolved_by !== ids.principal || row.duplicate_of !== (k.body.duplicate_of ?? null)
            || row.resolved_at !== "now") {
          c.fail(k.step, `${shown}; the row is ${JSON.stringify(row)}`);
        }
        c.pass(`${k.step}: both adapters close the report to the same row, the route with a 204`);
        continue;
      }
      if (toolRows !== start) c.fail(k.step, `a refusal changed the rows: ${toolRows}`);
      if (closed(said) || !k.says?.test(said)) c.fail(k.step, `${shown}; the tool's refusal should match ${k.says}`);
      if (k.want === "missing") {
        if (got.status !== 404 || got.body !== undefined) c.fail(k.step, shown);
        c.pass(`${k.step}: the route answers 404 with no body before zz-core is asked, the tool refuses, and nothing changes`);
        continue;
      }
      const status = k.want === "conflict" ? 409 : 400;
      if (got.status !== status || (got.body as { error?: unknown } | undefined)?.error !== said) c.fail(k.step, shown);
      c.pass(`${k.step}: the route answers ${status} with the tool's own sentence, and nothing changes`);
    }

    let step = "two resolves through the route at once";
    await reset();
    const raced = [{ status: "fixed", resolution: "Fixed: the first of two." },
                   { status: "not_a_bug", resolution: "Intended: the second of two." }];
    const both = await Promise.all(raced.map((b) => post(S, b)));
    const won = both.findIndex((a) => a.status === 204);
    const lost = both[1 - won];
    const after = (JSON.parse(await rows()) as Record<string, unknown>[]).find((r) => r.id === S);
    if (won < 0 || lost.status !== 409
        || !String((lost.body as { error?: unknown }).error).startsWith("ERROR: that report was already closed as")
        || !String((lost.body as { error?: unknown }).error).includes(raced[won].resolution)
        || after?.status !== raced[won].status || after?.resolution !== raced[won].resolution) {
      c.fail(step, `answered ${JSON.stringify(both)}; the row is ${JSON.stringify(after)}`);
    }
    c.pass("two resolves through the route at once: one 204, one 409 naming the first decision, and the row holds the first");

    step = "two resolves through the tool at once";
    await reset();
    const replies = await Promise.all(raced.map((b, i) => resolve(S, b, i ? adminClient(c) : tool)));
    const first = replies.findIndex((r) => closed(r) !== null);
    const held = (JSON.parse(await rows()) as Record<string, unknown>[]).find((r) => r.id === S);
    if (first < 0 || !/^ERROR: that report was already closed as/.test(replies[1 - first])
        || held?.status !== raced[first].status || held?.resolution !== raced[first].resolution) {
      c.fail(step, `replied ${JSON.stringify(replies)}; the row is ${JSON.stringify(held)}`);
    }
    c.pass("two resolves through the tool at once: one closes, the other is refused, and the row holds the first");

    step = "a member is refused";
    await reset();
    const refused = await post(S, { status: "fixed", resolution: "A member's close." }, { email: member, role: "member" });
    const body = JSON.stringify(refused.body ?? null);
    if (refused.status !== 403 || body.includes(member) || body.includes(c.email) || /admin/i.test(body)
        || await rows() !== start) {
      c.fail(step, `answered ${refused.status} ${body}`);
    }
    c.pass("a member's request is 403 with no name in the body, and changes nothing");

    step = "a blank report is refused";
    await reset();
    await c.refused(step, "bug_report", { title: "   ", detail: "Something broke." }, /^ERROR: `title` is blank/);
    await c.refused(step, "bug_report", { title: "It broke", detail: " \n " }, /^ERROR: `detail` is blank/);
    if (await rows() !== start) c.fail(step, "a blank report was filed");
    c.pass("bug_report refuses a title or a detail that is blank after trimming, and files nothing");

    step = "the route records the console's door";
    await reset();
    const recorded = await post(S, { status: "fixed", resolution: "Fixed, recorded." });
    if (recorded.status !== 204) c.fail(step, `answered ${recorded.status} ${JSON.stringify(recorded.body)}`);
    // `logEvent` does not wait for its write, so the row is waited on, briefly.
    const until = Date.now() + 5000;
    for (;;) {
      const { rows: seen } = await c.sql.query<{ n: number }>(
        `select count(*)::int as n from zz.event e join zz.principal p on p.id = e.actor_id
          where e.kind = 'bug.console_resolve' and e.subject = $1 and e.detail->>'via' = 'web'
            and e.detail->>'status' = 'fixed' and p.email = $2`, [S, c.email]);
      if (seen[0].n > 0) break;
      if (Date.now() > until) c.fail(step, "no bug.console_resolve event with via: web names the person");
      await new Promise((r) => setTimeout(r, 100));
    }
    c.pass("a close from the console is recorded as bug.console_resolve, via: web, under the person");
  } finally {
    await dbModule.platformDb().end();
    delete process.env.TEAM_DB_URL;
    delete process.env.CORE_MCP_URL;
  }
}

process.exitCode = await withThrowawayCore(NAME, DONE, run);
