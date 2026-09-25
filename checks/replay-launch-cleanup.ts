#!/usr/bin/env node
// Round-6 review: the launcher's cleanup runs every removal even when one throws, and a leftover
// directory never turns a completed run into a failed one — the run is already closed and scored,
// so it stays completed with a cleanup_warning; a failed run stays failed with the leftovers
// appended to the log it keeps. Driven through settleCleanup, the function launchReplay's own
// `finally` hands its removals to.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { settleCleanup } = await import(pathToFileURL(join(process.cwd(), "packages/tools/dist/replay/launch.js")).href);

const dir = mkdtempSync(join(tmpdir(), "zz-cleanup-check-"));
const logPath = join(dir, "logs", "run.jsonl");
const quiet = console.error;
try {
  console.error = () => {};
  const ran: string[] = [];
  const removals = (failing: string | null) => ["worktree", "candidate home", "person home"].map((what) =>
    [what, () => { ran.push(what); if (what === failing) throw new Error("EBUSY"); }] as const);

  const clean = { status: "completed", logPath: null, verifier: "scored" };
  assert.equal(settleCleanup(clean, logPath, removals(null)), clean, "nothing left over: the answer is unchanged");
  assert.deepEqual(ran, ["worktree", "candidate home", "person home"]);

  ran.length = 0;
  const completed = settleCleanup(clean, logPath, removals("worktree"));
  assert.deepEqual(ran, ["worktree", "candidate home", "person home"], "a failed removal does not skip the ones after it");
  assert.equal(completed.status, "completed", "a completed run stays completed");
  assert.equal(completed.logPath, null);
  assert.equal(completed.verifier, "scored");
  assert.match(completed.cleanup_warning, /^cleanup failed: worktree: EBUSY$/);
  assert.equal(existsSync(logPath), false, "a completed run's log is not recreated to hold the warning");

  const failed = settleCleanup({ status: "failed", logPath }, logPath, removals("person home"));
  assert.equal(failed.status, "failed");
  assert.equal(failed.logPath, logPath);
  assert.match(failed.cleanup_warning, /person home: EBUSY/);
  assert.match(readFileSync(logPath, "utf8"), /^# cleanup failed: person home: EBUSY$/m, "a failed run's log names the leftover");
} finally {
  console.error = quiet;
  rmSync(dir, { recursive: true, force: true });
}
console.log("replay-launch-cleanup: every removal runs, and a leftover never fails a completed run");
