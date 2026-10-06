#!/usr/bin/env node
// A change withdraws exactly the approval of the snapshot it displaced. An id that named only the
// path withdrew every approval of it, later ones included, because the kernel's withdrawn set is
// order-independent; an id that named only the public version could not tell two approvals of one
// version apart — an approved document given a metadata-only correction is a new snapshot of the
// SAME version, approved again later, and the correction must withdraw the first approval and not
// the second. So a document or approval id names the snapshot within its public version,
// `@v<version>.<revision>`. The fix is the id the writer MINTS, so this asserts the writer's own
// minting function and the log it yields; the kernel's own behaviour over that log is
// `scripts/control-loop-e2e.ts`.
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

delete process.env.TEAM_DB_URL;
const observe = await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/host/observe.js")).href);

const mint = observe.evidenceEntryId;
assert.equal(typeof mint, "function", "the writer exposes one pure function that mints an entry id");

const doc = (p: string, v: number, r: number) => mint({ kind: "document", path: p, at: { version: v, revision: r } });
const approval = (p: string, v: number, r: number) => mint({ kind: "approval", path: p, at: { version: v, revision: r } });
const audit = (p: string) => mint({ kind: "audit", path: p });

assert.equal(doc("spec.md", 1, 1), "doc:spec.md@v1.1");
assert.equal(doc("spec.md", 2, 3), "doc:spec.md@v2.3");
assert.equal(approval("spec.md", 1, 1), "approval:spec.md@v1.1");
assert.equal(approval("spec.md", 2, 4), "approval:spec.md@v2.4");
assert.notEqual(approval("spec.md", 2, 3), approval("spec.md", 2, 4),
  "two approvals of one public version are two facts");
assert.equal(audit("sources/x.md"), "audit:sources/x.md");

// The log those ids produce: write, approve, a new version, approve it, a metadata-only draft of
// that approved version, approve again. Every fact carries its own id, and each change withdraws
// the approval of the snapshot it displaced — never the one that followed it.
const log = [
  { entry_id: doc("spec.md", 1, 1), supersedes: null },
  { entry_id: approval("spec.md", 1, 1), supersedes: null },
  { entry_id: doc("spec.md", 2, 2), supersedes: approval("spec.md", 1, 1) },
  { entry_id: approval("spec.md", 2, 2), supersedes: null },
  { entry_id: doc("spec.md", 2, 3), supersedes: approval("spec.md", 2, 2) },
  { entry_id: approval("spec.md", 2, 3), supersedes: null },
];
const ids = log.map((e) => e.entry_id);
assert.equal(new Set(ids).size, ids.length, "every fact in one run has its own id");
assert.ok(log.some((e) => e.supersedes === approval("spec.md", 1, 1)),
  "a new version withdraws the approval it replaced");
assert.ok(log.some((e) => e.supersedes === approval("spec.md", 2, 2)),
  "a same-version draft withdraws the approval of the snapshot it displaced");
assert.ok(!log.some((e) => e.supersedes === approval("spec.md", 2, 3)),
  "and nothing withdraws the approval that came after it — the bug was that this one did not count");

console.log("ok control-evidence-identity");
