#!/usr/bin/env node
/**
 * checks/console-page-view.ts — a console page view is recorded as its own kind of event, and
 * counted as nothing else (AC-1.9).
 *
 *   node checks/console-page-view.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL migrated by the real runner (`withThrowawayDb`), seeds people, a
 * team and a history of events with SQL directly, and calls the gateway's own built route handlers
 * (`services/gateway/dist/console/page-view.js`, `dist/console/activity.js` and `dist/console/home.js`) the way Express
 * would, as a console session. What it establishes:
 *
 *   - a body that is not an object, a missing or empty feature, and a feature not in the closed
 *     list are each answered 400, and none of them writes an event;
 *   - no identity is answered 401, and a member's PAT 403, as every console route answers them;
 *   - a signed-in caller's view of a known feature answers 204 and writes exactly one
 *     `console.page_view` whose subject is the feature, whose detail is `{"workspace": …}` and
 *     nothing else — `main` for a Work destination and `platform` for a Platform one, decided by the
 *     gateway even when the body claims another and carries an address beside it — whose actor and
 *     team are the caller's, whose origin is `work`, and which names no initiative, run, skill
 *     version or conversation;
 *   - a caller in no team still records a view, with no team;
 *   - the team's activity log, its summary and Home, and the superadmin's activity log asked for the
 *     platform, answer byte for byte what they answered before those views were written, the read's
 *     own cutoff masked;
 *   - a page view raises no live hint: listening on the console's change channel from before the
 *     first view, the only hints heard are the three an ordinary team event written after the views
 *     raises — the positive control, without which hearing nothing would prove nothing.
 *
 * DELIBERATE: the feature ids, the workspaces and the kind are written here and nothing is imported
 * from the gateway. A check that read them from the code under test would agree with whatever it
 * said.
 *
 * The seeded history is dated forty days ago, inside one day, with a distinct count for every kind,
 * tool and message: a view written now would add a kind and a count and head the activity log, so
 * each exclusion has something to hide.
 *
 * The only database it touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import pg from "pg";

import { root } from "../scripts/deployment.ts";
import { withThrowawayDb } from "../scripts/schema/throwaway.ts";

const NAME = "console-page-view";
const DONE = "console-page-view: a page view is one console.page_view event naming its feature and workspace, " +
  "the caller's own, refused for anything outside the closed list, absent from the activity log, its summary and Home, " +
  "and heard by no open tab: ok";

/** The channel the console's change triggers notify on. COUPLED: `zz.console_hint` in
 *  services/gateway/migrations/003_console_live.sql. */
const CHANNEL = "zz_console_change";

const TEAM = "page-team";
const CONTROL = "control-team";
const MEMBER = "reader@example.test";
const LONER = "loner@example.test";
const ADMIN = "admin@example.test";

class CaseFailure extends Error {}
const fail = (step: string, detail: string): never => { throw new CaseFailure(`${NAME}: FAILED at "${step}": ${detail}`); };
const pass = (line: string): void => console.log(`ok ${line}`);
const load = (p: string) => import(pathToFileURL(join(root, p)).href);

type Answer = { status: number; body: unknown };
type Route = (req: unknown, res: unknown) => void;
type Identity = Record<string, unknown>;

/** A console session's identity, as identity.ts resolves one onto the request. */
function session(email: string, role: "superadmin" | "member", team: string | null): Identity {
  return { email, displayName: email, platformRole: role, via: "session",
           teams: team ? [{ slug: team, role: "member" }] : [], activeTeam: team, patTeam: null, sessionTeam: team };
}

/** Calls the mounted route as Express would, and waits for the answer it sends — a body, or none. */
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

