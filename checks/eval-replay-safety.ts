#!/usr/bin/env node
// FR-28-30: dependency modes never produce an uncontrolled write, and proof rows never reach search.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const { dependencyAction, sealedRows } = await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/replay-runs.js")).href);
assert.equal(dependencyAction({ mode: "sandbox", is_write: true, matcher_accepts: false }), "sandbox");
assert.equal(dependencyAction({ mode: "recorded", is_write: false, matcher_accepts: true }), "serve_recorded");
assert.equal(dependencyAction({ mode: "recorded", is_write: false, matcher_accepts: false }), "not_replayable", "no fabricated response");
assert.equal(dependencyAction({ mode: "simulated", is_write: true, matcher_accepts: false }), "simulate");
assert.equal(dependencyAction({ mode: "live_read_only", is_write: false, matcher_accepts: false }), "live_read");
assert.equal(dependencyAction({ mode: "live_read_only", is_write: true, matcher_accepts: false }), "not_replayable", "no live write");
assert.equal(dependencyAction({ mode: "non_replayable", is_write: false, matcher_accepts: true }), "not_replayable");
assert.throws(() => dependencyAction({ mode: "live_write", is_write: true, matcher_accepts: true }));
const rows = [{ id: 1, split: "validation" }, { id: 2, split: "proof" }, { id: 3, split: "evolve" }];
assert.deepEqual(sealedRows(rows, "search").map((r: { id: number }) => r.id), [1, 3], "search never sees proof");
assert.deepEqual(sealedRows(rows, "verifier").map((r: { id: number }) => r.id), [1, 2, 3]);
console.log("ok eval-replay-safety");
