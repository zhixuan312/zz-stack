#!/usr/bin/env node
// Round-2 review (finding 3): a sealed proof leaks at most one bit per resolved decision. The case
// set's proof split stays spent after proof_passed/proof_failed and after a not_established whose
// runs executed on proof cases; it is released when no run executed, or when the only gap was an
// unavailable leakage answer. Pure: candidate-prove-decide.ts on values alone.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const { proofSplitSpent } = await import(
  pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/candidate-prove-decide.js")).href);

assert.equal(proofSplitSpent("proof_passed", true, "no"), true, "a pass resolved a decision");
assert.equal(proofSplitSpent("proof_failed", true, "yes"), true, "a failure resolved a decision");
assert.equal(proofSplitSpent("not_established", false, null), false,
  "insufficient cases, or abandoned before any proof run was registered: no case was drawn");
assert.equal(proofSplitSpent("not_established", true, "unavailable"), false,
  "a leakage outage is not a property of the candidate: released");
assert.equal(proofSplitSpent("not_established", true, "unclear"), true,
  "an unclear critic after runs executed: the runs observed the cases, spent");
assert.equal(proofSplitSpent("not_established", true, "no"), true,
  "proof_unresolved / guardrails_not_established after runs executed: spent");
assert.equal(proofSplitSpent("not_established", true, null), true,
  "abandoned after runs executed: spent");

console.log("ok eval-proof-split-release");
