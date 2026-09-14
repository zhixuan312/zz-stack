/**
 * Running the gate: the counters, the one function every check registers through, and the
 * report that ends it.
 *
 * WHY THIS IS NOT IN `gate.mjs`. The checks live in modules now, and a module importing
 * `check` from the entry file while the entry file imports that module is a cycle. `check`
 * is a function declaration and hoists, so the import resolves — but `failures` is a `const`
 * in the entry file's own body, still inside its temporal dead zone when the first module
 * runs its first check. The gate would die with a ReferenceError before printing a single
 * verdict, and the error would name a variable nobody edited. Both sides import from here
 * instead and there is no cycle left to reason about.
 *
 * `quiet` is read here rather than passed, for the same reason `root` is computed in
 * `read.mjs`: a flag threaded through twenty-six modules is twenty-six chances for one of
 * them to disagree about what quiet means.
 */
import { gateCheckNames } from "./read.ts";

const failures: string[] = [];
let passed = 0;
const quiet = process.argv.includes("--quiet");

/** Register and run one check. A falsy return is a pass; a returned string is the failure. */
export function check(name: string, fn: () => string | null | undefined | void): void {
  let detail: string | null | undefined | void;
  try {
    detail = fn();
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`  ✗ ${name}\n      ${err instanceof Error ? err.message : err}`);
    return;
  }
  if (detail) {
    failures.push(`${name}: ${detail}`);
    console.error(`  ✗ ${name}\n      ${detail}`);
  } else {
    passed++;
    if (!quiet) console.log(`  ✓ ${name}`);
  }
}

/** An extra line under a passing check — a count, a version — suppressed by `--quiet`.
 *  A helper rather than an exported flag: two checks want this, and a `quiet` visible to
 *  twenty-six modules is twenty-six chances for one of them to decide what quiet means. */
export function note(message: string): void {
  if (!quiet) console.log(message);
}

/** Print the verdict and exit. Called by `gate.mjs` after every module has been imported —
 *  at the bottom of the entry file, because an ES module's imports all run first. */
export function report() {
  // EVERY CHECK ON DISK ACTUALLY RAN, and this is the only place that can know it.
  //
  // A module under gate/checks/ that nobody imports from gate.mjs keeps its `check(` lines
  // where STATE.md's count can find them and registers nothing — the declared total stays
  // right, the gate stays green, and the checks are gone. That failure did not exist while
  // every check lived in one file; it arrived with the split, so its guard did too. It is
  // not a check, because a check runs partway through and cannot see the final number.
  const written = gateCheckNames().length;
  const ran = passed + failures.length;
  if (written !== ran) {
    console.error(`\n  GATE INCOMPLETE — ${written} checks are written under ` +
      `scripts/gate/checks/ and ${ran} ran. A module is missing from gate.mjs's imports.`);
    process.exit(1);
  }
  console.log(`\n  ${"─".repeat(56)}`);
  if (failures.length === 0) {
    console.log(`  GATE PASSED — ${passed} checks`);
    process.exit(0);
  }
  console.error(`  GATE FAILED — ${failures.length} of ${passed + failures.length} checks`);
  process.exit(1);
}
