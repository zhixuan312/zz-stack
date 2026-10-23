#!/usr/bin/env node
/**
 * A failed check's reported detail ends with the line that says why it failed.
 *
 * The gate shows the last 400 characters of what a failing check printed. A check that starts a
 * real zz-core prints its cases on stdout and its `FAILED at "<case>"` line on stderr, followed
 * by zz-core's own tail (scripts/schema/throwaway-core.ts). With stderr first and stdout last,
 * gate 4838 reported a column of passing cases and none of the reason. With stdout last and
 * stderr after it, gate 4590 reported only zz-core's boot warnings. Neither order of the two
 * streams keeps the reason, so the reason line is moved to the end, whichever stream it came on.
 *
 *   1. the 4838 shape: the FAILED line on stderr, ahead of zz-core's tail, many cases on stdout;
 *   2. the 4590 shape: a long boot log on stderr, the cases and a `FAIL:` line on stdout;
 *   3. an output with no failure line keeps its last line last;
 *   4. a short output is reported whole.
 *
 * Run: node checks/check-failure-detail.ts
 */
import { failureDetail } from "../scripts/gate/suite-runner.ts";

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

const cases = (n: number) => Array.from({ length: n }, (_, i) => `  case ${i}: both adapters close to the same record: ok`).join("\n");
const boot = (n: number) => Array.from({ length: n }, (_, i) => `zz-core: no zz.plugin_version row for zz-core 0.0.${i}`).join("\n");

// 1
const reason = 'console-close: FAILED at "two closes at once": the second close answered 200';
const d1 = failureDetail(`${reason}\n--- zz-core output (tail)\n${boot(30)}\n`, cases(30));
is(d1.includes(reason), `the 4838 shape lost its FAILED line: ${d1}`);

// 2
const d2 = failureDetail(boot(40), `${cases(10)}\nFAIL: the record is read at one cutoff`);
is(d2.includes("FAIL: the record is read at one cutoff"), `the 4590 shape lost its FAIL line: ${d2}`);

// 3
const d3 = failureDetail("", `${cases(30)}\nTypeError: cannot read properties of undefined`);
is(d3.endsWith("TypeError: cannot read properties of undefined"), `an output with no failure line did not keep its last line last: ${d3}`);

// 4
is(failureDetail("warn\n", "a: ok\n") === "warn; a: ok", `a short output was not reported whole: ${failureDetail("warn\n", "a: ok\n")}`);

if (fail.length) {
  console.error(`check-failure-detail: ${fail.length} failure(s)`);
  for (const f of fail) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("check-failure-detail: a failed check's reason ends its detail, whichever stream it was printed on");
