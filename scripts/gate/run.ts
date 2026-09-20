/**
 * Running the gate: the counters, the one function every check registers through, and the
 * report that ends it.
 *
 * WHY THIS IS NOT IN `gate.ts`. The checks live in modules now, and a module importing
 * `check` from the entry file while the entry file imports that module is a cycle. `check`
 * is a function declaration and hoists, so the import resolves — but `failures` is a `const`
 * in the entry file's own body, still inside its temporal dead zone when the first module
 * runs its first check. The gate would die with a ReferenceError before printing a single
 * verdict, and the error would name a variable nobody edited. Both sides import from here
 * instead and there is no cycle left to reason about.
 *
 * `quiet` is read here rather than passed, for the same reason `root` is computed in
 * `read.ts`: a flag threaded through twenty-six modules is twenty-six chances for one of
 * them to disagree about what quiet means.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

import { gateCheckNames, isGateLaunchSource, root, trackedFiles } from "./read.ts";

/**
 * ONE RECORD PER CHECK THAT ACTUALLY RAN, and every number this file reports is derived from
 * it. There were two counters here — `failures` and `passed` — and the machine-readable report
 * added below needs the NAMES, not the totals. Keeping both would mean a report whose
 * `executed_ids.length` and whose printed "GATE PASSED — n checks" could disagree, which is
 * precisely the duplicated-constant shape this task's own contract refuses ("counts derive
 * from the same actual inventory/execution records, not duplicated constants").
 */
interface Execution {
  readonly name: string;
  /** The failure text, or null for a pass. */
  readonly detail: string | null;
}
const executions: Execution[] = [];

const quiet = process.argv.includes("--quiet");

// ── refusing a gate inside a gate, at runtime ──────────────────────────────────────────────
//
// `isGateLaunchSource` (read.ts) keeps a break-test from being REGISTERED, by reading what a
// check's source actually calls. It cannot see a launch it cannot prove statically: a command
// assembled at runtime, a `require`d launcher, or a spawn of something that spawns the gate.
// This is the other half, and it is a fact about the process rather than about the text.
//
// IT RUNS AT IMPORT TIME, AND THAT IS THE POINT. Every check module registers its checks in its
// own module body, and `scripts/gate.ts`'s first import pulls this module in ahead of all of
// them — so a refusal here lands before `marketplace.ts` regenerates a single file. A guard
// that waited for `report()` would refuse after the writes it exists to prevent.
//
// NO ORDINARY CHECK MAY TEST THIS by spawning the gate — that is the recursion itself. It is
// exercised from outside: `ZZ_GATE_RUNNING=1 node scripts/gate.ts` must refuse, non-zero, with
// the marketplace tree untouched.
const GATE_RUNNING = "ZZ_GATE_RUNNING";
if (process.env[GATE_RUNNING] === "1") {
  console.error("  GATE REFUSED — a gate is already running in this process tree " +
    `(${GATE_RUNNING}=1). A nested gate would regenerate the marketplace under the outer ` +
    "gate's feet and could not terminate. Run break-tests outside the gate, never as a check.");
  process.exit(1);
}
process.env[GATE_RUNNING] = "1";

// ── the optional machine-readable execution report ─────────────────────────────────────────

/**
 * `--report PATH` (or `--report=PATH`), resolved and refused if it lands inside the repository.
 *
 * The report is PRIVATE EVIDENCE: it names every check this run discovered, executed, skipped
 * and failed, and the external finalizer keeps it beside the rest of an acceptance run's
 * material, outside the checkout. Writing it into the tree would make it a repository
 * deliverable nobody declared, and the next gate would then hash its own last verdict into
 * `source_tree_sha256`.
 *
 * REFUSED EARLY, at import, rather than at `report()`: a bad path discovered after the gate has
 * spent minutes running every check is a bad path discovered too late to be useful.
 */
