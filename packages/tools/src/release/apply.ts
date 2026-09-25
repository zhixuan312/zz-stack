/**
 * `zz-tool release-apply` (Task I-23, FR-49, AC-49.1): the git-and-process half of an
 * exactly-once release, run by whoever has a shell — the IMPROVE agent, or a person by hand.
 * `release_apply` (the MCP tool, `services/zz-core/src/eval/release-apply.ts`) owns the decision,
 * the advisory lock and the record; zz-core runs server-side with no checkout of the plugin's
 * repository, so this CLI is what actually applies the patch, hashes it, commits, gates, and runs
 * the repository's own release procedure — the same server-decides/CLI-executes split
 * `packages/tools/src/replay/launch.ts` already uses for replay, and `candidate-build.ts` uses
 * for a candidate's own build+gate (server-side there only because THAT step never leaves the
 * platform's own checkout — this one does, once a real release procedure runs).
 *
 *   node packages/tools/dist/release/apply.js --candidate <id> --repo <path> \
 *     --initiative <slug> --digest <approved_patch_digest> \
 *     --release-cmd "<command>" [--gate-cmd "<command>"] [--gateway <url>]
 *
 * `--release-cmd` is deliberately required, with no default. `scripts/release.ts` and
 * `.claude/commands/release.md` both say plainly that the version bump, the changelog and the
 * branch/merge-to-master sequence are judgement work a script must not do on somebody's behalf —
 * this CLI cannot honestly supply them autonomously, so "the repository's release procedure" is a
 * configured command rather than a hard-coded call into `scripts/release.ts`. A real deployment
 * points `--release-cmd` at a wrapper that already carries those judgement calls (typically
 * prepared once, ahead of the candidate reaching this stage); this task's own verification points
 * it at a harmless stub instead — see the task's own instruction never to run a real release
 * while verifying.
 *
 * Isolation, not `git reset`: every step from `git apply` through the release command runs inside
 * a fresh, deterministic worktree (mirroring `packages/tools/src/replay/git.ts`'s own lifecycle,
 * repeated here with its own ref namespace rather than imported — the same small, self-contained
 * pattern `services/zz-core/src/eval/candidate-build.ts`'s own module note already repeats rather
 * than reaching across a service/package boundary for). `--repo`'s own HEAD and branch are never
 * touched, so "the repository returns to its pre-apply commit" on a gate or release failure holds
 * by construction: the worktree that failed is simply removed, and `--repo` was never on anything
 * else. `--repo` should be a throwaway clone during verification, never the real checkout — this
 * file has no way to tell the difference and does not try to.
 *
 * Every path past a successful `release_apply` call ends in exactly one `release_record` call —
 * `released` on success, `failed` (with the failing command's own output tail) on every other
 * exit, including an uncaught exception — because an `applying` attempt with nobody left to call
 * `release_record` for it is stuck there forever: migration 077's own partial unique index means
 * THIS candidate can never apply again until an operator calls `release_record` by hand. That
 * escape hatch — call `release_record(release_attempt_id, status: failed, failure_tail: "...",
 * idempotency_key: "...")` directly — is the one thing to reach for if this process itself dies
 * mid-run rather than exiting through one of its own paths.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Mcp } from "@zz/mcp-client";

import { die, optional, parseArgs, platformToken, required } from "../lib/cli.js";
import { splitCommand } from "../lib/shell.js";

const GIT_TIMEOUT_MS = 60_000;
const GATE_TIMEOUT_MS = 15 * 60_000;
const RELEASE_TIMEOUT_MS = 20 * 60_000;
/** The failing command's own output tail — enough to act on, never a whole log; mirrors
 *  `candidate-build.ts`'s own `OUTPUT_TAIL_CHARS`. */
const OUTPUT_TAIL_CHARS = 4000;
const DEFAULT_GATE_CMD = "npm run gate -- --quiet";
const DEFAULT_CLIENT = "zz-release-apply";

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

// -------------------------------------------------------------------------------------------
// Worktree lifecycle — own ref namespace (`refs/release-apply/<attempt>`), deterministic in the
// release_attempt_id so a crashed earlier attempt for the SAME id is found and cleared rather
// than colliding, exactly the property `replay/git.ts`'s own `worktreePathFor` and
// `candidate-build.ts`'s own `worktreePathFor` both lean on.

interface Worktree { readonly ref: string; readonly path: string }

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function gitQuiet(cwd: string, args: string[]): void {
  try { execFileSync("git", args, { cwd, timeout: GIT_TIMEOUT_MS, stdio: "ignore" }); }
  catch { /* nothing there to remove, or already gone — both are the success case here */ }
}

