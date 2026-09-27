#!/usr/bin/env node
// A relation stored in jsonb cannot be enforced, and two of them gate something: the findings an
// improvement run targets are its provenance, and the owners a release attempt requires are what
// document_approve reads. Group G drops the COLUMNS, not the vocabulary, so the target is asked
// which columns exist. The five names below are different: none survives the reshape in any form, so
// a file that still names one is reading a column that is gone — which is how three statements in
// I-30's own files were left behind by a Phase 3 sweep.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { SCHEMA_TARGET } = await import(pathToFileURL(join(process.cwd(), "schema-target.ts")).href);
const cols = (n: string) => (SCHEMA_TARGET.tables[n]?.columns ?? []).map((c: string[]) => c[0]);

for (const table of ["improvement_run_finding", "release_attempt_owner"]) {
  assert.ok(SCHEMA_TARGET.tables[table], `the target declares the relation table ${table}`);
}
for (const [table, gone] of [["improvement_run", "finding_ids"], ["release_attempt", "required_owners"],
                             ["candidate", "touched_owners"], ["release_attempt", "approval_refs"]] as const) {
  assert.ok(!cols(table).includes(gone), `${table}.${gone} is a relation table now`);
}
assert.ok(!cols("release_attempt").includes("rolled_back"), "one column, not two, records the rollback");
assert.ok(SCHEMA_TARGET.tables.release_attempt.columns.some((c: string[]) => c[0] === "verdict"),
  "the verdict a query branches on is a column, not a field inside verification");

// The names that survive nowhere. Each was read by a statement no instrument runs.
const dead = ["patchset", "touched_owners", "base_subject_version_id", "released_subject_version_id", "rolled_back"];
const files = ["services/zz-core/src/eval/candidates.ts", "services/zz-core/src/eval/release.ts",
               "services/zz-core/src/eval/release-apply.ts", "services/zz-core/src/eval/release-record.ts",
               "services/zz-core/src/eval/release-verify.ts", "services/zz-core/src/eval/release-rules.ts",
               "services/zz-core/src/eval/proposal-doc.ts", "services/zz-core/src/eval/proposer-bundle.ts",
               "services/zz-core/src/eval/improvement-doc.ts", "services/zz-core/src/release-owners.ts",
               "services/zz-core/src/release-head.ts", "services/gateway/src/console/plugin-eval.ts"];
const hits: string[] = [];
for (const f of files) {
  const src = readFileSync(f, "utf8");
  for (const name of dead) {
    if (new RegExp(`\\b${name}\\b`).test(src)) hits.push(`${f} names ${name}`);
  }
}
assert.deepEqual(hits, [], "no reader names a column this reshape retires");

console.log("ok release-relations");
