#!/usr/bin/env node
/**
 * checks/shape-diffs-kinds.ts — the console's shape comparison names a value whose kind differs between the real
 * answer and the fake: an array against an object, an object against a primitive, two primitives of different types.
 *
 *   node checks/shape-diffs-kinds.ts
 *
 * Every `checks/console-*.ts` that holds a route to its fake compares through `shapeDiffs`, so a pair of different
 * kinds that it passed in silence is a route that changed shape with every one of those checks green.
 *
 * Exit 0: every case held. Exit 1: one did not, naming it.
 */
import { shapeDiffs } from "../scripts/schema/shape-diffs.ts";

const fail: string[] = [];
const cases: [string, unknown, unknown, boolean][] = [
  ["an array where the fake has an object", { byKind: [{ k: 1 }] }, { byKind: { k: 1 } }, true],
  ["an object where the fake has an array", { byKind: { k: 1 } }, { byKind: [1] }, true],
  ["a string where the fake has a number", { n: "12" }, { n: 12 }, true],
  ["an object where the fake has a string", { x: { a: 1 } }, { x: "a" }, true],
  // Controls: the same shape with different values, and a null on one side, are no difference.
  ["the same shape", { a: [{ b: 1 }], c: "x" }, { a: [{ b: 2 }], c: "y" }, false],
  ["a null on one side", { a: null }, { a: [1] }, false],
];
for (const [name, real, fake, differs] of cases) {
  const out = shapeDiffs(real, fake, "", []);
  if ((out.length > 0) !== differs) {
    fail.push(`${name}: ${differs ? "no difference reported" : `reported ${JSON.stringify(out)}`}`);
  }
}

if (fail.length) {
  console.error(`shape-diffs-kinds: ${fail.length} failure(s)\n  ${fail.join("\n  ")}`);
  process.exit(1);
}
console.log("shape-diffs-kinds: a value of a different kind on each side is a difference, and the controls are not");
