#!/usr/bin/env node
/**
 * checks/console-imports.ts — one rule tells an import from a team's own work, for lessons and for
 * documents (AC-2.10, AC-2.11).
 *
 *   node checks/console-imports.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL migrated by the real runner and a real zz-core on it
 * (`withThrowawayCore`), and the gateway's own built middleware in this process: the identity gate, the
 * JSON parser, the tool-call telemetry and the relay to that zz-core, in the order server.ts mounts them.
 * Lessons are seeded as `scripts/schema/imports-seed.ts` declares; documents are made through the
 * gateway by a maintenance client (`zz-migrate`) and by a person's (`zz-plugin`), so their rows are the
 * ones the gateway and zz-core write. It calls the gateway's own built `lessonImports` and
 * `importedDocuments` (`services/gateway/dist/console/imports.js`) over them. What it establishes:
 *
 *   - an import day is a local day on which a shelf's successful `core:knowledge_add` calls with
 *     origin `platform` outnumber those with origin `work`, each answered with the counts it was
 *     decided on: refused calls are not counted, a tie is not one, a call asking `scope: platform`
 *     counts for the shared shelf and not the caller's, and the day is cut in the reporting timezone;
 *   - an import day's lessons on that shelf are its cohort, `by_day`, a lesson added by hand that day
 *     among them; a lesson made that day on another shelf is not;
 *   - a lesson whose `knowledge.add` event names it (`detail.ids.node`) is imported exactly when that
 *     event's origin is `platform`, whatever the day;
 *   - a document written only by a maintenance client is imported, one rewritten in place before it
 *     was shown and written again after it alike, a person's read of it and their refused edit not
 *     counting; a document written only as work is in no list, one whose draft three calls rewrote in
 *     place among them; a document whose writes were recorded under the retired `document_revise` and
 *     `document_patch` is told the same way; a document with no recorded write is unrecorded; one
 *     written both ways is mixed, its work write naming its path with a leading `/`; a source is never
 *     judged; the same initiative and path written by maintenance in another team is that team's;
 *   - adding an import adds it and nothing else to the rule's answer, and changes the inventories and
 *     no count of what a team made in a period; read at a cutoff before it, the rule answers what it
 *     answered before; a later work write makes an imported document mixed from that write on;
 *   - a cutoff that is not a time fails each function rather than answering nothing;
 *   - the rule's source names no text column: no title, body, subject or refusal.
 *
 * DELIBERATE: the reporting timezone is Asia/Singapore, eight hours ahead of UTC, and two of the
 * seed's maintenance calls fall on 20 September local and 19 September in UTC: a day cut on UTC's
 * calendar moves that import day and two of its lessons.
 *
 * DELIBERATE: the retired tools cannot be called any more, so their documents are written through
 * today's tools and the rows the gateway wrote for those calls are renamed to the retired tool keys:
 * the one direct write to the record beside the seeded lessons.
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

import { lastJson } from "@zz/mcp-client";
import type { Request, RequestHandler } from "express";
import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import {
  BEFORE_ADDED, EXPECTED, PERIOD, TIMEZONE, WREN, seedAddedImport, seedImports,
} from "../scripts/schema/imports-seed.ts";
import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";

const NAME = "console-imports";
const DONE = "console-imports: an import day is decided per shelf and local day from successful knowledge_add calls, " +
  "its lessons labelled by_day, a lesson its event names judged exactly by that event's origin, a document told by " +
  "every write that names it as imported, unrecorded or mixed, and an import added moves the inventories and the " +
  "cohort and no count of a team's own work: ok";

/** The client a maintenance command names itself, and the one a person's session does. */
const MAINTENANCE = "zz-migrate";
const WORK = "zz-plugin";
/** The second team, written to through a PAT bound to it. */
const TWO = "imports-two";

type Lesson = { id: string; shelf: string; basis: string };
type Day = { day: string; shelf: string; platform: number; work: number };
type DocRef = { docId: string; team: string; initiative: string; path: string };
type Told = { imported: DocRef[]; unrecorded: DocRef[]; mixed: DocRef[] };
const KINDS = ["imported", "unrecorded", "mixed"] as const;
/** A document as the check names it, `[team, initiative, path]`, and the three lists it expects. */
type Ref = [string, string, string];
type Wanted = Record<(typeof KINDS)[number], Ref[]>;
type Rule = {
  lessonImports: (asOf: string) => Promise<{ lessons: Lesson[]; days: Day[] }>;
  importedDocuments: (asOf: string) => Promise<Told>;
};

