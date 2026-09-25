#!/usr/bin/env node
// A qualification control passes when the evaluator answers what the OTHER plugin's numbers say.
// Found by scripts/eval-flow-e2e.ts: the rule was "answer differs from this plugin's own anchor",
// so whenever both plugins' counts had the same sign — two plugins both in use, the ordinary case
// — a truthful evaluator failed every control and no measure ever reached operationally_qualified.
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { controlOf } = await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/qualify-evidence.js")).href);

const vocabulary = { positive: "yes", zero: "no" };
const anchor = { key: "usable_run_coverage", n: 84, d: 100, subject: "", expected: "yes" };
const snapshot = (usable: number, total: number) => ({ id: "s", usable_run_count: usable, total_run_count: total, coverage: null });

// Same sign as this plugin's own anchor: the truthful answer is the anchor's own, and it passes.
const same = controlOf(anchor, snapshot(3, 9), vocabulary);
assert.ok(same, "a foreign snapshot with runs yields a control");
assert.equal(same.expected, "yes", "the control expects what the foreign count says, not the opposite of this plugin's anchor");
assert.match(same.subject, /Of 9 run\(s\).*, 3 were usable/, "the control states the foreign numbers");

// Opposite sign: the truthful answer differs from the anchor's.
assert.equal(controlOf(anchor, snapshot(0, 9), vocabulary).expected, "no");

// A foreign snapshot that never recorded the fact contributes no control.
assert.equal(controlOf(anchor, snapshot(0, 0), vocabulary), null);

console.log("ok eval-qualify-controls");
