#!/usr/bin/env node
/**
 * checks/console-writing.ts — the writing ledger: words added by period and the retained stock, from the
 * revisions zz-core keeps and the acts it records (AC-2.10, AC-5.4).
 *
 *   node checks/console-writing.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL and a real zz-core on it (`withThrowawayCore`), and the gateway's own
 * built door in this process: the identity gate, the JSON parser, the tool-call telemetry and the relay
 * to that zz-core, in the order server.ts mounts them, so every write a person's session (`zz-plugin`)
 * or a maintenance client (`zz-migrate`) makes through it leaves the rows the gateway and zz-core write.
 * The record is made in phases; each phase's rows are then moved, together and by one interval, into
 * the week the case needs. It calls the gateway's own built `additionsByPeriod`, `retainedStock`,
 * `transitions` and `documentFacts` (`services/gateway/dist/console/writing.js`). What it establishes,
 * with the expected values written below:
 *
 *   - a document written 0 -> 10,000 -> 6,000 -> 7,000 words, shown between writes, adds 10,000, 0 and
 *     1,000 in the weeks of those writes and leaves 7,000 in the stock; a same-length rewrite, a change
 *     to metadata only and a replayed write add nothing, the replay no revision at all;
 *   - two writes to a draft before it is shown are one transition, dated at the second;
 *   - an approval in a later week, and a close in a later week, leave the transition in the week its
 *     content was written, dated by the content act; a later edit leaves every earlier week as it was;
 *   - a lesson counts once, at its length, on the day it was made; an import-made document and a lesson
 *     a maintenance client made add nothing and are out of the stock; an unrecorded document is in the
 *     coverage and out of both; a mixed document counts as work and is named;
 *   - a missing_legacy revision, and the revision after it, are gaps in the coverage, never a creation
 *     from zero; a sealed revision with no content act before its seal is dated by its own written_at
 *     and counted in datedByLastWrite;
 *   - the running week is not complete, an empty week has no data rather than zero, a year's window
 *     answers months, and a cutoff that is not a time fails every function.
 *
 * It prints how long one read of the throwaway's small record took: a floor, not the representative
 * measure the plan asks for before anything is cached.
 *
 * DELIBERATE: three direct writes beside the moves. A missing_legacy revision is a fact only a legacy
 * store states and no tool makes one, so one revision is marked so; the content acts of one document are
 * deleted, to stand for a revision sealed before the acts were recorded; and nothing else.
 *
 * The only database it touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { lastJson } from "@zz/mcp-client";
import type { Request, RequestHandler } from "express";
import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";
import { TIMEZONE, WEEK, at, runningWeek } from "../scripts/schema/work-seed.ts";

const NAME = "console-writing";
const DONE = "console-writing: words added are dated by the content of each retained revision, sealed or not, imports " +
  "and unrecorded documents left out and gaps named, a lesson counted once on its day, and the stock each eligible " +
  "current body once: ok";

type Coverage = Record<"documents" | "revisions" | "importMade" | "unrecorded" | "mixed" | "datedByLastWrite" | "undated" | "missingLegacy", number>;
type Win = { from: string; to: string; observedFrom: string | null; observedThrough: string | null; complete: boolean };
type PF = { window: Win; figure: { value: number | null; why: string | null }; numerator: number | null; denominator: number | null };
type Transition = { docId: string; initiative: string; path: string; revision: number; added: number; removed: number; at: string; dating: string };
type Span = { from: string; to: string };
interface Writing {
  additionsByPeriod(team: string, window: Span, asOf: string): Promise<{ periods: PF[]; cumulative: PF[]; coverage: Coverage }>;
  retainedStock(team: string, asOf: string): Promise<{ words: number; coverage: Coverage }>;
  transitions(team: string, window: Span, asOf: string): Promise<Transition[]>;
  documentFacts(team: string, window: Span, asOf: string): Promise<{
    versions: number; mostRewritten: { initiative: string; path: string; versions: number }[];
    mostWordsInAWeek: { words: number; week: string } | null; documentsCreated: PF[];
  }>;
}

/** The client a maintenance command names itself, and the one a person's session does. */
const MAINTENANCE = "zz-migrate";
const WORK = "zz-plugin";
const HOUR = 3_600_000;

