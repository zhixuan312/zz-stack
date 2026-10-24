#!/usr/bin/env node
/**
 * checks/console-platform-audit.ts — the superadmin's Audit: recorded administration as sentences and
 * the latest events as metadata, through the gateway's own identity gate and route on a real database
 * (AC-4.5).
 *
 *   node checks/console-platform-audit.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL migrated by the real runner, seeds what
 * `scripts/schema/audit-seed.ts` declares, and serves the gateway's built identity middleware and
 * `services/gateway/dist/console/platform-audit.js` from this process, signed in with real console
 * session cookies. What it establishes, against the seed's written values:
 *
 *   - `filter=administration`, the default, answers exactly the administration kinds of reconciliation
 *     19, newest first with the id breaking a tie, each with its sentence: a maintenance act labelled as
 *     maintenance, an act by an actor nobody recorded reading `Someone not recorded`, a kind no template
 *     names said by the fallback, and `admin.list_oauth_clients` left out;
 *   - `filter=all` answers every event but page views, a subject only for the kinds whose subject is a
 *     slug, an email, an id or a tool, and no sentence for any other kind;
 *   - the ceiling: unfiltered, the latest 500 events and a total of 500, a page never reading past it;
 *     a kind, a team and an instant filter before it, so each reaches an event older than the latest 500;
 *   - no answer holds any text the seed planted in a `title`, `label`, `filename`, `reason`, `details`,
 *     `detail.detail`, a refusal or a search's question, and the module's SQL selects no `detail` but
 *     the allowed keys and never the `refusal` column;
 *   - a deleted report is named by what the record holds of it, the day its `bug_report` event was
 *     filed, whatever impact or surface that event records, and as one the record does not name where
 *     there is no such event; never by the title its deletion or its filing recorded, and never by an
 *     impact or a surface, which zz-core's filing does not record;
 *   - no sentence names a channel but `in the console`, and only for a console write;
 *   - a member is refused 403 with the fixed body before anything is read, whatever they ask; no
 *     session is 401 and a member's token 403; an unknown filter, a malformed instant or kind, a
 *     repeated parameter or a page out of range is 400; a query that fails is 500 with nothing partial;
 *   - every answer agrees in shape with the console's fake one, key set by key set;
 *   - no read wrote an event.
 *
 * The only database it touches is the one it started.
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

import type { Express, RequestHandler } from "express";
import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import {
  BULK, EVENTS, MEMBER, SENTINEL, SUPERADMIN, TEAM_ONE, TEAM_TWO, seedAudit, type SeededAudit,
} from "../scripts/schema/audit-seed.ts";
import { signIn } from "../scripts/schema/status-seed.ts";
import { withThrowawayDb } from "../scripts/schema/throwaway.ts";
import { shapeDiffs } from "../scripts/schema/shape-diffs.ts";

const NAME = "console-platform-audit";
const DONE = "console-platform-audit: recorded administration is answered as sentences and the latest 500 events as " +
  "metadata, filtered before the ceiling, to the superadmin alone, with no planted text and no channel but the " +
  "console, in the fake's shapes: ok";
const TIMEZONE = "Pacific/Auckland";
/** COUPLED: the fake answer in the console's checkout, `../zz-stack-dashboard` here and in CI. */
const FAKE = join(root, "..", "zz-stack-dashboard", "scripts", "fake-gateway", "platform-audit.ts");
const MODULE = join(root, "services", "gateway", "src", "console", "platform-audit.ts");

