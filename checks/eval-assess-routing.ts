#!/usr/bin/env node
// evaluation_assess asks each measure only what it judges.
//
// The live zz-core evaluation asked every measure of every ref — a bug-report measure of spec.md —
// and still asked unqualified evaluators whose answers could not count (~48 wasted model calls),
// and read each deterministic fact once per ref. Pure: the planner decides every row, and a check
// can prove what is NOT asked without a model or a database.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const m = await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/evaluate-measures.js")).href);
const { planAssessment, subjectKindOf, refKindOf, runLevelRef, isRunLevelRef, answerMeasure, readingsOf, documentParts } = m;
const { renderInterval } = await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/findings-doc.js")).href);

const measure = (key: string, evaluator_type: string, extra: Record<string, unknown> = {}) =>
  ({ id: `${key}-id`, key, evaluator_type, weight: 1, required: true, definition: {}, evaluator_version_id: `${key}-ev`,
     question: null, ...extra });

// -- kinds -------------------------------------------------------------------------------------
assert.equal(refKindOf("0b7c7a9e-1111-4222-8333-444455556666"), "run");
assert.equal(refKindOf("2026-09-24-x/spec.md"), "document");
assert.equal(refKindOf("_knowledge/nodes/0029-a.md"), "knowledge");
assert.equal(refKindOf("bug:0b7c7a9e-1111-4222-8333-444455556666"), "bug");
assert.equal(refKindOf("event:16644"), "event", "a door call is a subject of its own");
assert.equal(subjectKindOf(measure("r", "bounded_semantic", { question: "Read this refused call. Was ..." })), "event");
assert.equal(subjectKindOf(measure("a", "bounded_semantic", { definition: { subjectKind: "run" }, question: "Read this document." })), "run",
  "a declared subjectKind wins over the question");
// Every model-backed measure of the live zz-core protocol routes to a kind — none falls back to "every ref".
const protocol = JSON.parse(readFileSync("catalog/zz/zz-plugin-eval/protocols/zz-core.json", "utf8"));
const kinds: Record<string, string | null> = {};
for (const d of protocol.dimensions) for (const pm of d.measures) {
  if (!pm.evaluator) continue;
  kinds[pm.key] = subjectKindOf(measure(pm.key, pm.evaluatorType, { definition: pm.definition, question: pm.evaluator.question }));
}
const expected: Record<string, string> = {
  bug_report_evidence_discipline: "bug", document_gate_readiness: "document",
  knowledge_capture_effectiveness: "knowledge", refusal_explains_itself: "run",
  refusal_recovery_path: "run", cross_flow_reuse: "knowledge",
};
for (const [k, kind] of Object.entries(expected)) if (k in kinds) assert.equal(kinds[k], kind, `${k} routes to ${kind}`);
assert.ok(Object.keys(kinds).length > 0, "the protocol names model-backed measures to route");
for (const [k, v] of Object.entries(kinds)) assert.notEqual(v, null, `${k} routes to no kind`);

// -- the plan ----------------------------------------------------------------------------------
const run = runLevelRef("snap");
const refs = ["2026-09-24-x/spec.md", "_knowledge/nodes/0029-a.md", "0b7c7a9e-1111-4222-8333-444455556666"];
const measures = [
  measure("tool_refusal_rate", "deterministic", { definition: { factPath: "tool_refusal_rate" }, evaluator_version_id: null }),
  measure("bug_evidence", "bounded_semantic", { question: "Read this bug report. Does it ..." }),
  measure("frontmatter", "bounded_semantic", { question: "Read this document. Does it ..." }),
  measure("refusal_explains", "bounded_semantic", { question: "Read this run. Where it refused ..." }),
  measure("unqualified_doc", "bounded_semantic", { question: "Read this document. Does it ..." }),
];
const noText = () => undefined;
const plan = planAssessment({ measures, subjectRefs: refs, runLevel: run, alreadyAssessed: new Set(),
  qualified: (x: { key: string }) => x.key !== "unqualified_doc", textOf: noText });
