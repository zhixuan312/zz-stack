/**
 * launchReplay (Task I-17, AC-31.1, AC-32.1): the IMPROVE-stage session launcher. Given one
 * `replay_start` result, it marks the run `running` (`replay_begin`), clones the repository
 * standalone at the SUBJECT's own release tag and checks that tag's plugin digest against the
 * one the subject was captured at, installs the subject plugin into a session-local
 * `CLAUDE_CONFIG_DIR` from that clone (never the live checkout, never the published shelf), runs
 * a headless candidate session fed only `actor` events against a headless simulated-person
 * session fed `actor` + `user_oracle` events, attempts the verifier step, and always ends by
 * calling `replay_close` — a clone failure, a digest mismatch or a runtime refusal closes the
 * run `failed` rather than leaving it open, exactly as the contract's Errors clause requires.
 *
 * Each session runs with an allowlisted environment and a temporary `HOME` (`candidateEnv`,
 * plan.ts): the launcher's own credentials — the principal's PAT and the proof allocation's
 * verifier token — stay in this process and are used only for its own MCP calls.
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
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync, closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync,
  readFileSync, realpathSync, rmSync, statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Mcp } from "@zz/mcp-client";

import { die, optional, parseArgs, platformToken, required } from "../lib/cli.js";
import {
  applyPatch, changedPaths, createWorktree, holdWorktree, readReleaseLock, removeWorktree, type Worktree,
} from "./git.js";
import {
  assertRoleEvents, candidateMcpConfig, candidatePrompt, idempotencyKey, MAX_TURNS_CAP, NO_MCP_CONFIG,
  refuseBeforeIO, releaseLockMismatch, simulatedPersonPersona, stillAsking, type RuntimeEnv,
} from "./plan.js";
import {
  detectSandbox, installPlugin, makeSessionHome, removeSessionHome, runTurn, sandboxContext, writeMcpConfig,
  type SandboxContext,
} from "./session.js";
import { fetchThirdParty, pinGitPlan, sourceKind, thirdPartyPlan, wrapAsMarketplace } from "./third-party.js";

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
  /** Null on a proof-split run: `replay_read` never names a proof case (replay-verifier.ts's
   *  `sealProofRead`), and nothing here needs it — the launcher never starts a run itself, and
   *  the agent's own proof `replay_start` names no case_id either. */
  case_id: string | null; split: string | null; team_slug: string;
  subject_version_id: string | null; candidate_id: string | null;
  subject_plugin: string | null; subject_source_locator: unknown;
  /** The subject's `declared_version` (a catalog plugin's platform release version) and the
   *  `release_identity.released_digest` it was captured at — what picks the clone's tag and what
   *  that tag's `plugins.lock.json` must agree with. For a candidate run, the base subject's. */
  subject_declared_version?: string | null; subject_release_digest?: string | null;
  /** A third-party subject's own capture (`third-party.ts`): its whole-plugin digest and the
   *  release identity its source is fetched at (`resolved_commit` / `tarball_integrity`) and
   *  checked against (`tree_digest`, every file). */
  subject_content_digest?: string | null; subject_release_identity?: Record<string, unknown> | null;
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
  /** Interview rounds, at most `MAX_TURNS_CAP` — the bound the server's run TTL is sized for. */
  readonly maxTurns?: number;
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
// No `ref` option: the commit a replay installs is the subject's own release tag, resolved from
// the run itself. An operator-chosen ref would measure whatever that ref holds under the
// subject's name.

/** `logPath` is null once a completed run's logs are deleted (`LOG_RETENTION_MS`); a failed run
 *  keeps them for the operator. `verifier` is the verifier step's own outcome line — on a
 *  completed run, the only place it survives the log. */
export interface LaunchResult {
  readonly status: "completed" | "failed"; readonly logPath: string | null; readonly verifier?: string;
  readonly cleanup_warning?: string;
}

