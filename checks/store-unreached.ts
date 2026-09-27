#!/usr/bin/env node
// The claim is a negative one about the whole tree, so it is asserted over every tracked TypeScript
// file rather than a list — a list is what let four phantom paths into this phase's first draft.
//
// THE EXEMPTION LIST IS EMPTY, and it is empty because the work it exempted is done: the store
// layer is deleted (`services/zz-core/src/persist.ts`), the indexer's walk went with the store it
// walked (`packages/indexing/src/index.ts`), and the three files that mirrored a document into the
// store no longer do. An exemption that outlives the work it exempted is exactly what let the
// shortfall before this task pass a green check, so there is none left to outlive anything.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "services", "packages"], { encoding: "utf8" })
  .split("\n").filter((f) => f.endsWith(".ts") && !f.includes("/dist/") && !f.endsWith(".d.ts"));

// A call, not a declaration or an import: `export function logActivity(` was the layer defining it.
// No file is skipped — not even the layer, which no longer exists.
const callers: string[] = [];
for (const f of files) {
  const src = readFileSync(f, "utf8");
  for (const name of ["commitStore", "indexDoc", "persistDocument", "logActivity"]) {
    if (new RegExp(`(?<!function\\s{1,4})(?<!const\\s{1,4})\\b${name}\\s*\\(`).test(src)) {
      callers.push(`${f} calls ${name}`);
    }
  }
}
assert.deepEqual(callers, [], "no file reaches the store");

// And the layer itself is gone, so this cannot pass on a tree where it came back.
assert.ok(!files.includes("services/zz-core/src/persist.ts"), "the store layer is deleted");

// And the pins AC-6.7 asks for are written where the writers are.
const run = readFileSync("services/zz-core/src/eval/evaluate-run.ts", "utf8");
assert.ok(/doc_revision/.test(run), "a document evaluation subject pins its exact revision");
const rec = readFileSync("services/zz-core/src/eval/protocol-record.ts", "utf8");
assert.ok(/approved_doc_revision/.test(rec), "and a protocol affirmation pins the revision it affirmed");

console.log("ok store-unreached");

