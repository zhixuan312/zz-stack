/**
 * The candidate build's clone lifecycle: one standalone repository per build, its tree detached
 * at the base subject's own release tag. `git clone --bare --no-hardlinks` and `remote remove
 * origin` leave it with its own object store and no pointer back at `--repo` — nothing here ever
 * runs a command that writes to `--repo`'s `.git` (no `worktree add`, no `update-ref`), so neither
 * this CLI nor the candidate's build and gate, running inside the tree, can touch the operator's
 * real repository.
 *
 * DELIBERATE: a clone, never `git worktree add`. A worktree shares the operator's real `.git` (its
 * objects, its refs, its hooks and config), and the build runs the candidate's own code inside it
 * — `git -C .. update-ref`, a rewritten hook, or a ref deleted from the worktree would land in the
 * operator's own repository.
 *
 * DELIBERATE: the repository lives BESIDE the tree (`<tree>.git`), never inside it, and every git
 * call here names both (`--git-dir`, `--work-tree`). The tree holds bytes somebody else chose — a
 * fetched package, whatever the build wrote — and a `.git/config` among them would be read as git
 * configuration by any git that found it by discovery: a filter driver there runs as the operator
 * on the next `git add` or `git status`. Given an explicit `--git-dir`, git never looks for one,
 * and the only configuration it reads is this CLI's own. The one `.git` the tree does carry is a
 * gitfile this CLI writes (`exposeGitDir`), for the gate's own git: it points at the repository,
 * which the sandbox lets the build read but not write (sandbox.ts).
 *
 * Every git call goes through `execFileSync` with an argv array — no shell, so a path can never be
 * reinterpreted as a second argument.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** One git subprocess's own timeout — clone, checkout, apply, status. */
export const GIT_EXEC_TIMEOUT_MS = 60_000;

/** Ahead of every git subcommand this CLI runs (`gitRaw`), and ahead of the `--git-dir`/
 *  `--work-tree` pair that points it at the build's own repository, outside the tree. The tree is
 *  the candidate's to write, and a fetched source is somebody else's bytes, so nothing in it is
 *  ever read as git configuration: a command-line `-c` outranks every config file, so neither an
 *  fsmonitor command, a hooks directory nor a global attributes file can come from anywhere else. */
export const GIT_HARDENED_ARGS = [
  "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.attributesFile=/dev/null",
] as const;

/** git's own name for the empty tree (sha1). `GIT_ATTR_SOURCE` set to it makes git 2.40+ read
 *  `.gitattributes` from that tree, never the working tree's: an in-tree `* filter=x` names no
 *  filter, `eol`/`ident` rewrite nothing, and a checkout writes each file's bytes as committed.
 *  COUPLED: `plugin_register`'s git reader (services/zz-core/src/eval/subject-source.ts) sets the
 *  same, so its recorded `tree_digest` is over the bytes this checkout writes. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** The proxy and CA settings a fetch may need to leave the host — git's (`GIT_SSL_CAINFO`,
 *  OpenSSL's `SSL_CERT_*`) and npm's (it honours the proxy variables, and takes an extra CA from
 *  `NODE_EXTRA_CA_CERTS`, never `SSL_CERT_FILE`). One list, so this CLI's git and its `npm pack`
 *  (third-party.ts) reach the network the same way. Nothing here can hold a credential of the
 *  operator's or name a command. */
const NETWORK_ENV_ALLOW = [
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
  "GIT_SSL_CAINFO", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
] as const;

/** `source`'s values for `NETWORK_ENV_ALLOW`, the ones present. */
export function networkEnv(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of NETWORK_ENV_ALLOW) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Copied into a git process when present, beside `networkEnv`: the process basics. */
const GIT_ENV_ALLOW = ["PATH", "LANG", "LC_ALL", "SystemRoot"] as const;

