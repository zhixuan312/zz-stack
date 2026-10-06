#!/usr/bin/env node
/**
 * A document body is stored whole, or refused — never stored shortened.
 *
 * `saveDocument` cut every body at 200,000 characters (`.slice(0, 200_000)`, a search-index cap
 * from the file store that became the stored bytes when documents moved into rows). The write
 * answered success, `content_hash` hashed the whole text, and the rows held a prefix: 37 revisions
 * on the deployment end at exactly 200,000 characters, and two reports (bugs 6a05dd64 and 560b5e26)
 * found plans missing their last phases and their `## Full-suite gate` only by comparing lengths.
 *
 * Driven through the real `saveDocument` over a stubbed `pg.Pool` that records every statement:
 *
 *   1. a 250,000-character body lands whole in the `zz.doc` insert AND the `zz.doc_revision`
 *      insert — the revision is the record, and the projection is what search reads;
 *   2. a body past `MAX_INPUT_BYTES` is refused with a sentence naming the limit, and no
 *      statement that writes anything ran.
 *
 * Run: node checks/document-body-whole.ts   (also run by scripts/gate.ts)
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import pg from "pg";

process.env.ZZ_CATALOG_DIR = join(process.cwd(), "catalog");
process.env.TEAM_DB_URL = "postgresql://stub@127.0.0.1:1/stub";

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

/** Every statement the write ran, with its parameters. */
let seen: { sql: string; values: unknown[] }[] = [];
const answer = (text: string, values: unknown[] = []) => {
  const sql = String(text).replace(/\s+/g, " ").trim();
  seen.push({ sql, values });
  const one = (rows: Record<string, unknown>[]) => ({ rows, rowCount: rows.length });
  if (/^select i\.id::text as id from zz\.initiative i/.test(sql)) return one([{ id: "i1" }]);
  if (/from zz\.principal where lower\(email\)/.test(sql)) return one([{ id: "p1" }]);
  if (/^insert into zz\.doc \(/.test(sql)) return one([{ id: "d1" }]);
  return one([]);
};
pg.Pool.prototype.query = (async function query(text: string, values?: unknown[]) {
  return answer(text, values);
}) as unknown as typeof pg.Pool.prototype.query;
pg.Pool.prototype.connect = (async function connect() {
  return { query: async (text: string, values?: unknown[]) => answer(text, values), release() {} };
}) as unknown as typeof pg.Pool.prototype.connect;

const { saveDocument } = await import(
  pathToFileURL(join(process.cwd(), "services/zz-core/dist/document-save.js")).href);
const { MAX_INPUT_BYTES } = await import(
  pathToFileURL(join(process.cwd(), "packages/indexing/dist/index.js")).href);

const INIT = "2026-09-29-whole";
const write = (body: string) => saveDocument({
  team: "t1", relPath: `${INIT}/plan.md`, initiative: INIT, by: "ada@zz.test",
  text: `---\ntitle: Plan\n---\n\n${body}\n`,
});
/** Whether a statement matching `re` was handed `body` whole as one of its parameters — up to the
 *  surrounding whitespace the envelope's stamping leaves around a body. */
const handed = (re: RegExp, body: string) =>
  seen.some((s) => re.test(s.sql) && s.values.some((v) => typeof v === "string" && v.trim() === body.trim()));

// 1. Past the old cut, under the limit: every character is stored, in both rows.
{
  seen = [];
  const lines = ["# Plan", ""];
  for (let i = 0; lines.join("\n").length < 250_000; i++) lines.push(`Task ${i}: build the part numbered ${i}.`);
  lines.push("", "## Full-suite gate", "", "npm run gate");
  const body = lines.join("\n");
  const got = await write(body);
  is(!("refusal" in got), `a ${body.length}-character body was refused: ${JSON.stringify(got)}`);
  is(handed(/^insert into zz\.doc \(/, body), `zz.doc was not handed the whole ${body.length}-character body`);
  is(handed(/^insert into zz\.doc_revision\b/, body),
     `zz.doc_revision was not handed the whole ${body.length}-character body`);
  // The write's journal entry is fire-and-forget: let it land before the next case reads `seen`.
  await new Promise((r) => setTimeout(r, 50));
}

// 2. Past the limit: refused by name, and nothing was written.
{
  seen = [];
  const body = "word ".repeat(Math.ceil((MAX_INPUT_BYTES + 1024) / 5));
  const got = await write(body);
  const refusal = "refusal" in got ? String(got.refusal) : "";
  is(/MiB/.test(refusal) && /nothing was written/.test(refusal),
     `a ${body.length}-byte body was not refused by the limit: ${JSON.stringify(got).slice(0, 200)}`);
  const wrote = seen.filter((s) => /^(insert into|update|delete from) zz\.doc/.test(s.sql));
  is(wrote.length === 0, `a refused body still wrote: ${wrote.map((s) => s.sql.slice(0, 60)).join(" | ")}`);
}

// 3. Citing more documents does not cost more lookups. One statement resolves every path a
//    revision names, however many it names; it was a `documentAt` per citation, 2.1 ms each and
//    sequential, so a write citing ten documents paid ~21 ms of round trips before its own commit.
//    Asserted as a COMPARISON rather than a number, so it pins the shape and not one implementation:
//    the write's own lookups are counted in both runs and only the difference would move.
{
  const withCites = async (n: number) => {
    seen = [];
    const got = await saveDocument({
      team: "t1", relPath: `${INIT}/plan.md`, initiative: INIT, by: "ada@zz.test",
      text: "---\ntitle: Plan\n---\n\na plan citing sources\n",
      cites: Array.from({ length: n }, (_, i) => ({ path: `${INIT}/sources/s${i}.md`, revision: 1 })),
    });
    await new Promise((r) => setTimeout(r, 50));
    return { got, lookups: seen.filter((s) => /from zz\.doc d\b/.test(s.sql)).length };
  };
  const one = await withCites(1);
  const four = await withCites(4);
  is(!("refusal" in four.got), `a write citing four documents was refused: ${JSON.stringify(four.got)}`);
  is(one.lookups === four.lookups,
     `citing four documents cost ${four.lookups} lookups of zz.doc against ${one.lookups} for one — a ` +
     "cited document is resolved once per write, not once per citation");
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("ok document-body-whole");
