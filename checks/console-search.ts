#!/usr/bin/env node
/**
 * checks/console-search.ts — the console's search, on a real database through a real zz-core.
 *
 *   node checks/console-search.ts   # needs Docker and a built tree (`npm run build`)
 *
 * `GET /api/console/search` is zz-core's `knowledge_search` called as the caller, with each row
 * reshaped so a console can link it (services/gateway/src/console/search.ts). It starts a throwaway
 * PostgreSQL and a real zz-core on it (`withThrowawayCore`), has an agent write one document and
 * record one knowledge node through that zz-core, so both are indexed the way production indexes
 * them, and calls the gateway's own built route handler the way Express would, signed in as a
 * console session. What it establishes:
 *
 *   - a question whose words are in a document's body finds that document, as `kind: "document"`
 *     with the team, the initiative and the path the console's document page is addressed by, and
 *     the matched text as its excerpt: the search reads content, not titles;
 *   - a question whose words are in a node's body finds that node, as `kind: "node"` with no
 *     initiative and the `nodes/<ordinal>-<slug>.md` path the console's knowledge page takes;
 *   - the search ran as the person signed in: zz-core's own `knowledge.search` row names them;
 *   - a question nothing matches answers 200 with no result, and says which kind of empty it is;
 *   - `limit` bounds what comes back, and a limit outside 1 to 50 is refused;
 *   - no question is refused, `?scope=platform` is refused rather than answered as one team's
 *     search under the platform's name, and a `?team=` that is not the team the caller acts for
 *     is refused rather than answered with another team's search.
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

const NAME = "console-search";
const DONE = "console-search: the console's search reads documents and nodes by their content, as the " +
  "person signed in, and refuses the scopes it cannot honestly answer: ok";

type Answer = { status: number; body: Record<string, unknown> };
type Route = (req: unknown, res: unknown) => void;
type Row = Record<string, unknown>;

/** The request a console session's call arrives as, past the gateway's middleware: its resolved
 *  identity, and the `x-zz-*` headers it stamps (COUPLED: identity.ts, where a resolved identity is
 *  written onto the request — the route forwards exactly these to zz-core). */
function request(c: Core, role: "superadmin" | "member", query: Record<string, string>): Record<string, unknown> {
  return {
    params: {}, query,
    zzIdentity: { email: c.email, displayName: "Skeleton", platformRole: role, via: "session",
                  teams: [{ slug: c.team, role: "admin" }], activeTeam: c.team, patTeam: null,
                  sessionTeam: c.team },
    headers: {
      "x-zz-user-email": c.email, "x-zz-user-name": "Skeleton", "x-zz-user-id": "",
      "x-zz-user-role": role === "superadmin" ? "admin" : "user", "x-zz-via": "session",
      "x-zz-pat-team": "", "x-zz-session-team": c.team,
    },
  };
}

/** Calls the mounted route as Express would, and waits for the answer it sends. */
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

/** How many `knowledge.search` rows zz-core recorded for this question under this person. The row
 *  is written after the tool answers, so it is waited on, briefly. */
