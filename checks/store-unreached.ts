#!/usr/bin/env node
// The claim is a negative one about the whole tree, so it is asserted over every tracked TypeScript
// file rather than a list — a list is what let four phantom paths into this phase's first draft.
// Two exemptions, both named with their reason: the layer's own module, which still DEFINES what
// this task stops calling, and the indexer's reindex pass, which Task I-41 retires with the layer.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "services", "packages"], { encoding: "utf8" })
  .split("\n").filter((f) => f.endsWith(".ts") && !f.includes("/dist/") && !f.endsWith(".d.ts"));

const LAYER = "services/zz-core/src/persist.ts";
const INDEXER = "packages/indexing/src/index.ts";
// I-39's BRIDGE, and it is temporary by construction. `versions.ts` writes the store mirror and
// `document-parts.ts` appends the journal row, because readers this phase does not own still open
// both: `review-rounds.ts` and `spec-gate.ts` read `<initiative>/sources/*.md`, and `attest.ts`
// reads `activity.jsonl`, through which `shownSinceLastChange` decides whether an approval would
// be refused. TWO REGISTERED CHECKS assert those exact rows — `checks/document-parts.ts` and
// `checks/approve-needs-present.ts` — so the swap is not free: removing the bridge does not move a
// reader, it makes those readers answer nothing. **Task I-41 REMOVES THIS EXEMPTION** when it
// retires the store, and this check's claim becomes the whole tree again.
const BRIDGE = ["services/zz-core/src/versions.ts", "services/zz-core/src/document-parts.ts"];

// A call, not a declaration or an import: `export function logActivity(` is the layer defining it.
const callers: string[] = [];
for (const f of files) {
  if (f === LAYER || f === INDEXER || BRIDGE.includes(f)) continue;
  const src = readFileSync(f, "utf8");
  for (const name of ["commitStore", "indexDoc", "persistDocument", "logActivity"]) {
    if (new RegExp(`(?<!function\\s{1,4})(?<!const\\s{1,4})\\b${name}\\s*\\(`).test(src)) {
      callers.push(`${f} calls ${name}`);
    }
  }
}
assert.deepEqual(callers, [], "no file outside the store layer reaches the store");

// The exemptions are real files, so this check cannot pass on a tree where they were renamed away.
for (const f of [LAYER, INDEXER, ...BRIDGE]) {
  assert.ok(files.includes(f), `${f} is still tracked, so the exemption is still the right one`);
}

// And the pins AC-6.7 asks for are written where the writers are.
const run = readFileSync("services/zz-core/src/eval/evaluate-run.ts", "utf8");
assert.ok(/doc_revision/.test(run), "a document evaluation subject pins its exact revision");
const rec = readFileSync("services/zz-core/src/eval/protocol-record.ts", "utf8");
assert.ok(/approved_doc_revision/.test(rec), "and a protocol affirmation pins the revision it affirmed");

console.log("ok store-unreached");
