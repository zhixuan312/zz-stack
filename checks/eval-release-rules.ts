#!/usr/bin/env node
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const { releaseDecision, rollbackDecision } = await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/release-rules.js")).href);
const ok = { base_is_current: true, approved_patch_digest: "p", patch_digest: "p",
             required_owners: ["xuan"], approvals: ["xuan"], proof_eligible: true };
assert.deepEqual(releaseDecision(ok), { kind: "apply" });
assert.deepEqual(releaseDecision({ ...ok, required_owners: [], approvals: [] }), { kind: "refuse", reason: "no_release_owners" });
assert.deepEqual(releaseDecision({ ...ok, proof_eligible: false }), { kind: "refuse", reason: "not_eligible" });
assert.deepEqual(releaseDecision({ ...ok, approvals: [] }), { kind: "refuse", reason: "approval_required" });
assert.deepEqual(releaseDecision({ ...ok, patch_digest: "q" }), { kind: "refuse", reason: "digest_mismatch" });
assert.deepEqual(releaseDecision({ ...ok, base_is_current: false }), { kind: "refuse", reason: "stale_baseline" });
assert.equal(rollbackDecision({ deltas: Array(12).fill(-1), guardrail_failed: false, resamples: 2000, seed: "s", confidence: 0.95 }), true, "established regression");
assert.equal(rollbackDecision({ deltas: Array(12).fill(0.2), guardrail_failed: false, resamples: 2000, seed: "s", confidence: 0.95 }), false);
assert.equal(rollbackDecision({ deltas: Array(12).fill(0.2), guardrail_failed: true, resamples: 2000, seed: "s", confidence: 0.95 }), true, "guardrail failure");
console.log("ok eval-release-rules");
