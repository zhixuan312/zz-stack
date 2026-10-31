#!/usr/bin/env node
/**
 * checks/console-statements-once.ts — no console page issues the same statement twice inside one
 * request (AC-10.1).
 *
 *   node checks/console-statements-once.ts   # needs Docker and a built tree (npm run build)
 *
 * A page's read is a fan-out: Home reduces the whole record to a week, Record slices a period,
 * Initiatives lists work, Status measures the platform. Each is several readers called from several
 * places in one request, and the same reader called twice with the same arguments buys nothing — the
 * second call issues the identical statement over the identical rows and throws the first away. The
 * cost is in nobody's answer: it is the page being slower for a figure no one can see.
 *
 * The rule is a PAIR, not a count: the same statement text with the same bind arguments, twice. Two
 * reads over different windows are legitimate and must not be flagged, which is why the comparison is
 * the whitespace-collapsed text together with the parameter array.
 *
 * DELIBERATE: SETTLED repeats are counted, not only concurrent ones. The in-flight dedupe the gateway
 * has (`shared()`, imports.ts) collapses calls issued while an earlier one is still running; a second
 * call issued after its twin has settled is untouched by it, and that is exactly the Home case this
 * check exists for — a week computed, awaited to place a window, and then computed again inside the
 * list that window feeds. A check that only counted concurrent repeats would pass on the tree that had
 * the defect, which is why each repeat is labelled and the label is printed with it.
 *
 * DELIBERATE: the change listener is taken down before any route is read. `mountConsole` opens it, and
 * with it up `cachedWithHit` keeps answers, so a reader that asked the cache twice in one request would
 * be served the second time and issue nothing — the repeat this check exists for, hidden. With nothing
 * listening no answer is kept, every route computes its page, and each answer must say it was not served.
 *
 * DELIBERATE: each route is read once, in one process. A memo of a reader's answer is process state,
 * so a later route reading a window an earlier one already read runs fewer statements and says nothing
 * about that route's own fan-out. The assertion is "no duplicate group", never an exact total; the
 * total is printed so a reader can see the page's weight.
 *
 * Exit 0: every route issued no statement twice with the same arguments — one line per route, then the
 * total of each.
 * Exit 1: a route issued one twice — the statement, its arguments and whether the pair overlapped.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import type { Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Express, RequestHandler } from "express";
import pg from "pg";

import { root } from "../scripts/deployment.ts";
import { signIn } from "../scripts/schema/status-seed.ts";
import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";
import { failing, type Fail } from "../scripts/schema/throwaway.ts";

const NAME = "console-statements-once";
const DONE = "console-statements-once: Home, Record, Initiatives and Status each issue no statement twice " +
  "with the same arguments inside one request: ok";

const TIMEZONE = "Asia/Singapore";

/** The four routes, what this check calls them, and the address read. Record's period and every page's
 *  size are pinned: a default that moves would change the window a repeat is judged over. */
const ROUTES: [string, string][] = [
  ["Home", "/api/console/home"],
  ["Record", "/api/console/record?period=all&limit=10"],
  ["Initiatives", "/api/console/initiatives?limit=10"],
  ["Status", "/api/console/platform/status"],
];

type Issued = { key: string; text: string; values: string; concurrent: boolean };

const fail: Fail = failing(NAME);
const pass = (line: string): void => console.log(`  ok  ${line}`);

/** A statement's text with its whitespace collapsed: the same statement written across two template
 *  literals has the same words, and Postgres is handed the same plan. */
const squash = (text: string): string => text.replace(/\s+/g, " ").trim();
const args = (values: unknown): string => JSON.stringify(values ?? null);

