#!/usr/bin/env node
// Replay isolation, R3 item 5: `collectProduced` (launch.ts) checks each path the session left and
// then reads it; a command the session left running in the background could swap the path for a
// symlink in between. Every sandboxed process runs as its own process group and the whole group is
// killed when it returns (`runGrouped`, session.ts), so by collection nothing of the session is
// left. Proven live: a background child left by a stand-in `claude` is gone once `runTurn`
// returns — and, as the control, the same script under a plain `execFileSync` leaves it running.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const session = await import(pathToFileURL(join(process.cwd(), "packages/tools/dist/replay/session.js")).href);

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
/** A killed orphan is reaped by init a moment later; until then `kill(pid, 0)` still answers. */
async function goneWithin(pid: number, ms: number): Promise<boolean> {
  for (const until = Date.now() + ms; Date.now() < until; await new Promise((r) => setTimeout(r, 50))) {
    if (!alive(pid)) return true;
  }
  return !alive(pid);
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "zz-pgroup-")));
const leftovers: number[] = [];
try {
  // A stand-in `claude`: leaves a background child (stdout closed, so the turn itself returns),
  // records its pid in the working directory, and answers one stream-json frame.
  const fake = join(scratch, "claude");
  writeFileSync(fake, [
    "#!/bin/sh",
    "sleep 300 </dev/null >/dev/null 2>&1 &",
    "echo $! > bg.pid",
    `echo '{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}'`,
  ].join("\n") + "\n", { mode: 0o755 });
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "zz-pgroup-tree-")));
  const bgPid = () => Number(readFileSync(join(cwd, "bg.pid"), "utf8").trim());

  try {
    // The control: nothing kills what a plain exec leaves behind.
    execFileSync(fake, [], { cwd, stdio: "ignore" });
    const orphan = bgPid();
    leftovers.push(orphan);
    assert.equal(alive(orphan), true, "control: a plain exec leaves the background child running — without this the check proves nothing");

    // runGrouped on its own.
    const out: string = session.runGrouped(fake, [], { cwd, env: { PATH: process.env.PATH ?? "" }, timeout: 30_000 });
    assert.match(out, /"text":"done"/);
    const grouped = bgPid();
    leftovers.push(grouped);
    assert.equal(await goneWithin(grouped, 3000), true, "runGrouped kills the process group it started");
    assert.throws(() => session.runGrouped("/bin/sh", ["-c", "echo partial; exit 3"], { cwd, env: {}, timeout: 30_000 }),
      (e: { message: string; stdout: string }) => /exited 3/.test(e.message) && e.stdout === "partial\n",
      "a failing process throws the way execFileSync did, stdout attached");

    // The real path: one candidate turn through the sandbox, then nothing of it is left.
    const tool = session.detectSandbox();
    if (!tool) {
      console.log(`  (sandboxed runTurn half not run: no working sandbox-exec/bwrap on ${process.platform} here)`);
    } else {
      const home = session.makeSessionHome();
      try {
        // The operator's checkout the context denies: a directory of its own, neither the
        // stand-in's nor the tree it writes.
        const repo = realpathSync(mkdtempSync(join(tmpdir(), "zz-pgroup-repo-")));
        const ctx = session.sandboxContext(tool, repo, fake);
        rmSync(repo, { recursive: true });
        const turn = session.runTurn(fake, home, ctx, { model: "sonnet", prompt: "go" }, cwd, join(home.root, "turn.log"));
        assert.equal(turn.lastText, "done");
        const left = bgPid();
        leftovers.push(left);
        assert.equal(await goneWithin(left, 3000), true, "a background child left by the session is gone once runTurn returns");
      } finally {
        session.removeSessionHome(home);
      }
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
} finally {
  for (const pid of leftovers) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  rmSync(scratch, { recursive: true, force: true });
}

console.log("ok replay-process-group");
