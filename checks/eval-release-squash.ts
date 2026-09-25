#!/usr/bin/env node
// Round-3 review (finding 1): a release command that squashes the candidate's commit publishes a
// tag that does not contain it. `zz-tool release-apply --reconcile` then records nothing on its
// own — and names --accept-tag-without-candidate-commit — records `released` by the tag's
// commit, with a reason saying so, only when that flag is passed AND the version is registered,
// and never records `failed` while the release tag is published.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const load = async (rel: string) => import(pathToFileURL(join(process.cwd(), "packages/tools/dist", rel)).href);
const { reconcileMain } = await load("release/apply.js");
const { parseArgs } = await load("lib/cli.js");

const root = mkdtempSync(join(tmpdir(), "zz-release-squash-"));
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
  const origin = join(root, "origin.git");
  git(root, "init", "--quiet", "--bare", "-b", "main", origin);
  const clone = join(root, "clone");
  git(root, "clone", "--quiet", origin, clone);
  const base = commit(clone, "base");
  git(clone, "push", "--quiet", "origin", "main");

  // The candidate's branch commit, then a release command that squashes it onto main: the tag it
  // publishes carries the same change but not the candidate's commit.
  git(clone, "checkout", "--quiet", "-b", "release/candidate-c1");
  commit(clone, "release: apply candidate c1");
  git(clone, "checkout", "--quiet", "main");
  git(clone, "merge", "--quiet", "--squash", "release/candidate-c1");
  git(clone, "commit", "--quiet", "-m", "release 1.2.0 (squashed)");
  const squashed = git(clone, "rev-parse", "HEAD");
  assert.notEqual(squashed, base);

  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const mcp = (registered: boolean) => ({
    async call(tool: string, args: Record<string, unknown>) {
      calls.push({ tool, args });
      if (tool === "plugin_locate") return registered ? JSON.stringify({ subject_version_id: "s-new" }) : "ERROR: no such version";
      return JSON.stringify({ status: args.status });
    },
  });
  const recorded = () => calls.filter((c) => c.tool === "release_record").map((c) => c.args);
  let said = "";
  const settle = async (registered: boolean, extra: string[] = []): Promise<number> => {
    calls.length = 0;
    said = "";
    const [log, err] = [console.log, console.error];
    console.log = () => {};
    console.error = (...parts: unknown[]) => { said += `${parts.join(" ")}\n`; };
    try {
      return await reconcileMain(mcp(registered), parseArgs([
        "--candidate", "c1", "--plugin", "demo", "--release-version", "1.2.0", "--release-tag", "v1.2.0",
        "--repo", clone, ...extra,
      ]), "attempt-1");
    } finally {
      [console.log, console.error] = [log, err];
    }
  };
  const FLAG = "--accept-tag-without-candidate-commit";

  // The flag cannot stand in for a tag that was never published.
  git(clone, "tag", "-a", "-m", "v1.2.0", "v1.2.0");
  assert.equal(await settle(true, [FLAG]), 1, "an unpublished tag is never accepted");
  assert.deepEqual(recorded(), []);

  git(clone, "push", "--quiet", "origin", "main", "v1.2.0");

  // Published but not yet registered: the release happened, so failed would be a lie.
  assert.equal(await settle(false), 1);
  assert.deepEqual(recorded(), [], "no failed while the release tag is published");
  assert.match(said, /may register late/);
  assert.equal(await settle(false, [FLAG]), 1, "the flag needs the version registered too");
  assert.deepEqual(recorded(), []);

  // Registered, tag published without the candidate's commit: nothing recorded, and the refusal
  // names the override.
  assert.equal(await settle(true), 1);
  assert.deepEqual(recorded(), []);
  assert.match(said, /--accept-tag-without-candidate-commit/, "the refusal names the override");

  // With the override: released, by the tag's own commit, with a reason saying it was accepted.
  assert.equal(await settle(true, [FLAG]), 0);
  assert.equal(recorded().length, 1);
  const rec = recorded()[0];
  assert.equal(rec.status, "released");
  assert.equal(rec.release_ref, squashed, "release_ref is the tag's commit");
  assert.match(String(rec.reason), /accepted by the operator with --accept-tag-without-candidate-commit/);
  assert.match(String(rec.reason), new RegExp(squashed));
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("ok eval-release-squash");
process.exit(0);