function resolveReportPath(argv: readonly string[]): string | null {
  const inline = argv.find((a) => a.startsWith("--report="));
  const flagIndex = argv.indexOf("--report");
  if (inline === undefined && flagIndex < 0) return null;
  const raw = inline !== undefined ? inline.slice("--report=".length) : argv[flagIndex + 1];
  // A FLAG GIVEN WITH NOTHING AFTER IT IS REFUSED, NEVER READ AS ABSENT — this repository's own
  // rule, and it has its own check. `--report` with no path used to fall through to `null` here
  // and the gate ran happily, producing no report and saying nothing: the caller asked for
  // evidence and got a green verdict and an empty workspace.
  if (raw === undefined || raw === "" || raw.startsWith("--")) {
    console.error("  GATE REFUSED — --report was given with no path after it");
    process.exit(2);
  }
  const target = resolve(raw);
  // The PARENT is realpath'd, not the target: the report itself need not exist yet, and a
  // symlinked parent pointing back into the checkout is exactly what this refusal is for.
  const parent = dirname(target);
  if (!existsSync(parent)) {
    console.error(`  GATE REFUSED — --report ${raw}: its directory ${parent} does not exist`);
    process.exit(2);
  }
  const real = realpathSync(parent);
  if (real === root || real.startsWith(root + sep)) {
    console.error(`  GATE REFUSED — --report ${raw} resolves inside the repository (${real}). ` +
      "A gate report is private evidence and belongs in the finalizer's workspace.");
    process.exit(2);
  }
  return join(real, basename(target));
}

const reportPath = resolveReportPath(process.argv);

/**
 * A digest of the source tree this verdict is about, so a report can be bound to the checkout
 * that produced it rather than to a branch name or a timestamp.
 *
 * Over git's own inventory where there is one — tracked AND untracked-but-not-ignored, the same
 * answer `trackedFiles()` gives every check, so the hash covers a file somebody wrote and has
 * not yet added. Outside a checkout (a tarball) it walks instead, and SAYS SO in
 * `source_tree_basis`: the two bases produce different digests for the same bytes, and a
 * reader comparing two reports has to know which question each one answered.
 */
function sourceTreeDigest(): { sha256: string; basis: string } {
  const tracked = trackedFiles();
  let files: string[];
  let basis: string;
  if (tracked) {
    files = [...tracked].sort();
    basis = "git ls-files --cached --others --exclude-standard";
  } else {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (["node_modules", "dist"].includes(e.name) || e.name.startsWith(".")) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else out.push(full.slice(root.length + 1));
      }
    };
    walk(root);
    files = out.sort();
    basis = "filesystem walk — no git inventory in this checkout";
  }
  const tree = createHash("sha256");
  for (const rel of files) {
    const full = join(root, rel);
    if (!existsSync(full)) continue;          // listed as untracked and removed between the two reads
    tree.update(`${rel}\0${createHash("sha256").update(readFileSync(full)).digest("hex")}\n`);
  }
  return { sha256: tree.digest("hex"), basis };
}

/**
 * The break-tests, classified out of the same `checks/` directory registration reads, by the
 * same function registration uses. They are NEVER executed here — a gate that ran them would
 * be the recursion they test for — so each is reported with an explicitly empty receipt, which
 * the final acceptance step fills from its own external run.
 */
function independentBreaktests(): { id: string; path: string; executed_by_this_gate: false; receipt: null }[] {
  const dir = join(root, "checks");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".ts")).sort()
    .filter((f) => isGateLaunchSource(readFileSync(join(dir, f), "utf8")))
    .map((f) => ({ id: f.replace(/\.ts$/, ""), path: `checks/${f}`, executed_by_this_gate: false as const, receipt: null }));
}

/** Names in `discovered` that no execution record accounts for, count-aware so a duplicated
 *  check name cannot hide a missing one behind a set membership test. */
