#!/usr/bin/env node
/**
 * The doctor's contract layer looks for every tool zz-core registers for every caller, one at a
 * time, and for no tool only a superadmin is offered.
 *
 * Registers the real layer (registration only; no probe runs and no host is reached) and hands
 * `unservedTools` a served list built from the source's own declaration:
 *   1. everything served is nothing missing;
 *   2. `assess`, the only tool tools/assess.ts registers, left out is reported under that module —
 *      a whole-module rule that needed two missing tools passed a dropped one-tool module;
 *   3. every `if (sup)` tool left out, as under the member token the doctor asks with, is nothing
 *      missing — knowledge_reindex is the only tool knowledge-index.ts registers.
 *
 * Run: node checks/doctor-contract-tools.ts
 */
import { unservedTools } from "../scripts/doctor/layers/contract.ts";
import { zzCoreTools } from "../scripts/gate/read.ts";

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

const all = zzCoreTools().map((t) => t.name);
const SUPERADMIN = ["knowledge_reindex", "bug_list", "bug_resolve", "bug_delete"];
is(all.includes("assess") && SUPERADMIN.every((n) => all.includes(n)),
   "the source no longer declares assess and the four superadmin tools — this check is reading nothing");
const without = (gone: string[]) => new Set(all.filter((n) => !gone.includes(n)));

is(unservedTools(new Set(all)) === null, `every tool served still reports ${unservedTools(new Set(all))}`);
const one = unservedTools(without(["assess"]));
is(one?.includes("services/zz-core/src/tools/assess.ts (assess)"),
   `assess, its module's only tool, left off the doors reports ${JSON.stringify(one)}`);
const sup = unservedTools(without(SUPERADMIN));
is(sup === null, `the superadmin's tools left off the doors, as a member token sees them, report ${sup}`);

if (fail.length) {
  console.error(`doctor-contract-tools: ${fail.length} failure(s)`);
  for (const f of fail) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`doctor-contract-tools: ${all.length} declared tools, a one-tool module's loss reported, the superadmin's four not looked for`);
