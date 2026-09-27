#!/usr/bin/env node
// Two lifecycles shared this table: the legacy ruler rounds (eval_id, scope, docs_affected,
// proposed_change, resulted_in_skill_version_id) and the eval_run findings. The legacy one has had no
// writer since I-13 and its rows were archived in Phase 3, so its columns go. This asks the target,
// where a column either exists or does not — `scope`, `eval_id` and `pattern` are ordinary words
// elsewhere in the tree, so a name-scan in source would be a check that cannot pass.
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { SCHEMA_TARGET } = await import(pathToFileURL(join(process.cwd(), "schema-target.ts")).href);
const cols = (SCHEMA_TARGET.tables["eval_finding"]?.columns ?? []).map((c: [string, ...unknown[]]) => c[0]);
for (const c of ["eval_run_id", "kind", "owner_kind", "decision", "superseded_by"]) {
  assert.ok(cols.includes(c), `eval_finding.${c} stands`);
}
for (const c of ["eval_id", "scope", "docs_affected", "proposed_change", "resulted_in_skill_version_id"]) {
  assert.ok(!cols.includes(c), `eval_finding.${c} is dropped`);
}

console.log("ok finding-one-lifecycle");
