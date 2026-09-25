#!/usr/bin/env node
// Replay isolation, R2 item 2: `collectProduced` reads the candidate's clone from outside the
// sandbox and ships what it reads to the platform as `produced`. A symlink the candidate leaves
// behind (`ln -s ~/.ssh/id_ed25519 leak`), or a regular-looking path under a symlinked
// directory, must never be followed out of the clone. Proven on a throwaway repository with a
// throwaway "secret" standing in for the operator's key.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { collectProduced } = await import(pathToFileURL(join(process.cwd(), "packages/tools/dist/replay/launch.js")).href);

const g = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const clone = realpathSync(mkdtempSync(join(tmpdir(), "zz-produced-clone-")));
const outside = realpathSync(mkdtempSync(join(tmpdir(), "zz-produced-outside-")));
const SECRET = "zz-fake-operator-secret-for-this-check-only";
try {
  writeFileSync(join(outside, "id_ed25519"), SECRET);
  mkdirSync(join(outside, "dir"));
  writeFileSync(join(outside, "dir", "inner.txt"), SECRET);

  g(clone, "init", "-q");
  g(clone, "config", "user.email", "check@example.invalid");
  g(clone, "config", "user.name", "check");
  g(clone, "config", "commit.gpgsign", "false");
  writeFileSync(join(clone, "base.txt"), "base\n");
  g(clone, "add", "base.txt");
  g(clone, "commit", "-q", "-m", "base");

  // What a session leaves behind: one honest file, and three ways out of the clone.
  writeFileSync(join(clone, "report.md"), "the real output\n");
  symlinkSync(join(outside, "id_ed25519"), join(clone, "leak"));
  symlinkSync(join(outside, "dir"), join(clone, "linkdir"));
  symlinkSync(join(clone, "report.md"), join(clone, "inside-link"));

  const produced = collectProduced(clone, "transcript", []);
  const paths = produced.artifacts.map((a: { path: string }) => a.path);
  assert.deepEqual(paths, ["report.md"], "only the regular file inside the clone is collected");
  assert.equal(produced.artifacts[0].head, "the real output\n");
  assert.ok(!JSON.stringify(produced).includes(SECRET), "nothing outside the clone reaches produced");
  assert.ok(!paths.includes("inside-link"), "a symlink is skipped even when it points inside the clone");
} finally {
  rmSync(clone, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}

console.log("ok replay-produced-symlink");
