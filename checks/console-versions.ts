#!/usr/bin/env node
/**
 * checks/console-versions.ts — the console's document and initiative reads, and its presentation
 * and approval, on a real database through a real zz-core.
 *
 *   node checks/console-versions.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL and a real zz-core on it (`withThrowawayCore`), seeds rows with
 * SQL directly, and calls the gateway's own built route handlers (`services/gateway/dist/console/
 * initiatives.js` and `dist/console-write.js`) the way Express would, signed in as a console
 * session. The write routes reach that zz-core through `CORE_MCP_URL`, carrying the identity
 * headers the gateway's middleware stamps on a console session (identity.ts): `x-zz-via: session`,
 * `x-zz-user-email`, `x-zz-session-team`. What it establishes:
 *
 *   - a document's `versions` holds one entry per public version, each the version's approved
 *     snapshot when it has one and else its last, with `version` the public number and `revision`
 *     the snapshot to fetch; `current_version` is the document's own;
 *   - `?revision=` returns that one snapshot's text and names its public version;
 *   - a closed initiative whose closing document is a pending correction reads as closed and
 *     complete, with `correction` naming the document and its version, on the initiative and on
 *     the list; a close that was approved and never corrected carries no correction; and a close
 *     recorded on a draft (an abandoned close) is not a correction and still reads as incomplete;
 *   - the bell (`?waiting=1`) lists a closed initiative's pending correction, and no other closed one;
 *   - the document read names the displayed snapshot's `content_revision`, the token zz-core states;
 *   - opening a document records a full presentation of that snapshot under the console's own
 *     review context, which `POST /documents/shown` returns; Approve with that revision and that
 *     context signs it; a document edited after it was shown answers the conflict in the console's
 *     words and is not signed; and an agent's approval never rests on the console's context.
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
import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";

const EMAIL = "console@example.test";
const TEAM = "console-team";
const VERSIONS = "2026-10-06-versions";
const CORRECTED = "2026-10-06-corrected";
const SIGNED = "2026-10-06-signed";
const DROPPED = "2026-10-06-dropped";

const NAME = "console-versions";
const DONE = "console-versions: public versions, snapshot reads, pending corrections, and the console's " +
  "presentation and approval: ok";

/** One snapshot as seeded: its public version, whether it was presented or approved, and the
 *  `outcome` its fields carry when a close stamped one. */
type Snap = { version: number; approved?: boolean; presented?: boolean; outcome?: string };

async function seed(db: pg.Client): Promise<{ principal: string; team: string }> {
  const p = await db.query<{ id: string }>(
    "INSERT INTO zz.principal (email, display_name, role) VALUES ($1, 'Console', 'superadmin') RETURNING id", [EMAIL]);
  const principal = p.rows[0].id;
  const t = await db.query<{ id: string }>(
    "INSERT INTO zz.team (slug, name, created_by) VALUES ($1, 'Console team', $2) RETURNING id", [TEAM, principal]);
  await db.query(
    "INSERT INTO zz.membership (team_id, principal_id, role, added_by) VALUES ($1, $2, 'admin', $2)", [t.rows[0].id, principal]);
  return { principal, team: t.rows[0].id };
}

async function initiative(db: pg.Client, team: string, principal: string, slug: string, flow: string | null,
                          outcome: string | null): Promise<string> {
  const i = await db.query<{ id: string }>(
    `INSERT INTO zz.initiative (team_id, slug, flow, opened_by, closed_at, closed_by, outcome, accepted_by)
     VALUES ($1, $2, $3, $4, CASE WHEN $5::text IS NULL THEN NULL ELSE now() END,
             CASE WHEN $5::text IS NULL THEN NULL ELSE $4::uuid END, $5::text,
             CASE WHEN $5::text = 'accepted' THEN $6 END) RETURNING id`,
    [team, slug, flow, principal, outcome, EMAIL]);
  return i.rows[0].id;
}

/** A document and its snapshots, revision numbers counting from 1, the last one current. Its
 *  `status` and `approved_revision` follow the current snapshot, as `zz.doc`'s check demands. */