function worktreePathFor(attemptId: string): string {
  return join(tmpdir(), "zz-release-apply", attemptId);
}
function refFor(attemptId: string): string {
  return `refs/release-apply/${attemptId}`;
}

function clearStaleWorktree(repoRoot: string, attemptId: string): void {
  const path = worktreePathFor(attemptId);
  gitQuiet(repoRoot, ["worktree", "remove", "--force", path]);
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  gitQuiet(repoRoot, ["update-ref", "-d", refFor(attemptId)]);
}

/** Pins a detached worktree to `--repo`'s own current HEAD — never a branch, so nothing this file
 *  does can ever move `--repo`'s own checkout out from under whoever else is using it. */
function createReleaseWorktree(repoRoot: string, attemptId: string): Worktree {
  clearStaleWorktree(repoRoot, attemptId);
  const commit = git(repoRoot, ["rev-parse", "HEAD"]);
  const ref = refFor(attemptId);
  git(repoRoot, ["update-ref", ref, commit]);
  const path = worktreePathFor(attemptId);
  mkdirSync(join(tmpdir(), "zz-release-apply"), { recursive: true });
  try {
    git(repoRoot, ["worktree", "add", "--quiet", "--detach", path, ref]);
  } catch (err) {
    gitQuiet(repoRoot, ["update-ref", "-d", ref]);
    throw err;
  }
  return { ref, path };
}

function removeReleaseWorktree(repoRoot: string, worktree: Worktree): void {
  gitQuiet(repoRoot, ["worktree", "remove", "--force", worktree.path]);
  if (existsSync(worktree.path)) rmSync(worktree.path, { recursive: true, force: true });
  gitQuiet(repoRoot, ["update-ref", "-d", worktree.ref]);
}

/** `git apply`, argv only — the diff text never reaches `execFileSync`'s argv as a string, only a
 *  private temporary file's path does, mirroring `replay/git.ts`'s and `candidate-build.ts`'s own
 *  `applyPatch`. */
