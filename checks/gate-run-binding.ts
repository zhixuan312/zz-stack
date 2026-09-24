// Break-test for "a run is attributed to a version by time, not by a column nothing stamps".
//
// It plants `sv.version = e.step_version` back in the binding. That column is stamped only
// when a skill is served whole through skill_read; an installed skill read off disk stamps
// nothing, so every row the initiative-bearing insert writes carries skill_version_id NULL, a
// NULL cannot match that insert's conflict target, and the timer appends a duplicate each
// pass.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const FILE = "services/gateway/src/runs.ts";
const gate = () => spawnSync("node", ["scripts/gate.ts", "--quiet"], { encoding: "utf8" });
function fail(m: string): never { console.error("FAIL: " + m); process.exit(1); }

const original = readFileSync(FILE, "utf8");
if (gate().status !== 0) fail("the gate is already red before planting anything");

// COUPLED: services/gateway/src/runs.ts must keep spelling the binding as a single
// `const VERSION_AT_EVENT = \`...\`;`, or this regex matches nothing. One constant feeds all
// four sites, so replacing it plants the defect at every one of them at once.
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