/** The whole environment a git process here runs with — never this CLI's own, which can hold
 *  `ZZ_TOKEN`. No system or global config and no system attributes (a filter driver or
 *  `include.path` there would be one more command git runs), in-tree attributes read from the
 *  empty tree (`EMPTY_TREE`), no prompt, and no optional index write from `status`.
 *
 *  DELIBERATE: two layers against a filter driver, because only the first holds on every git.
 *  The configuration git reads is the build's own repository and these variables, and none of
 *  them defines a `filter.<name>.*` — so an in-tree attribute naming one resolves to nothing. On
 *  git 2.40+, `GIT_ATTR_SOURCE` also stops the attribute being read at all; an older git ignores
 *  the variable, and the first layer is what stands. */
export function hardenedGitEnv(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env = networkEnv(source);
  for (const key of GIT_ENV_ALLOW) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_ATTR_SOURCE: EMPTY_TREE,
    GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0",
  };
}

/** The git tag a catalog subject's release lives at. A catalog plugin's `declared_version` IS
 *  the platform's release version (`register-plugins.ts`), and `/release` tags that release
 *  `v<version>` — so this is the one ref that holds exactly the bytes the subject was captured
 *  from, never the operator's `HEAD` or a ref somebody typed. */
export function releaseTagFor(declaredVersion: string): string {
  return `v${declaredVersion}`;
}

interface LockEntryLike { readonly version?: unknown; readonly digest?: unknown }

/** The component-digest comparison between what the clone holds and what the subject was
 *  captured as. `plugins.lock.json`'s own `digest` for a plugin is the packager's hash of
 *  everything that plugin ships, and `register-plugins.ts` copied that same value into
 *  `zz.plugin_version.digest` at release — which `plugin_locate` then froze into the subject's
 *  `release_identity.released_digest`. Equal means the tag holds the subject's bytes; anything
 *  else means the build would judge a patch against a different plugin than its base. Null when
 *  they agree; otherwise the refusal text. */
export function releaseLockMismatch(
  lock: unknown, plugin: string, declaredVersion: string, releasedDigest: string,
): string | null {
  const entry = (lock && typeof lock === "object" ? (lock as Record<string, unknown>)[plugin] : undefined) as
    LockEntryLike | undefined;
  if (!entry) return `plugins.lock.json at ${releaseTagFor(declaredVersion)} records no plugin '${plugin}'`;
  if (entry.version !== declaredVersion) {
    return `plugins.lock.json at ${releaseTagFor(declaredVersion)} declares '${plugin}' version ` +
      `${String(entry.version)}, not the subject's ${declaredVersion}`;
  }
  if (entry.digest !== releasedDigest) {
    return `'${plugin}' at ${releaseTagFor(declaredVersion)} has content digest ${String(entry.digest)}, ` +
      `but the subject was captured at ${releasedDigest} — refusing to build against a different plugin`;
  }
  return null;
}

// -------------------------------------------------------------------------------------------
// The clone lifecycle.

export interface Worktree {
  /** `refs/tags/v<declared_version>` for a catalog subject, the captured identity for a third
   *  party (third-party.ts). */
  readonly ref: string;
  /** The tree the build works in. */
  readonly path: string;
  /** The build's repository for that tree, outside it. */
  readonly gitDir: string;
  readonly commit: string;
}

type Repo = Pick<Worktree, "path" | "gitDir">;

/** The one way this CLI runs git: hardened flags, then the repository named explicitly, then the
 *  subcommand, under an allowlisted environment (`GIT_HARDENED_ARGS`, `hardenedGitEnv`). Nothing
 *  in the tree is read as configuration and no token of this process reaches a git process.
 *  `repo` null is a command that makes the repository (`clone`, `init`) or reads a checkout. */
function gitRaw(repo: Repo | null, cwd: string, args: string[], env = hardenedGitEnv(process.env)): string {
  const at = repo ? [`--git-dir=${repo.gitDir}`, `--work-tree=${repo.path}`] : [];
  return execFileSync("git", [...GIT_HARDENED_ARGS, ...at, ...args], {
    cwd, env, encoding: "utf8", timeout: GIT_EXEC_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"],
  });
}
/** git in `repo`, trimmed — `third-party.ts`'s fetch and snapshot and build.ts's commit use it too. */
export const gitIn = (repo: Repo, args: string[]): string => gitRaw(repo, repo.path, args).trim();

