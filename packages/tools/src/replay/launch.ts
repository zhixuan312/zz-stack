/**
 * launchReplay (Task I-17, AC-31.1, AC-32.1): the IMPROVE-stage session launcher. Given one
 * `replay_start` result, it pins a worktree to an exact commit, installs the subject plugin into
 * a session-local `CLAUDE_CONFIG_DIR` from that pinned worktree (never the live checkout, never
 * the published shelf), runs a headless candidate session fed only `actor` events against a
 * headless simulated-person session fed `actor` + `user_oracle` events, attempts the verifier
 * step, and always ends by calling `replay_close` — a worktree failure or a runtime refusal
 * closes the run `failed` rather than leaving it open, exactly as the contract's Errors clause
 * requires.
 *
 * Two contract adjustments this task made to `replay_read` (agreed with the orchestrator; see
 * the worker report for the full reasoning) are what this file leans on rather than re-deriving:
 *   - `replay_read(role: "actor" | "simulated_person" | "evaluator")` returns that role's own
 *     events, filtered by `visibleEvents` (`replay-cases.ts`) — the one function every reader of
 *     a case's timeline goes through, server-side.
 *   - a credential bound to THIS run's own reserved team (the one the candidate session holds)
 *     is refused any role but `actor` there — `roleReadGuard`, in `replay-runs.ts`. The launcher
 *     itself repeats the same check client-side (`assertRoleEvents`, `plan.ts`) as defense in
 *     depth: a payload is never trusted just because the server was supposed to have filtered it.
 *
 * Task I-18 lifted this file's own candidate-replay refusal, now that `candidate_record` gives a
 * `candidate_id` run a row to read: `replay-runs.ts` resolves `subject_plugin` for a candidate
 * the same way it always did for a `subject_version_id` (through the recorded candidate's own
 * `base_subject_version_id`) and hands back `candidate_patchset` alongside it. This file applies
 * that patch into the pinned worktree with `applyPatch` (`git.ts`) — `git apply` of a temp file
 * holding the diff text, argv only — before `installPlugin` ever reads from the worktree, so the
 * plugin a candidate session runs is the patched one, not the base subject's own bytes.
 *
 * DELIBERATE: no import from `services/zz-core/dist`. `ReplayStartResult`/`ReplayReadResult`
 * below are local mirrors of that door's JSON, the same way `ops/call.ts` never imports a
 * service's types — `packages/tools` only ever crosses that boundary over MCP, on the wire.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Mcp } from "@zz/mcp-client";

import { die, optional, parseArgs, platformToken, required } from "../lib/cli.js";
import { applyPatch, createWorktree, listWorktrees, removeWorktree, type Worktree } from "./git.js";
import {
  assertRoleEvents, candidateMcpConfig, candidatePrompt, idempotencyKey, NO_MCP_CONFIG,
  refuseBeforeIO, simulatedPersonPersona, stillAsking, type RuntimeEnv,
} from "./plan.js";
import {
  installPlugin, makeConfigDir, removeConfigDir, runTurn, writeMcpConfig,
} from "./session.js";

// -------------------------------------------------------------------------------------------
// Shapes carried over the wire — see the module note above for why these are local, not imported.

export interface ReplayStartResult {
  replay_run_id: string;
  team_slug: string;
  worktree_ref: string;
  digest: string;
  token: string | null;
  token_already_issued: boolean;
  dependency_modes: readonly { surface: string; mode: string }[];
}

interface ReplayEvent { readonly seq: number; readonly actor: string; readonly visibility: string; readonly kind: string; readonly payload: unknown }

interface ReplayReadResult {
  case_id: string; split: string | null; team_slug: string;
  subject_version_id: string | null; candidate_id: string | null;
  subject_plugin: string | null; subject_source_locator: unknown;
  /** I-18: the recorded candidate's own patchset, present only for a `candidate_id` run —
   *  `replay-runs.ts` resolves `subject_plugin` for a candidate the same way it always did for
   *  a `subject_version_id` (through the base subject `candidate_record` bound at recording
   *  time), and hands this back alongside it so the launcher never re-derives it. */
  candidate_patchset?: { diff: string; files?: string[] } | null;
  events?: ReplayEvent[];
}

