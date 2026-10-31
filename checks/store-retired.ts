#!/usr/bin/env node
// The file store is retired: this asserts what must no longer be there, about the artefacts that
// are gone rather than about words that happen to appear in comments.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const files = execFileSync("git", ["ls-files", "services", "packages", "scripts", "deploy"], { encoding: "utf8" })
  .split("\n").filter((f) => f.endsWith(".ts") && !f.includes("/dist/") && existsSync(f));

// The store layer, which was also the writer of team git, is gone.
assert.ok(!existsSync("services/zz-core/src/persist.ts"), "the store layer is removed");

// No tracked TypeScript file names the store's root or a `_versions/` path, and none is exempt.
//
// DELIBERATE: comments are stripped before the match and strings are not. A comment about the
// store does not reach it; a path in a string is how code reaches one.
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
assert.ok(files.length > 0, "git ls-files listed no TypeScript under services, packages, scripts or deploy — the scan below would read nothing");
const namers = files.filter((f) => /\bARTIFACTS_DIR\b|_versions\//.test(code(readFileSync(f, "utf8"))));
assert.deepEqual(namers, [], "no file reaches the store's root or its version directory");

// The backup writes three tarballs and the store's is not among them.
const backup = readFileSync("deploy/backup.sh", "utf8");
assert.ok(/pg_dump/.test(backup), "the database is still dumped");
assert.ok(/zz-artifacts-\$STAMP|ARTIFACT_VOLUME/.test(backup) === false,
  "and the store's own tarball is gone, because the store is in that dump now");
assert.ok(/zz-credentials-\$STAMP/.test(backup) && /zz-config-\$STAMP/.test(backup),
  "while the credentials and configuration tarballs stay: they are not the store");
assert.ok(/zz-store-archive|store-archive/.test(backup),
  "and the prune is given an exemption for the one archive that must outlive it");

// The one module that must survive this file's name being read as 'store'.
assert.ok(existsSync("services/zz-core/src/host/store.ts"),
  "host/store.ts is the control loop's durable half and is not the file store");

// The target declares none of the eleven columns the store's documents carried.
const { SCHEMA_TARGET } = await import(pathToFileURL(join(process.cwd(), "schema-target.ts")).href);
const doc = (SCHEMA_TARGET.tables.doc?.columns ?? []).map((c: [string, ...unknown[]]) => c[0]);
for (const c of ["team_slug", "initiative", "flow", "outcome", "closed_by", "approved_by",
                 "approved_at", "evidence", "supports", "superseded_by", "produced_by_run_id"]) {
  assert.ok(!doc.includes(c), `doc.${c} is dropped`);
}

console.log("ok store-retired");
