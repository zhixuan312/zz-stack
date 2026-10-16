#!/usr/bin/env node
// `checks/schema-inventory.ts` compares each table's comments against the target's, so it proves
// a comment is WELL-FORMED and never that one is MISSING. That is the property this asserts, and
// the reason it is a separate check: a column that carries no `columnComments` entry at all is
// invisible to a comparison of the entries that do.
//
// It is also the only thing that reads the SHAPE of a target comment. `scripts/schema/compare.ts`
// holds the target and the migrated catalog to each other, so drift between them is refused — but
// two comments that AGREE can both break the standard, and nothing in a comparison can see that.
// These rules lived in `scripts/schema/comments.ts`, which rendered the target's comments into
// `COMMENT ON` statements; that rendering has run, its output is folded into `001_init.sql`, and
// the file was dead. The rendering was redundant, the ASSERTIONS were not, so they moved here —
// this reads `schema-target.ts` directly and renders nothing.
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { SCHEMA_TARGET } = await import(pathToFileURL(join(process.cwd(), "schema-target.ts")).href);

/** The six classes `SCHEMA.md` fixes. A comment naming a seventh is not one this standard can
 *  read, and it is exactly what a comparison cannot catch: it proves the two agree, never that
 *  either is one of the six. */
const CLASSES = ["current_state", "immutable_history", "state_machine", "relation", "ephemeral", "projection"];

type T = { comment?: string | null; columns?: [string, ...unknown[]][]; columnComments?: Record<string, string> };
const tables = (SCHEMA_TARGET.tables ?? {}) as Record<string, T>;

/** The keys `SCHEMA.md`'s template fixes, in the order it writes them. A comment is
 *  `class=…; authority=…; question=<one sentence>` and then the tails its class takes. */
const KEYS = ["class", "authority", "question", "transitions", "rebuilt_from", "retention"] as const;

/** The `key=value` each key carries, or undefined when the comment does not carry it.
 *
 *  NOT a split on `;` — and that is the whole reason this is a function rather than a one-line
 *  regex. `question` is `<one sentence>`, and a sentence may contain a semicolon: `zz.event.detail`
 *  asks about "section headings, cause paths, normalisations and diagnostics; on a document.refused
 *  row ...; and on a document.shown or document.shown_part row ...", which a split on `; ` cuts in
 *  half so that the question reads as ending mid-clause. The parser this replaced — in the
 *  now-deleted `scripts/schema/comments.ts` — did exactly that, so its `question` rule was red
 *  against a target that was in fact correct, and being dead nobody ever saw it.
 *
 *  So a field starts at the string's own start or after `; `, and a value runs to wherever the
 *  NEXT known key starts, less the `; ` that separates them. A `; ` inside a sentence is inside
 *  the value, which is what the template means by `<one sentence>`. */
function fields(comment: string): Record<string, string> {
  const hits: { key: string; at: number; valueAt: number }[] = [];
  for (const key of KEYS) {
    for (const m of comment.matchAll(new RegExp(`(?:^|; )${key}=`, "g"))) {
      hits.push({ key, at: m.index, valueAt: m.index + m[0].length });
    }
  }
  hits.sort((a, b) => a.at - b.at);
  const out: Record<string, string> = {};
  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1].at : comment.length;
    out[hits[i].key] = comment.slice(hits[i].valueAt, end).replace(/; $/, "");
  }
  return out;
}

/** Every way one comment can fail the contract, as whole sentences naming what is wrong.
 *  `allow` is the tail keys this comment's own class takes — read from its class rather than
 *  guessed, so a comment with no readable class is reported once rather than argued about. */
function faults(what: string, comment: string | null | undefined, allow: readonly string[]): string[] {
  const bad: string[] = [];
  if (comment === undefined || comment === null || comment.trim() === "") return [`${what} carries no comment`];
  const f = fields(comment);
  if (comment.includes("\n")) bad.push(`${what} spans more than one line`);
  const cls = f.class;
  if (!cls) bad.push(`${what} states no class`);
  else if (!CLASSES.includes(cls)) bad.push(`${what} names class=${cls}, which is not one of the six`);
  if (f.authority === undefined) bad.push(`${what} names no authority`);
  const question = f.question;
  if (!question) bad.push(`${what} asks no question`);
  else if (!question.endsWith("?")) bad.push(`${what} asks a question that does not end in ?`);
  for (const key of ["transitions", "rebuilt_from", "retention"]) {
    if (f[key] !== undefined && !allow.includes(key)) {
      bad.push(`${what} carries ${key}=, which its class does not take`);
    }
  }
  return bad;
}

