#!/usr/bin/env node
// Task I-29's own fix dispatch (initiative 2026-09-24-plugin-eval-next-version): a deterministic/
// outcome measure now reads ANY fact the observation snapshot carries, by a dotted
// definition.factPath, normalised by a declared rule (rate/inverted_rate/threshold) — and
// improvement.criticalGuardrails is the ONE guardrail mechanism, evaluated against each measure's
// already-reduced value. This check is pure: no database, no model call.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const { answerMeasure, evaluateGuardrails, parseCriticalGuardrails } =
  await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/evaluate-measures.js")).href);
const { factPathRefusal, criticalGuardrailRefusal } =
  await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/protocol-record.js")).href);

const noQualification = async () => null;

const measure = (key: string, definition: Record<string, unknown>) =>
  ({ id: `${key}-id`, key, evaluator_type: "deterministic", weight: 1, required: true, definition, evaluator_version_id: null });

const snapshot = (facts: Record<string, unknown> | null) =>
  ({ usable_run_count: 0, total_run_count: 0, coverage: null, facts });

// -- rate (default normalize) ----------------------------------------------------------------
const rateFacts = snapshot({ tool_coverage: { value: 0.75, numerator: 3, denominator: 4 } });
const rateAnswer = await answerMeasure({
  measure: measure("tool_coverage", { factPath: "tool_coverage" }), snapshot: rateFacts,
  subjectRef: "s", principal: "p", qualificationOf: noQualification,
});
assert.equal(rateAnswer.value, 0.75, "rate reads the fact's own value directly");
assert.equal(rateAnswer.excluded, false);

// -- inverted_rate: a refusal rate example, exactly what the task text names ------------------
const refusalFacts = snapshot({ tool_refusal_rate: { value: 0.2, numerator: 2, denominator: 10 } });
const invertedAnswer = await answerMeasure({
  measure: measure("tool_refusal_rate", { factPath: "tool_refusal_rate", normalize: "inverted_rate" }),
  snapshot: refusalFacts, subjectRef: "s", principal: "p", qualificationOf: noQualification,
});
assert.equal(invertedAnswer.value, 0.8, "inverted_rate reads 1 - value: a low refusal rate scores high");

// -- threshold: a measured quantity outside [0,1], compared against max/min -------------------
const latencyFacts = snapshot({ latency_p50_ms: { value: 1200 } });
const underBudget = await answerMeasure({
  measure: measure("latency_within_budget", { factPath: "latency_p50_ms", normalize: "threshold", max: 5000 }),
  snapshot: latencyFacts, subjectRef: "s", principal: "p", qualificationOf: noQualification,
});
assert.equal(underBudget.value, 1, "under the max threshold scores 1");
const overBudgetFacts = snapshot({ latency_p50_ms: { value: 9000 } });
const overBudget = await answerMeasure({
  measure: measure("latency_within_budget", { factPath: "latency_p50_ms", normalize: "threshold", max: 5000 }),
  snapshot: overBudgetFacts, subjectRef: "s", principal: "p", qualificationOf: noQualification,
});
assert.equal(overBudget.value, 0, "over the max threshold scores 0");

// -- rate on a non-[0,1] value refuses rather than guessing ------------------------------------
const badRate = await answerMeasure({
  measure: measure("latency_p50_ms", { factPath: "latency_p50_ms" }), snapshot: latencyFacts,
  subjectRef: "s", principal: "p", qualificationOf: noQualification,
});
assert.equal(badRate.value, null);
assert.equal(badRate.excluded, true);
assert.match(badRate.excluded_reason ?? "", /not a rate in \[0,1\]/);

// -- missing fact (zero-denominator window) excludes with a reason, never 0 -------------------
const emptyFacts = snapshot({ tool_refusal_rate: { value: null, reason: "no tool call is recorded for this subject in this window" } });
const missing = await answerMeasure({
  measure: measure("tool_refusal_rate", { factPath: "tool_refusal_rate" }), snapshot: emptyFacts,
  subjectRef: "s", principal: "p", qualificationOf: noQualification,
});
assert.equal(missing.value, null, "a missing fact is null, never a bare 0");
assert.equal(missing.excluded, true);
assert.match(missing.excluded_reason ?? "", /no tool call is recorded/);

