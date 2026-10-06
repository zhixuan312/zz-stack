/**
 * A real zz-core on a throwaway database, for the checks that drive document tools end to end
 * through the MCP door: `withThrowawayDb`'s container, one principal seeded in one team, the built
 * `services/zz-core/dist/server.js` started on a free port against it, and MCP clients carrying
 * that principal's identity headers.
 *
 * A helper, not a check: every `.ts` under `checks/` is a check the gate runs, so the harness
 * those checks share lives here, beside the throwaway database it starts from.
 *
 * What a check gets (`Core`): the database as one SQL client (`sql`, `search_path` empty, so name
 * every table `zz.`), the zz-core child (`restart` kills it and starts another on the same
 * database), any number of MCP clients (`mcp`, `client()` for a second one whose calls run beside
 * the first's), the call helpers that turn a reply into a pass or a named failure, the order in
 * which PostgreSQL grants one advisory lock — what a race is staged with — and the built zz-core
 * modules loaded in this process against the same database (`inProcess`), for a rule no tool lets
 * a caller reach and for the statements a change issues, which only this process can count. A
 * check may hand the child a catalog of its own (`catalog`) — a copy carrying a fixture flow.
 *
 * DELIBERATE: everything it starts is stopped on every exit path — the child killed, every client
 * and pool it opened ended, the container removed by `withThrowawayDb` — and the only database it
 * touches is the one that call started.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Mcp } from "@zz/mcp-client";
import pg from "pg";

import { root } from "../deployment.ts";
import { withThrowawayDb } from "./throwaway.ts";

const EMAIL = "skeleton@example.test";
const TEAM = "skeleton-team";
const START_TIMEOUT_MS = 30_000;
/** How long a staged race waits for PostgreSQL to show the callers it was told to expect. */
const WAIT_TIMEOUT_MS = 20_000;
/** How much of zz-core's own output a failure prints after its line. */
const TAIL = 3000;

class CaseFailure extends Error {}

/** The built zz-core modules a check calls in this process, against the throwaway database. */
interface InProcess {
  documentGuards: typeof import("../../services/zz-core/dist/guards.js").documentGuards;
  chainFor: typeof import("../../services/zz-core/dist/chain.js").chainFor;
  /** The change service and the write path, as `document_edit` calls them: a statement this
   *  process issues is one `pg`'s `Client.prototype.query` sees, so a check can count them. */
  planEdit: typeof import("../../services/zz-core/dist/document-change.js").planEdit;
  saveDocument: typeof import("../../services/zz-core/dist/document-save.js").saveDocument;
  pool: pg.Pool;
}

/** `initiative_status`'s `next_move`. */
interface NextMove { action?: string; document?: string; why?: string }

