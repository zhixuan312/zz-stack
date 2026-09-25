/**
 * launch.ts's pure slice (Task I-17): every decision that needs no filesystem, no subprocess and
 * no network to make — argv arrays, role filtering, the runtime-capability refusal, and the
 * small text/JSON shapes the impure layers (git.ts, session.ts) hand to a real `git`/`claude`
 * process. Kept apart from them so `checks/replay-launch-pure.ts` can prove each one on values
 * alone, the same split `replay-runs.ts` draws around `dependencyAction`/`sealedRows`.
 *
 * DELIBERATE: every argv builder below returns `string[]`, never a string. `execFileSync`/`spawn`
 * take an argv array and never touch a shell, so nothing built here can be reinterpreted by one —
 * a worktree path or a plugin name with a space in it is one array element, not a token boundary.
 */
import { createHash } from "node:crypto";

// -------------------------------------------------------------------------------------------
// Role boundary — a second, client-side check of the same rule replay_read's `roleReadGuard`
// and `visibleEvents` already enforce server-side. Redundant on purpose: the candidate session
// holds a real, network-reachable credential, so "the server already filtered this" is not
// something the launcher gets to assume about a payload it is about to hand that session.

type ReplayRole = "actor" | "simulated_person";

interface EventLike { readonly seq: number; readonly visibility: string }

const ROLE_VISIBILITY: Readonly<Record<ReplayRole, ReadonlySet<string>>> = {
  actor: new Set(["actor"]),
  simulated_person: new Set(["actor", "user_oracle"]),
};

/** Throws the moment one event's visibility does not belong to `role` — never filters silently.
 *  A silent filter would turn a server defect (or a launcher bug asking for the wrong role) into
 *  "the candidate saw fewer events than it should have", which is a much quieter failure than
 *  the one this function is here to make loud. */
export function assertRoleEvents<T extends EventLike>(events: readonly T[], role: ReplayRole): readonly T[] {
  const allowed = ROLE_VISIBILITY[role];
  for (const e of events) {
    if (!allowed.has(e.visibility)) {
      throw new Error(
        `launchReplay: got a "${e.visibility}" event for role "${role}" — refusing to hand it to ` +
        `that session (allowed: ${[...allowed].join(", ")})`);
    }
  }
  return events;
}

// -------------------------------------------------------------------------------------------
// Runtime capability — the refusal fires before any argv is built or any process spawned.

export interface RuntimeEnv {
  readonly platform: NodeJS.Platform;
  /** `/bin/sh` on POSIX, `%ComSpec%` on Windows — whichever this platform's own shell-capable
   *  check looks for. Passed in rather than read here so the pure decision takes a value, not a
   *  filesystem probe. */
  readonly shellPath: string | null;
  /** Which OS sandbox (`sandbox.ts`) this host can start. Absent means "not checked" (the pure
   *  checks); null means checked and none works — refused, with no unsandboxed fallback. */
  readonly sandbox?: "sandbox-exec" | "bwrap" | null;
  /** Whether a model credential reaches a headless session. The launcher gives each session a
   *  fresh `CLAUDE_CONFIG_DIR`, which holds no login, so only `ANTHROPIC_API_KEY` or
   *  `CLAUDE_CODE_OAUTH_TOKEN` in the environment can authenticate it. Absent means "not
   *  checked" (the pure checks), false means checked and missing. */
  readonly modelCredential?: boolean;
}

type RuntimeCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** A launch needs a real child-process-capable runtime under it — `git worktree`, the `claude`
 *  binary, and the marketplace-install commands are all external processes, none of them
 *  optional. `shellPath` absent means exactly what its name says: not "the shell wasn't found in
 *  PATH", but "this runtime has no shell to hand `execFileSync`/`spawn` at all" (a locked-down
 *  sandbox, a worker runtime with no `child_process` backing it). */
export function shellCapableRuntime(env: RuntimeEnv): RuntimeCheck {
  if (!env.shellPath) {
    return {
      ok: false,
      reason: `launchReplay: no shell-capable runtime on ${env.platform} — git and claude both ` +
        "run as child processes, and this environment has neither a shell nor a way to spawn one",
    };
  }
  if (env.sandbox === null) {
    return {
      ok: false,
      reason: `launchReplay: no working OS sandbox on ${env.platform} — a replay session runs as ` +
        "you with bypassPermissions, and only sandbox-exec (macOS) or bwrap (Linux) stops it reading " +
        "your own files by absolute path. Install bubblewrap, or run the launcher outside any " +
        "enclosing sandbox; there is no unsandboxed mode",
    };
  }
  if (env.modelCredential === false) {
    return {
      ok: false,
      reason: "launchReplay: no model credential for a headless session — each session runs in a " +
        "fresh CLAUDE_CONFIG_DIR with no login, so set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN " +
        "(`claude setup-token` mints one) in the launcher's environment",
    };
  }
  return { ok: true };
}

