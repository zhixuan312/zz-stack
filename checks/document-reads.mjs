// Arrays, versions, a discoverable history — and the attestation still counts per document.
import { readFileSync } from "node:fs";
const fail = [];
const arts = readFileSync("services/zz-core/src/tools/artifacts.ts", "utf8");

for (const tool of ["document_read", "document_present"]) {
  const block = arts.split(`"${tool}"`)[1]?.slice(0, 4000) ?? "";
  if (!block) { fail.push(`${tool} is not registered`); continue; }
  if (!/array|z\.union|\[\]/.test(block)) fail.push(`${tool} does not accept an array of paths`);
  if (!/version/.test(block)) fail.push(`${tool} does not accept a version`);
}
const present = arts.split('"document_present"')[1]?.slice(0, 4000) ?? "";
if (!/_versions|versions/.test(present)) fail.push("document_present does not return the version list");
// Control: the shown record must survive, and must be per document rather than per call.
if (!/shown/.test(present)) fail.push("document_present no longer records that it was shown");
if (/shown[^\n]*once|single shown/.test(present)) {
  fail.push("a batched present records one shown row; it must record one per document");
}
// _versions must remain unwritable.
const paths = readFileSync("services/zz-core/src/paths.ts", "utf8");
if (!/_versions/.test(paths)) fail.push("the _versions write guard was removed");
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("document reads: ok");
