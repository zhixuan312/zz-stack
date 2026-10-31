#!/usr/bin/env node
/**
 * checks/activation-rehearsal-verdict.ts — the activation rehearsal states the verdict it derived, in every line that
 * names one, when no precondition is blocked.
 *
 *   node checks/activation-rehearsal-verdict.ts
 *
 * A temporary tree holds a copy of `scripts/activation-rehearsal.ts` and of the runbook with all eight preconditions
 * `met`. The rehearsal runs there with `--record`; it must exit 0, and neither its output nor the recorded block may
 * say the verdict is REFUSE.
 *
 * Exit 0: the case held. Exit 1: it did not, naming the line.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { root } from "../scripts/deployment.ts";

const fail: string[] = [];
const work = mkdtempSync(join(tmpdir(), "zz-activation-rehearsal-"));
try {
  mkdirSync(join(work, "scripts"));
  mkdirSync(join(work, "deploy"));
  copyFileSync(join(root, "scripts/activation-rehearsal.ts"), join(work, "scripts/activation-rehearsal.ts"));
  const runbook = JSON.parse(readFileSync(join(root, "deploy/activation-runbook.json"), "utf8"));
  for (const key of Object.keys(runbook.preconditions)) runbook.preconditions[key] = { state: "met" };
  const path = join(work, "deploy/activation-runbook.json");
  writeFileSync(path, JSON.stringify(runbook, null, 2));

  const env = { ...process.env };
  for (const name of ["TEAM_DB_URL", "PLATFORM_DB_URL", "DATABASE_URL", "ZZ_TENANT_INFO_ISOLATED_DB_URL", "POSTGRES_URL", "PGHOST", "PGDATABASE"]) {
    delete env[name];
  }
  const run = spawnSync(process.execPath, [join(work, "scripts/activation-rehearsal.ts"), "--record"], { env, encoding: "utf8" });
  if (run.status !== 0) fail.push(`with every precondition met the rehearsal exited ${run.status}, not 0: ${run.stderr.trim().slice(-300)}`);
  for (const line of run.stdout.split("\n").filter((l) => /REFUSE\b/.test(l))) {
    fail.push(`with every precondition met the rehearsal printed: ${line.trim()}`);
  }
  const recorded = JSON.parse(readFileSync(path, "utf8")).rehearsal ?? {};
  if (recorded.derived_gate !== "no blockers") fail.push(`the recorded derived_gate is ${JSON.stringify(recorded.derived_gate)}, not "no blockers"`);
  for (const e of (recorded.established ?? []) as string[]) {
    if (/REFUSE\b/.test(e)) fail.push(`the recorded block says, beside derived_gate "no blockers": ${e}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (fail.length) {
  console.error(`activation-rehearsal-verdict: ${fail.length} failure(s)`);
  for (const f of fail) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("activation-rehearsal-verdict: with every precondition met, the printed and recorded verdict is no blockers");