/** The one gate every impure step in launch.ts passes through first: `run` is never called when
 *  `env` is not shell-capable, so a caller proving that (by handing `run` a stub that throws) is
 *  proving the refusal actually happens before any I/O — not merely that the function returns a
 *  refusal value nobody acted on. Mirrors `checks/replay-team-pure.ts`'s own pattern for
 *  `provisionReplayTeam`'s pre-query refusal. */
export function refuseBeforeIO<T>(env: RuntimeEnv, run: () => T): T {
  const capable = shellCapableRuntime(env);
  if (!capable.ok) throw new Error(capable.reason);
  return run();
}

// -------------------------------------------------------------------------------------------
// git argv — a standalone clone per run, pinned to the subject's own release tag.
//
// DELIBERATE: a clone, never `git worktree add`. A worktree shares the operator's real `.git`
// (its objects, its refs, its hooks and config), and the candidate session runs with
// `bypassPermissions` inside it — `git -C .. update-ref`, a rewritten hook, or a ref deleted
// from the worktree lands in the operator's own repository. `--no-hardlinks` copies the object
// store rather than linking it, and `gitRemoveOriginArgv` drops the one remaining pointer back
// at `repoRoot`, so nothing the session does inside the clone can reach the checkout it came from.

/** One clone directory per run, named from its team slug — team slugs are already unique per
 *  run (`provisionReplayTeam`), so two concurrent launches can never collide on this path. */
export function worktreeDirName(teamSlug: string): string {
  return `replay-${teamSlug}`;
}

/** The git tag a catalog subject's release lives at. A catalog plugin's `declared_version` IS
 *  the platform's release version (`register-plugins.ts`), and `/release` tags that release
 *  `v<version>` — so this is the one ref that holds exactly the bytes the subject was captured
 *  from, never the operator's `HEAD` or a ref somebody typed. */
export function releaseTagFor(declaredVersion: string): string {
  return `v${declaredVersion}`;
}

/** The full ref `releaseTagFor` names — what a run records as its `sandbox_ref`/`worktree_ref`.
 *  COUPLED: `replay_start` (services/zz-core/src/eval/replay-runs.ts) spells the same string
 *  server-side, and the launcher refuses a run whose recorded ref differs from this. */
export function releaseRefFor(declaredVersion: string): string {
  return `refs/tags/${releaseTagFor(declaredVersion)}`;
}

/** Ahead of every git subcommand the launcher runs (`git.ts`'s one `git()` helper). The clone's
 *  working tree is the candidate's to write, so its `.git/config` is untrusted input once a
 *  session has run — the sandbox keeps `.git` read-only (sandbox.ts), and this is the second
 *  half: a command-line `-c` outranks every config file, so neither an fsmonitor command nor a
 *  hooks directory can come from anywhere the candidate could have touched. */
export const GIT_HARDENED_ARGS = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"] as const;

/** The whole environment a launcher git process runs with — never the launcher's own, which can
 *  hold `ZZ_TOKEN`. No system or global config (a filter driver or `include.path` there would be
 *  one more command git runs), no prompt, and no optional index write from `status`. */
export function hardenedGitEnv(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "SystemRoot"]) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
}

export const gitCloneArgv = (source: string, dest: string): string[] =>
  ["clone", "--no-hardlinks", "--no-checkout", "--quiet", source, dest];
export const gitRemoveOriginArgv = (): string[] => ["remote", "remove", "origin"];
/** `^{commit}` peels an annotated tag to the commit it names; `refs/tags/` keeps a branch that
 *  happens to share the tag's name from ever answering instead. */