const asks = plan.filter((p: { ask: boolean }) => p.ask);
const pairs = asks.map((p: { measure: { key: string }; subjectRef: string }) => `${p.measure.key} @ ${p.subjectRef}`);
assert.deepEqual(pairs.sort(), [
  `frontmatter @ ${refs[0]}`,
  `refusal_explains @ ${refs[2]}`,
  `tool_refusal_rate @ ${run}`,
].sort(), "each model-backed measure is asked only of its own kind; the fact is read once, at run level");
const byKey = (k: string) => plan.filter((p: { measure: { key: string } }) => p.measure.key === k);
assert.equal(byKey("bug_evidence").length, 1);
assert.equal(byKey("bug_evidence")[0].ask, false, "no bug ref: never asked");
assert.match(byKey("bug_evidence")[0].excluded_reason, /no subject_ref of kind "bug"/);
assert.equal(byKey("unqualified_doc").length, 1, "an unqualified evaluator writes one run-level row, not one per ref");
assert.equal(byKey("unqualified_doc")[0].ask, false, "an unqualified evaluator is never asked");
assert.match(byKey("unqualified_doc")[0].excluded_reason, /not qualified/);
assert.ok(isRunLevelRef(byKey("unqualified_doc")[0].subjectRef));
assert.ok(!refs.some((r) => isRunLevelRef(r)), "no subject ref reads as run-level");

// Once per run holds across calls: a second call on the same run adds no run-level row.
const again = planAssessment({ measures, subjectRefs: [refs[0]], runLevel: run,
  alreadyAssessed: new Set(plan.map((p: { measure: { id: string } }) => p.measure.id)),
  qualified: (x: { key: string }) => x.key !== "unqualified_doc", textOf: noText });
assert.deepEqual(again.map((p: { measure: { key: string } }) => p.measure.key), ["frontmatter"],
  "the deterministic fact and every run-level exclusion are written once per run, not once per call, " +
  "and a measure already asked of a run is not re-marked excluded by a call with no run ref");

// -- appliesWhen "refused": asked only of runs whose trace refused a call ------------------------
const refusedRun = "0b7c7a9e-1111-4222-8333-444455556666";
const cleanRun = "1c8d8b0f-2222-4333-8444-555566667777";
const texts: Record<string, string> = {
  [refusedRun]: `RUN ${refusedRun}:\n10:00:01  core:document_approve  x/spec.md  REFUSED  ERROR: present it first\n10:00:04  core:document_present  x/spec.md  ok`,
  [cleanRun]: `RUN ${cleanRun}:\n10:00:01  core:document_read  x/spec.md  ok`,
};
const recovery = measure("recovery", "bounded_semantic", { definition: { subjectKind: "run", appliesWhen: "refused" } });
const economy = measure("economy", "bounded_semantic", { definition: { subjectKind: "run" } });
const conditional = planAssessment({ measures: [recovery, economy], subjectRefs: [refusedRun, cleanRun], runLevel: run,
  alreadyAssessed: new Set(), qualified: () => true, textOf: (r: string) => texts[r] });
assert.deepEqual(conditional.filter((p: { ask: boolean }) => p.ask)
  .map((p: { measure: { key: string }; subjectRef: string }) => `${p.measure.key} @ ${p.subjectRef}`).sort(),
  [`economy @ ${cleanRun}`, `economy @ ${refusedRun}`, `recovery @ ${refusedRun}`].sort(),
  "a refusal measure is asked only of the run that refused; an unconditional one of both");
const none = planAssessment({ measures: [recovery], subjectRefs: [cleanRun], runLevel: run,
  alreadyAssessed: new Set(), qualified: () => true, textOf: (r: string) => texts[r] });
assert.equal(none.length, 1);
assert.equal(none[0].ask, false);
assert.match(none[0].excluded_reason, /applies only where one did/);

// -- definition.documents: a document measure judges only the files it names ---------------------
const agreement = measure("agreement", "bounded_semantic", { definition: { subjectKind: "document", documents: ["spec.md", "plan.md"] } });
const docsPlan = planAssessment({ measures: [agreement], subjectRefs: ["x/explore.md", "x/spec.md", "x/handover.md", "x/plan.md"],
  runLevel: run, alreadyAssessed: new Set(), qualified: () => true, textOf: noText });
assert.deepEqual(docsPlan.filter((p: { ask: boolean }) => p.ask).map((p: { subjectRef: string }) => p.subjectRef).sort(),
  ["x/plan.md", "x/spec.md"], "a measure naming spec.md and plan.md is asked of those alone");
const docsNone = planAssessment({ measures: [agreement], subjectRefs: ["x/explore.md"],
  runLevel: run, alreadyAssessed: new Set(), qualified: () => true, textOf: noText });
