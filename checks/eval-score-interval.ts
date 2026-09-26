#!/usr/bin/env node
// evaluation_score's interval is an interval of the run's own overall.
//
// The live zz-core evaluation reported overall 8.26 with a 95% interval of 8.61-8.78: the interval
// bootstrapped the mean of each subject's own overall, a different estimator from the overall it
// sat beside. Pure: the resampling is seeded, and the statistic is handed in.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const { bootstrapInterval, resolveUncertainty } = await import(
  pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/evaluate-interval.js")).href);

// Two kinds of subject, scored on different measures, pooled per measure as the run is: the mean
// of per-subject scores and the pooled statistic differ, and only the pooled one is the overall.
const docs = [0.9, 0.8, 0.7];
const runs = Array.from({ length: 40 }, (_, i) => (i % 5 === 0 ? 0.2 : 0.9));
const subjects = [...docs.map((v) => ({ kind: "doc", v })), ...runs.map((v) => ({ kind: "run", v }))];
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const overallOf = (indices: readonly number[]): number | null => {
  const picked = indices.map((i) => subjects[i]);
  const d = mean(picked.filter((s) => s.kind === "doc").map((s) => s.v));
  const r = mean(picked.filter((s) => s.kind === "run").map((s) => s.v));
  const present = [[0.6, d], [0.4, r]].filter(([, v]) => v !== null) as [number, number][];
  const w = present.reduce((a, [x]) => a + x, 0);
  return present.length ? present.reduce((a, [x, v]) => a + x * v, 0) / w * 10 : null;
};
const all = subjects.map((_, i) => i);
const overall = overallOf(all)!;
const settings = resolveUncertainty(undefined, "check-seed");
const interval = bootstrapInterval(subjects.length, overallOf, settings);
assert.equal(interval.degenerate, false);
assert.ok(interval.lower <= overall && overall <= interval.upper,
  `the interval ${interval.lower}-${interval.upper} contains the overall ${overall} it describes`);
assert.deepEqual(bootstrapInterval(subjects.length, overallOf, settings), interval, "seeded: a replay reproduces it");

const one = bootstrapInterval(1, () => 7.5, settings);
assert.equal(one.degenerate, true);
assert.equal(one.lower, 7.5);
const none = bootstrapInterval(3, () => null, settings);
assert.equal(none.degenerate, true, "a statistic that never scores gives no interval");
assert.equal(none.lower, null);
console.log("ok eval-score-interval");
