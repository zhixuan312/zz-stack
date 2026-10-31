#!/usr/bin/env node
// The document writers below do not call the store, and none writes a document to disk. The
// matcher is on call sites — a declaration such as `export function commitStore(` is not a
// caller. The primitive for a write path reaching a document is writeFileSync, which is asserted
// per file with no exemption.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const OWNED = [
  "services/zz-core/src/tools/artifacts.ts",
  "services/zz-core/src/tools/initiative-acts.ts",
  "services/zz-core/src/tools/knowledge.ts",
  "services/zz-core/src/review-acceptance.ts",
  "services/zz-core/src/document-parts.ts",
  "services/zz-core/src/versions.ts",
  "services/zz-core/src/document-save.ts",
];

// A check fails on the tree; it does not crash on a path that is not there yet.
for (const f of OWNED) assert.ok(existsSync(f), `${f} exists`);

// `commitStore(` and `indexDoc(`, as CALLS: not preceded by `function`/`const`/`import`.
const CALL = (name: string) => new RegExp(`(?<!function\\s{1,4})(?<!const\\s{1,4})\\b${name}\\s*\\(`);
const callers: string[] = [];
for (const f of OWNED) {
  const src = readFileSync(f, "utf8");
  for (const name of ["commitStore", "indexDoc"]) {
    if (CALL(name).test(src)) callers.push(`${f} calls ${name}`);
  }
}
assert.deepEqual(callers, [], "no document writer calls the file store's write path");

// The raw write: a document reaching the disk.
const rawWriters: string[] = [];
for (const f of OWNED) {
  if (/writeFileSync\s*\(/.test(readFileSync(f, "utf8"))) rawWriters.push(f);
}
assert.deepEqual(rawWriters, [], "and none writes a document with the raw primitive");

// The half that is about READING: the document tools answer from the revision table.
for (const f of ["services/zz-core/src/tools/artifacts.ts",
                 "services/zz-core/src/tools/initiative-acts.ts"]) {
  assert.ok(/doc_revision/.test(readFileSync(f, "utf8")), `${f} reads the revision table`);
}

// COUPLED: checks/store-retired.ts asserts the store layer itself is gone.

console.log("ok no-file-store");

