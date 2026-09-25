#!/usr/bin/env node
// Replay isolation, R2 item 1: the launcher reads the candidate's clone with `git status` after
// the session ends, outside any sandbox and with the operator's credentials in its own process.
// A `core.fsmonitor` command or a hooks directory planted in the clone's `.git/config` would run
// right there. Two halves, both proven live on a throwaway repository:
//   - the sandbox refuses a write to `<clone>/.git` while the rest of the clone stays writable;
//   - the launcher's own git (`changedPaths`) runs nothing a planted config names — and the same
//     planted config DOES run under a plain `git status`, so the vector this guards is real here.
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
assert.deepEqual([...plan.GIT_HARDENED_ARGS], ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"]);
const genv = plan.hardenedGitEnv({ PATH: "/usr/bin", ZZ_TOKEN: "zzp_principal", HOME: "/Users/op", GIT_DIR: "/x" });
assert.equal(genv.ZZ_TOKEN, undefined, "no launcher credential reaches a git process");
assert.equal(genv.HOME, undefined);
assert.equal(genv.GIT_DIR, undefined, "a launcher-side GIT_* variable never redirects the launcher's git");
assert.equal(genv.GIT_CONFIG_NOSYSTEM, "1");
assert.equal(genv.GIT_CONFIG_GLOBAL, "/dev/null");
assert.equal(genv.PATH, "/usr/bin");

// ---- on values: `.git` goes read-only after the writable clone, in both sandboxes.
const spec = { denyRead: [], allowRead: [], writable: ["/private/tmp/clone"], readOnly: ["/private/tmp/clone/.git"] };
const profile: string = sandbox.seatbeltProfile(spec);
assert.ok(profile.indexOf('(deny file-write* (subpath "/private/tmp/clone/.git"))') >
  profile.indexOf('(allow file-write* (subpath "/private/tmp/clone")'), "the .git deny comes after the clone's allow, so it wins");
const bw: string[] = sandbox.bwrapArgs(spec, "/private/tmp/clone");
const at = (...a: string[]) => bw.findIndex((_: string, i: number) => a.every((x, j) => bw[i + j] === x));
assert.ok(at("--ro-bind", "/private/tmp/clone/.git", "/private/tmp/clone/.git") >
  at("--bind", "/private/tmp/clone", "/private/tmp/clone"), "bwrap binds .git read-only on top of the writable clone");

// ---- live: a real clone with a planted .git/config.
const g = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const src = mkdtempSync(join(tmpdir(), "zz-fsmon-src-"));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "zz-fsmon-scratch-")));
const slug = `fsmon-check-${process.pid}`;
let wt: { path: string } | undefined;
try {
  g(src, "init", "-q");
  g(src, "config", "user.email", "check@example.invalid");
  g(src, "config", "user.name", "check");
  g(src, "config", "commit.gpgsign", "false");
  g(src, "config", "tag.gpgsign", "false");
  writeFileSync(join(src, "tracked.txt"), "one\n");
  g(src, "add", "tracked.txt");
  g(src, "commit", "-q", "-m", "release");
  g(src, "tag", "v1.0.0");
  wt = git.createWorktree(src, slug, "1.0.0");
  const clone = wt!.path;

  // What a candidate would plant if `.git` were writable to it.
  const fsmonCanary = join(scratch, "fsmonitor-ran");
  const hookCanary = join(scratch, "hook-ran");
  const fsmon = join(scratch, "fsmon.sh");
  writeFileSync(fsmon, `#!/bin/sh\ntouch '${fsmonCanary}'\nprintf '/\\0'\n`);
  chmodSync(fsmon, 0o755);
  const hooks = join(scratch, "hooks");
  mkdirSync(hooks);
  writeFileSync(join(hooks, "post-index-change"), `#!/bin/sh\ntouch '${hookCanary}'\n`);
  chmodSync(join(hooks, "post-index-change"), 0o755);
  g(clone, "config", "core.fsmonitor", fsmon);
  g(clone, "config", "core.hooksPath", hooks);
  writeFileSync(join(clone, "tracked.txt"), "changed\n");
  writeFileSync(join(clone, "new file.txt"), "new\n");
  // A staged rename: -z porcelain gives "R  new\0old\0" — only the new path is reported.
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "mv", "tracked.txt", "renamed.txt"], { cwd: clone });
  writeFileSync(join(clone, "renamed.txt"), "changed\n");

  const changed: string[] = git.changedPaths(clone);
  assert.deepEqual([...changed].sort(), ["new file.txt", "renamed.txt"], "changedPaths reports what changed, a rename by its new path only");
  assert.equal(existsSync(fsmonCanary), false, "the launcher's git never runs a planted core.fsmonitor");
  assert.equal(existsSync(hookCanary), false, "the launcher's git never runs a hook from a planted core.hooksPath");

  // The control: the same clone, read the way launch.ts used to, runs the planted command. Only
  // git >= 2.36 treats a non-boolean core.fsmonitor as a command, so an older git skips it.
  const [major, minor] = (g(src, "--version").match(/(\d+)\.(\d+)/) ?? []).slice(1).map(Number);
  if (major > 2 || (major === 2 && minor >= 36)) {
    g(clone, "status", "--porcelain");
    assert.equal(existsSync(fsmonCanary), true,
      "control: a plain `git status` does run the planted fsmonitor — without this the check proves nothing");
  } else {
    console.log(`  (fsmonitor control not run: git ${major}.${minor} predates command-valued core.fsmonitor)`);
  }

  // The sandbox half: `.git` is read-only inside the session, the rest of the clone is not.
  const tool = detectSandbox();
  if (!tool) {
    console.log(`  (live sandbox half not run: no working sandbox-exec/bwrap on ${process.platform} here)`);
  } else {
    const live = { denyRead: [], allowRead: [], writable: [clone], readOnly: [join(clone, ".git")] };
    const run = (script: string) => {
      const c = sandbox.sandboxedCommand(tool, live, "/bin/sh", ["-c", script], clone);
      return execFileSync(c.file, c.argv, { cwd: clone, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    };
    assert.throws(() => run(`echo '[core]' >> '${join(clone, ".git", "config")}'`),
      "a sandboxed write to the clone's .git/config must fail");
    assert.throws(() => run(`mv '${join(clone, ".git")}' '${join(clone, "moved")}'`), "nor can .git be moved aside");
    run(`echo ok > '${join(clone, "written.txt")}'`);
    assert.equal(existsSync(join(clone, "written.txt")), true, "the rest of the clone stays writable");
  }
} finally {
  if (wt) git.removeWorktree(wt);
  rmSync(src, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
}

console.log("ok replay-git-fsmonitor");