/** `n` words: a heading of two, then words of `tag` with `first` leading, twenty to a line. */
function text(n: number, tag: string): string {
  const words = Array.from({ length: n - 2 }, (_, i) => (i === 0 ? `${tag}-start` : tag));
  const lines: string[] = [];
  for (let i = 0; i < words.length; i += 20) lines.push(words.slice(i, i + 20).join(" "));
  return `# ${tag}\n\n${lines.join("\n")}\n`;
}
/** A block of `n` words, its first word the marker that makes it unique, twenty to a line. */
function block(marker: string, n: number): string {
  const words = [marker, ...Array.from({ length: n - 1 }, () => "lorem")];
  const lines: string[] = [];
  for (let i = 0; i < words.length; i += 20) lines.push(words.slice(i, i + 20).join(" "));
  return lines.join("\n");
}
// The ledger: 2 + 4,000 + 5,997 + 1 = 10,000 words; less the first block 6,000; with a thousand more 7,000.
const BLOCK_A = block("MARKA", 4000);
const LEDGER = `# Ledger\n\n${BLOCK_A}\n\n${block("MARKB", 5997)}\n\nMARKZ\n`;
const MORE = block("MARKY", 1000);

/** The gateway's door to zz-core, as server.ts mounts it, a PAT of the seeded person's, and the ledger,
 *  loaded once the reporting timezone is set. */
interface Gateway { url: string; token: string; writing: Writing; stop(): Promise<void> }

async function listen(c: Core): Promise<Gateway> {
  process.env.TEAM_DB_URL = c.url;
  process.env.ZZ_TZ = TIMEZONE;
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
  const writing = (await load("services/gateway/dist/console/writing.js")) as Writing;

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
  await c.sql.query(
    `insert into zz.pat (principal_id, token_hash, team_id) select p.id, $2, null from zz.principal p where p.email = $1`,
    [c.email, createHash("sha256").update(token, "utf8").digest("hex")]);
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token, writing,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.platformDb().end().catch(() => undefined);
      delete process.env.TEAM_DB_URL;
      delete process.env.ZZ_TZ;
      delete process.env.ZZ_CATALOG_DIR;
    },
  };
}

/** Tool calls through the gateway as a client, counted so the rows they leave can be waited for. */
function door(c: Core, g: Gateway) {
  let sent = 0;
  const call = async (step: string, client: string, name: string, args: Record<string, unknown>): Promise<string> => {
    const res = await fetch(`${g.url}/core/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${g.token}`, "content-type": "application/json",
                 accept: "application/json, text/event-stream", "x-zz-client": client },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(60_000),
    });
    const raw = await res.text();
    sent++;
    const env = lastJson(raw);
    const reply = env?.result?.content?.map((p) => p.text ?? "").join("") ?? env?.error?.message ?? raw.slice(0, 300);
    if (res.status !== 200 || reply.startsWith("ERROR")) c.fail(step, `${name} as ${client} answered ${res.status}: ${reply.slice(0, 300)}`);
    return reply;
  };
  return { call, sent: () => sent };
}

const count = async (c: Core, where: string): Promise<number> =>
  (await c.sql.query<{ n: number }>(`select count(*)::int as n from zz.event where ${where}`)).rows[0].n;

/**
 * Runs `make`, waits until every row it leaves has landed (the gateway writes a tool call after its
 * answer, and zz-core most acts after its commit), then moves every timestamp the phase wrote by one
 * interval, so its first instant lands at `target`: the events, the revisions' written and presented
 * times, the documents', the initiatives' and the lessons'. Each move keeps a seal's written_at equal to
 * its act's ts and to its initiative's closed_at.
 */
