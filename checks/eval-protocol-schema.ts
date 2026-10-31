#!/usr/bin/env node
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const { EvaluationProtocol, EVAL_STATE_ENUMS } = await import(pathToFileURL(join(process.cwd(), "packages/contracts/dist/index.js")).href);
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

// A protocol author writes only what something reads: a body without a suite per measure, a
// `suites` block or `improvement.evolvable` is complete, because nothing stores or reads them.
const unread = structuredClone(base) as Record<string, unknown> & Proto;
delete (unread as Partial<Proto>).suites;
delete (unread.improvement as Partial<Proto["improvement"]>).evolvable;
for (const dim of unread.dimensions) for (const measure of dim.measures) delete (measure as Partial<Measure>).suite;
assert.equal(EvaluationProtocol.safeParse(unread).success, true,
  "a protocol with no suite, suites or evolvable parses — nothing stores or reads them");

// Every state vocabulary @zz/contracts publishes is one a column constrains, value for value: a
// writer that takes its values from the list writes nothing the database refuses, and a list
// for a column that does not exist is not a state anybody holds.
const sql = readdirSync("services/gateway/migrations").filter((f) => f.endsWith(".sql")).sort()
  .map((f) => readFileSync(join("services/gateway/migrations", f), "utf8")).join("\n");
const constrained = (constraint: string): string[] => {
  const all = [...sql.matchAll(new RegExp(`CONSTRAINT ${constraint} CHECK \\(\\(\\w+ = ANY \\(ARRAY\\[([^\\]]*)\\]`, "g"))];
  const last = all.at(-1);
  assert.ok(last, `no CHECK named ${constraint} in the migrations`);
  return [...last[1].matchAll(/'([^']*)'::text/g)].map((v) => v[1]);
};
const COLUMN_CHECKS: Record<string, readonly string[]> = {
  qualificationState: ["eval_evaluator_qualification_state_check"],
  scoreStatus: ["eval_run_score_status_check"],
  guardrailStatus: ["eval_run_guardrail_status_check"],
  candidateStatus: ["candidate_status_check"],
  releaseAttemptStatus: ["release_attempt_status_check"],
  ownerKind: ["eval_finding_owner_kind_check", "eval_failure_mode_sighting_owner_kind_check"],
  answerKind: ["assessment_answer_kind_check"],
  findingKind: ["eval_finding_kind_check"],
};
for (const [key, values] of Object.entries(EVAL_STATE_ENUMS as Record<string, readonly string[]>)) {
  const checks = COLUMN_CHECKS[key];
  assert.ok(checks, `EVAL_STATE_ENUMS.${key} names no constrained column`);
  for (const constraint of checks) {
    assert.deepEqual([...values], constrained(constraint), `EVAL_STATE_ENUMS.${key} is not the set ${constraint} allows`);
  }
}

console.log("ok eval-protocol-schema");