/** Runs every removal on its own and settles the launch's answer. A rename that fails (a
 *  directory the session left busy, a permission it changed) must not skip the removals after
 *  it, and must not escape as a throw that replaces the answer.
 *
 *  DELIBERATE: a leftover never turns a completed run into a failed one. By then the run is
 *  closed and scored — reporting `failed` would send the agent to start a fresh run for evidence
 *  that already landed. It stays `completed`, with the leftovers in `cleanup_warning` (and on
 *  stderr); a failed run keeps `failed`, with them appended to the log it already kept. */
export function settleCleanup(
  result: LaunchResult, logPath: string, removals: readonly (readonly [string, () => void])[],
): LaunchResult {
  const leftovers: string[] = [];
  for (const [what, remove] of removals) {
    try { remove(); } catch (err) { leftovers.push(`${what}: ${(err as Error).message}`); }
  }
  if (!leftovers.length) return result;
  const warning = `cleanup failed: ${leftovers.join("; ")}`;
  if (result.status === "completed") {
    console.error(`launchReplay: ${warning}`);
    return { ...result, cleanup_warning: warning };
  }
  try {
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    appendFileSync(logPath, `# ${warning}\n`, "utf8");
  } catch { /* nowhere left to say it but the answer itself */ }
  return { ...result, cleanup_warning: warning };
}

/** `replay_close`'s own `result.produced` shape (migration 002), mirrored here — never imported
 *  from `services/zz-core/dist`, per the module note above: `packages/tools` crosses that
 *  boundary only over MCP, on the wire. Not exported: nothing outside this file needs the shape
 *  by name, only the value `collectProduced` below builds in it. */
interface ProducedArtifact { readonly path: string; readonly sha256: string; readonly bytes: number; readonly head: string }
interface ProducedRecord { readonly transcript: string; readonly artifacts: readonly ProducedArtifact[] }

const DEFAULT_MODEL = "sonnet";
const DEFAULT_MAX_TURNS = MAX_TURNS_CAP;
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

/** Logs retention. Both logs (the candidate's stream-json and the oracle-informed `.person`
 *  transcript) are deleted as soon as `replay_close` has taken a completed run — `produced` is
 *  the record from then on. A failed run's logs stay for the operator to read, and every launch
 *  first sweeps whatever any earlier one left older than this. */
const LOG_RETENTION_MS = 7 * 24 * 60 * 60_000;

function sweepOldLogs(logDir: string, now: number): void {
  for (const name of readdirSync(logDir)) {
    const p = join(logDir, name);
    try {
      if (now - statSync(p).mtimeMs > LOG_RETENTION_MS) rmSync(p, { force: true });
    } catch { /* a concurrent launch removed it first */ }
  }
}

function removeLogs(logPath: string): void {
  rmSync(logPath, { force: true });
  rmSync(`${logPath}.person`, { force: true });
}

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
 *  not a reason to fail the whole launch — the transcript alone is still worth storing.
 *
 *  Everything here reads a tree the candidate wrote, from OUTSIDE its sandbox, so every path is
 *  hostile: `ln -s ~/.ssh/id_ed25519 leak` shows up in `git status` as `leak`. Each path is
 *  judged by where it really lands (`realpathSync`, which also catches a symlinked parent
 *  directory) and must stay inside the clone, and then opened `O_NOFOLLOW | O_NONBLOCK` and
 *  `fstat`ed — only a regular file is read, so a symlink swapped in after the check, a FIFO or a
 *  device is refused rather than followed or blocked on. Nothing the session started can swap a
 *  path between the check and the read: `worktree` is the held tree (`holdWorktree`, git.ts),
 *  renamed out of every sandbox's writable path, so a command that outlived its turn can no
 *  longer change any path in it. Exported for `checks/replay-produced-symlink.ts`. */
