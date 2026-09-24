// sdlc's own shape: which document closes it, which one carries the gate, and that its audits
// produce a source rather than a document of the flow.
//
// COUPLED: what every flow's manifest owes is scripts/gate/checks/stage-produces.ts's rule, for
// every flow, and is not repeated here.
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
// And no more than those four. An audit report is evidence, so it is a source cited by the next
// revision rather than a document this flow delivers; declaring one puts a round on the record
// twice.
for (const n of ["spec-audit.md", "plan-audit.md"]) {
  if (docs[n]) fail.push(`${n} is declared as a document; an audit round is a source`);
}
if (docs["spec.md"]?.closing) fail.push("spec.md is still the closing document");
const r = docs["review.md"] || {};
for (const f of ["gate", "closing", "requiredForClose"]) {
  if (!r[f]) fail.push(`review.md does not carry ${f}`);
}
// `produces: "source"` is the manifest's word for evidence, and `supports` names the document
// it bears on, which is what lets the platform require the next version of that document to
// cite it.
for (const [stage, target] of [["sdlc-spec-audit", "spec.md"], ["sdlc-plan-audit", "plan.md"]]) {
  const st = (m.stages || []).find((x) => x.name === stage);
  if (!st) { fail.push(`${stage} is not a stage of this flow`); continue; }
  if (st.produces !== "source") fail.push(`${stage} produces ${st.produces}; an audit round is a source`);
  if (st.supports !== target) fail.push(`${stage} supports ${st.supports ?? "nothing"}, not ${target}`);
}
// Execute declares "nothing" explicitly, which is sdlc's own decision. That every stage
// declares something at all is the contract's rule (FlowStage.produces is required) and the
// catalog-wide check's.
const exec = (m.stages || []).find((s) => s.name === "sdlc-execute");
if (exec && exec.produces !== "nothing") {
  fail.push(`sdlc-execute declares produces: ${exec.produces}; its output is the repository`);
}
// The closing document is the last one the sequence produces.
const order = (m.stages || []).map((s) => s.produces).filter((p) => p && p.endsWith(".md"));
const closing = (m.documents || []).find((d) => d.closing)?.name;
if (order.length && closing !== order[order.length - 1]) {
  fail.push(`the closing document is ${closing}, but the last produced is ${order[order.length - 1]}`);
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("sdlc documents: ok");
