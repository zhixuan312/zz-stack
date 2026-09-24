#!/usr/bin/env node
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const { scoreRun } = await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/score.js")).href);
const kinds = ["effectiveness", "reliability", "constraint_adherence", "recovery_robustness", "efficiency", "generalization"];
const w = [0.3, 0.2, 0.2, 0.1, 0.1, 0.1];
const dims = (vals: (number | null)[]) => kinds.map((k, i) => ({ key: k, canonical_kind: k, weight: w[i], required: true,
  applicable: true, not_applicable_reason: null as string | null, measures: [{ weight: 1, required: true as boolean, value: vals[i] }] }));
const all = scoreRun({ dimensions: dims([1, 0.5, 1, 0, 1, 0.5]), coverage_met: true, qualification_met: true, guardrails: ["pass"] });
assert.equal(all.overall, 7.5); assert.equal(all.status, "established"); assert.equal(all.guardrail_status, "pass");
assert.equal(all.dimensions.length, 6);
const partial = scoreRun({ dimensions: dims([1, null, 1, 1, 1, 1]), coverage_met: true, qualification_met: true, guardrails: [] });
assert.equal(partial.status, "provisional"); assert.equal(partial.overall, 10);
const none = scoreRun({ dimensions: dims([null, null, null, null, null, null]), coverage_met: true, qualification_met: true, guardrails: [] });
assert.equal(none.status, "not_established"); assert.equal(none.overall, null);
const unq = scoreRun({ dimensions: dims([1, 1, 1, 1, 1, 1]), coverage_met: true, qualification_met: false, guardrails: [] });
assert.equal(unq.status, "provisional", "unqualified evidence cannot establish");
const g = scoreRun({ dimensions: dims([1, 1, 1, 1, 1, 1]), coverage_met: true, qualification_met: true, guardrails: ["pass", "fail"] });
assert.equal(g.guardrail_status, "fail"); assert.equal(g.overall, 10, "guardrail never changes the number");
const na = dims([1, 1, 1, 1, 1, 0]); na[5].applicable = false; na[5].not_applicable_reason = "no OOD cases";
assert.equal(scoreRun({ dimensions: na, coverage_met: true, qualification_met: true, guardrails: [] }).overall, 10, "N/A re-normalises");
const opt = dims([1, 1, 1, 1, 1, 1]); opt[0].measures = [{ weight: 0.5, required: true, value: 1 }, { weight: 0.5, required: false, value: null }];
assert.equal(scoreRun({ dimensions: opt, coverage_met: true, qualification_met: true, guardrails: [] }).dimensions[0].score, 1);
assert.throws(() => scoreRun({ dimensions: dims([1.2, 1, 1, 1, 1, 1]), coverage_met: true, qualification_met: true, guardrails: [] }), RangeError);
console.log("ok eval-score-formula");
