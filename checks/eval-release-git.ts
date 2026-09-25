#!/usr/bin/env node
// The release CLI's git decisions against real throwaway repositories: which commit a release
// starts from (resolveBase), which commit a release is recorded by (releaseRefFor — a published
// tag containing the candidate's commit, never a commit only one clone holds), and what
// `zz-tool release-apply --reconcile` records — released only when the tag contains the
// candidate's branch commit, failed only when the version never registered and no tag carries
// that commit.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const load = async (rel: string) => import(pathToFileURL(join(process.cwd(), "packages/tools/dist", rel)).href);
const { resolveBase, releaseRefFor, tagsContaining, commitOf } = await load("release/git.js");
const { reconcileMain } = await load("release/apply.js");
const { parseArgs } = await load("lib/cli.js");

const root = mkdtempSync(join(tmpdir(), "zz-release-git-"));
const emptyConfig = join(root, "gitconfig");
writeFileSync(emptyConfig, "");
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "check", GIT_AUTHOR_EMAIL: "check@local", GIT_COMMITTER_NAME: "check", GIT_COMMITTER_EMAIL: "check@local",
});
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (cwd: string, msg: string): string => {
  writeFileSync(join(cwd, "f.txt"), `${msg}\n`);
  git(cwd, "add", "f.txt");
  git(cwd, "commit", "--quiet", "-m", msg);
  return git(cwd, "rev-parse", "HEAD");
};

