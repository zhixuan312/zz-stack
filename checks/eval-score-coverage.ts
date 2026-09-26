#!/usr/bin/env node
// One excluded required measure lowers its dimension's coverage; it never nulls the dimension or
// the overall. The live zz-core evaluation had reliability null beside 0.981 and 0.933 scored,
// and so no overall at all. Pure: no database, no model.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const { scoreRun, PROVISIONAL_COVERAGE_FLOOR } =
  await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/score.js")).href);

const dim = (key: string, weight: number, measures: { weight: number; required: boolean; value: number | null }[]) =>
  ({ key, canonical_kind: key, weight, required: true, applicable: true, not_applicable_reason: null, measures });

// The live shape: reliability's three required measures, one excluded.
const reliability = dim("reliability", 0.5, [
  { weight: 0.4, required: true, value: 0.981 },
  { weight: 0.3, required: true, value: null },
  { weight: 0.3, required: true, value: 0.933 },
]);
const effectiveness = dim("effectiveness", 0.5, [{ weight: 1, required: true, value: 0.8 }]);
const run = scoreRun({ dimensions: [reliability, effectiveness], coverage_met: true, qualification_met: true, guardrails: [] });
const rel = run.dimensions.find((d: { key: string }) => d.key === "reliability");
assert.equal(rel.score, Number(((0.4 * 0.981 + 0.3 * 0.933) / 0.7).toFixed(4)), "the dimension scores from its scored measures, re-normalised");
assert.equal(rel.coverage, 0.7, "and reports the scored share of its declared weight");
assert.notEqual(run.overall, null, "one excluded measure never nulls the overall");
assert.equal(run.coverage, 0.85, "run coverage is the dimension-weighted mean of dimension coverage");
assert.equal(run.status, "provisional", "a required measure missing withholds established, not the number");
assert.equal(run.coverage_floor, PROVISIONAL_COVERAGE_FLOOR);

// Below the floor: the number is still reported, the status says how little it covers.
const thin = scoreRun({
  dimensions: [dim("a", 0.5, [{ weight: 0.2, required: true, value: 1 }, { weight: 0.8, required: true, value: null }]),
               dim("b", 0.5, [{ weight: 1, required: true, value: null }])],
  coverage_met: true, qualification_met: true, guardrails: [] });
assert.equal(thin.overall, 10);
assert.equal(thin.coverage, 0.1);
assert.equal(thin.status, "not_established", "coverage under the floor is not even provisional");

// Nothing scored: the only case overall is null.
const none = scoreRun({ dimensions: [dim("a", 1, [{ weight: 1, required: true, value: null }])],
  coverage_met: true, qualification_met: true, guardrails: [] });
assert.equal(none.overall, null);
assert.equal(none.coverage, 0);
assert.equal(none.status, "not_established");

// Everything scored, qualified and covered still establishes.
const full = scoreRun({ dimensions: [dim("a", 1, [{ weight: 1, required: true, value: 0.5 }])],
  coverage_met: true, qualification_met: true, guardrails: [] });
assert.equal(full.status, "established");
assert.equal(full.coverage, 1);
console.log("ok eval-score-coverage");
