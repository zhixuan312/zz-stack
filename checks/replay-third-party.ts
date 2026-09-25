#!/usr/bin/env node
// Replay isolation, R2 item 5: a third-party subject (plugin_register's git, package or local_dir
// source) is replayable — fetched at the identity it was captured at, its content digest checked
// with the same walk plugin_register used, refused on any mismatch. The plan is proven on values;
// the fetch is proven live for local_dir against a throwaway catalog (git and package fetch need
// the network, so their live half is not run here).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const tp = await load("packages/tools/dist/replay/third-party.js");
const git = await load("packages/tools/dist/replay/git.js");
const { pluginContentDigest, pluginDirComponents } = await load("packages/catalog/dist/index.js");

const COMMIT = "a".repeat(40);
const read = (kind: string, locator: string, identity: Record<string, unknown>, digest: string | null = "d1") => ({
  subject_source_locator: { kind, locator }, subject_release_identity: identity, subject_content_digest: digest,
});

// ---- the plan, on values.
assert.equal(tp.sourceKind({ subject_source_locator: { kind: "catalog" } }), "catalog");
assert.equal(tp.sourceKind({ subject_source_locator: null }), "unrecorded");
assert.deepEqual(tp.thirdPartyPlan(read("git", "https://example.com/p.git#main", { resolved_commit: COMMIT })),
  { kind: "git", url: "https://example.com/p.git", commit: COMMIT, digest: "d1" },
  "git fetches the captured commit, never the ref the locator named");
assert.match(tp.thirdPartyPlan(read("git", "https://example.com/p.git", {})), /no resolved_commit/);
assert.match(tp.thirdPartyPlan(read("git", "https://example.com/p.git", { resolved_commit: "main" })), /no resolved_commit/);
assert.match(tp.thirdPartyPlan(read("git", "ssh://example.com/p.git", { resolved_commit: COMMIT })), /only an https/);
assert.match(tp.thirdPartyPlan(read("git", "https://example.com/p.git", { resolved_commit: COMMIT }, null)), /no content_digest/);
assert.deepEqual(tp.thirdPartyPlan(read("package", "@acme/plugin@1.2.3", { tarball_integrity: "sha512-x" })),
  { kind: "package", spec: "@acme/plugin@1.2.3", integrity: "sha512-x", digest: "d1" });
assert.match(tp.thirdPartyPlan(read("package", "@acme/plugin@1.2.3", {})), /no tarball_integrity/);
assert.match(tp.thirdPartyPlan(read("package", "--registry=x", { tarball_integrity: "i" })), /not a registry package spec/);
assert.deepEqual(tp.thirdPartyPlan(read("local_dir", "/catalog/acme/tool/", {})), { kind: "local_dir", locator: "/catalog/acme/tool/", rel: "acme/tool", digest: "d1" },
  "a platform catalog path is rebased onto --repo's own catalog");
assert.match(tp.thirdPartyPlan(read("local_dir", "/etc/passwd", {})), /not a directory under a catalog root/);
assert.match(tp.thirdPartyPlan(read("local_dir", "/catalog/../etc", {})), /not a directory under a catalog root/);
assert.match(tp.thirdPartyPlan(read("ftp", "x", {})), /no way to fetch/);

// ---- local_dir, live: fetched into the run's clone directory as a git repository, digest
// checked, and a wrapping one-plugin marketplace in the session home.
const repo = realpathSync(mkdtempSync(join(tmpdir(), "zz-3p-repo-")));
const slug = `third-party-check-${process.pid}`;
try {
  const src = join(repo, "catalog", "acme", "tool");
  mkdirSync(join(src, "skills", "greet"), { recursive: true });
  writeFileSync(join(src, "skills", "greet", "SKILL.md"), "---\nname: greet\n---\nSay hello.\n");
  const got = pluginDirComponents(src);
  assert.ok(!("error" in got));
  const digest = pluginContentDigest(got.components);

  const wt = tp.fetchThirdParty({ kind: "local_dir", locator: "/catalog/x", rel: "acme/tool", digest }, repo, slug);
  try {
    assert.equal(wt.ref, "local_dir:/catalog/x", "the ref is the one replay_start records: local_dir:<locator>");
    assert.equal(readFileSync(join(wt.path, "skills", "greet", "SKILL.md"), "utf8"), "---\nname: greet\n---\nSay hello.\n");
    assert.deepEqual(git.changedPaths(wt.path), [], "the fetched source is committed, so nothing is reported as produced yet");
    writeFileSync(join(wt.path, "out.md"), "session output\n");
    assert.deepEqual(git.changedPaths(wt.path), ["out.md"], "what the session writes afterwards is what gets reported");

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

  assert.throws(() => tp.fetchThirdParty({ kind: "local_dir", locator: "/catalog/x", rel: "acme/tool", digest: "0".repeat(64) }, repo, slug),
    /content digest .* refusing to replay a different plugin/, "a digest mismatch is refused");
  assert.equal(existsSync(git.worktreePathFor(slug)), false, "a refused fetch leaves nothing behind");
  assert.throws(() => tp.fetchThirdParty({ kind: "local_dir", locator: "/catalog/x", rel: "acme/missing", digest }, repo, slug), /does not exist/);

  // A catalog entry that is a symlink out of the catalog is refused, never copied.
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "zz-3p-outside-")));
  try {
    execFileSync("ln", ["-s", outside, join(repo, "catalog", "escape")]);
    assert.throws(() => tp.fetchThirdParty({ kind: "local_dir", locator: "/catalog/x", rel: "escape", digest }, repo, slug), /outside --repo's catalog/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
} finally {
  rmSync(repo, { recursive: true, force: true });
}

console.log("ok replay-third-party");
