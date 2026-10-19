#!/usr/bin/env node
/**
 * checks/console-live-since.ts — a console read carries the revision of its collection, and a tab's first stream, asked
 * with that revision, is greeted `synced` when nothing it would have been told moved since and `resync` naming what did
 * (ZZ Meridian 0.18.0's `since`, AC-8.7).
 *
 *   node checks/console-live-since.ts   # needs Docker and a built tree (`npm run build`)
 *
 * The console's server reads a page as the person, hands the revisions those reads carried to the page's `useLive`, and
 * the tab's first stream sends them back (the console's `src/lib/live.ts`, ZZ Meridian's file). A revision is
 * `<boot>:<n>`: the boot of the gateway's current `LISTEN` connection and the count of changes to that collection the
 * caller's own stream would have been told, so it moves with exactly the hints that caller would have heard. What it
 * establishes, as a member and as a superadmin in one team, and a second team neither reads:
 *
 *   - a read while the gateway is not listening yet carries no revision;
 *   - once it listens, `/activity` and `/me` each carry `x-zz-revision: <collection>:<boot>:<n>`, the two people's
 *     revisions of one boot;
 *   - a stream asked with those revisions is greeted `synced`, and one asked with none is greeted with a resync of every
 *     name, as before;
 *   - an event written in the member's team moves both people's `activity` revision, and a stream asked with the old
 *     ones is greeted with a resync naming `activity` alone;
 *   - an event written in the other team moves the superadmin's revision and leaves the member's where it was: the
 *     member's stream is still `synced`, the superadmin's resyncs `activity`;
 *   - a malformed pair resyncs its own name and leaves the others' greeting as it was;
 *   - once the `LISTEN` connection is lost and made again, reads carry a new boot, and a revision of the old one is
 *     answered with a resync of every name it named;
 *   - the console's routes as `mountConsole` mounts them carry the revision too.
 *
 * DELIBERATE: the changes are rows written to `zz.event`, which the change triggers of
 * `services/gateway/migrations/003_console_live.sql` and `005_page_view_no_hint.sql` notify on, rather than a
 * `pg_notify` of the check's own: a revision has to move with what a real write sends, through the path it takes.
 *
 * It starts a throwaway PostgreSQL migrated by the real runner (`withThrowawayDb`), signs the two people in, and serves
 * the gateway's built identity middleware, the revision, `/me`, `/activity` and the stream from this process in
 * server.ts's order, reading the answers over HTTP as a browser would. The only database it touches is the one it
 * started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import type { Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Express, RequestHandler } from "express";
import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import { signIn } from "../scripts/schema/status-seed.ts";
import { withThrowawayDb } from "../scripts/schema/throwaway.ts";

const NAME = "console-live-since";
const DONE = "console-live-since: every console read carries its collection's revision as the caller's stream counts it, " +
  "and a first stream asked with it is greeted synced, or resync naming only what moved, a member's revision moving " +
  "with their own team alone: ok";

/** The header a read's revision travels in. COUPLED: `REVISION_HEADER` in services/gateway/src/console/live-revision.ts
 *  and the console's src/data/gateway.ts, written out here so the check does not agree with whatever the code says. */
const HEADER = "x-zz-revision";
const REVISION = /^(activity|me):([A-Za-z0-9_-]+):(\d+)$/;

const TEAM = "since-team";
const OTHER = "since-other";
const MEMBER = "member@since.example.test";
const ADMIN = "admin@since.example.test";

/** How long a committed change is given to reach the listener, and a lost connection to be made again. */
const SETTLES_MS = 15_000;

