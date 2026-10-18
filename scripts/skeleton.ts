#!/usr/bin/env node
/**
 * skeleton.ts — the walking skeleton, end to end in one command: the console built and served as
 * production serves it, reading the real gateway, against an isolated database (AC-1.13).
 *
 *   npm run skeleton      # needs Docker, psql and ../zz-stack-dashboard with its dependencies installed
 *
 * It starts a throwaway PostgreSQL migrated by the real runner (`withThrowawayDb`), seeds the events
 * and people `scripts/schema/status-seed.ts` declares and the two teams `scripts/schema/isolation-seed.ts`
 * declares, and signs a member of the status seed's first team and a superadmin in through real
 * console session rows. The platform is built first (`npm run build`, incremental), and a real zz-core
 * is started on that database (`startCore`, scripts/skeleton-work.ts). The gateway is its own built
 * identity middleware, JSON parser, whole console API (`mountConsole`), its console acts and settings
 * (`mountConsoleWrite`, `mountSettings`), and its `/core/mcp` door's telemetry and relay to that
 * zz-core, mounted in this process in server.ts's order on a free port:
 * `dist/server.js` itself listens on port 8000 of every interface, which a run beside a deployment
 * or another stack cannot have. The console is built the way `pnpm verify` builds it, with `ZZ_GATEWAY` set to that
 * gateway, and served with `next start` on a free port with `NODE_ENV` production and no
 * development credential. What it establishes, first through the gateway and then through the console:
 *
 *   - the platform's status, releases, bugs and evaluation reads, each as the member and as the
 *     superadmin, answer 200 with every part in the state the seeds give it: on status `needs`
 *     complete, the eight measures, `records` and `doors` ok, `running` unavailable as `unrecorded`
 *     since no seed records a release, and `own` ok for the member and `no_team` for the superadmin;
 *     on releases `rows` ok and empty with no latest release; every part of bugs and evaluation ok.
 *     Status's malformed-call rate for the last whole week is the seed's, 8 of 125 and 64.0. The
 *     member's answers hold none of the isolation seed's second-team sentinels, matched in the raw
 *     body; the superadmin's bugs and evaluation hold that team's report title and protocol key, so
 *     the member's absence is not a seed that never arrived;
 *   - Usage and Knowledge health, each as the member and as the superadmin, answer 200 with every part
 *     ok. The member's name no team: no week's calls split by team, shelves only `own`, `shared` and
 *     `all`, `questions` null, and none of the second team's sentinels or any seeded slug in the raw
 *     body. The superadmin's split every week's calls into at most four team parts, the status seed's
 *     second team among them, and Knowledge health holds the second team's slug and its question that
 *     found nothing;
 *   - Teams, People and Audit answer the member 403 with exactly `{"error":"not permitted"}`, and the
 *     superadmin 200 holding the seeded teams, people and the second team's events;
 *   - Work, once the platform's reads are done (scripts/skeleton-work.ts, which says what it makes and
 *     what it expects): a record made through the door in the member's team, an initiative closed
 *     through the console's route with the outcome initiative_status reads back, and for the member and
 *     a superadmin acting for that team, Home's title and paired figures, Record's lead at its pace,
 *     Approvals' waiting count and the caller's own history, Initiatives' first page with zz-core's next
 *     moves, and the closures by outcome over Record's quarter, asked of work/query, agreeing with Record;
 *   - Phase 4's destinations, once Work's are done (scripts/skeleton-destinations.ts, which says what it
 *     makes and what it expects): the catalog's skills registered by the release's own registrar, a run
 *     of the member's through the door holding a refusal and a question that found nothing, and for the
 *     member and the acting superadmin, Activity's summary counting the refusal under its owner with
 *     every week's owners summing to its refused total, its log narrowed to refused calls, Knowledge's
 *     summary with the question, Runs with the run, Plugins with the required flag and install command,
 *     and Access with no secret in it; a person in two teams switched through the console's route,
 *     the next reads answering the other team; and a lesson of the member's;
 *   - the agent reads, once the built console has drawn every page (scripts/skeleton-agents.ts): for the member
 *     and the acting superadmin, the five reads on the core door, zz-core reaching back through the gateway's
 *     agent door (`CORE_PEERS` the loopback), each lead figure the one that person's page reads and draws.
 *
 *   Each read's other values are its own check's (`checks/console-platform-*.ts`);
 *
 * and through the console, each page read to the end of its stream and matched on its text with
 * markup, scripts and React's comments removed:
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
 *   - every page's lead as the gateway answers it just before the page is read, as the member and as the
 *     superadmin (Work's as the acting superadmin): Releases', Bugs', Evaluation's, Usage's and Knowledge
 *     health's first tile, Teams', People's and Audit's rows to the superadmin alone (`platformPages`), and
 *     Home's paired figures, Record's lead, Initiatives' and Approvals' tables, Knowledge's tiles,
 *     Activity's refused week, Runs' tiles, Plugins' table and Access's tokens (`workPages` and
 *     `destinationPages`). No page of the member's holds one of the second team's sentinels anywhere in its
 *     body, the flight payload included, nor a Work page or a page that names no team the status seed's
 *     second team;
 *   - the member's Teams, People, Audit and another team's page each answer 200 with the page that names
 *     nothing: the missing page, its words those of an address no page answers;
 *   - the removed `/teams`, `/teams/<slug>`, `/people` and `/settings`, as the member and as the superadmin, each
 *     the missing page with no redirect, its words that person's unknown address's (scripts/skeleton-addresses.ts);
 *   - the console's explore probe (../zz-stack-dashboard/scripts/explore-probe.ts) on this gateway as the
 *     member: every view tool and every prepared query the member is offered asked through ZZ Meridian's
 *     runner over the console's prepared collections, none of their answers holding the second team's
 *     words, and Status's last whole week through `/platform/query` and Activity's through `/work/query`
 *     agreeing with the pages read above; and as the acting superadmin, its control, whose answers do hold
 *     them.
 *
 * Run at the end of every phase, never beside another worker: it builds the console into
 * `../zz-stack-dashboard/.next`. Not a gate check — it needs Docker and a production build, and
 * runs for minutes. It writes nothing outside the throwaway database and that build output, and
 * stops every process and container it started by its own id, on success, failure and interrupt.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed, a build failed, or zz-core or the console did not start — the case and what was found.
 * Exit 2: Docker or psql is not available, or the console's checkout is missing — the skeleton could
 *         not run, and that is not a pass.
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import net from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Express, Request, RequestHandler } from "express";
import type pg from "pg";

import { root } from "./deployment.ts";
import { seedIsolation } from "./schema/isolation-seed.ts";
import { EXPECTED, MEMBER, SUPERADMIN, TEAM_TWO, seedStatus, signIn, weekStart } from "./schema/status-seed.ts";
import { withThrowawayDb } from "./schema/throwaway.ts";
import { nowhere, removedAddresses, words } from "./skeleton-addresses.ts";
import { agentReads } from "./skeleton-agents.ts";
import { destinationCases, destinationPages, probe } from "./skeleton-destinations.ts";
import { answer, count, lead, startCore, stopCore, workCases, workPages, type ConsolePage, type PageContext } from "./skeleton-work.ts";

const NAME = "skeleton";
const DONE = "skeleton: the real gateway answers the platform's four reads, Usage and Knowledge health to a member and a " +
  "superadmin in the seeds' states with none of another team's words and no team split or question to the member, refuses " +
  "the member Teams, People and Audit with one body and answers them to the superadmin, reads Work's Home, Record, Approvals, " +
  "Initiatives and a prepared query agreeing with Record to the member and an acting superadmin, closes an initiative through " +
  "the console's route to the outcome initiative_status reads back, reads them Activity with the refusal it made under its " +
  "owner, Knowledge with its question that found nothing, Runs with its run, Plugins with the required flag and install " +
  "command and Access with no secret, switches a person between two teams through the console's route and reads the other " +
  "team's answers, the built console signs both in through it, draws the " +
  "seeded malformed-call rate on /platform, sends a signed-out request to sign in with its whole address, draws every " +
  "page's lead as the gateway answers it with none of another team's words on a member's page, answers a member's Teams, " +
  "People and Audit as an address that names nothing, answers the removed /teams, /teams/<slug>, /people and /settings " +
  "to both as the missing page, and the console's explore probe asks every view and prepared " +
  "query as the member with none of the second team's words in any answer and two agreeing with their pages, and " +
  "platform_status, release_list, activity_refusals, run_summary and record_read on the core door answer the member and " +
  "the acting superadmin their pages' lead figures with none of another team's words: ok";
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
interface Page extends ConsolePage { location: string | null }

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

/** `path` of the built console at `base`, carrying `secret` as the `zz_console` cookie, or no cookie when it is null. */
async function read(base: string, path: string, secret: string | null): Promise<Page> {
  const res = await fetch(`${base}${path}`, {
    redirect: "manual", signal: AbortSignal.timeout(30_000),
    headers: secret === null ? {} : { cookie: `zz_console=${secret}` },
  });
  const body = await res.text();
  return { status: res.status, location: res.headers.get("location"), body, text: visible(body) };
}

