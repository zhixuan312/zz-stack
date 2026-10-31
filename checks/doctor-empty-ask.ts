#!/usr/bin/env node
/**
 * checks/doctor-empty-ask.ts — a doctor run that asked no layer is never reported as every layer agreeing.
 *
 *   node checks/doctor-empty-ask.ts
 *
 *   1. `node scripts/doctor.ts --layer=` and `--layer=,` select no layer, so no host is reached; each must exit
 *      non-zero, and neither may print EVERY LAYER AGREES.
 *   2. `diagnose({ only: [] })` over the registered layers must return a finding that is not `ok`, so a caller that
 *      reads findings (the release's verification) sees that nothing was asked.
 *
 * Exit 0: every case held. Exit 1: one did not, naming it.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import "../scripts/doctor/layers/repo.ts";
import "../scripts/doctor/layers/host.ts";
import { root } from "../scripts/deployment.ts";
import { diagnose } from "../scripts/doctor/run.ts";

const fail: string[] = [];

for (const arg of ["--layer=", "--layer=,"]) {
  const run = spawnSync(process.execPath, [join(root, "scripts/doctor.ts"), arg], { cwd: root, encoding: "utf8" });
  if (run.status === 0) fail.push(`doctor ${arg} exited 0 having asked no layer`);
  if (run.stdout.includes("EVERY LAYER AGREES")) fail.push(`doctor ${arg} printed EVERY LAYER AGREES having asked no layer`);
}

const findings = diagnose({ only: [] });
if (!findings.some((f) => f.verdict !== "ok")) {
  fail.push(`diagnose({ only: [] }) returned ${findings.length} finding(s), none of them saying nothing was asked`);
}

if (fail.length) {
  console.error(`doctor-empty-ask: ${fail.length} failure(s)`);
  for (const f of fail) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("doctor-empty-ask: a run that asked no layer exits non-zero and never reports agreement");
