#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const { EvaluationProtocol } = await import(pathToFileURL(join(process.cwd(), "packages/contracts/dist/eval-protocol.js")).href);
const p = JSON.parse(readFileSync("catalog/zz/zz-plugin-eval/protocols/zz-core.v1.json", "utf8"));
assert.equal(EvaluationProtocol.safeParse(p).success, true);
const w = Object.fromEntries(p.dimensions.map((d: { canonicalKind: string; weight: number }) => [d.canonicalKind, d.weight]));
assert.deepEqual(w, { effectiveness: 0.3, reliability: 0.2, constraint_adherence: 0.2, recovery_robustness: 0.1, efficiency: 0.1, generalization: 0.1 });
const s = p.improvement.search;
assert.equal(s.minRepeats, 3); assert.equal(s.minMeaningfulEffect, 0.3); assert.equal(s.confidence, 0.95);
assert.equal(s.equivalenceBand, 0.1); assert.equal(s.maxGenerations, 5); assert.equal(s.maxCandidatesPerGeneration, 8);
assert.equal(s.wallClockHours, 24); assert.equal(s.complexity, "lines_plus_20_per_component");
assert.deepEqual(p.improvement.selection.order, ["lower_bound", "complexity", "latency", "cost", "id"]);
assert.deepEqual(p.replay.splitPolicy, { evolve: 0.4, validation: 0.3, proof: 0.3, min: { evolve: 5, validation: 10, proof: 10 } });
assert.equal(p.scoring.establishment.bootstrap, true);
assert.equal(p.qualification.boundedSemanticMinimum, "operationally_qualified");
console.log("ok eval-zz-core-protocol");
