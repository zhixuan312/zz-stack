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
const dir = "services/gateway/migrations";
const named = readdirSync(dir).filter((n: string) => /drop_legacy_store\.sql$/.test(n));
assert.equal(named.length, 1, "exactly one drop migration");
const sql = readFileSync(join(dir, named[0]), "utf8");
const missing = RETIRED.filter((c) => !new RegExp(`drop\\s+column\\s+(?:if\\s+exists\\s+)?${c}\\b`, "i").test(sql));
assert.deepEqual(missing, [], "the migration drops every retired column, in one file");

// The other half of the phase's claim: the layer is gone and backup.sh writes three.
assert.ok(!readdirSync("services/zz-core/src").includes("persist.ts"), "the store layer is deleted");
const backup = readFileSync("deploy/backup.sh", "utf8");
assert.ok(!/zz-artifacts-\$STAMP|ARTIFACT_VOLUME/.test(backup), "the store's tarball is gone");
assert.ok(/zz-store-archive/.test(backup), "and the prune spares the one archive");

console.log("ok drop-is-complete");