/** An item spelled with its keys sorted, so the order a statement names its columns in is no difference. */
const canonical = (x: unknown): unknown => Array.isArray(x) ? x.map(canonical)
  : x !== null && typeof x === "object" ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
  : x;
/** One sorted line per item, so two lists compare as sets and a difference prints readably. */
const lines = (items: readonly unknown[]): string[] => items.map((x) => JSON.stringify(canonical(x))).sort();
function same(c: Core, step: string, found: readonly unknown[], expected: readonly unknown[]): void {
  const f = lines(found), e = lines(expected);
  const missing = e.filter((x) => !f.includes(x)), extra = f.filter((x) => !e.includes(x));
  if (missing.length || extra.length || f.length !== e.length) {
    c.fail(step, `missing [${missing.join(", ")}], not expected [${extra.join(", ")}]`);
  }
}

/** The gateway's door to zz-core, as server.ts mounts it, a PAT of the seeded person's for each team,
 *  and the rule, loaded once the reporting timezone is set. */
interface Gateway { url: string; one: string; two: string; rule: Rule; stop(): Promise<void> }

async function listen(c: Core): Promise<Gateway> {
  // `withThrowawayDb` ended the gateway's pool after migrating; a fresh one on the same container, the
  // reporting timezone set before shared.js reads it at load.
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
  const rule = (await load("services/gateway/dist/console/imports.js")) as Rule;

  const app = express();
  // COUPLED: services/gateway/src/server.ts — the identity gate, the JSON parser, the telemetry on
  // the door and then the door's relay to zz-core, in the order server.ts mounts them.
  app.use(identityMiddleware());
  app.use(express.json({ limit: "20mb" }));
  app.use(["/core/mcp"], toolCallTelemetry((req) => doorSurface(req.originalUrl)));
  app.all("/core/mcp", passThrough(c.mcp.url, "core proxy", "zz-core is not reachable"));
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));

  // The seeded person is in a second team too; a PAT bound to it writes there.
  await c.sql.query(
    `with t as (insert into zz.team (slug, name, created_by) select $2, $2, id from zz.principal where email = $1 returning id)
     insert into zz.membership (team_id, principal_id, role, added_by)
     select t.id, p.id, 'admin', p.id from t, zz.principal p where p.email = $1`, [c.email, TWO]);
  const pat = async (team: string | null): Promise<string> => {
    const token = `zzp_${randomBytes(24).toString("hex")}`;
    await c.sql.query(
      `insert into zz.pat (principal_id, token_hash, team_id)
       select p.id, $2, (select id from zz.team where slug = $3::text) from zz.principal p where p.email = $1`,
      [c.email, createHash("sha256").update(token, "utf8").digest("hex"), team]);
    return token;
  };
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    one: await pat(null), two: await pat(TWO), rule,
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

/** How many `tool_call` rows the gateway has written: it writes each after the answer it describes. */
const calls = async (c: Core): Promise<number> =>
  (await c.sql.query<{ n: number }>("select count(*)::int as n from zz.event where kind = 'tool_call'")).rows[0].n;

/** Waits until the gateway has written `n` tool calls in all. */
async function settled(c: Core, step: string, n: number): Promise<void> {
  const until = Date.now() + 10_000;
  let seen = await calls(c);
  while (seen < n) {
    if (Date.now() > until) c.fail(step, `the gateway wrote ${seen} tool calls, not ${n}`);
    await new Promise((r) => setTimeout(r, 100));
    seen = await calls(c);
  }
}

/** A caller through the gateway: which client it names itself and which PAT it holds. */
interface Caller { client: string; token: string }

/** Tool calls through the gateway, counted so their rows can be waited for. */
function door(c: Core, g: Gateway) {
  let sent = 0;
  const call = async (step: string, as: Caller, name: string, args: Record<string, unknown>, refused?: RegExp): Promise<string> => {
    const res = await fetch(`${g.url}/core/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${as.token}`, "content-type": "application/json",
                 accept: "application/json, text/event-stream", "x-zz-client": as.client },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(60_000),
    });
    const raw = await res.text();
    sent++;
    const env = lastJson(raw);
    const reply = env?.result?.content?.map((p) => p.text ?? "").join("") ?? env?.error?.message ?? raw.slice(0, 300);
    const isRefusal = reply.startsWith("ERROR");
    if (res.status !== 200 || (refused ? !isRefusal || !refused.test(reply) : isRefusal)) {
      c.fail(step, `${name} as ${as.client} answered ${res.status}: ${reply.slice(0, 300)}`);
    }
    return reply;
  };
  return { call, sent: () => sent };
}

