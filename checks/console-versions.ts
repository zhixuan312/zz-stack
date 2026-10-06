#!/usr/bin/env node
/**
 * checks/console-versions.ts — the console's document and initiative reads, on a real database.
 *
 *   node checks/console-versions.ts   # needs Docker and a built tree (`npm run build`)
 *
 * The bell (`?waiting=1`) lists a closed initiative's pending correction, and no other closed one.
 *
 * It starts a throwaway PostgreSQL (`withThrowawayDb`), seeds rows with SQL directly, and calls
 * the gateway's own built route handlers (`services/gateway/dist/console/initiatives.js`) the way
 * Express would, signed in as a console session. What it establishes:
 *
 *   - a document's `versions` holds one entry per public version, each the version's approved
 *     snapshot when it has one and else its last, with `version` the public number and `revision`
 *     the snapshot to fetch; `current_version` is the document's own;
 *   - `?revision=` returns that one snapshot's text and names its public version;
 *   - a closed initiative whose closing document is a pending correction reads as closed and
 *     complete, with `correction` naming the document and its version, on the initiative and on
 *     the list; a close that was approved and never corrected carries no correction; and a close
 *     recorded on a draft (an abandoned close) is not a correction and still reads as incomplete.
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

const EMAIL = "console@example.test";
const TEAM = "console-team";
const VERSIONS = "2026-10-06-versions";
const CORRECTED = "2026-10-06-corrected";
const SIGNED = "2026-10-06-signed";
const DROPPED = "2026-10-06-dropped";

class CaseFailure extends Error {}
function fail(step: string, detail: string): never {
  throw new CaseFailure(`console-versions: FAILED at "${step}": ${detail}`);
}
const ok = (step: string): void => console.log(`  ${step}: ok`);

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

/** Calls one mounted route as Express would, and waits for the answer it sends. */
function call(route: Route, params: Record<string, string>, query: Record<string, string> = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200, headersSent: false,
      status(code: number) { this.statusCode = code; return this; },
      json(body: Record<string, unknown>) { this.headersSent = true; resolve({ status: this.statusCode, body }); },
    };
    const req = {
      params, query,
      zzIdentity: { email: EMAIL, displayName: "Console", platformRole: "superadmin", via: "session",
                    teams: [{ slug: TEAM, role: "admin" }], activeTeam: TEAM },
    };
    try { route(req, res); } catch (err) { reject(err); }
  });
}

async function run(db: pg.Client, url: string): Promise<void> {
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
  process.env.TEAM_DB_URL = url;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  const load = (p: string) => import(pathToFileURL(join(root, p)).href);
  const dbModule = (await load("services/gateway/dist/db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await dbModule.initPlatformDb();
  const { mountInitiatives } = (await load("services/gateway/dist/console/initiatives.js")) as
    { mountInitiatives: (app: unknown) => void };
  const routes = new Map<string, Route>();
  mountInitiatives({ get: (path: string, h: Route) => routes.set(path, h) });
  const route = (path: string): Route => routes.get(path) ?? fail("mount", `no route ${path}`);
  const documentRoute = route("/api/console/document/:team/:initiative/*");
  const initiativeRoute = route("/api/console/initiatives/:team/:slug");
  const listRoute = route("/api/console/initiatives");

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

    const c = await call(initiativeRoute, { team: TEAM, slug: CORRECTED });
    if (c.status !== 200) fail("corrected initiative", `answered ${c.status}: ${JSON.stringify(c.body)}`);
    const correction = JSON.stringify(c.body.correction);
    if (c.body.closed !== true || c.body.complete !== true || correction !== JSON.stringify({ path: "review.md", version: 2 })) {
      fail("pending correction", `closed ${String(c.body.closed)}, complete ${String(c.body.complete)}, ` +
        `correction ${correction} — expected closed, complete, review.md v2`);
    }
    const review = (c.body.documents as { path: string; correction: number | null }[]).find((x) => x.path === "review.md");
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
  } finally {
    await dbModule.platformDb().end();
    delete process.env.TEAM_DB_URL;
  }
}

async function main(): Promise<number> {
  let dbUrl = "";
  try {
    await withThrowawayDb((db) => run(db, dbUrl), async (url) => { dbUrl = url; });
  } catch (err) {
    if (err instanceof Error && /Docker is not running/.test(err.message)) {
      console.error("console-versions: Docker is not available — the check could not run, which is not a pass");
      return 2;
    }
    console.error(err instanceof CaseFailure ? err.message : `console-versions: ${String((err as Error)?.stack ?? err)}`);
    return 1;
  }
  console.log("console-versions: public versions, snapshot reads and pending corrections: ok");
  return 0;
}

process.exitCode = await main();
