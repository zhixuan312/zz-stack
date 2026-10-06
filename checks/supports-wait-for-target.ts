#!/usr/bin/env node
/**
 * A support named before its document exists is linked when that document is written.
 *
 * A `supports` link is a `doc_link` row and needs its target's row, so a source naming a document
 * not yet written filed nothing — and round 1 of a review is recorded before review.md exists by
 * design. The support was lost outright: `reviewRounds` counted no round (bug c92d1bb1), and the
 * material was never listed behind the document once it was written.
 *
 *   1. the real `sourceDocument` keeps what the caller declared, as the envelope's `supports`;
 *   2. the real `saveDocument`, creating a document, files the links waiting for it: one
 *      `doc_link` insert of kind `supports`, keyed by the new row's id, its initiative and its name.
 *
 * The SQL's own reading of the declaration — `string_to_array(replace(…, ' ', ''), ',')` over
 * `fields->>'supports'` — was checked against production rows declaring "explore.md, spec.md";
 * this pins that the statement runs, with the name it has to match.
 *
 * Run: node checks/supports-wait-for-target.ts   (also run by scripts/gate.ts)
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import pg from "pg";

process.env.ZZ_CATALOG_DIR = join(process.cwd(), "catalog");
process.env.TEAM_DB_URL = "postgresql://stub@127.0.0.1:1/stub";

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

const seen: { sql: string; values: unknown[] }[] = [];
const answer = (text: string, values: unknown[] = []) => {
  const sql = String(text).replace(/\s+/g, " ").trim();
  seen.push({ sql, values });
  const one = (rows: Record<string, unknown>[]) => ({ rows, rowCount: rows.length });
  if (/^select i\.id::text as id from zz\.initiative i/.test(sql)) return one([{ id: "i1" }]);
  if (/from zz\.principal where lower\(email\)/.test(sql)) return one([{ id: "p1" }]);
  if (/^insert into zz\.doc \(/.test(sql)) return one([{ id: "d-review" }]);
  return one([]);
};
pg.Pool.prototype.query = (async function query(text: string, values?: unknown[]) {
  return answer(text, values);
}) as unknown as typeof pg.Pool.prototype.query;
pg.Pool.prototype.connect = (async function connect() {
  return { query: async (text: string, values?: unknown[]) => answer(text, values), release() {} };
}) as unknown as typeof pg.Pool.prototype.connect;

const { sourceDocument } = await import(
  pathToFileURL(join(process.cwd(), "services/zz-core/dist/indexing.js")).href);
const { saveDocument } = await import(
  pathToFileURL(join(process.cwd(), "services/zz-core/dist/document-save.js")).href);

// 1. The declaration survives into the envelope.
const source = sourceDocument({ title: "Review round 1", by: "ada@zz.test", day: "2026-09-30",
  content: "notes", stage: "sdlc-review", supports: ["review.md", "plan.md"] });
is(/^supports: review\.md, plan\.md$/m.test(source),
   `the source envelope does not carry the declared supports: ${source.split("\n---")[0]}`);

// 2. Creating review.md files the links that were waiting for it.
const INIT = "2026-09-30-waiting";
const made = await saveDocument({ team: "t1", relPath: `${INIT}/review.md`, initiative: INIT,
  by: "ada@zz.test", text: "---\ntitle: Review\n---\n\n# Review\n", mode: "create" });
is(!("refusal" in made), `creating review.md was refused: ${JSON.stringify(made)}`);
const link = seen.find((s) => /^insert into zz\.doc_link .* 'supports'/.test(s.sql) &&
  /fields->>'supports'/.test(s.sql));
is(link, "creating a document filed no supports link from the sources waiting for it");
is(link && link.values[0] === "d-review" && link.values[1] === "i1" && link.values[2] === "review.md",
   `the waiting links were keyed wrong: ${JSON.stringify(link?.values)}`);

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("ok supports-wait-for-target");