export function collectProduced(
  worktree: Pick<Worktree, "path" | "gitDir">, transcript: string, secrets: readonly string[],
): ProducedRecord {
  let paths: string[] = [];
  let root = worktree.path;
  try {
    root = realpathSync(worktree.path);
    paths = changedPaths({ path: root, gitDir: worktree.gitDir });
  } catch { /* nothing to report — the transcript below still gets stored */ }

  const kept = paths
    .filter((p) => p && !/^(node_modules|dist)\//.test(p) && !/\/(node_modules|dist)\//.test(p) && !p.startsWith(".git/"))
    .slice(0, MAX_ARTIFACTS);

  const artifacts: ProducedArtifact[] = [];
  for (const rel of kept) {
    const buf = readInside(root, rel);
    if (!buf) continue;
    artifacts.push({
      path: rel, sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length,
      head: redact(buf.toString("utf8").slice(0, ARTIFACT_HEAD_CHARS), secrets),
    });
  }
  return { transcript: redact(transcript, secrets), artifacts };
}

/** `rel`'s bytes when it is a regular file really inside `root`; null for anything else — a
 *  symlink, a path whose parent is one, a FIFO, a device, or a file that is gone. */
function readInside(root: string, rel: string): Buffer | null {
  const abs = join(root, rel);
  let fd: number | undefined;
  try {
    if (!lstatSync(abs).isFile()) return null;
    const real = realpathSync(abs);
    if (!real.startsWith(`${root}/`)) return null;
    fd = openSync(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return null;
    return readFileSync(fd);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The one probe this function spawns is the sandbox's own trial run (`detectSandbox`): whether
 *  a sandbox can start is only knowable by starting one. Not even that without a model
 *  credential — the refusal for its absence needs no probe, so none runs. A `claude login` kept
 *  in the macOS keychain does not count: every session runs in a fresh `CLAUDE_CONFIG_DIR`. */
function runtimeEnv(): RuntimeEnv {
  const modelCredential = Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN);
  const sandbox = modelCredential ? detectSandbox() : undefined;
  if (process.platform === "win32") {
    return { platform: process.platform, shellPath: process.env.ComSpec ?? null, modelCredential, sandbox };
  }
  return { platform: process.platform, shellPath: existsSync("/bin/sh") ? "/bin/sh" : null, modelCredential, sandbox };
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

/** `registered -> running`. A refusal here (a run already swept, closed or cancelled, or a
 *  credential that is not the launching principal's own) throws, and the launch closes it
 *  `failed` — which the server then refuses too for a run already terminal, leaving it as is. */
async function beginRun(mcp: Mcp, replayRunId: string): Promise<void> {
  const said = await mcp.call("replay_begin", {
    replay_run_id: replayRunId, idempotency_key: idempotencyKey(replayRunId, "replay_begin"),
  });
  if (/^ERROR[: ]/.test(said)) throw new Error(`replay_begin refused: ${said}`);
}

/** Which tag to clone and what digest it must carry — a catalog subject only, whose release is a
 *  tag in this repository. A third-party subject is fetched from its own source instead
 *  (`fetchSubject`); installing this repository's bytes under its name would score the wrong plugin. */
function subjectRelease(read: ReplayReadResult): { declaredVersion: string; releasedDigest: string } {
  if (!read.subject_declared_version || !read.subject_release_digest) {
    throw new Error("launchReplay: replay_read carried no subject_declared_version/subject_release_digest " +
      "— the subject's release cannot be pinned");
  }
  return { declaredVersion: read.subject_declared_version, releasedDigest: read.subject_release_digest };
}

/** A catalog subject: a standalone clone of `--repo` at the subject's release tag, whose
 *  `plugins.lock.json` must carry the digest the subject was captured at. */
function cloneCatalogSubject(read: ReplayReadResult, start: ReplayStartResult, repoRoot: string, plugin: string): Worktree {
  const release = subjectRelease(read);
  const worktree = createWorktree(repoRoot, start.team_slug, release.declaredVersion);
  // replay_start recorded the tag it expected this clone to sit at; the two must agree, or the
  // run's own record names bytes this launch did not install.
  if (start.worktree_ref !== worktree.ref) {
    removeWorktree(worktree);
    throw new Error(`launchReplay: replay_start recorded ${start.worktree_ref} but the subject resolves to ${worktree.ref}`);
  }
  const mismatch = releaseLockMismatch(readReleaseLock(worktree.path), plugin, release.declaredVersion, release.releasedDigest);
  if (mismatch) {
    removeWorktree(worktree);
    throw new Error(`launchReplay: ${mismatch}`);
  }
  return worktree;
}

/** A third-party subject (`plugin_register`'s git, package or local_dir source): fetched at the
 *  identity it was captured at and checked against its digests (`third-party.ts`), and — like a
 *  catalog clone — refused when that identity is not the ref `replay_start` recorded. */
async function fetchSubject(read: ReplayReadResult, start: ReplayStartResult, repoRoot: string): Promise<Worktree> {
  const plan = thirdPartyPlan(read);
  if (typeof plan === "string") throw new Error(`launchReplay: ${plan}`);
  const worktree = fetchThirdParty(await pinGitPlan(plan), repoRoot, start.team_slug);
  if (start.worktree_ref !== worktree.ref) {
    removeWorktree(worktree);
    throw new Error(`launchReplay: replay_start recorded ${start.worktree_ref} but the subject resolves to ${worktree.ref}`);
  }
  return worktree;
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
 *  `replay_close`. Every failure after the two argument guards below still calls
 *  `replay_close(failed, ...)` before returning — everything that can fail, from the first
 *  directory this function creates onwards, is inside the one `try`.
 *
 *  The two guards stay outside it on purpose. With no gateway there is no door to close through.
 *  With no token, this `ReplayStartResult` is a same-key retry's (`token: null`): the credential,
 *  and the live run it drives, belong to whichever call got the fresh response — closing that
 *  run `failed` from here would kill somebody else's replay. `platformToken()` below can also
 *  stop the process before the `try`, when the launcher has no credential of its own — and then
 *  there is nothing to call `replay_close` with either. */
export async function launchReplay(start: ReplayStartResult, opts: LaunchOpts): Promise<LaunchResult> {
  const gatewayUrl = (opts.gatewayUrl ?? process.env.ZZ_URL ?? "").replace(/\/+$/, "");
  if (!gatewayUrl) throw new Error("launchReplay: no gatewayUrl — pass opts.gatewayUrl or set ZZ_URL");
  if (!start.token) throw new Error("launchReplay: no token on this ReplayStartResult — nothing to authenticate the candidate with");
  const token = start.token;
  const claudeBin = opts.claudeBin ?? "claude";
  const model = opts.model ?? DEFAULT_MODEL;
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const clientName = opts.clientName ?? DEFAULT_CLIENT;
  const ownPat = opts.ownPat ?? platformToken();

  const candidateMcp = new Mcp(`${gatewayUrl}/eval/mcp`, { pat: token, client: clientName });
  const ownMcp = new Mcp(`${gatewayUrl}/eval/mcp`, { pat: ownPat, client: clientName });

  // Never under `opts.repoRoot`: that is a real checkout, possibly shared with other work, and a
  // log file landing in it is a stray untracked file nobody asked for. `os.tmpdir()` outlives
  // this function's own cleanup, so a failed run's log is still there for the operator; a
  // completed run's is deleted (`LOG_RETENTION_MS`). The path is fixed before the `try` so the
  // `catch` can always name it; the directory itself is created inside.
  const logPath = join(tmpdir(), "zz-replay-logs", `${start.replay_run_id}.jsonl`);
  let worktree: Worktree | undefined;
  let candidateHome: ReturnType<typeof makeSessionHome> | undefined;
  let personHome: ReturnType<typeof makeSessionHome> | undefined;
  let result: LaunchResult;

  try {
    if (!Number.isInteger(maxTurns) || maxTurns < 0 || maxTurns > MAX_TURNS_CAP) {
      throw new Error(`launchReplay: maxTurns ${maxTurns} is outside 0..${MAX_TURNS_CAP} — the ` +
        "server's run TTL is sized for that bound, and a longer launch would be swept mid-run");
    }
    // The runtime-capability refusal fires before any directory is created or any process is
    // spawned. `refuseBeforeIO` is what makes that provable rather than merely true by
    // construction: see `checks/replay-launch-pure.ts`.
    const env = runtimeEnv();
    let sandbox: SandboxContext;
    [candidateHome, personHome, sandbox] = refuseBeforeIO(env, () => {
      const logDir = join(tmpdir(), "zz-replay-logs");
      mkdirSync(logDir, { recursive: true, mode: 0o700 });
      sweepOldLogs(logDir, Date.now());
      // `env.sandbox` is non-null here — refuseBeforeIO has already refused a host without one.
      const ctx = sandboxContext(env.sandbox!, opts.repoRoot, claudeBin);
      return [makeSessionHome({ replayToken: token, gatewayUrl }), makeSessionHome(), ctx] as const;
    });

    await beginRun(ownMcp, start.replay_run_id);

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

    const catalogSubject = sourceKind(actorRead) === "catalog";
    worktree = catalogSubject
      ? cloneCatalogSubject(actorRead, start, opts.repoRoot, plugin)
      : await fetchSubject(actorRead, start, opts.repoRoot);
    appendFileSync(logPath, `# source ${worktree.ref} in ${worktree.path} @ ${worktree.commit}\n`, "utf8");

    // I-18: no candidate executes before its own row exists (FR-36), and that row is what this
    // reads — a candidate replay installs the BASE subject's plugin (just resolved above) and
    // then applies the recorded patch on top of it, in the clone, before anything reads from
    // it. A subject_version_id run (no candidate_id) skips this entirely: there is no patch, and
    // the release tag's own commit is already what gets installed.
    if (actorRead.candidate_id) {
      const diff = actorRead.candidate_patchset?.diff;
      if (!diff) {
        throw new Error(
          `launchReplay: candidate ${actorRead.candidate_id} carries no patchset.diff to apply`);
      }
      applyPatch(worktree, diff);
      appendFileSync(logPath, `# applied candidate ${actorRead.candidate_id}'s patch into ${worktree.path}\n`, "utf8");
    }

    // A catalog clone is its own marketplace; a third-party plugin is wrapped in a one-plugin one.
    const marketplaceRoot = catalogSubject ? worktree.path : wrapAsMarketplace(worktree, plugin, candidateHome.root);
    // The launcher's repository is readable to the candidate, never writable: its own git works
    // read-only in the tree through the gitfile (git.ts), and nothing it does reaches what the
    // launcher's git reads after the session.
    const gitView = [worktree.gitDir];
    installPlugin(claudeBin, candidateHome, sandbox, marketplaceRoot, plugin, gitView);
    const candidateMcpPath = writeMcpConfig(
      candidateHome.configDir, candidateMcpConfig(plugin, gatewayUrl, token, clientName));
    const personMcpPath = writeMcpConfig(personHome.configDir, NO_MCP_CONFIG);

    const candidateSessionId = randomUUID();
    let candidate = runTurn(claudeBin, candidateHome, sandbox, {
      model, newSessionId: candidateSessionId, mcpConfigPath: candidateMcpPath, strictMcpConfig: true,
      prompt: candidatePrompt(actorEvents),
    }, worktree.path, logPath, gitView);

    const personaPrompt = simulatedPersonPersona(personEvents);
    for (let turn = 0; turn < maxTurns && stillAsking(candidate.lastText); turn += 1) {
      const person = runTurn(claudeBin, personHome, sandbox, {
        model, mcpConfigPath: personMcpPath, strictMcpConfig: true, appendSystemPrompt: personaPrompt,
        disallowedTools: DISALLOWED_PERSON_TOOLS,
        prompt: `They say:\n\n${candidate.lastText}\n\nReply as yourself.`,
      }, personHome.root, `${logPath}.person`);
      if (!person.lastText) break;
      candidate = runTurn(claudeBin, candidateHome, sandbox, {
        model, resumeSessionId: candidateSessionId, mcpConfigPath: candidateMcpPath, strictMcpConfig: true,
        prompt: person.lastText,
      }, worktree.path, logPath, gitView);
    }

    // Held before it is read: past this line no process the session left can change a path in it.
    worktree = holdWorktree(worktree);
    // produced is collected and persisted through replay_close BEFORE the verifier is ever
    // attempted — replay_score (the verifier) reads zz.replay_run.produced, and a run scored
    // before that column is written would find nothing there and refuse. Both calls go through
    // ownMcp, the launcher's own credential: replay_close refuses the run's own team credential.
    const produced = collectProduced(worktree, candidate.lastText, [token, ownPat, opts.verifierToken ?? ""]);
    await closeRun(
      ownMcp, start.replay_run_id, "completed", "candidate and simulated-person sessions finished", produced);

    const verifierNote = await attemptVerifier(ownMcp, start.replay_run_id);
    removeLogs(logPath);
    result = { status: "completed", logPath: null, verifier: verifierNote };
  } catch (err) {
    const reason = (err as Error).message;
    try {
      appendFileSync(logPath, `# launch failed: ${reason}\n`, "utf8");
    } catch { /* the log directory is not created until after the runtime check */ }
    await closeRun(ownMcp, start.replay_run_id, "failed", reason).catch(() => {
      // replay_close itself refusing must never mask the original failure this run is being
      // closed for — the reason above is already in the log.
    });
    result = { status: "failed", logPath };
  } finally {
    // The run itself was already closed above either way; see settleCleanup.
    const removals: (readonly [string, () => void])[] = [];
    if (worktree) { const w = worktree; removals.push(["worktree", () => removeWorktree(w)]); }
    if (candidateHome) { const h = candidateHome; removals.push(["candidate home", () => removeSessionHome(h)]); }
    if (personHome) { const h = personHome; removals.push(["person home", () => removeSessionHome(h)]); }
    // `result` is assigned on both paths above; the finally only ever sees it set.
    result = settleCleanup(result!, logPath, removals);
  }
  return result;
}

// -------------------------------------------------------------------------------------------
// CLI: `node packages/tools/dist/replay/launch.js --run <replay_run_id> --repo <path>
//        --token-file <path> [--verifier-token-file <path>]`
//
// The CLI's own argv is narrower than `launchReplay`'s own `start: ReplayStartResult` — in
// particular `replay_start`'s `token` and `dependency_modes` are not among replay_read's fields,
// so a CLI-driven run reads what it can from `replay_read` and takes the run-scoped token from a
// file. A caller that already holds the full `ReplayStartResult` should call `launchReplay`
// directly rather than round-tripping through this CLI.
//
// DELIBERATE: tokens arrive only as files, never argv or environment. argv is visible in `ps`
// and shell history; an environment variable is readable from `/proc/<pid>/environ` (or `ps eww`)
// by any process of the same user. The file must be a regular file owned by this user with no
// group or other permission bits (`umask 077` before writing it) — anything looser is refused,
// because a token another user could read is already spent. The launcher reads it once and never
// deletes it; the skill that wrote it does.

function readTokenFile(path: string, what: string): string {
  let st;
  try { st = lstatSync(path); } catch { return die(`${what}: ${path} does not exist`); }
  if (!st.isFile()) die(`${what}: ${path} is not a regular file`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) die(`${what}: ${path} is not owned by you`);
  if ((st.mode & 0o077) !== 0) {
    die(`${what}: ${path} is readable by others (mode ${(st.mode & 0o777).toString(8)}) — write it under umask 077`);
  }
  const token = readFileSync(path, "utf8").trim();
  if (!token) die(`${what}: ${path} is empty`);
  return token;
}

async function cliMain(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const replayRunId = required(args, "run", "the replay_run_id from replay_start");
  const repoRoot = required(args, "repo", "the repository to clone from");
  const claudeBin = optional(args, "claude-bin", "path to the claude binary") ?? undefined;
  const gatewayUrl = optional(args, "gateway", "the gateway base, e.g. http://localhost:18000") ?? undefined;
  const model = optional(args, "model", "the model for both sessions") ?? undefined;
  const token = readTokenFile(
    required(args, "token-file", "a mode-0600 file holding the run-scoped PAT replay_start returned"), "--token-file");
  // A proof run's own case is split: proof, sealed from a context: "search" reader whoever asks,
  // so it needs the verifier_token candidate_prove minted for the run's allocation. It stays in
  // this process — `candidateEnv` never passes it on.
  const verifierFile = optional(args, "verifier-token-file", "a mode-0600 file holding candidate_prove's verifier_token");
  const verifierToken = verifierFile ? readTokenFile(verifierFile, "--verifier-token-file") : undefined;

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
  const result = await launchReplay(start, { repoRoot, claudeBin, gatewayUrl: base, model, verifierToken });
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
