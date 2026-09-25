/**
 * `zz-tool release-rollback` (Task I-24, FR-50, AC-50.1): the git-and-process half of an
 * automatic rollback, run by whoever has a shell — the IMPROVE agent, or a person by hand. This
 * mirrors `packages/tools/src/release/apply.ts`'s own split exactly: `release_verify` (the MCP
 * tool, `services/zz-core/src/eval/release-verify.ts`) owns the decision — the released
 * subject's score on real use after release against its base's, and the rollback rule — and hands
 * back a `rollback_plan` on a `rolled_back` verdict; zz-core runs server-side with no checkout of the plugin's repository, so THIS file is
 * what actually runs the repository's own rollback procedure and reports back through
 * `release_record`.
 *
 *   node packages/tools/dist/release/rollback.js --release-attempt <id> --repo <path> \
 *     --rollback-cmd "<command naming {version}>" [--gateway <url>]
 *
 * The command is TOLD which version to restore: every `{version}` in `--rollback-cmd` becomes
 * `rollback_plan.declared_version` and every `{plugin}` becomes `rollback_plan.plugin`, and a
 * command naming no `{version}` is refused before it runs — a rollback that restores "the
 * previous release" by its own reckoning may restore something other than the subject
 * `release_verify` measured against. After the command succeeds, `plugin_locate` AT
 * `rollback_plan.declared_version` must answer exactly `rollback_plan.prior_subject_version_id`
 * before anything is recorded. `release_record(rolled_back)` then retracts the rolled-back version
 * and, in the same transaction, refuses `prior_not_current` unless the prior subject is the
 * plugin's current one — so a rollback is verified without deleting any `zz.plugin_version` row,
 * and a newer release still standing over the prior one is never recorded as rolled back.
 *
 * `--rollback-cmd` is deliberately required, with no default baked in as a hard-coded call —
 * the same judgement `apply.ts`'s own `--release-cmd` already declines to make on a caller's
 * behalf. A real deployment points it at the repository's own `npm run rollback`, prepared ahead
 * of time the same way a real `--release-cmd` is; this task's own verification points it at a
 * harmless stub instead — see the task's own instruction never to run a real rollback while
 * verifying.
 *
 * No patch, no hash, no gate: unlike `apply.ts`, this file applies no diff — the repository's own
 * `npm run rollback` is what actually knows how to restore the prior version (read a tag, revert
 * a commit, whatever that repository's own release history calls for), which is exactly why it is
 * a configured command rather than logic duplicated here. This file's only job is to run that
 * command in an isolated worktree, confirm the prior subject is current, and record that.
 *
 * `--repo`'s own HEAD and branch are never touched, the same isolation `apply.ts` keeps: every
 * step runs inside a fresh, deterministic worktree in its own ref namespace
 * (`refs/release-rollback/<attempt>`), removed whether the command succeeds or fails.
 * `--repo` should be a throwaway clone during verification, never the primary checkout.
 *
 * `release_record` for `rolled_back` is keyed on the attempt, so a lost response retries as a
 * replay. If `release_verify`'s own current verdict is not `rolled_back` (established, not_established,
 * or still pending more post-release evidence), there is nothing for this CLI to do — it says so and
 * exits 0 without touching the repository or calling release_record; running it again once
 * evidence resolves is the correct way to find out whether a rollback is now due. If the rollback
 * command itself fails, this file logs the failure and exits non-zero WITHOUT calling
 * release_record — release_verify's own `rolled_back` verdict is already durably recorded
 * (`zz.release_attempt.verification`), so re-running this same command is always safe and is the
 * intended recovery: nothing here is lost by a first failed attempt.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Mcp } from "@zz/mcp-client";

import { die, optional, parseArgs, platformToken, required } from "../lib/cli.js";
import { splitCommand } from "../lib/shell.js";

const GIT_TIMEOUT_MS = 60_000;
const ROLLBACK_TIMEOUT_MS = 20 * 60_000;
/** The failing command's own output tail — mirrors `apply.ts`'s own `OUTPUT_TAIL_CHARS`, printed
 *  to the operator rather than recorded (see the module note: a failed rollback command is never
 *  reported through release_record). */
