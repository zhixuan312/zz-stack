#!/usr/bin/env node
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const { pairedDecision } = await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/stats.js")).href);
const opts = { resamples: 2000, seed: "s", confidence: 0.95 };
const up = pairedDecision(Array(20).fill(1.0), 0.3, opts);
assert.equal(up.verdict, "improves"); assert.equal(up.mean, 1);
assert.equal(pairedDecision(Array(20).fill(-0.5), 0.3, opts).verdict, "not_improved");
const noisy = [1.5, -1.2, 0.9, -0.8, 1.1, -1.0, 0.7, -0.6, 1.3, -1.1];
assert.equal(pairedDecision(noisy, 0.3, opts).verdict, "unresolved");
assert.deepEqual(pairedDecision(noisy, 0.3, opts), pairedDecision(noisy, 0.3, opts), "seeded and reproducible");
const r = pairedDecision(noisy, 0.3, opts); assert.ok(r.lower <= r.mean && r.mean <= r.upper);
console.log("ok eval-paired-stats");
