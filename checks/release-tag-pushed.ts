#!/usr/bin/env node
/**
 * A release tag ends on origin, whichever run writes it.
 *
 * Drives the real `placeTag` (scripts/release/tag.ts) — what release.ts's tagOnce and the
 * `--verify-only` tag-live both call — against a throwaway clone of a bare origin:
 *   1. a tag nobody has written is written on the commit and pushed;
 *   2. a tag already on the commit but on this machine alone — a run whose push failed — is
 *      pushed, not taken as done: before, both callers logged "left as it is" and returned, so the
 *      tag never reached origin;
 *   3. a tag on another commit is reported with that commit and neither moved nor pushed.
 *
 * Run: node checks/release-tag-pushed.ts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { placeTag } from "../scripts/release/tag.ts";

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

const dir = mkdtempSync(join(tmpdir(), "release-tag-pushed-"));
const emptyConfig = join(dir, "gitconfig");
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
/** The commit origin's tag `name` points at, or "" when origin has no such tag. */
const onOrigin = (repo: string, name: string): string =>
  git(repo, "ls-remote", "--tags", "origin").split("\n").map((l) => l.split("\t"))
    .find(([, ref]) => ref === `refs/tags/${name}^{}`)?.[0] ?? "";

try {
  const origin = join(dir, "origin.git");
  git(dir, "init", "--quiet", "--bare", "-b", "master", origin);
  const repo = join(dir, "repo");
  git(dir, "clone", "--quiet", origin, repo);
  const first = commit(repo, "first");
  const second = commit(repo, "second");
  git(repo, "push", "--quiet", "origin", "HEAD:master");

  const fresh = placeTag(repo, "v1.0.0", first, "zz-stack 1.0.0");
  is("wrote" in fresh && fresh.wrote, `a tag nobody had written answered ${JSON.stringify(fresh)}`);
  is(onOrigin(repo, "v1.0.0") === first, "a tag written now is not on origin at its commit");

  git(repo, "tag", "-a", "v1.0.1", second, "-m", "zz-stack 1.0.1");   // the run whose push failed
  const local = placeTag(repo, "v1.0.1", second, "zz-stack 1.0.1");
  is("wrote" in local && !local.wrote, `a tag already on the commit answered ${JSON.stringify(local)}`);
  is(onOrigin(repo, "v1.0.1") === second,
     "a tag already on the commit but on this machine alone was not pushed — every later run would take it as done");

  git(repo, "tag", "-a", "v1.0.2", first, "-m", "zz-stack 1.0.2");
  const elsewhere = placeTag(repo, "v1.0.2", second, "zz-stack 1.0.2");
  is("elsewhere" in elsewhere && elsewhere.elsewhere === first,
     `a tag on another commit answered ${JSON.stringify(elsewhere)}, not that commit`);
  is(git(repo, "rev-parse", "v1.0.2^{commit}") === first, "a tag on another commit was moved");
  is(onOrigin(repo, "v1.0.2") === "", "a tag on another commit was pushed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (fail.length) {
  console.error(`release-tag-pushed: ${fail.length} failure(s)`);
  for (const f of fail) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("release-tag-pushed: a tag written now and one left on this machine alone both end on origin; one elsewhere is reported, unmoved");