async function searchesBy(c: Core, question: string): Promise<number> {
  const until = Date.now() + 5000;
  for (;;) {
    const { rows } = await c.sql.query<{ n: number }>(
      `select count(*)::int as n
         from zz.event e join zz.principal p on p.id = e.actor_id
        where e.kind = 'knowledge.search' and e.subject = $1 and p.email = $2`, [question, c.email]);
    if (rows[0].n > 0 || Date.now() > until) return rows[0].n;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function run(c: Core): Promise<void> {
  const initiative = await c.open("console-search");
  // Words no other row holds, in the BODY and not the title: a search that read titles alone
  // would find neither.
  await c.ok("an agent writes a document", "document_write", {
    path: `${initiative}/notes.md`, title: "Notes",
    content: "# Notes\n\n## Reconciliation\n\nThe quokka ledger reconciles nightly, after the vendor export lands.\n",
  });
  await c.ok("an agent records a node", "knowledge_add", {
    title: "Cache expiry", type: "decision", scope: "team", evidence: [initiative],
    body: "The wombat cache expires an entry ninety seconds after it was last read.",
  });

  // `withThrowawayDb` ended the gateway's pool after migrating; a fresh one on the same container.
  process.env.TEAM_DB_URL = c.url;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  // The route reaches zz-core here, the harness's own child.
  process.env.CORE_MCP_URL = c.mcp.url;
  const load = (p: string) => import(pathToFileURL(join(root, p)).href);
  const dbModule = (await load("services/gateway/dist/db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await dbModule.initPlatformDb();
  const { mountSearch } = (await load("services/gateway/dist/console/search.js")) as { mountSearch: (app: unknown) => void };
  const routes = new Map<string, Route>();
  mountSearch({ get: (path: string, h: Route) => routes.set(`GET ${path}`, h) });
  const search = routes.get("GET /api/console/search") ?? c.fail("mount", "no route GET /api/console/search");
  const ask = (query: Record<string, string>, role: "superadmin" | "member" = "member"): Promise<Answer> =>
    answer(search, request(c, role, query));
  const rowsOf = (a: Answer): Row[] => (Array.isArray(a.body.results) ? a.body.results as Row[] : []);
  /** A row's excerpt without the `**` the tool puts round each matched term. */
  const plain = (r: Row): string => String(r.excerpt).replaceAll("**", "");

  try {
    let step = "a document is found by its content";
    const question = "quokka ledger";
    const doc = await ask({ q: question });
    if (doc.status !== 200 || doc.body.team !== c.team || doc.body.query !== question) {
      c.fail(step, `answered ${doc.status}: ${JSON.stringify(doc.body)}`);
    }
    const found = rowsOf(doc).find((r) => r.kind === "document");
    if (!found || found.team !== c.team || found.shelf !== "team" || found.initiative !== initiative
        || found.path !== "notes.md" || found.title !== "Notes" || found.type !== null
        || !/quokka ledger reconciles nightly/.test(plain(found)) || !String(found.excerpt).includes("**quokka**")) {
      c.fail(step, `no linkable document row for ${initiative}/notes.md in ${JSON.stringify(doc.body.results)}`);
    }
    if (doc.body.returned !== rowsOf(doc).length || doc.body.recall !== null) {
      c.fail(step, `returned ${JSON.stringify(doc.body.returned)} beside ${rowsOf(doc).length} rows, recall ${JSON.stringify(doc.body.recall)}`);
    }
    c.pass("a question whose words are in a document's body finds it, with the team, initiative and path its page is addressed by");

    step = "the search ran as the person signed in";
    if (await searchesBy(c, question) < 1) {
      c.fail(step, `zz-core recorded no knowledge.search row for "${question}" under ${c.email}`);
    }
    c.pass("zz-core's own knowledge.search row names the person the console session belongs to");

    step = "a node is found by its content";
    const node = await ask({ q: "wombat cache expires" });
    const lesson = rowsOf(node).find((r) => r.kind === "node");
    if (node.status !== 200 || !lesson || lesson.team !== c.team || lesson.initiative !== null
        || !/^nodes\/\d+-[a-z0-9-]+\.md$/.test(String(lesson.path)) || lesson.title !== "Cache expiry"
        || lesson.type !== "decision" || !/wombat cache expires/.test(plain(lesson))) {
      c.fail(step, `answered ${node.status}: ${JSON.stringify(node.body)}`);
    }
    c.pass("a question whose words are in a node's body finds it, with no initiative and the path its page takes");

    step = "a limit bounds the answer";
    const one = await ask({ q: "quokka OR wombat", limit: "1" });
    if (one.status !== 200 || rowsOf(one).length !== 1) {
      c.fail(step, `limit=1 answered ${one.status} with ${rowsOf(one).length} rows: ${JSON.stringify(one.body)}`);
    }
    for (const limit of ["0", "51", "two"]) {
      const bad = await ask({ q: "quokka", limit });
      if (bad.status !== 400) c.fail(step, `limit=${limit} answered ${bad.status}: ${JSON.stringify(bad.body)}`);
    }
    c.pass("limit bounds what comes back, and a limit outside 1 to 50 is refused");

    step = "nothing matched";
    const none = await ask({ q: "zyzzyva platypus" });
    if (none.status !== 200 || rowsOf(none).length !== 0 || none.body.returned !== 0
        || typeof none.body.recall !== "string" || !none.body.recall || typeof none.body.note !== "string" || !none.body.note) {
      c.fail(step, `answered ${none.status}: ${JSON.stringify(none.body)}`);
    }
    c.pass(`a question nothing matches answers no result and says which kind of empty: ${String(none.body.recall)}`);

    step = "the scopes it cannot answer";
    const noQuestion = await ask({});
    if (noQuestion.status !== 400 || !/q required/.test(String(noQuestion.body.error))) {
      c.fail(step, `no question answered ${noQuestion.status}: ${JSON.stringify(noQuestion.body)}`);
    }
    const fleet = await ask({ q: question, scope: "platform" }, "superadmin");
    if (fleet.status !== 400 || !/scope=platform/.test(String(fleet.body.error))) {
      c.fail(step, `?scope=platform answered ${fleet.status}: ${JSON.stringify(fleet.body)}`);
    }
    const elsewhere = await ask({ q: question, team: "another-team" }, "superadmin");
    if (elsewhere.status !== 400 || !new RegExp(`the team you act for, ${c.team}, not another-team`).test(String(elsewhere.body.error))) {
      c.fail(step, `?team=another-team answered ${elsewhere.status}: ${JSON.stringify(elsewhere.body)}`);
    }
    c.pass("no question, ?scope=platform and a ?team= the caller does not act for are each refused");
  } finally {
    await dbModule.platformDb().end();
    delete process.env.TEAM_DB_URL;
    delete process.env.CORE_MCP_URL;
  }
}

process.exitCode = await withThrowawayCore(NAME, DONE, run);