// -- an unresolved path excludes with a reason -------------------------------------------------
const unresolved = await answerMeasure({
  measure: measure("nonexistent", { factPath: "nonexistent_fact" }), snapshot: rateFacts,
  subjectRef: "s", principal: "p", qualificationOf: noQualification,
});
assert.equal(unresolved.excluded, true);
assert.match(unresolved.excluded_reason ?? "", /names no fact this observation snapshot carries/);

// -- a snapshot with no facts at all (pre-086, or a replay/verify context) excludes ------------
const noFacts = await answerMeasure({
  measure: measure("tool_coverage", { factPath: "tool_coverage" }), snapshot: snapshot(null),
  subjectRef: "s", principal: "p", qualificationOf: noQualification,
});
assert.equal(noFacts.excluded, true);
assert.match(noFacts.excluded_reason ?? "", /carries no facts/);

console.log("ok eval-fact-path: rate / inverted_rate / threshold / missing-fact / unresolved-path");

// -- protocol_record refuses a factPath naming no fact OBSERVE computes -----------------------
assert.equal(factPathRefusal({ key: "m", evaluatorType: "deterministic", definition: { factPath: "made_up_fact" } }) !== null, true,
  "an unknown fact is refused");
assert.match(
  factPathRefusal({ key: "m", evaluatorType: "deterministic", definition: { factPath: "made_up_fact" } }) ?? "",
  /names no fact OBSERVE computes/);
assert.equal(factPathRefusal({ key: "m", evaluatorType: "deterministic", definition: { factPath: "tool_refusal_rate" } }), null,
  "a real fact is accepted");
assert.equal(factPathRefusal({ key: "m", evaluatorType: "deterministic", definition: {} }) !== null, true,
  "no factPath at all is refused");
assert.equal(factPathRefusal({ key: "m", evaluatorType: "bounded_semantic", definition: {} }), null,
  "a model-backed measure needs no factPath");
assert.equal(
  factPathRefusal({ key: "m", evaluatorType: "deterministic", definition: { factPath: "latency_p50_ms", normalize: "threshold" } }) !== null,
  true, "normalize:threshold with no max/min is refused");

// -- criticalGuardrails resolves to exactly one measure, or is refused ------------------------
const body = (guardrailKey: string, measureKeys: string[]) => ({
  dimensions: [{ measures: measureKeys.map((k) => ({ key: k })) }],
  improvement: { criticalGuardrails: [{ key: guardrailKey }] },
});
assert.equal(criticalGuardrailRefusal(body("usable_run_coverage", ["usable_run_coverage", "other"])), null, "resolves to one measure");
assert.match(criticalGuardrailRefusal(body("missing_key", ["usable_run_coverage"])) ?? "", /which no dimension's measure declares/);
assert.match(criticalGuardrailRefusal(body("dup", ["dup", "dup"])) ?? "", /which 2 measures/);

console.log("ok eval-fact-path: protocol_record refuses an unknown factPath and an unresolved criticalGuardrails key");

// -- evaluateGuardrails: pass / fail / not_established, never a bare "not pass" == "fail" -----
const critical = parseCriticalGuardrails([{ key: "usable_run_coverage", threshold: 0.5 }, { key: "document_gate_readiness", threshold: 0.5 }]);
const values = new Map<string, number | null>([["usable_run_coverage", 0.9], ["document_gate_readiness", 0.3]]);
const results = evaluateGuardrails(critical, values);
assert.equal(results.find((r: { key: string }) => r.key === "usable_run_coverage").status, "pass");
assert.equal(results.find((r: { key: string }) => r.key === "document_gate_readiness").status, "fail");
const notEstablished = evaluateGuardrails(critical, new Map());
assert.ok(notEstablished.every((r: { status: string }) => r.status === "not_established"), "an unmeasured guardrail is not_established, never fail");

console.log("ok eval-fact-path: evaluateGuardrails distinguishes pass / fail / not_established");
