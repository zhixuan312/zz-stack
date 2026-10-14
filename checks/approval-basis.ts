#!/usr/bin/env node
/**
 * checks/approval-basis.ts — an approval records the decision basis its caller stated, and only
 * that, through a real zz-core on a real database.
 *
 *   node checks/approval-basis.ts   # needs Docker and a built tree (`npm run build`)
 *
 * `document_approve` takes `decision_basis`: `explicit` (the person decided this approval) or
 * `delegation` (approved under a standing delegation the person recorded), kept as
 * `detail.decision_basis` on the approval's `document.document_approve` event. It starts a
 * throwaway PostgreSQL and a real zz-core on it (`withThrowawayCore`), approves documents through
 * the tool, and calls the gateway's own built console routes (`services/gateway/dist/
 * console-write.js`) the way Express would, as a console session. What it establishes:
 *
 *   - an approval with `decision_basis: "explicit"` records `explicit` on its event, and one with
 *     `"delegation"` records `delegation`;
 *   - an approval with none records none: the event carries no `decision_basis` key at all;
 *   - an unknown value (`"implicit"`, and an empty string) is refused in the tool's `ERROR:` form,
 *     naming both values, before anything is written: the document, its revisions and the
 *     document events are exactly what they were;
 *   - the console's Approve (`POST /api/console/documents/approve`) records `explicit`;
 *   - the tool's answer is unchanged: the replies to all three approvals and the console's
 *     relayed one are the same sentence once the initiative, content revision and review context
 *     are put aside, and none mentions a basis.
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

const NAME = "approval-basis";
const DONE = "approval-basis: an approval records the decision basis its caller stated and no other, an unknown " +
  "one is refused before anything is written, the console's Approve records explicit, and the answer is unchanged: ok";

/** A freeform document with two sections, the way an agent writes one. */
const BODY = "# Notes\n\n## Alpha\n\nalpha line one\n\n## Beta\n\nbeta line one\n";
const DOC = "notes.md";

type Answer = { status: number; body: Record<string, unknown> };
type Route = (req: unknown, res: unknown) => void;

/** The request a console session's call arrives as, past the gateway's middleware: its resolved
 *  identity, and the `x-zz-*` headers it stamps (COUPLED: identity.ts, where a resolved identity is
 *  written onto the request — the write routes forward exactly these to zz-core). */
