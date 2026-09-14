// The floor is one decision written in two files. This asserts they agree, and that
// nobody quietly raised the image's Node while raising the contributor's.
import { readFileSync } from "node:fs";
const fail = [];
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const declared = pkg.engines?.node;
if (declared !== ">=24.0.0") {
  fail.push(`package.json engines.node is ${JSON.stringify(declared)}, expected ">=24.0.0"`);
}
let nvmrc = "";
try { nvmrc = readFileSync(".nvmrc", "utf8").trim(); }
catch { fail.push(".nvmrc does not exist"); }
if (nvmrc && nvmrc !== "24") fail.push(`.nvmrc is ${JSON.stringify(nvmrc)}, expected "24"`);
const dockerfile = readFileSync("Dockerfile", "utf8");
if (!/FROM node:22\.23\.2-alpine/.test(dockerfile)) {
  fail.push("Dockerfile no longer pins node:22.23.2-alpine — the image version is deliberately " +
            "NOT raised by this change, because scripts/ and checks/ never ship in it");
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
