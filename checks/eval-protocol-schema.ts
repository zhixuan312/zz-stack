#!/usr/bin/env node
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const { EvaluationProtocol } = await import(pathToFileURL(join(process.cwd(), "packages/contracts/dist/eval-protocol.js")).href);
type Measure = { key: string; evaluatorType: string; weight: number; suite: string; required: boolean; definition: Record<string, never>; evaluator: null };
type Dim = { key: string; name: string; canonicalKind: string; weight: number; required: boolean; applicable: boolean; notApplicableReason: string | null; measures: Measure[] };
const m = (key: string, weight: number): Measure => ({ key, evaluatorType: "deterministic", weight, suite: "production", required: true, definition: {}, evaluator: null });
const d = (key: string, kind: string, weight: number): Dim => ({ key, name: key, canonicalKind: kind, weight, required: true, applicable: true, notApplicableReason: null, measures: [m(key + ".m", 1)] });
const base = {
  protocolKey: "p", version: 1, pluginPurpose: "x", observableSurfaces: ["traces"], failureTaxonomy: [] as string[],
  dimensions: [d("e", "effectiveness", 0.3), d("r", "reliability", 0.2), d("c", "constraint_adherence", 0.2),
               d("rr", "recovery_robustness", 0.1), d("ef", "efficiency", 0.1), d("g", "generalization", 0.1)],
  suites: { capability: {}, regression: {}, production: {} },
  qualification: { boundedSemanticMinimum: "operationally_qualified", thresholds: {}, labelMappings: [] as string[] },
  scoring: { establishment: { bootstrap: false, minCoverage: {} }, uncertainty: {} },
  improvement: { evolvable: true, criticalGuardrails: [] as string[],
    release: { minPostReleaseRuns: 5, regressionBand: 0.1 } },
};
type Proto = typeof base;
const at = <T>(xs: T[], i: number): T => { const x = xs[i]; assert.ok(x !== undefined); return x; };
assert.equal(EvaluationProtocol.safeParse(base).success, true, "a complete protocol parses");
const bad = (f: (p: Proto) => void): boolean => { const p = structuredClone(base); f(p); return EvaluationProtocol.safeParse(p).success; };
assert.equal(bad((p) => { delete (p as Partial<Proto>).improvement; }), false, "missing FR-6 field refused");
assert.equal(bad((p) => { delete (p.improvement as Partial<Proto["improvement"]>).release; }), false, "missing release policy refused");
assert.equal(bad((p) => { at(p.dimensions, 0).weight = 0.5; }), false, "dimension weights must sum to 1");
assert.equal(bad((p) => { at(p.dimensions, 0).measures.push(m("x", 0.5)); }), false, "measure weights must sum to 1");
assert.equal(bad((p) => { at(p.dimensions, 0).canonicalKind = "vibes"; }), false, "unknown canonical kind refused");
assert.equal(bad((p) => { at(p.dimensions, 5).applicable = false; }), false, "N/A without reason refused");
assert.equal(bad((p) => { at(p.dimensions, 5).applicable = false; at(p.dimensions, 5).notApplicableReason = "no OOD cases";
  at(p.dimensions, 0).weight = 0.4; }), true, "N/A with reason and re-normalized weights parses");
console.log("ok eval-protocol-schema");
