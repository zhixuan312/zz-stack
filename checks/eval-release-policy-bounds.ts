#!/usr/bin/env node
// The protocol's improvement.release is the only policy a release is judged by (002): the run
// count real use must reach is a positive integer, and the regression band is never negative. A
// dimension's weight must be positive only when the dimension is applicable, because score.ts
// never reads an inapplicable dimension's weight.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const { ReleasePolicy, EvaluationProtocol, Dimension } = await import(
  pathToFileURL(join(process.cwd(), "packages/contracts/dist/index.js")).href);

const policy = { minPostReleaseRuns: 5, regressionBand: 0.1 };
assert.ok(ReleasePolicy.safeParse(policy).success, "a sound policy parses");
assert.ok(ReleasePolicy.safeParse({ ...policy, regressionBand: 0 }).success, "a zero band is allowed");
for (const [field, value] of [
  ["minPostReleaseRuns", 0], ["minPostReleaseRuns", -1], ["minPostReleaseRuns", 2.5],
  ["regressionBand", -0.01],
] as const) {
  assert.ok(!ReleasePolicy.safeParse({ ...policy, [field]: value }).success, `${field}: ${value} is refused`);
}
assert.ok(!ReleasePolicy.safeParse({ regressionBand: 0.1 }).success, "a policy naming no run count is refused");

const measure = { key: "m", evaluatorType: "deterministic", weight: 1, suite: "capability", required: true, definition: {}, evaluator: null };
const dim = {
  key: "d", name: "D", canonicalKind: "effectiveness", weight: 1, required: true,
  applicable: true, notApplicableReason: null, measures: [measure],
};
assert.ok(Dimension.safeParse(dim).success, "an applicable dimension with a positive weight parses");
assert.ok(!Dimension.safeParse({ ...dim, weight: 0 }).success, "an applicable dimension at weight 0 is refused");
assert.ok(Dimension.safeParse({ ...dim, weight: 0, applicable: false, notApplicableReason: "no surface" }).success,
  "an inapplicable dimension may carry weight 0 — the scorer never reads it");
assert.ok(!Dimension.safeParse({ ...dim, weight: -1, applicable: false, notApplicableReason: "no surface" }).success,
  "a negative weight is refused either way");

// A protocol body carries no replay, search, selection or proof policy any more.
const body = {
  protocolKey: "k", version: 1, pluginPurpose: "p", observableSurfaces: [], failureTaxonomy: [], dimensions: [dim],
  suites: { capability: {}, regression: {}, production: {} },
  qualification: { boundedSemanticMinimum: "operationally_qualified", thresholds: {}, labelMappings: [] },
  scoring: { establishment: { bootstrap: true, minCoverage: {} }, uncertainty: {} },
  improvement: { evolvable: true, criticalGuardrails: [], release: policy },
};
assert.ok(EvaluationProtocol.safeParse(body).success, "a body with improvement.release parses");
assert.ok(!EvaluationProtocol.safeParse({ ...body, improvement: { evolvable: true, criticalGuardrails: [] } }).success,
  "a body with no improvement.release is refused");
assert.ok(!("replay" in EvaluationProtocol.parse({ ...body, replay: {} })), "a replay section is not part of the protocol");

console.log("ok eval-release-policy-bounds");
