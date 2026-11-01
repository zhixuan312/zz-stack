// An unsupported Node is a runtime problem, not a defect in the code, and this reports it as one.
// The floor is read from `package.json`'s `engines.node`, never copied as a literal here.
//
// That this Node strips TypeScript at all is not asserted here: this file and the module it imports
// are TypeScript with type syntax, so a runtime that cannot strip them fails before the first line.
// One that can and is still below the floor — Node 22.18 and later strip types unflagged — reaches
// the comparison below and fails there.
import { readFileSync } from "node:fs";

import { errMessage } from "../scripts/gate/read.ts";

const WHY = "this repository runs its scripts and checks as native TypeScript on the Node " +
  "that floor names, and a Node below it is not one they are run on.";

let pkg: { engines?: { node?: string } };
try {
  pkg = JSON.parse(readFileSync("package.json", "utf8"));
} catch (err) {
  console.error(`package.json could not be read or parsed (${errMessage(err)}) — the floor is ` +
    "undeclared, not unmet.");
  process.exit(1);
}

const declared = pkg.engines?.node;
if (!declared) {
  console.error("package.json has no engines.node — the floor is undeclared, not unmet.");
  process.exit(1);
}

// The whole version, not the major: a floor of `>=24.12.0` is unmet on 24.3. A part the floor
// leaves out is 0.
const requiredMatch = declared.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
if (!requiredMatch) {
  console.error(`package.json engines.node is ${JSON.stringify(declared)}, which names no ` +
    "version — the floor is undeclared, not unmet.");
  process.exit(1);
}
const required = requiredMatch.slice(1, 4).map((n) => Number(n ?? 0));
const running = process.versions.node.split(".").map(Number);
const below = (a: number[], b: number[]): boolean => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
};

if (below(running, required)) {
  console.error(
    `Node ${process.version} does not meet this project's floor of ${declared} ` +
    `(package.json engines.node) — ${WHY}`);
  process.exit(1);
}

process.exit(0);