/** The console process, while it runs: stopped by its own process group id. */
let consoleProc: ChildProcess | null = null;
function stopConsole(): void {
  if (consoleProc?.pid !== undefined && consoleProc.exitCode === null) {
    try { process.kill(-consoleProc.pid, "SIGTERM"); } catch { /* already gone */ }
  }
}
process.on("exit", () => { stopConsole(); stopCore(); });
// A signal skips every `finally`, so the console, zz-core and the database container are stopped here.
// COUPLED: `withThrowawayDb` in scripts/schema/throwaway.ts names its container by this process's id.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopConsole();
    stopCore();
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

type Isolation = Awaited<ReturnType<typeof seedIsolation>>;
type Who = "the member" | "the superadmin";
/** A part as every platform read answers one. */
type Part = { state: "ok"; data: unknown } | { state: "unavailable"; reason: string };

/** What a part answered, as a case line says it: `ok`, or `unavailable` and why. */
const stateOf = (p: Part | undefined): string => p === undefined ? "missing" : p.state === "ok" ? "ok" : `unavailable (${p.reason})`;

/** A JSON answer that is an object, narrowed rather than asserted. */
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** What is wrong with `a` where each of `names` must be an ok part. */
const notOk = (a: Record<string, unknown>, names: string[]): string[] =>
  names.filter((k) => stateOf(a[k] as Part) !== "ok").map((k) => `${k} is ${stateOf(a[k] as Part)}, not ok`);

