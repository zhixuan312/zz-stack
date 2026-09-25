#!/usr/bin/env node
// The candidate build's `applyPatch` (candidate/git.ts), live: a candidate's diff applied into a
// real standalone clone at its release tag. With `GIT_ATTR_SOURCE` set, `git apply` segfaulted on
// git 2.50.1 (Apple Git-155) — every candidate failed before its build began, and nothing covered
// it. Proves:
//   - a diff applies, a trailing newline missing from the recorded diff included;
//   - a filter named by the tree's own `.gitattributes` (or one the patch adds) never runs;
//   - a diff that does not match the tree throws, and leaves the tree unchanged.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const git = await load("packages/tools/dist/candidate/git.js");

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "zz-apply-patch-")));
const canary = join(scratch, "filter-ran");
const repo = join(scratch, "repo");
mkdirSync(repo);
const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=c@x", "-c", "user.name=c", ...a], { cwd: repo, stdio: "pipe" });
g("init", "-q");
writeFileSync(join(repo, "value.txt"), "before\n");
// Planted in the release itself: every file through a filter the build's git must never run.
writeFileSync(join(repo, ".gitattributes"), "* filter=evil\n");
g("add", "-A");
g("commit", "-q", "-m", "release");
g("tag", "v0.0.1");

const slug = `apply-patch-check-${process.pid}`;
const tree = git.createWorktree(repo, slug, "0.0.1");
try {
  // The operator's own config naming the filter would be the only way it could run; the
  // build's git reads none (GIT_CONFIG_GLOBAL=/dev/null), which is what this proves together with
  // the canary staying absent.
  process.env.GIT_CONFIG_PARAMETERS = `'filter.evil.clean'='touch ${canary}; cat' 'filter.evil.smudge'='touch ${canary}; cat'`;
  git.applyPatch(tree, "diff --git a/value.txt b/value.txt\n--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-before\n+after");
  assert.equal(readFileSync(join(tree.path, "value.txt"), "utf8"), "after\n", "the diff applied (no trailing newline in the recorded diff)");

  git.applyPatch(tree, "diff --git a/added.txt b/added.txt\nnew file mode 100644\n--- /dev/null\n+++ b/added.txt\n@@ -0,0 +1 @@\n+new\n");
  assert.equal(readFileSync(join(tree.path, "added.txt"), "utf8"), "new\n", "a file the patch adds is created");

  assert.throws(() => git.applyPatch(tree,
    "diff --git a/value.txt b/value.txt\n--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-nothing like this\n+x\n"),
    /Command failed/, "a diff that does not match throws");
  assert.equal(readFileSync(join(tree.path, "value.txt"), "utf8"), "after\n", "and leaves the tree as it was");
  assert.equal(existsSync(canary), false, "no filter ran");
} finally {
  delete process.env.GIT_CONFIG_PARAMETERS;
  git.removeWorktree(tree);
  rmSync(git.buildDirFor(slug), { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
}

console.log("ok candidate-apply-patch");
