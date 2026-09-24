// An unsupported Node is a runtime problem, not a defect in the code, and this reports it as one.
// The floor is read from `package.json`'s `engines.node`, never copied as a literal here.
//
// A second assertion: `tsc` can prove the code is erasable; only the runtime that will run it can
// prove this Node strips it. Native stripping is a load-time behaviour, not a parse-time one —
// `node --check` still throws on a `.ts` file with real type syntax while `import()` of the same
// file succeeds — so this loads a file rather than checking it.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { root } from "../scripts/gate/read.ts";

const WHY = "this repository runs its scripts and checks as native TypeScript, and a Node " +
  "below the floor cannot strip that syntax at all.";

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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

const requiredMatch = declared.match(/\d+/);
if (!requiredMatch) {
  console.error(`package.json engines.node is ${JSON.stringify(declared)}, which names no ` +
    "version — the floor is undeclared, not unmet.");
  process.exit(1);
}
const requiredMajor = Number(requiredMatch[0]);
const runningMajor = Number(process.version.replace(/^v/, "").split(".")[0]);

if (runningMajor < requiredMajor) {
  console.error(
    `Node ${process.version} does not meet this project's floor of ${declared} ` +
    `(package.json engines.node) — ${WHY}`);
  process.exit(1);
}

// DELIBERATE: a named module, never whichever file sorts first. The sample's import must only
// define things — a module that reads a token, spawns a subprocess or calls process.exit would take
// the gate off its offline rule — and this check must not already import it, because a second
// import hits the module cache and proves nothing. scripts/deployment.ts qualifies.
const SAMPLE = "scripts/deployment.ts";
try {
  await import(pathToFileURL(`${root}/${SAMPLE}`).href);
} catch (err) {
  console.error(
    `Node ${process.version} (floor ${declared} is met) failed to load ${SAMPLE} — this is the ` +
    `runtime's native TypeScript support failing to strip the file, not a syntax error in the ` +
    `code it strips from: ${errMessage(err)}`);
  process.exit(1);
}

process.exit(0);
