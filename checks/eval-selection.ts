#!/usr/bin/env node
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const { paretoFrontier, selectFinal } = await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/selection.js")).href);
const f = paretoFrontier([
  { id: "a", pass_vector: [1, 1, 0], cost: 10 }, { id: "b", pass_vector: [1, 0, 0], cost: 12 },
  { id: "c", pass_vector: [0, 1, 1], cost: 10 }, { id: "d", pass_vector: [1, 1, 0], cost: 5 }]);
assert.deepEqual([...f].sort(), ["c", "d"], "a and b are dominated");
const c = (id: string, lb: number, cx = 0, lat = 0, cost = 0, g = true) =>
  ({ id, guardrails_pass: g, lower_bound: lb, complexity_delta: cx, latency_delta: lat, cost_delta: cost });
assert.equal(selectFinal([c("x", 0.9), c("y", 0.5)], 0.1), "x");
assert.equal(selectFinal([c("x", 0.9, 50), c("y", 0.85, -10)], 0.1), "y", "within band, lower complexity wins");
assert.equal(selectFinal([c("x", 0.9, 0, 5), c("y", 0.9, 0, 1)], 0.1), "y", "then latency");
assert.equal(selectFinal([c("x", 0.9, 0, 0, 1), c("w", 0.9, 0, 0, 1)], 0.1), "w", "then id");
assert.equal(selectFinal([c("x", 2.0, 0, 0, 0, false), c("y", 0.4)], 0.1), "y", "guardrail failure excluded");
assert.equal(selectFinal([c("x", 1, 0, 0, 0, false)], 0.1), null);
console.log("ok eval-selection");