/** A fresh, empty repository at `repo.gitDir`, for `repo.path`. Bare to create (so nothing is
 *  written into the tree), then `core.bare=false` so the gate's git, arriving through the
 *  gitfile, sees an ordinary repository with a working tree. */
export function initGitDir(repo: Repo): void {
  gitRaw(null, dirname(repo.gitDir), ["init", "-q", "--bare", repo.gitDir]);
  gitIn(repo, ["config", "core.bare", "false"]);
}

/** The gitfile the build's own git finds the repository through. Written last, once every check
 *  of the tree's content has passed; this CLI's own git never reads it. */
export function exposeGitDir(repo: Repo): void {
  writeFileSync(join(repo.path, ".git"), `gitdir: ${repo.gitDir}\n`);
}

/** The files git tracks under `dir`, relative to it — `ls-files` in the operator's own checkout,
 *  under the same hardened flags and environment as every other git call here. */
export const trackedFiles = (dir: string): string[] =>
  gitRaw(null, dir, ["ls-files", "-z", "--", "."]).split("\0").filter(Boolean);

/** The files under `dir` git does not track, ignored ones included — what a copy of the tracked
 *  set leaves out, named when a digest disagrees. */
export const untrackedFiles = (dir: string): string[] =>
  gitRaw(null, dir, ["ls-files", "-z", "--others", "--", "."]).split("\0").filter(Boolean);

/** Each build's own directory under the system temporary directory, deterministic in `slug` so a
 *  crashed earlier attempt is found and replaced. The tree's parent is this build's alone, so the
 *  console clone the gate reads beside it (`../zz-stack-dashboard`, tree.ts) is too. */
export function buildDirFor(slug: string): string {
  // Real path: the OS sandbox (sandbox.ts) matches `/private/var/...`, not the `/var` symlink.
  return join(realpathSync(tmpdir()), "zz-candidate-build", slug);
}

/** The tree one build works in. */
export const worktreePathFor = (slug: string): string => join(buildDirFor(slug), "tree");

/** Where a held tree sits: beside its own path, under the system temporary directory the sandbox
 *  denies, and inside no build's writable path — Seatbelt's `subpath` is by whole components, so
 *  `<tree>` never covers `<tree>.held`. */
const HELD = ".held";

/** The build's two paths, with whatever a crashed earlier attempt left at them removed and the
 *  tree's directory created empty. The repository sits beside the tree, under the system
 *  temporary directory the sandbox denies, and is never bound back writable. */
export function freshRepo(slug: string): Repo {
  const path = worktreePathFor(slug);
  const repo = { path, gitDir: `${path}.git` };
  for (const p of [repo.path, `${repo.path}${HELD}`, repo.gitDir]) if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  mkdirSync(repo.path, { recursive: true });
  return repo;
}

/** The tree, moved to where no build process can write, before anything outside a sandbox deletes
 *  it. A command the build or gate started in a session of its own (`setsid`) leaves the process
 *  group `runGrouped` (sandbox.ts) kills, and Seatbelt kills nothing. Left running, it could swap
 *  a directory for a symlink under `rmSync`'s walk. Seatbelt judges every write by the path the
 *  file has at that moment, so once the tree is renamed out of the sandbox's writable path,
 *  nothing left running can create, rename, unlink or link anything in it — a directory it holds
 *  open included. Proven live by `checks/candidate-hold-tree.ts`.
 *
 *  Under bwrap nothing is left to race: the build's PID namespace dies with its command
 *  (sandbox.ts). The tree is held there too — one path for both sandboxes. Idempotent. */
export function holdWorktree<T extends Repo>(repo: T): T {
  if (repo.path.endsWith(HELD)) return repo;
  const held = `${repo.path}${HELD}`;
  if (existsSync(held)) rmSync(held, { recursive: true, force: true });
  renameSync(repo.path, held);
  return { ...repo, path: held };
}

/** Clones `repoRoot` into this build's repository and checks its tree out at `v<declaredVersion>`.
 *  Whatever the operator's checkout does after this call, the clone keeps the release commit for
 *  the whole build. A missing tag throws: a subject whose release was never tagged in `repoRoot`
 *  cannot be built from it, and falling back to `HEAD` would judge whatever the operator happens to
 *  have checked out. A crashed earlier attempt for the same slug is removed first. */