function request(c: Core, body: Record<string, unknown>): Record<string, unknown> {
  return {
    params: {}, query: { team: c.team }, body,
    zzIdentity: { email: c.email, displayName: "Skeleton", platformRole: "member", via: "session",
                  teams: [{ slug: c.team, role: "admin" }], activeTeam: c.team, patTeam: null,
                  sessionTeam: c.team },
    headers: {
      "x-zz-user-email": c.email, "x-zz-user-name": "Skeleton", "x-zz-user-id": "",
      "x-zz-user-role": "user", "x-zz-via": "session", "x-zz-pat-team": "", "x-zz-session-team": c.team,
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

/** The details of the approval events on one document, oldest first. */
async function approvals(c: Core, path: string): Promise<Record<string, unknown>[]> {
  const { rows } = await c.sql.query<{ detail: Record<string, unknown> }>(
    "select detail from zz.event where kind = 'document.document_approve' and subject = $1 order by ts, id", [path]);
  return rows.map((r) => r.detail);
}

/** Everything an approval could write about one document: its row, its revisions, and every
 *  document event the platform holds. */
async function written(c: Core, initiative: string): Promise<string> {
  const doc = await c.sql.query(
    `select d.status, d.current_revision, d.approved_revision, d.content_generation::text as generation,
            d.updated_at::text as updated_at
       from zz.doc d join zz.initiative i on i.id = d.initiative_id where i.slug = $1 and d.path = $2`,
    [initiative, DOC]);
  const revisions = await c.sql.query(
    `select r.revision, r.version, r.approved_by::text as approved_by, r.approved_at::text as approved_at,
            r.written_at::text as written_at, r.presented_at::text as presented_at
       from zz.doc_revision r join zz.doc d on d.id = r.doc_id join zz.initiative i on i.id = d.initiative_id
      where i.slug = $1 and d.path = $2 order by r.revision`, [initiative, DOC]);
  const acts = await c.sql.query("select count(*)::int as n from zz.event where kind like 'document.%'");
  return JSON.stringify({ doc: doc.rows, revisions: revisions.rows, acts: acts.rows[0] });
}

/** The content revision zz-core's own read of the current document states. */
async function tokenOf(c: Core, step: string, path: string): Promise<string> {
  const read = await c.ok(step, "document_read", { path });
  return /^content_revision: (cr_[a-z2-7]{26})$/m.exec(read)?.[1] ?? c.fail(step, `no content_revision in: ${read}`);
}

/** A reply with what differs between two approvals of the same kind of document put aside: the
 *  initiative it is in, read as the reference approval's, and the snapshot it signs and the review
 *  context it rests on. */
function shape(reply: string, initiative: string, as: string): string {
  return reply.split(initiative).join(as)
    .replace(/\bcr_[a-z2-7]{26}\b/g, "<cr>").replace(/\brc_[a-z2-7]{26}\b/g, "<rc>");
}

async function run(c: Core): Promise<void> {
  // `withThrowawayDb` ended the gateway's pool after migrating; a fresh one on the same container.
  process.env.TEAM_DB_URL = c.url;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  // The write routes reach zz-core here, the harness's own child.
  process.env.CORE_MCP_URL = c.mcp.url;
  const load = (p: string) => import(pathToFileURL(join(root, p)).href);
  const dbModule = (await load("services/gateway/dist/db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await dbModule.initPlatformDb();
  const { mountConsoleWrite } = (await load("services/gateway/dist/console-write.js")) as
    { mountConsoleWrite: (app: unknown) => void };
  const routes = new Map<string, Route>();
  mountConsoleWrite({ post: (path: string, h: Route) => routes.set(`POST ${path}`, h) });
  const route = (path: string): Route => routes.get(path) ?? c.fail("mount", `no route ${path}`);
  const shown = route("POST /api/console/documents/shown");
  const approve = route("POST /api/console/documents/approve");

  /** A freeform initiative with one document an agent wrote and presented: its name. */
  const presented = async (slug: string): Promise<string> => {
    const initiative = await c.open(slug);
    await c.ok(`write ${slug}`, "document_write", { path: `${initiative}/${DOC}`, content: BODY });
    await c.ok(`present ${slug}`, "document_present", { path: `${initiative}/${DOC}` });
    return initiative;
  };

  const replies: { step: string; initiative: string; reply: string }[] = [];
  try {
    for (const basis of ["explicit", "delegation", null] as const) {
      const step = basis ? `an approval stating ${basis}` : "an approval stating none";
      const initiative = await presented(`basis-${basis ?? "none"}`);
      const path = `${initiative}/${DOC}`;
      const reply = await c.ok(step, "document_approve", { path, ...(basis ? { decision_basis: basis } : {}) });
      replies.push({ step, initiative, reply });
      const acts = await approvals(c, path);
      if (acts.length !== 1) c.fail(step, `${acts.length} approval events were recorded: ${JSON.stringify(acts)}`);
      if (basis ? acts[0].decision_basis !== basis : "decision_basis" in acts[0]) {
        c.fail(step, `the approval's event carries ${JSON.stringify(acts[0])} — expected ` +
          (basis ? `decision_basis "${basis}"` : "no decision_basis at all"));
      }
      c.pass(basis ? `${step}: its event records decision_basis "${basis}"` : `${step}: its event records no decision_basis`);
    }

    let step = "an unknown basis";
    const initiative = await presented("basis-unknown");
    const path = `${initiative}/${DOC}`;
    const before = await written(c, initiative);
    for (const value of ["implicit", ""]) {
      await c.refused(`${step} ${JSON.stringify(value)}`, "document_approve", { path, decision_basis: value },
        new RegExp(`^ERROR: decision_basis ${JSON.stringify(value)} is not one .*\`explicit\`.*\`delegation\``));
    }
    const after = await written(c, initiative);
    if (after !== before) c.fail(step, `a refused approval wrote something: before ${before}, after ${after}`);
    if ((await approvals(c, path)).length) c.fail(step, "a refused approval recorded an approval event");
    c.pass("an unknown basis, or an empty one, is refused in the tool's ERROR form naming both values, and nothing is written");

    step = "the console's Approve";
    const consoleInitiative = await c.open("basis-console");
    const consolePath = `${consoleInitiative}/${DOC}`;
    await c.ok(step, "document_write", { path: consolePath, content: BODY });
    const cr = await tokenOf(c, step, consolePath);
    const s = await answer(shown, request(c, { initiative: consoleInitiative, path: DOC, content_revision: cr }));
    const rc = s.body.review_context;
    if (s.status !== 200 || typeof rc !== "string") c.fail(step, `POST /documents/shown answered ${s.status}: ${JSON.stringify(s.body)}`);
    const signed = await answer(approve, request(c, { initiative: consoleInitiative, path: DOC, expected_revision: cr,
                                                       review_context: rc }));
    if (signed.status !== 200 || signed.body.ok !== true || typeof signed.body.result !== "string") {
      c.fail(step, `Approve answered ${signed.status}: ${JSON.stringify(signed.body)}`);
    }
    replies.push({ step, initiative: consoleInitiative, reply: signed.body.result as string });
    const acts = await approvals(c, consolePath);
    if (acts.length !== 1 || acts[0].decision_basis !== "explicit") {
      c.fail(step, `the approval recorded ${JSON.stringify(acts)} — expected one, with decision_basis "explicit"`);
    }
    c.pass("the console's Approve records decision_basis \"explicit\" on the approval's event");

    step = "the answer is unchanged";
    const none = replies.find((r) => r.step === "an approval stating none")!;
    const want = shape(none.reply, none.initiative, none.initiative);
    if (!/ approved — recorded under /.test(none.reply)) c.fail(step, `the approval with no basis answered: ${none.reply}`);
    for (const r of replies) {
      const got = shape(r.reply, r.initiative, none.initiative);
      if (got !== want) c.fail(step, `${r.step} answered ${JSON.stringify(got)}, where an approval stating none answers ${JSON.stringify(want)}`);
      // Read past the initiative's name, which these approvals' own slugs spell a basis into.
      if (/decision_basis|explicit|delegation/.test(got)) c.fail(step, `${r.step}'s answer mentions a basis: ${r.reply}`);
    }
    c.pass("every approval answers the same sentence, stating a basis or not, through the tool or the console");
  } finally {
    await dbModule.platformDb().end();
    delete process.env.TEAM_DB_URL;
    delete process.env.CORE_MCP_URL;
  }
}

process.exitCode = await withThrowawayCore(NAME, DONE, run);