export const gitResolveTagArgv = (tag: string): string[] =>
  ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`];
export const gitCheckoutDetachArgv = (commit: string): string[] =>
  ["checkout", "--detach", "--quiet", commit];
/** NUL-separated, so a path with a space, a quote or a newline arrives as itself. */
export const gitStatusArgv = (): string[] => ["status", "--porcelain", "-z", "--untracked-files=all"];

interface LockEntryLike { readonly version?: unknown; readonly digest?: unknown }

/** The component-digest comparison between what the clone is about to install and what the
 *  subject was captured as. `plugins.lock.json`'s own `digest` for a plugin is the packager's
 *  hash of everything that plugin ships, and `register-plugins.ts` copied that same value into
 *  `zz.plugin_version.digest` at release — which `plugin_locate` then froze into the subject's
 *  `release_identity.released_digest`. Equal means the tag holds the subject's bytes; anything
 *  else means the launcher would be measuring a different plugin than the one it was asked to.
 *  Null when they agree; otherwise the refusal text. */
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
      `but the subject was captured at ${releasedDigest} — refusing to replay a different plugin`;
  }
  return null;
}

/** I-18: a recorded candidate's own patch, applied into the pinned worktree before anything
 *  installs from it — `patchPath` is a file this same run wrote its diff text to (see
 *  `git.ts`'s `applyPatch`), never the diff text itself on the command line, so an unusual
 *  character in a patch line is never handed to a shell to reinterpret. `--whitespace=nowarn`
 *  because a candidate's own diff may carry trailing-whitespace edits the plugin under test
 *  made on purpose; this launcher installs and runs the patched plugin, it does not lint it. */
export const gitApplyArgv = (patchPath: string): string[] =>
  ["apply", "--whitespace=nowarn", patchPath];

// -------------------------------------------------------------------------------------------
// claude plugin argv — install at an exact digest: a LOCAL marketplace source pointed at the
// pinned worktree, never the live checkout and never the published GitHub shelf, so what gets
// installed is exactly the commit `git update-ref` pinned above and nothing a concurrent edit to
// the caller's own checkout could move underneath a running session.

export const claudeMarketplaceAddArgv = (localMarketplaceRoot: string): string[] =>
  ["plugin", "marketplace", "add", localMarketplaceRoot];
export const claudeInstallArgv = (plugin: string, marketplace: string): string[] =>
  ["plugin", "install", "-y", `${plugin}@${marketplace}`];

// -------------------------------------------------------------------------------------------
// claude -p argv — one headless turn. Proven live by testing/eval-step.sh's own use of exactly
// these flags; not invented here.

export interface SessionArgvOpts {
  readonly model: string;
  readonly prompt: string;
  /** Omit for the first turn of a session; the session id to continue on every later turn. */
  readonly resumeSessionId?: string;
  /** Only the first turn sets this — `claude -p --session-id <id>` is how a fresh session gets an
   *  id the launcher already knows, so a crash before the first response still leaves a log
   *  named the way the caller expects. */
  readonly newSessionId?: string;
  /** Absolute path to a `{"mcpServers": {...}}` file. Omitted entirely (never an empty object
   *  inline) for a session that gets no tools at all — the simulated person. */
  readonly mcpConfigPath?: string;
  /** Always paired with `mcpConfigPath` when present: only this file's servers are offered, never
   *  a plugin-declared one the session's installed plugin brought along uninvited. */
  readonly strictMcpConfig?: boolean;
  readonly appendSystemPrompt?: string;
  readonly disallowedTools?: readonly string[];
}

export function claudeSessionArgv(opts: SessionArgvOpts): string[] {
  const argv: string[] = ["-p", "--model", opts.model, "--permission-mode", "bypassPermissions",
    "--output-format", "stream-json", "--verbose"];
  if (opts.newSessionId) argv.push("--session-id", opts.newSessionId);
  if (opts.resumeSessionId) argv.push("--resume", opts.resumeSessionId);
  if (opts.mcpConfigPath) argv.push("--mcp-config", opts.mcpConfigPath);
  if (opts.strictMcpConfig) argv.push("--strict-mcp-config");
  if (opts.disallowedTools?.length) argv.push("--disallowedTools", opts.disallowedTools.join(","));
  if (opts.appendSystemPrompt) argv.push("--append-system-prompt", opts.appendSystemPrompt);
  argv.push(opts.prompt);
  return argv;
}

// -------------------------------------------------------------------------------------------
// Session environment — an allowlist, never `{ ...process.env }`.
//
// Every session runs `--permission-mode bypassPermissions`, so whatever is in its environment is
// readable by the model and by any command it runs. The launcher's own environment holds the
// principal's unbound PAT (`ZZ_TOKEN`), and in memory the run's replay token and the proof
// allocation's verifier token (read from files, launch.ts's CLI note), and a real `HOME` whose `~/.zz/token` is that same unbound PAT
// again. None of those may cross into a session: the candidate is the thing under test, and a
// candidate that can reach the verifier's token or the principal's own credential can mark its own
// homework. So nothing is inherited by default — only what `claude` needs to run and to reach
// its model.

/** Copied across when present. Model credentials (the fresh config dir holds no login), the
 *  process basics a CLI needs, and proxy settings a model request may need to leave the host.
 *  Nothing matching `ZZ_*`, `REPLAY_*` or `VERIFIER_*` is ever on this list. */
const SESSION_ENV_ALLOW = [
  "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "SHELL", "TZ",
  "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  // Windows only — a child process there cannot start without them; absent on POSIX.
  "SystemRoot", "ComSpec", "PATHEXT",
] as const;

interface SessionEnvOpts {
  /** A temporary directory standing in for `HOME`, so `~/.zz/token`, `~/.claude` and every other
   *  dotfile of the operator's resolves somewhere empty. */
  readonly home: string;
  readonly configDir: string;
  /** The candidate only: the run's own replay-team PAT and the gateway it is for, as `ZZ_TOKEN`/
   *  `ZZ_URL` — the credential the candidate legitimately holds (it is already in the session's
   *  own `--mcp-config`), set explicitly so the principal's own value can never be the one a
   *  `zz-tool` call inside the session picks up. The simulated person gets neither. */
  readonly replayToken?: string;
  readonly gatewayUrl?: string;
}

/** The whole environment one replay session's `claude` process is started with. Pure: `source`
 *  is passed in (the launcher hands it `process.env`) so a check can prove what is dropped. */
export function candidateEnv(source: Readonly<Record<string, string | undefined>>, opts: SessionEnvOpts): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SESSION_ENV_ALLOW) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  env.HOME = opts.home;
  // Inside the session home: the sandbox leaves nothing else writable (sandbox.ts).
  env.TMPDIR = `${opts.home}/tmp`;
  env.USERPROFILE = opts.home;
  env.CLAUDE_CONFIG_DIR = opts.configDir;
  if (opts.replayToken) env.ZZ_TOKEN = opts.replayToken;
  if (opts.gatewayUrl) env.ZZ_URL = opts.gatewayUrl;
  return env;
}

// -------------------------------------------------------------------------------------------
// The launch's worst-case wall time — what the server's run TTL has to outlast.
//
// COUPLED: `REPLAY_RUN_TTL_MS` in `services/zz-core/src/eval/replay-runs.ts` must exceed
// `launchWorstCaseMs(MAX_TURNS_CAP)`. The two packages never import each other, so the coupling is
// pinned by `checks/replay-isolation-pure.ts`, which loads both and compares them. A TTL shorter
// than a real launch lets `sweepExpired` cancel a live run and expire the candidate's PAT under it.

/** One `claude` subprocess's own timeout — a plugin install step or one headless turn. */
export const SESSION_EXEC_TIMEOUT_MS = 10 * 60_000;
/** One git subprocess's own timeout — clone, checkout, apply, status. */
export const GIT_EXEC_TIMEOUT_MS = 60_000;
/** The most interview rounds a launch may run; `launchReplay` refuses a larger `maxTurns`. */
export const MAX_TURNS_CAP = 8;
// The longest source path: a third-party package — npm pack, tar, init, add, commit, apply,
// status — plus one to spare. A catalog clone takes six (clone, remove origin, resolve tag,
// checkout, apply, status); a third-party git source six (init, fetch, checkout, verify, apply,
// status).
const GIT_STEPS = 8;

/** Two install commands, the candidate's first turn, and one person turn plus one candidate turn
 *  per interview round — each bounded by `SESSION_EXEC_TIMEOUT_MS` — plus the git steps. */
export function launchWorstCaseMs(maxTurns: number): number {
  return (2 + 1 + 2 * maxTurns) * SESSION_EXEC_TIMEOUT_MS + GIT_STEPS * GIT_EXEC_TIMEOUT_MS;
}

// -------------------------------------------------------------------------------------------
// The candidate's MCP config — built inline with the run-scoped PAT already in hand, never
// through `headersHelper`/`~/.zz/token`: a session-local `CLAUDE_CONFIG_DIR` should not have to
// carry a token file at all, and this way it never does.

/** Which door a plugin's own tools live behind — the same mapping every plugin's own
 *  `marketplace/<plugin>/.mcp.json` in this repository encodes, reproduced here because the
 *  candidate's config is
 *  generated, not copied from the plugin's own (possibly prod-pointed) file. `zz-core` is always
 *  included: every flow's skills call `skill_read`/`document_write`/etc. on it regardless of
 *  which plugin is under test. */
const PLUGIN_DOOR: Readonly<Record<string, string>> = {
  "zz-core": "/core/mcp",
  "zz-access": "/manage/mcp",
  "zz-plugin-eval": "/eval/mcp",
};

export interface McpServerSpec { readonly type: "http"; readonly url: string; readonly headers: Record<string, string> }

/** `{"mcpServers": {...}}`, generated for one plugin against one gateway base — always the core
 *  door, plus the plugin's own door when it has one (`sdlc` has none; its skills call zz-core).
 *  `token` goes straight into the header rather than a `headersHelper` script, because the
 *  launcher already holds it in memory and a session-local config should not need a second file
 *  to read it from. */
export function candidateMcpConfig(
  plugin: string, gatewayBase: string, token: string, client: string,
): { mcpServers: Record<string, McpServerSpec> } {
  const doors = new Set<string>(["/core/mcp"]);
  const own = PLUGIN_DOOR[plugin];
  if (own) doors.add(own);
  const servers: Record<string, McpServerSpec> = {};
  for (const path of doors) {
    const name = path === "/core/mcp" ? "zz-core" : path === "/manage/mcp" ? "zz-access" : "zz-plugin-eval";
    servers[name] = {
      type: "http",
      url: `${gatewayBase.replace(/\/+$/, "")}${path}`,
      headers: { Authorization: `Bearer ${token}`, "X-ZZ-Client": client },
    };
  }
  return { mcpServers: servers };
}

/** The simulated person gets no MCP servers and no tools — `testing/eval-step.sh`'s own persona
 *  is built the same way: a stakeholder with the agent's tools could do the agent's work, which
 *  would score the pair instead of the candidate alone. */
export const NO_MCP_CONFIG = { mcpServers: {} } as const;

// -------------------------------------------------------------------------------------------
// Prompt text — pure formatting of an already role-filtered event list. What each `kind`/
// `payload` means is `replay-cases.ts`'s own concern (FR-25/26); this only renders what it is
// handed, in the `seq` order the server already returned.

/** One event, one line: `[seq] kind: payload`. `payload` is rendered as compact JSON — the
 *  candidate reads it as data, not as prose written for a person. */
function renderEvent(e: { seq: number; kind: string; payload: unknown }): string {
  return `[${e.seq}] ${e.kind}: ${JSON.stringify(e.payload)}`;
}

/** The candidate's opening prompt: nothing but the `actor` timeline, in order. What the
 *  candidate does with it — which skill it loads, which flow it runs — is the plugin under
 *  test's own concern; the plan's own boundary keeps that out of this task. */
export function candidatePrompt(events: readonly { seq: number; kind: string; payload: unknown }[]): string {
  const lines = events.map(renderEvent);
  return [
    "You are replaying one recorded case. What follows is the actor's own timeline, in order.",
    "Work from it exactly as you would from a real request — you may ask questions; they will be",
    "answered by the person who made this request.",
    "",
    ...lines,
  ].join("\n");
}

/** The simulated person's system prompt: the actor timeline for context, plus every `user_oracle`
 *  answer already on record — so a question the case already answers gets the recorded answer
 *  back, not an improvised one. */
export function simulatedPersonPersona(
  events: readonly { seq: number; kind: string; payload: unknown; visibility: string }[],
): string {
  const lines = events.map(renderEvent);
  return [
    "You are the person whose request this is. Answer questions about it from what is below,",
    "in your own words. Where it does not cover something, decide the way a sensible requester",
    "would and stay consistent with that for the rest of the conversation. Keep replies short.",
    "",
    ...lines,
  ].join("\n");
}

/** True while the candidate's last reply is still asking something — `testing/eval-step.sh`'s own
 *  stopping rule for its interview loop, reused rather than reinvented. */
export function stillAsking(lastReply: string): boolean {
  return lastReply.includes("?");
}

// -------------------------------------------------------------------------------------------
// Idempotency keys — deterministic per (run, purpose), so a retried close/assess call replays
// the first attempt through the FR-59 ledger instead of minting a second one.

export function idempotencyKey(...parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex");
}
