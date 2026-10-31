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
// zz-core's own skills are this repository's, not the image's /skills: read before plugin-eval.js
// loads, which captures it (`SKILLS_DIR`).
process.env.ZZ_SKILLS_DIR ??= join(process.cwd(), "skills");
const { EvaluationProtocol } = await load("packages/contracts/dist/index.js");
const { gatherCountedEvidence } = await load("services/zz-core/dist/eval/qualify-evidence.js");
const { qualificationState, resolveThresholds } = await load("services/zz-core/dist/eval/qualify-ladder.js");
const { toolsNamedBy } = await load("services/zz-core/dist/eval/plugin-eval.js");
const { sourceFiles } = await load("packages/tools/dist/lib/sql-statements.js") as
  { sourceFiles: (dir: string, keep: (path: string) => boolean) => { path: string; src: string }[] };

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
// The surfaces cover every tool zz-core's own skills name and its door serves: one missing fires
// protocol_read's new_evidence_surface on the shipped protocol itself, before any evaluation
// (runtime pass 2, F8). A tool another door serves is not zz-core's surface, as protocol_read and
// OBSERVE narrow it (ownTools): zz-core's skills name /manage's team_switch, and listing it put a
// tool zz-core never serves into its protocol. What zz-core serves is what its source registers.
{
  const registered = new Set(sourceFiles("services/zz-core/src", (p) => p.endsWith(".ts"))
    .flatMap(({ src }) => [...src.matchAll(/registerTool\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1])));
  const named: string[] = toolsNamedBy("zz-core");
  assert.ok(named.includes("team_switch") && !registered.has("team_switch"),
    "the case this narrows, a tool zz-core's skills name and another door serves, is still there");
  const surfaces = new Set<string>(protocol.observableSurfaces);
  const missing = named.filter((t) => registered.has(t) && !surfaces.has(t));
  assert.deepEqual(missing, [], "zz-core.json's observableSurfaces lack tools zz-core's skills name and its door serves");
  const foreign = named.filter((t) => !registered.has(t) && surfaces.has(t));
  assert.deepEqual(foreign, [], "zz-core.json's observableSurfaces list a tool another door serves");
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
  // A dimension that does not apply may name no measure; one that applies must name one.
  const na = structuredClone(protocol);
  const dropped = na.dimensions.find((d: { key: string }) => d.key === "generalization");
  na.dimensions = na.dimensions.filter((d: { key: string }) => d.key !== "generalization");
  na.dimensions.push({ ...dropped, weight: 0, required: false, applicable: false,
    notApplicableReason: "No second flow exists to generalise to.", measures: [] });
  na.dimensions[0].weight += dropped.weight;
  assert.equal(EvaluationProtocol.safeParse(na).success, true, "a not-applicable dimension with no measure was refused");
  const empty = structuredClone(protocol);
  empty.dimensions[0].measures = [];
  assert.match(JSON.stringify(EvaluationProtocol.safeParse(empty).error.issues), /is applicable and names no measure/);
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
  assert.equal(results.length, m.definition.qualification!.anchors.length * 3, `${m.key}: every text asked three times`);
}

// 3b. One draw does not qualify: an evaluator whose answer on one anchor flips on the third ask
// fails that anchor and its stability (sdlc read_economy: yes under v1, unclear under v2).
{
  const anchors = semantic[0].definition.qualification!.anchors;
  const flaky = anchors.find((a) => a.role === "anchor")!;
  let seen = 0;
  const { counts } = await gatherCountedEvidence({
    anchors, ask: async (text: string) => (text === flaky.text && ++seen === 3 ? noul("unclear") : truthful(text)),
  });
  assert.equal(counts.anchors.passed, counts.anchors.total - 1, "an anchor answered unclear once in three still passed");
  assert.equal(counts.stability.passed, counts.stability.total - 1, "an entry whose answers disagreed counted as stable");
  assert.equal(qualificationState({ ...counts, labels: null }, thresholds).state, "unqualified");
}

// 3c. No answer is not a stable answer: an evaluator that returned nothing comparable three times
// over agrees with nobody (runtime pass 2, F4 — an outage read as 4/4 "agreeing").
{
  const { counts } = await gatherCountedEvidence({
    anchors: semantic[0].definition.qualification!.anchors, ask: async () => noul("unavailable"),
  });
  assert.equal(counts.stability.passed, 0, `entries with no answer counted as stable: ${JSON.stringify(counts.stability)}`);
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

// 8. The asks are independent model calls, made several at a time; the results keep the order
// the texts are declared in, each text's three asks together, whatever order the answers arrive.
{
  const anchors = semantic[0].definition.qualification!.anchors;
  let inFlight = 0;
  let most = 0;
  const calls: number[] = [];
  const { results } = await gatherCountedEvidence({
    anchors, ask: async (text: string, index: number) => {
      calls.push(index);
      inFlight += 1; most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 30 - (index % 3) * 10));
      inFlight -= 1;
      return truthful(text);
    },
  });
  assert.ok(most > 1, `the ${anchors.length * 3} asks ran one at a time`);
  assert.deepEqual(results.map((r: { id: string }) => r.id), anchors.flatMap((a) => [a.id, a.id, a.id]),
    "the results are not in declared order");
  assert.deepEqual([...calls].sort((a, b) => a - b), anchors.flatMap((_, i) => [3 * i, 3 * i + 1, 3 * i + 2]),
    "each ask is handed its own index");
}

console.log("ok eval-qualify-anchors");
