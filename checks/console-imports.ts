#!/usr/bin/env node
/**
 * checks/console-imports.ts — one rule tells an import from a team's own work, for lessons and for
 * documents (AC-2.11).
 *
 *   node checks/console-imports.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL migrated by the real runner (`withThrowawayDb`), seeds the record
 * `scripts/schema/imports-seed.ts` declares, and calls the gateway's own built `lessonImports` and
 * `importedRevisions` (`services/gateway/dist/console/imports.js`) over it. What it establishes:
 *
 *   - an import day is a local day on which a shelf's successful `core:knowledge_add` calls with
 *     origin `platform` outnumber those with origin `work`, each answered with the counts it was
 *     decided on: refused calls are not counted, a tie is not one, a call asking `scope: platform`
 *     counts for the shared shelf and not the caller's, and the day is cut in the reporting timezone;
 *   - an import day's lessons on that shelf are its cohort, `by_day`, a lesson added by hand that day
 *     among them; a lesson made that day on another shelf is not;
 *   - a lesson whose `knowledge.add` event names it (`detail.ids.node`) is imported exactly when that
 *     event's origin is `platform`, whatever the day: `exact` on a day that is no import day, and left
 *     out on a day that is one when the event is `work`;
 *   - a document's revisions are matched to the successful `core:document_write` and
 *     `core:document_edit` calls naming its path in its team, in the order they were made: the
 *     revision a maintenance call wrote is imported, the creating one and a later one alike, while
 *     revisions written as work, a refused write, a read of the path and the same path in another
 *     team are not;
 *   - adding an import changes the inventories and the cohort by exactly what it added, and no count
 *     of what a team made in a period; read at a cutoff before it, the rule answers what it answered
 *     before it was added;
 *   - a cutoff that is not a time fails each function rather than answering nothing;
 *   - the rule's source names no text column: no title, body, subject or refusal.
 *
 * DELIBERATE: the reporting timezone is Asia/Singapore, eight hours ahead of UTC, and two of the
 * seed's maintenance calls fall on 20 September local and 19 September in UTC: a day cut on UTC's
 * calendar moves that import day and two of its lessons.
 *
 * The only database it touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import {
  BEFORE_ADDED, EXPECTED, PERIOD, TIMEZONE, WREN, seedAddedImport, seedImports,
} from "../scripts/schema/imports-seed.ts";
import { withThrowawayDb } from "../scripts/schema/throwaway.ts";

const NAME = "console-imports";
const DONE = "console-imports: an import day is decided per shelf and local day from successful knowledge_add calls, " +
  "its lessons labelled by_day, a lesson its event names judged exactly by that event's origin, a document's " +
  "revisions by the write that made each, and an import added moves the inventories and the cohort and no count " +
  "of a team's own work: ok";

class CaseFailure extends Error {}
function fail(step: string, detail: string): never {
  throw new CaseFailure(`${NAME}: FAILED at "${step}": ${detail}`);
}
const pass = (line: string): void => console.log(`  ok  ${line}`);

type Lesson = { id: string; shelf: string; basis: string };
type Day = { day: string; shelf: string; platform: number; work: number };
type Revision = { docId: string; team: string; initiative: string; path: string; revision: number };
type Rule = {
  lessonImports: (asOf: string) => Promise<{ lessons: Lesson[]; days: Day[] }>;
  importedRevisions: (asOf: string) => Promise<Revision[]>;
};

/** An item spelled with its keys sorted, so the order a statement names its columns in is no difference. */
const canonical = (x: unknown): unknown => Array.isArray(x) ? x.map(canonical)
  : x !== null && typeof x === "object" ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
  : x;
