/**
 * The disposable checkout every mutation is planted in, and the proof it came back clean.
 *
 * WHY A COPY AND NOT THIS CHECKOUT. A mutation here is a defect planted in real source, and
 * the gate's first check runs `npm run -s build` — so a faulted `packages/contracts/src`
 * would be compiled into `packages/contracts/dist`, which is what `@zz/contracts` resolves
 * to, which is what every other worker on this machine imports. One sibling did exactly that
 * earlier and rebuilt the shared package ten times on top of a faulted source. Nothing here
 * writes to the checkout it was launched from.
 *
 * WHY THE SIBLING SYMLINK. `scripts/gate/checks/console.ts` reads `join(root, "..",
 * "zz-stack-dashboard")` to find out who calls each gateway route. A copy without that
 * sibling beside it reports forty-three routes as uncalled, which is a fact about the copy
 * and not about the repository — the first baseline run found exactly that.
 *
 * WHY THE COPY IS COMMITTED. The gate rebuilds `marketplace/` and then asks git whether it
 * changed, so a working tree with uncommitted catalog edits fails a check whose own message
 * says "now commit it". Committing inside the copy makes the snapshot self-consistent; it
 * changes nothing in the checkout this was launched from, which is never touched by git here.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

/** Everything outside the tree a mutation can reach: dependencies and git's own store. Both
 *  are identical in the copy and the snapshot, so excluding them costs nothing and makes the
 *  restore a quarter of a second instead of several. */
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
 *
 * The same shape as the gate's own `sourceTreeDigest`, and for the same reason: a digest that
 * covered content alone would not notice a file that moved, and a restore that puts the bytes
 * back under the wrong name is not a restore.
 */
function treeDigest(dir: string): string {
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
 *  `--delete` is what makes this a restore rather than an overlay: a mutation that ADDED a
 *  file would otherwise survive its own experiment. */
export function restore(ws: Workspace): string {
  execFileSync("rsync", ["-a", "--delete", "--exclude", "node_modules/", "--exclude", ".git/",
    `${ws.pristine}/`, `${ws.repo}/`], { stdio: "pipe" });
  return treeDigest(ws.repo);
}

/** Every sibling of `source` that is a directory, linked beside the copy under its own name.
 *  Linked rather than copied: the checks that read a sibling only read it, and one of them is
 *  1.8GB. A copy without them answers a different question from the one the check asked. */
function linkSiblings(source: string, into: string): void {
  const parent = dirname(source);
  // `statSync`, not the Dirent: a Dirent reports a SYMLINK to a directory as a symlink and
  // not as a directory, so a checkout whose siblings are themselves links had none of them
  // carried across — and the check that reads one then reported forty-three routes as uncalled,
  // which is the copy artifact this function exists to prevent.
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
 * `resolve` alone is LEXICAL — it never consults the disk — so a work directory reached
 * through a link into the checkout resolved to the link's own name, did not look like the
 * checkout, and would have been deleted as if it were somewhere else. The deletion, of course,
 * follows the link. A work directory usually does not exist yet, which is why this walks up to
 * the nearest ancestor that does, resolves THAT, and puts the remaining names back on.
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
 * BOTH SIDES ARE RESOLVED, AND THROUGH LINKS, and each half was learned the hard way. An
 * earlier form compared the strings it was given, so `--work .` was compared against an
 * absolute checkout path, found no overlap, and the deletion below ran with the repository as
 * the working directory; the tree was removed. The form after that resolved both sides
 * lexically and still passed a symlink whose target was the checkout — found by asking it
 * about a table of paths rather than by letting it fail to stop one.
 *
 * Exported so it can go on being asked, rather than tested by triggering it.
 */
export function overlaps(a: string, b: string): boolean {
  const x = throughLinks(a);
  const y = throughLinks(b);
  return x === y || x.startsWith(y + sep) || y.startsWith(x + sep);
}

/**
 * Build the workspace: copy, link the siblings, commit, snapshot.
 *
 * `cp -a` rather than a clone, because the checkout's UNCOMMITTED work is the thing under
 * test — a check file the author has written and not yet added is in `trackedFiles()` and so
 * is in the set this run has to cover.
 */
export function makeWorkspace(source: string, at: string, prepare?: (repo: string) => void): Workspace {
  // THE FIRST THING THIS FUNCTION DOES IS DELETE `at`, SO `at` IS JUDGED BEFORE THAT. A work
  // directory that overlaps the checkout takes the checkout with it, and every other session's
  // uncommitted work in it. Refused early and by exit code, the way the gate refuses a report
  // path that resolves inside the repository.
  if (overlaps(at, source)) {
    console.error(`  REFUSED — the work directory ${resolve(at)} overlaps the checkout ` +
      `${resolve(source)}. It is deleted and rebuilt on every run, so it must be somewhere ` +
      "else entirely — not the repository, not a parent of it, not a directory inside it.");
    process.exit(2);
  }
  rmSync(at, { recursive: true, force: true });
  mkdirSync(at, { recursive: true });
  const parent = join(at, "parent");
  mkdirSync(parent);
  const repo = join(parent, basename(source));
  execFileSync("cp", ["-a", source, repo], { stdio: "pipe" });
  linkSiblings(source, parent);
  // BEFORE the commit and before the snapshot, so whatever `prepare` writes is part of the
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

/** The check files this run must cover, by the command the frozen coverage check uses to
 *  decide the same question. NEVER a list typed here: a roster goes stale by gaining a file,
 *  and the failure is silent — it covers fewer checks than exist and reports success. */
export function declaredChecks(repo: string): string[] {
  return git(repo, ["ls-files", "--cached", "--others", "--exclude-standard"])
    .split("\n")
    .filter((f) => f.startsWith("scripts/gate/checks/") && f.endsWith(".ts"))
    .sort();
}

export const DECLARED_BY = "git ls-files --cached --others --exclude-standard";

