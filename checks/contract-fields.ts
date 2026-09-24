// The manifest can express what the standard requires, and refuses the `standalone` key.
import { FlowStage, CatalogManifest } from "../packages/contracts/dist/index.js";
const fail = [];

// produces is required and three-valued.
if (FlowStage.safeParse({ name: "s" }).success) fail.push("a stage without produces validates");
for (const p of ["doc.md", "record", "nothing"]) {
  if (!FlowStage.safeParse({ name: "s", produces: p }).success) fail.push(`produces: ${p} rejected`);
}
// Controls: the union must refuse something, or the two literals beside the string arm decide
// nothing. `""` alone does not show that — the string arm's own length rule catches it. The
// discriminating value is a non-empty string that is neither a document name nor one of the
// two literals.
for (const p of ["", "garbage", "spec.txt", "Spec.md", "-spec.md"]) {
  if (FlowStage.safeParse({ name: "s", produces: p }).success) {
    fail.push(`produces: ${JSON.stringify(p)} validates, and it is neither a document name nor "record"/"nothing"`);
  }
}

// The manifest fields exist.
const ok = CatalogManifest.safeParse({
  name: "x", purpose: "why it exists",
  commands: { flow: "x-flow" }, libraries: ["x-lib"],
  stages: [{ name: "s", produces: "nothing" }],
});
if (!ok.success) fail.push(`a conformant manifest was rejected: ${JSON.stringify(ok.error?.issues)}`);

// `standalone` is refused rather than ignored.
const old = CatalogManifest.safeParse({ name: "x", standalone: ["y"] });
if (old.success) fail.push("standalone still validates; it must be replaced by commands");

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("contract fields: ok");
