#!/usr/bin/env node
// Replay isolation, R4 item 1: the real `claude` starts its Bash tool's shell in a session of its
// own (`setsid`), so a background command the candidate runs leaves the process group `runGrouped`
// (session.ts) kills, and on macOS nothing kills it. Left running, it could swap a directory in the
// tree for a symlink to a secret between `collectProduced`'s check and its read. The launcher holds
// the tree first (`holdWorktree`, git.ts): renamed out of the sandbox's writable path, where
// Seatbelt refuses every write the survivor tries, relative to a directory it holds open included.
//
// Proven live, through the real `runTurn` and the real sandbox, with a stand-in `claude` whose
// background loop is started detached (Node's `detached` is `setsid`) and keeps swapping `sub` for a
// symlink to a directory holding a secret the sandbox cannot read:
//   - macOS: the loop outlives the turn (so the process-group kill does not reach it — without this
//     the check proves nothing), keeps writing into the tree until it is held, and not once after;
//     `collectProduced` over the held tree never carries the secret, however often it is asked.
//   - Linux: the loop is gone once the turn returns — bwrap is PID 1 of the session's own PID
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
const session = await load("packages/tools/dist/replay/session.js");
const git = await load("packages/tools/dist/replay/git.js");
const { collectProduced } = await load("packages/tools/dist/replay/launch.js");

const tool = session.detectSandbox();
if (!tool) {
  console.log(`ok replay-hold-tree (not run: no working sandbox-exec/bwrap on ${process.platform} here)`);
  process.exit(0);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SECRET = "zz-fake-operator-secret-for-replay-hold-tree";
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "zz-hold-bin-")));
const vault = realpathSync(mkdtempSync(join(tmpdir(), "zz-hold-secret-")));
const slug = `hold-tree-check-${process.pid}`;
let repo = git.freshRepo(slug);
let loopPid = 0;
try {
  writeFileSync(join(vault, "inner.txt"), SECRET);

  // The launcher's layout: the repository beside the tree, a committed base, the gitfile.
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
  const fake = join(scratch, "claude");
  writeFileSync(fake, [
    "#!/bin/sh",
    // Written by the turn itself, before the loop starts: under bwrap the loop dies with the turn.
    "mkdir -p sub && echo honest > sub/inner.txt && echo 'the real output' > report.md",
    `${JSON.stringify(process.execPath)} ${JSON.stringify(join(scratch, "spawn.cjs"))}`,
    `echo '{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}'`,
  ].join("\n") + "\n", { mode: 0o755 });

  const home = session.makeSessionHome();
  const denied = realpathSync(mkdtempSync(join(tmpdir(), "zz-hold-repo-")));
  try {
    const ctx = session.sandboxContext(tool, denied, fake);
    const turn = session.runTurn(fake, home, ctx, { model: "sonnet", prompt: "go" }, repo.path, join(home.root, "turn.log"));
    assert.equal(turn.lastText, "done");
    await sleep(500);
    const beat = () => { try { return statSync(join(repo.path, "beat")).size; } catch { return 0; } };

    if (tool === "bwrap") {
      const before = beat();
      await sleep(1000);
      assert.equal(beat(), before, "under bwrap nothing the session started outlives its turn");
    } else {
      loopPid = Number(readFileSync(join(repo.path, "loop.pid"), "utf8"));
      const before = beat();
      await sleep(500);
      assert.ok(beat() > before,
        "control: the detached loop outlives the turn and still writes into the tree — without this the check proves nothing");
    }

    repo = git.holdWorktree(repo);
    assert.equal(repo.path, `${git.worktreePathFor(slug)}.held`);
    await sleep(200);
    const snapshot = () => readdirSync(repo.path).sort().map((n) => `${n}:${lstatSync(join(repo.path, n)).isSymbolicLink()}`);
    const frozenAt = snapshot();
    const beatAt = beat();
    for (let i = 0; i < 20; i += 1) {
      const produced = collectProduced(repo, "transcript", []);
      assert.ok(!JSON.stringify(produced).includes(SECRET), "nothing outside the tree reaches produced");
      assert.ok(produced.artifacts.some((a: { path: string }) => a.path === "report.md"), "the honest output is collected");
      await sleep(50);
    }
    assert.deepEqual(snapshot(), frozenAt, "no name in the held tree changes after the hold");
    assert.equal(beat(), beatAt, "and nothing more is written into it");
    // removeSessionHome holds the home before it deletes it: nothing is left at either path.
    session.removeSessionHome(home);
    assert.equal(existsSync(home.root), false);
    assert.equal(existsSync(`${home.root}.held`), false);
  } finally {
    if (existsSync(home.root)) session.removeSessionHome(home);
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
  rmSync(scratch, { recursive: true, force: true });
  rmSync(vault, { recursive: true, force: true });
}

console.log(`ok replay-hold-tree (${tool})`);
