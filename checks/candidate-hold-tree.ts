#!/usr/bin/env node
// Candidate build isolation: a build or gate command the candidate controls can start a background
// command in a session of its own (`setsid`), which leaves the process group `runGrouped`
// (candidate/sandbox.ts) kills, and on macOS nothing kills it. Left running, it could swap a
// directory in the tree for a symlink to a secret under `rmSync`'s walk. The build holds the tree
// first (`holdWorktree`, candidate/git.ts): renamed out of the sandbox's writable path, where
// Seatbelt refuses every write the survivor tries, relative to a directory it holds open included.
//
// Proven live, through the real `execSandboxed` and the real sandbox, with a stand-in build command
// whose background loop is started detached (Node's `detached` is `setsid`) and keeps swapping
// `sub` for a symlink to a directory holding a secret the sandbox cannot read:
//   - macOS: the loop outlives the command (so the process-group kill does not reach it — without
//     this the check proves nothing), keeps writing into the tree until it is held, and not once
//     after; no name in the held tree changes, however long it is watched.
//   - Linux: the loop is gone once the command returns — bwrap is PID 1 of the build's own PID
//     namespace, and when a namespace's init exits the kernel SIGKILLs everything in it
//     (pid_namespaces(7)), `setsid` or not.
import assert from "node:assert/strict";
import {
  existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const sandbox = await load("packages/tools/dist/candidate/sandbox.js");
const git = await load("packages/tools/dist/candidate/git.js");

const tool = sandbox.detectSandbox();
if (!tool) {
  console.log(`ok candidate-hold-tree (not run: no working sandbox-exec/bwrap on ${process.platform} here)`);
  process.exit(0);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SECRET = "zz-fake-operator-secret-for-candidate-hold-tree";
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "zz-hold-bin-")));
const vault = realpathSync(mkdtempSync(join(tmpdir(), "zz-hold-secret-")));
const slug = `hold-tree-check-${process.pid}`;
let repo = git.freshRepo(slug);
let loopPid = 0;
try {
  writeFileSync(join(vault, "inner.txt"), SECRET);

  // The build's layout: the repository beside the tree, a committed base, the gitfile.
  git.initGitDir(repo);
  writeFileSync(join(repo.path, "base.txt"), "base\n");
  git.gitIn(repo, ["add", "base.txt"]);
  git.gitIn(repo, ["-c", "user.name=c", "-c", "user.email=c@example.invalid", "-c", "commit.gpgsign=false",
    "commit", "-q", "-m", "base"]);
  git.exposeGitDir(repo);

  // The survivor: its pid, a heartbeat, and the swap — all relative to its cwd.
  writeFileSync(join(scratch, "loop.cjs"), `
    const fs = require("fs");
    fs.writeFileSync("loop.pid", String(process.pid));
    const swap = () => {
      for (let i = 0; i < 50; i++) {
        try { fs.appendFileSync("beat", "."); } catch {}
        try {
          fs.renameSync("sub", "sub.real");
          fs.symlinkSync(${JSON.stringify(vault)}, "sub");
          fs.unlinkSync("sub");
          fs.renameSync("sub.real", "sub");
        } catch {}
        try { fs.writeFileSync("late-" + (i % 3), "x"); } catch {}
      }
      setTimeout(swap, 2);
    };
    swap();
  `);
  writeFileSync(join(scratch, "spawn.cjs"), `
    require("child_process").spawn(process.execPath, [${JSON.stringify(join(scratch, "loop.cjs"))}],
      { detached: true, stdio: "ignore", cwd: process.cwd() }).unref();
  `);
  const fake = join(scratch, "build");
  writeFileSync(fake, [
    "#!/bin/sh",
    // Written by the command itself, before the loop starts: under bwrap the loop dies with it.
    "mkdir -p sub && echo honest > sub/inner.txt && echo 'the real output' > report.md",
    `${JSON.stringify(process.execPath)} ${JSON.stringify(join(scratch, "spawn.cjs"))}`,
    "echo done",
  ].join("\n") + "\n", { mode: 0o755 });

  const home = sandbox.makeBuildHome();
  const denied = realpathSync(mkdtempSync(join(tmpdir(), "zz-hold-repo-")));
  try {
    const ctx = sandbox.sandboxContext(tool, denied, fake);
    const said: string = sandbox.execSandboxed(ctx, { writable: [home.root, repo.path], readable: [repo.gitDir] }, fake, [],
      { cwd: repo.path, env: home.env, timeout: 60_000 });
    assert.equal(said, "done\n");
    await sleep(500);
    const beat = () => { try { return statSync(join(repo.path, "beat")).size; } catch { return 0; } };

    if (tool === "bwrap") {
      const before = beat();
      await sleep(1000);
      assert.equal(beat(), before, "under bwrap nothing the build started outlives its command");
    } else {
      loopPid = Number(readFileSync(join(repo.path, "loop.pid"), "utf8"));
      const before = beat();
      await sleep(500);
      assert.ok(beat() > before,
        "control: the detached loop outlives the command and still writes into the tree — without this the check proves nothing");
    }

    repo = git.holdWorktree(repo);
    assert.equal(repo.path, `${git.worktreePathFor(slug)}.held`);
    assert.equal(readFileSync(join(repo.path, "report.md"), "utf8"), "the real output\n", "the build's output is held with the tree");
    await sleep(200);
    const snapshot = () => readdirSync(repo.path).sort().map((n) => `${n}:${lstatSync(join(repo.path, n)).isSymbolicLink()}`);
    const frozenAt = snapshot();
    const beatAt = beat();
    for (let i = 0; i < 20; i += 1) {
      assert.deepEqual(snapshot(), frozenAt, "the survivor swaps nothing in the held tree");
      await sleep(50);
    }
    assert.deepEqual(snapshot(), frozenAt, "no name in the held tree changes after the hold");
    assert.equal(beat(), beatAt, "and nothing more is written into it");
    // removeBuildHome holds the home before it deletes it: nothing is left at either path.
    sandbox.removeBuildHome(home);
    assert.equal(existsSync(home.root), false);
    assert.equal(existsSync(`${home.root}.held`), false);
  } finally {
    if (existsSync(home.root)) sandbox.removeBuildHome(home);
    rmSync(denied, { recursive: true, force: true });
  }
} finally {
  if (!loopPid && tool === "sandbox-exec") {
    try { loopPid = Number(readFileSync(join(repo.path, "loop.pid"), "utf8")); } catch { /* never started */ }
  }
  if (loopPid) { try { process.kill(loopPid, "SIGKILL"); } catch { /* already gone */ } }
  git.removeWorktree(repo);
  assert.equal(existsSync(repo.path), false, "removeWorktree removes a held tree");
  assert.equal(existsSync(repo.gitDir), false);
  rmSync(git.buildDirFor(slug), { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
  rmSync(vault, { recursive: true, force: true });
}

console.log(`ok candidate-hold-tree (${tool})`);
