/**
 * The launcher's clone lifecycle (Task I-17): one standalone repository per run, its tree
 * detached at the subject's own release tag. `git clone --bare --no-hardlinks` and `remote remove
 * origin` leave it with its own object store and no pointer back at `opts.repoRoot` — nothing here
 * ever runs a command that writes to `repoRoot`'s `.git` (no `worktree add`, no `update-ref`), so
 * neither the launcher nor the `bypassPermissions` session running inside the tree can touch the
 * operator's real repository. See `plan.ts`'s git section for why a worktree was not good enough.
 *
 * DELIBERATE: the repository lives BESIDE the tree (`<tree>.git`), never inside it, and every
 * launcher git call names both (`--git-dir`, `--work-tree`). The tree holds bytes somebody else
 * chose — a fetched package, a candidate session's writes — and a `.git/config` among them would
 * be read as git configuration by any git that found it by discovery: a filter driver there runs
 * as the operator on the next `git add` or `git status`. Given an explicit `--git-dir`, git never
 * looks for one, and the only configuration it reads is the launcher's own. The one `.git` the
 * tree does carry is a launcher-written gitfile (`exposeGitDir`), for the SESSION's git: it points
 * at the repository, which the sandbox lets the candidate read but not write (session.ts).
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  GIT_EXEC_TIMEOUT_MS, GIT_HARDENED_ARGS, gitApplyArgv, gitCheckoutDetachArgv, gitCloneArgv, gitRemoveOriginArgv,
  gitResolveTagArgv, gitStatusArgv, hardenedGitEnv, releaseRefFor, releaseTagFor, worktreeDirName,
} from "./plan.js";

export interface Worktree {
  /** `refs/tags/v<declared_version>` for a catalog subject, the captured identity for a third
   *  party — what `replay_start` recorded as the run's `sandbox_ref`/`worktree_ref`. */
  readonly ref: string;
  /** The tree the session works in. */
  readonly path: string;
  /** The launcher's repository for that tree, outside it. */
  readonly gitDir: string;
  readonly commit: string;
}

type Repo = Pick<Worktree, "path" | "gitDir">;

/** The one way this launcher runs git: hardened flags, then the repository named explicitly,
 *  then the subcommand, under an allowlisted environment (`GIT_HARDENED_ARGS`, `hardenedGitEnv`,
 *  plan.ts). Nothing in the tree is read as configuration and no token of the launcher's reaches
 *  a git process. `repo` null is a command that makes the repository (`clone`, `init`). */
function gitRaw(repo: Repo | null, cwd: string, args: string[]): string {
  const at = repo ? [`--git-dir=${repo.gitDir}`, `--work-tree=${repo.path}`] : [];
  return execFileSync("git", [...GIT_HARDENED_ARGS, ...at, ...args], {
    cwd, env: hardenedGitEnv(process.env), encoding: "utf8", timeout: GIT_EXEC_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"],
  });
}
/** git in `repo`, trimmed — `third-party.ts`'s fetch and snapshot use it too. */
export const gitIn = (repo: Repo, args: string[]): string => gitRaw(repo, repo.path, args).trim();

/** A fresh, empty launcher repository at `repo.gitDir`, for `repo.path`. Bare to create (so
 *  nothing is written into the tree), then `core.bare=false` so the session's git, arriving
 *  through the gitfile, sees an ordinary repository with a working tree. */
export function initGitDir(repo: Repo): void {
  gitRaw(null, dirname(repo.gitDir), ["init", "-q", "--bare", repo.gitDir]);
  gitIn(repo, ["config", "core.bare", "false"]);
}

/** The gitfile the SESSION's git finds the repository through. Written last, once every check
 *  of the tree's content has passed; the launcher's own git never reads it. */
export function exposeGitDir(repo: Repo): void {
  writeFileSync(join(repo.path, ".git"), `gitdir: ${repo.gitDir}\n`);
}

/** The paths `git status` reports changed or new in the tree — what the session produced. A
 *  rename's second NUL field (its old path) is skipped. Runs after the session, so every
 *  hardening in `gitRaw` is what makes reading the candidate's own tree safe. */
export function changedPaths(repo: Repo): string[] {
  const fields = gitRaw(repo, repo.path, gitStatusArgv()).split("\0");
  const out: string[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const f = fields[i];
    if (f.length < 4) continue;
    out.push(f.slice(3));
    if (f[0] === "R" || f[0] === "C") i += 1;
  }
  return out;
}

/** The files git tracks under `dir`, relative to it — `ls-files` in the operator's own checkout,
 *  under the same hardened flags and environment as every other launcher git call. */
export const trackedFiles = (dir: string): string[] =>
  gitRaw(null, dir, ["ls-files", "-z", "--", "."]).split("\0").filter(Boolean);

/** The files under `dir` git does not track, ignored ones included — what a copy of the tracked
 *  set leaves out, named when a digest disagrees. */
export const untrackedFiles = (dir: string): string[] =>
  gitRaw(null, dir, ["ls-files", "-z", "--others", "--", "."]).split("\0").filter(Boolean);

/** Deterministic from `teamSlug` alone — never a random suffix. `team_slug` is already unique
 *  per run (`provisionReplayTeam` derives it from `sha256(runId)`), so this needs no randomness
 *  of its own to stay unique across concurrent runs, and a deterministic path is exactly what
 *  lets a retry find and remove what a crashed earlier attempt for the SAME run left behind —
 *  a random suffix minted fresh on every call could never be rediscovered by a later one. */
