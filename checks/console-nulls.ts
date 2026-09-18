// An aggregate nothing measured renders as null, never as a confident zero.
//
// WHY THIS EXISTS AT ALL. This property was implemented, reviewed and left uncovered, and then
// a `git checkout --` reverted the file and NOTHING WENT RED. The gate read
// `GATE PASSED — 296 checks` with the conflation restored. The work that had a check came back
// because a check demanded it; this came back only because someone happened to grep for it.
// A property with no check is a property that survives exactly as long as nobody touches it.
import { existsSync, readFileSync } from "node:fs";

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

// Control: NOTHING may report `turns` again, in any form. The column was written by nothing
// — no statement anywhere set it — and no `kind='turn'` event has ever been emitted either,
// so the console reported a field that could only be zero and built a "turns are not
// attributed to runs" caveat from it that could never clear. This used to pin the `> 0` form
// as a deliberate exception to the null rule above; the honest resolution was to stop
// reporting a measurement nothing takes. A reader that returns is a reader to delete, not a
// coercion to get right.
if (/\bturns\b/.test(src)) {
  fail.push("skills.ts reads `turns` again — zz.run.turns is written by nothing and no turn " +
            "event is emitted, so any figure built on it is a zero wearing the clothes of a " +
            "measurement. Delete the reader; do not coerce it.");
}

// ── THE SAME PROPERTY, ON THE OVERVIEW ─────────────────────────────────────────────────
// The status row reads `zz.run.bytes_total`, which migration 051 made nullable for exactly
// the reason above: a run nobody measured is not a run that moved nothing. This file pinned
// the property on skills.ts alone, so the overview reintroduced the conflation one layer up
// with `Number(v ?? 0)` and nothing went red — the second time this gate has watched that
// happen. A check that names one file protects one file.
//
// GUARDED, AND THE GUARD IS THE POINT. `readFileSync` on a path that is not there throws
// ENOENT, and a check that throws does not fail — it takes the whole gate down before any
// check reports, so a clone without this file gets no verdict instead of a red one. That is
// the runtime twin of the unresolvable-import hole the tracked-check guard closed. The rule
// arms itself when the file arrives, which also means this check and the source it reads can
// be committed in either order without one breaking the other.
const o = "services/gateway/src/console/overview-metrics.ts";
if (existsSync(o)) {
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
  // The count helper must stay keyed to counts. `?? 0` is right for an absent ROW and wrong for
  // a null AGGREGATE, and one helper serving both is how this came back the first time.
  if (!/const count\s*=/.test(osrc)) {
    fail.push(`${o} has no count() helper — see the note there for why it is not called num()`);
  }
  if (/\bcount\(\s*r\.bytes/.test(osrc)) {
    fail.push(`${o} points count() at a nullable aggregate — that helper is for count(*) only`);
  }
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("console nulls: ok");
