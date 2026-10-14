#!/usr/bin/env node
/**
 * checks/event-origin-db.ts — every event carries its origin, on a real database, from both of its
 * writers and from the migration's own backfill (AC-2.1, AC-2.2).
 *
 *   node checks/event-origin-db.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL migrated by the real runner and a real zz-core on it
 * (`withThrowawayCore`), and the gateway's own built middleware in this process: the identity gate,
 * the JSON parser, the tool-call telemetry and the relay to that zz-core, in the order server.ts
 * mounts them. What it establishes:
 *
 *   - the column refuses a third value and a null, and a row written with no origin reads `work`;
 *   - the backfill, read from the migration file and run again over rows seeded at the default,
 *     marks `platform` exactly the rows whose recorded client names one of the three maintenance
 *     clients — in any case, with a version or a space after the name, and whatever the row's
 *     kind, a presentation as well as a tool call — and leaves every other row `work`: another
 *     client, a near miss, and no client, of either kind;
 *   - a tool call sent through the gateway with each of those names lands `platform` on the row
 *     the gateway writes, and with `zz-plugin`, a near miss or no header lands `work`: the answer
 *     the backfill gave the same name;
 *   - the event zz-core writes while handling that same call, the header relayed to it by the
 *     gateway, lands with the same origin;
 *   - an event zz-core writes inside a transaction for a caller naming `zz-doctor` lands
 *     `platform`, and the same act by another client lands `work`;
 *   - no row of `zz.event` holds a null or a third value.
 *
 * DELIBERATE: the three names and both origins are written here and nothing is imported from
 * `@zz/contracts`. A check that read them from the code under test would agree with whatever it
 * said.
 *
 * That the migration does the same to rows that existed before it is what the rehearsal against a
 * production copy proves (`scripts/rehearse/expect.ts`). The only database this touches is the one
 * it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { lastJson } from "@zz/mcp-client";
import type { Request, RequestHandler } from "express";
import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";

const NAME = "event-origin-db";
const DONE = "event-origin-db: the backfill marks exactly the rows whose recorded client is a maintenance client, the gateway and " +
  "zz-core each stamp a live call with the origin of the client it named, and no event holds a null or a third value: ok";

/** COUPLED: the fold. When this file folds into `001_init.sql` its backfill statement leaves with
 *  it — a database built from the fold holds no row older than the column — and the backfill case
 *  below leaves too. */
const MIGRATION = "services/gateway/migrations/004_event_origin.sql";

type Origin = "work" | "platform";

/** A client name as a caller sends it and the origin it must read. `live` is false for a name
 *  HTTP cannot carry as sent — a header's value loses its leading space and holds no tab — so
 *  those two are rows of history only. */
const CLIENTS: readonly { client: string | null; origin: Origin; live: boolean }[] = [
  { client: "chain-check", origin: "platform", live: true },
  { client: "zz-migrate", origin: "platform", live: true },
  { client: "zz-doctor", origin: "platform", live: true },
  { client: "Chain-Check/1.4.0", origin: "platform", live: true },
  { client: "ZZ-MIGRATE 2", origin: "platform", live: true },
  { client: "Zz-Doctor/0.96.0 (darwin arm64)", origin: "platform", live: true },
  { client: "zz-plugin", origin: "work", live: true },
  { client: null, origin: "work", live: true },
  { client: "zz-doctor-extra", origin: "work", live: true },
  { client: "zz-update/zz-doctor", origin: "work", live: true },
  { client: "zz doctor", origin: "work", live: true },
  { client: " zz-doctor", origin: "work", live: false },
  { client: "zz-doctor\t1", origin: "work", live: false },
];

/** Rows of another kind, seeded beside the tool calls. The backfill reads the recorded client and
 *  not the kind, so a presentation a maintenance client made is marked like its tool call. */
const OTHER_KINDS: readonly { kind: string; client: string | null; origin: Origin }[] = [
  { kind: "document.shown", client: "zz-doctor/0.96.0", origin: "platform" },
  { kind: "document.shown_part", client: "Chain-Check 1.4", origin: "platform" },
  { kind: "document.shown", client: "zz-plugin", origin: "work" },
  { kind: "knowledge.search", client: null, origin: "work" },
];

const shown = (client: string | null): string => (client === null ? "no client" : JSON.stringify(client));

/** Rows matching `sql`, waited on until there are `n` of them: an event is written after the
 *  answer it describes, so it is polled for, briefly. */
