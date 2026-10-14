#!/usr/bin/env node
/**
 * skeleton.ts — the walking skeleton, end to end in one command: the console built and served as
 * production serves it, reading the real gateway, against an isolated database (AC-1.13).
 *
 *   npm run skeleton      # needs Docker and ../zz-stack-dashboard with its dependencies installed
 *
 * It starts a throwaway PostgreSQL migrated by the real runner (`withThrowawayDb`), seeds the events
 * and people `scripts/schema/status-seed.ts` declares, and signs a member of the seed's first team
 * and a superadmin in through real console session rows. The platform is built first (`npm run
 * build`, incremental), and the gateway is its own built identity middleware, JSON parser and
 * whole console API (`mountConsole`), mounted in this process in server.ts's order on a free port:
 * `dist/server.js` itself listens on port 8000 of every interface, which a run beside a deployment
 * or another stack cannot have. The console is built the way `pnpm verify` builds it, with `ZZ_GATEWAY` set to that
 * gateway, and served with `next start` on a free port with `NODE_ENV` production and no
 * development credential. What it establishes, each page read to the end of its stream and matched
 * on its text with markup, scripts and React's comments removed:
 *
 *   - `/platform` as the member and as the superadmin answers 200 with `Malformed calls per 1,000`,
 *     the last whole week's value to one decimal and its `<n> of <d>` — the figure the seed states,
 *     8 of 125 and 64.0, never one read back from the gateway;
 *   - `/` as each answers 200;
 *   - `/platform`, and a nested initiative address with a query, each with no cookie and with a
 *     cookie no session has, are sent to `/login?next=` that whole address, encoded, in both forms
 *     Next streams a page's redirect in: its `NEXT_REDIRECT` marker and its `__next-page-redirect`
 *     meta refresh. The status is 200, said in the case line: the gate redirects from inside the
 *     streamed layout, after the status was sent, as Meridian's pages do, and a browser follows it.
 *     Neither answer holds the page's figure, a seeded team's slug or a seeded person's email;
 *   - the member's `/teams` answers 200 with the refused view, and the other team's slug appears
 *     nowhere in the body, the flight payload included.
 *
 * Run at the end of every phase, never beside another worker: it builds the console into
 * `../zz-stack-dashboard/.next`. Not a gate check — it needs Docker and a production build, and
 * runs for minutes. It writes nothing outside the throwaway database and that build output, and
 * stops every process and container it started by its own id, on success, failure and interrupt.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed, a build failed or the console did not start — the case and what was found.
 * Exit 2: Docker is not available or the console's checkout is missing — the skeleton could not
 *         run, and that is not a pass.
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import net from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Express, RequestHandler } from "express";
import type pg from "pg";

import { root } from "./deployment.ts";
import { EXPECTED, MEMBER, SUPERADMIN, TEAM_TWO, seedStatus, signIn } from "./schema/status-seed.ts";
import { withThrowawayDb } from "./schema/throwaway.ts";

const NAME = "skeleton";
const DONE = "skeleton: the built console signs a member and a superadmin in through the real gateway, draws the " +
  "seeded malformed-call rate on /platform, sends a signed-out request to sign in with its whole address, and shows " +
  "a member no other team on /teams: ok";
/** The reporting timezone the gateway cuts weeks in, and the seed with it. */
const TIMEZONE = "Asia/Singapore";
const CONSOLE = join(root, "..", "zz-stack-dashboard");
const NEXT = join(CONSOLE, "node_modules", ".bin", "next");
/** How long the built console has to answer its first request. */
const START_MS = 60_000;
/** A nested initiative address, its query included, so `next` must carry the whole of it. */
const DEEP = "/initiatives/plover-works/walking-skeleton/spec.md?section=scope";

class CaseFailure extends Error {}
function fail(step: string, detail: string): never {
  throw new CaseFailure(`${NAME}: FAILED at "${step}": ${detail}`);
}
const pass = (line: string): void => console.log(`  ok  ${line}`);

/** The last `n` lines of what a process printed. */
const tail = (out: string, n = 60): string => out.trim().split("\n").slice(-n).join("\n");