async function document(db: pg.Client, principal: string, initiativeId: string, path: string, type: string,
                        snaps: Snap[]): Promise<void> {
  const current = snaps.length;
  const last = snaps[current - 1];
  const approvedAt = snaps.map((s, i) => (s.approved ? i + 1 : 0)).filter(Boolean).pop() ?? null;
  // `zz.doc` names its current revision before it exists (a deferrable key); the approved one is
  // set once the revisions are in, because that key is not deferrable.
  await db.query("BEGIN");
  await db.query("SET CONSTRAINTS ALL DEFERRED");
  const d = await db.query<{ id: string }>(
    `INSERT INTO zz.doc (initiative_id, path, type, status, updated_at, title, body, current_revision,
                         current_version)
     VALUES ($1, $2, $3, 'draft', now(), $2, $4, $5, $6) RETURNING id`,
    [initiativeId, path, type, `body of r${current}`, current, last.version]);
  for (const [i, s] of snaps.entries()) {
    const fields = s.outcome ? { outcome: s.outcome, closed_by: EMAIL } : {};
    await db.query(
      `INSERT INTO zz.doc_revision (doc_id, revision, version, content_state, title, body, tags, content_hash,
                                    written_by, written_at, approved_by, approved_at, presented_at, fields)
       VALUES ($1, $2, $3, 'retained', $4, $5, '{}', $6, $7, now() - make_interval(mins => $8::int),
               $9, $10, $11, $12)`,
      [d.rows[0].id, i + 1, s.version, path, `body of r${i + 1}`, `h${i + 1}`, principal, current - i,
       s.approved ? principal : null, s.approved ? new Date().toISOString() : null,
       s.presented || s.approved ? new Date().toISOString() : null, JSON.stringify(fields)]);
  }
  await db.query("UPDATE zz.doc SET status = $2, approved_revision = $3 WHERE id = $1",
    [d.rows[0].id, last.approved ? "approved" : "draft", approvedAt]);
  await db.query("COMMIT");
}

/** Every document sdlc-flow gates (handover.md included), approved, with the closing document's
 *  snapshots given. */
async function closedFlow(db: pg.Client, principal: string, initiativeId: string, review: Snap[]): Promise<void> {
  await document(db, principal, initiativeId, "explore.md", "ground", [{ version: 1 }]);
  for (const [path, type] of [["spec.md", "agreement"], ["plan.md", "plan"], ["handover.md", "handover"]]) {
    await document(db, principal, initiativeId, path, type, [{ version: 1, approved: true }]);
  }
  await document(db, principal, initiativeId, "review.md", "verification", review);
}

type Answer = { status: number; body: Record<string, unknown> };
type Route = (req: unknown, res: unknown) => void;

/** Who a request is from: the identity the gateway's middleware resolved for a console session. */
interface Who { email: string; name: string; role: "superadmin" | "member"; team: string }

/** The request a console session's call arrives as, past the gateway's middleware: its resolved
 *  identity, and the `x-zz-*` headers it stamps (COUPLED: identity.ts, where a resolved identity is
 *  written onto the request — the write routes forward exactly these to zz-core). */
function request(who: Who, params: Record<string, string>, query: Record<string, string>,
                 body?: Record<string, unknown>): Record<string, unknown> {
  return {
    params, query, body,
    zzIdentity: { email: who.email, displayName: who.name, platformRole: who.role, via: "session",
                  teams: [{ slug: who.team, role: "admin" }], activeTeam: who.team, patTeam: null,
                  sessionTeam: who.team },
    headers: {
      "x-zz-user-email": who.email, "x-zz-user-name": who.name, "x-zz-user-id": "",
      "x-zz-user-role": who.role === "superadmin" ? "admin" : "user", "x-zz-via": "session",
      "x-zz-pat-team": "", "x-zz-session-team": who.team,
    },
  };
}

/** Calls one mounted route as Express would, and waits for the answer it sends. */
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

/** The body an agent writes for the console to show: two sections, so an edit leaves records. */
const BODY = "# Notes\n\n## Alpha\n\nalpha line one\n\nalpha line two\n\n## Beta\n\nbeta line one\n\nbeta line two\n";
const CONTEXT = /^rc_[a-z2-7]{26}$/;