const ROW_KEYS = ["actor", "at", "id", "inConsole", "kind", "ok", "origin", "refusalOwner", "sentence", "subject", "team"];
const ANSWER_KEYS = ["ceiling", "filter", "meta", "notRecorded", "rows", "total"];
const NOT_RECORDED = ["knowledge reindex", "knowledge reconcile", "client setup", "plugin registration", "release record"];
const ADMINISTRATION_POPULATION = "recorded acts of administration";
const ALL_POPULATION = "recorded events, page views left out";
const BAD_PAGE = "limit must be a whole number from 1 to 100, and offset one from 0";
/** The detail keys a sentence may read, and `via` for whether an act was made in the console. */
const ALLOWED_DETAIL = ["role", "status", "reactivated", "from", "team", "owner", "patsRevoked", "sessionsRevoked", "enrolmentsSpent", "via",
  // A deleted report's filing: the report it filed.
  "bug"];
/** The day a report was filed as the gateway's sentence says it, in the check's time zone. */
const FILED_DAY = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, day: "numeric", month: "short", year: "numeric" });
/** Words that would name the door an act came through; only `in the console` may. */
const CHANNEL = /mcp-oauth|\bMCP\b|OAuth|\bvia\b|\bweb\b|script/;

class CaseFailure extends Error {}
function fail(step: string, detail: string): never {
  throw new CaseFailure(`${NAME}: FAILED at "${step}": ${detail}`);
}
const pass = (line: string): void => console.log(`  ok  ${line}`);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const keys = (v: unknown): string => (isObj(v) ? Object.keys(v).sort().join(",") : `not an object: ${JSON.stringify(v)}`);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(sortDeep(a)) === JSON.stringify(sortDeep(b));

/** A value with every object's keys in order, so two answers compare by content alone. */
function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
  return v;
}

interface Answer { status: number; body: Obj; text: string }

/** What each seeded event's row must read, newest first, from the seed's written values. */
function expectedRows(seeded: SeededAudit): Obj[] {
  return [...EVENTS].reverse().map((e) => ({
    id: seeded.ids.get(e.key), at: iso(seeded.at.get(e.key)!),
    actor: e.actor === "super" ? SUPERADMIN : e.actor === "member" ? MEMBER : null,
    team: e.team === "one" ? TEAM_ONE : e.team === "two" ? TEAM_TWO : null,
    kind: e.kind, subject: e.expect.subject, ok: e.call?.ok ?? null, refusalOwner: e.call?.owner ?? null,
    origin: e.origin ?? "work", inConsole: e.expect.inConsole, sentence: e.expect.sentence,
  }));
}

/** An answer's rows, or a failure naming what came instead. */
function rowsOf(step: string, a: Answer): Obj[] {
  if (a.status !== 200 || keys(a.body) !== ANSWER_KEYS.join() || !Array.isArray(a.body.rows)) {
    fail(step, `answered ${a.status}: ${a.text.slice(0, 400)}`);
  }
  return a.body.rows as Obj[];
}

/** The keys of the seed's rows a list of answered rows names, for a readable failure. */
const named = (rows: Obj[], seeded: SeededAudit): string =>
  rows.map((r) => [...seeded.ids].find(([, id]) => id === r.id)?.[0] ?? `${String(r.kind)}@${String(r.at)}`).join(", ");

function compareRows(step: string, got: Obj[], want: Obj[], seeded: SeededAudit): void {
  if (got.length !== want.length) fail(step, `${got.length} rows (${named(got, seeded)}), not ${want.length} (${named(want, seeded)})`);
  for (const [i, r] of got.entries()) {
    if (keys(r) !== ROW_KEYS.join()) fail(step, `row ${i} has keys ${keys(r)}, not ${ROW_KEYS.join(",")}`);
    if (!same(r, want[i])) fail(step, `row ${i} reads ${JSON.stringify(r)}, not ${JSON.stringify(want[i])}`);
  }
}