/** What a check is handed. */
export interface Core {
  /** The throwaway database, as one client with an empty `search_path`. */
  sql: pg.Client;
  /** Its URL — a second connection to it is the check's own to end. */
  url: string;
  team: string;
  email: string;
  /** The first MCP client. `restart` replaces it. */
  mcp: Mcp;
  /** Another MCP client for the seeded principal, on its own session: two calls released
   *  together run as two callers. */
  client(): Mcp;
  freePort(): Promise<number>;
  /** Kill the zz-core child and start another on the same database, on a fresh port. */
  restart(): Promise<void>;
  /** The tool's reply text; a transport failure or an untrusted peer fails `step`. */
  call(step: string, tool: string, args: unknown, via?: Mcp): Promise<string>;
  /** A reply that is not a refusal. */
  ok(step: string, tool: string, args: unknown, via?: Mcp): Promise<string>;
  /** A refusal matching `expect`. */
  refused(step: string, tool: string, args: unknown, expect: RegExp, via?: Mcp): Promise<string>;
  fail(step: string, detail: string): never;
  /** One case held: its line. */
  pass(step: string): void;
  /** `initiative_open`, answering the initiative's dated name. */
  open(slug: string, flow?: string): Promise<string>;
  /** `source_add`, answering the path the source was recorded at. */
  source(step: string, args: Record<string, unknown>, via?: Mcp): Promise<string>;
  /** `document_present`, then `document_approve`. */
  sign(path: string): Promise<string>;
  /** `initiative_status` of one initiative, parsed. */
  status(initiative: string): Promise<{ outcome?: string | null; next_move?: NextMove | null }>;
  /** The sources every revision of a document cites, as `<source path> <linked_by> v<version>`,
   *  oldest revision first; `-` for a citation that records no origin. */
  cites(path: string): Promise<string[]>;
  /** The per-document lock key `saveDocument` takes, `doc:<team>/<path>`. */
  docKey(path: string): string;
  /** Take an advisory lock on `key` from a connection of the harness's own, and keep it. */
  hold(key: string): Promise<void>;
  /** Resolve once exactly `n` callers wait on `key`. */
  waiters(step: string, key: string, n: number): Promise<void>;
  /** Give `key` up, and — with `again` — ask for it again in the same statement, so the holder
   *  queues behind whoever was waiting and has it back the moment they let go. */
  release(key: string, again?: boolean): Promise<void>;
  inProcess(): Promise<InProcess>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

async function seed(db: pg.Client): Promise<void> {
  const p = await db.query<{ id: string }>(
    "INSERT INTO zz.principal (email, display_name, role) VALUES ($1, 'Skeleton', 'member') RETURNING id", [EMAIL]);
  const principal = p.rows[0].id;
  const t = await db.query<{ id: string }>(
    "INSERT INTO zz.team (slug, name, created_by) VALUES ($1, 'Skeleton team', $2) RETURNING id", [TEAM, principal]);
  const team = t.rows[0].id;
  await db.query(
    "INSERT INTO zz.membership (team_id, principal_id, role, added_by) VALUES ($1, $2, 'admin', $2)", [team, principal]);
  await db.query("UPDATE zz.principal SET active_team_id = $1 WHERE id = $2", [team, principal]);
}

/** A running zz-core child and what it has said, its tail kept for a failure to print. */
interface Child { proc: ChildProcess; port: number; output: () => string }

/** What a check may change about the zz-core it is given. */
interface CoreOptions {
  /** The catalog the child reads its flows from, in place of the checkout's own `catalog/`: a
   *  copy carrying a fixture flow no shipped catalog declares. */
  catalog?: string;
}

/** Starts zz-core and resolves once it says it is listening on `port`. */
function startCore(name: string, url: string, port: number, catalog: string): Promise<Child> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["services/zz-core/dist/server.js", "--port", String(port)], {
      cwd: root,
      env: {
        ...process.env,
        TEAM_DB_URL: url,
        TRUSTED_PEERS: "localhost",
        ZZ_CATALOG_DIR: catalog,
        ZZ_SKILLS_DIR: `${root}/skills`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Read for the life of the child, so a full pipe never stalls it.
    let seen = "";
    let listening = false;
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new CaseFailure(`${name}: FAILED at "start zz-core": no \`listening on :${port}\` within ` +
        `${START_TIMEOUT_MS / 1000}s. Output so far: ${seen.trim() || "(none)"}`));
    }, START_TIMEOUT_MS);
    const onData = (b: Buffer): void => {
      seen = (seen + b.toString()).slice(-TAIL);
      if (!listening && seen.includes(`listening on :${port}`)) {
        listening = true;
        clearTimeout(timer);
        resolve({ proc, port, output: () => seen });
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.once("error", (err) => { clearTimeout(timer); reject(err); });
    proc.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (!listening) {
        reject(new CaseFailure(`${name}: FAILED at "start zz-core": exited (${code ?? signal}) before ` +
          `listening. Output: ${seen.trim() || "(none)"}`));
      }
    });
  });
}

function stopCore(c: Child): Promise<void> {
  const { proc } = c;
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const t = setTimeout(() => { proc.kill("SIGKILL"); }, 5000);
    proc.once("exit", () => { clearTimeout(t); resolve(); });
    proc.kill("SIGTERM");
  });
}

function mcpFor(port: number, name: string): Mcp {
  return new Mcp(`http://127.0.0.1:${port}/mcp`, {
    client: name,
    timeoutMs: 60_000,
    headers: {
      "x-zz-user-email": EMAIL, "x-zz-user-name": "Skeleton", "x-zz-user-id": "",
      "x-zz-user-role": "user", "x-zz-via": "forwarded", "x-zz-pat-team": "", "x-zz-session-team": "",
    },
  });
}

