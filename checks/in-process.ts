/**
 * checks/in-process.ts — the fakes checks share to drive the real services in this process, with no
 * network and no database: the core door built the way zz-core builds it, a `pg.Pool` that answers the
 * initiative and document reads from a fixture world, and a mounted route called as Express would.
 *
 * Not a check of its own: importing it installs nothing. Each fake is installed or called by the check
 * that wants it, and the stub pool only by `stubInitiativePool`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pg from "pg";

import { root } from "../scripts/deployment.ts";

export type Obj = Record<string, unknown>;

// The core door

/**
 * The core door with every tool module services/zz-core/src/server.ts imports registered on it,
 * read out of server.ts rather than listed here, so a door that grows another module is built with
 * it. Answers the server and the registrars it called; none called means the build went blind.
 *
 * Every name in an import is a registrar candidate, not the first — `registerBugAdminTools,
 * registerBugTools` come from one module — and the module may sit beside server.ts
 * (`./document-panel.js`) as well as under `./tools/`. `true` goes where a registrar takes a role:
 * the door under test is the whole surface, what a superadmin is served.
 */
export async function coreDoor(version: string): Promise<{ server: McpServer; registrars: string[] }> {
  const src = readFileSync(join(root, "services/zz-core/src/server.ts"), "utf8");
  const { coreServer } = await import(pathToFileURL(join(root, "services/zz-core/dist/orientation.js")).href) as
    { coreServer: (v: string) => McpServer };
  const server = coreServer(version);
  const registrars: string[] = [];
  for (const [, names, rel] of src.matchAll(/import \{ ([^}]+) \} from "\.\/((?:tools\/)?[\w-]+)\.js"/g)) {
    const fns = names!.split(",").map((n) => n.trim()).filter((n) => /^register\w+$/.test(n));
    if (!fns.length) continue;                   // a module that exports no registrar: a helper, not tools
    const mod = await import(pathToFileURL(join(root, `services/zz-core/dist/${rel}.js`)).href) as Obj;
    for (const fn of fns) {
      (mod[fn] as (s: McpServer, role?: unknown) => void)(server, true);
      registrars.push(fn);
    }
  }
  return { server, registrars };
}

/** A real client, connected to `server` over a linked in-memory transport pair. */
export async function connectTo(server: McpServer, name: string): Promise<Client> {
  const [forServer, forClient] = InMemoryTransport.createLinkedPair();
  await server.connect(forServer);
  const client = new Client({ name, version: "0" });
  await client.connect(forClient);
  return client;
}

// The stub pool

/** One initiative as the stub pool answers it: its own row's flow, its documents as `zz.doc` rows
 *  joined to their current revision, and, where a check needs them, its branch facts and stage
 *  records. */
export interface StubInitiative {
  flow: string | null;
  docs: Obj[];
  facts?: Record<string, string>;
  records?: Record<string, Record<string, string>>;
}
interface Rows { rows: Obj[]; rowCount: number }
export const rowsOf = (rows: Obj[]): Rows => ({ rows, rowCount: rows.length });

/**
 * Replaces `pg.Pool.prototype.query` with one that answers the platform's initiative and document
 * reads from `world()`, a getter so a check may swap its world between cases.
 *
 * `own` is asked first, with the statement's whitespace collapsed: it answers what the check models
 * itself — a write it records, a table only it seeds — or returns undefined to fall through. A
 * statement nobody answers reads as no rows, which is right for a read and a lie for a write, so a
 * check that cares about its writes records them in `own`.
 *
 * COUPLED: the patterns below are the SQL of services/zz-core/src/initiative-record.ts,
 * tools/initiative-status.ts and the document readers (guards.ts, indexing.ts). A reworded statement
 * falls through to no rows here — once, for every check that installs this.
 */