export interface LaunchOpts {
  readonly repoRoot: string;
  readonly claudeBin?: string;
  /** Defaults to `$ZZ_URL`. */
  readonly gatewayUrl?: string;
  /** The launching principal's own unbound credential — used for everything the candidate's
   *  team-bound token must never be trusted with (reading the simulated person's own events,
   *  the verifier attempt, `replay_close`). Defaults to `platformToken()`. */
  readonly ownPat?: string;
  readonly model?: string;
  readonly maxTurns?: number;
  /** What commit the worktree pins to. Defaults to `HEAD` of `repoRoot`. */
  readonly ref?: string;
  readonly clientName?: string;
  /** Task I-21's own addition: the `verifier_token` `candidate_prove` minted for this run's own
   *  proof allocation. When present, EVERY `replay_read` this launch makes — the candidate's own
   *  `role: actor` read included — carries `context: "verifier"` plus this token, because a
   *  proof-split case is sealed (`ERROR: proof is sealed`) from a `context: "search"` reader
   *  regardless of which credential asks (`sealedRows`, `replay-runs.ts`, is a function of
   *  `context` alone). The token itself never reaches either session's own prompt — it lives only
   *  in this process's own outgoing MCP calls. Omitted (the default) for a validation/evolve run,
   *  which reads under the ordinary `context: "search"` default instead. */
  readonly verifierToken?: string;
}

export interface LaunchResult { readonly status: "completed" | "failed"; readonly logPath: string }

/** `replay_close`'s own `result.produced` shape (migration 080), mirrored here — never imported
 *  from `services/zz-core/dist`, per the module note above: `packages/tools` crosses that
 *  boundary only over MCP, on the wire. Not exported: nothing outside this file needs the shape
 *  by name, only the value `collectProduced` below builds in it. */
interface ProducedArtifact { readonly path: string; readonly sha256: string; readonly bytes: number; readonly head: string }
interface ProducedRecord { readonly transcript: string; readonly artifacts: readonly ProducedArtifact[] }

const DEFAULT_MODEL = "sonnet";
const DEFAULT_MAX_TURNS = 8;
const DEFAULT_CLIENT = "zz-replay-launcher";
const DISALLOWED_PERSON_TOOLS = ["Skill", "Task", "Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch"];

// FIX (Task I-17/I-19 dispatch): the candidate's own worktree is what replay_score must read to
// score the replay it actually ran, never the original recorded case again. Bounded so a large
// diff or a chatty final turn cannot blow past what a model-backed measure's own request budget
// can carry: `ARTIFACT_HEAD_CHARS` per file, `MAX_ARTIFACTS` files, `git status --porcelain`
// (never a directory walk) as the source of "what this session produced" — the worktree already
// carries the base subject's own tracked files, and a candidate replay's applied patch, so a walk
// would report everything the base subject shipped as something this session wrote.
const ARTIFACT_HEAD_CHARS = 2000;
const MAX_ARTIFACTS = 20;
const REDACTED = "[REDACTED]";

/** Every occurrence of every secret this run held, replaced — never partial, never case-folded:
 *  a token is exact bytes or it is not the token. Applied to both the transcript and every
 *  artifact head before `produced` ever leaves this process. Exported for
 *  `checks/replay-launch-pure.ts` — the one pure slice of this file's own fix, provable with no
 *  process, no worktree and no database. */
export function redact(s: string, secrets: readonly string[]): string {
  let out = s;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join(REDACTED);
  }
  return out;
}

/** What the session left behind in its own worktree, bounded and redacted — `replay_close`'s own
 *  `result.produced`, and the only thing `replay_score` (Task I-19's own fix) has to judge. Never
 *  throws: a worktree `git status` cannot read (already torn down, an unexpected git failure) is
 *  not a reason to fail the whole launch — the transcript alone is still worth storing. */