/** A document's revision count, by team, initiative and path. */
const revisionsOf = async (c: Core, team: string, initiative: string, path: string): Promise<number> =>
  (await c.sql.query<{ n: number }>(
    `select count(*)::int as n from zz.doc_revision r join zz.doc d on d.id = r.doc_id
       join zz.initiative i on i.id = d.initiative_id join zz.team t on t.id = i.team_id
      where t.slug = $1 and i.slug = $2 and d.path = $3`, [team, initiative, path])).rows[0].n;

/** The database's own clock, at full precision: a cutoff between two writes. */
async function instant(c: Core): Promise<string> {
  await new Promise((r) => setTimeout(r, 20));
  const at = (await c.sql.query<{ at: string }>("select now()::text as at")).rows[0].at;
  await new Promise((r) => setTimeout(r, 20));
  return at;
}

async function lessonCases(c: Core, rule: Rule): Promise<void> {
  const seeded = await seedImports(c.sql);
  const slugOf = new Map([...seeded.lessons].map(([slug, id]) => [id, slug]));
  const now = () => new Date().toISOString();
  const named = (ls: Lesson[]) => ls.map((l) => [slugOf.get(l.id) ?? `unseeded ${l.id}`, l.shelf, l.basis]);

  const before = await rule.lessonImports(now());
  same(c, "the import days", before.days, EXPECTED.days);
  c.pass("import days: 13 September on osprey decided 5 to 2 with 4 refused calls left out, 14 September on the shared shelf " +
         "3 to 0 from calls asking scope platform, 20 September on osprey 2 to 1 on local time; a tie, a work majority and " +
         "a caller's own shelf for a shared-shelf call are none");
  same(c, "the lessons imported", named(before.lessons), EXPECTED.lessons);
  c.pass("an import day's lessons on its shelf are its cohort, by_day, the one added by hand included; another shelf's " +
         "lesson that day is not; a lesson its event names is imported exactly when the event is platform, on any day");

  const counts = async (cohort: Lesson[]) => {
    const made = (await c.sql.query<{ id: string }>(
      `select n.id::text as id from zz.knowledge_node n join zz.team t on t.id = n.team_id
        where t.slug = $1 and n.created_at >= $2::timestamptz and n.created_at < $3::timestamptz`, [WREN, PERIOD.from, PERIOD.to])).rows;
    const out = new Set(cohort.map((l) => l.id));
    const inventory = (await c.sql.query<{ n: number }>(
      "select count(*)::int as n from zz.knowledge_node n join zz.team t on t.id = n.team_id where t.slug = $1", [WREN])).rows[0].n;
    return { inventory, made: made.filter((l) => !out.has(l.id)).length };
  };
  const was = await counts(before.lessons);
  same(c, "wren's lessons before the import is added", [was], [{ inventory: EXPECTED.inventory.before, made: EXPECTED.made }]);

  await seedAddedImport(c.sql, seeded);
  for (const [slug, id] of seeded.lessons) slugOf.set(id, slug);
  const after = await rule.lessonImports(now());
  same(c, "the import days once an import is added", after.days, [...EXPECTED.days, ...EXPECTED.added.days]);
  same(c, "the cohort once an import is added", named(after.lessons), [...EXPECTED.lessons, ...EXPECTED.added.lessons]);
  same(c, "wren's lessons once the import is added", [await counts(after.lessons)], [{ inventory: EXPECTED.inventory.after, made: EXPECTED.made }]);
  c.pass("adding an import adds its day and its four lessons to the rule's answer and to wren's inventory (10 to 14 lessons), " +
         "and leaves what wren made in October at 1 lesson");

  const earlier = await rule.lessonImports(new Date(BEFORE_ADDED).toISOString());
  same(c, "the import days at a cutoff before the added import", earlier.days, EXPECTED.days);
  same(c, "the cohort at a cutoff before the added import", named(earlier.lessons), EXPECTED.lessons);
  c.pass("read at a cutoff before the added import, the lesson rule answers what it answered before it was added");
}

