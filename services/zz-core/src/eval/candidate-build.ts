/**
 * `candidate_validate`'s own build+gate isolation step (Task I-19, contract's own words:
 * "builds the candidate in isolation and runs the gate in its worktree"): a candidate's
 * patchset is proven against THIS repository's own build and gate — not merely against the
 * plugin it patches — before a single replay case is ever spent on it. A build/gate failure
 * here is what makes a candidate `invalid`; nothing downstream of this file ever replays one.
 *
 * Mirrors `packages/tools/src/replay/git.ts`'s worktree lifecycle (argv-only `execFileSync`, a
 * deterministic path so a crashed attempt can be found and cleared by the next one) rather than
 * importing it: `zz-core` carries no dependency on `packages/tools` (a service-to-CLI-tool
 * boundary this task does not cross), so the same small pattern is repeated here, scoped to its
 * own `refs/candidate-validate/<candidate_id>` namespace so the two callers' refs can never
 * collide.
 *
 * DELIBERATE: `node_modules` is never reinstalled. `npm ci`/`npm install` inside every
 * candidate's own isolated worktree would cost real network time on every validate call, for
 * dependencies that never changed. Every ordinary package is symlinked straight from the live
 * checkout's own `node_modules`; every `@zz/*` workspace package is re-linked to point at THIS
 * WORKTREE's own copy instead — npm's own workspace symlinks are relative
 * (`@zz/contracts -> ../../packages/contracts`), so linking `node_modules` itself wholesale
 * would resolve every `@zz/*` import back into the LIVE checkout, silently building against the
 * pre-patch source for exactly the packages a candidate is most likely to have touched.
 *
 * DELIBERATE: no `repoRoot` argument. `candidate_validate`'s own signature (the plan's contract)
 * carries only `candidate_id`/`idempotency_key` — this file discovers the checkout from where
 * the service process runs (`git rev-parse --show-toplevel`), and a deployment with none (a
 * production container built from a tarball, say) gets a clean refusal rather than a crash: the
 * caller reports it as "cannot build here" the same way `db()` returning null already reports
 * "no platform database" elsewhere in this service.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync, unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const GIT_TIMEOUT_MS = 60_000;
const BUILD_TIMEOUT_MS = 10 * 60_000;
const GATE_TIMEOUT_MS = 15 * 60_000;
/** The contract's own words: "the failing command's own output tail" — enough to act on, never
 *  the whole log (a runaway gate can print megabytes). */
const OUTPUT_TAIL_CHARS = 4000;

export interface Worktree { readonly ref: string; readonly path: string; readonly commit: string }

/** `{ ok: false }` distinguishes a genuine command failure (exit code, real output) from a
 *  timeout — a build that never finished is not a build that finished badly, and
 *  `candidate_validate` refuses rather than marking `invalid` on one (a slow environment is not
 *  the candidate's own fault). */
export type BuildOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly stage: "build" | "gate"; readonly output: string }
  | { readonly ok: false; readonly stage: "timeout"; readonly command: string };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function gitQuiet(cwd: string, args: string[]): void {
  try { execFileSync("git", args, { cwd, timeout: GIT_TIMEOUT_MS, stdio: "ignore" }); }
  catch { /* nothing there to remove, or already gone — both are the success case here */ }
}

/** `null` for a process not running from inside a git checkout — the caller's own clean
 *  refusal, never a thrown error this deep. */
