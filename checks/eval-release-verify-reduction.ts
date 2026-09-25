#!/usr/bin/env node
// release_verify's decision (002): a release is judged on real use. It waits for the protocol's
// minimum of real runs, then for an evaluation of them; a failed critical guardrail rolls back
// before the score is read; a released score more than the regression band below the base rolls
// back; no base score to compare against is not_established, never a rollback.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const { verifyDecision } =
  await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/release-rules.js")).href);

const base = {
  post_release_runs: 5, min_post_release_runs: 5, regression_band: 0.1, base_overall: 0.7,
  released: { overall: 0.7, guardrail_status: "pass" },
};

assert.deepEqual(verifyDecision({ ...base, post_release_runs: 3 }),
  { kind: "pending", reason: "awaiting_post_release_runs", runs_needed: 2 }, "too few real runs names how many are still needed");
assert.deepEqual(verifyDecision({ ...base, post_release_runs: 3, released: { overall: 0.1, guardrail_status: "fail" } }).kind, "pending",
  "nothing is decided on fewer real runs than the protocol's minimum");
assert.deepEqual(verifyDecision({ ...base, released: null }), { kind: "pending", reason: "awaiting_evaluation" });
assert.deepEqual(verifyDecision({ ...base, released: { overall: 0.9, guardrail_status: "fail" } }),
  { kind: "resolve", verdict: "rolled_back", reason: "guardrail_failed", delta: 0.9 - 0.7 },
  "a failed critical guardrail rolls back whatever the score says");
assert.deepEqual(verifyDecision({ ...base, released: { overall: null, guardrail_status: "fail" } }).verdict, "rolled_back",
  "a failed guardrail rolls back even with no overall score");
assert.deepEqual(verifyDecision({ ...base, released: { overall: null, guardrail_status: "pass" } }),
  { kind: "pending", reason: "released_score_not_established" });
assert.deepEqual(verifyDecision({ ...base, base_overall: null }),
  { kind: "resolve", verdict: "not_established", reason: "no_base_score", delta: null }, "no rollback without evidence");
const verdictAt = (overall: number) => verifyDecision({ ...base, released: { overall, guardrail_status: "pass" } });
assert.equal(verdictAt(0.55).verdict, "rolled_back", "0.15 below the base is beyond a 0.1 band");
assert.equal(verdictAt(0.55).reason, "regression_beyond_band");
assert.equal(verdictAt(0.65).verdict, "established", "0.05 below the base is inside the band");
assert.equal(verdictAt(0.6).verdict, "established", "exactly the band is not beyond it");
assert.equal(verdictAt(0.9).reason, "no_regression_beyond_band");
assert.equal(verifyDecision({ ...base, released: { overall: 0.7, guardrail_status: "not_established" } }).verdict, "established",
  "an unmeasured guardrail is not a failed one");

// The released evaluation is read under the base's own protocol version and over at least the
// minimum of real runs, and a pending answer hands back every argument the next calls need.
const src = readFileSync("services/zz-core/src/eval/release-verify.ts", "utf8");
assert.match(src, /er\.subject_version_id = \$1::uuid and er\.protocol_version_id = \$2::uuid\s+and er\.run_status = 'completed' and os\.total_run_count >= \$3/,
  "release_verify reads an evaluation of another protocol version, or of too few runs");
assert.match(src, /score_status in \('established', 'provisional'\) and overall_score is not null/,
  "release_verify compares against a base score that was never established or provisional");
assert.match(src, /evaluation_required: \{\s*subject_version_id: releasedId, protocol_version_id: protocolVersionId,\s*evidence_window: \{ last_runs: runs \}/,
  "a pending answer does not carry the arguments plugin_profile and evaluation_start need");
assert.match(src, /WITHOUT `initiative`/, "the evaluation steps do not warn against overwriting the initiative's own records");
console.log("ok eval-release-verify-reduction");