try {
  // origin (bare) <- seed pushes base history and the base release tag v1.1.0.
  const origin = join(root, "origin.git");
  git(root, "init", "--quiet", "--bare", "-b", "main", origin);
  const seed = join(root, "seed");
  git(root, "clone", "--quiet", origin, seed);
  const early = commit(seed, "early");
  const baseCommit = commit(seed, "base 1.1.0");
  git(seed, "tag", "-a", "-m", "v1.1.0", "v1.1.0");
  git(seed, "push", "--quiet", "origin", "HEAD:main", "--tags");

  // A second clone: it has the tag, never the seed's later unpushed commit.
  const clone = join(root, "clone");
  git(root, "clone", "--quiet", origin, clone);
  const unpushed = commit(seed, "unpushed");

  // -- resolveBase ---------------------------------------------------------------------------
  assert.deepEqual(resolveBase(clone, baseCommit, null, null), { commit: baseCommit }, "the recorded ref resolves");
  assert.deepEqual(resolveBase(clone, baseCommit, baseCommit, null), { commit: baseCommit });
  assert.match(resolveBase(clone, baseCommit, early, null).refused, /but the base subject was released from/);
  assert.match(resolveBase(clone, baseCommit, "nope", null).refused, /--base-ref nope names no commit/);
  // A recorded ref this clone cannot resolve: a commit from another clone, or a label.
  for (const planRef of [unpushed, "demo@1.1.0"]) {
    assert.match(resolveBase(clone, planRef, null, null).refused, /pass --base-ref and --base-tag/);
    assert.match(resolveBase(clone, planRef, baseCommit, null).refused, /pass --base-tag/);
    assert.match(resolveBase(clone, planRef, baseCommit, "v9.9.9").refused, /v9\.9\.9 is not one/);
    assert.deepEqual(resolveBase(clone, planRef, baseCommit, "v1.1.0"), { commit: baseCommit }, "a --base-ref the base tag contains stands in");
    assert.deepEqual(resolveBase(clone, planRef, early, "v1.1.0"), { commit: early });
  }
  const afterBase = commit(clone, "after base");
  assert.match(resolveBase(clone, "demo@1.1.0", afterBase, "v1.1.0").refused, /is not inside the base release tag v1\.1\.0/);
  git(clone, "reset", "--quiet", "--hard", baseCommit);
  assert.deepEqual(resolveBase(clone, null, early, null), { commit: early }, "nothing recorded: the operator's word");
  assert.match(resolveBase(clone, null, null, null).refused, /nothing records the commit/);

  // -- releaseRefFor -------------------------------------------------------------------------
  git(clone, "checkout", "--quiet", "-b", "release/candidate-c1");
  const candidate = commit(clone, "release: apply candidate c1");
  const bump = commit(clone, "bump 1.2.0");
  git(clone, "tag", "-a", "-m", "v1.2.0", "v1.2.0");
  assert.match(releaseRefFor(clone, "v1.2.0", candidate).refused, /tag v1\.2\.0 is not on origin/, "a tag only this clone holds is no record");
  git(clone, "push", "--quiet", "origin", "v1.2.0");
  assert.deepEqual(releaseRefFor(clone, "v1.2.0", candidate), { commit: bump }, "the published tag's peeled commit");
  assert.match(releaseRefFor(clone, "v1.1.0", candidate).refused, /does not contain the candidate's commit/, "another release's tag");
  // A repository with no remote: the local tag is the record.
  const solo = join(root, "solo");
  git(root, "init", "--quiet", "-b", "main", solo);
  const soloCandidate = commit(solo, "candidate");
  git(solo, "tag", "v0.1.0");
  assert.deepEqual(releaseRefFor(solo, "v0.1.0", soloCandidate), { commit: soloCandidate });
  assert.deepEqual(tagsContaining(clone, candidate), ["v1.2.0"]);

  // -- reconcileMain -------------------------------------------------------------------------
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const mcp = (registered: boolean) => ({
    async call(tool: string, args: Record<string, unknown>) {
      calls.push({ tool, args });
      if (tool === "plugin_locate") return registered ? JSON.stringify({ subject_version_id: "s-new" }) : "ERROR: no such version";
      return JSON.stringify({ status: args.status });
    },
  });
  const recorded = () => calls.filter((c) => c.tool === "release_record").map((c) => c.args);
  const settle = (registered: boolean, repo: string, tag: string, extra: string[] = []) => {
    calls.length = 0;
    return reconcileMain(mcp(registered), parseArgs([
      "--candidate", "c1", "--plugin", "demo", "--release-version", "1.2.0", "--release-tag", tag, "--repo", repo, ...extra,
    ]), "attempt-1");
  };
  const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
    const [log, err] = [console.log, console.error];
    console.log = console.error = () => {};
    try { return await fn(); } finally { [console.log, console.error] = [log, err]; }
  };

  // Registered, and the tag contains the branch commit: released, by the tag's commit.
  assert.equal(await quiet(() => settle(true, clone, "v1.2.0")), 0);
  assert.equal(recorded().length, 1);
  assert.equal(recorded()[0].status, "released");
  assert.equal(recorded()[0].release_ref, bump);
  // Registered, but by a release that does not contain this candidate: nothing recorded.
  assert.equal(await quiet(() => settle(true, clone, "v1.1.0")), 1);
  assert.deepEqual(calls.map((c) => c.tool), ["plugin_locate"]);
  // Not registered, but a tag already carries the commit: the release landed; failed is refused.
  assert.equal(await quiet(() => settle(false, clone, "v1.2.0")), 1);
  assert.deepEqual(calls.map((c) => c.tool), ["plugin_locate"]);
  assert.ok(commitOf(clone, "refs/heads/release/candidate-c1"), "the branch is kept while its release may still register");
  // Not registered and no tag carries it: failed, and the branch removed.
  git(clone, "checkout", "--quiet", "--detach", baseCommit);
  git(clone, "branch", "--quiet", "-D", "release/candidate-c1");
  const lone = join(root, "lone");
  git(root, "clone", "--quiet", origin, lone);
  git(lone, "checkout", "--quiet", "-b", "release/candidate-c1");
  commit(lone, "never released");
  git(lone, "checkout", "--quiet", "--detach", baseCommit);
  assert.equal(await quiet(() => settle(false, lone, "v1.3.0")), 0);
  assert.deepEqual(recorded().map((r) => r.status), ["failed"]);
  assert.equal(commitOf(lone, "refs/heads/release/candidate-c1"), null, "the branch is removed");
  // Branch gone and no --commit: nothing can be confirmed, nothing is asked or recorded.
  assert.equal(await quiet(() => settle(false, lone, "v1.3.0")), 1);
  assert.deepEqual(calls, []);
  // --commit stands in for a deleted branch.
  assert.equal(await quiet(() => settle(true, clone, "v1.2.0", ["--commit", candidate])), 0);
  assert.equal(recorded()[0]?.release_ref, bump);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("ok eval-release-git");
process.exit(0);
