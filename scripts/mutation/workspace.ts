/**
 * The disposable checkout every mutation is planted in, and the proof it came back clean.
 *
 * A copy, never this checkout: the gate's first check runs `npm run -s build`, so a faulted
 * `packages/contracts/src` would be compiled into `packages/contracts/dist`, which every other
 * worker on this machine imports. Nothing here writes to the checkout it was launched from.
 *
 * COUPLED: `scripts/gate/checks/console.ts` reads `join(root, "..", "zz-stack-dashboard")`, so
 * the copy needs that sibling linked beside it — without it the check reports every console
 * route as uncalled, which is a fact about the copy.
 *
 * The copy is committed, because the gate rebuilds `marketplace/` and asks git whether it
 * changed. That happens inside the copy only; git is never run against the source checkout.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

/** Everything outside the tree a mutation can reach: dependencies and git's own store. Both
 *  are identical in the copy and the snapshot, so excluding them makes the restore a quarter
 *  of a second instead of several. */
const OUTSIDE = new Set(["node_modules", ".git"]);

interface Workspace {
  /** The copy the gate is actually run in. */
  readonly repo: string;
  /** The byte-for-byte snapshot every mutation is restored from. */
  readonly pristine: string;
  /** Where gate reports are written — outside `repo`, which the gate insists on. */
  readonly reports: string;
  /** The digest of the snapshot, which every restore has to reproduce. */
  readonly digest: string;
}

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

/**
 * A sha256 over every file in `dir` except `node_modules` and `.git`, path and content both.
 * The same shape as the gate's `sourceTreeDigest`: a digest over content alone would not
 * notice a file that moved.
 */
export function treeDigest(dir: string): string {
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      if (OUTSIDE.has(e.name)) continue;
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(dir);
  const tree = createHash("sha256");
  for (const full of files.sort()) {
    const rel = full.slice(dir.length + 1);
    tree.update(`${rel}\0${createHash("sha256").update(readFileSync(full)).digest("hex")}\n`);
  }
  return tree.digest("hex");
}

/** Put `repo` back to exactly what `pristine` holds, and say what the tree hashes to now.
 *  `--delete` is what makes this a restore rather than an overlay: a mutation that added a
 *  file would otherwise survive its own experiment. */
export function restore(ws: Workspace): string {
  execFileSync("rsync", ["-a", "--delete", "--exclude", "node_modules/", "--exclude", ".git/",
    `${ws.pristine}/`, `${ws.repo}/`], { stdio: "pipe" });
  return treeDigest(ws.repo);
}

/** Every sibling of `source` that is a directory, linked beside the copy under its own name.
 *  Linked rather than copied: the checks that read a sibling only read it, and copying one is slow. */
function linkSiblings(source: string, into: string): void {
  const parent = dirname(source);
  // `statSync`, not the Dirent: a Dirent reports a symlink to a directory as a symlink rather
  // than a directory, so a checkout whose siblings are themselves links carries none of them
  // across.
  for (const e of readdirSync(parent)) {
    if (e === basename(source) || e.startsWith(".")) continue;
    const full = join(parent, e);
    try { if (!statSync(full).isDirectory()) continue; } catch { continue; }
    symlinkSync(full, join(into, e));
  }
}

/**
 * A path with every symlink on it followed, as far as the filesystem actually goes.
 *
 * `resolve` alone is lexical and never consults the disk, so a work directory reached through
 * a link into the checkout resolves to the link's own name and does not look like the
 * checkout — while the deletion follows the link. A work directory usually does not exist yet,
 * so this walks up to the nearest ancestor that does, resolves that, and puts the remaining
 * names back on.
 */
function throughLinks(p: string): string {
  const target = resolve(p);
  const tail: string[] = [];
  let cur = target;
  for (;;) {
    try {
      const real = realpathSync(cur);
      return tail.length ? join(real, ...tail) : real;
    } catch {
      const up = dirname(cur);
      if (up === cur) return target;          // nothing on this path exists at all
      tail.unshift(basename(cur));
      cur = up;
    }
  }
}

/**
 * Whether two paths overlap — the same place, or one inside the other.
 *
 * Both sides are resolved, and through links. Comparing the strings as given lets `--work .`
 * find no overlap against an absolute checkout path and delete the repository; resolving both
 * sides lexically still passes a symlink whose target is the checkout.
 *
 * Exported so it can be asked directly rather than tested by triggering it.
 */