async function rowsOnce<T extends pg.QueryResultRow>(c: Core, sql: string, params: unknown[], n: number): Promise<T[]> {
  const until = Date.now() + 5000;
  for (;;) {
    const { rows } = await c.sql.query<T>(sql, params);
    if (rows.length >= n || Date.now() > until) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The migration's backfill: its one statement that changes rows of `zz.event`, comments left out. */
function backfillOf(c: Core, step: string): string {
  const code = readFileSync(join(root, MIGRATION), "utf8").split("\n")
    .filter((l) => !l.trimStart().startsWith("--")).join("\n");
  const found = [...code.matchAll(/\bupdate\s+zz\.event\b[^;]*;/gi)].map((m) => m[0]);
  if (found.length !== 1) c.fail(step, `${MIGRATION} holds ${found.length} statements updating zz.event, not one`);
  return found[0];
}

async function schemaCases(c: Core): Promise<void> {
  const step = "the column admits work and platform and nothing else";
  const insert = "insert into zz.event (kind, subject, origin) values ('probe.origin', 'refused', $1)";
  for (const [value, code] of [["maintenance", "23514"], [null, "23502"]] as const) {
    const refused = await c.sql.query(insert, [value]).then(() => null, (err: unknown) => (err as { code?: string }).code ?? String(err));
    if (refused !== code) c.fail(step, `origin ${JSON.stringify(value)} was ${refused === null ? "accepted" : `refused with ${refused}`}, not refused with ${code}`);
  }
  for (const value of ["work", "platform"]) {
    await c.sql.query("insert into zz.event (kind, subject, origin) values ('probe.origin', 'admitted', $1)", [value]);
  }
  c.pass("a third value and a null are refused by the column, and work and platform are admitted");
}

async function backfillCases(c: Core): Promise<void> {
  const step = "the backfill, run again over seeded rows";
  const expected = new Map<string, Origin>();
  const seed = async (subject: string, kind: string, client: string | null, origin: Origin): Promise<void> => {
    const call = kind === "tool_call";
    const { rows } = await c.sql.query<{ origin: string }>(
      `insert into zz.event (kind, subject, detail, ok, tool_key)
       values ($1, $2, $3::jsonb, $4, $5) returning origin`,
      [kind, subject, JSON.stringify(client === null ? {} : { client }), call ? true : null, call ? "seed:probe" : null]);
    if (rows[0].origin !== "work") c.fail(step, `a row written with no origin reads ${rows[0].origin}, not the default work`);
    expected.set(subject, origin);
  };
  for (const [i, f] of CLIENTS.entries()) await seed(`seed:call-${i} ${shown(f.client)}`, "tool_call", f.client, f.origin);
  for (const [i, o] of OTHER_KINDS.entries()) await seed(`seed:other-${i} ${o.kind} ${shown(o.client)}`, o.kind, o.client, o.origin);

  await c.sql.query(backfillOf(c, step));

  const { rows } = await c.sql.query<{ subject: string; origin: string }>(
    "select subject, origin from zz.event where subject like 'seed:%' order by id");
  if (rows.length !== expected.size) c.fail(step, `${rows.length} seeded rows read back, not ${expected.size}`);
  const wrong = rows.filter((r) => r.origin !== expected.get(r.subject)).map((r) => `${r.subject} reads ${r.origin}`);
  if (wrong.length) c.fail(step, wrong.join("; "));
  const marked = rows.filter((r) => r.origin === "platform").length;
  const maintenance = [...CLIENTS, ...OTHER_KINDS].filter((f) => f.origin === "platform").length;
  if (marked !== maintenance) c.fail(step, `${marked} seeded rows read platform, not the ${maintenance} a maintenance client made`);
  c.pass(`the migration's own backfill marks platform exactly the ${maintenance} rows whose recorded client is a maintenance client, ` +
         `in any case, before a version or a space and whatever the row's kind, and leaves the other ${rows.length - marked} seeded rows work`);
}

/** The gateway's door to zz-core, as server.ts mounts it, and a PAT of the seeded person's. */
interface Gateway { url: string; token: string; stop(): Promise<void> }

async function listen(c: Core): Promise<Gateway> {
  // `withThrowawayDb` ended the gateway's pool after migrating; a fresh one on the same container.
  process.env.TEAM_DB_URL = c.url;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  const load = (p: string) => import(pathToFileURL(join(root, p)).href);
  const express = (await import("express")).default;
  const db = (await load("services/gateway/dist/db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await db.initPlatformDb();
  const { identityMiddleware } = (await load("services/gateway/dist/identity.js")) as { identityMiddleware: () => RequestHandler };
  const { toolCallTelemetry, doorSurface } = (await load("services/gateway/dist/tool-telemetry.js")) as
    { toolCallTelemetry: (surface: (req: Request) => string) => RequestHandler; doorSurface: (url: string) => string };
  const { passThrough } = (await load("services/gateway/dist/relay.js")) as
    { passThrough: (url: string, what: string, refusal: string) => RequestHandler };

  const app = express();
  // COUPLED: services/gateway/src/server.ts — the identity gate, the JSON parser, the telemetry on
  // the door and then the door's relay to zz-core, in the order server.ts mounts them.
  app.use(identityMiddleware());
  app.use(express.json({ limit: "20mb" }));
  app.use(["/core/mcp"], toolCallTelemetry((req) => doorSurface(req.originalUrl)));
  app.all("/core/mcp", passThrough(c.mcp.url, "core proxy", "zz-core is not reachable"));
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));

  const token = `zzp_${randomBytes(24).toString("hex")}`;
  await c.sql.query("insert into zz.pat (principal_id, token_hash) select id, $2 from zz.principal where email = $1",
                    [c.email, createHash("sha256").update(token, "utf8").digest("hex")]);
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    token,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.platformDb().end().catch(() => undefined);
      delete process.env.TEAM_DB_URL;
      delete process.env.ZZ_CATALOG_DIR;
    },
  };
}

