#!/usr/bin/env node
/**
 * The documents a release is answerable for are walked once per gate, by the walk every other
 * check reads.
 *
 *   1. `ourDocs()` answers the same list to its five callers rather than walking the tree for each;
 *   2. it holds no path under node_modules or dist, nor under the trees whose documents are
 *      checked at their own source — the walk `sourceFiles` skips, not a second one beside it;
 *   3. it holds README.md, so the cases above are about a list that has documents in it.
 *
 * Run: node checks/our-docs.ts
 */
import { ourDocs } from "../scripts/gate/facts.ts";

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

const docs = ourDocs();
is(ourDocs() === docs, "ourDocs() walked the tree again on its second call — the gate asks it five times");
const stray = docs.filter((r) => r.split("/").some((seg) => seg === "node_modules" || seg === "dist") ||
  ["catalog", "skills", "services", "packages", "testing", "marketplace"].includes(r.split("/")[0]));
is(stray.length === 0, `ourDocs() holds ${stray.length} document(s) it must not: ${stray.slice(0, 4).join(", ")}`);
is(docs.includes("README.md"), "ourDocs() does not hold README.md — this check is reading nothing");

if (fail.length) {
  console.error(`our-docs: ${fail.length} failure(s)`);
  for (const f of fail) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`our-docs: ${docs.length} document(s), walked once, none under node_modules, dist or a checked-at-source tree`);
