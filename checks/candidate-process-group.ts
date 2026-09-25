#!/usr/bin/env node
// Candidate build isolation: a build step the candidate controls can leave a command running in the
// background, which could move things in the tree while it is removed. Every sandboxed process
// runs as its own process group and the whole group is killed when it returns (`runGrouped`,
// candidate/sandbox.ts). Proven live: a background child left by a stand-in build command is gone
// once `execSandboxed` returns — and, as the control, the same script under a plain `execFileSync`
// leaves it running. A command that leaves the group (`setsid`) is out of this kill's reach;
// checks/candidate-hold-tree.ts proves what covers it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const sandbox = await import(pathToFileURL(join(process.cwd(), "packages/tools/dist/candidate/sandbox.js")).href);

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
  // A stand-in build command: leaves a background child (stdout closed, so the command itself
  // returns), records its pid in the working directory, and prints one line.
  const fake = join(scratch, "build");
  writeFileSync(fake, [
    "#!/bin/sh",
    "sleep 300 </dev/null >/dev/null 2>&1 &",
    "echo $! > bg.pid",
    "echo done",
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
    const out: string = sandbox.runGrouped(fake, [], { cwd, env: { PATH: process.env.PATH ?? "" }, timeout: 30_000 });
    assert.equal(out, "done\n");
    const grouped = bgPid();
    leftovers.push(grouped);
    assert.equal(await goneWithin(grouped, 3000), true, "runGrouped kills the process group it started");
    assert.throws(() => sandbox.runGrouped("/bin/sh", ["-c", "echo partial; exit 3"], { cwd, env: {}, timeout: 30_000 }),
      (e: { message: string; stdout: string }) => /exited 3/.test(e.message) && e.stdout === "partial\n",
      "a failing process throws the way execFileSync did, stdout attached");

    // The real path: one build command through the sandbox, then nothing of it is left.
    const tool = sandbox.detectSandbox();
    if (!tool) {
      console.log(`  (sandboxed half not run: no working sandbox-exec/bwrap on ${process.platform} here)`);
    } else {
      const home = sandbox.makeBuildHome();
      try {
        // The operator's checkout the context denies: a directory of its own, neither the
        // stand-in's nor the tree it writes.
        const repo = realpathSync(mkdtempSync(join(tmpdir(), "zz-pgroup-repo-")));
        const ctx = sandbox.sandboxContext(tool, repo, fake);
        rmSync(repo, { recursive: true });
        const said: string = sandbox.execSandboxed(ctx, { writable: [home.root, cwd] }, fake, [],
          { cwd, env: home.env, timeout: 30_000 });
        assert.equal(said, "done\n");
        const left = bgPid();
        leftovers.push(left);
        assert.equal(await goneWithin(left, 3000), true, "a background child left by the build is gone once execSandboxed returns");
      } finally {
        sandbox.removeBuildHome(home);
      }
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
} finally {
  for (const pid of leftovers) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  rmSync(scratch, { recursive: true, force: true });
}

console.log("ok candidate-process-group");