export function createWorktree(repoRoot: string, slug: string, declaredVersion: string): Worktree {
  const repo = freshRepo(slug);
  try {
    // `--bare` into the build's own directory: the object store and config live there, and the
    // tree is checked out beside it, so the tree never holds a repository of its own.
    gitRaw(null, dirname(repo.gitDir), ["clone", "--bare", "--no-hardlinks", "--quiet", resolve(repoRoot), repo.gitDir]);
    gitIn(repo, ["config", "core.bare", "false"]);
    gitIn(repo, ["remote", "remove", "origin"]);
    const tag = releaseTagFor(declaredVersion);
    let commit: string;
    try {
      // `^{commit}` peels an annotated tag; `refs/tags/` keeps a same-named branch from answering.
      commit = gitIn(repo, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]);
    } catch {
      throw new Error(`candidate-build: ${repoRoot} has no release tag ${tag} — the subject's own ` +
        "release cannot be checked out, and no other commit is an acceptable stand-in for it");
    }
    gitIn(repo, ["checkout", "--detach", "--quiet", commit]);
    exposeGitDir(repo);
    return { ref: `refs/tags/${tag}`, ...repo, commit };
  } catch (err) {
    removeWorktree(repo);
    throw err;
  }
}

/** The clone's own `plugins.lock.json`, parsed — what `releaseLockMismatch` compares against the
 *  subject's captured digest. */
export function readReleaseLock(worktreePath: string): unknown {
  return JSON.parse(readFileSync(join(worktreePath, "plugins.lock.json"), "utf8"));
}

/** Removes the tree and its repository, the tree held first (`holdWorktree`) so no process the
 *  build left can move anything under the walk. Always called from a `finally`; safe to call
 *  twice. */
export function removeWorktree(repo: Repo): void {
  const tree = existsSync(repo.path) ? holdWorktree(repo).path : repo.path;
  for (const p of [tree, repo.gitDir]) if (existsSync(p)) rmSync(p, { recursive: true, force: true });
}

/** Applies a recorded candidate's own unified diff into an already-created clone, before anything
 *  installs from it. The diff text never reaches `execFileSync`'s argv as a string; it is written
 *  to a private temporary file first and only that file's PATH is passed, so nothing in the
 *  diff's own content can be misread as a second argument. The temporary directory is removed
 *  whether `git apply` succeeds or throws.
 *
 *  `patch_digest` is sha256 of `candidate_record`'s own `patchset.diff` exactly as recorded — this
 *  function never touches that string, so any trailing-newline normalisation happens only in the
 *  COPY written to the patch file. `git apply` refuses a patch whose last hunk line has no
 *  trailing newline as "corrupt", so one is added to the written copy when missing.
 *  `--whitespace=nowarn` because a candidate's diff may carry trailing-whitespace edits on
 *  purpose; the build judges the patched plugin, it does not lint the patch. */
export function applyPatch(repo: Repo, diff: string): void {
  const dir = mkdtempSync(join(tmpdir(), "zz-candidate-patch-"));
  const patchPath = join(dir, "candidate.patch");
  writeFileSync(patchPath, diff.endsWith("\n") ? diff : `${diff}\n`, "utf8");
  // DELIBERATE: `git apply` runs without `GIT_ATTR_SOURCE`. Probed on git 2.50.1 (Apple Git-155):
  // `git apply` with that variable set to any tree segfaults (SIGSEGV, no output), so every
  // candidate patch failed to apply. The first layer `hardenedGitEnv` names still stands — no
  // configuration git reads here defines a `filter.<name>.*`, so an in-tree attribute naming one
  // resolves to nothing; `eol`/`ident` attributes may now rewrite line endings of the patched files.
  const { GIT_ATTR_SOURCE: _attrSource, ...env } = hardenedGitEnv(process.env);
  try {
    gitRaw(repo, repo.path, ["apply", "--whitespace=nowarn", patchPath], env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
