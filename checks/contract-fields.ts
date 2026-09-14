// The manifest can express what the standard requires, and cannot express what it replaced.
import { FlowStage, CatalogManifest } from "../packages/contracts/dist/index.js";
const fail = [];

// produces is required and three-valued.
if (FlowStage.safeParse({ name: "s" }).success) fail.push("a stage without produces validates");
for (const p of ["doc.md", "record", "nothing"]) {
  if (!FlowStage.safeParse({ name: "s", produces: p }).success) fail.push(`produces: ${p} rejected`);
}
// Controls: the union must REFUSE something, or the two literals beside the string arm decide
// nothing at all. `""` alone could not show this — it is caught by the string arm's own length
// rule, so it passed while `produces: "garbage"` validated and this line read as proof it did
// not. The discriminating value is a non-empty string that is neither a document name nor one
// of the two literals.
for (const p of ["", "garbage", "spec.txt", "Spec.md", "-spec.md"]) {
  if (FlowStage.safeParse({ name: "s", produces: p }).success) {
    fail.push(`produces: ${JSON.stringify(p)} validates, and it is neither a document name nor "record"/"nothing"`);
  }
}

// The new manifest fields exist.
const ok = CatalogManifest.safeParse({
  name: "x", purpose: "why it exists",
  commands: { flow: "x-flow" }, libraries: ["x-lib"],
  stages: [{ name: "s", produces: "nothing" }],
});
if (!ok.success) fail.push(`a conformant manifest was rejected: ${JSON.stringify(ok.error?.issues)}`);

// standalone is gone, and its removal is loud.
const old = CatalogManifest.safeParse({ name: "x", standalone: ["y"] });
if (old.success) fail.push("standalone still validates; it must be replaced by commands");

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("contract fields: ok");
