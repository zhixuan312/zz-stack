#!/usr/bin/env node
// What this asserts is narrower than it looks, deliberately: the four files this task owns stop
// CALLING the store, and the layer itself survives them (I-41 removes it). So the matcher is on
// call sites — a declaration such as `export function commitStore(` is not a caller, and a check
// that matched it could only be satisfied by deleting a module this task does not own. The
// assertion the AC's first clause really makes is about a write path reaching a document, and the
// primitive for that is writeFileSync, which is asserted per file with the one exemption named.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const OWNED = [
  "services/zz-core/src/tools/artifacts.ts",
  "services/zz-core/src/tools/initiative-acts.ts",
  "services/zz-core/src/tools/knowledge.ts",
  "services/zz-core/src/review-acceptance.ts",
  "services/zz-core/src/document-parts.ts",
  "services/zz-core/src/versions.ts",
];

// A check fails on the tree; it does not crash on a path that is not there yet.
for (const f of OWNED) assert.ok(existsSync(f), `${f} is where the plan says it is`);

// `commitStore(` and `indexDoc(`, as CALLS: not preceded by `function`/`const`/`import`.
const CALL = (name: string) => new RegExp(`(?<!function\\s{1,4})(?<!const\\s{1,4})\\b${name}\\s*\\(`);
const callers: string[] = [];
for (const f of OWNED) {
  const src = readFileSync(f, "utf8");
  for (const name of ["commitStore", "indexDoc"]) {
    if (CALL(name).test(src)) callers.push(`${f} calls ${name}`);
  }
}
assert.deepEqual(callers, [], "no file this task owns calls the file store's write path");

// The raw write: a document reaching the disk. review-acceptance.ts writes the acceptance cache
// under `_assessments/`, which is not a document, so it is exempt from this clause alone.
const rawWriters: string[] = [];
for (const f of OWNED) {
  if (f.endsWith("review-acceptance.ts")) continue;   // the acceptance cache, not a document
  if (/writeFileSync\s*\(/.test(readFileSync(f, "utf8"))) rawWriters.push(f);
}
assert.deepEqual(rawWriters, [], "and none writes a document with the raw primitive");

// The half that is about READING: the document tools answer from the revision table.
for (const f of ["services/zz-core/src/tools/artifacts.ts",
                 "services/zz-core/src/tools/initiative-acts.ts"]) {
  assert.ok(/doc_revision/.test(readFileSync(f, "utf8")), `${f} reads the revision table`);
}

// And the store layer is still there — this task stops callers, it does not retire the layer.
assert.ok(existsSync("services/zz-core/src/persist.ts"), "the store layer survives this task");

console.log("ok no-file-store");