export function worktreePathFor(teamSlug: string): string {
  // Real path: the OS sandbox (sandbox.ts) matches `/private/var/...`, not the `/var` symlink.
  return join(realpathSync(tmpdir()), "zz-replay", worktreeDirName(teamSlug));
}

/** The run's repository, beside its tree — under the system temporary directory the sandbox
 *  denies, and never bound back writable, so no session can change what the launcher's git reads. */
const gitDirFor = (teamSlug: string): string => `${worktreePathFor(teamSlug)}.git`;

/** Where a held tree sits: beside its own path, under the system temporary directory the sandbox
 *  denies, and inside no session's writable path — Seatbelt's `subpath` is by whole components,
 *  so `<tree>` never covers `<tree>.held`. */
const HELD = ".held";

/** The run's two paths, with whatever a crashed earlier attempt left at them removed and the
 *  tree's directory created empty. */
export function freshRepo(teamSlug: string): Repo {
  const repo = { path: worktreePathFor(teamSlug), gitDir: gitDirFor(teamSlug) };
  for (const p of [repo.path, `${repo.path}${HELD}`, repo.gitDir]) if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  mkdirSync(repo.path, { recursive: true });
  return repo;
}

/** The tree, moved to where no session can write, before anything outside a sandbox reads it or
 *  deletes it. A command the candidate ran through its Bash tool can outlive the turn: the real
 *  `claude` starts that shell in a session of its own (`setsid`), outside the process group
 *  `runGrouped` (session.ts) kills, and Seatbelt kills nothing. Left running, it could swap a
 *  directory for a symlink between `collectProduced`'s check and its read, or under `rmSync`'s
 *  walk. Seatbelt judges every write by the path the file has at that moment, so once the tree is
 *  renamed out of the sandbox's writable path, nothing the session left can create, rename,
 *  unlink or link anything in it — a directory it holds open included. Proven live by
 *  `checks/replay-hold-tree.ts`. What stays possible: `write()` on a file it opened before the
 *  rename, which changes bytes of a file it wrote anyway and reaches no path.
 *
 *  Under bwrap nothing is left to race: the session's PID namespace dies with its turn
 *  (sandbox.ts). The tree is held there too — one path for both sandboxes. Never moved back: the
 *  launcher reads the tree only after the last turn. Idempotent. */
export function holdWorktree<T extends Repo>(repo: T): T {
  if (repo.path.endsWith(HELD)) return repo;
  const held = `${repo.path}${HELD}`;
  if (existsSync(held)) rmSync(held, { recursive: true, force: true });
  renameSync(repo.path, held);
  return { ...repo, path: held };
}

/** Clones `repoRoot` into this run's repository and checks its tree out at `v<declaredVersion>` — the
 *  "install at an exact digest" half of the contract. Whatever the operator's checkout does
 *  after this call, the clone keeps the release commit for the whole life of the run. A missing
 *  tag throws: a subject whose release was never tagged in `repoRoot` cannot be replayed from it,
 *  and falling back to `HEAD` would measure whatever the operator happens to have checked out.
 *  A crashed earlier attempt for the same team slug is removed first, so a retry never collides
 *  with its own predecessor. */
export function createWorktree(repoRoot: string, teamSlug: string, declaredVersion: string): Worktree {
  const repo = freshRepo(teamSlug);
  try {
    gitRaw(null, dirname(repo.gitDir), gitCloneArgv(resolve(repoRoot), repo.gitDir));
    gitIn(repo, ["config", "core.bare", "false"]);
    gitIn(repo, gitRemoveOriginArgv());
    const tag = releaseTagFor(declaredVersion);
    let commit: string;
    try {
      commit = gitIn(repo, gitResolveTagArgv(tag));
    } catch {
      throw new Error(`launchReplay: ${repoRoot} has no release tag ${tag} — the subject's own ` +
        "release cannot be checked out, and no other commit is an acceptable stand-in for it");
    }
    gitIn(repo, gitCheckoutDetachArgv(commit));
    exposeGitDir(repo);
    return { ref: releaseRefFor(declaredVersion), ...repo, commit };
  } catch (err) {
    removeWorktree(repo);
    throw err;
  }
}

/** The clone's own `plugins.lock.json`, parsed — what `releaseLockMismatch` (plan.ts) compares
 *  against the subject's captured digest. */
export function readReleaseLock(worktreePath: string): unknown {
  return JSON.parse(readFileSync(join(worktreePath, "plugins.lock.json"), "utf8"));
}

/** Removes the tree and its repository, the tree held first (`holdWorktree`) so no process a
 *  session left can move anything under the walk. Always called from a `finally`; safe to call
 *  twice. */
export function removeWorktree(repo: Repo): void {
  const tree = existsSync(repo.path) ? holdWorktree(repo).path : repo.path;
  for (const p of [tree, repo.gitDir]) if (existsSync(p)) rmSync(p, { recursive: true, force: true });
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
export function applyPatch(repo: Repo, diff: string): void {
  const dir = mkdtempSync(join(tmpdir(), "zz-replay-patch-"));
  const patchPath = join(dir, "candidate.patch");
  writeFileSync(patchPath, diff.endsWith("\n") ? diff : `${diff}\n`, "utf8");
  try {
    gitIn(repo, gitApplyArgv(patchPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