/**
 * Runs `fn` against a fresh zz-core on a fresh throwaway database and answers the check's exit
 * code: 0 when `fn` returned (and `done` was printed), 1 when a case failed (`<name>: FAILED at
 * "<case>": …`, then zz-core's last output), 2 when Docker is not available — which is not a pass.
 */
export async function withThrowawayCore(
  name: string, done: string, fn: (core: Core) => Promise<void>, opts: CoreOptions = {},
): Promise<number> {
  const catalog = opts.catalog ?? `${root}/catalog`;
  let url = "";
  let child: Child | null = null;
  let holder: pg.Client | null = null;
  let inProc: InProcess | null = null;
  const fail = (step: string, detail: string): never => {
    throw new CaseFailure(`${name}: FAILED at "${step}": ${detail}`);
  };
  try {
    await withThrowawayDb(async (sql) => {
      await seed(sql);
      child = await startCore(name, url, await freePort(), catalog);
      const live = (): Child => child ?? fail("zz-core", "not running");
      const call = async (step: string, tool: string, args: unknown, via?: Mcp): Promise<string> => {
        let reply = "";
        try {
          reply = await (via ?? core.mcp).call(tool, args);
        } catch (err) {
          fail(step, `${(err as Error).message}${/not a trusted caller/.test(String(err))
            ? " — zz-core refused this peer; TRUSTED_PEERS must resolve to the address the check calls from" : ""}`);
        }
        if (/not a trusted caller/.test(reply)) {
          fail(step, `${reply} — TRUSTED_PEERS must resolve to the address the check calls from`);
        }
        return reply;
      };
      const ungranted = async (key: string): Promise<number> => (await sql.query<{ n: number }>(
        `select count(*)::int as n from pg_catalog.pg_locks
          where locktype = 'advisory' and not granted
            and ((classid::bigint << 32) | objid::bigint) = pg_catalog.hashtext($1)::bigint`, [key])).rows[0].n;
      const core: Core = {
        sql, url, team: TEAM, email: EMAIL,
        mcp: mcpFor(live().port, name),
        client: () => mcpFor(live().port, name),
        freePort,
        restart: async () => {
          await stopCore(live());
          child = null;
          child = await startCore(name, url, await freePort(), catalog);
          core.mcp = mcpFor(child.port, name);
        },
        call,
        ok: async (step, tool, args, via) => {
          const reply = await call(step, tool, args, via);
          if (reply.startsWith("ERROR")) fail(step, reply);
          return reply;
        },
        refused: async (step, tool, args, expect, via) => {
          const reply = await call(step, tool, args, via);
          if (!reply.startsWith("ERROR") || !expect.test(reply)) {
            fail(step, `expected a refusal matching ${expect}, got: ${reply}`);
          }
          return reply;
        },
        fail,
        pass: (step) => console.log(`  ${step}: ok`),
        open: async (slug, flow) => {
          const opened = await core.ok(`open ${slug}`, "initiative_open", flow ? { slug, flow } : { slug });
          try {
            return (JSON.parse(opened) as { initiative: string }).initiative;
          } catch {
            return fail(`open ${slug}`, `reply was not JSON: ${opened}`);
          }
        },
        source: async (step, args, via) => {
          const reply = await core.ok(step, "source_add", args, via);
          return /source recorded: (\S+)/.exec(reply)?.[1] ?? fail(step, `no recorded path in: ${reply}`);
        },
        sign: async (path) => {
          await core.ok(`present ${path}`, "document_present", { path });
          return core.ok(`approve ${path}`, "document_approve", { path });
        },
        status: async (initiative) => {
          const reply = await core.ok(`initiative_status ${initiative}`, "initiative_status", { initiative });
          try {
            return JSON.parse(reply) as { outcome?: string | null; next_move?: NextMove | null };
          } catch {
            return fail(`initiative_status ${initiative}`, `reply was not JSON: ${reply}`);
          }
        },
        cites: async (path) => {
          const [initiative, name] = [path.split("/")[0], path.split("/").slice(1).join("/")];
          const { rows } = await sql.query<{ cited: string }>(
            `select si.slug || '/' || s.path || ' ' || coalesce(l.linked_by, '-') || ' v' || r.version as cited
               from zz.doc d
               join zz.initiative i on i.id = d.initiative_id
               join zz.doc_link l on l.from_doc_id = d.id and l.kind = 'cites'
               join zz.doc_revision r on r.doc_id = d.id and r.revision = l.from_revision
               join zz.doc s on s.id = l.to_doc_id
               join zz.initiative si on si.id = s.initiative_id
              where i.slug = $1 and d.path = $2
              order by r.revision, s.path`, [initiative, name]);
          return [...new Set(rows.map((r) => r.cited))];
        },
        docKey: (path) => `doc:${TEAM}/${path}`,
        hold: async (key) => {
          if (!holder) {
            holder = new pg.Client({ connectionString: url });
            await holder.connect();
          }
          await holder.query("select pg_catalog.pg_advisory_lock(pg_catalog.hashtext($1))", [key]);
        },
        waiters: async (step, key, n) => {
          const until = Date.now() + WAIT_TIMEOUT_MS;
          let seen = await ungranted(key);
          while (seen !== n) {
            if (Date.now() > until) fail(step, `expected ${n} caller(s) waiting on ${key}, saw ${seen}`);
            await new Promise((r) => setTimeout(r, 50));
            seen = await ungranted(key);
          }
        },
        release: async (key, again = false) => {
          if (!holder) return fail("release", `${key} is not held`);
          // One statement, evaluated left to right: the waiter is granted the lock as it is let
          // go, and the request after it queues behind that waiter.
          await holder.query(again
            ? "select pg_catalog.pg_advisory_unlock(pg_catalog.hashtext($1)), pg_catalog.pg_advisory_lock(pg_catalog.hashtext($1))"
            : "select pg_catalog.pg_advisory_unlock(pg_catalog.hashtext($1))", [key]);
        },
        inProcess: async () => {
          if (inProc) return inProc;
          // Read once, when platform-db.js loads: set before the first import of it.
          process.env.TEAM_DB_URL = url;
          const load = (p: string) => import(pathToFileURL(join(root, "services/zz-core/dist", p)).href);
          const guards = (await load("guards.js")) as typeof import("../../services/zz-core/dist/guards.js");
          const chain = (await load("chain.js")) as typeof import("../../services/zz-core/dist/chain.js");
          const change = (await load("document-change.js")) as typeof import("../../services/zz-core/dist/document-change.js");
          const save = (await load("document-save.js")) as typeof import("../../services/zz-core/dist/document-save.js");
          const pdb = (await load("platform-db.js")) as typeof import("../../services/zz-core/dist/platform-db.js");
          const pool = pdb.db();
          if (!pool) return fail("in-process zz-core", "platform-db.js opened no pool on the throwaway database");
          inProc = { documentGuards: guards.documentGuards, chainFor: chain.chainFor, planEdit: change.planEdit,
                     saveDocument: save.saveDocument, pool };
          return inProc;
        },
      };
      try {
        await fn(core);
      } catch (err) {
        // zz-core's own last words, after the failure's line: the reason a reply was what it was.
        if (child) console.error(`${err instanceof CaseFailure ? err.message : String(err)}\n--- zz-core output (tail)\n${child.output()}`);
        throw Object.assign(err as Error, { printed: true });
      } finally {
        if (child) await stopCore(child);
        await (holder as pg.Client | null)?.end().catch(() => undefined);
        await (inProc as InProcess | null)?.pool.end().catch(() => undefined);
        delete process.env.TEAM_DB_URL;
      }
    }, async (u) => { url = u; });
  } catch (err) {
    if (err instanceof Error && /Docker is not running/.test(err.message)) {
      console.error(`${name}: Docker is not available — the check could not run, which is not a pass`);
      return 2;
    }
    if (!(err as { printed?: boolean })?.printed) {
      console.error(err instanceof CaseFailure ? err.message : `${name}: ${String((err as Error)?.stack ?? err)}`);
    }
    return 1;
  }
  console.log(done);
  return 0;
}
