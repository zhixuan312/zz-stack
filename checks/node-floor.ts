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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

// A NAMED, SIDE-EFFECT-FREE MODULE — never `converted[0]`. That picked whichever file sorted
// first across scripts/, checks/, testing/ and catalog/, which resolved deterministically to
// catalog/zz/zz-access/skills/zz-doctor/doctor.ts: a CLI that reads ~/.zz/token, spawns
// `claude plugin list`, fetches a production URL and calls process.exit(1) on failure. Importing
// it made this check reach the network — breaking the gate's offline rule — and process.exit
// cannot be caught, so the gate failed with the DOCTOR's diagnostic attributed to the Node floor.
//
// What this assertion needs is a converted file whose import does nothing but define things,
// AND which this check does not already import — importing a module twice hits the module cache
// and re-exercises nothing, so the assertion would prove itself vacuously.
// scripts/deployment.ts qualifies: verified to import cleanly with no side effect, and nothing
// above pulls it in.
const SAMPLE = "scripts/deployment.ts";
if (!existsSync(join(root, SAMPLE))) process.exit(0);

const sample = SAMPLE;
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
