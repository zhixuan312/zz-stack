// The plant: break the stage/document contract three ways; prove the valid variants pass.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const MF = "catalog/sdlc/sdlc-flow/flow.json";
const original = readFileSync(MF, "utf8");
const gate = () => { try { execFileSync("node", ["scripts/gate.mjs"], { stdio: "pipe" }); return 0; }
                     catch { return 1; } };
const fail = [];
const write = (o) => writeFileSync(MF, JSON.stringify(o, null, 2));
const restore = () => writeFileSync(MF, original);

if (gate() !== 0) { console.error("the gate is already red; the plant cannot measure anything"); process.exit(1); }

// 1. A stage with no produces.
let m = JSON.parse(original); delete m.stages[0].produces; write(m);
if (gate() === 0) fail.push("a stage without produces did not turn the gate red");
restore();

// 2. produces naming a document the manifest does not declare.
m = JSON.parse(original); m.stages[0].produces = "invented.md"; write(m);
if (gate() === 0) fail.push("produces naming an undeclared document did not turn the gate red");
restore();

// 3. A declared document produced by no stage.
m = JSON.parse(original); m.documents.push({ name: "orphan.md", role: "ground" }); write(m);
if (gate() === 0) fail.push("a document produced by no stage did not turn the gate red");
restore();

// 4. CONTROL — "record" and "nothing" are valid and must NOT fire. A check that demanded a
//    document from every stage would force a fake build.md into existence.
//    Swap between the two NON-document values only: changing a document-producing stage
//    would orphan its document and redden the gate for a different, correct reason.
m = JSON.parse(original);
const exec = m.stages.find((s) => s.name === "sdlc-execute");
if (!exec || exec.produces !== "nothing") fail.push("sdlc-execute should already declare nothing");
exec.produces = "record"; write(m);
if (gate() !== 0) fail.push('the check rejects produces: "record"; it is a valid variant');
restore();

// 5. CONTROL — a non-flow plugin has no stages and must not be asked for produces.
//    zz-core declares neither; the gate being green at the start already proves this,
//    but assert it explicitly so a later change that demands stages of every plugin is caught.
const core = JSON.parse(readFileSync("catalog/zz/zz-core/flow.json", "utf8"));
if ((core.stages || []).length) fail.push("zz-core declares stages; it is not a flow");

if (gate() !== 0) fail.push("the gate did not return green after restore");
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("stage-produces plant: ok");