const inherited: NodeJS.ProcessEnv = { ...process.env };
/** The environment the console is built and served with, from what this process inherited and not
 *  the gateway's own: every assistant variable BLANKED, not deleted, as `pnpm verify` does, because `next start`
 *  loads `.env.local` and does not overwrite a variable already set. */
function consoleEnv(gateway: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...inherited, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", ZZ_GATEWAY: gateway, ZZ_DEV_PAT: "" };
  for (const k of ["ASSISTANT_PROVIDER", "ASSISTANT_API_KEY", "ASSISTANT_MODEL", "ASSISTANT_BASE_URL",
                   ...Object.keys(env).filter((x) => x.startsWith("ASSISTANT_"))]) env[k] = "";
  return env;
}

const freePort = (): Promise<number> => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});

/** What a page answered: its status, where it redirects, its whole body, and the body as a reader sees it. */
interface Page { status: number; location: string | null; body: string; text: string }

/** A page's text: React's `<!-- -->` separators, scripts and styles with their contents, and every tag
 *  removed, the common entities decoded and whitespace collapsed. A script's contents are the flight
 *  payload, which holds the figures whether or not the page drew them. */
function visible(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, "\"")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
}

/** The console process, while it runs: stopped by its own process group id. */
let consoleProc: ChildProcess | null = null;
function stopConsole(): void {
  if (consoleProc?.pid !== undefined && consoleProc.exitCode === null) {
    try { process.kill(-consoleProc.pid, "SIGTERM"); } catch { /* already gone */ }
  }
}
process.on("exit", stopConsole);
// A signal skips every `finally`, so the console and the database container are stopped here.
// COUPLED: `withThrowawayDb` in scripts/schema/throwaway.ts names its container by this process's id.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopConsole();
    try { execFileSync("docker", ["rm", "-f", "-v", `zz-schema-target-pg-${process.pid}`], { stdio: "ignore", timeout: 60_000 }); } catch { /* none started */ }
    process.exit(sig === "SIGINT" ? 130 : 143);
  });
}