async function seed(sql: pg.Client): Promise<{ member: string; loner: string; team: string; control: string }> {
  const person = async (email: string, role: string): Promise<string> => (await sql.query<{ id: string }>(
    "insert into zz.principal (email, display_name, role) values ($1, $2, $3) returning id", [email, email, role])).rows[0].id;
  const member = await person(MEMBER, "member");
  const loner = await person(LONER, "member");
  await person(ADMIN, "superadmin");
  const team = (await sql.query<{ id: string }>(
    "insert into zz.team (slug, name, created_by) values ($1, 'Page team', $2) returning id", [TEAM, member])).rows[0].id;
  await sql.query("insert into zz.membership (team_id, principal_id, role, added_by) values ($1, $2, 'member', $2)", [team, member]);
  // The positive control's team: no view is ever recorded in it, so every hint naming it is the control's.
  const control = (await sql.query<{ id: string }>(
    "insert into zz.team (slug, name, created_by) values ($1, 'Control team', $2) returning id", [CONTROL, member])).rows[0].id;

  // Distinct counts and distinct instants, so every `order by` the reads use has one answer.
  // `minutes` places each row inside one day, forty days ago.
  const rows: { kind: string; team: boolean; ok?: boolean; tool?: string; refusal?: string; owner?: string }[] = [
    ...Array.from({ length: 4 }, () => ({ kind: "tool_call", team: true, ok: true, tool: "core:document_read" })),
    { kind: "tool_call", team: true, ok: false, tool: "core:document_write", refusal: "ERROR: GATE_REFUSED first", owner: "guardrail" },
    { kind: "tool_call", team: true, ok: false, tool: "core:document_write", refusal: "ERROR: GATE_REFUSED first", owner: "guardrail" },
    { kind: "tool_call", team: true, ok: false, tool: "core:knowledge_add", refusal: "ERROR: BAD_INPUT second", owner: "theirs" },
    ...Array.from({ length: 3 }, () => ({ kind: "knowledge.add", team: true })),
    ...Array.from({ length: 2 }, () => ({ kind: "document.approve", team: true })),
    { kind: "pat.issue", team: false },
  ];
  for (const [i, r] of rows.entries()) {
    await sql.query(
      `insert into zz.event (ts, kind, subject, ok, tool_key, refusal, refusal_owner, team_id, actor_id)
       values (now() - interval '40 days' + make_interval(mins => $1::int * 37), $2, $3, $4, $5, $6, $7, $8, $9)`,
      [i, r.kind, r.tool ?? `seed-${i}`, r.ok ?? null, r.tool ?? null, r.refusal ?? null, r.owner ?? null,
       r.team ? team : null, member]);
  }
  return { member, loner, team, control };
}

/** The page views written so far, waited on until there are `n`: an event is written after the
 *  answer it describes, so it is polled for, briefly. */