const OUTPUT_TAIL_CHARS = 4000;
const DEFAULT_CLIENT = "zz-release-rollback";

// -------------------------------------------------------------------------------------------
// Worktree lifecycle — its own ref namespace, deterministic in release_attempt_id, mirroring
// apply.ts's own createReleaseWorktree/removeReleaseWorktree (kept as its own small copy rather
// than imported, the same self-contained pattern candidate-build.ts's own module note repeats
// rather than reaching across a service/package boundary for).

interface Worktree { readonly ref: string; readonly path: string }

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function gitQuiet(cwd: string, args: string[]): void {
  try { execFileSync("git", args, { cwd, timeout: GIT_TIMEOUT_MS, stdio: "ignore" }); }
  catch { /* nothing there to remove, or already gone — both are the success case here */ }
}

function worktreePathFor(attemptId: string): string {
  return join(tmpdir(), "zz-release-rollback", attemptId);
}
function refFor(attemptId: string): string {
  return `refs/release-rollback/${attemptId}`;
}

function clearStaleWorktree(repoRoot: string, attemptId: string): void {
  const path = worktreePathFor(attemptId);
  gitQuiet(repoRoot, ["worktree", "remove", "--force", path]);
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  gitQuiet(repoRoot, ["update-ref", "-d", refFor(attemptId)]);
}

/** Pins a detached worktree to `--repo`'s own current HEAD — never a branch, so nothing this file
 *  does can ever move `--repo`'s own checkout out from under whoever else is using it. */
function createRollbackWorktree(repoRoot: string, attemptId: string): Worktree {
  clearStaleWorktree(repoRoot, attemptId);
  const commit = git(repoRoot, ["rev-parse", "HEAD"]);
  const ref = refFor(attemptId);
  git(repoRoot, ["update-ref", ref, commit]);
  const path = worktreePathFor(attemptId);
  mkdirSync(join(tmpdir(), "zz-release-rollback"), { recursive: true });
  try {
    git(repoRoot, ["worktree", "add", "--quiet", "--detach", path, ref]);
  } catch (err) {
    gitQuiet(repoRoot, ["update-ref", "-d", ref]);
    throw err;
  }
  return { ref, path };
}