async function phase(c: Core, d: ReturnType<typeof door>, target: number, make: () => Promise<void>): Promise<void> {
  const start = (await c.sql.query<{ t: string }>("select clock_timestamp()::text as t")).rows[0].t;
  const base = await count(c, "kind = 'tool_call'") - d.sent();
  await make();
  const until = Date.now() + 15_000;
  let seen = -1;
  for (;;) {
    await new Promise((r) => setTimeout(r, 400));
    const calls = await count(c, "kind = 'tool_call'");
    const all = await count(c, "true");
    if (calls >= base + d.sent() && all === seen) break;
    if (Date.now() > until) c.fail("a phase settles", `${calls} tool calls of ${base + d.sent()}, events still moving`);
    seen = all;
  }
  const to = new Date(target).toISOString();
  const move = (table: string, columns: string[]) => c.sql.query(
    `update ${table} set ${columns.map((k) => `${k} = case when ${k} >= $1::timestamptz then ${k} + ($2::timestamptz - $1::timestamptz) else ${k} end`).join(", ")}
      where ${columns.map((k) => `${k} >= $1::timestamptz`).join(" or ")}`, [start, to]);
  await move("zz.event", ["ts"]);
  await move("zz.doc_revision", ["written_at", "presented_at"]);
  await move("zz.doc", ["created_at", "updated_at"]);
  await move("zz.initiative", ["opened_at", "closed_at"]);
  await move("zz.knowledge_node", ["created_at", "updated_at"]);
}

/** Equal when both spell the same JSON, which a failure prints. */
const same = (c: Core, step: string, found: unknown, expected: unknown): void => {
  const f = JSON.stringify(found), e = JSON.stringify(expected);
  if (f !== e) c.fail(step, `found ${f}, expected ${e}`);
};
/** A period's value, or `null` with no data, by weeks back from the running week. */
const values = (periods: PF[]): (number | null)[] => periods.map((p) => p.figure.value);

async function run(c: Core): Promise<void> {
  const g = await listen(c);
  try {
    await cases(c, g);
  } finally {
    await g.stop();
  }
}