export function overlaps(a: string, b: string): boolean {
  const x = throughLinks(a);
  const y = throughLinks(b);
  return x === y || x.startsWith(y + sep) || y.startsWith(x + sep);
}

/**
 * Build the workspace: copy, link the siblings, commit, snapshot.
 *
 * `cp -a` rather than a clone, because the checkout's uncommitted work is what is under test —
 * a check file written and not yet added is in `trackedFiles()` and so is in the set this run
 * has to cover.
 */
export function makeWorkspace(source: string, at: string, prepare?: (repo: string) => void): Workspace {
  // This function's first act is to delete `at`, so `at` is judged before that. A work
  // directory that overlaps the checkout takes the checkout with it, and every other session's
  // uncommitted work in it. Refused early and by exit code.
  if (overlaps(at, source)) {
    console.error(`  REFUSED — the work directory ${resolve(at)} overlaps the checkout ` +
      `${resolve(source)}. It is deleted and rebuilt on every run, so it must be somewhere ` +
      "else entirely — not the repository, not a parent of it, not a directory inside it.");
    process.exit(2);
  }
  // A second run is refused before the delete, not discovered after it. The work directory
  // defaults to one path, so two runs on one machine share it, and a second run started while
  // a first is walking its rows removes the pristine snapshot the first restores from — which
  // surfaces as an rsync failure inside `restore`.
  //
  // The lock names its owner and is stale only when that process is genuinely gone:
  // `kill(pid, 0)` throws ESRCH for a pid nobody holds, so a crashed run's lock is reclaimed
  // without a timeout that would be either too short for a long pass or too long to be useful.
  const lock = `${resolve(at)}.lock`;
  if (existsSync(lock)) {
    const held = Number(readFileSync(lock, "utf8").trim());
    let alive = false;
    try { process.kill(held, 0); alive = true; } catch { alive = false; }
    if (alive) {
      console.error(`  REFUSED — pid ${held} is already using ${resolve(at)}, and the first ` +
        "thing this function does is delete that directory. Wait for it, or pass a different " +
        "--work. Two runs over one work directory take each other's snapshot away mid-pass.");
      process.exit(2);
    }
    console.error(`  the lock at ${lock} names pid ${held}, which is gone — reclaiming it`);
  }
  rmSync(at, { recursive: true, force: true });
  mkdirSync(at, { recursive: true });
  writeFileSync(lock, `${process.pid}\n`);
  const parent = join(at, "parent");
  mkdirSync(parent);
  const repo = join(parent, basename(source));
  execFileSync("cp", ["-a", source, repo], { stdio: "pipe" });
  linkSiblings(source, parent);
  // Before the commit and before the snapshot, so whatever `prepare` writes is part of the
  // tree every mutation is restored to rather than something the first restore deletes.
  if (prepare) prepare(repo);

  git(repo, ["-c", "user.name=mutation", "-c", "user.email=mutation@local", "add", "-A"]);
  if (git(repo, ["status", "--porcelain"]).trim()) {
    git(repo, ["-c", "user.name=mutation", "-c", "user.email=mutation@local",
      "commit", "-q", "-m", "mutation snapshot"]);
  }

  const pristine = join(at, "pristine");
  mkdirSync(pristine);
  execFileSync("rsync", ["-a", "--delete", "--exclude", "node_modules/", "--exclude", ".git/",
    `${repo}/`, `${pristine}/`], { stdio: "pipe" });
  const reports = join(at, "reports");
  mkdirSync(reports);
  return { repo, pristine, reports, digest: treeDigest(pristine) };
}

/** What the checkout this was launched from looked like when it was copied, so a reader of
 *  the report can tell which tree the verdicts are about. */
export function provenanceOf(source: string): { commit: string; dirty_paths: number } {
  const commit = git(source, ["rev-parse", "HEAD"]).trim();
  const dirty = git(source, ["status", "--porcelain"]).split("\n").filter(Boolean).length;
  return { commit, dirty_paths: dirty };
}

/** The check files this run must cover, by the command the gate's own file listing uses.
 *  Never a list typed here: a roster goes stale by gaining a file,
 *  and then covers fewer checks than exist while reporting success. */
export function declaredChecks(repo: string): string[] {
  return git(repo, ["ls-files", "--cached", "--others", "--exclude-standard"])
    .split("\n")
    .filter((f) => f.startsWith("scripts/gate/checks/") && f.endsWith(".ts"))
    .sort();
}

export const DECLARED_BY = "git ls-files --cached --others --exclude-standard";

