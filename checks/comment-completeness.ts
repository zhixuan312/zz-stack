#!/usr/bin/env node
// `checks/schema-inventory.ts` compares each table's comments against the target's, so it proves
// a comment is WELL-FORMED and never that one is MISSING. That is the property this asserts, and
// the reason it is a separate check: a column that carries no `columnComments` entry at all is
// invisible to a comparison of the entries that do.
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { SCHEMA_TARGET } = await import(pathToFileURL(join(process.cwd(), "schema-target.ts")).href);
type T = { comment?: string | null; columns?: [string, ...unknown[]][]; columnComments?: Record<string, string> };
const tables = (SCHEMA_TARGET.tables ?? {}) as Record<string, T>;

const missing: string[] = [];
let columns = 0, comments = 0;

for (const [name, t] of Object.entries(tables)) {
  const c = t.comment;
  // The whole shape, not its first token: a table comment that stops at `class=` names no
  // authority and asks no question, which is the standard's first requirement.
  if (!c || !/class=/.test(c) || !/authority=/.test(c) || !/question=/.test(c)) {
    missing.push(`${name}: table comment is absent or incomplete`);
  }
  if (c && /class=state_machine/.test(c) && !/transitions=/.test(c)) missing.push(`${name}: state_machine names no transitions`);
  if (c && /class=(ephemeral|projection)/.test(c) && !/retention=|rebuilt_from=/.test(c)) {
    missing.push(`${name}: ephemeral/projection declares no retention or rebuild source`);
  }

  for (const [col] of t.columns ?? []) {
    columns++;
    const cc = t.columnComments?.[col];
    if (!cc || !/class=/.test(cc) || !/authority=/.test(cc) || !/question=/.test(cc)) {
      missing.push(`${name}.${col}: column comment is absent or incomplete`);
    } else { comments++; }
    if (cc && /class=projection/.test(cc) && !/rebuilt_from=/.test(cc)) {
      missing.push(`${name}.${col}: projection names no rebuild source`);
    }
  }
}

assert.deepEqual(missing.slice(0, 20), [], `${missing.length} table(s) or column(s) carry no usable comment`);
assert.equal(comments, columns, "every column carries a comment");
assert.ok(comments > 400, "and there are columns to comment, so this is not vacuously true");

console.log(`ok comment-completeness (${comments} columns commented)`);
