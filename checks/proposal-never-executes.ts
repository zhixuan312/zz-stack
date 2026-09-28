#!/usr/bin/env node
// The strongest thing this platform claims about a non-owned subject: `proposal.md` is written
// without ever applying its patch. The task's own words were "a non-owned subject never causes a
// repository write, ever — make that an explicit guard", and `proposal-doc.ts` states how: it
// imports nothing that can run anything, and the candidate's diff is rendered as inert fenced
// markdown.
//
// Stated in a module note, unpinned by anything. A future edit reaching for `child_process` to
// "check the patch applies" would keep every other check green and turn the claim false, which is
// the shape this file exists to refuse. Matched on IMPORTS and on the fence, not on declarations:
// a sentence promising inertness is what the module already has.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = "services/zz-core/src/eval/proposal-doc.ts";
const raw = readFileSync(SRC, "utf8");
// Comments stripped before anything is matched — the same reason `checks/no-file-store.ts` strips
// them: this module's own note NAMES `release-apply.js` and `release-verify.js` to say it reaches
// neither, and a check that read prose would fail on the sentence that promises the opposite.
const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// 1. Nothing that executes. `release-apply` and `release-verify` are the two modules that do
//    repository work, and both are reachable in this tree — so naming them is the way a proposal
//    would come to apply something.
for (const forbidden of ["node:child_process", "release-apply", "release-verify", "node:vm",
                         "node:worker_threads"]) {
  assert.ok(!src.includes(forbidden),
    `${SRC} names ${forbidden} — a proposal must not be able to run anything`);
}

// 2. The only things it may reach are the document path and the database.
const imports = [...src.matchAll(/^import[^;]*from "([^"]+)"/gm)].map((m) => m[1]);
assert.ok(imports.length > 0, "the import list is readable");
for (const i of imports) {
  assert.ok(!/^(node:|child_process)/.test(i),
    `${SRC} imports ${i}; its only side effects are a database read and a document write`);
}

// 3. The diff is fenced. A `diff` field rendered raw would be read as markdown by every reader that
//    renders this document, which is the difference between showing a patch and running one. The
//    fence is chosen (`fenceFor`) rather than a literal ``` so a diff that itself contains a fence
//    cannot end the block early — assert that, since that is the mechanism the module actually uses.
assert.ok(/function fenceFor\(/.test(src), "the fence is chosen by fenceFor from the body it wraps");
assert.ok(/\$\{fence\}diff/.test(src) && /^\s*fence,$/m.test(src),
  "the diff is rendered between the fence it chose, not raw");

console.log("ok proposal-never-executes");
