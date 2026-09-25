#!/usr/bin/env node
// release_verify's reduction: guardrails are read before the interval, so a failed guardrail rolls
// back even while the interval is unresolved and the liveness bound is not reached; the protocol's
// own confidence is the one both the unresolved check and rollbackDecision use.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const { verifyReduction, rollbackDecision } =
  await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/release-rules.js")).href);

const straddling = [-1, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 1];
const base = { resamples: 2000, seed: "s", confidence: 0.95, liveness_bound_reached: false, evidence_complete: true };
const pick = (r: { kind: string; verdict?: string; reason?: string }) => (r.kind !== "resolve" ? { kind: r.kind } : { kind: r.kind, verdict: r.verdict, reason: r.reason });

assert.deepEqual(pick(verifyReduction({ ...base, deltas: straddling, guardrail_status: "fail" })),
  { kind: "resolve", verdict: "rolled_back", reason: "guardrail_failed" },
  "a failed guardrail rolls back while the interval is unresolved and the bound is not reached");
assert.deepEqual(pick(verifyReduction({ ...base, deltas: straddling, guardrail_status: "fail", liveness_bound_reached: true })),
  { kind: "resolve", verdict: "rolled_back", reason: "guardrail_failed" });
// Incomplete evidence: a guardrail the runs collected so far already failed rolls back — before
// any missing run arrives, and before the liveness bound — even with no case paired yet; anything
// else waits for the missing runs.
const partial = { ...base, evidence_complete: false };
assert.deepEqual(pick(verifyReduction({ ...partial, deltas: [], guardrail_status: "fail" })),
  { kind: "resolve", verdict: "rolled_back", reason: "guardrail_failed" },
  "a visibly failing guardrail on partial evidence does not wait for the missing runs");
assert.equal(verifyReduction({ ...partial, deltas: [], guardrail_status: "fail" }).decision, null);
assert.deepEqual(pick(verifyReduction({ ...partial, deltas: straddling.slice(0, 3), guardrail_status: "fail", liveness_bound_reached: true })),
  { kind: "resolve", verdict: "rolled_back", reason: "guardrail_failed" });
for (const guardrail_status of ["pass", "not_established"]) {
  assert.deepEqual(pick(verifyReduction({ ...partial, deltas: Array(12).fill(-1), guardrail_status })), { kind: "pending" },
    `incomplete evidence with guardrails ${guardrail_status} waits for the missing runs`);
}
assert.deepEqual(pick(verifyReduction({ ...base, deltas: [], guardrail_status: "pass" })),
  { kind: "resolve", verdict: "not_established", reason: "no_paired_cases" });
assert.deepEqual(pick(verifyReduction({ ...base, deltas: straddling, guardrail_status: "not_established" })),
  { kind: "resolve", verdict: "not_established", reason: "guardrails_not_established" });
assert.deepEqual(pick(verifyReduction({ ...base, deltas: straddling, guardrail_status: "pass" })),
  { kind: "escalate" }, "unresolved before the bound asks for one more repeat");
assert.deepEqual(pick(verifyReduction({ ...base, deltas: straddling, guardrail_status: "pass", liveness_bound_reached: true })),
  { kind: "resolve", verdict: "not_established", reason: "verification_unresolved" });
assert.deepEqual(pick(verifyReduction({ ...base, deltas: Array(12).fill(-1), guardrail_status: "pass" })),
  { kind: "resolve", verdict: "rolled_back", reason: "regression_established" });
assert.deepEqual(pick(verifyReduction({ ...base, deltas: Array(12).fill(0.2), guardrail_status: "pass" })),
  { kind: "resolve", verdict: "established", reason: "no_regression_established" });

// One confidence: deltas whose interval clears zero at 80% but not at 99% resolve a regression at
// 0.8 and escalate at 0.99, and rollbackDecision agrees with the reduction at each.
const edgy = [-0.9, -0.8, -0.7, -1.0, 0.6, 0.4, -0.9, 0.8, 0.3, -0.7, -0.5, 0.2];
assert.equal(verifyReduction({ ...base, confidence: 0.8, deltas: edgy, guardrail_status: "pass" }).verdict, "rolled_back");
assert.equal(verifyReduction({ ...base, confidence: 0.99, deltas: edgy, guardrail_status: "pass" }).kind, "escalate");
for (const confidence of [0.8, 0.99]) {
  const r = verifyReduction({ ...base, confidence, deltas: edgy, guardrail_status: "pass" });
  const rolled = rollbackDecision({ deltas: edgy, guardrail_failed: false, resamples: 2000, seed: "s", confidence });
  assert.equal(r.kind === "resolve" && r.verdict === "rolled_back", rolled, `confidence ${confidence}`);
}
// Post-release verification gets no exemption from verifier-token binding (migration 002): the
// token it mints names the case set and the released subject, and what it asks the agent to run
// is counts per side, never a proof case id.
import { readFileSync } from "node:fs";
const verifySrc = readFileSync("services/zz-core/src/eval/release-verify.ts", "utf8");
assert.match(verifySrc, /insert into zz\.replay_verifier_token\s*\(token_hash, candidate_id, case_set_id, released_subject_version_id,/,
  "release_verify mints a verifier token not bound to its case set and released subject");
assert.match(verifySrc, /interface VerifyRunsRequired \{ readonly case_set_id: string; readonly baseline: number; readonly candidate: number \}/,
  "release_verify's runs_required is not counts per side");
assert.doesNotMatch(verifySrc, /runs_required[^\n]*case_id/, "release_verify hands out a proof case id");
// The guardrail rollback precedes both pending answers: verifyReduction is asked before the
// liveness-bound replays_unavailable resolve and before the verifier token is handed out.
const reduceAt = verifySrc.indexOf("const reduced = verifyReduction(");
assert.ok(reduceAt > 0 && reduceAt < verifySrc.indexOf('reason: "replays_unavailable"') &&
  reduceAt < verifySrc.indexOf("await ensureVerifierToken(attempt"),
  "release_verify returns a pending answer before summarising the guardrails collected so far");
console.log("ok eval-release-verify-reduction");