/** The content revision zz-core's own read of the current document states. */
async function tokenOf(c: Core, step: string, path: string): Promise<string> {
  const read = await c.ok(step, "document_read", { path });
  return /^content_revision: (cr_[a-z2-7]{26})$/m.exec(read)?.[1] ?? c.fail(step, `no content_revision in: ${read}`);
}

/** The `zz.event` rows of one kind about one document, oldest first. The gateway's own rows are
 *  written fire-and-forget after it answers, so a row looked for is waited on, briefly. */
async function events(c: Core, kind: string, subject: string, want = 1): Promise<Record<string, unknown>[]> {
  const until = Date.now() + 5000;
  for (;;) {
    const { rows } = await c.sql.query<{ detail: Record<string, unknown> }>(
      "select detail from zz.event where kind = $1 and subject = $2 order by ts, id", [kind, subject]);
    if (rows.length >= want || Date.now() > until) return rows.map((r) => r.detail);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The status zz-core holds for a document. */
async function statusOf(c: Core, initiative: string, name: string): Promise<string | null> {
  const { rows } = await c.sql.query<{ status: string | null }>(
    `select d.status from zz.doc d join zz.initiative i on i.id = d.initiative_id
      where i.slug = $1 and d.path = $2`, [initiative, name]);
  return rows[0]?.status ?? null;
}

/** The console presents what it displays and approves what it presented. The documents are the
 *  harness's principal's, written by an agent through zz-core (`x-zz-via: forwarded`); the console
 *  session is the same person in a browser (`x-zz-via: session`), a different credential kind. */
async function presentation(c: Core, routes: { detail: Route; shown: Route; approve: Route }): Promise<void> {
  const who: Who = { email: c.email, name: "Skeleton", role: "member", team: c.team };
  const initiative = await c.open("console-present");
  const name = "notes.md";
  const path = `${initiative}/${name}`;
  await c.ok("an agent writes the document", "document_write", { path, content: BODY });
  const detail = async (step: string, doc = name): Promise<Record<string, unknown>> => {
    const d = await answer(routes.detail, request(who, { team: c.team, initiative, 0: doc }, {}));
    if (d.status !== 200) c.fail(step, `the document read answered ${d.status}: ${JSON.stringify(d.body)}`);
    return d.body;
  };
  const post = (r: Route, body: Record<string, unknown>, doc = name): Promise<Answer> =>
    answer(r, request(who, {}, { team: c.team }, { initiative, path: doc, ...body }));

  let step = "the document read names its snapshot";
  const cr1 = (await detail(step)).content_revision;
  const stated = await tokenOf(c, step, path);
  if (cr1 !== stated) c.fail(step, `content_revision was ${JSON.stringify(cr1)}, zz-core's read states ${stated}`);
  c.pass("the document read names the displayed snapshot's content_revision, the token zz-core states");

  step = "opening it records a presentation";
  const s1 = await post(routes.shown, { content_revision: cr1 });
  const rc = s1.body.review_context;
  if (s1.status !== 200 || typeof rc !== "string" || !CONTEXT.test(rc)) {
    c.fail(step, `POST /documents/shown answered ${s1.status}: ${JSON.stringify(s1.body)}`);
  }
  const shown = await events(c, "document.shown", path);
  const mine = shown.filter((e) => e.review_context === rc);
  if (mine.length !== 1 || mine[0].target !== cr1 || mine[0].kind !== "full" || mine[0].credential !== "session"
      || mine[0].start !== 0 || mine[0].end !== mine[0].total) {
    c.fail(step, `zz-core recorded ${JSON.stringify(shown)} — expected one full presentation of ${cr1} under ${rc}, ` +
      "credential session");
  }
  const door = await events(c, "document.console_shown", path);
  if (door.length !== 1 || door[0].via !== "web") c.fail(step, `the gateway's own row was ${JSON.stringify(door)}`);
  const again = await post(routes.shown, { content_revision: cr1, review_context: rc });
  if (again.status !== 200 || again.body.review_context !== rc
      || (await events(c, "document.shown", path)).length !== shown.length) {
    c.fail(step, `showing it again under ${rc} answered ${again.status} ${JSON.stringify(again.body)}, or recorded a second row`);
  }
  c.pass("opening a document records one full presentation of that snapshot under the console's own context");

  step = "an agent's approval";
  await c.refused(step, "document_approve", { path }, /^ERROR: PRESENTATION_REQUIRED/);
  await c.refused(step, "document_approve", { path, review_context: rc },
    /^ERROR: PRESENTATION_REQUIRED — the review context \S+ is not one of yours/);
  if (await statusOf(c, initiative, name) === "approved") c.fail(step, "an agent's refused approval sealed the document");
  c.pass("an agent's approval does not rest on the console's context, passed or found");

  step = "an edit after display";
  await c.ok(step, "document_edit", { path, edits: [{ find: "beta line two", replace: "beta line two, edited" }] });
  const stale = await post(routes.approve, { expected_revision: cr1, review_context: rc });
  const said = String(stale.body.error ?? "");
  if (stale.status !== 409 || stale.body.conflict !== "changed" || /^ERROR|APPROVAL_CONFLICT/.test(said)
      || !said.includes(name) || !/reload/i.test(said)) {
    c.fail(step, `Approve on the snapshot shown answered ${stale.status}: ${JSON.stringify(stale.body)} — expected a 409 ` +
      "conflict in the console's words, naming the document and saying to reload");
  }
  if (await statusOf(c, initiative, name) === "approved") c.fail(step, "the conflicting approval sealed the document");
  const late = await post(routes.shown, { content_revision: cr1, review_context: rc });
  if (late.status !== 409 || late.body.conflict !== "changed" || /^ERROR/.test(String(late.body.error))) {
    c.fail(step, `recording the old snapshot as shown answered ${late.status}: ${JSON.stringify(late.body)}`);
  }
  c.pass("an edit after display makes Approve the conflict, in the console's words, and nothing is signed");

  step = "Approve with the displayed revision";
  const cr2 = (await detail(step)).content_revision;
  if (typeof cr2 !== "string" || cr2 === cr1) c.fail(step, `after the edit the read names ${JSON.stringify(cr2)}`);
  const s2 = await post(routes.shown, { content_revision: cr2, review_context: rc });
  if (s2.status !== 200 || s2.body.review_context !== rc) {
    c.fail(step, `showing the edited snapshot under ${rc} answered ${s2.status}: ${JSON.stringify(s2.body)}`);
  }
  const signed = await post(routes.approve, { expected_revision: cr2, review_context: rc });
  if (signed.status !== 200 || signed.body.ok !== true) {
    c.fail(step, `Approve answered ${signed.status}: ${JSON.stringify(signed.body)}`);
  }
  const act = await events(c, "document.document_approve", path);
  if (await statusOf(c, initiative, name) !== "approved" || act.length !== 1
      || act[0].review_context !== rc || act[0].content_revision !== cr2) {
    c.fail(step, `the approval recorded ${JSON.stringify(act)} — expected one, resting on ${rc} at ${cr2}`);
  }
  const approved = await events(c, "document.approve", path);
  if (approved.length !== 1 || approved[0].via !== "web") c.fail(step, `the gateway's own row was ${JSON.stringify(approved)}`);
  c.pass("Approve with the displayed revision and the console's context signs exactly that snapshot");

  step = "a console approval on an agent's presentation";
  const other = "other.md";
  await c.ok(step, "document_write", { path: `${initiative}/${other}`, content: BODY });
  const presented = await c.ok(step, "document_present", { path: `${initiative}/${other}` });
  const agentRc = /\b(rc_[a-z2-7]{26})\b/.exec(presented)?.[1] ?? c.fail(step, `no review context in: ${presented}`);
  const cr3 = (await detail(step, other)).content_revision;
  const borrowed = await post(routes.approve, { expected_revision: cr3, review_context: agentRc }, other);
  if (borrowed.status !== 409 || borrowed.body.conflict !== "unshown" || /^ERROR|PRESENTATION_REQUIRED/.test(String(borrowed.body.error))) {
    c.fail(step, `Approve on an agent's context answered ${borrowed.status}: ${JSON.stringify(borrowed.body)} — ` +
      "expected a 409 in the console's words");
  }
  if (await statusOf(c, initiative, other) === "approved") c.fail(step, "the console sealed on an agent's presentation");
  c.pass("a console approval does not rest on an agent's context, and says so in the console's words");
}

const CONSOLE: Who = { email: EMAIL, name: "Console", role: "superadmin", team: TEAM };

async function run(c: Core): Promise<void> {
  const fail = c.fail;
  const ok = c.pass;
  const db = c.sql;
  const { principal, team } = await seed(db);
  // v1 is presented as r1 and approved as r2; v2 is presented as r3 and is now r4, unapproved.
  const plain = await initiative(db, team, principal, VERSIONS, null, null);
  await document(db, principal, plain, "notes.md", "note", [
    { version: 1, presented: true }, { version: 1, approved: true },
    { version: 2, presented: true }, { version: 2 },
  ]);
  // Closed on an approved review.md (r1, v1), then corrected: r2 is v2, a draft carrying the outcome.
  await closedFlow(db, principal, await initiative(db, team, principal, CORRECTED, "sdlc-flow", "accepted"),
    [{ version: 1, approved: true, outcome: "accepted" }, { version: 2, outcome: "accepted" }]);
  // Closed on an approved review.md and never corrected.
  await closedFlow(db, principal, await initiative(db, team, principal, SIGNED, "sdlc-flow", "accepted"),
    [{ version: 1, approved: true, outcome: "accepted" }]);
  // Approved once, revised, and then abandoned on the unapproved revision: a close that stopped
  // short, not a correction.
  await closedFlow(db, principal, await initiative(db, team, principal, DROPPED, "sdlc-flow", "abandoned"),
    [{ version: 1, approved: true }, { version: 2, outcome: "abandoned" }]);

  // `withThrowawayDb` ended the gateway's pool after migrating; a fresh one on the same container.
  process.env.TEAM_DB_URL = c.url;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  // The write routes reach zz-core here, the harness's own child.
  process.env.CORE_MCP_URL = c.mcp.url;
  const load = (p: string) => import(pathToFileURL(join(root, p)).href);
  const dbModule = (await load("services/gateway/dist/db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await dbModule.initPlatformDb();
  const { mountInitiatives } = (await load("services/gateway/dist/console/initiatives.js")) as
    { mountInitiatives: (app: unknown) => void };
  const { mountConsoleWrite } = (await load("services/gateway/dist/console-write.js")) as
    { mountConsoleWrite: (app: unknown) => void };
  const routes = new Map<string, Route>();
  mountInitiatives({ get: (path: string, h: Route) => routes.set(`GET ${path}`, h) });
  mountConsoleWrite({ post: (path: string, h: Route) => routes.set(`POST ${path}`, h) });
  const route = (path: string): Route => routes.get(path) ?? fail("mount", `no route ${path}`);
  const documentRoute = route("GET /api/console/document/:team/:initiative/*");
  const initiativeRoute = route("GET /api/console/initiatives/:team/:slug");
  const listRoute = route("GET /api/console/initiatives");
  const call = (r: Route, params: Record<string, string>, query: Record<string, string> = {}): Promise<Answer> =>
    answer(r, request(CONSOLE, params, query));

  try {
    const d = await call(documentRoute, { team: TEAM, initiative: VERSIONS, 0: "notes.md" });
    if (d.status !== 200) fail("document detail", `answered ${d.status}: ${JSON.stringify(d.body)}`);
    const versions = d.body.versions as { version: number; revision: number; status: string }[];
    const got = versions.map((v) => `v${v.version}@r${v.revision}:${v.status}`).join(", ");
    if (got !== "v1@r2:approved, v2@r4:draft") {
      fail("one entry per public version", `versions were ${got}, not v1@r2:approved, v2@r4:draft`);
    }
    ok("one entry per public version, its approved snapshot else its last");
    if (d.body.current_version !== 2 || d.body.current_revision !== 4) {
      fail("current version", `current_version ${String(d.body.current_version)}, ` +
        `current_revision ${String(d.body.current_revision)} — expected 2 and 4`);
    }
    ok("the document's current version is its own, not the highest snapshot");

    const snap = await call(documentRoute, { team: TEAM, initiative: VERSIONS, 0: "notes.md" }, { revision: "3" });
    if (snap.status !== 200 || snap.body.body !== "body of r3" || snap.body.version !== 2 || snap.body.revision !== 3) {
      fail("?revision=", `revision 3 answered ${snap.status} ${JSON.stringify(snap.body)}`);
    }
    ok("?revision= fetches one snapshot and names its public version");

    const corrected = await call(initiativeRoute, { team: TEAM, slug: CORRECTED });
    if (corrected.status !== 200) fail("corrected initiative", `answered ${corrected.status}: ${JSON.stringify(corrected.body)}`);
    const correction = JSON.stringify(corrected.body.correction);
    if (corrected.body.closed !== true || corrected.body.complete !== true || correction !== JSON.stringify({ path: "review.md", version: 2 })) {
      fail("pending correction", `closed ${String(corrected.body.closed)}, complete ${String(corrected.body.complete)}, ` +
        `correction ${correction} — expected closed, complete, review.md v2`);
    }
    const review = (corrected.body.documents as { path: string; correction: number | null }[]).find((x) => x.path === "review.md");
    if (review?.correction !== 2) fail("pending correction", `review.md's own correction is ${String(review?.correction)}, not 2`);
    const rd = await call(documentRoute, { team: TEAM, initiative: CORRECTED, 0: "review.md" });
    if (rd.body.correction !== 2 || rd.body.current_version !== 2) {
      fail("pending correction", `the document read says correction ${String(rd.body.correction)}, ` +
        `current_version ${String(rd.body.current_version)} — expected 2 and 2`);
    }
    ok("a closed initiative with a pending correction reads closed and complete, correction v2");

    const s = await call(initiativeRoute, { team: TEAM, slug: SIGNED });
    if (s.body.correction !== null || s.body.complete !== true) {
      fail("signed close", `correction ${JSON.stringify(s.body.correction)}, complete ${String(s.body.complete)}`);
    }
    const a = await call(initiativeRoute, { team: TEAM, slug: DROPPED });
    if (a.body.correction !== null || a.body.complete !== false) {
      fail("abandoned on a draft", `correction ${JSON.stringify(a.body.correction)}, complete ${String(a.body.complete)}`);
    }
    ok("an approved close carries no correction, and a close on a draft is no correction");

    const list = await call(listRoute, {}, { team: TEAM });
    const rows = list.body.initiatives as { slug: string; correction: unknown; complete: boolean }[];
    const listed = (slug: string) => rows.find((x) => x.slug === slug);
    if (JSON.stringify(listed(CORRECTED)?.correction) !== JSON.stringify({ path: "review.md", version: 2 })
        || listed(CORRECTED)?.complete !== true || listed(SIGNED)?.correction !== null
        || listed(DROPPED)?.correction !== null) {
      fail("initiative list", `the list says ${JSON.stringify(rows.map((x) => [x.slug, x.correction, x.complete]))}`);
    }
    ok("the initiative list carries the same correction");

    // The bell lists what a person can sign today. A correction awaiting approval is one, though its
    // initiative is closed — initiative_status routes it to await_approval — and a close that was
    // signed and never corrected, or abandoned on a draft, is not.
    const bell = await call(listRoute, {}, { team: TEAM, waiting: "1" });
    const waiting = bell.body.waiting as { id: string; gate: string }[];
    const ids = waiting.map((w) => w.id);
    if (!ids.includes(`${TEAM}/${CORRECTED}/review.md`) || ids.some((x) => x.includes(SIGNED) || x.includes(DROPPED))) {
      fail("waiting list", `the bell lists ${JSON.stringify(waiting)}`);
    }
    ok("the bell lists a pending correction and no other closed initiative");

    await presentation(c, { detail: documentRoute, shown: route("POST /api/console/documents/shown"),
                            approve: route("POST /api/console/documents/approve") });
  } finally {
    await dbModule.platformDb().end();
    delete process.env.TEAM_DB_URL;
    delete process.env.CORE_MCP_URL;
  }
}

process.exitCode = await withThrowawayCore(NAME, DONE, run);
