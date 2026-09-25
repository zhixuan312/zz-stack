/**
 * `npm run candidate-build` (0.76.0): the git-and-process half of `candidate_validate`'s build,
 * run by whoever has a shell — the IMPROVE agent, when `candidate_validate` answers
 * `build_required`. zz-core owns the decision, the lease and the record
 * (services/zz-core/src/eval/candidate-build-rules.ts); it has no checkout to build in and must
 * not run a candidate's code, so this CLI does it here — the same server-decides/CLI-executes
 * split replay (`replay/launch.ts`) and release (`release/apply.ts`) keep.
 *
 *   npm run candidate-build -- --candidate <id> --repo <path-to-a-checkout> [--gateway <url>]
 *     [--build-cmd "<command>"] [--gate-cmd "<command>"]
 *
 * It reads the candidate (`candidate_read`, the base subject under replay_read's own names),
 * fetches the base subject exactly as the replay launcher does — a catalog subject cloned
 * standalone from `--repo` at `v<declared_version>` and checked against its captured digest, a
 * third-party one fetched at its captured identity (`replay/git.ts`, `replay/third-party.ts`) —
 * applies the patch, and for a catalog subject installs the clone's own locked dependencies
 * (`npm ci --ignore-scripts`) and runs the build and the gate in it inside the replay sandbox
 * (`replay/sandbox.ts`): nothing under the operator's home or checkout is readable but a clone of
 * the console (`tree.ts`), nothing is writable but the clone and a throwaway home, and no
 * credential of this process reaches the build's environment. A third-party subject is somebody else's plugin with no build of this
 * repository's to run: its check is that the patch applies cleanly.
 *
 * Then it records the result through `candidate_build_record`, with the digest of the patch it
 * actually applied. A candidate failure (the patch does not apply, its install, build or gate
 * fails) is recorded and invalidates it. A failure of THIS host is never the candidate's
 * (host.ts): one found before cloning (no sandbox, a tool the preflight could not run, a tag
 * `--repo` lacks, a digest mismatch) records nothing, and one that surfaces mid-build (a timeout,
 * a missing tool, an unreachable registry or docker daemon) is recorded as `timeout` or `host`,
 * which returns the candidate to `recorded`.
 * Prints one JSON line `{ candidate_id, ok, stage, recorded }`. Exit 0: a passed build recorded;
 * 1: a failed build recorded; 2: refused or nothing recorded.
 *
 * Tokens: the platform token the zz-tool CLIs read (`$ZZ_TOKEN`, `$ZZ_TOKEN_FILE`, `~/.zz/token`
 * — `platformToken`), never on the command line, and never passed on to the build.
 */
import { createHash } from "node:crypto";
import { realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Mcp, McpError } from "@zz/mcp-client";

import { die, optional, parseArgs, platformToken, required } from "../lib/cli.js";
import { splitCommand } from "../lib/shell.js";
import { applyPatch, createWorktree, gitIn, readReleaseLock, removeWorktree, type Worktree } from "../replay/git.js";
import { idempotencyKey, releaseLockMismatch } from "../replay/plan.js";
import {
  detectSandbox, execSandboxed, makeSessionHome, removeSessionHome, sandboxContext, type SandboxContext,
} from "../replay/session.js";
import { fetchThirdParty, pinGitPlan, sourceKind, thirdPartyPlan } from "../replay/third-party.js";
import { DEFAULT_BUILD_CMD, DEFAULT_GATE_CMD, hostFailure, preflightCommands } from "./host.js";
import { cloneConsoleSibling, linkDockerPlugins } from "./tree.js";

/** COUPLED: `BUILD_LEASE_MS` (candidate-build-rules.ts, 60 minutes) must hold all three, the
 *  clone and the agent's own time to start this command. */
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const BUILD_TIMEOUT_MS = 10 * 60_000;
const GATE_TIMEOUT_MS = 15 * 60_000;
const PREFLIGHT_TIMEOUT_MS = 60_000;
/** The clone's own dependencies, from the release tag's own package-lock.json — never the
 *  operator's installed set, which may be a different release's. `--ignore-scripts`: no package
 *  lifecycle script runs (this lockfile has none today, and a candidate's patch may add one).
 *  Inside the sandbox, with the build's throwaway home as npm's cache: measured on zz-stack
 *  v0.75.0 (198 lock entries) at about 2 seconds from an empty cache. The operator's own npm
 *  cache is NOT exposed to seed it — it would put every package the operator ever installed, and
 *  the index naming them, within the candidate's reach, to save two seconds. */