async function administrationCases(seeded: SeededAudit, as: (q: string) => Promise<Answer>): Promise<Answer> {
  let step = "administration, by default";
  const expected = expectedRows(seeded).filter((r) => r.sentence !== null);
  const a = await as("?limit=100");
  compareRows(step, rowsOf(step, a), expected, seeded);
  if (a.body.filter !== "administration" || a.body.ceiling !== 500 || a.body.total !== 21 || !same(a.body.notRecorded, NOT_RECORDED)) {
    fail(step, `filter ${String(a.body.filter)}, ceiling ${String(a.body.ceiling)}, total ${String(a.body.total)}, ` +
      `notRecorded ${JSON.stringify(a.body.notRecorded)}`);
  }
  const meta = a.body.meta as Obj;
  const from = iso(seeded.first);
  if (keys(meta) !== "asOf,builtAt,cacheHit,coverageFrom,observedAt,period,population,revision,scope,sourceRevision,timezone" || meta.scope !== "platform-admin"
      || meta.timezone !== TIMEZONE || meta.population !== ADMINISTRATION_POPULATION || meta.coverageFrom !== from
      || !isObj(meta.period) || meta.period.from !== from || meta.period.to !== meta.asOf) {
    fail(step, `meta reads ${JSON.stringify(meta)}`);
  }
  pass("the 21 acts of administration of reconciliation 19 newest first, the console's close before the agent's at " +
       "the same instant by its id, each with its written sentence, admin.list_oauth_clients left out, and the five acts " +
       "that leave no event named");

  step = "the acts the sentences must say plainly";
  const rows = a.body.rows as Obj[];
  const maintenance = rows.filter((r) => r.origin === "platform");
  if (maintenance.length !== 1 || !String(maintenance[0].sentence).includes(", as platform maintenance")) {
    fail(step, `the maintenance acts read ${JSON.stringify(maintenance)}`);
  }
  const nobody = rows.filter((r) => r.actor === null);
  if (nobody.length !== 1 || !String(nobody[0].sentence).startsWith("Someone not recorded ")) {
    fail(step, `the acts with no actor read ${JSON.stringify(nobody)}`);
  }
  pass("the act made by maintenance says so from its origin, and the act nobody recorded the actor of reads `Someone not recorded`");

  step = "the default page";
  const first = await as("");
  if (!same(rowsOf(step, first), expected.slice(0, 10)) || first.body.total !== 21) {
    fail(step, `no parameters answered ${first.text.slice(0, 300)}`);
  }
  const paged = await as("?filter=administration&limit=3&offset=2");
  if (!same(rowsOf(step, paged), expected.slice(2, 5)) || paged.body.total !== 21) fail(step, paged.text.slice(0, 300));
  pass("with no parameter the read is administration, ten rows; a page keeps the total");
  return a;
}

