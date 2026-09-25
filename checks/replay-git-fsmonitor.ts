#!/usr/bin/env node
// Replay isolation, R2 item 1 and R3 item 1: the launcher reads the candidate's tree with
// `git status` after the session ends, outside any sandbox and with the operator's credentials in
// its own process. A `core.fsmonitor` command, a hooks directory or a filter driver planted where
// git would read it runs right there. Three halves, all proven live on throwaway repositories:
//   - the launcher's repository sits outside the tree, and the sandbox leaves the session neither
//     the tree's gitfile nor that repository to write;
//   - the launcher's own git (`changedPaths`) runs nothing a `.git/config` planted IN the tree
//     names — fsmonitor, hook or filter, with a `.gitattributes` assigning that filter — and
//     the same planted repository DOES run each under plain git, so the vectors are real here;
//   - even a filter defined in the launcher's OWN config never runs from an in-tree attribute on
//     a git that reads `GIT_ATTR_SOURCE` (2.40+).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const git = await load("packages/tools/dist/replay/git.js");
const sandbox = await load("packages/tools/dist/replay/sandbox.js");
const { detectSandbox } = await load("packages/tools/dist/replay/session.js");
const plan = await load("packages/tools/dist/replay/plan.js");

// ---- on values: the hardened prefix and environment.
assert.deepEqual([...plan.GIT_HARDENED_ARGS],
  ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.attributesFile=/dev/null"]);
const genv = plan.hardenedGitEnv({
  PATH: "/usr/bin", ZZ_TOKEN: "zzp_principal", HOME: "/Users/op", GIT_DIR: "/x", GIT_CONFIG_PARAMETERS: "'filter.x.clean'='id'",
  HTTPS_PROXY: "http://proxy.example.invalid:3128", no_proxy: "localhost", GIT_SSL_CAINFO: "/ca.pem", SSL_CERT_FILE: "/c.pem", SSL_CERT_DIR: "/certs",
});
assert.equal(genv.ZZ_TOKEN, undefined, "no launcher credential reaches a git process");
assert.equal(genv.HOME, undefined);
assert.equal(genv.GIT_DIR, undefined, "a launcher-side GIT_* variable never redirects the launcher's git");
assert.equal(genv.GIT_CONFIG_PARAMETERS, undefined, "nor defines a filter through the environment");
assert.equal(genv.GIT_CONFIG_NOSYSTEM, "1");
assert.equal(genv.GIT_CONFIG_GLOBAL, "/dev/null");
assert.equal(genv.GIT_ATTR_NOSYSTEM, "1");
assert.equal(genv.GIT_ATTR_SOURCE, "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "attributes come from the empty tree");
assert.equal(genv.PATH, "/usr/bin");
assert.equal(genv.HTTPS_PROXY, "http://proxy.example.invalid:3128", "a proxy the fetch needs reaches it");
assert.equal(genv.no_proxy, "localhost");
assert.deepEqual([genv.GIT_SSL_CAINFO, genv.SSL_CERT_FILE, genv.SSL_CERT_DIR], ["/ca.pem", "/c.pem", "/certs"]);

// ---- on values: the gitfile goes read-only after the writable tree, in both sandboxes.
const spec = { denyRead: [], allowRead: [], writable: ["/private/tmp/clone"], readOnly: ["/private/tmp/clone/.git"] };
const profile: string = sandbox.seatbeltProfile(spec);
assert.ok(profile.indexOf('(deny file-write* (subpath "/private/tmp/clone/.git"))') >
  profile.indexOf('(allow file-write* (subpath "/private/tmp/clone")'), "the .git deny comes after the clone's allow, so it wins");
const bw: string[] = sandbox.bwrapArgs(spec, "/private/tmp/clone");
const at = (...a: string[]) => bw.findIndex((_: string, i: number) => a.every((x, j) => bw[i + j] === x));
assert.ok(at("--ro-bind", "/private/tmp/clone/.git", "/private/tmp/clone/.git") >
  at("--bind", "/private/tmp/clone", "/private/tmp/clone"), "bwrap binds .git read-only on top of the writable clone");

// ---- live.
const g = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const [major, minor] = (g(tmpdir(), "--version").match(/(\d+)\.(\d+)/) ?? []).slice(1).map(Number);
const gitAtLeast = (m: number, n: number) => major > m || (major === m && minor >= n);
const src = mkdtempSync(join(tmpdir(), "zz-fsmon-src-"));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "zz-fsmon-scratch-")));
const slug = `fsmon-check-${process.pid}`;
let wt: { path: string; gitDir: string } | undefined;
try {
  g(src, "init", "-q");
  g(src, "config", "user.email", "check@example.invalid");
  g(src, "config", "user.name", "check");
  g(src, "config", "commit.gpgsign", "false");
  g(src, "config", "tag.gpgsign", "false");
  writeFileSync(join(src, "tracked.txt"), "one\n");
  writeFileSync(join(src, "kept.txt"), "kept\n");
  g(src, "add", "tracked.txt", "kept.txt");
  g(src, "commit", "-q", "-m", "release");
  g(src, "tag", "v1.0.0");
  wt = git.createWorktree(src, slug, "1.0.0");
  const clone = wt!.path;
  const gitDir = wt!.gitDir;

  // The sandbox half first, against the layout the session really gets.
  const tool = detectSandbox();
  if (!tool) {
    console.log(`  (live sandbox half not run: no working sandbox-exec/bwrap on ${process.platform} here)`);
  } else {
    const live = { denyRead: [], allowRead: [gitDir], writable: [clone], readOnly: [join(clone, ".git")] };
    const run = (script: string) => {
      const c = sandbox.sandboxedCommand(tool, live, "/bin/sh", ["-c", script], clone);
      return execFileSync(c.file, c.argv, { cwd: clone, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    };
    assert.throws(() => run(`echo 'gitdir: /tmp/elsewhere' > '${join(clone, ".git")}'`), "the gitfile cannot be rewritten");
    assert.throws(() => run(`mv '${join(clone, ".git")}' '${join(clone, "moved")}'`), "nor moved aside");
    assert.throws(() => run(`echo '[core]' >> '${join(gitDir, "config")}'`), "the launcher's repository is not writable");
    assert.equal(run("git status --porcelain").trim(), "", "the session's own git reads the repository through the gitfile");
    run(`echo ok > '${join(clone, "written.txt")}'`);
    assert.equal(existsSync(join(clone, "written.txt")), true, "the rest of the tree stays writable");
    rmSync(join(clone, "written.txt"));
  }

  // A staged rename in the launcher's repository: -z porcelain gives "R  new\0old\0" — only the
  // new path is reported.
  g(clone, ...plan.GIT_HARDENED_ARGS, `--git-dir=${gitDir}`, `--work-tree=${clone}`, "mv", "tracked.txt", "renamed.txt");
  writeFileSync(join(clone, "renamed.txt"), "changed\n");

  // What a candidate would plant if it could replace the gitfile with a repository of its own:
  // an fsmonitor, a hooks directory and a filter driver in `.git/config`, and a `.gitattributes`
  // sending every file through that filter.
  const fsmonCanary = join(scratch, "fsmonitor-ran");
  const hookCanary = join(scratch, "hook-ran");
  const filterCanary = join(scratch, "filter-ran");
  const fsmon = join(scratch, "fsmon.sh");
  writeFileSync(fsmon, `#!/bin/sh\ntouch '${fsmonCanary}'\nprintf '/\\0'\n`);
  chmodSync(fsmon, 0o755);
  const hooks = join(scratch, "hooks");
  mkdirSync(hooks);
  writeFileSync(join(hooks, "post-index-change"), `#!/bin/sh\ntouch '${hookCanary}'\n`);
  chmodSync(join(hooks, "post-index-change"), 0o755);
  rmSync(join(clone, ".git"));
  g(clone, "init", "-q");
  g(clone, "config", "core.fsmonitor", fsmon);
  g(clone, "config", "core.hooksPath", hooks);
  g(clone, "config", "filter.evil.clean", `touch '${filterCanary}'; cat`);
  writeFileSync(join(clone, ".gitattributes"), "* filter=evil\n");
  writeFileSync(join(clone, "kept.txt"), "kept, and touched\n");
  writeFileSync(join(clone, "new file.txt"), "new\n");

  const changed: string[] = git.changedPaths(wt);
  assert.deepEqual([...changed].sort(), [".gitattributes", "kept.txt", "new file.txt", "renamed.txt"],
    "changedPaths reports what changed from the launcher's repository, a rename by its new path only, and never the planted .git");
  assert.equal(existsSync(fsmonCanary), false, "the launcher's git never runs a planted core.fsmonitor");
  assert.equal(existsSync(hookCanary), false, "the launcher's git never runs a hook from a planted core.hooksPath");
  assert.equal(existsSync(filterCanary), false, "the launcher's git never runs a planted filter driver");

  // The controls: the same tree, read by plain git that finds the planted `.git` by discovery.
  // Only git >= 2.36 treats a non-boolean core.fsmonitor as a command.
  if (gitAtLeast(2, 36)) {
    g(clone, "status", "--porcelain");
    assert.equal(existsSync(fsmonCanary), true,
      "control: a plain `git status` does run the planted fsmonitor — without this the check proves nothing");
  } else {
    console.log(`  (fsmonitor control not run: git ${major}.${minor} predates command-valued core.fsmonitor)`);
  }
  g(clone, "add", "-A", ".");
  assert.equal(existsSync(filterCanary), true,
    "control: a plain `git add` does run the planted filter — without this the check proves nothing");
  rmSync(filterCanary);

  // Layer two: a filter the launcher's OWN repository defined would still not run from an
  // in-tree attribute, because the launcher reads attributes from the empty tree.
  if (gitAtLeast(2, 40)) {
    g(clone, `--git-dir=${gitDir}`, "config", "filter.evil.clean", `touch '${filterCanary}'; cat`);
    writeFileSync(join(clone, "kept.txt"), "kept, touched twice\n");
    git.changedPaths(wt);
    execFileSync("git", [...plan.GIT_HARDENED_ARGS, `--git-dir=${gitDir}`, `--work-tree=${clone}`, "add", "-A", "."],
      { cwd: clone, env: plan.hardenedGitEnv(process.env), stdio: "ignore" });
    assert.equal(existsSync(filterCanary), false, "an in-tree attribute is never read by the launcher's git on 2.40+");
  } else {
    console.log(`  (attribute-source half not run: git ${major}.${minor} predates GIT_ATTR_SOURCE)`);
  }
} finally {
  if (wt) git.removeWorktree(wt);
  rmSync(src, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
}

console.log("ok replay-git-fsmonitor");