function collectProduced(worktreePath: string, transcript: string, secrets: readonly string[]): ProducedRecord {
  let statusOut = "";
  try {
    statusOut = execFileSync("git", ["status", "--porcelain"], {
      cwd: worktreePath, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch { /* nothing to report — the transcript below still gets stored */ }

  const paths = statusOut.split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    // The status code is always the first two characters ("??", " M", "A ", …); the path is
    // everything after the first space, quoted by git when it holds a space of its own.
    .map((l) => l.slice(l.indexOf(" ") + 1).trim().replace(/^"(.*)"$/, "$1"))
    .filter((p) => p && !/^(node_modules|dist)\//.test(p) && !/\/(node_modules|dist)\//.test(p) && !p.startsWith(".git/"))
    .slice(0, MAX_ARTIFACTS);

  const artifacts: ProducedArtifact[] = paths.map((rel) => {
    try {
      const buf = readFileSync(join(worktreePath, rel));
      return {
        path: rel, sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length,
        head: redact(buf.toString("utf8").slice(0, ARTIFACT_HEAD_CHARS), secrets),
      };
    } catch {
      return { path: rel, sha256: "", bytes: 0, head: "(could not be read — removed, or not a regular file)" };
    }
  });

  return { transcript: redact(transcript, secrets), artifacts };
}

function runtimeEnv(): RuntimeEnv {
  const modelCredential = Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN);
  if (process.platform === "win32") {
    return { platform: process.platform, shellPath: process.env.ComSpec ?? null, modelCredential };
  }
  return { platform: process.platform, shellPath: existsSync("/bin/sh") ? "/bin/sh" : null, modelCredential };
}

async function readRole(
  mcp: Mcp, replayRunId: string, role: "actor" | "simulated_person", verifierToken: string | undefined,
): Promise<{ read: ReplayReadResult; events: readonly ReplayEvent[] }> {
  const said = await mcp.call("replay_read", {
    replay_run_id: replayRunId, role,
    // A proof-split case is sealed from a context: "search" reader whoever asks — see the
    // LaunchOpts.verifierToken module note above.
    ...(verifierToken ? { context: "verifier", verifier_token: verifierToken } : {}),
  });
  if (/^ERROR[: ]/.test(said)) throw new Error(`replay_read(role: ${role}) refused: ${said}`);
  const read = JSON.parse(said) as ReplayReadResult;
  const events = assertRoleEvents(read.events ?? [], role);
  return { read, events };
}

/** The verifier step the contract names. Task I-17's own worker report left this calling
 *  `evaluation_assess` against `replayRunId` as if it were an `eval_run_id` — nothing mints an
 *  `eval_run` for a replay run, so that call could only ever come back refused (`notes.md`'s
 *  "OPEN (I-17 -> I-18/I-19)" line). Task I-19's `replay_score` (`replay-score.ts`) is the real
 *  scoring path: it reads the run's own protocol/subject off `zz.replay_run` directly, needs no
 *  `eval_run_id`, and is what this now calls. Still best effort, never blocking: a refusal is
 *  recorded in the log verbatim — never turned into a fabricated score. Called AFTER `closeRun`
 *  (see the caller below) — `replay_score` reads `zz.replay_run.produced`, which only exists
 *  once `closeRun` has written it, so scoring before closing would find nothing to score. */
async function attemptVerifier(mcp: Mcp, replayRunId: string): Promise<string> {
  try {
    const said = await mcp.call("replay_score", {
      replay_run_id: replayRunId, idempotency_key: idempotencyKey(replayRunId, "verify"),
    });
    return `verifier (replay_score): ${said}`;
  } catch (err) {
    return `verifier (replay_score): call failed — ${(err as Error).message}`;
  }
}

async function closeRun(
  mcp: Mcp, replayRunId: string, status: "completed" | "failed", reason: string,
  produced?: ProducedRecord,
): Promise<void> {
  const said = await mcp.call("replay_close", {
    replay_run_id: replayRunId, status,
    idempotency_key: idempotencyKey(replayRunId, "replay_close"),
    ...(produced ? { result: { produced } } : {}),
  });
  if (/^ERROR[: ]/.test(said)) {
    // replay_close itself refused. Nothing left to retry from inside this call — the caller's
    // own log already carries `reason`, and this is appended so the refusal is not lost either.
    throw new Error(`replay_close refused (${status}, ${reason}): ${said}`);
  }
}

/** Runs one replay: candidate against simulated person, best-effort verifier, always a terminal
 *  `replay_close`. Every failure path still calls `replay_close(failed, ...)` before returning —
 *  see the module note for why a runtime refusal and a worktree failure are not exceptions to
 *  that rule. */
export async function launchReplay(start: ReplayStartResult, opts: LaunchOpts): Promise<LaunchResult> {
  const gatewayUrl = (opts.gatewayUrl ?? process.env.ZZ_URL ?? "").replace(/\/+$/, "");
  if (!gatewayUrl) throw new Error("launchReplay: no gatewayUrl — pass opts.gatewayUrl or set ZZ_URL");
  if (!start.token) throw new Error("launchReplay: no token on this ReplayStartResult — nothing to authenticate the candidate with");
  const claudeBin = opts.claudeBin ?? "claude";
  const model = opts.model ?? DEFAULT_MODEL;
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const clientName = opts.clientName ?? DEFAULT_CLIENT;

  const candidateMcp = new Mcp(`${gatewayUrl}/eval/mcp`, { pat: start.token, client: clientName });
  const ownMcp = new Mcp(`${gatewayUrl}/eval/mcp`, { pat: opts.ownPat ?? platformToken(), client: clientName });

  // Never under `opts.repoRoot`: that is a real checkout, possibly shared with other work, and a
  // log file landing in it is a stray untracked file nobody asked for. `os.tmpdir()` outlives
  // this function's own cleanup — the caller reads the log after the worktree and config dirs
  // are already gone.
  const logDir = join(tmpdir(), "zz-replay-logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${start.replay_run_id}.jsonl`);
  let worktree: Worktree | undefined;
  const candidateConfigDir = makeConfigDir();
  const personConfigDir = makeConfigDir();

  try {
    // The runtime-capability refusal fires before `createWorktree` — and therefore before any
    // git process — is ever spawned. `refuseBeforeIO` is what makes that provable rather than
    // merely true by construction: see `checks/replay-launch-pure.ts`.
    worktree = refuseBeforeIO(runtimeEnv(), () => createWorktree(opts.repoRoot, start.team_slug, opts.ref));
    // Logged for the concurrency proof: two launches against the same repoRoot must never
    // register the same path here, whatever else either run is doing at the moment it logs.
    appendFileSync(logPath, `# worktree ${worktree.path} @ ${worktree.commit}\n` +
      `# repoRoot worktrees: ${listWorktrees(opts.repoRoot).join(", ")}\n`, "utf8");

    // The candidate holds `start.token`, a credential bound to its own reserved team — the same
    // one `roleReadGuard` on the server refuses for anything but `role: "actor"`. Reading with
    // it here, rather than with the launcher's own credential, is deliberate: it is exactly the
    // read the candidate session could make itself if it reached this door directly, so a
    // regression in that guard shows up here first.
    const { read: actorRead, events: actorEvents } =
      await readRole(candidateMcp, start.replay_run_id, "actor", opts.verifierToken);
    const { events: personEvents } =
      await readRole(ownMcp, start.replay_run_id, "simulated_person", opts.verifierToken);

    const plugin = actorRead.subject_plugin;
    if (!plugin) {
      const why = actorRead.candidate_id
        ? "this run replays candidate_id " + actorRead.candidate_id + ", whose own " +
          "base_subject_version_id names a plugin never located"
        : "subject_version_id names a plugin never located — call plugin_locate first";
      throw new Error(`launchReplay: cannot resolve which plugin to install — ${why}`);
    }

    // I-18: no candidate executes before its own row exists (FR-36), and that row is what this
    // reads — a candidate replay installs the BASE subject's plugin (just resolved above) and
    // then applies the recorded patch on top of it, in the worktree, before anything reads from
    // that worktree. A subject_version_id run (no candidate_id) skips this entirely: there is no
    // patch, and the pinned worktree's own commit is already what gets installed.
    if (actorRead.candidate_id) {
      const diff = actorRead.candidate_patchset?.diff;
      if (!diff) {
        throw new Error(
          `launchReplay: candidate ${actorRead.candidate_id} carries no patchset.diff to apply`);
      }
      applyPatch(worktree.path, diff);
      appendFileSync(logPath, `# applied candidate ${actorRead.candidate_id}'s patch into ${worktree.path}\n`, "utf8");
    }

    installPlugin(claudeBin, candidateConfigDir, worktree.path, plugin);
    const candidateMcpPath = writeMcpConfig(
      candidateConfigDir, candidateMcpConfig(plugin, gatewayUrl, start.token, clientName));
    const personMcpPath = writeMcpConfig(personConfigDir, NO_MCP_CONFIG);

    const candidateSessionId = randomUUID();
    let candidate = runTurn(claudeBin, candidateConfigDir, {
      model, newSessionId: candidateSessionId, mcpConfigPath: candidateMcpPath, strictMcpConfig: true,
      prompt: candidatePrompt(actorEvents),
    }, worktree.path, logPath);

    const personaPrompt = simulatedPersonPersona(personEvents);
    for (let turn = 0; turn < maxTurns && stillAsking(candidate.lastText); turn += 1) {
      const person = runTurn(claudeBin, personConfigDir, {
        model, mcpConfigPath: personMcpPath, strictMcpConfig: true, appendSystemPrompt: personaPrompt,
        disallowedTools: DISALLOWED_PERSON_TOOLS,
        prompt: `They say:\n\n${candidate.lastText}\n\nReply as yourself.`,
      }, worktree.path, `${logPath}.person`);
      if (!person.lastText) break;
      candidate = runTurn(claudeBin, candidateConfigDir, {
        model, resumeSessionId: candidateSessionId, mcpConfigPath: candidateMcpPath, strictMcpConfig: true,
        prompt: person.lastText,
      }, worktree.path, logPath);
    }

    // FIX: produced is collected and persisted through replay_close BEFORE the verifier is ever
    // attempted — replay_score (the verifier) reads zz.replay_run.produced, and a run scored
    // before that column is written would find nothing there and refuse (replay-score.ts's own
    // fix). The team's PAT is still valid for this call (closeRun uses ownMcp, an unbound
    // credential, not the team-scoped one anyway), and replay_score itself needs no live team —
    // it reads the row straight off the database — so closing first costs nothing and buys the
    // ordering the contract now requires.
    const produced = collectProduced(worktree.path, candidate.lastText, [start.token, opts.ownPat ?? platformToken()]);
    await closeRun(
      ownMcp, start.replay_run_id, "completed", "candidate and simulated-person sessions finished", produced);

    const verifierNote = await attemptVerifier(ownMcp, start.replay_run_id);
    appendFileSync(logPath, `# ${verifierNote}\n`, "utf8");

    return { status: "completed", logPath };
  } catch (err) {
    const reason = (err as Error).message;
    try {
      appendFileSync(logPath, `# launch failed: ${reason}\n`, "utf8");
    } catch { /* logPath's own directory may not exist yet if the failure was very early */ }
    await closeRun(ownMcp, start.replay_run_id, "failed", reason).catch(() => {
      // replay_close itself refusing must never mask the original failure this run is being
      // closed for — the reason above is already in the log and in the thrown error below.
    });
    return { status: "failed", logPath };
  } finally {
    if (worktree) removeWorktree(opts.repoRoot, worktree);
    removeConfigDir(candidateConfigDir);
    removeConfigDir(personConfigDir);
  }
}

// -------------------------------------------------------------------------------------------
// CLI: `node packages/tools/dist/replay/launch.js --run <replay_run_id> --repo <path>`
//
// The CLI's own argv is fixed by the plan (`--run`, `--repo`), which is narrower than
// `launchReplay`'s own `start: ReplayStartResult` — in particular `replay_start`'s `token` and
// `dependency_modes` are not among replay_read's fields, so a CLI-driven run reads what it can
// from `replay_read` and takes the run-scoped token from `$REPLAY_TOKEN`. A caller that already
// holds the full `ReplayStartResult` (the IMPROVE skill, immediately after its own `replay_start`
// call) should call `launchReplay` directly rather than round-tripping through this CLI — this
// entry point exists for the npm script and for a person re-running a launch by hand.

async function cliMain(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const replayRunId = required(args, "run", "the replay_run_id from replay_start");
  const repoRoot = required(args, "repo", "the repository to worktree from");
  const claudeBin = optional(args, "claude-bin", "path to the claude binary") ?? undefined;
  const gatewayUrl = optional(args, "gateway", "the gateway base, e.g. http://localhost:18000") ?? undefined;
  const model = optional(args, "model", "the model for both sessions") ?? undefined;
  const ref = optional(args, "ref", "the commit/ref to pin the worktree to") ?? undefined;
  const token = (process.env.REPLAY_TOKEN ?? "").trim();
  if (!token) die("REPLAY_TOKEN is required: the run-scoped PAT replay_start returned for this run");
  // Task I-21's own addition: a proof run's own case is split: proof, sealed from a
  // context: "search" reader whoever asks — this CLI's own team_slug/sandbox_ref lookup below
  // needs the SAME verifier_token candidate_prove minted for this run's own allocation, or it is
  // refused before launchReplay is ever reached. `--verifier-token`, falling back to
  // `$VERIFIER_TOKEN` the same way `--run`'s own token falls back to `$REPLAY_TOKEN` — a secret
  // is better left out of argv (visible in `ps`, shell history, logs) when either works, so the
  // flag exists for the plan's own named contract and the env var for how it is actually passed.
  const verifierToken =
    (optional(args, "verifier-token", "the verifier_token candidate_prove minted for this run's proof allocation")
      ?? process.env.VERIFIER_TOKEN ?? "").trim() || undefined;

  const base = (gatewayUrl ?? process.env.ZZ_URL ?? "").replace(/\/+$/, "");
  if (!base) die("no gateway: pass --gateway or set ZZ_URL");
  const ownMcp = new Mcp(`${base}/eval/mcp`, { pat: platformToken(), client: DEFAULT_CLIENT });
  const said = await ownMcp.call("replay_read", {
    replay_run_id: replayRunId,
    ...(verifierToken ? { context: "verifier", verifier_token: verifierToken } : {}),
  });
  if (/^ERROR[: ]/.test(said)) die(`replay_read refused: ${said}`, 2);
  const row = JSON.parse(said) as { team_slug: string; sandbox_ref: string; environment_digest: string };

  const start: ReplayStartResult = {
    replay_run_id: replayRunId, team_slug: row.team_slug, worktree_ref: row.sandbox_ref,
    digest: row.environment_digest, token, token_already_issued: true,
    // replay_read carries no dependency_modes — only replay_start's own response does. A
    // CLI-driven run therefore proceeds without them; a caller that needs them calls
    // launchReplay directly with the full ReplayStartResult instead.
    dependency_modes: [],
  };
  const result = await launchReplay(start, { repoRoot, claudeBin, gatewayUrl: base, model, ref, verifierToken });
  console.log(JSON.stringify(result));
  return result.status === "completed" ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(await cliMain(process.argv.slice(2)));
  } catch (err) {
    console.error((err as Error).message ?? String(err));
    process.exit(2);
  }
}
