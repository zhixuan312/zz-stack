// sdlc's own shape: which document closes it, which one carries the gate, and that its audits
// produce a SOURCE rather than a document of the flow. What every flow's manifest owes is checked for every flow,
// in scripts/gate/checks/stage-produces.ts — not again here for one of them.
import { readFileSync } from "node:fs";

interface Doc {
  name: string; closing?: boolean; gate?: boolean; requiredForClose?: boolean;
  [key: string]: unknown;
}
interface Stage { name: string; produces?: string; supports?: string }
interface Flow { documents?: Doc[]; stages?: Stage[] }

const fail: string[] = [];
const m: Flow = JSON.parse(readFileSync("catalog/sdlc/sdlc-flow/flow.json", "utf8"));
const docs: Record<string, Doc> = Object.fromEntries((m.documents ?? []).map((d) => [d.name, d]));

for (const n of ["explore.md", "spec.md", "plan.md", "review.md"]) {
  if (!docs[n]) fail.push(`${n} is not declared`);
}
// AND NO MORE THAN THOSE FOUR. An audit report is evidence — the material that makes the next
// version of somebody else's document necessary — so it is a source, cited by that revision,
// not a document this flow delivers. Declaring one would put a round on the record twice.
for (const n of ["spec-audit.md", "plan-audit.md"]) {
  if (docs[n]) fail.push(`${n} is declared as a document; an audit round is a source`);
}
if (docs["spec.md"]?.closing) fail.push("spec.md is still the closing document");
const r = docs["review.md"] || {};
for (const f of ["gate", "closing", "requiredForClose"]) {
  if (!r[f]) fail.push(`review.md does not carry ${f}`);
}
// THE AUDIT STAGES SAY WHAT THEY LEAVE AND WHAT IT IS ABOUT. `produces: "source"` is the
// manifest's word for evidence, and `supports` names the document that evidence bears on —
// which is what lets the platform require the next version of that document to cite it, and
// what lets a diagram show the round happened without anything knowing the word "audit".
for (const [stage, target] of [["sdlc-spec-audit", "spec.md"], ["sdlc-plan-audit", "plan.md"]]) {
  const st = (m.stages || []).find((x) => x.name === stage);
  if (!st) { fail.push(`${stage} is not a stage of this flow`); continue; }
  if (st.produces !== "source") fail.push(`${stage} produces ${st.produces}; an audit round is a source`);
  if (st.supports !== target) fail.push(`${stage} supports ${st.supports ?? "nothing"}, not ${target}`);
}
// Execute declares "nothing" explicitly — sdlc's own decision, and the only part of this
// paragraph that is about sdlc. That every stage declares SOMETHING is the contract's rule
// (FlowStage.produces is required) and the catalog-wide check's, not this file's.
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

// THE TWO HALVES OF THE MANIFEST NAMING EACH OTHER IS NOT THIS FILE'S RULE ANY MORE.
//
// It was written here first, hardcoded to catalog/sdlc/sdlc-flow/flow.json, and Task I-31
// generalised it: scripts/gate/checks/stage-produces.ts walks every package the catalog
// classifies as a flow and asserts all three directions — a stage's `produces` resolves to a
// declared document, that document's `stage` names the stage back, and no declared document
// is produced by nothing. sdlc-flow is one of the flows it walks, so keeping a copy here
// bought nothing and cost the thing a second copy always costs: two rules for one fact, able
// to disagree, with no way to tell which one a reader should believe.
//
// What stays below is what is TRUE OF SDLC AND OF NO OTHER FLOW — which document closes it,
// which one carries the gate, and that its audits are recorded rather than approved. Those
// are sdlc's design decisions, not properties of a manifest.
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("sdlc documents: ok");