function applyDiff(worktreePath: string, diff: string): void {
  const dir = mkdtempSync(join(tmpdir(), "zz-release-apply-patch-"));
  const patchPath = join(dir, "candidate.patch");
  writeFileSync(patchPath, diff.endsWith("\n") ? diff : `${diff}\n`, "utf8");
  try {
    git(worktreePath, ["apply", "--whitespace=nowarn", patchPath]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface CommandOutcome { readonly ok: boolean; readonly output: string }

function runCommand(cwd: string, argv: readonly string[], timeoutMs: number): CommandOutcome {
  try {
    const output = execFileSync(argv[0], argv.slice(1), {
      cwd, encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    return { ok: false, output: (e.stderr || e.stdout || e.message || "unknown error").trim() };
  }
}

// -------------------------------------------------------------------------------------------
// The wire shapes this CLI reads back — local mirrors, never imported from `services/zz-core/
// dist`, the same rule `replay/launch.ts`'s own module note states: `packages/tools` crosses that
// boundary only over MCP, on the wire.

interface ApplyResponse {
  status: "applying" | "refused";
  reason: string | null;
  release_attempt_id: string;
  patch: { diff: string; patch_digest: string } | null;
  plan: { plugin: string; declared_version: string; base_subject_version_id: string; branch: string } | null;
}

async function cliMain(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const candidateId = required(args, "candidate", "the candidate_id release_apply is called for");
  const repoRoot = required(args, "repo", "the repository checkout to apply the patch into — a throwaway clone while verifying, never the primary checkout");
  const initiative = required(args, "initiative", "the initiative improvement.md was written into");
  const digest = required(args, "digest", "the approved_patch_digest quoted in the approved improvement.md");
  const gatewayUrl = (optional(args, "gateway", "the gateway base, e.g. http://localhost:18000") ?? process.env.ZZ_URL ?? "").replace(/\/+$/, "");
  if (!gatewayUrl) die("no gateway: pass --gateway or set ZZ_URL");
  const gateCmd = splitCommand(optional(args, "gate-cmd", "the command that gates the applied patch") ?? DEFAULT_GATE_CMD);
  const releaseCmd = splitCommand(required(args, "release-cmd",
    "the repository's own release procedure, run from the isolated worktree once the gate " +
    "passes — read scripts/release.ts and .claude/commands/release.md before choosing one for a " +
    "real release; pass a harmless stub while verifying, e.g. --release-cmd \"git tag " +
    "v0.0.0-verify\""));
  const idempotencyKey = optional(args, "idempotency-key", "a fixed key, to retry this exact call idempotently") ?? randomUUID();

  const mcp = new Mcp(`${gatewayUrl}/eval/mcp`, { pat: platformToken(), client: DEFAULT_CLIENT });

  const applySaid = await mcp.call("release_apply", {
    candidate_id: candidateId, approved_patch_digest: digest, initiative, idempotency_key: idempotencyKey,
  });
  if (/^ERROR[: ]/.test(applySaid)) die(`release_apply refused: ${applySaid}`, 2);
  const apply = JSON.parse(applySaid) as ApplyResponse;
  console.log(`release_apply -> ${apply.status}${apply.reason ? ` (${apply.reason})` : ""}`);
  if (apply.status !== "applying" || !apply.patch || !apply.plan) {
    // Refused before anything here ever touched the repository — release_apply already recorded
    // why, on the server, as part of the same call.
    return 1;
  }

  const attemptId = apply.release_attempt_id;
  const diff = apply.patch.diff;

  let recorded = false;
  const recordFailed = async (tail: string): Promise<void> => {
    if (recorded) return; // every exit path calls this at most once — see the module note
    recorded = true;
    const said = await mcp.call("release_record", {
      release_attempt_id: attemptId, status: "failed",
      failure_tail: tail.slice(-OUTPUT_TAIL_CHARS), idempotency_key: randomUUID(),
    });
    console.log(`release_record (failed) -> ${said}`);
  };

  // The contract's own words: "hashes the applied bytes against approved_patch_digest before
  // committing." Checked here, before the repository is touched at all — independently of the
  // check release_apply itself already made server-side, on the bytes this process actually
  // received rather than trusting the wire twice for the same fact without checking it twice.
  const appliedHash = sha256(diff);
  if (appliedHash !== digest || apply.patch.patch_digest !== digest) {
    await recordFailed(
      `local hash check failed before applying: sha256(diff)=${appliedHash}, expected ${digest}, ` +
      `server's own patch_digest=${apply.patch.patch_digest}`);
    return 1;
  }

  let worktree: Worktree | undefined;
  try {
    worktree = createReleaseWorktree(repoRoot, attemptId);
    applyDiff(worktree.path, diff);
    // -c user.name/user.email rather than relying on repo/global config: this process may run in
    // an environment with neither set, and a commit failing on that account is not a candidate or
    // a gate problem worth reporting as either.
    git(worktree.path, ["add", "-A"]);
    git(worktree.path, [
      // "@local", not a dotted domain: the gate's own credential-disclosure check treats an
      // address with a dot after the "@" as a real, reachable one (mutation/workspace.ts's own
      // committer identity uses the same shape for the same reason).
      "-c", "user.name=zz-release-apply", "-c", "user.email=release-apply@local",
      "commit", "-m", `release: apply candidate ${candidateId} (${digest})`,
    ]);

    const gate = runCommand(worktree.path, gateCmd, GATE_TIMEOUT_MS);
    if (!gate.ok) { await recordFailed(gate.output); return 1; }

    const release = runCommand(worktree.path, releaseCmd, RELEASE_TIMEOUT_MS);
    if (!release.ok) { await recordFailed(release.output); return 1; }

    // Best effort — `--always` falls back to an abbreviated commit hash on a repo with no tags at
    // all, so this never throws for want of one; a release_ref is still recorded either way.
    const releaseRef = git(worktree.path, ["describe", "--tags", "--always"]);

    // The new subject version release_record asks for is resolved the SAME way plugin_locate
    // resolves any other — never re-derived here, which would risk disagreeing with it.
    const locateSaid = await mcp.call("plugin_locate", { plugin: apply.plan.plugin, idempotency_key: randomUUID() });
    if (/^ERROR[: ]/.test(locateSaid)) {
      await recordFailed(`release procedure ran, but plugin_locate afterwards failed: ${locateSaid}`);
      return 1;
    }
    const located = JSON.parse(locateSaid) as { subject_version_id: string };

    recorded = true; // set before the call: a thrown/rejected release_record must not also retry through recordFailed
    const recordSaid = await mcp.call("release_record", {
      release_attempt_id: attemptId, status: "released",
      release_ref: releaseRef, released_subject_version_id: located.subject_version_id,
      idempotency_key: randomUUID(),
    });
    console.log(`release_record (released) -> ${recordSaid}`);
    return /^ERROR[: ]/.test(recordSaid) ? 1 : 0;
  } catch (err) {
    await recordFailed((err as Error).message ?? String(err));
    return 1;
  } finally {
    if (worktree) removeReleaseWorktree(repoRoot, worktree);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(await cliMain(process.argv.slice(2)));
  } catch (err) {
    console.error((err as Error).message ?? String(err));
    process.exit(2);
  }
}
