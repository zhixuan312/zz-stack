/**
 * The launcher's clone lifecycle (Task I-17): one standalone clone per run, detached at the
 * subject's own release tag. `git clone --no-hardlinks` and `remote remove origin` leave the
 * clone with its own object store and no pointer back at `opts.repoRoot` — nothing here ever runs
 * a command that writes to `repoRoot`'s `.git` (no `worktree add`, no `update-ref`), so neither the
 * launcher nor the `bypassPermissions` session running inside the clone can touch the operator's
 * real repository. See `plan.ts`'s git section for why a worktree was not good enough.
 *
 * DELIBERATE: no `zz-stack-dashboard` symlink beside the clone any more. One used to point at the
 * operator's real console checkout so a gate run inside the replay could find its sibling — which
 * handed a `bypassPermissions` session a writable path into a second real repository. A gate run
 * inside a replay now reports the missing sibling the way it does on any host without one.
 *
 * Every git call goes through `execFileSync` with an argv array from `plan.ts` — no shell, so a
 * team slug or a path can never be reinterpreted as a second argument.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  GIT_EXEC_TIMEOUT_MS, gitApplyArgv, gitCheckoutDetachArgv, gitCloneArgv, gitRemoveOriginArgv,
  gitResolveTagArgv, releaseRefFor, releaseTagFor, worktreeDirName,
} from "./plan.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: GIT_EXEC_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export interface Worktree {
  /** `refs/tags/v<declared_version>` — the ref the clone was checked out from, and what
   *  `replay_start` recorded as the run's `sandbox_ref`/`worktree_ref`. */
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
  // Real path: the OS sandbox (sandbox.ts) matches `/private/var/...`, not the `/var` symlink.
  return join(realpathSync(tmpdir()), "zz-replay", worktreeDirName(teamSlug));
}

/** Clones `repoRoot` into this run's directory and detaches it at `v<declaredVersion>` — the
 *  "install at an exact digest" half of the contract. Whatever the operator's checkout does
 *  after this call, the clone keeps the release commit for the whole life of the run. A missing
 *  tag throws: a subject whose release was never tagged in `repoRoot` cannot be replayed from it,
 *  and falling back to `HEAD` would measure whatever the operator happens to have checked out.
 *  A crashed earlier attempt for the same team slug is removed first, so a retry never collides
 *  with its own predecessor. */
export function createWorktree(repoRoot: string, teamSlug: string, declaredVersion: string): Worktree {
  const path = worktreePathFor(teamSlug);
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  // Only the parent: `git clone` creates the target directory itself.
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });
  git(parent, gitCloneArgv(resolve(repoRoot), path));
  try {
    git(path, gitRemoveOriginArgv());
    const tag = releaseTagFor(declaredVersion);
    let commit: string;
    try {
      commit = git(path, gitResolveTagArgv(tag));
    } catch {
      throw new Error(`launchReplay: ${repoRoot} has no release tag ${tag} — the subject's own ` +
        "release cannot be checked out, and no other commit is an acceptable stand-in for it");
    }
    git(path, gitCheckoutDetachArgv(commit));
    return { ref: releaseRefFor(declaredVersion), path, commit };
  } catch (err) {
    rmSync(path, { recursive: true, force: true });
    throw err;
  }
}

/** The clone's own `plugins.lock.json`, parsed — what `releaseLockMismatch` (plan.ts) compares
 *  against the subject's captured digest. */
export function readReleaseLock(worktreePath: string): unknown {
  return JSON.parse(readFileSync(join(worktreePath, "plugins.lock.json"), "utf8"));
}

/** Removes the clone. Always called from a `finally`; safe to call twice. */
export function removeWorktree(worktree: Worktree): void {
  if (existsSync(worktree.path)) rmSync(worktree.path, { recursive: true, force: true });
}

/** I-18: applies a recorded candidate's own unified diff into an already-created clone,
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
