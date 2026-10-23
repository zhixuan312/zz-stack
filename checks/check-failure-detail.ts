#!/usr/bin/env node
/**
 * A failed check's reported detail ends with what it said about why it failed.
 *
 * The gate shows 400 characters of what a failing check printed. A check that starts a real
 * zz-core prints its cases on stdout and its `FAILED at "<case>"` line on stderr, followed by
 * zz-core's own tail (scripts/schema/throwaway-core.ts). With stdout first and stderr last, gate
 * 4590 reported only zz-core's warnings; with stderr first and stdout last, gate 4838 reported
 * only passing cases. Neither order keeps the reason, so failureDetail orders lines by kind.
 *
 *   1. the 4838 shape: cases on stdout, the FAILED line and zz-core's tail on stderr;
 *   2. the same with a 585-character reason: the window keeps the reason's head, which names the
 *      check and the case;
 *   3. an error that is not a case failure, thrown inside a throwaway zz-core: its message is
 *      kept, ahead of its stack frames and zz-core's tail;
 *   4. a plain uncaught throw, which node prints on stderr: its message is kept;
 *   5. an `N failure(s)` summary on stderr after progress on stdout is kept, its last item too;
 *   6. a short output is reported whole.
 *
 * Run: node checks/check-failure-detail.ts
 */
import { failureDetail } from "../scripts/gate/suite-runner.ts";

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

const cases = (n: number) => Array.from({ length: n }, (_, i) => `  case ${i}: both adapters close to the same record: ok`).join("\n");
const boot = (n: number) => Array.from({ length: n }, (_, i) => `zz-core: no zz.plugin_version row for zz-core 0.0.${i}`).join("\n");
const zzTail = `--- zz-core output (tail)\n${boot(30)}\n`;

// 1
const reason = 'console-close: FAILED at "two closes at once": the second close answered 200';
const d1 = failureDetail(`${reason}\n${zzTail}`, cases(30));
is(d1.includes(reason), `the 4838 shape lost its FAILED line: ${d1}`);

// 2
const long = `console-close: FAILED at "two closes through the route at once": answered ${JSON.stringify("x".repeat(250))}; the record is ${JSON.stringify("y".repeat(250))}`;
const d2 = failureDetail(`${long}\n${zzTail}`, cases(30));
is(d2.startsWith('console-close: FAILED at "two closes through the route at once"'), `a long reason lost its head: ${d2.slice(0, 120)}`);

// 3
const d3 = failureDetail(`console-close: TypeError: Cannot read properties of undefined (reading 'rows')\n    at run (checks/console-close.ts:200:5)\n    at async withThrowawayCore (scripts/schema/throwaway-core.ts:470:9)\n${zzTail}`, cases(30));
is(d3.includes("TypeError: Cannot read properties of undefined (reading 'rows')"), `a thrown error's message was cut: ${d3}`);

// 4
const d4 = failureDetail("file:///checks/x.ts:12\n  const n = rows[0].n;\n                    ^\n\nTypeError: Cannot read properties of undefined (reading 'n')\n    at file:///checks/x.ts:12:21\n    at ModuleJob.run (node:internal/modules/esm/module_job:429:5)\n\nNode.js v25.9.0\n", cases(30));
is(d4.includes("TypeError: Cannot read properties of undefined (reading 'n')"), `an uncaught throw's message was cut: ${d4}`);

// 5
const d5 = failureDetail("review-rounds: 2 failure(s)\n  - case 3: the round was not counted\n  - case 7: the budget did not renew\n", cases(30));
is(d5.includes("review-rounds: 2 failure(s)") && d5.endsWith("case 7: the budget did not renew"), `a failure summary was cut: ${d5}`);

// 6
is(failureDetail("warn\n", "a: ok\n") === "a: ok; warn", `a short output was not reported whole: ${failureDetail("warn\n", "a: ok\n")}`);

if (fail.length) {
  console.error(`check-failure-detail: ${fail.length} failure(s)`);
  for (const f of fail) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("check-failure-detail: a failed check's reason is in its detail, whichever stream printed it and however long it is");
