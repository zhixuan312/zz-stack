// An unsupported Node is a runtime problem, not a defect in the code, and this reports it as
// one. The floor is read from `package.json`'s `engines.node` — never copied as a literal here,
// because a second copy of the floor is a second thing to forget and the two can drift apart.
//
// A SECOND ASSERTION, once there is something to assert against. `tsc` can prove converted code
// is erasable; only the runtime that will actually run it can prove THIS Node strips it. Native
// stripping is a load-time behaviour, not a parse-time one — `node --check` on this very host
// still throws `SyntaxError: Unexpected identifier` on a `.ts` file with real type syntax, while
// `import()` of the same file strips it and succeeds — so this loads the file, it does not merely
// check it. The file is resolved by scanning the tree at runtime, never hardcoded, so the check
// cannot outlive the file it names. Until Task I-4 converts anything, the scan finds nothing and
// this assertion is skipped rather than held red for a corpus that cannot exist yet.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { root, sourceFiles } from "../scripts/gate/read.ts";

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

const converted = sourceFiles(["scripts", "checks", "testing", "catalog"], [".ts"]);
if (converted.length === 0) process.exit(0);

const sample = converted[0];
try {
  await import(pathToFileURL(`${root}/${sample}`).href);
} catch (err) {
  console.error(
    `Node ${process.version} (floor ${declared} is met) failed to load ${sample} — this is the ` +
    `runtime's native TypeScript support failing to strip the file, not a syntax error in the ` +
    `code it strips from: ${errMessage(err)}`);
  process.exit(1);
}

process.exit(0);
