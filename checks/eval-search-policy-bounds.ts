#!/usr/bin/env node
// Round-2 review (finding 6): SearchPolicy's generation bounds are positive integers and its
// minMeaningfulEffect is never negative; round 3 (finding 4): wallClockHours is positive,
// minRepeats a positive integer, confidence inside (0, 1) and equivalenceBand never negative. A
// dimension's weight must be positive only when the dimension is applicable, because score.ts
// never reads an inapplicable dimension's weight.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const { SearchPolicy, Dimension } = await import(
  pathToFileURL(join(process.cwd(), "packages/contracts/dist/index.js")).href);

const policy = {
  maxGenerations: 2, maxCandidatesPerGeneration: 2, wallClockHours: 24, minRepeats: 3,
  minMeaningfulEffect: 0.05, confidence: 0.95, equivalenceBand: 0.1, complexity: "lines",
};
assert.ok(SearchPolicy.safeParse(policy).success, "a sound policy parses");
assert.ok(SearchPolicy.safeParse({ ...policy, minMeaningfulEffect: 0 }).success, "an mme of 0 is allowed");
assert.ok(SearchPolicy.safeParse({ ...policy, equivalenceBand: 0, wallClockHours: 0.5 }).success,
  "a zero band and a fractional hour bound are allowed");
for (const [field, value] of [
  ["maxGenerations", 0], ["maxGenerations", 1.5], ["maxCandidatesPerGeneration", -1],
  ["maxCandidatesPerGeneration", 2.5], ["minMeaningfulEffect", -0.1],
  // Round 3 (finding 4): the run bound, the repeat count, the confidence level and the band.
  ["wallClockHours", 0], ["wallClockHours", -1], ["minRepeats", 0], ["minRepeats", 2.5],
  ["confidence", 0], ["confidence", 1], ["confidence", 1.5], ["equivalenceBand", -0.01],
] as const) {
  assert.ok(!SearchPolicy.safeParse({ ...policy, [field]: value }).success, `${field}: ${value} is refused`);
}

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

console.log("ok eval-search-policy-bounds");
