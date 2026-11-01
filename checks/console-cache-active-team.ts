#!/usr/bin/env node
/**
 * checks/console-cache-active-team.ts — a kept Work answer is stranded by a write to the team it is about,
 * whatever `?team=` the request names.
 *
 *   node checks/console-cache-active-team.ts   # a throwaway core, the built gateway in-process
 *
 * Work's reads (`/initiatives`, `/home`, `/record`) are computed for the identity's active team and ignore
 * `?team=`. The marker a kept answer sits under was folded from the scope `resolveScope` reads off the
 * request, which honours `?team=`: a person in teams A and B, acting for A and asking with `?team=B`, was
 * answered A's figures under B's marker. A's writes never moved that marker, so the answer stayed stale
 * until the cache's minute ran out. On the tree before this check the third read below is a hit that still
 * counts the open initiatives as they were before the write, which is the defect.
 *
 * Exit 0: every case holds — one line per case, then the final line.
 * Exit 1: the first case that does not, quoting what was read.
 * Exit 2: Docker is not available.
 */
import type { Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Express, RequestHandler } from "express";
import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import { signIn } from "../scripts/schema/status-seed.ts";
import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";
import { failing, type Fail } from "../scripts/schema/throwaway.ts";

const NAME = "console-cache-active-team";
const DONE = "console-cache-active-team: a kept Work answer sits under its active team's marker, so a write " +
  "to that team strands it whatever ?team= the request names";

const OTHER_TEAM = "cache-active-other";
const INITIATIVES = "/api/console/initiatives";
const ASKED = `${INITIATIVES}?team=${OTHER_TEAM}`;

const fail: Fail = failing(NAME);
const pass = (line: string): void => console.log(`ok ${line}`);

const load = (f: string) => import(pathToFileURL(join(root, "services/gateway/dist", f)).href);

type Answer = { status: number; hit: unknown; open: unknown; body: Record<string, unknown> };

/** The seeded person, a member of a second team as well, still acting for the first. */
async function seed(sql: pg.Client, core: Core): Promise<{ teamA: string; person: string }> {
  const person = (await sql.query<{ id: string }>("select id from zz.principal where email = $1", [core.email])).rows[0].id;
  const teamA = (await sql.query<{ id: string }>("select id from zz.team where slug = $1", [core.team])).rows[0].id;
  const teamB = (await sql.query<{ id: string }>(
    "insert into zz.team (slug, name, created_by) values ($1, $1, $2) returning id", [OTHER_TEAM, person])).rows[0].id;
  await sql.query("insert into zz.membership (team_id, principal_id, role, added_by) values ($1, $2, 'member', $2)",
    [teamB, person]);
  await sql.query("update zz.principal set active_team_id = $1 where id = $2", [teamA, person]);
  return { teamA, person };
}

async function run(core: Core): Promise<void> {
  const sql = core.sql;
  const { teamA, person } = await seed(sql, core);

  process.env.TEAM_DB_URL = core.url;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  const express = (await import("express")).default;
  const dbModule = (await load("db.js")) as { initPlatformDb: () => Promise<void> };
  const { identityMiddleware } = (await load("identity.js")) as { identityMiddleware: () => RequestHandler };
  const { mountConsole } = (await load("console.js")) as { mountConsole: (app: Express) => void };
  const live = (await load("console/live-revision.js")) as { dataVersion: () => string | null };
  await dbModule.initPlatformDb();

  // COUPLED: services/gateway/src/server.ts — the identity gate in front of the console's own reads.
  const app = express();
  app.use(identityMiddleware());
  mountConsole(app);
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const cookie = `zz_console=${await signIn(sql, core.email)}`;

  const read = async (path: string): Promise<Answer> => {
    const res = await fetch(`${base}${path}`, { headers: { cookie, accept: "application/json" } });
    const body = await res.json() as Record<string, unknown>;
    return {
      status: res.status, body,
      hit: (body.meta as { cacheHit?: unknown } | undefined)?.cacheHit,
      open: (body.tiles as { open?: unknown } | undefined)?.open,
    };
  };
  const ok = (step: string, a: Answer): Answer => {
    if (a.status !== 200) fail(step, `${ASKED} answered ${a.status}: ${JSON.stringify(a.body).slice(0, 300)}`);
    return a;
  };

  try {
    // With nothing listening nothing is kept, and the case below would pass for that reason alone.
    for (let waited = 0; ; waited += 100) {
      if (live.dataVersion() !== null) break;
      if (waited > 15_000) fail("the change listener is up", "it did not come up within 15s");
      await new Promise((r) => setTimeout(r, 100));
    }

    let step = "the active team's list asked with ?team= naming the other team is kept";
    const first = ok(step, await read(ASKED));
    const again = ok(step, await read(ASKED));
    if (first.hit !== false || again.hit !== true) fail(step, `the two reads report cacheHit ${first.hit} and ${again.hit}`);
    pass(`${ASKED} is computed once and kept, for the team the person acts for`);

    step = "a write to the active team strands it";
    await sql.query(
      "insert into zz.initiative (team_id, slug, opened_by, opened_at) values ($1, '2026-10-03-cache-active-new', $2, now())",
      [teamA, person]);
    // The listener hears the write on its own connection, after the insert returns.
    await new Promise((r) => setTimeout(r, 50));
    const after = ok(step, await read(ASKED));
    if (after.hit !== false) {
      fail(step, `the read after a new initiative in ${core.team} was served the kept answer, ${after.open} open ` +
        `as before the write: it sat under ${OTHER_TEAM}'s marker`);
    }
    if (typeof first.open !== "number" || after.open !== first.open + 1) {
      fail(step, `the list counts ${JSON.stringify(after.open)} open after the write, ${JSON.stringify(first.open)} before`);
    }
    pass(`a new initiative in ${core.team} stranded the answer, and the next read counts it`);
  } finally {
    server.close();
  }
}

process.exit(await withThrowawayCore(NAME, DONE, run));
