#!/usr/bin/env node
/**
 * checks/doctor-empty-ask.ts — a doctor run that asked no layer is never reported as every layer agreeing, and one
 * that asked some is never reported as the whole deployment agreeing.
 *
 *   node checks/doctor-empty-ask.ts
 *
 *   1. `node scripts/doctor.ts --layer=` and `--layer=,` select no layer, so no host is reached; each must exit
 *      non-zero, and neither may print EVERY LAYER AGREES.
 *   2. `diagnose({ only: [] })` over the registered layers must return a finding that is not `ok`, so a caller that
 *      reads findings (the release's verification) sees that nothing was asked.
 *   3. `node scripts/doctor.ts --layer repo` reads only this checkout; whatever it finds, it must not say the
 *      deployment is what the checkout declares, and it must name the layers it did not ask.
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

{
  const run = spawnSync(process.execPath, [join(root, "scripts/doctor.ts"), "--layer", "repo"], { cwd: root, encoding: "utf8" });
  if (/EVERY LAYER AGREES|the deployment is what this checkout declares/.test(run.stdout)) {
    fail.push("doctor --layer repo vouched for the deployment having asked only the checkout");
  }
  if (!/not asked: image, host, doors, contract, data/.test(run.stdout)) {
    fail.push(`doctor --layer repo did not name the layers it left out; it ended ${JSON.stringify(run.stdout.trim().split("\n").slice(-2).join(" "))}`);
  }
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
console.log("doctor-empty-ask: a run that asked no layer exits non-zero and never reports agreement, and a run that " +
  "asked some names the rest as not asked");
