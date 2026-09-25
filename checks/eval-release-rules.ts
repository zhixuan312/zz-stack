#!/usr/bin/env node
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const { releaseDecision } = await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/release-rules.js")).href);
const ok = { base_is_current: true, approved_patch_digest: "p", patch_digest: "p",
             required_owners: ["xuan"], approvals: ["xuan"], releasable: true };
assert.deepEqual(releaseDecision(ok), { kind: "apply" });
assert.deepEqual(releaseDecision({ ...ok, required_owners: [], approvals: [] }), { kind: "refuse", reason: "no_release_owners" });
assert.deepEqual(releaseDecision({ ...ok, releasable: false }), { kind: "refuse", reason: "not_eligible" });
assert.deepEqual(releaseDecision({ ...ok, approvals: [] }), { kind: "refuse", reason: "approval_required" });
assert.deepEqual(releaseDecision({ ...ok, patch_digest: "q" }), { kind: "refuse", reason: "digest_mismatch" });
assert.deepEqual(releaseDecision({ ...ok, base_is_current: false }), { kind: "refuse", reason: "stale_baseline" });
console.log("ok eval-release-rules");
