#!/usr/bin/env node
// Candidate build isolation: a fetched third-party tree is somebody else's bytes, and a plain
// `git init` + `git add -A` inside it keeps a `.git/config` the tree shipped, so a filter driver
// there would run as the operator, outside any sandbox. Proven live and offline, with an npm
// tarball packed from a local file:
//   - a package carrying `package/.git/config` (a filter driver and an fsmonitor) and a
//     `.gitattributes` sending every file through that filter is refused before any git command
//     runs, nothing it names runs, and nothing is left behind — while the SAME tree under plain
//     `git init` + `git add -A` runs the filter, so the vector is real here;
//   - a `.gitattributes` assigning a filter is refused without any `.git`, a tracked one in a
//     local_dir is refused too, and a `.git` at any depth or in any case is refused by the one
//     shared rule (`gitInstruction`, @zz/catalog) — never copied from a local_dir, whose copy is
//     only what git tracks, and refused at registration (checks/plugin-register-source.ts);
//   - a clean package is fetched, and its tree digest (`pluginTreeDigest`, @zz/catalog) covers
//     every file — hooks included — skips only `.git`, and refuses a symlink or a FIFO.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const tp = await load("packages/tools/dist/candidate/third-party.js");
const git = await load("packages/tools/dist/candidate/git.js");
const { gitInstruction, pluginContentDigest, pluginDirComponents, pluginTreeDigest } = await load("packages/catalog/dist/index.js");

/** What the build's own git reports changed or new in the tree — run as the build runs it
 *  (hardened flags, explicit repository, allowlisted environment). */
const changedPaths = (wt: { path: string; gitDir: string }): string[] =>
  execFileSync("git", [...git.GIT_HARDENED_ARGS, `--git-dir=${wt.gitDir}`, `--work-tree=${wt.path}`,
    "status", "--porcelain", "-z", "--untracked-files=all"],
  { cwd: wt.path, env: git.hardenedGitEnv(process.env), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    .split("\0").filter((f) => f.length > 3).map((f) => f.slice(3));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "zz-fetched-tree-")));
const slug = `fetched-tree-check-${process.pid}`;
const canary = join(scratch, "filter-ran");
const fsmonCanary = join(scratch, "fsmonitor-ran");

/** A plugin directory at `dir/package`, optionally carrying the planted git metadata. */
function plugin(dir: string, opts: { dotGit?: boolean; attributes?: string } = {}): string {
  const root = join(dir, "package");
  mkdirSync(join(root, "skills", "greet"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "acme-tool", version: "1.0.0" }));
  writeFileSync(join(root, "skills", "greet", "SKILL.md"), "---\nname: greet\n---\nSay hello.\n");
  mkdirSync(join(root, "hooks"));
  writeFileSync(join(root, "hooks", "hooks.json"), "{}\n");
  if (opts.attributes) writeFileSync(join(root, ".gitattributes"), opts.attributes);
  if (opts.dotGit) {
    mkdirSync(join(root, ".git"));
    const fsmon = join(scratch, "fsmon.sh");
    writeFileSync(fsmon, `#!/bin/sh\ntouch '${fsmonCanary}'\n`, { mode: 0o755 });
    writeFileSync(join(root, ".git", "config"),
      `[core]\n\tfsmonitor = ${fsmon}\n[filter "evil"]\n\tclean = touch '${canary}'; cat\n`);
  }
  return root;
}

/** `dir/package` as an npm tarball, and the plan that fetches it — a local file spec, which
 *  `npm pack` repacks byte for byte with no registry. */
