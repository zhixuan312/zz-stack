/**
 * `zz-tool release-apply` (Task I-23, FR-49, AC-49.1): the git-and-process half of an
 * exactly-once release, run by whoever has a shell — the IMPROVE agent, or a person by hand.
 * `release_apply` (the MCP tool, `services/zz-core/src/eval/release-apply.ts`) owns the decision,
 * the advisory lock and the record; zz-core runs server-side with no checkout of the plugin's
 * repository, so this CLI is what actually applies the patch, hashes it, commits, gates, and runs
 * the repository's own release procedure — the same server-decides/CLI-executes split
 * `packages/tools/src/replay/launch.ts` already uses for replay.
 *
 *   node packages/tools/dist/release/apply.js --candidate <id> --repo <path> \
 *     --initiative <slug> --digest <approved_patch_digest> --release-cmd "<command>" \
 *     --release-version <version> [--base-ref <commit>] [--gate-cmd "<command>"] [--gateway <url>]
 *
 *   node packages/tools/dist/release/apply.js --reconcile <release_attempt_id> \
 *     --candidate <id> --plugin <name> --release-version <version> --repo <path> [--gateway <url>]
 *
 * `--release-cmd` is deliberately required, with no default: the version bump, the changelog and
 * the branch/merge sequence are judgement work a script must not do on somebody's behalf, so "the
 * repository's release procedure" is a configured command, prepared ahead with those calls made.
 * `--release-version` is the exact version that command publishes; the new subject is located AT
 * that version (`plugin_locate` with `version`), never as "whatever the head is now" — the head
 * after a release that registered nothing is the unchanged base, and recording that as released
 * is the lie `release_record` now refuses (`not_newer`).
 *
 * Where the patch lands: a fresh worktree on `plan.branch`, created at the commit the base subject
 * was released from — `plan.base_ref` from the server (this system's own release_ref, or a git
 * source's resolved_commit), else `--base-ref` from the operator, and refused (recorded `failed`,
 * nothing touched) when neither names a commit this repository has or the two disagree. Never
 * `--repo`'s own HEAD: a candidate is proved against its base, and applying it onto whatever the
 * checkout happens to hold releases something nobody proved. `--repo`'s own HEAD and branch are
 * never moved. On success the worktree is removed and the branch KEPT — it holds the release
 * commit, and its sha is the `release_ref` the next release against this subject starts from. On
 * any failure before the release command succeeds, worktree and branch are both removed and the
 * attempt is recorded `failed`.
 *
 * Once the release command has succeeded, `failed` is never recorded again: the release happened.
 * If locating the new version or recording `released` is refused or the process dies, the
 * attempt stays applying and `release_apply` refuses every later attempt of the plugin with
 * `release_in_progress` — naming it as stale once it is — until `--reconcile` finds out what
 * really happened: the published version located → `released`; never registered → `failed`, the
 * truth, and the branch removed. `released` is recorded under a key derived from the attempt, so a
 * lost response is retried as a replay rather than a second write.
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
/** The failing command's own output tail — enough to act on, never a whole log. */
const OUTPUT_TAIL_CHARS = 4000;
const DEFAULT_GATE_CMD = "npm run gate -- --quiet";
const DEFAULT_CLIENT = "zz-release-apply";

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const isRefusal = (said: string): boolean => /^ERROR[: ]/.test(said);

// -------------------------------------------------------------------------------------------
// Git.

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function gitQuiet(cwd: string, args: string[]): void {
  try { execFileSync("git", args, { cwd, timeout: GIT_TIMEOUT_MS, stdio: "ignore" }); }
  catch { /* nothing there to remove, or already gone — both are the success case here */ }
}
/** The commit `ref` names in `repoRoot`, or null when it names none. */
function commitOf(repoRoot: string, ref: string): string | null {
  try { return git(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]); }
  catch { return null; }
}

function worktreePathFor(attemptId: string): string {
  return join(tmpdir(), "zz-release-apply", attemptId);
}

/** Removes the worktree, and the branch too unless it is being kept as the release's record. */
function removeWorktree(repoRoot: string, attemptId: string, branch: string | null): void {
  const path = worktreePathFor(attemptId);
  gitQuiet(repoRoot, ["worktree", "remove", "--force", path]);
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  gitQuiet(repoRoot, ["worktree", "prune"]);
  if (branch) gitQuiet(repoRoot, ["branch", "-D", branch]);
}

/** `git apply`, argv only — the diff text never reaches argv, only a private file's path does. */
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
// dist`: `packages/tools` crosses that boundary only over MCP.

interface ApplyResponse {
  status: "applying" | "refused";
  reason: string | null;
  release_attempt_id: string;
  patch: { diff: string; patch_digest: string } | null;
  plan: {
    plugin: string; declared_version: string; base_subject_version_id: string; branch: string;
    base_ref: string | null;
  } | null;
}