function removeRollbackWorktree(repoRoot: string, worktree: Worktree): void {
  gitQuiet(repoRoot, ["worktree", "remove", "--force", worktree.path]);
  if (existsSync(worktree.path)) rmSync(worktree.path, { recursive: true, force: true });
  gitQuiet(repoRoot, ["update-ref", "-d", worktree.ref]);
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
// dist`, the same rule `apply.ts`'s own module note states.

interface VerifyResponse {
  verdict: "established" | "rolled_back" | "not_established" | null;
  reason: string | null;
  evidence: unknown;
  rollback_plan: { plugin: string; declared_version: string; prior_subject_version_id: string; branch: string } | null;
  status: string;
}

async function cliMain(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const releaseAttemptId = required(args, "release-attempt", "the release_attempt_id release_verify decided rolled_back for");
  const repoRoot = required(args, "repo", "the repository checkout to run the rollback command into — a throwaway clone while verifying, never the primary checkout");
  const gatewayUrl = (optional(args, "gateway", "the gateway base, e.g. http://localhost:18000") ?? process.env.ZZ_URL ?? "").replace(/\/+$/, "");
  if (!gatewayUrl) die("no gateway: pass --gateway or set ZZ_URL");
  const rollbackTemplate = splitCommand(required(args, "rollback-cmd",
    "the repository's own rollback procedure, run from an isolated worktree, naming {version} " +
    "(and optionally {plugin}) where the version to restore goes; pass a harmless stub while " +
    "verifying, e.g. --rollback-cmd \"git tag v{version}-rollback\""));
  if (!rollbackTemplate.some((a) => a.includes("{version}"))) {
    die("--rollback-cmd names no {version}: the command must be told which version to restore", 2);
  }
  const idempotencyKey = optional(args, "idempotency-key", "a fixed key, to retry this exact call idempotently") ?? randomUUID();

  const mcp = new Mcp(`${gatewayUrl}/eval/mcp`, { pat: platformToken(), client: DEFAULT_CLIENT, retryStaleSocket: true });

  const verifySaid = await mcp.call("release_verify", { release_attempt_id: releaseAttemptId, idempotency_key: idempotencyKey });
  if (/^ERROR[: ]/.test(verifySaid)) die(`release_verify refused: ${verifySaid}`, 2);
  const verify = JSON.parse(verifySaid) as VerifyResponse;
  console.log(`release_verify -> verdict: ${verify.verdict ?? "pending"}${verify.reason ? ` (${verify.reason})` : ""}`);

  if (verify.verdict !== "rolled_back") {
    // Nothing to do — established, not_established, or still pending more post-release evidence
    // (the module note's own contract: this CLI never gathers evidence itself).
    console.log(verify.verdict === null
      ? "release_verify has not decided yet — nothing to roll back yet"
      : `release_verify's own verdict is ${verify.verdict} — no rollback due`);
    return 0;
  }
  if (!verify.rollback_plan) {
    die(`release_verify returned verdict: rolled_back with no rollback_plan for ${releaseAttemptId} — cannot proceed`, 2);
  }
  const plan = verify.rollback_plan;
  console.log(`rollback_plan -> plugin ${plan.plugin}, restoring ${plan.declared_version} (${plan.prior_subject_version_id})`);
  const rollbackCmd = rollbackTemplate.map((a) =>
    a.replaceAll("{version}", () => plan.declared_version).replaceAll("{plugin}", () => plan.plugin));

  let worktree: Worktree | undefined;
  try {
    worktree = createRollbackWorktree(repoRoot, releaseAttemptId);
    const rollback = runCommand(worktree.path, rollbackCmd, ROLLBACK_TIMEOUT_MS);
    if (!rollback.ok) {
      // See the module note: no release_record call on a failed command — release_verify's own
      // rolled_back verdict is already durable, so a retry of this same CLI call is the recovery.
      console.error(`rollback command failed:\n${rollback.output.slice(-OUTPUT_TAIL_CHARS)}`);
      return 1;
    }

    // The version restored must still BE the prior subject — located at its exact version, the
    // same content release_verify measured against. Whether it is then current is release_record's
    // own check, made in the same transaction that retracts the rolled-back version.
    const locateSaid = await mcp.call("plugin_locate", {
      plugin: plan.plugin, version: plan.declared_version, idempotency_key: randomUUID(),
    });
    const prior = /^ERROR[: ]/.test(locateSaid) ? null : (JSON.parse(locateSaid) as { subject_version_id: string });
    if (!prior || prior.subject_version_id !== plan.prior_subject_version_id) {
      console.error(
        `the rollback command succeeded, but ${plan.plugin} ${plan.declared_version} now resolves to ` +
        `${prior ? prior.subject_version_id : `nothing: ${locateSaid}`}, not the prior subject ` +
        `${plan.prior_subject_version_id} — nothing recorded`);
      return 1;
    }

    const recordSaid = await mcp.call("release_record", {
      release_attempt_id: releaseAttemptId, status: "rolled_back",
      reason: verify.reason ?? "regression_established",
      idempotency_key: `release_record:${releaseAttemptId}:rolled_back`,
    });
    console.log(`release_record (rolled_back) -> ${recordSaid}`);
    return /^ERROR[: ]/.test(recordSaid) ? 1 : 0;
  } finally {
    if (worktree) removeRollbackWorktree(repoRoot, worktree);
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
