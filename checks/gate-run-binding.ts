// Break-test for "a run is attributed to a version by time, not by a column nothing stamps".
//
// It plants `released_at >= ${at}` in the bound. The resolution then answers with the latest
// version released at or AFTER the event, and for a call being written now that is a version
// which does not exist yet — so the event's skill_version_id resolves null, the door's guard on
// the identity tuple never holds, and no run is created for any call. A skill whose runs stop
// being recorded is indistinguishable, in every query, from one nobody used.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const FILE = "services/gateway/src/runs.ts";
const gate = () => spawnSync("node", ["scripts/gate.ts", "--quiet"], { encoding: "utf8" });
function fail(m: string): never { console.error("FAIL: " + m); process.exit(1); }

const original = readFileSync(FILE, "utf8");
if (gate().status !== 0) fail("the gate is already red before planting anything");

// COUPLED: services/gateway/src/runs.ts must keep spelling the bound as a single
// `v.released_at <= ${at}`, or this regex matches nothing. One function feeds both of the door's
// statements, so replacing it plants the defect wherever a version is resolved at all.
const planted = original.replace(
  /v\.released_at <= \$\{at\}/,
  () => "v.released_at >= ${at}");
if (planted === original) {
  fail("could not plant the defect — the released_at anchor did not match, so this " +
       "break-test is not testing anything. Re-point it at whatever runs.ts actually says.");
}
writeFileSync(FILE, planted);
const red = gate();
writeFileSync(FILE, original);
const green = gate();

if (red.status === 0) {
  fail("the gate stayed GREEN with the bound flipped — the check does not work, and every call " +
       "would leave the per-version report it exists for with nothing to say so");
}
if (green.status !== 0) fail("the gate did not return to GREEN after restoring:\n" + green.stdout);
console.log("PASS: red with the bound flipped, green with the time binding.");