function packagePlan(dir: string) {
  const tgz = join(dir, "acme-tool-1.0.0.tgz");
  execFileSync("tar", ["-czf", tgz, "-C", dir, "package"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const integrity = `sha512-${createHash("sha512").update(readFileSync(tgz)).digest("base64")}`;
  const root = join(dir, "package");
  const tree = pluginTreeDigest(root);
  const components = pluginDirComponents(root);
  return {
    kind: "package", spec: tgz, integrity,
    digest: pluginContentDigest("error" in components ? [] : components.components),
    treeDigest: "error" in tree ? "0".repeat(64) : tree.digest,
  };
}

const gone = () => {
  assert.equal(existsSync(git.worktreePathFor(slug)), false, "a refused fetch leaves no tree behind");
  assert.equal(existsSync(`${git.worktreePathFor(slug)}.git`), false, "nor a repository");
};

try {
  // ---- a package with package/.git/config and a filter attribute: refused, nothing runs.
  const evil = join(scratch, "evil");
  mkdirSync(evil);
  plugin(evil, { dotGit: true, attributes: "* filter=evil\n" });
  const evilPlan = packagePlan(evil);
  assert.throws(() => tp.fetchThirdParty(evilPlan, scratch, slug), /refused — \.git is git metadata/);
  assert.equal(existsSync(canary), false, "the tarball's filter driver never ran");
  assert.equal(existsSync(fsmonCanary), false, "nor its fsmonitor");
  gone();

  // The control: the same tree, snapshotted by plain git, runs the filter.
  const control = join(scratch, "control");
  mkdirSync(control);
  execFileSync("tar", ["-xzf", evilPlan.spec, "-C", control]);
  execFileSync("git", ["init", "-q"], { cwd: join(control, "package"), env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" }, stdio: "ignore" });
  execFileSync("git", ["add", "-A", "--", "."], { cwd: join(control, "package"), env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" }, stdio: "ignore" });
  assert.equal(existsSync(canary), true,
    "control: `git init` keeps the shipped .git/config and `git add` runs its filter — without this the check proves nothing");
  rmSync(canary);

  // ---- a filter attribute alone, and a macro defining one: refused.
  for (const attributes of ["*.md filter=lfs\n", "[attr]sneaky filter=evil\n* sneaky\n"]) {
    const dir = join(scratch, `attr-${createHash("sha256").update(attributes).digest("hex").slice(0, 8)}`);
    mkdirSync(dir);
    plugin(dir, { attributes });
    assert.throws(() => tp.fetchThirdParty(packagePlan(dir), scratch, slug), /\.gitattributes assigns a git filter/);
    gone();
  }

  // ---- a `.GIT` two levels down: git metadata to the shared rule, whatever its case, and the
  // clone's own top-level `.git` only when the caller says the tree is its clone.
  const repo = join(scratch, "repo");
  const local = plugin(join(repo, "catalog", "acme"), {});
  mkdirSync(join(local, "skills", "greet", ".GIT"));
  writeFileSync(join(local, "skills", "greet", ".GIT", "config"), "[core]\n");
  assert.equal(gitInstruction(local), "skills/greet/.GIT is git metadata");
  rmSync(join(local, "skills", "greet", ".GIT"), { recursive: true });
  mkdirSync(join(local, ".git"));
  assert.equal(gitInstruction(local), ".git is git metadata");
  assert.equal(gitInstruction(local, { ownGit: true }), null, "a clone's own .git is git's, not the source's");
  rmSync(join(local, ".git"), { recursive: true });

  // ---- a local_dir whose tracked `.gitattributes` assigns a filter: copied, then refused.
  writeFileSync(join(local, ".gitattributes"), "*.md filter=lfs\n");
  const rg = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  rg("init", "-q");
  rg("add", "catalog");
  const localTree = pluginTreeDigest(local);
  const localDigest = pluginContentDigest(pluginDirComponents(local).components);
  assert.throws(() => tp.fetchThirdParty({ kind: "local_dir", locator: "/catalog/acme/package", rel: "acme/package",
    digest: localDigest, treeDigest: localTree.digest }, repo, slug), /\.gitattributes assigns a git filter/);
  assert.equal(existsSync(canary), false);
  gone();

  // ---- a clean package: fetched, digests match, committed in the build's own repository.
  const clean = join(scratch, "clean");
  mkdirSync(clean);
  plugin(clean, { attributes: "* text=auto\n" });
  const cleanPlan = packagePlan(clean);
  const wt = tp.fetchThirdParty(cleanPlan, scratch, slug);
  try {
    assert.equal(wt.ref, `package:${cleanPlan.integrity}`);
    assert.equal(readFileSync(join(wt.path, "hooks", "hooks.json"), "utf8"), "{}\n");
    assert.equal(readFileSync(join(wt.path, ".git"), "utf8"), `gitdir: ${wt.gitDir}\n`, "only the build's gitfile");
    assert.deepEqual(changedPaths(wt), [], "everything fetched is committed");
  } finally {
    git.removeWorktree(wt);
  }
  const moved = { ...cleanPlan, treeDigest: "0".repeat(64) };
  assert.throws(() => tp.fetchThirdParty(moved, scratch, slug), /files digest to .* refusing to build against a different plugin/);
  gone();

  // ---- pluginTreeDigest on its own.
  const t = join(clean, "package");
  const base = pluginTreeDigest(t).digest;
  assert.match(base, /^[0-9a-f]{64}$/);
  mkdirSync(join(t, ".git"));
  writeFileSync(join(t, ".git", "HEAD"), "ref: refs/heads/main\n");
  assert.equal(pluginTreeDigest(t).digest, base, "a .git is a clone's metadata, never content");
  rmSync(join(t, ".git"), { recursive: true });
  writeFileSync(join(t, "hooks", "hooks.json"), "{\"changed\": true}\n");
  assert.notEqual(pluginTreeDigest(t).digest, base, "any file's bytes move the digest");
  writeFileSync(join(t, "hooks", "hooks.json"), "{}\n");
  assert.equal(pluginTreeDigest(t).digest, base, "and it is a function of content alone");
  symlinkSync("/etc/hosts", join(t, "hooks", "leak"));
  assert.match(pluginTreeDigest(t).error, /hooks\/leak is a symlink/);
  rmSync(join(t, "hooks", "leak"));
  execFileSync("mkfifo", [join(t, "pipe")]);
  assert.match(pluginTreeDigest(t).error, /pipe is not a regular file/);
} finally {
  rmSync(git.buildDirFor(slug), { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
}

console.log("ok candidate-fetched-tree");