/** How many team parts the superadmin's calls by week may draw in a week: three teams and `Other`. */
const TEAM_PARTS = 4;

/** Each read's parts in the states the seeds give them, as the person asking: what is wrong with `a`,
 *  each a phrase, and the states the case line names. A `teamless` read names no team to the member:
 *  no seeded slug is anywhere in the member's raw body. */
const READS: { path: string; teamless?: true; parts: (a: Record<string, unknown>, who: Who) => { wrong: string[]; said: string } }[] = [
  { path: "/api/console/platform/status", parts: (a, who) => {
    const wrong: string[] = [];
    type Last = { figure: { value: number | null }; numerator: number | null; denominator: number | null } | null;
    const parts = a as { needs?: { state?: string }; measures?: { key: string; last: Last }[] } & Record<string, Part>;
    const want: Record<string, string> = {
      records: "ok", doors: "ok", running: "unavailable (unrecorded)", own: who === "the member" ? "ok" : "unavailable (no_team)",
    };
    for (const [k, v] of Object.entries(want)) if (stateOf(parts[k]) !== v) wrong.push(`${k} is ${stateOf(parts[k])}, not ${v}`);
    if (parts.needs?.state !== "complete") wrong.push(`needs is ${parts.needs?.state ?? "missing"}, not complete`);
    if (parts.measures?.length !== 8) wrong.push(`it answers ${parts.measures?.length ?? "no"} measures, not 8`);
    const last = EXPECTED.weeks.find((w) => w.back === EXPECTED.last)!;
    const got = parts.measures?.find((m) => m.key === "malformed_per_1000")?.last;
    if (got?.figure.value !== last.value || got.numerator !== last.numerator || got.denominator !== last.denominator) {
      wrong.push(`the last whole week's malformed-call rate is ${JSON.stringify(got ?? null)}, not ${last.numerator} of ${last.denominator}, ${last.value}`);
    }
    return { wrong, said: `needs complete, eight measures, the last whole week's malformed-call rate ${last.numerator} of ` +
      `${last.denominator} and ${last.value!.toFixed(1)}, ${Object.entries(want).map(([k, v]) => `${k} ${v}`).join(", ")}` };
  } },
  { path: "/api/console/platform/releases", parts: (a) => {
    const parts = a as { tiles?: { latest?: unknown }; rows?: Part };
    const rows = parts.rows?.state === "ok" ? parts.rows.data as { rows: unknown[]; total: number } : null;
    const wrong = rows === null ? [`rows is ${stateOf(parts.rows)}, not ok`]
      : rows.total !== 0 || rows.rows.length ? [`rows holds ${rows.total} releases, though no seed records one`] : [];
    if (parts.tiles?.latest !== null) wrong.push(`the latest release is ${JSON.stringify(parts.tiles?.latest)}, not none`);
    return { wrong, said: "rows ok and empty and no latest release, as no seed records one" };
  } },
  { path: "/api/console/platform/bugs", parts: (a) => {
    const names = ["counts", "queue"];
    return { wrong: notOk(a, names), said: `${names.join(" and ")} ok` };
  } },
  { path: "/api/console/platform/evaluation", parts: (a) => {
    const names = ["plugins", "history", "byDecision", "byOwner", "waiting"];
    return { wrong: notOk(a, names), said: `${names.join(", ")} ok` };
  } },
  { path: "/api/console/platform/usage", teamless: true, parts: (a, who) => {
    const names = ["tiles", "callsByWeek", "traffic", "refusals", "followup", "tools", "rhythm", "mostUsed", "perApproval", "modelCalls"];
    const wrong = notOk(a, names);
    const by = a.callsByWeek as Part;
    const weeks = by?.state === "ok" ? (by.data as { weeks: { parts: { label: string }[] | null }[] }).weeks : [];
    if (who === "the member") {
      const split = weeks.filter((w) => w.parts !== null).length;
      if (split) wrong.push(`${split} of its weeks split the calls by team`);
      return { wrong, said: `${names.join(", ")} ok, and no week's calls split by team` };
    }
    const over = weeks.filter((w) => w.parts === null || w.parts.length > TEAM_PARTS).length;
    if (!weeks.length || over) wrong.push(`${over} of its ${weeks.length} weeks draw no team parts or more than ${TEAM_PARTS}`);
    if (!weeks.some((w) => w.parts?.some((p) => p.label === TEAM_TWO))) wrong.push(`no week names ${TEAM_TWO} among its parts`);
    return { wrong, said: `${names.join(", ")} ok, every week's calls split into at most ${TEAM_PARTS} parts, ${TEAM_TWO} among them` };
  } },
  { path: "/api/console/platform/knowledge", teamless: true, parts: (a, who) => {
    const names = ["tiles", "shelves", "made", "searches", "cohorts", "byKind"];
    const wrong = notOk(a, names);
    const shelves = a.shelves as Part;
    const rows = shelves?.state === "ok" ? (shelves.data as { rows: { shelf: string }[] }).rows.map((r) => r.shelf) : [];
    if (who === "the member") {
      if (a.questions !== null) wrong.push(`questions is ${a.questions === undefined ? "missing" : stateOf(a.questions as Part)}, not null`);
      const named = rows.filter((s) => !["own", "shared", "all"].includes(s));
      if (named.length) wrong.push(`its shelves name ${named.join(", ")}, not only own, shared and all`);
      return { wrong, said: `${names.join(", ")} ok, its shelves own, shared and all, and no questions` };
    }
    const questions = a.questions === null ? "null" : stateOf(a.questions as Part);
    if (questions !== "ok") wrong.push(`questions is ${questions}, not ok`);
    return { wrong, said: `${names.join(", ")} and questions ok, its shelves named by slug` };
  } },
];

