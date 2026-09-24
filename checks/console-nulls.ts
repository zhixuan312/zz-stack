// An aggregate nothing measured renders as null, never as a confident zero.
//
// Both readers are pinned: skills.ts below, and overview-metrics.ts further down. A check that
// names one file protects one file.
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

// Control: nothing may report `turns`, in any form. `zz.run.turns` is written by no
// statement and no `kind='turn'` event is emitted, so a reader of it can only ever report zero.
if (/\bturns\b/.test(src)) {
  fail.push("skills.ts reads `turns` again — zz.run.turns is written by nothing and no turn " +
            "event is emitted, so any figure built on it is a zero wearing the clothes of a " +
            "measurement. Delete the reader; do not coerce it.");
}

// The same property, on the overview. The status row reads `zz.run.bytes_total`, which is
// nullable for the reason above: a run nobody measured is not a run that moved nothing.
// `Number(v ?? 0)` one layer up reintroduces the conflation.
const o = "services/gateway/src/console/overview-metrics.ts";
const osrc = readFileSync(o, "utf8");

// The nullable column is tested for null, not coerced.
if (!/\.bytes\s*!==\s*null/.test(osrc)) {
  fail.push(`${o} does not test run bytes for null — \`Number(null ?? 0)\` is 0, so a run ` +
            `nobody measured renders as a measured zero and pulls the median down with it`);
}
// And the runs it could not measure are reported rather than silently dropped: a median over
// a set the reader cannot size is its own quiet lie.
if (!/unmeasured/.test(osrc)) {
  fail.push(`${o} drops unmeasured runs without counting them — the tile cannot say how many ` +
            `of its runs it could not see`);
}
// The count helper must stay keyed to counts: `?? 0` is right for an absent row and wrong
// for a null aggregate, and one helper cannot serve both.
if (!/const count\s*=/.test(osrc)) {
  fail.push(`${o} has no count() helper — see the note there for why it is not called num()`);
}
if (/\bcount\(\s*r\.bytes/.test(osrc)) {
  fail.push(`${o} points count() at a nullable aggregate — that helper is for count(*) only`);
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("console nulls: ok");