export function discoverRepoRoot(startDir: string = process.cwd()): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"],
      { cwd: startDir, encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

function worktreePathFor(candidateId: string): string {
  return join(tmpdir(), "zz-candidate-validate", candidateId);
}
function refFor(candidateId: string): string {
  return `refs/candidate-validate/${candidateId}`;
}

/** Fix 6, mirrored from `packages/tools/src/replay/git.ts`'s own `ensureDashboardSibling` (see
 *  that file's note): `candidate_validate` runs the repository gate inside this candidate's own
 *  worktree, and the gate's "every route this gateway serves has a caller" check resolves the
 *  console's sibling checkout relative to wherever it is running from — a fresh worktree with no
 *  sibling of its own fails that check for a reason that has nothing to do with the candidate's
 *  patch. Every worktree this file creates shares the same parent
 *  (`tmpdir()/zz-candidate-validate`), so one symlink there makes `../zz-stack-dashboard`
 *  resolve from every candidate's worktree under it. */
function ensureDashboardSibling(repoRoot: string, parentDir: string): void {
  const real = resolve(repoRoot, "..", "zz-stack-dashboard");
  if (!existsSync(real)) return;
  const link = join(parentDir, "zz-stack-dashboard");
  try {
    const stat = lstatSync(link);
    if (stat.isSymbolicLink() && readlinkSync(link) === real) return;
    unlinkSync(link);
  } catch {
    // ENOENT: nothing there yet — fall through to create it.
  }
  symlinkSync(real, link);
}

function clearStaleWorktree(repoRoot: string, candidateId: string): void {
  const path = worktreePathFor(candidateId);
  gitQuiet(repoRoot, ["worktree", "remove", "--force", path]);
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  gitQuiet(repoRoot, ["update-ref", "-d", refFor(candidateId)]);
}

/** Pins a worktree to `ref` (default `HEAD` — the candidate's base is whatever this checkout
 *  currently holds; a candidate names no ref of its own in the plan's contract) and adds a
 *  detached worktree at a path deterministic in `candidateId`, so a crashed earlier attempt for
 *  the SAME candidate is found and cleared rather than colliding. */
export function createCandidateWorktree(repoRoot: string, candidateId: string, ref = "HEAD"): Worktree {
  clearStaleWorktree(repoRoot, candidateId);
  const commit = git(repoRoot, ["rev-parse", ref]);
  const worktreeRef = refFor(candidateId);
  git(repoRoot, ["update-ref", worktreeRef, commit]);
  const path = worktreePathFor(candidateId);
  const parent = join(tmpdir(), "zz-candidate-validate");
  mkdirSync(parent, { recursive: true });
  ensureDashboardSibling(repoRoot, parent);
  try {
    git(repoRoot, ["worktree", "add", "--quiet", "--detach", path, worktreeRef]);
  } catch (err) {
    gitQuiet(repoRoot, ["update-ref", "-d", worktreeRef]);
    throw err;
  }
  return { ref: worktreeRef, path, commit };
}

export function removeCandidateWorktree(repoRoot: string, worktree: Worktree): void {
  gitQuiet(repoRoot, ["worktree", "remove", "--force", worktree.path]);
  if (existsSync(worktree.path)) rmSync(worktree.path, { recursive: true, force: true });
  gitQuiet(repoRoot, ["update-ref", "-d", worktree.ref]);
}

/** `git apply`, argv only — the diff text never reaches `execFileSync`'s argv as a string, only
 *  a private temporary file's path does, mirroring `packages/tools/src/replay/git.ts`'s own
 *  `applyPatch`. A missing trailing newline is added to the written copy (`git apply` reads the
 *  file format strict), never to the digested/recorded diff itself. */
export function applyCandidatePatch(worktreePath: string, diff: string): void {
  const dir = mkdtempSync(join(tmpdir(), "zz-candidate-patch-"));
  const patchPath = join(dir, "candidate.patch");
  writeFileSync(patchPath, diff.endsWith("\n") ? diff : `${diff}\n`, "utf8");
  try {
    git(worktreePath, ["apply", "--whitespace=nowarn", patchPath]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** See the module note: every ordinary dependency is symlinked straight from the live
 *  checkout's `node_modules`; every `@zz/*` workspace package is re-linked to point at this
 *  worktree's own copy of that package instead of following the live checkout's relative
 *  symlink back to itself. Skips whatever the worktree's own (empty, freshly checked-out) tree
 *  does not otherwise have — a workspace package `@zz/x` whose worktree copy does not exist
 *  (should not happen; every workspace is tracked) is left unlinked rather than pointed at
 *  nothing. */
export function linkWorkspaceDependencies(repoRoot: string, worktreePath: string): void {
  const liveModules = join(repoRoot, "node_modules");
  if (!existsSync(liveModules)) return; // nothing installed to link — build/gate will say so
  const worktreeModules = join(worktreePath, "node_modules");
  mkdirSync(worktreeModules, { recursive: true });

  for (const entry of readdirSync(liveModules, { withFileTypes: true })) {
    if (entry.name === "@zz") continue; // handled per-package below
    symlinkSync(join(liveModules, entry.name), join(worktreeModules, entry.name));
  }

  const liveScope = join(liveModules, "@zz");
  if (!existsSync(liveScope)) return;
  const worktreeScope = join(worktreeModules, "@zz");
  mkdirSync(worktreeScope, { recursive: true });
  for (const pkg of readdirSync(liveScope, { withFileTypes: true })) {
    if (!pkg.isSymbolicLink()) continue;
    // The live checkout's own relative link, e.g. "../../packages/contracts" — resolved against
    // where it actually lives (liveScope), never against the worktree, to find which workspace
    // directory this package name maps to.
    const liveTarget = resolve(liveScope, readlinkSync(join(liveScope, pkg.name)));
    const relativeToRepo = liveTarget.startsWith(`${repoRoot}/`) ? liveTarget.slice(repoRoot.length + 1) : null;
    if (!relativeToRepo) continue; // an unexpected link shape — left unlinked rather than guessed at
    const worktreeTarget = join(worktreePath, relativeToRepo);
    if (existsSync(worktreeTarget)) symlinkSync(worktreeTarget, join(worktreeScope, pkg.name));
  }
}

function runCommand(cwd: string, cmd: string, args: string[], timeoutMs: number): { ok: boolean; timedOut: boolean; output: string } {
  try {
    const output = execFileSync(cmd, args, {
      cwd, encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, timedOut: false, output };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string; killed?: boolean; signal?: string };
    return {
      ok: false, timedOut: Boolean(e.killed && e.signal),
      output: (e.stderr || e.stdout || e.message || "unknown error").trim(),
    };
  }
}

/** `npm run build` then, only if it passed, `npm run gate -- --quiet` — the exact two commands
 *  this repository's own worker_rules ask a human or an agent to run before calling anything
 *  finished, run here against the candidate's own isolated worktree instead. */
export function buildAndGate(worktreePath: string): BuildOutcome {
  const build = runCommand(worktreePath, "npm", ["run", "build"], BUILD_TIMEOUT_MS);
  if (build.timedOut) return { ok: false, stage: "timeout", command: "npm run build" };
  if (!build.ok) return { ok: false, stage: "build", output: build.output.slice(-OUTPUT_TAIL_CHARS) };

  const gate = runCommand(worktreePath, "npm", ["run", "gate", "--", "--quiet"], GATE_TIMEOUT_MS);
  if (gate.timedOut) return { ok: false, stage: "timeout", command: "npm run gate -- --quiet" };
  if (!gate.ok) return { ok: false, stage: "gate", output: gate.output.slice(-OUTPUT_TAIL_CHARS) };

  return { ok: true };
}