/** What a gateway route answered `email`: its status and its raw body. */
async function ask(gateway: string, path: string, cookies: Map<string, string>, email: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${gateway}${path}`, {
    headers: { cookie: `zz_console=${cookies.get(email)}` }, signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, body: await res.text() };
}

/** The platform's reads straight from the gateway, as the member and as the superadmin: each part in
 *  its seeded state, none of the second team's sentinels in the member's raw body and no seeded slug
 *  in a teamless one, and the superadmin's bugs, evaluation and Knowledge health holding that team's
 *  own words. */
async function reads(gateway: string, cookies: Map<string, string>, isolation: Isolation, seeded: Seeded): Promise<void> {
  const sentinels = Object.entries(isolation.sentinels);
  /** What the superadmin's answer to a read must hold, so the member's absence is not a missing seed. */
  const held: Record<string, (keyof Isolation["sentinels"])[]> = {
    "/api/console/platform/bugs": ["bugTitle"], "/api/console/platform/evaluation": ["protocolKey", "pattern"],
    "/api/console/platform/knowledge": ["question", "slug"],
  };
  for (const { path, teamless, parts } of READS) {
    for (const [who, email] of [["the member", MEMBER], ["the superadmin", SUPERADMIN]] as const) {
      const step = `${path} as ${who}`;
      const { status, body } = await ask(gateway, path, cookies, email);
      if (status !== 200) fail(step, `answered ${status}: ${body.slice(0, 400)}`);
      const answer: unknown = JSON.parse(body);
      if (!isRecord(answer)) fail(step, `answered something other than an object: ${body.slice(0, 200)}`);
      const { wrong, said } = parts(answer, who);
      if (wrong.length) fail(step, wrong.join("; "));
      if (who === "the member") {
        const found = sentinels.filter(([, s]) => body.includes(s));
        if (found.length) fail(step, `the body holds the second team's ${found.map(([f, s]) => `${f} at ${body.indexOf(s)}`).join(", ")}`);
        const slugs = teamless ? seeded.slugs.filter((s) => body.includes(s)) : [];
        if (slugs.length) fail(step, `the body names the teams ${slugs.map((s) => `${s} at ${body.indexOf(s)}`).join(", ")}`);
        pass(`${step} answers 200 with ${said}, and holds none of the second team's ${sentinels.length} sentinels` +
          (teamless ? ` and none of the ${seeded.slugs.length} seeded teams' slugs` : ""));
      } else {
        const missing = (held[path] ?? []).filter((f) => !body.includes(isolation.sentinels[f]));
        if (missing.length) fail(step, `the body does not hold the second team's ${missing.join(", ")}`);
        pass(`${step} answers 200 with ${said}` +
          (held[path] ? `, and holds the second team's ${held[path].join(" and ")} as written` : ""));
      }
    }
  }
}

