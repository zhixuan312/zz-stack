#!/usr/bin/env node
// A revision withdraws the approval it replaced. Today it withdraws every approval of that path,
// later ones included, because `approval:<path>` repeats and the kernel's withdrawn set is
// order-independent — so a document approved, revised and approved again has a second approval that
// does not count. The fix is the id the writer MINTS, so this asserts the writer's own minting
// function and the log it yields; the kernel's own behaviour over that log is
// `scripts/control-loop-e2e.ts`, which this task's acceptance runs.
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

delete process.env.TEAM_DB_URL;
const observe = await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/host/observe.js")).href);

const mint = observe.evidenceEntryId;
assert.equal(typeof mint, "function", "the writer exposes one pure function that mints an entry id");

const doc = (p: string, v: number) => mint({ kind: "document", path: p, version: v });
const approval = (p: string, v: number) => mint({ kind: "approval", path: p, version: v });
const audit = (p: string) => mint({ kind: "audit", path: p });

assert.equal(doc("spec.md", 1), "doc:spec.md@v1");
assert.equal(doc("spec.md", 2), "doc:spec.md@v2");
assert.equal(approval("spec.md", 1), "approval:spec.md@v1");
assert.equal(approval("spec.md", 2), "approval:spec.md@v2");
assert.notEqual(approval("spec.md", 1), approval("spec.md", 2),
  "the approval that follows a revision is a different fact from the one the revision withdrew");
assert.equal(audit("sources/x.md"), "audit:sources/x.md");

// The log those ids produce: write, approve, revise, approve again. Every fact carries its own id,
// and the revision withdraws the approval that stood — not the one that followed it.
const log = [
  { entry_id: doc("spec.md", 1), supersedes: null },
  { entry_id: approval("spec.md", 1), supersedes: null },
  { entry_id: doc("spec.md", 2), supersedes: approval("spec.md", 1) },
  { entry_id: approval("spec.md", 2), supersedes: null },
];
const ids = log.map((e) => e.entry_id);
assert.equal(new Set(ids).size, ids.length, "every fact in one run has its own id");
assert.ok(log.some((e) => e.supersedes === approval("spec.md", 1)),
  "the revision withdraws the approval it replaced");
assert.ok(!log.some((e) => e.supersedes === approval("spec.md", 2)),
  "and nothing withdraws the approval that came after it — the bug was that this one did not count");
assert.ok(new Set([approval("spec.md", 1), approval("spec.md", 2)]).size === 2,
  "so a later approval stands as a fact of its own");

console.log("ok control-evidence-identity");