assert.match(docsNone[0].excluded_reason, /is one of the documents it judges \(spec\.md, plan\.md\)/);

// -- a long document is read whole, part by part ------------------------------------------------
{
  const doc = ["# Spec", ...Array.from({ length: 12 }, (_, i) => `## Section ${i}\n${"x".repeat(9000)}`)].join("\n");
  const parts = documentParts(doc, 22000);
  assert.ok(parts.length >= 5, `a 108KB document in ${parts.length} part(s)`);
  assert.ok(parts.every((p: string) => p.length <= 22000 + 60), "every part fits the judge's window");
  assert.equal(parts.map((p: string) => p.replace(/^\[Part \d+ of \d+ of one document\]\n/, "")).join(""), doc,
    "the parts together are the whole document, nothing dropped");
  assert.deepEqual(documentParts("short", 22000), ["short"], "a short document is one unlabelled part");
  // A heading with no text of its own is never the last thing in a part: zz-core's spec read 0.14
  // on parts ending "### Proposed design" and "## Risks & Mitigations".
  const nested = `## Risks\n\n### Named\n\n${"r".repeat(15000)}\n`;
  const cut = documentParts(`# Spec\n\n${"a".repeat(15000)}\n\n${nested}`, 22000);
  for (const part of cut) assert.doesNotMatch(part.trimEnd(), /\n#{1,6} [^\n]*$/, "no part ends on a heading");
  assert.ok(cut.some((part: string) => part.includes("## Risks\n\n### Named\n\nrrr")), "a heading chain travels with its content");
}

// -- no model call for an unqualified evaluator, even through answerMeasure --------------------
let asked = false;
const unq = await answerMeasure({ measure: measures[4], snapshot: { usable_run_count: 0, total_run_count: 0, coverage: null, facts: null },
  subjectRef: refs[0], principal: "check", subjectText: "body",
  qualificationOf: async () => { asked = true; return { id: "q", state: "unqualified" }; } });
assert.ok(asked, "qualification is consulted");
assert.equal(unq.pending, null, "no model answer exists: the evaluator was not asked");
assert.equal(unq.excluded, true);
assert.match(unq.excluded_reason, /not asked/);

// -- readings: every stored answer, citable --------------------------------------------------------
const readings = readingsOf([
  { measure_id: "frontmatter-id", subject_ref: refs[0], answer: { value: 0.91234, excluded: false, excluded_reason: null, assessment_id: 42, detail: { reading: "yes" } } },
  { measure_id: "bug_evidence-id", subject_ref: run, answer: { value: null, excluded: true, excluded_reason: "no bug ref", assessment_id: null, detail: {} } },
], new Map([["frontmatter-id", "frontmatter"], ["bug_evidence-id", "bug_evidence"]]));
assert.deepEqual(readings, {
  frontmatter: [{ ref: refs[0], value: 0.9123, reading: "yes", assessment_id: 42 }],
  bug_evidence: [{ ref: run, excluded: "no bug ref" }],
});
// A later call that assessed the kind supersedes the run-level "no ref of its kind" row.
const later = readingsOf([
  { measure_id: "bug_evidence-id", subject_ref: run, answer: { value: null, excluded: true, excluded_reason: "no bug ref", assessment_id: null, detail: {} } },
  { measure_id: "bug_evidence-id", subject_ref: "bug:1", answer: { value: 0.9, excluded: false, excluded_reason: null, assessment_id: 7, detail: { reading: "yes" } } },
], new Map([["bug_evidence-id", "bug_evidence"]]));
assert.deepEqual(later, { bug_evidence: [{ ref: "bug:1", value: 0.9, reading: "yes", assessment_id: 7 }] });

// -- findings.md renders the interval as a sentence, never raw JSON -------------------------------
const line = renderInterval({ lower: 6.1, upper: 7.85, level: 0.95, iterations: 1000, n_subjects: 6, degenerate: false, note: null });
assert.equal(line, "6.10–7.85 (95% bootstrap over 6 subjects, 1000 resamples)");
assert.ok(!renderInterval({ lower: 5, upper: 5, level: 0.95, iterations: 1000, n_subjects: 1, degenerate: true, note: "one" }).includes("{"));
assert.match(renderInterval({ lower: null, upper: null, level: 0.95, iterations: 1000, n_subjects: 0, degenerate: true, note: "no subject was scored" }), /^none/);
console.log("ok eval-assess-routing");