const INSTALL_CMD = ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"] as const;
/** COUPLED: `LOG_TAIL_MAX` in services/zz-core/src/eval/candidate-build.ts. */
const LOG_TAIL_CHARS = 4000;
const DEFAULT_CLIENT = "zz-candidate-build";
const COMMIT_IDENTITY = ["-c", "user.name=zz-candidate-build", "-c", "user.email=zz-candidate-build@localhost", "-c", "commit.gpgsign=false"];

/** `candidate_read`'s answer, the fields this CLI reads — a local mirror, never imported from
 *  `services/zz-core/dist`: `packages/tools` crosses that boundary only over MCP. The subject
 *  fields carry replay_read's names, so `sourceKind`/`thirdPartyPlan` read them unchanged. */
interface CandidateRead {
  readonly candidate_id: string;
  readonly status: string;
  readonly patch_digest: string;
  readonly candidate_patchset: { readonly diff: string };
  readonly subject_plugin: string | null;
  readonly subject_source_locator: unknown;
  readonly subject_declared_version: string | null;
  readonly subject_release_digest: string | null;
  readonly subject_content_digest?: string | null;
  readonly subject_release_identity?: Record<string, unknown> | null;
  readonly build_requested_at: string | null;
  readonly build_recorded_at: string | null;
}

/** COUPLED: `BUILD_STAGES` in candidate-build-rules.ts. */
type BuildOutcome =
  | { readonly ok: true; readonly commands: readonly string[] }
  | {
    readonly ok: false; readonly stage: "apply" | "install" | "build" | "gate" | "timeout" | "host";
    readonly log_tail: string; readonly commands: readonly string[];
  };

interface BuildOpts {
  readonly repoRoot: string;
  readonly buildCmd: readonly string[];
  readonly gateCmd: readonly string[];
}

const tail = (s: string): string => s.slice(-LOG_TAIL_CHARS);
const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** Each build's own directory under the system temporary directory, deterministic in the
 *  candidate so a crashed earlier attempt is found and replaced. The tree's parent is this
 *  build's alone, so the console clone beside it is too. */
function buildBase(candidateId: string): { slug: string; base: string } {
  const slug = `cb-${sha256(candidateId).slice(0, 16)}`;
  return { slug, base: join("zz-candidate-build", slug) };
}

/** The base subject, fetched exactly as the replay launcher fetches it. Throws on anything that
 *  is this host's problem rather than the candidate's. */
async function fetchBase(read: CandidateRead, repoRoot: string, slug: string, base: string): Promise<Worktree> {
  if (!read.subject_plugin) throw new Error("candidate-build: the candidate's base subject names no located plugin");
  if (sourceKind(read) !== "catalog") {
    const plan = thirdPartyPlan(read);
    if (typeof plan === "string") throw new Error(`candidate-build: ${plan}`);
    return fetchThirdParty(await pinGitPlan(plan), repoRoot, slug);
  }
  if (!read.subject_declared_version || !read.subject_release_digest) {
    throw new Error("candidate-build: candidate_read carried no subject_declared_version/subject_release_digest");
  }
  const tree = createWorktree(repoRoot, slug, read.subject_declared_version, base);
  const mismatch = releaseLockMismatch(readReleaseLock(tree.path), read.subject_plugin,
    read.subject_declared_version, read.subject_release_digest);
  if (mismatch) {
    removeWorktree(tree);
    throw new Error(`candidate-build: ${mismatch}`);
  }
  return tree;
}

type Home = ReturnType<typeof makeSessionHome>;
interface Sandboxed {
  readonly sandbox: SandboxContext; readonly home: Home; readonly env: Record<string, string>;
  /** Host tools under the operator's home, re-allowed by exact path (`linkDockerPlugins`). */
  readonly tools: readonly string[];
}

/** The preflight (host.ts): every tool the install, build and gate will reach for, run once in
 *  the same sandbox, environment and home before anything is cloned. Throws — nothing recorded —
 *  naming the first that fails. */
