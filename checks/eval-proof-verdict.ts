#!/usr/bin/env node
// Release-review fixes (findings 3 and 8): candidate_prove's verdict over finished proof
// evidence. An accepted pruning trade-off is judged before "ask for more repeats", and an
// unclear or unavailable leakage answer is not_established (leakage_unresolved), never a pass.
// Pure: candidate-prove-decide.ts on values alone.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const { acceptedPruning, needsMoreRepeats, proofVerdict } = await import(
  pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/candidate-prove-decide.js")).href);

const unresolvedNoRegression = { verdict: "unresolved", lower: 0.01 };
const unresolvedStraddling = { verdict: "unresolved", lower: -0.2 };
const improves = { verdict: "improves", lower: 0.3 };
const clean = { reading: "no", reason: null };

assert.equal(acceptedPruning(-5, unresolvedNoRegression), true, "negative complexity, lower >= 0: accepted pruning");
assert.equal(acceptedPruning(3, unresolvedNoRegression), false, "positive complexity is never pruning");
assert.equal(acceptedPruning(-5, unresolvedStraddling), false, "a pruning that may regress is not accepted");

assert.equal(needsMoreRepeats(unresolvedNoRegression, -5, false), false,
  "an accepted pruning is settled — no more repeats, even under the bound (the fix)");
assert.equal(needsMoreRepeats(unresolvedStraddling, 3, false), true, "unresolved, under the bound: one more repeat");
assert.equal(needsMoreRepeats(unresolvedStraddling, 3, true), false, "at the bound: resolve now");
assert.equal(needsMoreRepeats(improves, 3, false), false, "a resolved interval never asks for more");

const base = { decision: improves, complexityDelta: 3, guardrails: "pass", leakage: clean, hasOwners: true };
assert.deepEqual(proofVerdict(base), { proof_status: "proof_passed", reason: "proof_passed", release_eligible: true });
assert.equal(proofVerdict({ ...base, hasOwners: false }).release_eligible, false, "no owners: passed but not eligible");

assert.equal(proofVerdict({ ...base, leakage: { reading: "yes", reason: "hard-coded id" } }).proof_status, "proof_failed",
  "a clear leakage yes fails the proof");
for (const reading of ["unclear", "unavailable"]) {
  const v = proofVerdict({ ...base, leakage: { reading, reason: null } });
  assert.deepEqual([v.proof_status, v.reason], ["not_established", "leakage_unresolved"],
    `leakage ${reading} is not_established, never admitted (the fix)`);
}
assert.equal(proofVerdict({ ...base, guardrails: "not_established", decision: unresolvedStraddling }).reason,
  "guardrails_not_established", "an unmeasured guardrail is named before an unresolved interval");
assert.equal(proofVerdict({ ...base, decision: unresolvedStraddling }).reason, "proof_unresolved");
assert.equal(proofVerdict({ ...base, decision: unresolvedNoRegression, complexityDelta: -5 }).proof_status, "proof_passed",
  "an accepted pruning passes although its interval never cleared mme");
assert.equal(proofVerdict({ ...base, guardrails: "fail" }).reason, "guardrails_failed");
assert.equal(proofVerdict({ ...base, decision: { verdict: "not_improved", lower: -0.4 } }).reason,
  "improvement_below_meaningful_effect");

console.log("ok eval-proof-verdict");