function unaccountedFor(discovered: readonly string[], executed: readonly string[]): string[] {
  const remaining = new Map<string, number>();
  for (const name of executed) remaining.set(name, (remaining.get(name) ?? 0) + 1);
  const out: string[] = [];
  for (const name of discovered) {
    const n = remaining.get(name) ?? 0;
    if (n > 0) remaining.set(name, n - 1);
    else out.push(name);
  }
  return out;
}

function writeReport(verdict: "PASSED" | "FAILED" | "INCOMPLETE"): void {
  if (!reportPath) return;
  const discovered = gateCheckNames();
  const executed = executions.map((e) => e.name);
  const tree = sourceTreeDigest();
  writeFileSync(reportPath, `${JSON.stringify({
    schema_version: 1,
    verdict,
    produced_at: new Date().toISOString(),
    source_tree_sha256: tree.sha256,
    source_tree_basis: tree.basis,
    discovered_ids: discovered,
    executed_ids: executed,
    skipped_ids: unaccountedFor(discovered, executed),
    failed_ids: executions.filter((e) => e.detail !== null).map((e) => e.name),
    failures: executions.filter((e) => e.detail !== null).map((e) => ({ id: e.name, detail: e.detail })),
    independent_breaktests: independentBreaktests(),
  }, null, 2)}\n`);
  note(`  report written to ${reportPath}`);
}

/** Register and run one check. A falsy return is a pass; a returned string is the failure. */
export function check(name: string, fn: () => string | null | undefined | void): void {
  let detail: string | null | undefined | void;
  try {
    detail = fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    executions.push({ name, detail: message });
    console.error(`  ✗ ${name}\n      ${message}`);
    return;
  }
  if (detail) {
    executions.push({ name, detail });
    console.error(`  ✗ ${name}\n      ${detail}`);
  } else {
    executions.push({ name, detail: null });
    if (!quiet) console.log(`  ✓ ${name}`);
  }
}

/** An extra line under a passing check — a count, a version — suppressed by `--quiet`.
 *  A helper rather than an exported flag: two checks want this, and a `quiet` visible to
 *  twenty-six modules is twenty-six chances for one of them to decide what quiet means. */
export function note(message: string): void {
  if (!quiet) console.log(message);
}

/** Print the verdict and exit. Called by `gate.ts` after every module has been imported —
 *  at the bottom of the entry file, because an ES module's imports all run first. */
export function report() {
  // EVERY CHECK ON DISK ACTUALLY RAN, and this is the only place that can know it.
  //
  // A module under gate/checks/ that nobody imports from gate.ts keeps its `check(` lines
  // where STATE.md's count can find them and registers nothing — the declared total stays
  // right, the gate stays green, and the checks are gone. That failure did not exist while
  // every check lived in one file; it arrived with the split, so its guard did too. It is
  // not a check, because a check runs partway through and cannot see the final number.
  const written = gateCheckNames().length;
  const ran = executions.length;
  const failed = executions.filter((e) => e.detail !== null).length;
  if (written !== ran) {
    // THE REPORT IS WRITTEN ON THIS PATH TOO. An incomplete run is the one a reader most needs
    // the machine-readable form of — `skipped_ids` names exactly which checks never ran, which
    // the one line below can only count. Writing it only on the way to a verdict would have
    // made the report's absence the diagnostic.
    writeReport("INCOMPLETE");
    console.error(`\n  GATE INCOMPLETE — ${written} checks are written under ` +
      `scripts/gate/checks/ and ${ran} ran. A module is missing from gate.ts's imports.`);
    process.exit(1);
  }
  writeReport(failed === 0 ? "PASSED" : "FAILED");
  console.log(`\n  ${"─".repeat(56)}`);
  if (failed === 0) {
    console.log(`  GATE PASSED — ${ran} checks`);
    process.exit(0);
  }
  console.error(`  GATE FAILED — ${failed} of ${ran} checks`);
  process.exit(1);
}
