#!/usr/bin/env node
/**
 * test-run.ts — the three test commands, and the only ones.
 *
 *   npm run test:t1       the Tier 1 checks affected by changes since the last green run
 *   npm run test:t2       the affected Tier 2 checks plus the affected Tier 1 checks
 *   npm run test:release  every Tier 1 and Tier 2 check, then the type check and lint, reported only
 *
 * No command takes an argument. The gate has no import graph, so the tests are chosen by
 * `scripts/gate/select.ts` from the path-to-module map in `scripts/gate/test-groups.json`: a path
 * the map does not cover runs the whole gate. A passing run writes `.gate-last-green` (gitignored),
 * and the next run starts there; with no marker it diffs against master.
 *
 * This repository has no Tier 2 checks today — there is no `<name>.perf` module — so `test:t2`
 * selects the affected Tier 1 checks. That is the standard's own rule for a repository with no
 * Tier 2 tests, not a missing command.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { gateCheckNames } from "./gate/read.ts";
import { gateModules, markGreen, select } from "./gate/select.ts";

const root = join(import.meta.dirname, "..");
const tier = process.argv[2];

const run = (cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): boolean => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", env });
  return r.status === 0;
};

if (tier === "t1" || tier === "t2") {
  const selection = select(tier === "t2" ? 2 : 1);
  const checks = gateCheckNames(selection.modules).length;
  const ofChecks = gateCheckNames().length;
  const basis = selection.changed.length === 0
    ? selection.basis
    : `${selection.changed.length} changed path(s) ${selection.basis}`;
  console.log(`  test:${tier} — ${basis}`);
  console.log(`  ${selection.modules.length} of ${gateModules().length} modules, ` +
    `${checks} of ${ofChecks} checks${selection.whole ? " (the whole gate)" : ""}`);
  if (selection.changed.length > 0) {
    for (const p of selection.changed.slice(0, 12)) console.log(`      ${p}`);
    if (selection.changed.length > 12) console.log(`      … and ${selection.changed.length - 12} more`);
  }
  // The selection is passed in the environment, not on the command line: the three commands take
  // no arguments, and the runner — not the person invoking it — picks the tests.
  const passed = run("node", ["scripts/gate.ts"], {
    ...process.env,
    ZZ_GATE_MODULES: selection.modules.join(","),
  });
  if (!passed) process.exit(1);
  const head = markGreen();
  console.log(`  last green: ${head.slice(0, 12)}`);
  process.exit(0);
}

if (tier === "release") {
  // Every Tier 1 and Tier 2 check, then the type check and lint. There is no lint configuration
  // in this repository, so lint is the `any` sweeps. The tooling project is not in `tsc -b`,
  // which the gate's build check runs because a build that does not compile is Tier 1.
  // DELIBERATE: the type check and lint are Tier 3 — they run after the gate and are reported,
  // and their results never change the exit code. Every stage runs whatever the others returned.
  console.log("  test:release — every Tier 1 and Tier 2 check, then the type check and lint (reported, never block)");
  const gatePassed = run("node", ["scripts/gate.ts"]);
  const reported: [string, string][] = [
    ["type check", "checks/strict-tooling-zero.ts"],
    ["lint, any in checks/", "checks/strict-checks-dir.ts"],
    ["lint, any in scripts/, testing/, skills", "checks/strict-scripts-dir.ts"],
  ];
  for (const [what, file] of reported) {
    const clean = run("node", [file]);
    console.log(`  ${what} (Tier 3, reported only): ${clean ? "clean" : "findings above — not a failure"}`);
  }
  if (!gatePassed) process.exit(1);
  const head = markGreen();
  console.log(`  last green: ${head.slice(0, 12)}`);
  process.exit(0);
}

console.error("usage: node scripts/test-run.ts t1|t2|release");
process.exit(2);