/** Builds the platform, so the gateway mounted below is this tree's: `npm run build`, incremental. */
function buildPlatform(): void {
  const r = spawnSync("npm", ["run", "-s", "build"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) fail("the platform builds", `npm run build exited ${r.status ?? r.signal}:\n${tail(`${r.stdout}${r.stderr}`)}`);
  pass("the platform builds");
}

/** Builds the console the way `pnpm verify` does: `next build` in its own checkout, once. */
function buildConsole(env: NodeJS.ProcessEnv): void {
  const r = spawnSync(NEXT, ["build"], { cwd: CONSOLE, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) fail("the console builds", `next build exited ${r.status ?? r.signal}:\n${tail(`${r.stdout}${r.stderr}`)}`);
  pass("the console builds with ZZ_GATEWAY set to the gateway");
}

/** Serves the built console with `next start` on a free port and waits until it answers. */
async function serve(env: NodeJS.ProcessEnv): Promise<string> {
  const port = await freePort();
  const proc = spawn(NEXT, ["start", "-p", String(port), "-H", "127.0.0.1"], { cwd: CONSOLE, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  consoleProc = proc;
  let out = "";
  const keep = (d: Buffer): void => { out = (out + d.toString()).slice(-20_000); };
  proc.stdout!.on("data", keep);
  proc.stderr!.on("data", keep);
  const base = `http://127.0.0.1:${port}`;
  const until = Date.now() + START_MS;
  while (Date.now() < until) {
    if (proc.exitCode !== null) fail("the console starts", `next start exited ${proc.exitCode}:\n${tail(out)}`);
    try {
      const res = await fetch(`${base}/login`, { redirect: "manual", signal: AbortSignal.timeout(5_000) });
      await res.text();
      if (res.status < 500) {
        pass(`the built console answers at ${base} with NODE_ENV production`);
        return base;
      }
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  fail("the console starts", `no answer within ${START_MS / 1000} s:\n${tail(out)}`);
}

/** Stops the console and waits for it to go. */
async function stop(): Promise<void> {
  const proc = consoleProc;
  if (!proc || proc.exitCode !== null) return;
  const gone = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
  stopConsole();
  await Promise.race([gone, new Promise((r) => setTimeout(r, 10_000))]);
}

/** What a seeded reader could recognise as theirs: every team's slug and every person's email. */
interface Seeded { slugs: string[]; emails: string[] }

async function cases(base: string, cookies: Map<string, string>, seeded: Seeded): Promise<void> {
  const last = EXPECTED.weeks.find((w) => w.back === EXPECTED.last)!;
  const want = ["Malformed calls per 1,000", last.value!.toFixed(1), `${last.numerator} of ${last.denominator}`];
  /** `path`, carrying `secret` as the `zz_console` cookie, or no cookie when it is null. */
  const get = async (path: string, secret: string | null): Promise<Page> => {
    const res = await fetch(`${base}${path}`, {
      redirect: "manual", signal: AbortSignal.timeout(30_000),
      headers: secret === null ? {} : { cookie: `zz_console=${secret}` },
    });
    const body = await res.text();
    return { status: res.status, location: res.headers.get("location"), body, text: visible(body) };
  };
  const as = (email: string): string => cookies.get(email)!;
  const brief = (p: Page): string => `${p.status}${p.location ? ` to ${p.location}` : ""}: ${p.text.slice(0, 400)}`;

  for (const [who, email] of [["the member", MEMBER], ["the superadmin", SUPERADMIN]] as const) {
    const step = `/platform as ${who}`;
    const p = await get("/platform", as(email));
    const missing = want.filter((s) => !p.text.includes(s));
    if (p.status !== 200 || missing.length) fail(step, `answered ${brief(p)}${missing.length ? ` — without ${missing.join(", ")}` : ""}`);
    pass(`/platform as ${who} answers 200 with ${want.join(", ")}`);
  }

  for (const [who, email] of [["the member", MEMBER], ["the superadmin", SUPERADMIN]] as const) {
    const p = await get("/", as(email));
    if (p.status !== 200) fail(`/ as ${who}`, `answered ${brief(p)}`);
    pass(`/ as ${who} answers 200`);
  }

  const step = "/teams as the member";
  const teams = await get("/teams", as(MEMBER));
  if (teams.status !== 200 || !teams.body.includes("data-no-access")) fail(step, `answered ${brief(teams)}, not the refused view`);
  if (teams.body.includes(TEAM_TWO)) fail(step, `the body holds ${TEAM_TWO} at ${teams.body.indexOf(TEAM_TWO)}`);
  pass(`/teams as the member answers 200 with the refused view, and ${TEAM_TWO} is nowhere in its body`);

  // What no signed-out answer may hold, read in its whole body, the flight payload included.
  const withheld = ["Malformed calls", ...want.slice(1), ...seeded.slugs, ...seeded.emails];
  const unknown = randomBytes(24).toString("hex");
  for (const path of ["/platform", DEEP]) {
    const target = `/login?next=${encodeURIComponent(path)}`;
    for (const [who, secret] of [["no cookie", null], ["a cookie no session has", unknown]] as const) {
      const step = `${path} with ${who}`;
      const p = await get(path, secret);
      // Next streams a page's redirect twice: the marker its router follows, and a meta refresh for a
      // browser running no script. Every copy of each must name the target, decoded to the whole address.
      const markers = [...p.body.matchAll(/NEXT_REDIRECT;([a-z]+);([^;"\\]*);(\d+);/g)].map((m) => `${m[1]} ${m[2]} ${m[3]}`);
      const metas = [...p.body.matchAll(/<meta id="__next-page-redirect" http-equiv="refresh" content="\d+;url=([^"]*)"/g)]
        .map((m) => m[1].replace(/&amp;/g, "&"));
      if (!markers.length || markers.some((m) => m !== `replace ${target} 307`)) {
        fail(step, `answered ${p.status} with the redirect markers ${JSON.stringify(markers)}, not replace ${target} 307: ${brief(p)}`);
      }
      if (!metas.length || metas.some((m) => m !== target)) fail(step, `answered ${p.status} with the meta refreshes ${JSON.stringify(metas)}, not ${target}`);
      for (const address of [markers[0].split(" ")[1], metas[0]]) {
        const to = new URL(address, base);
        if (to.origin !== base || to.pathname !== "/login" || to.searchParams.get("next") !== path) {
          fail(step, `${address} decodes to ${to.href}, whose next is ${JSON.stringify(to.searchParams.get("next"))}, not ${path}`);
        }
      }
      const held = withheld.filter((s) => p.body.includes(s));
      if (held.length) fail(step, `the body holds ${held.join(", ")}`);
      pass(`${step} answers ${p.status} with Next's in-stream redirect to ${target}, as its marker and its meta refresh, ` +
           "and holds none of the page's figure, no seeded team's slug and no seeded person's email");
    }
  }
}

async function run(db: pg.Client, url: string): Promise<void> {
  await seedStatus(db, TIMEZONE);
  const seeded: Seeded = {
    slugs: (await db.query<{ slug: string }>("select slug from zz.team")).rows.map((r) => r.slug),
    emails: (await db.query<{ email: string }>("select email from zz.principal")).rows.map((r) => r.email),
  };
  const cookies = new Map<string, string>();
  for (const email of [MEMBER, SUPERADMIN]) cookies.set(email, await signIn(db, email));

  // `withThrowawayDb` ended the gateway's pool after migrating; a fresh one on the same container,
  // and the reporting timezone set before console/shared.js reads it at load.
  process.env.TEAM_DB_URL = url;
  process.env.ZZ_TZ = TIMEZONE;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  const load = (p: string) => import(pathToFileURL(join(root, p)).href);
  const express = (await import("express")).default;
  const dbModule = (await load("services/gateway/dist/db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await dbModule.initPlatformDb();
  const { identityMiddleware } = (await load("services/gateway/dist/identity.js")) as { identityMiddleware: () => RequestHandler };
  const { mountConsole } = (await load("services/gateway/dist/console.js")) as { mountConsole: (app: Express) => void };
  const app = express();
  // COUPLED: services/gateway/src/server.ts — the identity gate, the JSON parser, then the console.
  app.use(identityMiddleware());
  app.use(express.json({ limit: "20mb" }));
  mountConsole(app);
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const gateway = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  try {
    // Straight from the gateway first: a failure here is the gateway's, not the page's, and the read
    // warms the pool before the page's 5 s bound is counted.
    const step = "the gateway answers the member";
    const res = await fetch(`${gateway}/api/console/platform/status`, {
      headers: { cookie: `zz_console=${cookies.get(MEMBER)}` }, signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (res.status !== 200) fail(step, `/api/console/platform/status answered ${res.status}: ${text.slice(0, 400)}`);
    pass(`the gateway listens at ${gateway} and answers the member's status read`);

    const env = consoleEnv(gateway);
    buildConsole(env);
    const base = await serve(env);
    await cases(base, cookies, seeded);
  } finally {
    await stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await dbModule.platformDb().end().catch(() => undefined);
    delete process.env.TEAM_DB_URL;
    delete process.env.ZZ_TZ;
    delete process.env.ZZ_CATALOG_DIR;
  }
}

/** Why the skeleton cannot run here, or null when it can. Docker is asked with a bound: it can hang. */
function cannotRun(): string | null {
  if (!existsSync(join(CONSOLE, "package.json")) || !existsSync(NEXT)) {
    return `the console's checkout is not at ${CONSOLE} with its dependencies installed (pnpm install there)`;
  }
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 120_000 });
  } catch {
    return "Docker is not available or did not answer within two minutes";
  }
  return null;
}

async function main(): Promise<number> {
  const why = cannotRun();
  if (why) {
    console.error(`${NAME}: ${why} — the skeleton could not run, which is not a pass`);
    return 2;
  }
  let dbUrl = "";
  try {
    buildPlatform();
    await withThrowawayDb((db) => run(db, dbUrl), async (u) => { dbUrl = u; });
  } catch (err) {
    if (err instanceof Error && /Docker is not running/.test(err.message)) {
      console.error(`${NAME}: Docker is not available — the skeleton could not run, which is not a pass`);
      return 2;
    }
    console.error(err instanceof CaseFailure ? err.message : `${NAME}: ${String((err as Error)?.stack ?? err)}`);
    return 1;
  }
  console.log(DONE);
  return 0;
}

// Exited rather than left to drain: the gateway's modules may hold a timer or a listener open.
process.exit(await main());