async function views(sql: pg.Client, n: number): Promise<Record<string, unknown>[]> {
  const until = Date.now() + 5000;
  for (;;) {
    const { rows } = await sql.query(
      `select subject, detail::text as detail, origin, actor_id, team_id, initiative_id, run_id,
              skill_version_id, session
         from zz.event where kind = 'console.page_view' order by subject`);
    if (rows.length >= n || Date.now() > until) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function run(sql: pg.Client, url: string): Promise<void> {
  const ids = await seed(sql);

  // `withThrowawayDb` ended the gateway's pool after migrating; a fresh one on the same container.
  process.env.TEAM_DB_URL = url;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  const db = (await load("services/gateway/dist/db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await db.initPlatformDb();
  const { mountPageView } = (await load("services/gateway/dist/console/page-view.js")) as { mountPageView: (app: unknown) => void };
  const { mountHome } = (await load("services/gateway/dist/console/home.js")) as { mountHome: (app: unknown) => void };
  const { mountActivity } = (await load("services/gateway/dist/console/activity.js")) as { mountActivity: (app: unknown) => void };
  const routes = new Map<string, Route>();
  const app = { get: (p: string, h: Route) => routes.set(`GET ${p}`, h), post: (p: string, h: Route) => routes.set(`POST ${p}`, h) };
  mountPageView(app);
  mountHome(app);
  mountActivity(app);
  const route = (key: string): Route => routes.get(key) ?? fail("mount", `no route ${key}`);
  const view = route("POST /api/console/page-view");
  const post = (id: Identity | null, body: unknown): Promise<Answer> =>
    answer(view, { params: {}, query: {}, headers: {}, body, ...(id ? { zzIdentity: id } : {}) });
  const get = (key: string, id: Identity, query: Record<string, string>): Promise<Answer> =>
    answer(route(key), { params: {}, query, headers: {}, zzIdentity: id });

  const member = session(MEMBER, "member", TEAM);
  const loner = session(LONER, "member", null);
  // Activity is the active team's whatever the request names, so the superadmin reads it acting for the team.
  const acting = session(ADMIN, "superadmin", TEAM);
  const reads: [string, string, Identity, Record<string, string>][] = [
    ["the team's activity log", "GET /api/console/activity", member, {}],
    ["the superadmin's activity log, asked for the platform", "GET /api/console/activity", acting, { scope: "platform" }],
    ["the team's activity summary", "GET /api/console/activity/summary", member, {}],
    ["the team's Home", "GET /api/console/home", member, {}],
  ];
  // An answer with its own cutoff masked: Activity and Home state the second they were read at, which no page view moves.
  const masked = (body: unknown): string => {
    const asOf = (body as { meta?: { asOf?: string } }).meta?.asOf;
    const text = JSON.stringify(body);
    return asOf ? text.replaceAll(asOf, "<asOf>") : text;
  };
  const snapshot = async (): Promise<string[]> => Promise.all(reads.map(async ([what, key, id, query]) => {
    const a = await get(key, id, query);
    if (a.status !== 200) fail("the reads answer", `${what} answered ${a.status}: ${JSON.stringify(a.body)}`);
    return masked(a.body);
  }));

  // A connection of its own, as the gateway's stream has: a session that listens hears what other
  // sessions commit.
  const listener = new pg.Client({ connectionString: url });
  await listener.connect();
  const heard: { t: string; c: string }[] = [];
  listener.on("notification", (m) => {
    if (m.channel === CHANNEL) heard.push(JSON.parse(m.payload ?? "{}") as { t: string; c: string });
  });

  try {
    const before = await snapshot();
    // The seeded history is visible to the activity reads, so an equal answer later is not an empty one.
    if (!before.slice(0, 2).every((b) => b.includes("knowledge.add")) || !before[2].includes("GATE_REFUSED")) {
      fail("the reads answer", `a read does not show the seeded history: ${before.join(" | ")}`);
    }

    let step = "what is refused";
    const refused: [string, Identity | null, unknown, number, RegExp][] = [
      ["no identity", null, { feature: "home" }, 401, /authentication required/],
      ["a member's PAT", { ...member, via: "pat", patTeam: TEAM }, { feature: "home" }, 403, /browser sign-in/],
      ["a string body", member, "home", 400, /must be an object/],
      ["an array body", member, ["home"], 400, /must be an object/],
      ["a null body", member, null, 400, /must be an object/],
      ["no body", member, undefined, 400, /must be an object/],
      ["no feature", member, {}, 400, /^feature required/],
      ["an empty feature", member, { feature: "" }, 400, /^feature required/],
      ["a feature that is not a string", member, { feature: 3 }, 400, /^feature required/],
      ["an unknown feature", member, { feature: "dashboard" }, 400, /^dashboard is not one of the console's destinations$/],
      ["an address", member, { feature: "/initiatives/secret-plan" }, 400, /is not one of the console's destinations$/],
      ["a feature in the wrong case", member, { feature: "Home" }, 400, /is not one of the console's destinations$/],
      ["an object's own property name", member, { feature: "constructor" }, 400, /is not one of the console's destinations$/],
    ];
    for (const [what, id, body, status, says] of refused) {
      const a = await post(id, body);
      const error = String((a.body as { error?: unknown } | undefined)?.error ?? "");
      if (a.status !== status || !says.test(error)) fail(step, `${what} answered ${a.status}: ${JSON.stringify(a.body)}`);
    }
    pass("no identity is 401, a member's PAT 403, and a body that is not an object, a missing feature and one outside the closed list are each 400");

    // Listening from before the first view, so a hint any of them raised is heard.
    await listener.query("listen zz_console_change");

    step = "a recorded view";
    const recorded: [Identity, unknown][] = [
      // A claimed workspace and an address beside the feature: neither reaches the event.
      [member, { feature: "home", workspace: "platform", url: "/initiatives/secret-plan?q=x" }],
      [member, { feature: "platform-status" }],
      [loner, { feature: "knowledge" }],
    ];
    for (const [id, body] of recorded) {
      const a = await post(id, body);
      if (a.status !== 204 || a.body !== undefined) fail(step, `${JSON.stringify(body)} answered ${a.status}: ${JSON.stringify(a.body)}`);
    }
    const rows = await views(sql, recorded.length);
    // Every refused request was answered before the first of these was sent, so a row from one of
    // them would be here too.
    if (rows.length !== recorded.length) fail(step, `${rows.length} console.page_view rows, not ${recorded.length}: ${JSON.stringify(rows)}`);
    const expected = [
      { subject: "home", detail: '{"workspace": "main"}', actor_id: ids.member, team_id: ids.team },
      { subject: "knowledge", detail: '{"workspace": "main"}', actor_id: ids.loner, team_id: null },
      { subject: "platform-status", detail: '{"workspace": "platform"}', actor_id: ids.member, team_id: ids.team },
    ];
    for (const [i, want] of expected.entries()) {
      const got = rows[i];
      if (got.subject !== want.subject || got.detail !== want.detail || got.actor_id !== want.actor_id
          || got.team_id !== want.team_id || got.origin !== "work" || got.initiative_id !== null || got.run_id !== null
          || got.skill_version_id !== null || got.session !== "") {
        fail(step, `the view of ${want.subject} reads ${JSON.stringify(got)}, not ${JSON.stringify({ ...want, origin: "work" })} ` +
                   "with no initiative, run, skill version or conversation");
      }
    }
    pass("a view writes one console.page_view: subject the feature, detail only its workspace (main, or platform for a Platform " +
         "destination, whatever the body claimed), the caller as actor, the caller's team, origin work, and nothing else");
    pass("a caller in no team records a view with no team");

    step = "counted as nothing else";
    const after = await snapshot();
    for (const [i, [what]] of reads.entries()) {
      if (after[i] !== before[i]) fail(step, `${what} changed after ${recorded.length} page views:\n  before ${before[i]}\n  after  ${after[i]}`);
    }
    for (const [id, query] of [[member, { kind: "console.page_view" }], [acting, { scope: "platform", kind: "console.page_view" }]] as const) {
      const a = await get("GET /api/console/activity", id, query);
      const { rows: events, total, kinds } = a.body as { rows?: unknown[]; total?: number; kinds?: string[] };
      if (a.status !== 200 || !Array.isArray(events) || events.length !== 0 || total !== 0 || kinds?.includes("console.page_view")) {
        fail(step, `the activity log asked for ${JSON.stringify(query)} answered ${a.status}: ${JSON.stringify(a.body)}`);
      }
    }
    pass("the team's activity log, its summary and Home, and the superadmin's log asked for the platform, answer byte for byte what " +
         "they answered before the views, and the log asked for page views by kind lists none");

    step = "heard by no open tab";
    // The positive control: an ordinary event of another team, written after every view committed.
    // Postgres delivers notifications in commit order, so once its hints are heard, any hint a view
    // raised has been heard before them.
    await sql.query("insert into zz.event (kind, subject, team_id) values ('knowledge.add', 'control', $1)", [ids.control]);
    const until = Date.now() + 5000;
    while (heard.filter((h) => h.t === CONTROL).length < 3 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    const control = heard.filter((h) => h.t === CONTROL).map((h) => h.c).sort().join(",");
    if (control !== "activity,overview,runs") {
      fail(step, `the control event raised [${control}] on ${CHANNEL}, not activity, overview and runs — the listener hears nothing, ` +
                 `so it cannot say what a page view raised (heard ${JSON.stringify(heard)})`);
    }
    const fromViews = heard.filter((h) => h.t !== CONTROL);
    if (fromViews.length) fail(step, `the page views raised ${fromViews.length} hints: ${JSON.stringify(fromViews)}`);
    pass("a page view raises no live hint, while an ordinary team event written after it raises activity, overview and runs");
  } finally {
    await listener.end().catch(() => undefined);
    await db.platformDb().end().catch(() => undefined);
    delete process.env.TEAM_DB_URL;
    delete process.env.ZZ_CATALOG_DIR;
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