/** The base commit, or why there is none — see the module note. */
function resolveBase(repoRoot: string, planRef: string | null, operatorRef: string | null): { commit: string } | { refused: string } {
  const fromPlan = planRef ? commitOf(repoRoot, planRef) : null;
  const fromOperator = operatorRef ? commitOf(repoRoot, operatorRef) : null;
  if (planRef && !fromPlan) return { refused: `the base subject's recorded release commit ${planRef} is not in ${repoRoot}` };
  if (operatorRef && !fromOperator) return { refused: `--base-ref ${operatorRef} names no commit in ${repoRoot}` };
  if (fromPlan && fromOperator && fromPlan !== fromOperator) {
    return { refused: `--base-ref ${operatorRef} is ${fromOperator}, but the base subject was released from ${fromPlan}` };
  }
  const commit = fromPlan ?? fromOperator;
  return commit ? { commit } : {
    refused: "nothing records the commit the base subject was released from — pass --base-ref " +
      "naming it (the commit whose catalog carries the base version)",
  };
}

const releasedKey = (attemptId: string): string => `release_record:${attemptId}:released`;
const failedKey = (attemptId: string): string => `release_record:${attemptId}:failed`;

function reconcileHint(attemptId: string, candidateId: string, plugin: string, version: string): string {
  return `zz-tool release-apply --reconcile ${attemptId} --candidate ${candidateId} --plugin ${plugin} ` +
    `--release-version ${version} --repo <this clone>`;
}

async function applyMain(mcp: Mcp, args: ReturnType<typeof parseArgs>): Promise<number> {
  const candidateId = required(args, "candidate", "the candidate_id release_apply is called for");
  const repoRoot = required(args, "repo", "the repository checkout to release from — a throwaway clone while verifying, never the primary checkout");
  const initiative = required(args, "initiative", "the initiative improvement.md was written into");
  const digest = required(args, "digest", "the approved_patch_digest quoted in the approved improvement.md");
  const releaseVersion = required(args, "release-version", "the exact version --release-cmd publishes");
  const operatorBase = optional(args, "base-ref", "the commit the base subject was released from, when the platform records none");
  const gateCmd = splitCommand(optional(args, "gate-cmd", "the command that gates the applied patch") ?? DEFAULT_GATE_CMD);
  const releaseCmd = splitCommand(required(args, "release-cmd",
    "the repository's own release procedure, run from the isolated worktree once the gate " +
    "passes — read scripts/release.ts and .claude/commands/release.md before choosing one for a " +
    "real release; pass a harmless stub while verifying, e.g. --release-cmd \"git tag " +
    "v0.0.0-verify\""));
  const idempotencyKey = optional(args, "idempotency-key", "a fixed key, to retry this exact call idempotently")
    ?? randomUUID();

  const applySaid = await mcp.call("release_apply", {
    candidate_id: candidateId, approved_patch_digest: digest, initiative, idempotency_key: idempotencyKey,
  });
  if (isRefusal(applySaid)) die(`release_apply refused: ${applySaid}`, 2);
  const apply = JSON.parse(applySaid) as ApplyResponse;
  console.log(`release_apply -> ${apply.status}${apply.reason ? ` (${apply.reason})` : ""}`);
  if (apply.status !== "applying" || !apply.patch || !apply.plan) return 1;

  const attemptId = apply.release_attempt_id;
  const plan = apply.plan;
  const diff = apply.patch.diff;
  let createdBranch = false;
  let released = false; // once true, `failed` is never recorded — see the module note
  let recorded = false;
  const recordFailed = async (tail: string): Promise<void> => {
    if (recorded || released) return;
    recorded = true;
    removeWorktree(repoRoot, attemptId, createdBranch ? plan.branch : null);
    const said = await mcp.call("release_record", {
      release_attempt_id: attemptId, status: "failed",
      failure_tail: tail.slice(-OUTPUT_TAIL_CHARS), idempotency_key: failedKey(attemptId),
    });
    console.log(`release_record (failed) -> ${said}`);
  };

  // Hashed before the repository is touched, on the bytes this process actually received.
  const appliedHash = sha256(diff);
  if (appliedHash !== digest || apply.patch.patch_digest !== digest) {
    await recordFailed(
      `local hash check failed before applying: sha256(diff)=${appliedHash}, expected ${digest}, ` +
      `server's own patch_digest=${apply.patch.patch_digest}`);
    return 1;
  }
  const base = resolveBase(repoRoot, plan.base_ref, operatorBase);
  if ("refused" in base) { await recordFailed(`base unresolvable, nothing applied: ${base.refused}`); return 1; }
  if (commitOf(repoRoot, `refs/heads/${plan.branch}`)) {
    await recordFailed(
      `branch ${plan.branch} already exists in ${repoRoot} — an earlier attempt for this candidate ` +
      "left it; delete it (or reconcile that attempt) before applying again. Nothing applied.");
    return 1;
  }

  const path = worktreePathFor(attemptId);
  try {
    removeWorktree(repoRoot, attemptId, null);
    mkdirSync(join(tmpdir(), "zz-release-apply"), { recursive: true });
    git(repoRoot, ["worktree", "add", "--quiet", "-b", plan.branch, path, base.commit]);
    createdBranch = true;
    applyDiff(path, diff);
    git(path, ["add", "-A"]);
    git(path, [
      // "@local", not a dotted domain: the gate's own credential-disclosure check treats an
      // address with a dot after the "@" as a real, reachable one.
      "-c", "user.name=zz-release-apply", "-c", "user.email=release-apply@local",
      "commit", "-m", `release: apply candidate ${candidateId} (${digest})`,
    ]);

    const gate = runCommand(path, gateCmd, GATE_TIMEOUT_MS);
    if (!gate.ok) { await recordFailed(gate.output); return 1; }
    const release = runCommand(path, releaseCmd, RELEASE_TIMEOUT_MS);
    if (!release.ok) { await recordFailed(release.output); return 1; }
    released = true;

    const releaseRef = git(path, ["rev-parse", "HEAD"]);
    removeWorktree(repoRoot, attemptId, null);
    return await recordReleased(mcp, attemptId, plan.plugin, releaseVersion, releaseRef,
      reconcileHint(attemptId, candidateId, plan.plugin, releaseVersion));
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    if (released) {
      console.error(`${message}\nThe release command succeeded, so this attempt is left applying. Run: ` +
        reconcileHint(attemptId, candidateId, plan.plugin, releaseVersion));
    } else {
      await recordFailed(message);
    }
    return 1;
  } finally {
    if (!released && !recorded) removeWorktree(repoRoot, attemptId, createdBranch ? plan.branch : null);
  }
}

