// Break-test for "a run is attributed to a version by time, not by a column nothing stamps".
//
// The check landed in a227251 and WAS break-tested — by hand, with a throwaway script, in a
// session transcript. That is not a break-test: nobody can re-run it, and a check nobody can
// re-prove is a check that quietly stops working. This is the same plant, committed.
//
// What it plants is the original defect, exactly: `sv.version = e.step_version` back in the
// binding. That column is stamped only when a skill is served WHOLE through skill_view, and an
// installed skill read off disk stamps nothing — measured twice a day apart, it sat frozen at
// 39 rows while the event log grew by a third. Every row the initiative-bearing insert wrote
// therefore carried skill_version_id NULL, a NULL cannot match that insert's conflict target,
// and the timer appended a duplicate every pass: 1801 of 1805 rows.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const FILE = "services/gateway/src/runs.ts";
const gate = () => spawnSync("node", ["scripts/gate.mjs", "--quiet"], { encoding: "utf8" });
const fail = (m) => { console.error("FAIL: " + m); process.exit(1); };

const original = readFileSync(FILE, "utf8");
if (gate().status !== 0) fail("the gate is already red before planting anything");

// The binding lives in one constant so the four sites cannot drift apart; replacing it plants
// the defect at every one of them at once, which is the shape the original had.
const planted = original.replace(
  /const VERSION_AT_EVENT = `[\s\S]*?`;/,
  'const VERSION_AT_EVENT = `\n      join zz.skill_version sv on sv.skill_id = s.id and sv.version = e.step_version`;');
if (planted === original) {
  fail("could not plant the defect — the VERSION_AT_EVENT anchor did not match, so this " +
       "break-test is not testing anything. Re-point it at whatever runs.ts actually says.");
}
writeFileSync(FILE, planted);
const red = gate();
writeFileSync(FILE, original);
const green = gate();

if (red.status === 0) {
  fail("the gate stayed GREEN with step_version back in the binding — the check does not work, " +
       "and zz.run would start accumulating phantom rows again with nothing to say so");
}
if (green.status !== 0) fail("the gate did not return to GREEN after restoring:\n" + green.stdout);
console.log("PASS: red with step_version in the binding, green with the time binding.");