function preflight(box: Sandboxed, opts: BuildOpts): void {
  for (const argv of preflightCommands(opts.buildCmd, opts.gateCmd)) {
    try {
      execSandboxed(box.sandbox, { writable: [box.home.root], readable: box.tools }, argv[0], argv.slice(1),
        { cwd: box.home.root, env: box.env, timeout: PREFLIGHT_TIMEOUT_MS });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      throw new Error(`candidate-build: this host cannot run \`${argv.join(" ")}\` inside the build's sandbox ` +
        `(${tail(`${e.stderr ?? ""}${e.stdout ?? ""}`.trim() || (e.message ?? "")).slice(-300)}) — a host problem, ` +
        "not the candidate's; fix it and run this again");
    }
  }
}

/** Builds one candidate. Resolves to the verdict to record; throws when this host cannot judge
 *  it at all — nothing is recorded then. Always removes what it made. */
async function buildCandidate(read: CandidateRead, opts: BuildOpts): Promise<BuildOutcome> {
  const tool = detectSandbox();
  if (!tool) {
    throw new Error("candidate-build: no working sandbox (sandbox-exec on macOS, bwrap on Linux) — " +
      "a candidate's build is its own code and never runs unsandboxed");
  }
  const catalog = sourceKind(read) === "catalog";
  const { slug, base } = buildBase(read.candidate_id);
  const baseDir = join(realpathSync(tmpdir()), base);
  rmSync(baseDir, { recursive: true, force: true });
  let tree: Worktree | undefined;
  const home = makeSessionHome();
  try {
    const tools = linkDockerPlugins(home.root);
    // No model credential either: the build has no model to reach, and `candidateEnv` keeps one
    // for a replay session.
    const { ANTHROPIC_API_KEY: _k, CLAUDE_CODE_OAUTH_TOKEN: _o, ...env } = home.env;
    const box: Sandboxed = { sandbox: sandboxContext(tool, opts.repoRoot, "npm"), home, env, tools };
    if (catalog) preflight(box, opts);

    tree = await fetchBase(read, opts.repoRoot, slug, base);
    try {
      applyPatch(tree, read.candidate_patchset.diff);
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      return { ok: false, stage: "apply", log_tail: tail(e.stderr || e.message || "git apply failed"), commands: ["git apply"] };
    }
    if (!catalog) return { ok: true, commands: ["git apply"] };
    // Committed before anything runs: the gate reads the clone through git, and a patch left in
    // the working tree reads as uncommitted work — scripts/gate/checks/marketplace.ts's
    // `git status --porcelain -- marketplace` failed every skill-editing candidate as "shelf is
    // stale". By the launcher's hardened git (replay/git.ts: no hooks, no fsmonitor, no in-tree
    // attributes or config), outside the sandbox, under a fixed identity, as a fetched
    // third-party source is snapshotted.
    gitIn(tree, ["add", "-A", "--", "."]);
    gitIn(tree, [...COMMIT_IDENTITY, "commit", "-q", "--no-verify", "--allow-empty", "-m", `candidate ${read.candidate_id}`]);

    const consoleClone = cloneConsoleSibling(opts.repoRoot, tree.path);
    const readable = [tree.gitDir, ...tools, ...(consoleClone ? [consoleClone] : [])];
    const commands: string[] = [];
    for (const [stage, argv, timeout] of [
      ["install", INSTALL_CMD, INSTALL_TIMEOUT_MS], ["build", opts.buildCmd, BUILD_TIMEOUT_MS],
      ["gate", opts.gateCmd, GATE_TIMEOUT_MS],
    ] as const) {
      commands.push(argv.join(" "));
      try {
        execSandboxed(box.sandbox, { writable: [home.root, tree.path], readable }, argv[0], [...argv.slice(1)],
          { cwd: tree.path, env, timeout, maxBuffer: 64 * 1024 * 1024 });
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        if (/ETIMEDOUT/.test(e.message ?? "")) {
          return { ok: false, stage: "timeout", log_tail: `${argv.join(" ")} did not finish in ${timeout / 60_000} minutes`, commands };
        }
        const output = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || (e.message ?? "");
        const host = hostFailure(output);
        if (host) return { ok: false, stage: "host", log_tail: tail(`host problem (${host}) during ${stage}:\n${output}`), commands };
        return { ok: false, stage, log_tail: tail(output), commands };
      }
    }
    return { ok: true, commands };
  } finally {
    if (tree) removeWorktree(tree);
    removeSessionHome(home);
    rmSync(baseDir, { recursive: true, force: true });
  }
}

