// The flow closes on the last thing it produces, and every stage says what it leaves behind.
import { readFileSync } from "node:fs";
const fail = [];
const m = JSON.parse(readFileSync("catalog/sdlc/sdlc-flow/flow.json", "utf8"));
const docs = Object.fromEntries((m.documents || []).map((d) => [d.name, d]));

for (const n of ["explore.md", "spec.md", "spec-audit.md", "plan.md", "plan-audit.md", "review.md"]) {
  if (!docs[n]) fail.push(`${n} is not declared`);
}
if (docs["spec.md"]?.closing) fail.push("spec.md is still the closing document");
const r = docs["review.md"] || {};
for (const f of ["gate", "closing", "requiredForClose"]) {
  if (!r[f]) fail.push(`review.md does not carry ${f}`);
}
// Control: the audits must stay UNGATED. A sweep that gated everything fails here.
for (const a of ["spec-audit.md", "plan-audit.md"]) {
  if (docs[a]?.gate) fail.push(`${a} is gated; an audit is recorded, not approved`);
}
// Every stage declares produces, and execute declares nothing explicitly.
for (const s of m.stages || []) {
  if (!s.produces) fail.push(`stage ${s.name} declares no produces`);
}
const exec = (m.stages || []).find((s) => s.name === "sdlc-execute");
if (exec && exec.produces !== "nothing") {
  fail.push(`sdlc-execute declares produces: ${exec.produces}; its output is the repository`);
}
// The closing document is the LAST one the sequence produces.
const order = (m.stages || []).map((s) => s.produces).filter((p) => p && p.endsWith(".md"));
const closing = (m.documents || []).find((d) => d.closing)?.name;
if (order.length && closing !== order[order.length - 1]) {
  fail.push(`the closing document is ${closing}, but the last produced is ${order[order.length - 1]}`);
}

// THE TWO HALVES OF THE MANIFEST NAME EACH OTHER, and neither direction was checked.
//
// `documents[].stage` and `stages[].produces` are two statements of one fact written in two
// places, and every reader takes a different one: the console's stepper derives what a stage
// writes from `documents[].stage` (services/gateway/src/console/shared.ts:328), while
// `skill_view` prints it from `stages[].produces` (services/zz-core/src/tools/skills.ts:179).
// Let them disagree and the console and the door describe different flows, with no error
// anywhere — which is the exact failure this task exists to end, one layer down.
//
// Everything above tests the SHAPE the sequence has today. These two test the RELATION, and
// they are two breaks, not one. A stage naming a document the flow does not declare slips
// past the closing test whenever it is not the last stage; a declared document produced by no
// stage slips past it always, and past `catalog-stages.mjs`'s "a document's declared stage is
// a stage its flow has" too, because that check skips a document with no `stage` at all.
// @zz/contracts says as much at the field itself: a document name in `produces` is "a CLAIM
// the rest of the manifest can be held to". Nothing held it.
const stageNamed = new Map((m.stages || []).map((s) => [s.name, s.produces]));
for (const d of m.documents || []) {
  if (!d.stage) { fail.push(`document ${d.name} names no stage, so nothing says who writes it`); continue; }
  if (!stageNamed.has(d.stage)) { fail.push(`document ${d.name} names stage ${d.stage}, which the flow does not declare`); continue; }
  if (stageNamed.get(d.stage) !== d.name) {
    fail.push(`document ${d.name} says stage ${d.stage} writes it, and that stage produces ` +
              `${stageNamed.get(d.stage)}`);
  }
}
for (const s of m.stages || []) {
  if (!s.produces || !s.produces.endsWith(".md")) continue;
  if (!docs[s.produces]) fail.push(`stage ${s.name} produces ${s.produces}, which the flow does not declare`);
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("sdlc documents: ok");