/** One sorted line per item, so two lists compare as sets and a difference prints readably. */
const lines = (items: readonly unknown[]): string[] => items.map((x) => JSON.stringify(canonical(x))).sort();
function same(step: string, found: readonly unknown[], expected: readonly unknown[]): void {
  const f = lines(found), e = lines(expected);
  const missing = e.filter((x) => !f.includes(x)), extra = f.filter((x) => !e.includes(x));
  if (missing.length || extra.length || f.length !== e.length) {
    fail(step, `missing [${missing.join(", ")}], not expected [${extra.join(", ")}]`);
  }
}

async function run(sql: pg.Client, url: string): Promise<void> {
  const seeded = await seedImports(sql);
  const slugOf = new Map([...seeded.lessons].map(([slug, id]) => [id, slug]));

  // `withThrowawayDb` ended the gateway's pool after migrating; a fresh one on the same container, the
  // reporting timezone set before shared.js reads it at load.
  process.env.TEAM_DB_URL = url;
  process.env.ZZ_TZ = TIMEZONE;
  const load = (p: string) => import(pathToFileURL(join(root, p)).href);
  const db = (await load("services/gateway/dist/db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await db.initPlatformDb();
  const rule = (await load("services/gateway/dist/console/imports.js")) as Rule;
  const now = () => new Date().toISOString();
  const named = (ls: Lesson[]) => ls.map((l) => [slugOf.get(l.id) ?? `unseeded ${l.id}`, l.shelf, l.basis]);
  const revisions = (rs: Revision[]) => rs.map((r) => [r.team, r.initiative, r.path, r.revision]);

  try {
    const before = await rule.lessonImports(now());
    same("the import days", before.days, EXPECTED.days);
    pass("import days: 13 September on osprey decided 5 to 2 with 4 refused calls left out, 14 September on the shared shelf " +
         "3 to 0 from calls asking scope platform, 20 September on osprey 2 to 1 on local time; a tie, a work majority and " +
         "a caller's own shelf for a shared-shelf call are none");
    same("the lessons imported", named(before.lessons), EXPECTED.lessons);
    pass("an import day's lessons on its shelf are its cohort, by_day, the one added by hand included; another shelf's " +
         "lesson that day is not; a lesson its event names is imported exactly when the event is platform, on any day");
    const revisionsBefore = await rule.importedRevisions(now());
    same("the revisions imported", revisions(revisionsBefore), EXPECTED.revisions);
    for (const r of revisionsBefore) {
      const id = (await sql.query<{ id: string }>(
        `select d.id::text as id from zz.doc d join zz.initiative i on i.id = d.initiative_id join zz.team t on t.id = i.team_id
          where t.slug = $1 and i.slug = $2 and d.path = $3`, [r.team, r.initiative, r.path])).rows[0]?.id;
      if (r.docId !== id) fail("the revisions imported", `${r.team} ${r.initiative}/${r.path} answers document ${r.docId}, not ${id}`);
    }
    pass("a document's revisions written by maintenance are imported, the creating one and a later one, by its own document; " +
         "work revisions, a refused write, a read and the same path in another team are not");

    const counts = async (cohort: Lesson[], imported: Revision[]) => {
      const lessons = (await sql.query<{ id: string; at: string }>(
        `select n.id::text as id, n.created_at::text as at from zz.knowledge_node n join zz.team t on t.id = n.team_id
          where t.slug = $1 and n.created_at >= $2::timestamptz and n.created_at < $3::timestamptz`, [WREN, PERIOD.from, PERIOD.to])).rows;
      const written = (await sql.query<{ doc: string; revision: number }>(
        `select r.doc_id::text as doc, r.revision from zz.doc_revision r join zz.doc d on d.id = r.doc_id
           join zz.initiative i on i.id = d.initiative_id join zz.team t on t.id = i.team_id
          where t.slug = $1 and r.written_at >= $2::timestamptz and r.written_at < $3::timestamptz`, [WREN, PERIOD.from, PERIOD.to])).rows;
      const out = new Set(cohort.map((l) => l.id));
      const left = new Set(imported.map((r) => `${r.docId}#${r.revision}`));
      const inventory = (await sql.query<{ lessons: number; documents: number }>(
        `select (select count(*) from zz.knowledge_node n join zz.team t on t.id = n.team_id where t.slug = $1)::int as lessons,
                (select count(*) from zz.doc d join zz.initiative i on i.id = d.initiative_id join zz.team t on t.id = i.team_id
                  where t.slug = $1)::int as documents`, [WREN])).rows[0];
      return {
        inventory,
        made: { lessons: lessons.filter((l) => !out.has(l.id)).length, revisions: written.filter((w) => !left.has(`${w.doc}#${w.revision}`)).length },
      };
    };
    const was = await counts(before.lessons, revisionsBefore);
    same("wren's inventories before the import is added", [was.inventory], [EXPECTED.inventory.before]);
    same("what wren made in October before the import is added", [was.made], [EXPECTED.made]);

    await seedAddedImport(sql, seeded);
    for (const [slug, id] of seeded.lessons) slugOf.set(id, slug);
    const after = await rule.lessonImports(now());
    const revisionsAfter = await rule.importedRevisions(now());
    same("the import days once an import is added", after.days, [...EXPECTED.days, ...EXPECTED.added.days]);
    same("the cohort once an import is added", named(after.lessons), [...EXPECTED.lessons, ...EXPECTED.added.lessons]);
    same("the revisions imported once an import is added", revisions(revisionsAfter), [...EXPECTED.revisions, ...EXPECTED.added.revisions]);
    const is = await counts(after.lessons, revisionsAfter);
    same("wren's inventories once the import is added", [is.inventory], [EXPECTED.inventory.after]);
    same("what wren made in October once the import is added", [is.made], [EXPECTED.made]);
    pass("adding an import adds its day, its four lessons and its document's revision to the rule's answer and to wren's " +
         "inventories (10 to 14 lessons, 2 to 3 documents), and leaves what wren made in October at 1 lesson and 1 revision");

    const earlier = await rule.lessonImports(new Date(BEFORE_ADDED).toISOString());
    same("the import days at a cutoff before the added import", earlier.days, EXPECTED.days);
    same("the cohort at a cutoff before the added import", named(earlier.lessons), EXPECTED.lessons);
    same("the revisions at a cutoff before the added import",
         revisions(await rule.importedRevisions(new Date(BEFORE_ADDED).toISOString())), EXPECTED.revisions);
    pass("read at a cutoff before the added import, the rule answers what it answered before it was added");

    for (const [name, call] of [["lessonImports", () => rule.lessonImports("not a time")],
                                ["importedRevisions", () => rule.importedRevisions("not a time")]] as const) {
      const failed = await call().then(() => false, () => true);
      if (!failed) fail("a query that fails", `${name}("not a time") answered instead of failing`);
    }
    pass("a cutoff that is not a time fails each function rather than answering nothing");

    const source = readFileSync(join(root, "services", "gateway", "src", "console", "imports.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const read = ["title", "body", "subject", "refusal"].filter((w) => new RegExp(`\\b${w}\\b`).test(source));
    if (read.length) fail("the rule reads no text", `imports.ts names ${read.join(", ")} outside its comments`);
    pass("the rule's statements name no title, body, subject or refusal");
  } finally {
    await db.platformDb().end().catch(() => undefined);
    delete process.env.TEAM_DB_URL;
    delete process.env.ZZ_TZ;
  }
}

let url = "";
try {
  await withThrowawayDb((sql) => run(sql, url), async (u) => { url = u; });
  console.log(DONE);
} catch (err) {
  if (err instanceof CaseFailure) { console.error(err.message); process.exitCode = 1; }
  else if (/Docker is not running/.test(String(err))) {
    console.error(`${NAME}: Docker is not available — the check could not run, which is not a pass`);
    process.exitCode = 2;
  } else { console.error(`${NAME}: FAILED — ${err instanceof Error ? err.stack : String(err)}`); process.exitCode = 1; }
}