/** The one body every read refused to a member answers. */
const REFUSED = JSON.stringify({ error: "not permitted" });

/** Teams, People and Audit straight from the gateway: the member refused 403 with `REFUSED` and not a
 *  byte more, and the superadmin answered 200 with what the seeds wrote, so the refusal is not a read
 *  that found nothing. Each answer's other values are its own check's. */
async function refused(gateway: string, cookies: Map<string, string>, isolation: Isolation): Promise<void> {
  const reads: { name: string; path: string; holds: [string, string][] }[] = [
    { name: "Teams", path: "/api/console/teams?limit=100", holds: [["the second team's slug", isolation.sentinels.slug], [TEAM_TWO, TEAM_TWO]] },
    { name: "People", path: "/api/console/people?limit=100", holds: [[isolation.both, isolation.both], [MEMBER, MEMBER]] },
    { name: "Audit", path: "/api/console/platform/audit?filter=all&limit=100", holds: [["the second team's slug", isolation.sentinels.slug]] },
  ];
  for (const { name, path, holds } of reads) {
    const mine = await ask(gateway, path, cookies, MEMBER);
    if (mine.status !== 403 || mine.body !== REFUSED) fail(`${path} as the member`, `${name} answered ${mine.status} ${mine.body.slice(0, 400)}, not 403 ${REFUSED}`);
    pass(`${path} as the member answers 403 ${REFUSED} and nothing else: ${name} is refused`);
    const theirs = await ask(gateway, path, cookies, SUPERADMIN);
    if (theirs.status !== 200) fail(`${path} as the superadmin`, `${name} answered ${theirs.status}: ${theirs.body.slice(0, 400)}`);
    const answer: unknown = JSON.parse(theirs.body);
    if (!isRecord(answer)) fail(`${path} as the superadmin`, `${name} answered something other than an object: ${theirs.body.slice(0, 200)}`);
    const missing = holds.filter(([, s]) => !theirs.body.includes(s)).map(([what]) => what);
    if (missing.length) fail(`${path} as the superadmin`, `${name} does not hold ${missing.join(" or ")}`);
    pass(`${path} as the superadmin answers 200 with ${name}, holding ${holds.map(([what]) => what).join(" and ")}`);
  }
}