async function cases(c: Core, g: Gateway): Promise<void> {
  const d = door(c, g);
  const w0 = runningWeek(Date.now());
  const when = (back: number) => at(w0, [back, 30]);
  const back = (iso: string): number => Math.ceil((w0 - Date.parse(iso)) / WEEK);
  // Eleven weeks: ten back, then the running one.
  const window: Span = { from: new Date(at(w0, [10, 0])).toISOString(), to: new Date(w0 + WEEK).toISOString() };
  const cutoff = () => new Date(Math.ceil(Date.now() / 1000) * 1000).toISOString();
  let I = "", J = "";
  const p = (path: string) => `${I}/${path}`;
  const write = (step: string, client: string, path: string, content: string) => d.call(step, client, "document_write", { path, content });
  const edit = (step: string, client: string, path: string, edits: { find: string; replace: string }[], extra: Record<string, unknown> = {}) =>
    d.call(step, client, "document_edit", { path, edits, ...extra });
  const present = (step: string, path: string) => d.call(step, WORK, "document_present", { path });

  let step = "the record made";
  await phase(c, d, when(9), async () => {
    I = await c.open("ledger");
    await write(step, WORK, p("ledger.md"), LEDGER);
    await present(step, p("ledger.md"));
  });
  await phase(c, d, when(8), async () => {
    await edit(step, WORK, p("ledger.md"), [{ find: `${BLOCK_A}\n\n`, replace: "" }]);
    await present(step, p("ledger.md"));
  });
  await phase(c, d, when(7), async () => {
    await edit(step, WORK, p("ledger.md"), [{ find: "MARKZ", replace: `MARKZ\n${MORE}` }]);
    await present(step, p("ledger.md"));
  });
  await phase(c, d, when(6), async () => {
    J = await c.open("closing");
    await write(step, WORK, p("approved.md"), text(300, "approved"));
    await write(step, WORK, p("sealed.md"), text(200, "sealed"));
    await write(step, MAINTENANCE, p("imported.md"), text(400, "imported"));
    await write(step, MAINTENANCE, p("mixed.md"), text(100, "mixed"));
    await edit(step, WORK, p("mixed.md"), [{ find: "mixed-start", replace: `mixed-start ${Array(50).fill("more").join(" ")}` }]);
    await c.ok(step, "document_write", { path: p("unrecorded.md"), content: text(250, "unrecorded") });
    await write(step, WORK, `${J}/notes.md`, text(120, "notes"));
    await write(step, WORK, p("legacy.md"), text(60, "legacy"));
    await present(step, p("legacy.md"));
    await edit(step, WORK, p("legacy.md"), [{ find: "legacy-start", replace: `legacy-start ${Array(30).fill("later").join(" ")}` }]);
    await present(step, p("legacy.md"));
  });
  await phase(c, d, when(5), async () => {
    await write(step, WORK, p("draft.md"), text(80, "draft"));
  });
  await phase(c, d, when(4), async () => {
    await edit(step, WORK, p("draft.md"), [{ find: "draft-start", replace: `draft-start ${Array(50).fill("filled").join(" ")}` }]);
    await d.call(step, WORK, "knowledge_add", { title: "Ledger cadence", type: "decision", scope: "team", evidence: [I],
      body: "The ledger closes every Friday after the vendor export lands in the bucket." });
    await d.call(step, MAINTENANCE, "knowledge_add", { title: "Carried lesson", type: "knowledge", scope: "team", evidence: [I],
      body: Array(40).fill("carried").join(" ") });
  });
  await phase(c, d, when(3), async () => {
    await c.sign(p("approved.md"));
    await c.sign(p("sealed.md"));
    await edit(step, WORK, p("ledger.md"), [{ find: "MARKB", replace: "MARKC" }]);
    await present(step, p("ledger.md"));
    await d.call(step, WORK, "document_edit", { path: p("ledger.md"), tags: ["ledger"] });
    await present(step, p("ledger.md"));
    for (let i = 0; i < 2; i++) await edit(step, WORK, p("ledger.md"), [{ find: "MARKC", replace: "MARKD" }], { request_id: "same-change" });
  });
  // The acts of sealed.md, as for a revision sealed before the acts were recorded; legacy.md's first
  // revision, as one whose bytes a legacy store never held.
  const CONTENT = ["write", "edit", "patch", "revise"].flatMap((a) => [`document.${a}`, `document.document_${a}`]);
  const gone = await c.sql.query(`delete from zz.event where kind = any($1::text[]) and ltrim(subject, '/') = $2`, [CONTENT, p("sealed.md")]);
  if (!gone.rowCount) c.fail(step, "sealed.md had no content act to delete");
  const legacy = await c.sql.query(
    `update zz.doc_revision r set content_state = 'missing_legacy', title = null, body = null, tags = null, content_hash = null
       from zz.doc d where d.id = r.doc_id and d.path = 'legacy.md' and r.revision = 1`);
  if (legacy.rowCount !== 1) c.fail(step, `${legacy.rowCount} legacy revisions marked, not 1`);
  const revisionsOf = async (path: string) => (await c.sql.query<{ n: number }>(
    "select count(*)::int as n from zz.doc_revision r join zz.doc d on d.id = r.doc_id where d.path = $1", [path])).rows[0].n;
  same(c, "the ledger's revisions, the replay making none", await revisionsOf("ledger.md"), 6);
  same(c, "the draft rewritten in place", await revisionsOf("draft.md"), 1);

  step = "the weeks before a later edit and a close";
  const asOfEarly = cutoff();
  const early = await g.writing.additionsByPeriod(c.team, window, asOfEarly);

  await phase(c, d, when(2), async () => {
    await c.ok(step, "initiative_close", { initiative: J, disposition: "finished", document: "notes.md" });
    await present(step, p("draft.md"));
  });
  await phase(c, d, when(1), async () => {
    await edit(step, WORK, p("draft.md"), [{ find: "draft-start", replace: `draft-start ${Array(20).fill("again").join(" ")}` }]);
  });
  const sealedAt = (await c.sql.query<{ sealed: boolean }>(
    `select r.written_at = i.closed_at as sealed from zz.doc_revision r join zz.doc d on d.id = r.doc_id
       join zz.initiative i on i.id = d.initiative_id where i.slug = $1 and d.path = 'notes.md'`, [J])).rows[0];
  if (!sealedAt?.sealed) c.fail(step, "the close did not rewrite notes.md in its own transaction, so the case cannot hold");

  // The weeks, ten back to the running one.
  const asOf = cutoff();
  const started = performance.now();
  const added = await g.writing.additionsByPeriod(c.team, window, asOf);
  const took = performance.now() - started;
  step = "words added by week";
  const WEEKS = [null, 10_000, 0, 1_000, 570, null, 143, 200, null, 20, null];
  same(c, step, values(added.periods), WEEKS);
  let sum = 0;
  same(c, "the cumulative words", values(added.cumulative), WEEKS.map((v) => (sum += v ?? 0)));
  same(c, "the windows", added.periods.map((x) => [back(x.window.from), x.window.complete]),
    [10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map((b) => [b, b > 0]));
  same(c, "an empty week", added.periods[5], { ...added.periods[5], figure: { value: null, why: "no_data" }, numerator: null, denominator: null });
  c.pass("0 -> 10,000 -> 6,000 -> 7,000 adds 10,000, 0 and 1,000 in its weeks; the same-length rewrite, the metadata change " +
         "and the replay add nothing; the running week is not complete and an empty week has no data, not zero");

  step = "an earlier week after a later edit and a close";
  same(c, step, values(added.periods).slice(0, 8), values(early.periods).slice(0, 8));
  same(c, "the weeks read before them", values(early.periods), [null, 10_000, 0, 1_000, 570, null, 143, 200, null, null, null]);
  c.pass("a later edit, a close in a later week and an approval in a later week leave every earlier week as it was");

  step = "the transitions";
  const rows = await g.writing.transitions(c.team, window, asOf);
  const line = (t: Transition) => [t.path, t.revision, t.added, t.removed, back(t.at), t.dating];
  same(c, step, rows.map(line).sort((a, b) => String(a[0]).localeCompare(String(b[0])) || Number(a[1]) - Number(b[1])), [
    ["approved.md", 1, 300, 0, 6, "content_act"],
    ["draft.md", 1, 130, 0, 4, "last_write"],
    ["draft.md", 2, 20, 0, 1, "last_write"],
    ["ledger.md", 1, 10_000, 0, 9, "last_write"],
    ["ledger.md", 2, 0, 4_000, 8, "last_write"],
    ["ledger.md", 3, 1_000, 0, 7, "last_write"],
    ["ledger.md", 4, 0, 0, 3, "last_write"],
    ["ledger.md", 5, 0, 0, 3, "last_write"],
    ["ledger.md", 6, 0, 0, 3, "last_write"],
    ["mixed.md", 1, 150, 0, 6, "last_write"],
    ["notes.md", 1, 120, 0, 6, "content_act"],
    ["sealed.md", 1, 200, 0, 3, "last_write"],
  ]);
  for (let i = 1; i < rows.length; i++) if (rows[i].at < rows[i - 1].at) c.fail(step, "the transitions are not earliest first");
  const second = (await c.sql.query<{ at: string }>(
    `select to_char(r.written_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as at
       from zz.doc_revision r join zz.doc d on d.id = r.doc_id where d.path = 'draft.md' and r.revision = 1`)).rows[0].at;
  same(c, "the draft's transition is the second write's", rows.find((t) => t.path === "draft.md" && t.revision === 1)?.at, second);
  c.pass("two writes to a draft before it is shown are one transition at the second; an approval and a close date theirs by " +
         "the content act; the sealed revision with no act before it by its written_at; a gap and an import are no transition");

  step = "the coverage of the weeks";
  same(c, step, added.coverage,
    { documents: 9, revisions: 16, importMade: 1, unrecorded: 1, mixed: 1, datedByLastWrite: 1, undated: 0, missingLegacy: 2 });
  c.pass("the coverage counts every document and revision read, names the import, the unrecorded and the mixed document, the " +
         "one revision dated by its seal, and both revisions of the missing_legacy gap");

  step = "the stock";
  const stock = await g.writing.retainedStock(c.team, asOf);
  // 7,000 ledger + 300 + 200 + 150 mixed + 120 notes + 90 legacy + 150 draft + 13 the lesson.
  same(c, step, stock, { words: 8_023, coverage:
    { documents: 9, revisions: 16, importMade: 1, unrecorded: 1, mixed: 1, datedByLastWrite: 1, undated: 0, missingLegacy: 0 } });
  same(c, "the stock between the edits", (await g.writing.retainedStock(c.team, new Date(when(7) + HOUR).toISOString())).words, 7_000);
  same(c, "the stock before the first write", (await g.writing.retainedStock(c.team, new Date(when(9) - HOUR).toISOString())).words, 0);
  c.pass("the stock sums each eligible current body once: the ledger at 7,000, the lesson once at its length, the import, the " +
         "maintenance lesson and the unrecorded document out; read at a cutoff it is that cutoff's");

  step = "the document facts";
  const facts = await g.writing.documentFacts(c.team, window, asOf);
  same(c, step, { ...facts, mostWordsInAWeek: facts.mostWordsInAWeek && [facts.mostWordsInAWeek.words, back(facts.mostWordsInAWeek.week)],
                  documentsCreated: values(facts.documentsCreated) }, {
    versions: 14,
    mostRewritten: [{ initiative: I, path: "ledger.md", versions: 6 }, { initiative: I, path: "draft.md", versions: 2 },
                    { initiative: I, path: "legacy.md", versions: 2 }],
    mostWordsInAWeek: [10_000, 9],
    documentsCreated: [0, 1, 0, 0, 5, 1, 0, 0, 0, 0, 0],
  });
  c.pass("versions written count every eligible revision in the window, gaps included; the most rewritten, the week with the " +
         "most words and the documents created by week answer the record");

  step = "a year's window";
  const year: Span = { from: new Date(at(w0, [52, 0])).toISOString(), to: window.to };
  const months = await g.writing.additionsByPeriod(c.team, year, asOf);
  const local = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(new Date(iso));
  if (months.periods.length < 12 || months.periods.length > 14) c.fail(step, `${months.periods.length} periods, not about twelve months`);
  const firsts = months.periods.slice(1).map((x) => local(x.window.from).slice(8));
  same(c, "each month starts on its first day", [...new Set(firsts)], ["01"]);
  same(c, "the year's words", months.cumulative.at(-1)?.figure.value, 11_933);
  c.pass("a year's window answers months, each from its first local day, with the same words");

  step = "a query that fails";
  for (const [name, call] of [
    ["additionsByPeriod", () => g.writing.additionsByPeriod(c.team, window, "not a time")],
    ["retainedStock", () => g.writing.retainedStock(c.team, "not a time")],
    ["transitions", () => g.writing.transitions(c.team, window, "not a time")],
    ["documentFacts", () => g.writing.documentFacts(c.team, window, "not a time")],
  ] as const) {
    if (!(await (call as () => Promise<unknown>)().then(() => false, () => true))) c.fail(step, `${name}("not a time") answered instead of failing`);
  }
  c.pass("a cutoff that is not a time fails every function rather than answering nothing");
  console.log(`  one read of the throwaway's record took ${took.toFixed(0)} ms (a floor, not the representative measure)`);
}

process.exitCode = await withThrowawayCore(NAME, DONE, run);
