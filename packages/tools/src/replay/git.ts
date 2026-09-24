/**
 * The launcher's worktree lifecycle (Task I-17): one detached worktree per run, pinned to a
 * resolved commit under `refs/replay/<team_slug>` — never a branch, never the caller's own
 * checkout. `git worktree add`/`remove` and `update-ref` only; nothing here ever runs
 * `checkout`, `stash` or `reset` against `opts.repoRoot` itself, so the user's real checkout is
 * never touched (worker_rules.md's own line: "never touch the user's main checkout's branches").
 *
 * Every git call goes through `execFileSync` with an argv array from `plan.ts` — no shell, so a
 * team slug or a path can never be reinterpreted as a second argument.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  gitRevParseArgv, gitUpdateRefArgv, gitUpdateRefDeleteArgv, gitWorktreeAddArgv,
  gitWorktreeListArgv, gitWorktreeRemoveArgv, replayRefFor, worktreeDirName,
} from "./plan.js";

const EXEC_TIMEOUT_MS = 60_000;

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", timeout: EXEC_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Best-effort; a command that fails because there was nothing to undo is not this function's
 *  problem — it is called speculatively, both up front (clearing a crashed run's leftovers) and
 *  in the `finally` that closes a run out. */
function gitQuiet(repoRoot: string, args: string[]): void {
  try { execFileSync("git", args, { cwd: repoRoot, timeout: EXEC_TIMEOUT_MS, stdio: "ignore" }); }
  catch { /* nothing there to remove, or already gone — both are the success case here */ }
}

export interface Worktree {
  readonly ref: string;
  readonly path: string;
  readonly commit: string;
}

/** Deterministic from `teamSlug` alone — never a random suffix. `team_slug` is already unique
 *  per run (`provisionReplayTeam` derives it from `sha256(runId)`), so this needs no randomness
 *  of its own to stay unique across concurrent runs, and a deterministic path is exactly what
 *  lets a retry find and remove what a crashed earlier attempt for the SAME run left behind —
 *  a random suffix minted fresh on every call could never be rediscovered by a later one. */
function worktreePathFor(teamSlug: string): string {
  return join(tmpdir(), "zz-replay", worktreeDirName(teamSlug));
}

/** Removes whatever a crashed earlier launch for this same team slug left behind — the ref, the
 *  worktree directory registration, and the directory itself — so a retry never collides with
 *  its own predecessor. Called before anything else touches this run's worktree. */
function clearStaleWorktree(repoRoot: string, teamSlug: string): void {
  const path = worktreePathFor(teamSlug);
  gitQuiet(repoRoot, gitWorktreeRemoveArgv(path));
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  gitQuiet(repoRoot, gitUpdateRefDeleteArgv(replayRefFor(teamSlug)));
}

/** Resolves `ref` (default `HEAD`) to a commit, points `refs/replay/<team_slug>` at it, and adds
 *  a detached worktree there — the "install at an exact digest" half of the contract: whatever
 *  the caller's own checkout does after this call, the worktree keeps the commit it was pinned
 *  to for the whole life of the run. */
export function createWorktree(repoRoot: string, teamSlug: string, ref = "HEAD"): Worktree {
  clearStaleWorktree(repoRoot, teamSlug);
  const commit = git(repoRoot, gitRevParseArgv(ref));
  const replayRef = replayRefFor(teamSlug);
  git(repoRoot, gitUpdateRefArgv(replayRef, commit));
  const path = worktreePathFor(teamSlug);
  // Only the parent: `git worktree add` refuses a target directory that already exists, and
  // creates it itself.
  mkdirSync(join(tmpdir(), "zz-replay"), { recursive: true });
  try {
    git(repoRoot, gitWorktreeAddArgv(path, replayRef));
  } catch (err) {
    gitQuiet(repoRoot, gitUpdateRefDeleteArgv(replayRef));
    throw err;
  }
  return { ref: replayRef, path, commit };
}

/** Removes the worktree and its ref, in that order — a worktree still registered against a
 *  deleted ref is the state `git worktree list` would otherwise show as broken. Always called
 *  from a `finally`; safe to call twice. */
export function removeWorktree(repoRoot: string, worktree: Worktree): void {
  gitQuiet(repoRoot, gitWorktreeRemoveArgv(worktree.path));
  if (existsSync(worktree.path)) rmSync(worktree.path, { recursive: true, force: true });
  gitQuiet(repoRoot, gitUpdateRefDeleteArgv(worktree.ref));
}

/** Every worktree `repoRoot` currently has registered, one path per line — the live
 *  concurrency proof (two launches sharing no worktree) reads this rather than trusting each
 *  run's own bookkeeping. */
export function listWorktrees(repoRoot: string): string[] {
  return git(repoRoot, gitWorktreeListArgv())
    .split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length));
}