async function cases(base: string, cookies: Map<string, string>, seeded: Seeded): Promise<void> {
  const last = EXPECTED.weeks.find((w) => w.back === EXPECTED.last)!;
  const want = ["Malformed calls per 1,000", last.value!.toFixed(1), `${last.numerator} of ${last.denominator}`];
  const get = (path: string, secret: string | null): Promise<Page> => read(base, path, secret);
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

/**
 * Platform's pages from the built console, as the member and as the superadmin, each lead against the gateway's
 * answer read just before it; Teams, People and Audit the superadmin's, and to the member each of those and another
 * team's page the page that names nothing. COUPLED: the tiles' labels in
 * ../zz-stack-dashboard/src/views/pages/platform-*.tsx, and the missing page's `data-missing-page` in
 * src/views/no-access.tsx.
 */
async function platformPages(ctx: PageContext, isolation: Isolation): Promise<void> {
  for (const [who, email] of [["the member", MEMBER], ["the superadmin", SUPERADMIN]] as const) {
    const json = async <T>(path: string): Promise<T> => (await answer(ctx, `${path} for the page, as ${who}`, email, path)) as T;
    const ok = <T>(path: string, p: Part): T => (p.state === "ok" ? p.data as T : fail(`${path} for the page, as ${who}`, `it is ${stateOf(p)}`));
    // Its figure is the seed's, read in `cases`; here, that nothing of another team's is in the member's.
    await lead(ctx, who, email, "/platform", "data-figures", ["Malformed calls per 1,000"], false);
    const releases = await json<{ tiles: { releases: number; latest: { version: string } | null } }>("/api/console/platform/releases");
    await lead(ctx, who, email, "/platform/releases", 'data-protagonist="Releases"',
      [`Releases ${count(releases.tiles.releases)}`, `Latest release ${releases.tiles.latest?.version ?? "None recorded"}`], false);
    const { open } = ok<{ open: number }>("/api/console/platform/bugs", (await json<{ counts: Part }>("/api/console/platform/bugs")).counts);
    await lead(ctx, who, email, "/platform/bugs", 'data-protagonist="Queue"', [`Open ${count(open)}`], false);
    const { waiting } = (await json<{ tiles: { waiting: number } }>("/api/console/platform/evaluation")).tiles;
    await lead(ctx, who, email, "/platform/evaluation", 'data-figures="read"', [`Findings waiting ${count(waiting)}`], false);
    const calls = ok<{ calls: { last: { figure: { value: number | null } } } }>("/api/console/platform/usage", (await json<{ tiles: Part }>("/api/console/platform/usage")).tiles).calls.last.figure.value;
    if (calls === null) fail(`/api/console/platform/usage for the page, as ${who}`, "last week's calls have no value, though the status seed records them");
    await lead(ctx, who, email, "/platform/usage", 'data-figures="read"', [`Calls ${count(calls)}`]);
    const { standing } = ok<{ standing: number }>("/api/console/platform/knowledge", (await json<{ tiles: Part }>("/api/console/platform/knowledge")).tiles);
    await lead(ctx, who, email, "/platform/knowledge", 'data-figures="read"', [`Lessons adopted ${count(standing)}`]);
  }
  await lead(ctx, "the superadmin", SUPERADMIN, "/platform/teams", 'data-protagonist="Teams"', [TEAM_TWO, isolation.sentinels.slug]);
  await lead(ctx, "the superadmin", SUPERADMIN, "/platform/people", 'data-protagonist="People"', [MEMBER, isolation.both]);
  // The feed draws each act as its actor and the rest of the gateway's sentence (`feedEvent` in the console).
  const acts = (await answer(ctx, "/api/console/platform/audit for the page", SUPERADMIN, "/api/console/platform/audit?filter=administration&limit=10&offset=0"))
    .rows as { actor: string | null; sentence: string | null }[];
  const said = acts.slice(0, 3).flatMap((a) => (a.sentence && a.actor && a.sentence.startsWith(`${a.actor} `) ? [a.sentence.slice(a.actor.length + 1)] : []));
  await lead(ctx, "the superadmin", SUPERADMIN, "/platform/audit", 'data-feed="read"', said.length ? said : ["Administration"]);

  const secret = ctx.cookies.get(MEMBER)!;
  // An address no page answers, in each workspace and in none: a refused page reads as one of them.
  const unknown = await nowhere(ctx, secret);
  for (const path of ["/platform/teams", "/platform/people", "/platform/audit", `/platform/teams/${isolation.sentinels.slug}`]) {
    const step = `the built console's ${path} as the member`;
    const p = await ctx.page(path, secret);
    const held = [...ctx.withheld, ctx.slug].filter((s) => p.body.includes(s) && !path.includes(s));
    if (p.status !== 200 || !p.body.includes("data-missing-page") || !unknown.includes(words(p)) || held.length) {
      fail(step, `answered ${p.status}${held.length ? `, holding ${held.join(", ")}` : ""}, not the page an address that names nothing draws: ${p.text.slice(0, 400)}`);
    }
    pass(`${step} answers 200 with the page that names nothing, its words those of an address no page answers, and none of the ` +
         `${ctx.withheld.length + 1} words of another team's in its body`);
  }
}

async function run(db: pg.Client, url: string): Promise<void> {
  await seedStatus(db, TIMEZONE);
  // Its people and slugs are its own, its one tool call per team is maintenance, and its planted events sit in the running week, so the status seed's figure stands.
  const planted = Date.now();
  const isolation = await seedIsolation(db, planted);
  const seeded: Seeded = {
    slugs: (await db.query<{ slug: string }>("select slug from zz.team")).rows.map((r) => r.slug),
    emails: (await db.query<{ email: string }>("select email from zz.principal")).rows.map((r) => r.email),
  };
  const cookies = new Map<string, string>();
  for (const email of [MEMBER, SUPERADMIN]) cookies.set(email, await signIn(db, email));

  // `withThrowawayDb` ended the gateway's pool after migrating; a fresh one on the same container,
  // and the reporting timezone set before console/shared.js reads it at load. The console's acts and
  // next moves reach zz-core through CORE_MCP_URL, and zz-core's agent reads the gateway, listening first.
  const server: Server = createServer().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const gateway = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const core = await startCore(url, gateway, fail);
  process.env.CORE_MCP_URL = core;
  process.env.TEAM_DB_URL = url;
  process.env.ZZ_TZ = TIMEZONE;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  process.env.ZZ_SKILLS_DIR = join(root, "skills");
  process.env.GATEWAY_PUBLIC_URL = "https://gateway.skeleton.example.test";
  process.env.CORE_PEERS = "localhost";
  const load = (p: string) => import(pathToFileURL(join(root, p)).href);
  const express = (await import("express")).default;
  const dbModule = (await load("services/gateway/dist/db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await dbModule.initPlatformDb();
  const { identityMiddleware } = (await load("services/gateway/dist/identity.js")) as { identityMiddleware: () => RequestHandler };
  const { mountConsole } = (await load("services/gateway/dist/console.js")) as { mountConsole: (app: Express) => void };
  const { mountConsoleWrite } = (await load("services/gateway/dist/console-write.js")) as { mountConsoleWrite: (app: Express) => void };
  const { mountSettings } = (await load("services/gateway/dist/settings.js")) as { mountSettings: (app: Express, deps: unknown) => void };
  const credentials = (await load("services/gateway/dist/credentials.js")) as Record<string, unknown>;
  const { toolCallTelemetry, doorSurface } = (await load("services/gateway/dist/tool-telemetry.js")) as
    { toolCallTelemetry: (surface: (req: Request) => string) => RequestHandler; doorSurface: (url: string) => string };
  const { passThrough } = (await load("services/gateway/dist/relay.js")) as
    { passThrough: (url: string, what: string, refusal: string) => RequestHandler };
  const { mountAgentDoor } = (await load("services/gateway/dist/agent-door.js")) as { mountAgentDoor: (app: Express) => void };
  const app = express();
  // COUPLED: services/gateway/src/server.ts — the agent door outside the identity gate, the gate, the JSON
  // parser, the console's reads, its acts and its settings, then the telemetry on the door and its relay to zz-core.
  mountAgentDoor(app);
  app.use(identityMiddleware());
  app.use(express.json({ limit: "20mb" }));
  mountConsole(app);
  mountConsoleWrite(app);
  mountSettings(app, { myAccessTokensFor: credentials.myAccessTokensFor, issueMyAccessTokenFor: credentials.issueMyAccessTokenFor,
                       revokeMyAccessTokenFor: credentials.revokeMyAccessTokenFor });
  app.use(["/core/mcp"], toolCallTelemetry((req) => doorSurface(req.originalUrl)));
  app.all("/core/mcp", passThrough(core, "core proxy", "zz-core is not reachable"));
  server.on("request", app);

  try {
    // A read cuts at its whole second, so none begins inside the second the planted events are dated in.
    await new Promise((r) => setTimeout(r, Math.max(0, Math.floor(planted / 1000) * 1000 + 1000 - Date.now())));
    // Straight from the gateway first: a failure here is the gateway's, not the page's, and the read
    // warms the pool before the page's 5 s bound is counted.
    const step = "the gateway answers the member";
    const res = await fetch(`${gateway}/api/console/platform/status`, {
      headers: { cookie: `zz_console=${cookies.get(MEMBER)}` }, signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (res.status !== 200) fail(step, `/api/console/platform/status answered ${res.status}: ${text.slice(0, 400)}`);
    pass(`the gateway listens at ${gateway} and answers the member's status read`);
    await reads(gateway, cookies, isolation, seeded);
    await refused(gateway, cookies, isolation);
    // Work and Phase 4's destinations last of the gateway's: their record is written now, in the running
    // week, so every read above saw the seeds alone. Their people sign in, so no signed-out page may hold
    // them either.
    const work = await workCases({ sql: db, gateway, member: MEMBER, memberCookie: cookies.get(MEMBER)!, fail, pass });
    seeded.emails.push(work.acting);
    // The release's registrar reaches the throwaway database by its own address, through this machine's psql.
    const made = await destinationCases({ sql: db, gateway, psql: `psql ${url}`, member: MEMBER, acting: work.acting, cookies: work.cookies,
                                          tokens: work.tokens, isolation, fail, pass });

    const env = consoleEnv(gateway);
    buildConsole(env);
    const base = await serve(env);
    await cases(base, cookies, seeded);
    const ctx: PageContext = { gateway, page: (path, secret) => read(base, path, secret), cookies: new Map([...cookies, ...work.cookies]),
                               member: MEMBER, withheld: Object.values(isolation.sentinels), slug: TEAM_TWO, fail, pass };
    await platformPages(ctx, isolation);
    await removedAddresses(ctx, [["the member", MEMBER], ["the superadmin", SUPERADMIN]], isolation.sentinels.slug);
    const readers: [string, string][] = [["the member", MEMBER], ["the acting superadmin", work.acting]];
    await workPages(ctx, readers);
    const drawn = await destinationPages(ctx, readers, made);
    await agentReads({ ...ctx, sql: db, tokens: work.tokens, timezone: TIMEZONE }, readers);
    // The last whole week's Monday, as both routes key a week: what /platform and /activity drew is that week's.
    const week = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(new Date(weekStart(Date.now(), 1, TIMEZONE)));
    const last = EXPECTED.weeks.find((w) => w.back === EXPECTED.last)!;
    const t = `/initiatives/${work.team}/${work.waiting}`;
    const input = {
      sentinels: [...Object.values(isolation.sentinels), TEAM_TWO],
      addresses: [t, `${t}/spec.md`, made.lesson, `/plugins/${made.plugin}`, `/plugins/${made.plugin}/sdlc-method`,
                  `/platform/bugs/${isolation.two.bugs.open}`, `/platform/teams/${isolation.sentinels.slug}`].map((address) => ({ address, exists: true }))
        .concat({ address: "/platform/releases/0.0.0", exists: false }),
      agree: { platform: { week, malformed: last.numerator, calls: last.denominator, per1000: last.value! }, work: { week, ...drawn } },
    };
    await probe(ctx, "the member", cookies.get(MEMBER)!, input);
    await probe(ctx, "the acting superadmin", work.cookies.get(work.acting)!, input, true);
  } finally {
    await stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await dbModule.platformDb().end().catch(() => undefined);
    stopCore();
    delete process.env.CORE_MCP_URL;
    delete process.env.TEAM_DB_URL;
    delete process.env.ZZ_TZ;
    delete process.env.ZZ_CATALOG_DIR;
    delete process.env.ZZ_SKILLS_DIR;
    delete process.env.GATEWAY_PUBLIC_URL;
    delete process.env.CORE_PEERS;
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
  // The release's registrar writes the skills through psql (scripts/skeleton-destinations.ts).
  if (spawnSync("psql", ["--version"], { stdio: "ignore" }).status !== 0) return "psql is not on the PATH";
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
