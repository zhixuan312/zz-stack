#!/usr/bin/env node
// The target no longer declares any of `zz.doc`'s retired columns. That the migrated catalog agrees
// with the target is checks/schema-inventory.ts's, and that the store layer and its backup tarball
// are gone is checks/store-retired.ts's.
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const RETIRED = ["team_slug", "initiative", "flow", "outcome", "closed_by", "approved_by",
                 "approved_at", "evidence", "supports", "superseded_by", "produced_by_run_id"];

const { SCHEMA_TARGET } = await import(pathToFileURL(join(process.cwd(), "schema-target.ts")).href);
const doc = (SCHEMA_TARGET.tables.doc?.columns ?? []).map((c: [string, ...unknown[]]) => c[0]);
for (const c of RETIRED) assert.ok(!doc.includes(c), `the target no longer declares doc.${c}`);

console.log("ok drop-is-complete");