class CaseFailure extends Error {}
const fail = (step: string, detail: string): never => { throw new CaseFailure(`${NAME}: FAILED at "${step}": ${detail}`); };
const pass = (line: string): void => console.log(`ok ${line}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Read = { status: number; revision: string | null };

async function seed(sql: pg.Client): Promise<{ team: string; other: string; member: string }> {
  const person = async (email: string, role: string): Promise<string> => (await sql.query<{ id: string }>(
    "insert into zz.principal (email, display_name, role) values ($1, $2, $3) returning id", [email, email, role])).rows[0].id;
  const member = await person(MEMBER, "member");
  const admin = await person(ADMIN, "superadmin");
  const team = async (slug: string): Promise<string> => (await sql.query<{ id: string }>(
    "insert into zz.team (slug, name, created_by) values ($1, $1, $2) returning id", [slug, admin])).rows[0].id;
  const one = await team(TEAM);
  const other = await team(OTHER);
  // Both people act for the one team; nobody here acts for the other, whose changes only the superadmin may hear.
  for (const p of [member, admin]) {
    await sql.query("insert into zz.membership (team_id, principal_id, role, added_by) values ($1, $2, 'member', $3)", [one, p, admin]);
  }
  return { team: one, other, member };
}

async function run(sql: pg.Client, url: string): Promise<void> {
  const ids = await seed(sql);
  const cookie = { member: `zz_console=${await signIn(sql, MEMBER)}`, admin: `zz_console=${await signIn(sql, ADMIN)}` };

  process.env.TEAM_DB_URL = url;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  const load = (f: string) => import(pathToFileURL(join(root, "services/gateway/dist", f)).href);
  const express = (await import("express")).default;
  const dbModule = (await load("db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  const { identityMiddleware } = (await load("identity.js")) as { identityMiddleware: () => RequestHandler };
  const { mountConsoleRevision } = (await load("console/live-revision.js")) as { mountConsoleRevision: (app: Express) => void };
  const { mountMe } = (await load("console/me.js")) as { mountMe: (app: Express) => void };
  const { mountActivity } = (await load("console/activity.js")) as { mountActivity: (app: Express) => void };
  const { mountConsoleLive } = (await load("console/live.js")) as { mountConsoleLive: (app: Express) => void };
  const { mountConsole } = (await load("console.js")) as { mountConsole: (app: Express) => void };
  await dbModule.initPlatformDb();

  // COUPLED: services/gateway/src/server.ts and console.ts — the identity gate, then the revision in front of every
  // console read, then the reads. The stream is mounted once the first case has read with nothing listening, since
  // mounting it is what starts the gateway's `LISTEN`.
  const app = express();
  app.use(identityMiddleware());
  mountConsoleRevision(app);
  mountMe(app);
  mountActivity(app);
  const servers: Server[] = [];
  const serve = async (a: Express): Promise<string> => {
    const server = a.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  };
  const base = await serve(app);

  const read = async (who: string, path: string, at = base): Promise<Read> => {
    const res = await fetch(`${at}/api/console${path}`, { headers: { cookie: who, accept: "application/json" } });
    await res.arrayBuffer();
    return { status: res.status, revision: res.headers.get(HEADER) };
  };
  /** The revision a read carries, as the pair a stream's `since` takes. */
  const revised = async (step: string, who: string, path: string): Promise<string> => {
    const r = await read(who, path);
    if (r.status !== 200) fail(step, `${path} answered ${r.status}`);
    if (!r.revision || !REVISION.test(r.revision)) fail(step, `${path} carried ${HEADER}: ${JSON.stringify(r.revision)}`);
    return r.revision!;
  };
  /** The stream's first event once it opens: its greeting. The stream is closed as soon as it is read. */
  const greeting = async (step: string, who: string, query: string): Promise<string> => {
    const abort = new AbortController();
    const res = await fetch(`${base}/api/console/live?${query}`, { headers: { cookie: who }, signal: abort.signal });
    if (res.status !== 200) fail(step, `the stream answered ${res.status}: ${await res.text()}`);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const until = Date.now() + 5000;
    try {
      while (Date.now() < until) {
        const event = text.split("\n\n").find((f) => f.startsWith("event:"));
        if (event) return event;
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      return fail(step, `no greeting arrived: ${JSON.stringify(text)}`);
    } finally {
      abort.abort();
    }
  };
  const since = (...pairs: string[]) => `since=${encodeURIComponent(pairs.join(","))}`;
  const FOLLOWED = "collections=activity,me";
  const SYNCED = "event: synced\ndata: {}";
  const resync = (names: string[]) => `event: resync\ndata: ${JSON.stringify({ collections: names })}`;
  const expect = (step: string, found: string, want: string) => { if (found !== want) fail(step, `greeted ${JSON.stringify(found)}, not ${JSON.stringify(want)}`); };
  /** Poll `who`'s revision of `path` until it is no longer `was`. */
  const movedFrom = async (step: string, who: string, path: string, was: string): Promise<string> => {
    const until = Date.now() + SETTLES_MS;
    for (;;) {
      const now = (await read(who, path)).revision;
      if (now && now !== was) return now;
      if (Date.now() > until) return fail(step, `${path} still carries ${JSON.stringify(now)} ${SETTLES_MS} ms on`);
      await sleep(50);
    }
  };
  const event = (team: string, n: number) => sql.query(
    "insert into zz.event (kind, subject, ok, team_id, actor_id) values ('knowledge.add', $1, true, $2, $3)", [`since-${n}`, team, ids.member]);

  try {
    let step = "a read while the gateway is not listening yet carries no revision";
    const before = await read(cookie.member, "/activity");
    if (before.status !== 200 || before.revision !== null) fail(step, `/activity answered ${before.status} with ${HEADER}: ${JSON.stringify(before.revision)}`);
    pass(step);

    mountConsoleLive(app);
    step = "once the gateway listens, each read carries its collection's revision, both people's of one boot";
    const until = Date.now() + SETTLES_MS;
    while ((await read(cookie.member, "/activity")).revision === null) {
      if (Date.now() > until) fail(step, `no read carried a revision ${SETTLES_MS} ms after the stream was mounted`);
      await sleep(50);
    }
    const memberActivity = await revised(step, cookie.member, "/activity");
    const memberMe = await revised(step, cookie.member, "/me");
    const adminActivity = await revised(step, cookie.admin, "/activity?scope=platform");
    const adminMe = await revised(step, cookie.admin, "/me");
    const bootOf = (r: string) => REVISION.exec(r)![2];
    if (new Set([memberActivity, memberMe, adminActivity, adminMe].map(bootOf)).size !== 1) {
      fail(step, `the revisions name more than one boot: ${[memberActivity, memberMe, adminActivity, adminMe].join(", ")}`);
    }
    if (!memberMe.startsWith("me:") || !memberActivity.startsWith("activity:")) fail(step, `the revisions name the wrong collections: ${memberActivity}, ${memberMe}`);
    pass(`${step}: ${memberActivity}, ${memberMe}`);

    step = "a stream asked with the revisions just read is greeted synced";
    expect(`${step}, as the member`, await greeting(step, cookie.member, `${FOLLOWED}&${since(memberActivity, memberMe)}`), SYNCED);
    expect(`${step}, as the superadmin`, await greeting(step, cookie.admin, `${FOLLOWED}&${since(adminActivity, adminMe)}`), SYNCED);
    pass(step);

    step = "a stream asked with no revision is greeted with a resync of every name, as before";
    expect(step, await greeting(step, cookie.member, FOLLOWED), resync(["activity", "me"]));
    pass(step);

    step = "an event in the member's team moves both people's activity revision and resyncs activity alone";
    await event(ids.team, 1);
    const memberMoved = await movedFrom(step, cookie.member, "/activity", memberActivity);
    const adminMoved = await movedFrom(step, cookie.admin, "/activity?scope=platform", adminActivity);
    if ((await read(cookie.member, "/me")).revision !== memberMe) fail(step, "the member's me revision moved with an event");
    expect(`${step}, as the member`, await greeting(step, cookie.member, `${FOLLOWED}&${since(memberActivity, memberMe)}`), resync(["activity"]));
    expect(`${step}, as the superadmin`, await greeting(step, cookie.admin, `${FOLLOWED}&${since(adminActivity, adminMe)}`), resync(["activity"]));
    expect(`${step}, the new revisions`, await greeting(step, cookie.member, `${FOLLOWED}&${since(memberMoved, memberMe)}`), SYNCED);
    pass(`${step}: ${memberActivity} to ${memberMoved}`);

    step = "an event in another team moves the superadmin's revision and leaves the member's where it was";
    await event(ids.other, 2);
    const adminElsewhere = await movedFrom(step, cookie.admin, "/activity?scope=platform", adminMoved);
    const memberStill = (await read(cookie.member, "/activity")).revision;
    if (memberStill !== memberMoved) fail(step, `the member's revision moved from ${memberMoved} to ${memberStill} with another team's event`);
    expect(`${step}, as the member`, await greeting(step, cookie.member, `${FOLLOWED}&${since(memberMoved, memberMe)}`), SYNCED);
    expect(`${step}, as the superadmin`, await greeting(step, cookie.admin, `${FOLLOWED}&${since(adminMoved, adminMe)}`), resync(["activity"]));
    pass(`${step}: the superadmin's ${adminMoved} to ${adminElsewhere}, the member's ${memberStill}`);

    step = "a malformed pair resyncs its own name and no other";
    expect(`${step}, a revision that is not one`, await greeting(step, cookie.member, `${FOLLOWED}&${since("activity:not-a-revision", memberMe)}`), resync(["activity"]));
    expect(`${step}, a pair with no revision`, await greeting(step, cookie.member, `${FOLLOWED}&${since("activity", memberMe)}`), resync(["activity"]));
    expect(`${step}, a name the stream does not follow`, await greeting(step, cookie.member, `${FOLLOWED}&${since(memberMoved, memberMe, "runs:x:1")}`), SYNCED);
    pass(step);

    step = "a lost LISTEN connection, made again, is a new boot, and a revision of the old one resyncs every name it named";
    const ended = await sql.query("select pg_terminate_backend(pid) from pg_stat_activity where query = 'listen zz_console_change'");
    if (ended.rowCount !== 1) fail(step, `found ${ended.rowCount} listening connections to end, not one`);
    const after = Date.now() + SETTLES_MS;
    let renewed: string | null = null;
    while (!renewed || bootOf(renewed) === bootOf(memberMoved)) {
      if (Date.now() > after) fail(step, `no read carried a new boot ${SETTLES_MS} ms after the connection ended (last ${JSON.stringify(renewed)})`);
      await sleep(50);
      renewed = (await read(cookie.member, "/activity")).revision;
    }
    expect(step, await greeting(step, cookie.member, `${FOLLOWED}&${since(memberMoved, memberMe)}`), resync(["activity", "me"]));
    pass(`${step}: ${memberMoved} to ${renewed}`);

    step = "the console's routes as mountConsole mounts them carry the revision";
    const whole = express();
    whole.use(identityMiddleware());
    mountConsole(whole);
    const mounted = await read(cookie.member, "/activity", await serve(whole));
    if (mounted.status !== 200 || !mounted.revision || !REVISION.test(mounted.revision)) {
      fail(step, `/activity answered ${mounted.status} with ${HEADER}: ${JSON.stringify(mounted.revision)}; mountConsole mounts no revision in front of its reads`);
    }
    pass(step);
  } finally {
    for (const s of servers) { s.closeAllConnections(); s.close(); }
    await dbModule.platformDb().end().catch(() => undefined);
    delete process.env.TEAM_DB_URL;
  }
}

async function main(): Promise<number> {
  let url = "";
  try {
    await withThrowawayDb((sql) => run(sql, url), async (u) => { url = u; });
  } catch (err) {
    if (err instanceof CaseFailure) { console.error(err.message); return 1; }
    if (/Docker is not running/.test(String(err))) {
      console.error(`${NAME}: Docker is not available — the check could not run, which is not a pass`);
      return 2;
    }
    console.error(`${NAME}: FAILED — ${err instanceof Error ? err.stack : String(err)}`);
    return 1;
  }
  console.log(DONE);
  return 0;
}

process.exitCode = await main();
