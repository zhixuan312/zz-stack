#!/usr/bin/env node
/**
 * checks/rehearse-created-table.ts — the restore rehearsal accepts a table a pending migration creates only when
 * `scripts/rehearse/expect.ts` declares it, and labels one nobody declared as undeclared.
 *
 *   node checks/rehearse-created-table.ts
 *
 *   1. Every table a migration file under services/gateway/migrations creates, while that file is still its own
 *      file, is declared `added` by that migration's entry — otherwise a rehearsal of a backup taken before it
 *      exits non-zero for an additive migration.
 *   2. `diffSnapshots` over a table absent before and present after: no disagreement when declared, a disagreement
 *      labelled "undeclared" when not.
 *
 * Exit 0: every case held. Exit 1: one did not, naming it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { root } from "../scripts/deployment.ts";
import { diffSnapshots } from "../scripts/rehearse/diff.ts";
import { MIGRATION_EXPECTATIONS } from "../scripts/rehearse/expect.ts";

const fail: string[] = [];
const dir = join(root, "services/gateway/migrations");

// DELIBERATE: 001_init.sql is the schema every backup already has, so nothing in it is pending against one.
for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql") && f !== "001_init.sql").sort()) {
  const sql = readFileSync(join(dir, file), "utf8");
  for (const m of sql.matchAll(/^\s*create table (?:if not exists )?zz\.([a-z_]+)/gim)) {
    if (!MIGRATION_EXPECTATIONS[file]?.tables?.[m[1]]?.added) {
      fail.push(`${file} creates zz.${m[1]} and its entry in scripts/rehearse/expect.ts does not declare it added`);
    }
  }
}

const absent = { count: 0, hash: null, present: false };
const created = { count: 0, hash: "e", present: true };
const declared = diffSnapshots({ doc_words: absent }, { doc_words: created }, ["008_doc_words.sql"]);
if (declared.diffs.length) fail.push(`a declared created table disagreed: ${declared.diffs.join("; ")}`);
const undeclared = diffSnapshots({ nobody_declared: absent }, { nobody_declared: created }, []);
if (!undeclared.diffs.length) fail.push("a created table nothing declares passed the rehearsal");
if (undeclared.lines[0]?.expectedCount !== "undeclared") {
  fail.push(`a created table nothing declares is labelled ${JSON.stringify(undeclared.lines[0]?.expectedCount)}, not "undeclared"`);
}

if (fail.length) {
  console.error(`rehearse-created-table: ${fail.length} failure(s)\n  ${fail.join("\n  ")}`);
  process.exit(1);
}
console.log("rehearse-created-table: every pending migration's created table is declared, and an undeclared one is named so");
