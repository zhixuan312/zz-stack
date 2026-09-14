// An aggregate nothing measured renders as null, never as a confident zero.
//
// WHY THIS EXISTS AT ALL. This property was implemented, reviewed and left uncovered, and then
// a `git checkout --` reverted the file and NOTHING WENT RED. The gate read
// `GATE PASSED — 296 checks` with the conflation restored. The work that had a check came back
// because a check demanded it; this came back only because someone happened to grep for it.
// A property with no check is a property that survives exactly as long as nobody touches it.
import { readFileSync } from "node:fs";

const fail = [];
const f = "services/gateway/src/console/skills.ts";
const src = readFileSync(f, "utf8");

// The fields that come from `avg`/`sum`/`round` and can therefore be SQL null: every one of
// them reached the JSON through a unary plus, and `+null` is 0.
const FIELDS = ["durationAvg", "durationMedian", "durationMax", "kbPerRun", "mbTotal"];
for (const field of FIELDS) {
  const m = new RegExp(`${field}\\s*:\\s*([^,\\n}]+)`).exec(src);
  if (!m) { fail.push(`${f} no longer emits ${field}`); continue; }
  if (/^\s*\+/.test(m[1])) {
    fail.push(`${field} is coerced with a unary plus — \`+null\` is 0, so a group nothing ` +
              `measured reports as instant and free`);
  }
}
// The run-level total goes through the same door.
if (/\bmb:\s*\+/.test(src)) {
  fail.push("the run-level `mb` total is coerced with a unary plus — same conflation");
}

// The helper exists and distinguishes null from zero. Testing `> 0` would be wrong here: unlike
// the neighbouring `turns` field, a real 0 is meaningful — measured, and empty.
const helper = /const num\s*=\s*\([^)]*\)[^=]*=>\s*\(([^;]+)\);/.exec(src);
if (!helper) {
  fail.push(`${f} has no num() helper to report an unmeasured aggregate as null`);
} else if (!/===\s*null/.test(helper[1])) {
  fail.push("num() does not test for null — a helper keyed on `> 0` would erase a measured zero");
}

// Control: `turns` MUST keep its `> 0` form. It is the one field where zero is not a real
// finding — zz.run.turns is 0 on every row while the event log holds turn events with no run
// id — so a check that rewrote every coercion the same way would break a deliberate difference.
if (!/turns:\s*\+r\.turns\s*>\s*0/.test(src)) {
  fail.push("turns lost its `> 0` form — there, 0 means unknown and the file says why");
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("console nulls: ok");
