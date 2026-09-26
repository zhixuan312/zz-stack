#!/usr/bin/env node
// A model-backed measure is qualified against its OWN declared known-answer texts, asked its own
// question. Found by the live evaluation of zz-core on 0.76.2: anchors were fixed sentences about
// snapshot counts ("Of N runs … M were usable") asked against questions about documents and runs,
// so a truthful evaluator answered no to every one and all eight measures stayed unqualified.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const { EvaluationProtocol } = await load("packages/contracts/dist/eval-protocol.js");
const { gatherCountedEvidence } = await load("services/zz-core/dist/eval/qualify-evidence.js");
const { qualificationState, resolveThresholds } = await load("services/zz-core/dist/eval/qualify-ladder.js");

type Anchor = { id: string; role: "anchor" | "fault" | "control"; text: string; expected: string };
type Measure = { key: string; evaluatorType: string; definition: { qualification?: { anchors: Anchor[] } } };

const protocol = JSON.parse(readFileSync("catalog/zz/zz-plugin-eval/protocols/zz-core.json", "utf8"));
const measures: Measure[] = protocol.dimensions.flatMap((d: { measures: Measure[] }) => d.measures);
const semantic = measures.filter((m) => m.evaluatorType === "bounded_semantic" || m.evaluatorType === "generative_critic");
const { thresholds } = resolveThresholds(protocol.qualification.thresholds);

// 1. The reference protocol validates, and every model-backed measure carries anchors of both
// answers, a fault and a control.
assert.equal(EvaluationProtocol.safeParse(protocol).success, true, "zz-core.json no longer validates");
assert.ok(semantic.length > 0, "zz-core.json has no model-backed measure to qualify");
for (const m of semantic) {
  const anchors = m.definition.qualification?.anchors ?? [];
  const roles = new Set(anchors.map((a) => a.role));
  assert.ok(roles.has("anchor") && roles.has("fault") && roles.has("control"), `${m.key} lacks an anchor, fault or control`);
  assert.deepEqual(new Set(anchors.filter((a) => a.role === "anchor").map((a) => a.expected)), new Set(["yes", "no"]),
    `${m.key}'s anchors do not cover both answers`);
}
assert.ok(!measures.some((m) => m.key === "document_frontmatter_conformance"),
  "document_frontmatter_conformance asks a text judge about row state; it was dropped, not kept");

// 2. The contract refuses a model-backed measure with no anchors, naming what is missing.
{
  const bare = structuredClone(protocol);
  delete bare.dimensions[0].measures[0].definition.qualification;
  const r = EvaluationProtocol.safeParse(bare);
  assert.equal(r.success, false, "a model-backed measure with no anchors was accepted");
  assert.match(JSON.stringify(r.error.issues), /needs definition\.qualification\.anchors/);
  const oneSided = structuredClone(protocol);
  for (const a of oneSided.dimensions[0].measures[0].definition.qualification.anchors) a.expected = "yes";
  assert.match(JSON.stringify(EvaluationProtocol.safeParse(oneSided).error.issues), /at least two different expected answers/);
}

// A truthful evaluator: it answers each text with what that text actually is. Built from the
// protocol as written, so a protocol that later mislabels one of its texts is caught.
const truth = new Map<string, string>(semantic.flatMap((m) => m.definition.qualification!.anchors.map((a) => [a.text, a.expected])));
const noul = (reading: string | undefined) => ({ answer_kind: "noul", reading: reading ?? "unclear", distribution: null });
const truthful = async (text: string) => noul(truth.get(text));

// 3. Every measure's own anchors against the truthful evaluator: operationally qualified.
for (const m of semantic) {
  const { counts, results } = await gatherCountedEvidence({ anchors: m.definition.qualification!.anchors, ask: truthful });
  const r = qualificationState({ ...counts, labels: null }, thresholds);
  assert.deepEqual(r, { state: "operationally_qualified", reason: null }, `${m.key}: ${JSON.stringify({ r, counts })}`);
  assert.equal(results.length, m.definition.qualification!.anchors.length + 2, `${m.key}: one result per text plus two stability repeats`);
}

// 4. Mismatched anchors — a text labelled with the wrong answer — fail by name: the threshold,
// and the anchor id with what it expected and what it got.
{
  const anchors: Anchor[] = structuredClone(semantic[0].definition.qualification!.anchors);
  const wrong = anchors.find((a) => a.role === "anchor" && a.expected === "no")!;
  wrong.expected = "yes";
  const { counts, results } = await gatherCountedEvidence({ anchors, ask: truthful });
  const r = qualificationState({ ...counts, labels: null }, thresholds);
  assert.equal(r.state, "unqualified");
  assert.equal(r.reason, "anchorPassRate 0.50 < 0.80 (1/2)");
  assert.deepEqual(results.find((x: { id: string; role: string }) => x.id === wrong.id && x.role === "anchor"),
    { id: wrong.id, role: "anchor", expected: "yes", got: "no" });
}

// 5. An evaluator that always says yes cannot pass anchors of both answers.
{
  const { counts } = await gatherCountedEvidence({ anchors: semantic[0].definition.qualification!.anchors, ask: async () => noul("yes") });
  assert.equal(qualificationState({ ...counts, labels: null }, thresholds).state, "unqualified");
}

// 6. A fault the evaluator misses stops the climb at mechanically_qualified, naming faultKillRate.
{
  const anchors = semantic[0].definition.qualification!.anchors;
  const fault = anchors.find((a) => a.role === "fault")!;
  const { counts } = await gatherCountedEvidence({
    anchors, ask: async (text: string) => (text === fault.text ? noul(fault.expected === "yes" ? "no" : "yes") : truthful(text)),
  });
  assert.deepEqual(qualificationState({ ...counts, labels: null }, thresholds),
    { state: "mechanically_qualified", reason: "faultKillRate 0.00 < 0.80 (0/1)" });
}

// 7. No declared anchors: nothing is asked, and the ladder answers no_anchors.
{
  let asked = 0;
  const { counts } = await gatherCountedEvidence({ anchors: [], ask: async () => { asked += 1; return noul("yes"); } });
  assert.equal(asked, 0);
  assert.deepEqual(qualificationState({ ...counts, labels: null }, thresholds), { state: "unqualified", reason: "no_anchors" });
}

console.log("ok eval-qualify-anchors");