const missing: string[] = [];
let columns = 0, comments = 0;

for (const name of Object.keys(tables).sort()) {
  const t = tables[name];
  const c = t.comment;
  // The whole shape, not its first token: a table comment that stops at `class=` names no
  // authority and asks no question, which is the standard's first requirement.
  if (!c || !/class=/.test(c) || !/authority=/.test(c) || !/question=/.test(c)) {
    missing.push(`${name}: table comment is absent or incomplete`);
  }
  const tableClass = fields(c ?? "").class;
  // A table's allowed tails follow from its own class. `retention` is allowed on every class:
  // one class makes it MANDATORY (ephemeral) and rule 9 makes it mandatory for an unbounded
  // table, which is `immutable_history`'s own shape — `zz.event` is the case the rule exists for.
  const allow = ["retention",
    ...(tableClass === "state_machine" ? ["transitions"] : []),
    ...(tableClass === "projection" ? ["rebuilt_from"] : [])];
  missing.push(...faults(`table ${name}`, c, allow));
  const tableFields = fields(c ?? "");
  if (tableFields.authority !== "this") {
    missing.push(`table ${name} does not name itself as its authority — the table template fixes authority=this`);
  }
  if (tableClass === "state_machine" && !/transitions=/.test(c ?? "")) missing.push(`${name}: state_machine names no transitions`);
  if (tableClass === "projection" && !tableFields.rebuilt_from) {
    missing.push(`table ${name} is a projection and names no rebuilt_from`);
  }
  if (tableClass === "ephemeral" && !tableFields.retention) {
    missing.push(`table ${name} is ephemeral and names no retention`);
  }
  // And a table that calls ITSELF unbounded names its retention too — rule 9's other half, which
  // was prose nothing read. Most `immutable_history` tables are bounded by their subject (one row
  // per revision, per run), so the class cannot decide this; a comment that says "unbounded" can,
  // and a table nobody can bound is exactly the one that has to say what happens to it.
  if (/\bunbounded\b/.test(c ?? "") && !tableFields.retention) {
    missing.push(`table ${name} says it is unbounded and names no retention`);
  }

  for (const [col] of t.columns ?? []) {
    columns++;
    const cc = t.columnComments?.[col];
    if (!cc || !/class=/.test(cc) || !/authority=/.test(cc) || !/question=/.test(cc)) {
      missing.push(`${name}.${col}: column comment is absent or incomplete`);
    } else { comments++; }
    const colFields = fields(cc ?? "");
    const colClass = colFields.class;
    const auth = colFields.authority;
    missing.push(...faults(`column ${name}.${col}`, cc,
      colClass === "projection" ? ["rebuilt_from"] : []));
    if (colClass === "projection" && !/rebuilt_from=/.test(cc ?? "")) missing.push(`${name}.${col}: projection names no rebuild source`);
    // Authority on a column is itself the projection marker: a projection points at the table it
    // is rebuilt from, and every other column is its own authority. Saying `authority=this` on a
    // projection, or naming anything else without being one, is a comment arguing with itself.
    if (colClass === "projection" && auth === "this") {
      missing.push(`column ${name}.${col} is a projection and names itself as its authority`);
    }
    if (colClass !== undefined && colClass !== "projection" && auth !== undefined && auth !== "this") {
      missing.push(`column ${name}.${col} names authority=${auth} without being a projection`);
    }
  }
}

assert.deepEqual(missing.slice(0, 20), [], `${missing.length} table(s) or column(s) carry no usable comment`);
assert.equal(comments, columns, "every column carries a comment");
assert.ok(comments > 400, "and there are columns to comment, so this is not vacuously true");

console.log(`ok comment-completeness (${comments} columns commented)`);