/** One `knowledge_search` through the gateway, as a client naming itself `client` — or sending no
 *  `x-zz-client` at all — and the tool's reply. */
async function search(g: Gateway, client: string | null, query: string): Promise<{ status: number; reply: string }> {
  const res = await fetch(`${g.url}/core/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${g.token}`, "content-type": "application/json",
      accept: "application/json, text/event-stream", ...(client === null ? {} : { "x-zz-client": client }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "knowledge_search", arguments: { query } } }),
    signal: AbortSignal.timeout(60_000),
  });
  const raw = await res.text();
  const env = lastJson(raw);
  return { status: res.status, reply: env?.result?.content?.map((p) => p.text ?? "").join("") ?? env?.error?.message ?? raw.slice(0, 300) };
}

async function liveCases(c: Core, g: Gateway): Promise<void> {
  const step = "a live call through the gateway";
  const live = CLIENTS.filter((f) => f.live);
  for (const [i, f] of live.entries()) {
    // Its own words, so the row zz-core writes for this call is found by its subject.
    const query = `origin probe ${i} quokka`;
    const sent = await search(g, f.client, query);
    if (sent.status !== 200 || !sent.reply || sent.reply.startsWith("ERROR")) {
      c.fail(step, `knowledge_search as ${shown(f.client)} answered ${sent.status}: ${sent.reply.slice(0, 300)}`);
    }
    const calls = await rowsOnce<{ origin: string }>(c,
      `select origin from zz.event
        where kind = 'tool_call' and subject = 'core:knowledge_search' and detail->>'client' is not distinct from $1::text`,
      [f.client], 1);
    if (calls.length !== 1 || calls[0].origin !== f.origin) {
      c.fail(step, `the gateway's tool_call for ${shown(f.client)} reads ${JSON.stringify(calls.map((r) => r.origin))}, not one row of ${f.origin}`);
    }
    const acts = await rowsOnce<{ origin: string }>(c,
      "select origin from zz.event where kind = 'knowledge.search' and subject = $1", [query], 1);
    if (acts.length !== 1 || acts[0].origin !== f.origin) {
      c.fail(step, `zz-core's knowledge.search for ${shown(f.client)} reads ${JSON.stringify(acts.map((r) => r.origin))}, not one row of ${f.origin}`);
    }
  }
  const names = (o: Origin): string => live.filter((f) => f.origin === o).map((f) => shown(f.client)).join(", ");
  c.pass(`the gateway's tool_call lands platform for ${names("platform")} and work for ${names("work")}, as the backfill read the same names`);
  c.pass("the event zz-core writes for each of those calls, the header relayed by the gateway, lands with the same origin");
}

async function transactionCase(c: Core): Promise<void> {
  const step = "an event zz-core writes in a transaction";
  const path = `${await c.open("event-origin")}/notes.md`;
  await c.ok(step, "document_write", { path, title: "Notes", content: "# Notes\n\nThe wombat cache expires nightly.\n" });
  await c.ok(step, "document_present", { path }, c.client({ client: "zz-doctor" }));
  await c.ok(step, "document_present", { path });
  const rows = await rowsOnce<{ client: string | null; origin: string }>(c,
    `select detail->>'client' as client, origin from zz.event
      where kind in ('document.shown', 'document.shown_part') and subject = $1 order by id`, [path], 2);
  const read = rows.map((r) => `${r.client}:${r.origin}`).join(", ");
  if (read !== `zz-doctor:platform, ${NAME}:work`) {
    c.fail(step, `the presentations of ${path} read [${read}], not [zz-doctor:platform, ${NAME}:work]`);
  }
  c.pass("a presentation zz-core records in its transaction lands platform for a caller naming zz-doctor, and work for another client");
}

async function everyRow(c: Core): Promise<void> {
  const step = "no event holds a null or a third value";
  const { rows } = await c.sql.query<{ origin: string | null; n: number }>(
    "select origin, count(*)::int as n from zz.event group by origin order by origin");
  const other = rows.filter((r) => r.origin !== "work" && r.origin !== "platform");
  const of = (o: Origin): number => rows.find((r) => r.origin === o)?.n ?? 0;
  if (other.length || !of("work") || !of("platform")) c.fail(step, `zz.event holds ${JSON.stringify(rows)}`);
  c.pass(`every one of the ${of("work") + of("platform")} events reads work (${of("work")}) or platform (${of("platform")})`);
}

async function run(c: Core): Promise<void> {
  await schemaCases(c);
  await backfillCases(c);
  const g = await listen(c);
  try {
    await liveCases(c, g);
    await transactionCase(c);
    await everyRow(c);
  } finally {
    await g.stop();
  }
}

process.exitCode = await withThrowawayCore(NAME, DONE, run);