async function run(core: Core): Promise<void> {
  // DELIBERATE: set before any gateway module loads — the modules read these once.
  process.env.TEAM_DB_URL = core.url;
  process.env.ZZ_TZ = TIMEZONE;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  process.env.CORE_MCP_URL = core.mcp.url;

  // Two initiatives, one young and one old, with a document waiting for approval. Home's window and
  // the list's window coincide on a young record — the case that produced the sequential repeat — and
  // differ on an old one, which must stay legitimate rather than be counted as a repeat.
  const seed = async (slug: string, weeks: number): Promise<void> => {
    const name = await core.open(slug);
    await core.ok("the seed's document", "document_write", {
      path: `${name}/spec.md`,
      content: `# Spec\n\nSeeded for the statements-once check, opened ${weeks} week(s) ago.\n`,
    });
    await core.ok("the seed's presented document", "document_present", { path: `${name}/spec.md` });
    await core.sql.query("update zz.initiative set opened_at = now() - ($2 || ' weeks')::interval where slug = $1",
      [name, String(weeks)]);
  };
  await seed("i16-young", 3);
  await seed("i16-old", 30);

  const express = (await import("express")).default;
  const load = (f: string) => import(pathToFileURL(join(root, "services/gateway/dist", f)).href);
  const dbModule = (await load("db.js")) as { initPlatformDb: () => Promise<void> };
  const { identityMiddleware } = (await load("identity.js")) as { identityMiddleware: () => RequestHandler };
  const { passThrough } = (await load("relay.js")) as {
    passThrough: (url: string, what: string, refusal: string) => RequestHandler;
  };
  const { mountConsole } = (await load("console.js")) as { mountConsole: (app: Express) => void };
  const live = (await load("console/live-revision.js")) as { notListening: () => void; dataVersion: () => string | null };
  await dbModule.initPlatformDb();

  // COUPLED: services/gateway/src/server.ts — the identity gate, the core relay the list reaches its
  // relayed `initiative_status` through, and the console's own routes.
  const app = express();
  app.use(identityMiddleware());
  app.all("/core/mcp", passThrough(core.mcp.url, "core proxy", "zz-core is not reachable"));
  mountConsole(app);
  // The listener `mountConsole` opened is taken down, by the module doc's DELIBERATE. The wait first, as
  // checks/console-read-contract.ts does, so its own open cannot re-arm the marker after this.
  for (let waited = 0; live.dataVersion() === null; waited += 100) {
    if (waited > 15_000) fail("the change listener", "it never came up, so taking it down would prove nothing");
    await new Promise((r) => setTimeout(r, 100));
  }
  live.notListening();
  if (live.dataVersion() !== null) fail("the change listener", `dataVersion is ${live.dataVersion()} after it was taken down`);
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const cookie = `zz_console=${await signIn(core.sql, core.email)}`;

  // COUPLED: `pg.Pool.prototype.query` — the gateway runs in this process and `platformDb()` is its one
  // pool, so this sees every statement the page's own reads issue, whichever module issued it. The
  // in-flight counter is what tells a concurrent repeat from a settled one.
  const proto = pg.Pool.prototype as unknown as { query: (...a: unknown[]) => unknown };
  const original = proto.query;
  const inflight = new Map<string, number>();
  let issued: Issued[] = [];
  proto.query = function patched(this: unknown, ...a: unknown[]): unknown {
    const text = typeof a[0] === "string" ? a[0] : ((a[0] as { text?: string } | undefined)?.text ?? "");
    const values = typeof a[0] === "string" ? a[1] : (a[0] as { values?: unknown } | undefined)?.values;
    const key = `${squash(text)}\u0000${args(values)}`;
    issued.push({ key, text: squash(text), values: args(values), concurrent: (inflight.get(key) ?? 0) > 0 });
    inflight.set(key, (inflight.get(key) ?? 0) + 1);
    const out = original.apply(this, a as never) as Promise<unknown>;
    const done = (): void => { inflight.set(key, (inflight.get(key) ?? 1) - 1); };
    if (out && typeof (out as Promise<unknown>).then === "function") (out as Promise<unknown>).then(done, done);
    else done();
    return out;
  };

  const totals: [string, number][] = [];
  try {
    for (const [what, path] of ROUTES) {
      issued = [];
      const res = await fetch(`${base}${path}`, { headers: { cookie, accept: "application/json" } });
      if (res.status !== 200) fail(`${what} answers`, `${path} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = await res.json() as { meta?: { cacheHit?: unknown } | null };
      if (typeof body.meta !== "object" || body.meta === null) fail(`${what} answers`, `${path} answered no meta`);
      if (body.meta.cacheHit !== false) fail(`${what} answers`, `${path} answered meta.cacheHit ${JSON.stringify(body.meta.cacheHit)} with nothing listening`);
      if (issued.length === 0) fail(`${what} answers`, `${path} issued no statement this check could see — the wrapper is not on the pool it uses`);

      const groups = new Map<string, Issued[]>();
      for (const s of issued) groups.set(s.key, [...(groups.get(s.key) ?? []), s]);
      const repeated = [...groups.values()].filter((g) => g.length > 1);
      if (repeated.length) {
        const lines = repeated.map((g) => {
          const how = g.some((s) => s.concurrent) ? "concurrent" : "settled";
          return `${g.length}× ${how}: ${g[0].text.slice(0, 150)}  ← ${g[0].values.slice(0, 110)}`;
        });
        fail(`${what} issues no statement twice`, `${repeated.length} repeated statement(s):\n      ${lines.join("\n      ")}`);
      }
      totals.push([what, issued.length]);
      pass(`${what}: ${issued.length} statement(s), none issued twice with the same arguments`);
    }
  } finally {
    proto.query = original;
    server.close();
  }
  pass(`statements issued: ${totals.map(([w, n]) => `${w} ${n}`).join(", ")}`);
}

process.exit(await withThrowawayCore(NAME, DONE, run));
