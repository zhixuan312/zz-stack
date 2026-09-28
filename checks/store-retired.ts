#!/usr/bin/env node
// Retirement is irreversible, so this asserts what must no longer be there — and asserts it about
// the things that are actually gone rather than about words that happen to appear in comments. The
// first draft of this check looked for `git add`/`git commit` in any file: six tracked files match
// that today for reasons unrelated to the store, and the one file that really wrote team git was
// missed because it used `execFile`. This one names the artefacts instead.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const files = execFileSync("git", ["ls-files", "services", "packages", "scripts", "deploy"], { encoding: "utf8" })
  .split("\n").filter(Boolean);

// The layer is gone, and so is the writer of team git — the same file, which is why they go together.
assert.ok(!existsSync("services/zz-core/src/persist.ts"), "the store layer is removed");

// Nothing names the store's layout any more — asserted about CODE, not about prose.
//
// DELIBERATE: comments and block comments are stripped before the match. A comment that records
// what the store was is the opposite of a file that reaches it: `services/zz-core/src/tools/
// initiative-acts.ts` says the signed text "stays retrievable in `_versions/`", and
// `scripts/rehearse/expect.ts` records the store phase's fold and the carry that ran with it. All
// of it is history, and deleting the history to make a grep quiet is the one repair this project
// forbids. The predicate is the one `checks/no-store-namers.ts` already uses for the same claim
// over the same file set; the two exist because this check is the one the gate registers at this
// wave, and that one is I-44's own.
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const namers = files.filter((f) => f.endsWith(".ts") && !f.includes("/dist/") &&
  /\bARTIFACTS_DIR\b|_versions\//.test(code(readFileSync(f, "utf8"))));
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

// The manifest script agrees with the script that writes the set.
const manifest = readFileSync("deploy/backup-manifest.sh", "utf8");
assert.ok(!/art_file/.test(manifest), "the manifest no longer requires the store's tarball");

// The one module that must survive this file's name being read as 'store'.
assert.ok(existsSync("services/zz-core/src/host/store.ts"),
  "host/store.ts is the control loop's durable half and is not the file store");

// The target no longer declares the eleven.
const { SCHEMA_TARGET } = await import(pathToFileURL(join(process.cwd(), "schema-target.ts")).href);
const doc = (SCHEMA_TARGET.tables.doc?.columns ?? []).map((c: [string, ...unknown[]]) => c[0]);
for (const c of ["team_slug", "initiative", "flow", "outcome", "closed_by", "approved_by",
                 "approved_at", "evidence", "supports", "superseded_by", "produced_by_run_id"]) {
  assert.ok(!doc.includes(c), `doc.${c} is dropped`);
}

// The act itself is done and its tool is gone with the volume: the retirement script archived the
// store whole, read the archive back and re-hashed every file before removing anything, and the
// archive it wrote (`zz-store-archive-<stamp>.tar.gz`, which `deploy/backup.sh` still refuses to
// prune) is the record. A check asserting the script's existence would be asserting that a tool
// with nothing left to act on is still in the tree.

console.log("ok store-retired");