async function everythingCases(seeded: SeededAudit, as: (q: string) => Promise<Answer>): Promise<Answer> {
  let step = "everything, below the ceiling";
  const expected = expectedRows(seeded);
  const a = await as(`?filter=all&before=${encodeURIComponent(iso(seeded.bulkFrom))}&limit=100`);
  compareRows(step, rowsOf(step, a), expected, seeded);
  if (a.body.filter !== "all" || a.body.total !== EVENTS.length || (a.body.meta as Obj).population !== ALL_POPULATION) {
    fail(step, `filter ${String(a.body.filter)}, total ${String(a.body.total)}, meta ${JSON.stringify(a.body.meta)}`);
  }
  pass(`every one of the ${EVENTS.length} seeded events but the page view, the subject answered only for administration ` +
       "and a tool call's tool, a search's question and a token's label among the nulls, and no sentence but administration's");

  step = "the ceiling";
  const latest = await as("?filter=all&limit=100");
  const latestRows = rowsOf(step, latest);
  if (latest.body.total !== 500 || latestRows.length !== 100
      || latestRows.some((r) => r.kind !== "tool_call" || r.subject !== "core:skill_read")) {
    fail(step, `the latest events answered total ${String(latest.body.total)}: ${named(latestRows, seeded).slice(0, 300)}`);
  }
  for (const [offset, limit, count] of [[450, 100, 50], [499, 100, 1], [500, 10, 0], [900, 100, 0]] as const) {
    const p = await as(`?filter=all&limit=${limit}&offset=${offset}`);
    const r = rowsOf(step, p);
    if (r.length !== count || p.body.total !== 500) fail(step, `offset ${offset} answered ${r.length} rows of ${String(p.body.total)}`);
    if (offset === 499 && r[0].at !== iso(seeded.bulkFrom + (BULK - 500) * 1000)) {
      fail(step, `the 500th latest event is at ${String(r[0].at)}, not the bulk's ${BULK - 500 + 1}th`);
    }
  }
  pass(`unfiltered, the latest 500 of ${BULK} newer calls and a total of 500; a page never reads past the 500th`);

  step = "filters apply before the ceiling";
  const want = (...k: string[]) => expected.filter((r) => k.some((key) => r.id === seeded.ids.get(key)));
  const cases: [string, Obj[]][] = [
    ["?filter=all&kind=bug.delete", want("delete")],
    ["?kind=bug.delete", want("delete")],
    [`?filter=all&team=${TEAM_TWO}&limit=100`, want("archive", "remove-member", "reactivate")],
    [`?team=${TEAM_TWO}`, want("archive", "remove-member", "reactivate")],
    [`?before=${encodeURIComponent(iso(seeded.at.get("unrecorded")!))}`, want("maintenance", "add-member", "create", "reactivate", "delete")],
    ["?filter=all&kind=tool_call&team=" + TEAM_ONE + `&before=${encodeURIComponent(iso(seeded.bulkFrom))}`, want("maintenance-call", "refused-call")],
    ["?kind=tool_call", []],
    ["?filter=all&kind=console.page_view", []],
    ["?filter=all&kind=admin.list_oauth_clients", want("list-clients")],
    ["?kind=admin.list_oauth_clients", []],
    ["?filter=all&team=no-such-team", []],
  ];
  for (const [query, rows] of cases) {
    const f = await as(query);
    compareRows(`${step}: ${query}`, rowsOf(step, f), rows, seeded);
    if (f.body.total !== rows.length) fail(step, `${query} answered total ${String(f.body.total)}, not ${rows.length}`);
  }
  pass("a kind, a team and an instant each reach events older than the latest 500, under either filter; a page view, " +
       "an unknown team and a kind outside administration under administration answer nothing");
  return a;
}

async function refusalCases(as: (q: string) => Promise<Answer>, member: (q: string) => Promise<Answer>): Promise<void> {
  let step = "a member is refused before anything is read";
  for (const q of ["", "?filter=all", "?filter=everything&limit=0", `?team=${TEAM_TWO}&scope=platform`, "?kind=bug.delete&before=x"]) {
    const m = await member(q);
    if (m.status !== 403 || m.text !== JSON.stringify({ error: "not permitted" })) fail(step, `${q || "no query"} answered ${m.status}: ${m.text.slice(0, 200)}`);
  }
  pass("a member asking anything, a malformed request included, is 403 `not permitted` and nothing else");

  step = "a request the read does not take";
  for (const [q, error] of [
    ["?filter=everything", "filter must be one of administration, all"],
    ["?filter=all&filter=administration", "each filter and the page are given at most once"],
    ["?before=yesterday", "before must be an instant"],
    ["?kind=Bug%20Delete", "kind must be an event kind"],
    ["?limit=0", BAD_PAGE], ["?limit=101", BAD_PAGE], ["?limit=2.5", BAD_PAGE], ["?offset=-1", BAD_PAGE],
  ] as const) {
    const a = await as(q);
    if (a.status !== 400 || a.text !== JSON.stringify({ error })) fail(step, `${q} answered ${a.status}: ${a.text.slice(0, 200)}`);
  }
  pass("an unknown filter, a repeated parameter, a malformed instant or kind, or a page out of range is 400 with its fixed sentence");
}