async function documentCases(c: Core, g: Gateway): Promise<void> {
  const base = await calls(c);
  const d = door(c, g);
  const P: Caller = { client: MAINTENANCE, token: g.one }, W: Caller = { client: WORK, token: g.one };
  const P2: Caller = { client: MAINTENANCE, token: g.two };
  const I = await c.open("imports");
  const at = (p: string) => `${I}/${p}`;
  let step = "the documents written through the gateway";

  // Written only by maintenance: rewritten in place twice while a draft, shown, then written again.
  await d.call(step, P, "document_write", { path: at("imported.md"), content: "# Imported\n\none\n" });
  await d.call(step, P, "document_edit", { path: at("imported.md"), edits: [{ find: "one", replace: "two" }] });
  await d.call(step, P, "document_edit", { path: at("imported.md"), edits: [{ find: "two", replace: "three" }] });
  await d.call(step, P, "document_present", { path: at("imported.md") });
  await d.call(step, P, "document_edit", { path: at("imported.md"), edits: [{ find: "three", replace: "four" }] });
  await d.call(step, W, "document_read", { path: at("imported.md") });
  await d.call(step, W, "document_edit", { path: at("imported.md"), edits: [{ find: "absent", replace: "x" }] }, /^ERROR/);
  // Written only as work, a draft three calls rewrote in place.
  await d.call(step, W, "document_write", { path: at("work.md"), content: "# Work\n\none\n" });
  await d.call(step, W, "document_edit", { path: at("work.md"), edits: [{ find: "one", replace: "two" }] });
  await d.call(step, W, "document_edit", { path: at("work.md"), edits: [{ find: "two", replace: "three" }] });
  // Both ways, the work write naming its path with a leading `/`: read without it, the document is imported.
  await d.call(step, P, "document_write", { path: at("mixed.md"), content: "# Mixed\n\none\n" });
  await d.call(step, W, "document_edit", { path: `/${at("mixed.md")}`, edits: [{ find: "one", replace: "two" }] });
  // Under the retired names, once the rows are renamed below.
  for (const [path, as] of [["retired.md", P], ["retired-work.md", W]] as const) {
    await d.call(step, as, "document_write", { path: at(path), content: "# Retired\n\none\n" });
    await d.call(step, as, "document_edit", { path: at(path), edits: [{ find: "one", replace: "two" }] });
  }
  // A source a maintenance client filed, which is no flow document.
  await d.call(step, P, "source_add", { initiative: I, title: "Imported notes", content: "carried over" });
  // The same initiative and path in the second team, written by maintenance.
  const opened = JSON.parse(await d.call(step, P2, "initiative_open", { slug: "imports" })) as { initiative: string };
  if (opened.initiative !== I) c.fail(step, `the second team's initiative is ${opened.initiative}, not ${I}: the same path cannot be written`);
  await d.call(step, P2, "document_write", { path: at("work.md"), content: "# Theirs\n\none\n" });
  // No recorded write: made past the gateway, as the schema redesign's carry made thirteen.
  await c.ok(step, "document_write", { path: at("unrecorded.md"), content: "# Unrecorded\n\none\n" });
  await settled(c, step, base + d.sent());

  for (const [path, revisions] of [["imported.md", 2], ["work.md", 1]] as const) {
    const n = await revisionsOf(c, c.team, I, path);
    if (n !== revisions) c.fail(step, `${path} holds ${n} revisions, not ${revisions}: the draft was not rewritten in place as the case needs`);
  }
  const renamed = await c.sql.query(
    `update zz.event e set tool_key = case e.tool_key when 'core:document_write' then 'core:document_revise' else 'core:document_patch' end,
                           subject = case e.tool_key when 'core:document_write' then 'core:document_revise' else 'core:document_patch' end
      where e.kind = 'tool_call' and e.tool_key in ('core:document_write', 'core:document_edit')
        and e.detail -> 'ids' ->> 'path' in ($1, $2)`, [at("retired.md"), at("retired-work.md")]);
  if (renamed.rowCount !== 4) c.fail(step, `${renamed.rowCount} rows were renamed to the retired tools, not 4`);

  const ref = (team: string, path: string): Ref => [team, I, path];
  const expect = async (s: string, told: Told, wanted: Wanted) => {
    for (const k of KINDS) same(c, `${s}: ${k}`, told[k].map((r) => [r.team, r.initiative, r.path]), wanted[k]);
    for (const r of [...told.imported, ...told.unrecorded, ...told.mixed]) {
      const id = (await c.sql.query<{ id: string }>(
        `select d.id::text as id from zz.doc d join zz.initiative i on i.id = d.initiative_id join zz.team t on t.id = i.team_id
          where t.slug = $1 and i.slug = $2 and d.path = $3`, [r.team, r.initiative, r.path])).rows[0]?.id;
      if (r.docId !== id) c.fail(s, `${r.team} ${r.initiative}/${r.path} answers document ${r.docId}, not ${id}`);
    }
  };

  step = "the documents told";
  const RECORD: Wanted = {
    imported: [ref(c.team, "imported.md"), ref(c.team, "retired.md"), ref(TWO, "work.md")],
    unrecorded: [ref(c.team, "unrecorded.md")],
    mixed: [ref(c.team, "mixed.md")],
  };
  const first = await instant(c);
  await expect(step, await g.rule.importedDocuments(first), RECORD);
  c.pass("written only by maintenance is imported, rewritten in place and written again after it was shown, a person's read " +
         "and refused edit not counting; written only as work is in no list, a draft three calls rewrote in place; the retired " +
         "names are told the same way; no recorded write is unrecorded; both ways is mixed, the work write's path sent with a " +
         "leading slash; a " +
         "source is never judged; the same path written by maintenance in another team is that team's import");

  step = "an import added";
  const made = async (told: Told) => {
    const out = new Set([...told.imported, ...told.unrecorded].map((r) => r.docId));
    const rows = (await c.sql.query<{ doc: string }>(
      `select r.doc_id::text as doc from zz.doc_revision r join zz.doc d on d.id = r.doc_id
         join zz.initiative i on i.id = d.initiative_id join zz.team t on t.id = i.team_id
        where t.slug = $1 and d.path not like 'sources/%'`, [c.team])).rows;
    const inventory = (await c.sql.query<{ n: number }>(
      `select count(*)::int as n from zz.doc d join zz.initiative i on i.id = d.initiative_id join zz.team t on t.id = i.team_id
        where t.slug = $1 and d.path not like 'sources/%'`, [c.team])).rows[0].n;
    return { inventory, revisions: rows.filter((r) => !out.has(r.doc)).length };
  };
  same(c, step, [await made(await g.rule.importedDocuments(first))], [{ inventory: 6, revisions: 3 }]);
  await d.call(step, P, "document_write", { path: at("added.md"), content: "# Added\n\none\n" });
  await settled(c, step, base + d.sent());
  const added = await instant(c);
  const ADDED: Wanted = { ...RECORD, imported: [...RECORD.imported, ref(c.team, "added.md")] };
  await expect(step, await g.rule.importedDocuments(added), ADDED);
  same(c, step, [await made(await g.rule.importedDocuments(added))], [{ inventory: 7, revisions: 3 }]);
  c.pass("adding a document written by maintenance adds it to the imports and nothing else, and moves the team's inventory " +
         "from 6 to 7 documents and its revisions written as work not at all, 3 before and after");

  step = "a cutoff before a write";
  await d.call(step, W, "document_edit", { path: at("imported.md"), edits: [{ find: "four", replace: "five" }] });
  await settled(c, step, base + d.sent());
  await expect(step, await g.rule.importedDocuments(await instant(c)),
    { ...ADDED, imported: ADDED.imported.filter((r) => r[2] !== "imported.md"), mixed: [...ADDED.mixed, ref(c.team, "imported.md")] });
  await expect(step, await g.rule.importedDocuments(added), ADDED);
  await expect(step, await g.rule.importedDocuments(first), RECORD);
  c.pass("a later work write makes an imported document mixed from that write on; read at a cutoff before it the rule answers " +
         "imported, and before the added import it answers the record without the document made after the cutoff");
}

async function run(c: Core): Promise<void> {
  const g = await listen(c);
  try {
    await lessonCases(c, g.rule);
    await documentCases(c, g);

    const step = "a query that fails";
    for (const [name, call] of [["lessonImports", () => g.rule.lessonImports("not a time")],
                                ["importedDocuments", () => g.rule.importedDocuments("not a time")]] as const) {
      const failed = await call().then(() => false, () => true);
      if (!failed) c.fail(step, `${name}("not a time") answered instead of failing`);
    }
    c.pass("a cutoff that is not a time fails each function rather than answering nothing");

    const source = readFileSync(join(root, "services", "gateway", "src", "console", "imports.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const read = ["title", "body", "subject", "refusal"].filter((w) => new RegExp(`\\b${w}\\b`).test(source));
    if (read.length) c.fail("the rule reads no text", `imports.ts names ${read.join(", ")} outside its comments`);
    c.pass("the rule's statements name no title, body, subject or refusal");
  } finally {
    await g.stop();
  }
}

process.exitCode = await withThrowawayCore(NAME, DONE, run);
