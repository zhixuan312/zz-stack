// `--profile acceptance` does not pass a suite on cases that never ran.
//
// WHAT THIS PREVENTS IS A GREEN TICK NOBODY EARNED. All thirteen acceptance criteria name
// `npm run tenant-info -- verify --suite <name> --profile acceptance` as the command that
// produces their evidence, and the spec's CLI contract says of that profile: "forbids case
// restrictions and runs the complete required suite. Partial cases never pass a whole
// business AC."
//
// MEASURED WHILE WRITING THE ISOLATION SUITE. `--profile` was parsed and validated and then
// threaded nowhere — `runReadySuite` called `mod.run({ cases })` identically for both
// profiles. Suites deliberately treat a `not_run` case as non-blocking, which is right at the
// integration profile (an unreachable PostgreSQL 17 must not drag down the offline cases a
// checkout CAN prove) and exactly wrong at the acceptance one. The isolation suite reported
// `passed` at `--profile acceptance` with its two live-database cases never executed.
//
// THREE PROPERTIES, ALL REQUIRED. A suite with an unrun case is `blocked` at acceptance and
// unchanged at integration; a receipt whose per-case status cannot be read is `blocked` too,
// because a suite that cannot show what it ran cannot show it ran everything; and `blocked`
// stays distinct from `failed`, so a reader of acceptance.json never mistakes "we never stood
// up the database" for "isolation is broken".
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runReadySuite } from "../scripts/tenant-info/verify.ts";

const dir = mkdtempSync(join(tmpdir(), "zz-acceptance-profile-"));

/** A suite module written to disk, because `runReadySuite` reaches its subject by dynamic
 *  import — driving the real function end to end rather than a re-implementation of it. */
function suiteModule(name: string, body: string): string {
  const path = join(dir, `${name}.ts`);
  writeFileSync(path, body);
  return path;
}

const withUnrun = suiteModule("unrun", `
export function run() {
  return { passed: true, detail: { status: "ran", cases: {
    offline_case: { status: "passed" },
    live_case: { status: "not_run", reason: "no isolated database" },
  } } };
}
`);

const allRan = suiteModule("allran", `
export function run() {
  return { passed: true, detail: { status: "ran", cases: { offline_case: { status: "passed" } } } };
}
`);

const opaque = suiteModule("opaque", `
export function run() { return { passed: true, detail: { status: "ran" } }; }
`);

const red = suiteModule("red", `
export function run() {
  return { passed: false, detail: { status: "ran", cases: { offline_case: { status: "failed" } } } };
}
`);

const fail: string[] = [];
const expect = (condition: boolean, message: string) => { if (!condition) fail.push(message); };

const integration = await runReadySuite("unrun", withUnrun, undefined, "integration");
expect(integration.status === "passed",
  `a not_run case must stay non-blocking at --profile integration, got "${integration.status}" — an ` +
  "unreachable live database would now drag down every offline case this checkout can prove");

const acceptance = await runReadySuite("unrun", withUnrun, undefined, "acceptance");
expect(acceptance.status === "blocked",
  `a suite with an unrun case must be "blocked" at --profile acceptance, got "${acceptance.status}" — ` +
  "this is the exact shape that let a criterion collect a green tick for a case that never executed");
expect((acceptance.blocked_cases ?? []).includes("live_case"),
  "the receipt must NAME the case that did not run — a block with no named case is indistinguishable " +
  "from a bare refusal, and acceptance.json has to say which evidence is missing");

const complete = await runReadySuite("allran", allRan, undefined, "acceptance");
expect(complete.status === "passed",
  `a suite that ran every case must still pass at acceptance, got "${complete.status}" — a guard that ` +
  "refuses everything is not a guard");

const unreadable = await runReadySuite("opaque", opaque, undefined, "acceptance");
expect(unreadable.status === "blocked",
  "a receipt with no readable per-case status must be blocked at acceptance — otherwise the weakest " +
  "suite in the repository is the easiest one to pass");

const failed = await runReadySuite("red", red, undefined, "acceptance");
expect(failed.status === "failed",
  `an assertion that ran and went red stays "failed", not "blocked" — got "${failed.status}"; a failure ` +
  "is a fact about the system and a block is a fact about the run, and collapsing them misreports both");

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("acceptance-profile-refuses-unrun-cases: ok");
