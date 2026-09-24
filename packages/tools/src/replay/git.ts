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
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  gitApplyArgv, gitRevParseArgv, gitUpdateRefArgv, gitUpdateRefDeleteArgv, gitWorktreeAddArgv,
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

/** Fix 6: the gate's "every route this gateway serves has a caller" check (and the hygiene
 *  check beside it) resolves the console's sibling checkout as `join(<repo root the gate is
 *  running from>, "..", "zz-stack-dashboard")` — and `root` there is wherever `scripts/gate/
 *  read.ts` itself sits, which inside a worktree is the worktree's own top, not the real
 *  checkout's. A worktree created at a fresh `mkdtempSync` path every time has no sibling at
 *  all, so the gate run this launcher's own replay session may end up running (through the
 *  candidate's own build+gate, or a subject's) fails that check for a reason that has nothing to
 *  do with the patch under test.
 *
 *  Every worktree this file creates lives under the SAME parent (`tmpdir()/zz-replay`), so one
 *  symlink there — `tmpdir()/zz-replay/zz-stack-dashboard`, pointing at the real sibling beside
 *  `repoRoot` — makes `../zz-stack-dashboard` resolve correctly from every worktree under it,
 *  present or future. Created once, idempotently, and only when the real dashboard checkout
 *  exists beside `repoRoot`; a deployment with no sibling console checkout is left exactly as
 *  the gate already reports it (a named, non-fatal-here condition), never faked into existing. */
function ensureDashboardSibling(repoRoot: string, parentDir: string): void {
  const real = resolve(repoRoot, "..", "zz-stack-dashboard");
  if (!existsSync(real)) return;
  const link = join(parentDir, "zz-stack-dashboard");
  try {
    const stat = lstatSync(link);
    if (stat.isSymbolicLink() && readlinkSync(link) === real) return;
    unlinkSync(link); // stale — a previous run's dashboard moved or this is some other file
  } catch {
    // ENOENT: nothing there yet, which is the ordinary case — fall through to create it.
  }
  symlinkSync(real, link);
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
  const parent = join(tmpdir(), "zz-replay");
  mkdirSync(parent, { recursive: true });
  ensureDashboardSibling(repoRoot, parent);
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

/** I-18: applies a recorded candidate's own unified diff into an already-created worktree,
 *  before `installPlugin` reads anything out of it — the launcher's own lift of the
 *  candidate-replay refusal: "a recorded candidate's patch must be applied into the replay
 *  worktree before the session starts." The diff text never reaches `execFileSync`'s argv as a
 *  string; it is written to a private temporary file first and only that file's PATH is passed,
 *  so nothing in the diff's own content can be misread as a second argument. The temporary
 *  directory is removed whether `git apply` succeeds or throws — a failed apply must not leave
 *  a stray patch file behind for the next run's `mkdtempSync` to trip over.
 *
 *  `patch_digest` (`complexity.ts`'s `patchDigest`) is sha256 of `candidate_record`'s own
 *  `patchset.diff` exactly as recorded — this function never touches that string, so any
 *  trailing-newline normalisation happens only in the COPY written to `patchPath`, never in what
 *  was digested or stored. `git apply` reads the diff text file-format-strict and refuses a
 *  patch whose last hunk line has no trailing newline as "corrupt" (a bare `.join("\n")` never
 *  produces one), so one is added to the written copy when missing. */
export function applyPatch(worktreePath: string, diff: string): void {
  const dir = mkdtempSync(join(tmpdir(), "zz-replay-patch-"));
  const patchPath = join(dir, "candidate.patch");
  writeFileSync(patchPath, diff.endsWith("\n") ? diff : `${diff}\n`, "utf8");
  try {
    git(worktreePath, gitApplyArgv(patchPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every worktree `repoRoot` currently has registered, one path per line — the live
 *  concurrency proof (two launches sharing no worktree) reads this rather than trusting each
 *  run's own bookkeeping. */
export function listWorktrees(repoRoot: string): string[] {
  return git(repoRoot, gitWorktreeListArgv())
    .split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length));
}
