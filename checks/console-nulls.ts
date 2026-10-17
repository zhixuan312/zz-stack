// An aggregate nothing measured renders as null, never as a confident zero.
//
// The reader pinned is skills.ts, by name: a check that names one file protects one file.
import { readFileSync } from "node:fs";

const fail = [];
const f = "services/gateway/src/console/skills.ts";
const src = readFileSync(f, "utf8");

// The fields that come from `avg`/`sum`/`round` and can therefore be SQL null. A unary plus
// on any of them turns null into 0.
const FIELDS = ["durationAvg", "durationMedian", "durationMax", "kbPerRun", "mbTotal"];
for (const field of FIELDS) {
  const m = new RegExp(`${field}\\s*:\\s*([^,\\n}]+)`).exec(src);
  if (!m) { fail.push(`${f} no longer emits ${field}`); continue; }
  if (/^\s*\+/.test(m[1])) {
    fail.push(`${field} is coerced with a unary plus — \`+null\` is 0, so a group nothing ` +
              `measured reports as instant and free`);
  }
}

// The helper exists and distinguishes null from zero. Testing `> 0` would be wrong here: unlike
// the old model-turn count, a real 0 is meaningful — measured, and empty.
const helper = /const num\s*=\s*\([^)]*\)[^=]*=>\s*\(([^;]+)\);/.exec(src);
if (!helper) {
  fail.push(`${f} has no num() helper to report an unmeasured aggregate as null`);
} else if (!/===\s*null/.test(helper[1])) {
  fail.push("num() does not test for null — a helper keyed on `> 0` would erase a measured zero");
}

// Control: nothing may report `turns`, in any form. `zz.skill_run` has no such column and no
// statement writes one — `model_call` records each turn as its own row — so a reader of it can
// only ever report zero.
if (/\bturns\b/.test(src)) {
  fail.push("skills.ts reads `turns` again — zz.skill_run carries no such column and no turn " +
            "event is emitted, so any figure built on it is a zero wearing the clothes of a " +
            "measurement. Delete the reader; do not coerce it.");
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("console nulls: ok");
