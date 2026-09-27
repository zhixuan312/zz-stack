#!/usr/bin/env node
// The drop has two halves that must land together — the target and the migration — because the
// inventory check compares one against the other and either alone is red. This asserts they agree
// with each OTHER, which is the property neither file states on its own.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const RETIRED = ["team_slug", "initiative", "flow", "outcome", "closed_by", "approved_by",
                 "approved_at", "evidence", "supports", "superseded_by", "produced_by_run_id"];

const { SCHEMA_TARGET } = await import(pathToFileURL(join(process.cwd(), "schema-target.ts")).href);
const doc = (SCHEMA_TARGET.tables.doc?.columns ?? []).map((c: [string, ...unknown[]]) => c[0]);
for (const c of RETIRED) assert.ok(!doc.includes(c), `the target no longer declares doc.${c}`);

// And the migration drops every one of them, not a subset: a target that stopped declaring a
// column a live catalog still has is a red inventory, and the migration is what moves the catalog.
// DELIBERATE: the folded file, and the drop's EFFECT rather than its statement. 007_drop_legacy_
  // store.sql was folded into 001 once its release was verified, and a re-dump of a dropped column
  // emits nothing at all — there is no `drop column` left to find. What the drop produced is a
  // `zz.doc` with none of the eleven, and that is what this reads.
  const dir = "services/gateway/migrations";
  const sql = readFileSync(join(dir, "001_init.sql"), "utf8");
  const start = sql.indexOf("CREATE TABLE zz.doc (");
  assert.notEqual(start, -1, "zz.doc is declared in the folded file");
  const docBlock = sql.slice(start, sql.indexOf(");", start));
  const still = RETIRED.filter((c) => new RegExp(`^\\s*${c}\\s`, "m").test(docBlock));
  assert.deepEqual(still, [], "zz.doc declares none of the retired columns");
  assert.ok(/-- absorbs: 007_drop_legacy_store\.sql/.test(sql),
    "and the folded file names the drop migration it absorbed");

// The other half of the phase's claim: the layer is gone and backup.sh writes three.
assert.ok(!readdirSync("services/zz-core/src").includes("persist.ts"), "the store layer is deleted");
const backup = readFileSync("deploy/backup.sh", "utf8");
assert.ok(!/zz-artifacts-\$STAMP|ARTIFACT_VOLUME/.test(backup), "the store's tarball is gone");
assert.ok(/zz-store-archive/.test(backup), "and the prune spares the one archive");

console.log("ok drop-is-complete");
