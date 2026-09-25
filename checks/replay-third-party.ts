#!/usr/bin/env node
// Replay isolation, R2 item 5, R3 item 2 and R4 item 3: a third-party subject (plugin_register's
// git, package or local_dir source) is replayable — fetched at the identity it was captured at, its
// content digest AND its tree digest (every file) checked with the walks plugin_register used,
// refused on any mismatch. The plan is proven on values; the fetch is proven live for local_dir
// against a throwaway catalog in a throwaway git repository (git and package fetch need the
// network — the package path is run offline from a local tarball by
// checks/replay-fetched-tree.ts). A local_dir copy is the files git tracks, less `tests` — what the
// platform's image carries — so an untracked `.DS_Store` in the operator's checkout changes
// nothing, and a mismatch names the untracked files as the likely cause. A git host is re-checked
// on this host before any fetch.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const tp = await load("packages/tools/dist/replay/third-party.js");
const git = await load("packages/tools/dist/replay/git.js");
const { IMAGE_UNSHIPPED, pluginContentDigest, pluginDirComponents, pluginTreeDigest } = await load("packages/catalog/dist/index.js");

const COMMIT = "a".repeat(40);
const TREE = "b".repeat(64);
const read = (kind: string, locator: string, identity: Record<string, unknown>, digest: string | null = "d1") => ({
  subject_source_locator: { kind, locator }, subject_release_identity: { tree_digest: TREE, ...identity },
  subject_content_digest: digest,
});

// ---- the plan, on values.
assert.equal(tp.sourceKind({ subject_source_locator: { kind: "catalog" } }), "catalog");
assert.equal(tp.sourceKind({ subject_source_locator: null }), "unrecorded");
assert.deepEqual(tp.thirdPartyPlan(read("git", "https://example.com/p.git#main", { resolved_commit: COMMIT })),
  { kind: "git", url: "https://example.com/p.git", commit: COMMIT, digest: "d1", treeDigest: TREE },
  "git fetches the captured commit, never the ref the locator named");
assert.match(tp.thirdPartyPlan(read("git", "https://example.com/p.git", {})), /no resolved_commit/);
assert.match(tp.thirdPartyPlan(read("git", "https://example.com/p.git", { resolved_commit: "main" })), /no resolved_commit/);
assert.match(tp.thirdPartyPlan(read("git", "ssh://example.com/p.git", { resolved_commit: COMMIT })), /only an https/);
assert.match(tp.thirdPartyPlan(read("git", "https://example.com/p.git", { resolved_commit: COMMIT }, null)), /no content_digest/);
assert.deepEqual(tp.thirdPartyPlan(read("package", "@acme/plugin@1.2.3", { tarball_integrity: "sha512-x" })),
  { kind: "package", spec: "@acme/plugin@1.2.3", integrity: "sha512-x", digest: "d1", treeDigest: TREE });
assert.match(tp.thirdPartyPlan(read("package", "@acme/plugin@1.2.3", {})), /no tarball_integrity/);
assert.match(tp.thirdPartyPlan(read("package", "--registry=x", { tarball_integrity: "i" })), /not a registry package spec/);
assert.deepEqual(tp.thirdPartyPlan(read("local_dir", "/catalog/acme/tool/", {})),
  { kind: "local_dir", locator: "/catalog/acme/tool/", rel: "acme/tool", digest: "d1", treeDigest: TREE },
  "a platform catalog path is rebased onto --repo's own catalog");
assert.match(tp.thirdPartyPlan(read("local_dir", "/etc/passwd", {})), /not a directory under a catalog root/);
assert.match(tp.thirdPartyPlan(read("local_dir", "/catalog/../etc", {})), /not a directory under a catalog root/);
assert.match(tp.thirdPartyPlan(read("ftp", "x", {})), /no way to fetch/);
for (const kind of ["git", "package", "local_dir"]) {
  const noTree = { subject_source_locator: { kind, locator: kind === "local_dir" ? "/catalog/a/b" : "https://example.com/p.git" },
    subject_release_identity: { resolved_commit: COMMIT, tarball_integrity: "sha512-x" }, subject_content_digest: "d1" };
  assert.match(tp.thirdPartyPlan(noTree), /no tree_digest/, `a ${kind} subject captured without a tree digest is refused`);
}

// ---- the git host, re-checked here: an internal address is refused before any fetch, and a git
// plan that never went through the check is refused by the fetch itself.
const gitPlan = { kind: "git", url: "https://127.0.0.1/p.git", commit: COMMIT, digest: "d1", treeDigest: TREE };
await assert.rejects(tp.pinGitPlan(gitPlan), /private, loopback or link-local/);
await assert.rejects(tp.pinGitPlan({ ...gitPlan, url: "https://localhost/p.git" }), /private, loopback or link-local/);
assert.throws(() => tp.fetchThirdParty(gitPlan, "/nonexistent", `third-party-pin-${process.pid}`), /never checked as a public host/);
assert.deepEqual(await tp.pinGitPlan({ kind: "package", spec: "x", integrity: "i", digest: "d1", treeDigest: TREE }),
  { kind: "package", spec: "x", integrity: "i", digest: "d1", treeDigest: TREE }, "only a git plan is pinned");