// -------------------------------------------------------------------------------------------
// CLI

/** A connection that sat idle through a build of many minutes is one the server or a proxy may
 *  already have closed, and the first call after it then fails to reach the door at all — seen
 *  live against a keep-alive of seconds. The record goes through the idempotency ledger under one
 *  key, so trying it again is a replay, never a second write. A refusal or an HTTP error is an
 *  answer and is returned or thrown as is. */
async function callRetrying(mcp: Mcp, tool: string, args: unknown): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await mcp.call(tool, args);
    } catch (err) {
      if (attempt >= 3 || !(err instanceof McpError) || err.status !== undefined) throw err;
    }
  }
}

async function cliMain(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const candidateId = required(args, "candidate", "the candidate_id candidate_validate printed");
  const repoRoot = required(args, "repo", "a checkout of the repository to clone the base release from");
  const buildCmd = splitCommand(optional(args, "build-cmd", "the build command run in the clone") ?? DEFAULT_BUILD_CMD);
  const gateCmd = splitCommand(optional(args, "gate-cmd", "the gate command run in the clone") ?? DEFAULT_GATE_CMD);
  const gateway = (optional(args, "gateway", "the gateway base, e.g. http://localhost:18000") ?? process.env.ZZ_URL ?? "")
    .replace(/\/+$/, "");
  if (!gateway) die("no gateway: pass --gateway or set ZZ_URL", 2);
  const mcp = new Mcp(`${gateway}/eval/mcp`, { pat: platformToken(), client: DEFAULT_CLIENT });

  const said = await mcp.call("candidate_read", { candidate_id: candidateId });
  if (/^ERROR[: ]/.test(said)) die(`candidate_read refused: ${said}`, 2);
  const read = JSON.parse(said) as CandidateRead;
  if (read.status !== "awaiting_build" || !read.build_requested_at) {
    die(`candidate ${candidateId} is ${read.status}, not awaiting_build — call candidate_validate first`, 2);
  }
  // Before any clone: a second run would rebuild for minutes only to be refused at the record.
  if (read.build_recorded_at) die(`candidate ${candidateId}'s build is already recorded for this lease — call candidate_validate`, 2);
  // Digested on the bytes this process received and applies — what the record vouches for.
  const appliedDigest = sha256(read.candidate_patchset.diff);
  if (appliedDigest !== read.patch_digest) {
    die(`candidate ${candidateId}'s patch digests to ${appliedDigest}, not its recorded ${read.patch_digest}`, 2);
  }

  let outcome: BuildOutcome;
  try {
    outcome = await buildCandidate(read, { repoRoot, buildCmd, gateCmd });
  } catch (err) {
    die(`${(err as Error).message} — nothing recorded`, 2);
  }
  const record = {
    candidate_id: candidateId, patch_digest: appliedDigest,
    result: outcome.ok ? { ok: true, commands: outcome.commands }
      : { ok: false, stage: outcome.stage, log_tail: outcome.log_tail, commands: outcome.commands },
    // One key per lease: a lost response is retried as a replay, and a fresh lease is a fresh record.
    idempotency_key: idempotencyKey("candidate_build_record", candidateId, read.build_requested_at),
  };
  const recorded = await callRetrying(mcp, "candidate_build_record", record);
  if (/^ERROR[: ]/.test(recorded)) die(`candidate_build_record refused: ${recorded}`, 2);
  console.log(JSON.stringify({
    candidate_id: candidateId, ok: outcome.ok, stage: outcome.ok ? null : outcome.stage, recorded: true,
    ...(outcome.ok ? {} : { log_tail: outcome.log_tail }),
  }));
  return outcome.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(await cliMain(process.argv.slice(2)));
  } catch (err) {
    console.error((err as Error).message ?? String(err));
    process.exit(2);
  }
}
