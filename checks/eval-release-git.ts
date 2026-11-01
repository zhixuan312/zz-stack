#!/usr/bin/env node
// The release CLI's git decisions against real throwaway repositories: which commit a release
// starts from (resolveBase), which commit a release is recorded by (releaseRefFor — a published
// tag containing the candidate's commit, never a commit only one clone holds), and what
// `zz-tool release-apply --reconcile` records — released only when the tag contains the
// candidate's branch commit, failed only when the version never registered and no tag carries
// that commit — and what `zz-tool release-apply` leaves when its own `failed` record is not
// written: the reason, and the branch or the idempotency key that lets the attempt be finished.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const load = async (rel: string) => import(pathToFileURL(join(process.cwd(), "packages/tools/dist", rel)).href);
const { resolveBase, releaseRefFor, tagsContaining, commitOf } = await load("release/git.js");
const { applyMain, reconcileMain } = await load("release/apply.js");
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
  assert.equal(calls.length, 0);
  // --commit stands in for a deleted branch.
  assert.equal(await quiet(() => settle(true, clone, "v1.2.0", ["--commit", candidate])), 0);
  assert.equal(recorded()[0]?.release_ref, bump);

  // -- applyMain, when its failed record is not written ----------------------------------------
  // The worktree and the console clone go under tmpdir(), which is this check's own directory.
  process.env.TMPDIR = root;
  const applied = join(root, "applied");
  git(root, "clone", "--quiet", origin, applied);
  writeFileSync(join(applied, "g.txt"), "candidate\n");
  git(applied, "add", "g.txt");
  const diff = git(applied, "diff", "--cached");
  git(applied, "reset", "--quiet", "--hard");
  const digest = createHash("sha256").update(diff, "utf8").digest("hex");
  const heard: string[] = [];
  const listening = async <T>(fn: () => Promise<T>): Promise<T> => {
    heard.length = 0;
    const [log, err] = [console.log, console.error];
    console.log = console.error = (...a: unknown[]) => { heard.push(a.map(String).join(" ")); };
    try { return await fn(); } finally { [console.log, console.error] = [log, err]; }
  };
  const unrecorded = (patchDigest: string, record: () => Promise<string>) => ({
    async call(tool: string, args: Record<string, unknown>) {
      calls.push({ tool, args });
      if (tool !== "release_apply") return record();
      return JSON.stringify({
        status: "applying", reason: null, release_attempt_id: "attempt-2", patch: { diff, patch_digest: patchDigest },
        plan: { plugin: "demo", declared_version: "1.3.0", base_subject_version_id: "s-base",
                branch: "release/candidate-c2", base_ref: baseCommit },
      });
    },
  });
  const apply = (mcpStub: object, extra: string[] = []) => {
    calls.length = 0;
    return applyMain(mcpStub, parseArgs([
      "--candidate", "c2", "--repo", applied, "--initiative", "2026-11-01-demo", "--digest", digest,
      "--release-version", "1.3.0", "--release-tag", "v1.3.0", "--release-cmd", "git tag v1.3.0", ...extra,
    ]));
  };
  // The candidate is committed, then the missing console fails the attempt, and the record call
  // throws: the reason is still printed and the branch is kept, so --reconcile can record failed.
  const lost = unrecorded(digest, async () => { throw new Error("socket hang up"); });
  assert.equal(await listening(() => apply(lost)), 1);
  assert.deepEqual(calls.map((c) => [c.tool, c.args.status]), [["release_apply", undefined], ["release_record", "failed"]]);
  assert.ok(heard.some((l) => l.startsWith("why: no zz-stack-dashboard checkout")), heard.join("\n"));
  assert.ok(heard.some((l) => l.includes("--reconcile attempt-2 --candidate c2")), heard.join("\n"));
  assert.ok(commitOf(applied, "refs/heads/release/candidate-c2"), "the unrecorded attempt's branch is kept");
  calls.length = 0;
  assert.equal(await quiet(() => reconcileMain(mcp(false), parseArgs([
    "--candidate", "c2", "--plugin", "demo", "--release-version", "1.3.0", "--release-tag", "v1.3.0", "--repo", applied,
  ]), "attempt-2")), 0);
  assert.deepEqual(recorded().map((r) => r.status), ["failed"], "reconcile finishes it from the kept branch");
  // Refused before any branch exists: no commit to reconcile from, so the way out is the same call replayed.
  const refused = unrecorded("0".repeat(64), async () => "ERROR: release_record is unavailable");
  assert.equal(await listening(() => apply(refused, ["--idempotency-key", "k-1"])), 1);
  assert.ok(heard.some((l) => l.startsWith("why: local hash check failed")), heard.join("\n"));
  assert.ok(heard.some((l) => l.includes("--idempotency-key k-1")), heard.join("\n"));
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("ok eval-release-git");
process.exit(0);
