#!/usr/bin/env node
/**
 * checks/release-rollback-target.ts — a release records the version it replaces as the rollback target, and a release
 * that redeploys the running version keeps the target already recorded.
 *
 *   node checks/release-rollback-target.ts
 *
 * `recordRollbackTarget` is asked for three releases: a first one, one moving 1.1.0 to 1.2.0, and a re-run of 1.2.0
 * over 1.2.0. The first two must write the outgoing version. The re-run's shell runs against a scratch `.env` naming
 * 1.1.0 and must leave it byte for byte, or `--rollback` reads the running version and does nothing. release.ts must
 * record both the platform's and the console's target through it.
 *
 * DELIBERATE: the two writing cases are read, not run. The host's sed is GNU; a laptop's is BSD, whose `-i` takes the
 * next argument as a backup suffix, so running them here would test the laptop.
 *
 * Exit 0: every case held. Exit 1: one did not, naming it.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { root } from "../scripts/deployment.ts";
import { recordRollbackTarget } from "../scripts/release/rollback-target.ts";

const fail: string[] = [];
const KEY = "ZZ_PREVIOUS_VERSION";
for (const [name, outgoing] of [["a first release", "1.0.0"], ["a release moving 1.1.0 to 1.2.0", "1.1.0"]]) {
  const shell = recordRollbackTarget(KEY, outgoing, outgoing === "1.0.0" ? "1.1.0" : "1.2.0");
  if (!shell.includes(`echo '${KEY}=${outgoing}' >> .env`) || !shell.includes(`s/^${KEY}=.*/${KEY}=${outgoing}/`)) {
    fail.push(`${name}: the shell does not record ${outgoing}: ${shell}`);
  }
}
const work = mkdtempSync(join(tmpdir(), "zz-rollback-target-"));
try {
  const env = "ZZ_VERSION=1.2.0\nZZ_PREVIOUS_VERSION=1.1.0\n";
  writeFileSync(join(work, ".env"), env);
  execFileSync("sh", ["-c", recordRollbackTarget(KEY, "1.2.0", "1.2.0")], { cwd: work, stdio: "pipe" });
  const got = readFileSync(join(work, ".env"), "utf8");
  if (got !== env) fail.push(`a re-run of 1.2.0 over 1.2.0 rewrote .env to ${JSON.stringify(got)}; the recorded target 1.1.0 is lost`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

const release = readFileSync(join(root, "scripts/release.ts"), "utf8");
for (const key of ["ZZ_PREVIOUS_VERSION", "ZZ_DASHBOARD_PREVIOUS_VERSION"]) {
  if (!release.includes(`recordRollbackTarget("${key}",`)) fail.push(`release.ts does not record ${key} through recordRollbackTarget`);
}

if (fail.length) {
  console.error(`release-rollback-target: ${fail.length} failure(s)`);
  for (const f of fail) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("release-rollback-target: a release records what it replaced, and a same-version re-run keeps the recorded target");