// ---- local_dir, live: fetched into the run's clone directory as a git repository, digest
// checked, and a wrapping one-plugin marketplace in the session home.
const repo = realpathSync(mkdtempSync(join(tmpdir(), "zz-3p-repo-")));
const slug = `third-party-check-${process.pid}`;
const g = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
try {
  const src = join(repo, "catalog", "acme", "tool");
  mkdirSync(join(src, "skills", "greet"), { recursive: true });
  writeFileSync(join(src, "skills", "greet", "SKILL.md"), "---\nname: greet\n---\nSay hello.\n");
  // Fixtures the image leaves out, tracked all the same.
  mkdirSync(join(src, IMAGE_UNSHIPPED));
  writeFileSync(join(src, IMAGE_UNSHIPPED, "case.md"), "a fixture\n");
  g("init", "-q");
  g("add", "catalog");
  g("-c", "user.name=c", "-c", "user.email=c@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "catalog");
  const got = pluginDirComponents(src);
  assert.ok(!("error" in got));
  const digest = pluginContentDigest(got.components);
  // What plugin_register records for a catalog directory: without what the image leaves out.
  const tree = pluginTreeDigest(src, IMAGE_UNSHIPPED);
  assert.ok(!("error" in tree));
  const treeDigest = tree.digest;
  assert.notEqual(pluginTreeDigest(src).digest, treeDigest, "control: the fixtures would move the digest if counted");
  // Finder's litter, never tracked: not copied, so not digested.
  writeFileSync(join(src, ".DS_Store"), "junk");
  writeFileSync(join(src, "skills", ".SKILL.md.swp"), "junk");
  const local = { kind: "local_dir", locator: "/catalog/x", rel: "acme/tool", digest, treeDigest };

  const wt = tp.fetchThirdParty(local, repo, slug);
  try {
    assert.equal(wt.ref, "local_dir:/catalog/x", "the ref is the one replay_start records: local_dir:<locator>");
    assert.equal(readFileSync(join(wt.path, "skills", "greet", "SKILL.md"), "utf8"), "---\nname: greet\n---\nSay hello.\n");
    assert.equal(existsSync(join(wt.path, ".DS_Store")), false, "an untracked file is not copied");
    assert.equal(existsSync(join(wt.path, IMAGE_UNSHIPPED)), false, "nor what the image leaves out");
    assert.deepEqual(git.changedPaths(wt), [], "the fetched source is committed, so nothing is reported as produced yet");
    writeFileSync(join(wt.path, "out.md"), "session output\n");
    assert.deepEqual(git.changedPaths(wt), ["out.md"], "what the session writes afterwards is what gets reported");

    const sessionRoot = realpathSync(mkdtempSync(join(tmpdir(), "zz-3p-home-")));
    const market = tp.wrapAsMarketplace(wt, "acme-tool", sessionRoot);
    try {
      assert.equal(market, join(sessionRoot, "subject-marketplace"), "the wrap lives in the session's own home");
      const m = JSON.parse(readFileSync(join(market, ".claude-plugin", "marketplace.json"), "utf8"));
      assert.deepEqual(m.plugins, [{ name: "acme-tool", source: "./plugin" }]);
      assert.equal(existsSync(join(market, "plugin", "skills", "greet", "SKILL.md")), true);
      assert.equal(existsSync(join(market, "plugin", ".git")), false, "the clone's .git is not shipped into the marketplace");
    } finally {
      rmSync(sessionRoot, { recursive: true, force: true });
    }
  } finally {
    git.removeWorktree(wt);
  }

  assert.throws(() => tp.fetchThirdParty({ ...local, digest: "0".repeat(64) }, repo, slug),
    /content digest .* refusing to replay a different plugin/, "a digest mismatch is refused");
  assert.equal(existsSync(git.worktreePathFor(slug)), false, "a refused fetch leaves nothing behind");
  assert.equal(existsSync(`${git.worktreePathFor(slug)}.git`), false, "nor its repository");
  assert.throws(() => tp.fetchThirdParty({ ...local, rel: "acme/missing" }, repo, slug), /does not exist/);

  // Same skills, changed hook: the content digest still matches, the tree digest does not.
  mkdirSync(join(src, "hooks"));
  writeFileSync(join(src, "hooks", "hooks.json"), "{\"PreToolUse\": []}\n");
  g("add", "catalog/acme/tool/hooks");
  assert.equal(pluginContentDigest(pluginDirComponents(src).components), digest, "the content digest never sees hooks");
  assert.throws(() => tp.fetchThirdParty(local, repo, slug),
    /files digest to .* refusing to replay a different plugin \(a file git tracks in --repo differs/,
    "a checkout whose hooks moved since capture is refused");
  g("rm", "-q", "--cached", "-r", "catalog/acme/tool/hooks");
  // A capture that saw an untracked file (a platform reading a checkout's catalog): the mismatch
  // names it, rather than leaving the operator with two opaque digests.
  const withUntracked = { ...local, treeDigest: pluginTreeDigest(src, IMAGE_UNSHIPPED).digest };
  assert.throws(() => tp.fetchThirdParty(withUntracked, repo, slug),
    /the capture saw files git does not track, which are never copied: .*\.DS_Store.*skills\/\.SKILL\.md\.swp/,
    "an untracked file behind a mismatch is named");
  rmSync(join(src, "hooks"), { recursive: true });

  // A tracked file gone from the working tree is refused by name.
  rmSync(join(src, "skills", "greet", "SKILL.md"));
  assert.throws(() => tp.fetchThirdParty(local, repo, slug), /skills\/greet\/SKILL\.md is tracked .* missing from its working tree/);
  writeFileSync(join(src, "skills", "greet", "SKILL.md"), "---\nname: greet\n---\nSay hello.\n");

  // A catalog entry that is a symlink out of the catalog is refused, never copied.
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "zz-3p-outside-")));
  try {
    execFileSync("ln", ["-s", outside, join(repo, "catalog", "escape")]);
    assert.throws(() => tp.fetchThirdParty({ ...local, rel: "escape" }, repo, slug), /outside --repo's catalog/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
} finally {
  rmSync(repo, { recursive: true, force: true });
}

console.log("ok replay-third-party");