/** The module's SQL: every backtick literal in its source, its comments left out. */
function sqlOf(source: string): string {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return (code.match(/`[^`]*`/g) ?? []).join("\n");
}

function privacyCases(texts: string[], answers: Answer[]): void {
  let step = "no planted text leaves the gateway";
  for (const text of texts) {
    const at = text.indexOf(SENTINEL);
    if (at >= 0) fail(step, `an answer holds ${text.slice(Math.max(0, at - 80), at + 80)}`);
  }
  pass(`no answer of ${texts.length} holds the text planted in a title, a label, a file's name, a reason, a document's ` +
       "details, a journal's detail, a refusal or a search's question");

  step = "the read selects only the allowed detail keys";
  const sql = sqlOf(readFileSync(MODULE, "utf8"));
  const details = [...sql.matchAll(/\bdetail\b(->>'([A-Za-z]+)')?/g)];
  const bad = details.filter((m) => !m[2] || !ALLOWED_DETAIL.includes(m[2])).map((m) => m[0]);
  if (!details.length || bad.length) fail(step, `the module's SQL reads ${bad.join(", ") || "no detail key at all"}`);
  if (/\brefusal\b(?!_owner)/.test(sql)) fail(step, "the module's SQL reads the refusal column");
  pass("the module's SQL reads `detail` only through role, status, reactivated, from, team, owner, the three counts, " +
       "via, and a filing's bug, and never the refusal column");

  step = "no channel is named but the console";
  for (const a of answers) {
    for (const r of a.body.rows as Obj[]) {
      const s = r.sentence;
      if (s === null) continue;
      if (typeof s !== "string" || CHANNEL.test(s) || s.endsWith(" in the console") !== r.inConsole) {
        fail(step, `${String(r.kind)} reads ${JSON.stringify(s)} with inConsole ${String(r.inConsole)}`);
      }
    }
  }
  pass("a sentence ends `in the console` exactly when the act was a console write, and none names another door");
}

/**
 * Three more deleted reports, each with a filing that records more or less of it, every free text a sentinel: the
 * acts name each by the day it was filed alone, and nothing the deletion or the filing recorded leaves, an impact or a
 * surface included. The rows are removed again, so no case after this one reads them.
 */
async function deletionCases(db: pg.Client, as: (q: string) => Promise<Answer>): Promise<void> {
  const step = "a deleted report is named by the day it was filed";
  const actor = (await db.query<{ id: string }>("select id::text as id from zz.principal where email = $1", [SUPERADMIN])).rows[0].id;
  const now = Math.floor(Date.now() / 1000) * 1000 - 3_600_000;
  const filed = now - 20 * 86_400_000;
  const reports: { id: string; filing: Obj; want: string }[] = [
    { id: "c0000000-0000-4000-8000-0000000000a3", filing: { impact: "blocks_work", surface: "Console" },
      want: `${SUPERADMIN} deleted a report filed ${FILED_DAY.format(new Date(filed))}` },
    { id: "c0000000-0000-4000-8000-0000000000a4", filing: {},
      want: `${SUPERADMIN} deleted a report filed ${FILED_DAY.format(new Date(filed))}` },
    { id: "c0000000-0000-4000-8000-0000000000a5", filing: { impact: "cosmetic", surface: `${SENTINEL} a surface nobody registered` },
      want: `${SUPERADMIN} deleted a report filed ${FILED_DAY.format(new Date(filed))}` },
  ];
  const inserted: string[] = [];
  for (const [i, r] of reports.entries()) {
    for (const [ts, kind, subject, detail] of [
      [filed + i * 1000, "bug_report", "", { bug: r.id, title: `${SENTINEL} title of a filed report`, ...r.filing }],
      [now + i * 1000, "bug.delete", r.id, { title: `${SENTINEL} title of a deleted report` }],
    ] as const) {
      const { rows } = await db.query<{ id: string }>(
        `insert into zz.event (ts, kind, subject, detail, origin, actor_id) values ($1, $2, $3, $4::jsonb, 'work', $5) returning id::text as id`,
        [new Date(ts).toISOString(), kind, subject, JSON.stringify(detail), actor]);
      inserted.push(rows[0].id);
    }
  }
  try {
    const a = await as("?kind=bug.delete");
    const rows = rowsOf(step, a);
    for (const r of reports) {
      const got = rows.find((x) => x.subject === r.id)?.sentence;
      if (got !== r.want) fail(step, `report ${r.id} reads ${JSON.stringify(got)}, not ${JSON.stringify(r.want)}`);
    }
    const unnamed = EVENTS.find((e) => e.key === "delete")!.expect.sentence;
    if (rows.find((x) => x.subject !== null && !reports.some((r) => r.id === x.subject))?.sentence !== unnamed) {
      fail(step, `the seed's deletion reads ${JSON.stringify(rows.map((x) => x.sentence))}`);
    }
    if (a.text.includes(SENTINEL)) fail(step, `an answer holds ${a.text.slice(Math.max(0, a.text.indexOf(SENTINEL) - 80), a.text.indexOf(SENTINEL) + 80)}`);
  } finally {
    await db.query("delete from zz.event where id = any($1::bigint[])", [inserted]);
  }
  pass("a deleted report reads as the day it was filed, whatever impact or surface its filing records, and as one the " +
       "record does not name with no filing; no title, impact or surface either act recorded leaves");
}

async function run(db: pg.Client, url: string): Promise<void> {
  const seeded = await seedAudit(db);
  const cookie = new Map<string, string>();
  for (const email of [MEMBER, SUPERADMIN]) cookie.set(email, await signIn(db, email));
  const pat = `zzp_${randomBytes(24).toString("hex")}`;
  await db.query("insert into zz.pat (principal_id, token_hash) select id, $2 from zz.principal where email = $1",
                 [MEMBER, createHash("sha256").update(pat, "utf8").digest("hex")]);
  const events = async (): Promise<number> => (await db.query<{ n: number }>("select count(*)::int as n from zz.event")).rows[0].n;
  const before = await events();

  process.env.TEAM_DB_URL = url;
  process.env.ZZ_TZ = TIMEZONE;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  const load = (p: string) => import(pathToFileURL(join(root, p)).href);
  const express = (await import("express")).default;
  const dbModule = (await load("services/gateway/dist/db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await dbModule.initPlatformDb();
  const { identityMiddleware } = (await load("services/gateway/dist/identity.js")) as { identityMiddleware: () => RequestHandler };
  const { mountPlatformAudit } = (await load("services/gateway/dist/console/platform-audit.js")) as
    { mountPlatformAudit: (app: Express) => void };
  // The envelope, as mountConsole mounts it in front of every read: this answer is stamped like every other, so
  // its meta carries the three request-scoped fields beside builtAt and sourceRevision that describe no derived
  // data (checks/console-read-envelope.ts proves the stamping itself).
  const { mountReadEnvelope } = (await load("services/gateway/dist/console/read-envelope.js")) as
    { mountReadEnvelope: (app: Express) => void };
  const app = express();
  // COUPLED: services/gateway/src/server.ts — the identity gate before every console route.
  app.use(identityMiddleware());
  mountReadEnvelope(app);
  mountPlatformAudit(app);
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/console/platform/audit`;
  const texts: string[] = [];
  const fetchAs = async (headers: Record<string, string>, query: string): Promise<Answer> => {
    const res = await fetch(`${base}${query}`, { headers, signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    texts.push(text);
    let body: Obj = {};
    try { const v: unknown = JSON.parse(text); if (isObj(v)) body = v; } catch { /* not JSON: body stays empty */ }
    return { status: res.status, body, text };
  };
  const as = (q: string): Promise<Answer> => fetchAs({ cookie: `zz_console=${cookie.get(SUPERADMIN)}` }, q);
  const member = (q: string): Promise<Answer> => fetchAs({ cookie: `zz_console=${cookie.get(MEMBER)}` }, q);

  try {
    const administration = await administrationCases(seeded, as);
    const everything = await everythingCases(seeded, as);
    await refusalCases(as, member);
    privacyCases(texts, [administration, everything]);

    let step = "refusals before the gate";
    const none = await fetchAs({}, "");
    if (none.status !== 401) fail(step, `no session answered ${none.status}: ${none.text.slice(0, 300)}`);
    const token = await fetchAs({ authorization: `Bearer ${pat}` }, "");
    if (token.status !== 403 || "rows" in token.body) fail(step, `a member's token answered ${token.status}: ${token.text.slice(0, 300)}`);
    pass("no session is refused with 401, and a member's token, which the console does not let in, with 403");

    step = "the shapes the console's fake answers";
    let fake: { audit: (q: URLSearchParams, page: { limit: number; offset: number } | null) => [number, unknown] | null };
    try {
      fake = (await import(pathToFileURL(FAKE).href)) as typeof fake;
    } catch (err) {
      fail(step, `could not read the console's fake answer at ${FAKE}: ${(err as Error).message}`);
    }
    const fakeOf = (q: string): unknown => fake.audit(new URLSearchParams(q), { limit: 100, offset: 0 })?.[1];
    const diffs = [
      ...shapeDiffs(administration.body, fakeOf("filter=administration"), "administration", []),
      ...shapeDiffs(everything.body, fakeOf("filter=all"), "all", []),
    ];
    // Each fake row is held to the same keys, not only the first.
    for (const q of ["filter=administration", "filter=all"]) {
      for (const r of ((fakeOf(q) as Obj).rows as Obj[])) if (keys(r) !== ROW_KEYS.join()) diffs.push(`a fake ${q} row has keys ${keys(r)}`);
    }
    if (diffs.length) fail(step, diffs.join("; "));
    pass("administration and everything agree in shape with the fake's, key set by key set");

    step = "nothing was written";
    if (await events() !== before) fail(step, `zz.event holds ${await events()} rows after the reads, not ${before}`);
    pass("no read wrote an event");

    await deletionCases(db, as);

    step = "a query that fails";
    await db.query("alter table zz.event rename to event_hidden");
    const broken = await as("").finally(() => db.query("alter table zz.event_hidden rename to event"));
    if (broken.status !== 500 || broken.text !== JSON.stringify({ error: "could not read the platform's audit" })) {
      fail(step, `answered ${broken.status}: ${broken.text.slice(0, 300)}`);
    }
    await db.query("alter table zz.event rename to event_hidden");
    const refused = await member("").finally(() => db.query("alter table zz.event_hidden rename to event"));
    if (refused.status !== 403 || refused.text !== JSON.stringify({ error: "not permitted" })) {
      fail(step, `a member with the events unreadable answered ${refused.status}: ${refused.text.slice(0, 300)}`);
    }
    pass("a query that fails answers 500, could not read the platform's audit, and nothing else, and a member is still " +
         "refused 403 with the events unreadable, so the refusal reads nothing");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await dbModule.platformDb().end().catch(() => undefined);
    delete process.env.TEAM_DB_URL;
    delete process.env.ZZ_TZ;
    delete process.env.ZZ_CATALOG_DIR;
  }
}

async function main(): Promise<number> {
  let dbUrl = "";
  try {
    await withThrowawayDb((db) => run(db, dbUrl), async (u) => { dbUrl = u; });
  } catch (err) {
    if (err instanceof Error && /Docker is not running/.test(err.message)) {
      console.error(`${NAME}: Docker is not available — the check could not run, which is not a pass`);
      return 2;
    }
    console.error(err instanceof CaseFailure ? err.message : `${NAME}: ${String((err as Error)?.stack ?? err)}`);
    return 1;
  }
  console.log(DONE);
  return 0;
}

process.exitCode = await main();
