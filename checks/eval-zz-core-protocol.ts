#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const { EvaluationProtocol } = await import(pathToFileURL(join(process.cwd(), "packages/contracts/dist/eval-protocol.js")).href);
const p = JSON.parse(readFileSync("catalog/zz/zz-plugin-eval/protocols/zz-core.json", "utf8"));
assert.equal(EvaluationProtocol.safeParse(p).success, true);
const w = Object.fromEntries(p.dimensions.map((d: { canonicalKind: string; weight: number }) => [d.canonicalKind, d.weight]));
assert.deepEqual(w, { effectiveness: 0.3, reliability: 0.2, constraint_adherence: 0.2, recovery_robustness: 0.1, efficiency: 0.1, generalization: 0.1 });
assert.deepEqual(p.improvement.release, { minPostReleaseRuns: 5, regressionBand: 0.5 },
  "the reference protocol judges a release on five real runs and half a point (of ten) of regression band");
assert.ok(!("replay" in p) && !("search" in p.improvement) && !("selection" in p.improvement) && !("proof" in p.improvement),
  "the reference protocol still carries a replay, search, selection or proof policy");
assert.equal(p.scoring.establishment.bootstrap, false,
  "the reference protocol has been through a real evaluation and may establish a score");
const measures = p.dimensions.flatMap((d: { measures: { key: string; definition: Record<string, unknown> }[] }) => d.measures);
for (const key of ["refusal_explains_itself", "refusal_recovery_path"]) {
  assert.equal(measures.find((m: { key: string }) => m.key === key)?.definition.appliesWhen, "refused",
    `${key} is asked only of runs that refused a call`);
}
assert.equal(p.qualification.boundedSemanticMinimum, "operationally_qualified");
console.log("ok eval-zz-core-protocol");
