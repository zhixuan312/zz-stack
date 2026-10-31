#!/usr/bin/env node
/**
 * checks/set-version-all-or-nothing.ts — `scripts/set-version.ts` writes every location or none.
 *
 *   node checks/set-version-all-or-nothing.ts
 *
 * A temporary tree holds a copy of the script and of `scripts/manifests.ts`, a root manifest with one workspace
 * member, a lockfile, and a compose file whose image line no longer carries the `ZZ_VERSION` literal. Bumping it must
 * fail and leave every manifest and the lockfile as they were; a half-bumped tree is the state the script exists to
 * prevent. The same tree with the literal restored must then bump all four, and a second bump to the same version
 * must say nothing changed.
 *
 * Exit 0: both cases held. Exit 1: one did not, naming the file.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { root } from "../scripts/deployment.ts";

const fail: string[] = [];
const work = mkdtempSync(join(tmpdir(), "zz-set-version-"));
const FILES = ["package.json", "packages/a/package.json", "package-lock.json", "deploy/docker-compose.yml"];
const read = (): string[] => FILES.map((f) => readFileSync(join(work, f), "utf8"));
const bump = () => spawnSync(process.execPath, [join(work, "scripts/set-version.ts"), "2.0.0"], { cwd: work, encoding: "utf8" });
try {
  for (const d of ["scripts", "packages/a", "deploy"]) mkdirSync(join(work, d), { recursive: true });
  for (const f of ["scripts/set-version.ts", "scripts/manifests.ts"]) copyFileSync(join(root, f), join(work, f));
  writeFileSync(join(work, "package.json"), `{\n  "name": "t",\n  "version": "1.0.0",\n  "workspaces": ["packages/*"]\n}\n`);
  writeFileSync(join(work, "packages/a/package.json"), `{\n  "name": "a",\n  "version": "1.0.0"\n}\n`);
  writeFileSync(join(work, "package-lock.json"),
    `${JSON.stringify({ name: "t", version: "1.0.0", packages: { "": { version: "1.0.0" }, "packages/a": { version: "1.0.0" } } }, null, 2)}\n`);
  writeFileSync(join(work, "deploy/docker-compose.yml"), "services:\n  gateway:\n    image: ghcr.io/x/zz-stack:1.0.0\n");

  const before = read();
  const refused = bump();
  if (refused.status === 0) fail.push("a compose file with no ZZ_VERSION literal was bumped with exit 0");
  read().forEach((now, i) => { if (now !== before[i]) fail.push(`${FILES[i]} was rewritten by a bump that failed on the compose file`); });

  // Assembled, so the gate's one-default-per-variable rule does not read this fixture's 1.0.0 as a
  // second default for the real compose file's variables.
  const dflt = (name: string, value: string) => "${" + name + ":-" + value + "}";
  writeFileSync(join(work, "deploy/docker-compose.yml"),
    `services:\n  gateway:\n    image: ${dflt("ZZ_IMAGE", "ghcr.io/x/zz-stack")}:${dflt("ZZ_VERSION", "1.0.0")}\n`);
  const done = bump();
  if (done.status !== 0) fail.push(`a well-formed tree did not bump: ${done.stderr.trim()}`);
  read().forEach((now, i) => { if (!now.includes("2.0.0") || now.includes("1.0.0")) fail.push(`${FILES[i]} is not at 2.0.0 after a bump that succeeded`); });

  // The same version again moves nothing, and says so rather than asking for a commit of nothing.
  const again = bump();
  if (again.status !== 0) fail.push(`a repeated bump failed: ${again.stderr.trim()}`);
  if (!/already at 2\.0\.0 — nothing changed/.test(again.stdout) || /Commit them together/.test(again.stdout)) {
    fail.push(`a repeated bump does not say nothing changed: ${again.stdout.trim().split("\n").pop()}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (fail.length) {
  console.error(`set-version-all-or-nothing: ${fail.length} failure(s)`);
  for (const f of fail) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("set-version-all-or-nothing: a bump the compose file refuses writes nothing, a good one writes every location, and a repeat says nothing changed");