/** Locates the exact published version and records it released, under the attempt's own key —
 *  a retry replays rather than writing twice. A refusal leaves the attempt applying and says how
 *  to finish it; it never falls back to `failed`, because the release already happened. */
async function recordReleased(
  mcp: Mcp, attemptId: string, plugin: string, version: string, releaseRef: string, hint: string,
): Promise<number> {
  const locateSaid = await mcp.call("plugin_locate", { plugin, version, idempotency_key: `plugin_locate:${attemptId}:${version}` });
  if (isRefusal(locateSaid)) {
    console.error(`plugin_locate found no ${plugin} ${version}: ${locateSaid}\nOnce it is registered, run: ${hint}`);
    return 1;
  }
  const located = JSON.parse(locateSaid) as { subject_version_id: string };
  const recordSaid = await mcp.call("release_record", {
    release_attempt_id: attemptId, status: "released",
    release_ref: releaseRef, released_subject_version_id: located.subject_version_id,
    idempotency_key: releasedKey(attemptId),
  });
  console.log(`release_record (released) -> ${recordSaid}`);
  if (isRefusal(recordSaid)) {
    console.error(`the attempt is still applying; once the refusal above is addressed, run: ${hint}`);
    return 1;
  }
  return 0;
}

/** `--reconcile`: what really happened to an attempt nobody is left to report for. The version
 *  its release command publishes is registered → it released; it is not → it did not, and
 *  `failed` is the truth. */
async function reconcileMain(mcp: Mcp, args: ReturnType<typeof parseArgs>, attemptId: string): Promise<number> {
  const candidateId = required(args, "candidate", "the candidate the attempt applied");
  const plugin = required(args, "plugin", "the plugin the attempt released");
  const version = required(args, "release-version", "the exact version the attempt's release command publishes");
  const repoRoot = required(args, "repo", "the clone the attempt was applied in");
  const branch = `release/candidate-${candidateId}`;

  removeWorktree(repoRoot, attemptId, null);
  const locateSaid = await mcp.call("plugin_locate", { plugin, version, idempotency_key: `plugin_locate:${attemptId}:${version}` });
  if (!isRefusal(locateSaid)) {
    const releaseRef = commitOf(repoRoot, `refs/heads/${branch}`) ?? `${plugin}@${version}`;
    return recordReleased(mcp, attemptId, plugin, version, releaseRef, reconcileHint(attemptId, candidateId, plugin, version));
  }
  gitQuiet(repoRoot, ["branch", "-D", branch]);
  const said = await mcp.call("release_record", {
    release_attempt_id: attemptId, status: "failed", idempotency_key: failedKey(attemptId),
    failure_tail: `reconcile: ${plugin} ${version} was never registered, so this attempt's release ` +
      `did not land; branch ${branch} removed. plugin_locate said: ${locateSaid}`.slice(-OUTPUT_TAIL_CHARS),
  });
  console.log(`release_record (failed) -> ${said}`);
  return isRefusal(said) ? 1 : 0;
}

async function cliMain(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const gatewayUrl = (optional(args, "gateway", "the gateway base, e.g. http://localhost:18000") ?? process.env.ZZ_URL ?? "").replace(/\/+$/, "");
  if (!gatewayUrl) die("no gateway: pass --gateway or set ZZ_URL");
  const mcp = new Mcp(`${gatewayUrl}/eval/mcp`, { pat: platformToken(), client: DEFAULT_CLIENT });
  // NOT A TOOL: `reconcile` is this CLI's own flag, the mode that settles a stuck attempt.
  const reconcile = optional(args, "reconcile", "the release_attempt_id left applying to reconcile");
  return reconcile ? reconcileMain(mcp, args, reconcile) : applyMain(mcp, args);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(await cliMain(process.argv.slice(2)));
  } catch (err) {
    console.error((err as Error).message ?? String(err));
    process.exit(2);
  }
}