export function stubInitiativePool<W extends StubInitiative>(
  world: () => Map<string, W>,
  { openedAt, own }: { openedAt: string; own?: (sql: string, values: unknown[]) => Rows | undefined },
): void {
  pg.Pool.prototype.query = (async function query(text: string, values: unknown[] = []) {
    const sql = String(text).replace(/\s+/g, " ").trim();
    const mine = own?.(sql, values);
    if (mine) return mine;
    const all = world();
    // Two param shapes: most readers bind the team first and the initiative second; `docRows` binds
    // the initiative first, so its lookup is its own.
    const bySlug = all.get(String(values[1] ?? ""));
    if (/select i\.slug from zz\.initiative i join zz\.team t on t\.id = i\.team_id where t\.slug = \$1 order by i\.slug/.test(sql)) {
      return rowsOf([...all.keys()].sort().map((slug) => ({ slug })));
    }
    if (/select i\.slug, i\.flow, i\.closed_at::text/.test(sql)) {
      const names = (values[1] as string[]) ?? [];
      return rowsOf(names.filter((n) => all.has(n)).map((n) => ({
        slug: n, flow: all.get(n)!.flow, closed_at: null, closed_by: null, outcome: null })));
    }
    if (/from zz\.initiative i join zz\.team t on t\.id = i\.team_id/.test(sql)) {
      return rowsOf(bySlug ? [{ id: "i1", flow: bySlug.flow, opened_at: openedAt,
                                opened_by: "ada@zz.test", slug: String(values[1]) }] : []);
    }
    if (/from zz\.doc d\b/.test(sql) && /order by d\.path/.test(sql)) {
      return rowsOf(all.get(String(values[0]))?.docs ?? []);
    }
    if (/from zz\.doc d\b/.test(sql)) {
      const hit = (bySlug?.docs ?? []).filter((d) => d.path === values[2]);
      return rowsOf(hit.length ? [hit[hit.length - 1]!] : []);
    }
    // The revision a document currently points at: its bytes, its title and its seal.
    if (/from zz\.doc_revision r\b/.test(sql) && /where r\.doc_id = \$1::uuid/.test(sql)) {
      const d = [...all.values()].flatMap((w) => w.docs).find((x) => x.id === String(values[0]));
      return rowsOf(d ? [{ revision: d.current_revision ?? 1, version: d.current_revision ?? 1,
                           content_state: "retained", title: d.title, body: d.body, tags: d.tags ?? [],
                           content_hash: "h", fields: d.fields, revision_note: null,
                           written_by: "ada@zz.test", written_at: d.updated_at,
                           approved_by: d.approved_by, approved_at: d.approved_at }] : []);
    }
    if (/from zz\.initiative_fact f\b/.test(sql)) {
      return rowsOf(Object.entries(bySlug?.facts ?? {}).map(([fact, value]) => ({ fact, value })));
    }
    if (/from zz\.initiative_record r\b/.test(sql)) {
      return rowsOf(Object.entries(bySlug?.records ?? {}).flatMap(([stage, ids]) =>
        Object.entries(ids).map(([id_name, value]) => ({ stage, id_name, value }))));
    }
    return rowsOf([]);
  }) as unknown as typeof pg.Pool.prototype.query;
}

// The route caller

export type Route = (req: unknown, res: unknown) => void;
/** What a route sent: its status, and its JSON body — `{}` with `empty` set when it sent a bare
 *  status instead (`end`, `sendStatus`). */
export interface Answered { status: number; body: Obj; empty: boolean }

/** Calls a mounted route as Express would, and waits for what it sends: a JSON body, or a bare status. */
export function answer(route: Route, req: Obj): Promise<Answered> {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200, headersSent: false,
      status(code: number) { this.statusCode = code; return this; },
      json(body: Obj) { this.headersSent = true; resolve({ status: this.statusCode, body, empty: false }); },
      end() { this.headersSent = true; resolve({ status: this.statusCode, body: {}, empty: true }); },
      sendStatus(code: number) { this.statusCode = code; this.end(); },
    };
    try { route(req, res); } catch (err) { reject(err); }
  });
}
