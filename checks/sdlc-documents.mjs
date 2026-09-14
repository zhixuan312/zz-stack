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
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("sdlc documents: ok");
