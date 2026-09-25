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
// git argv — worktree lifecycle under refs/replay/<team_slug>, never a branch.

/** `refs/replay/<team_slug>` — never a branch, never under `refs/heads/`. `replay_start` already
 *  names this as `worktree_ref`/`sandbox_ref`; this is the one place that string is built from a
 *  team_slug, so a reader who wants "what ref does this run use" never has two answers. */
export function replayRefFor(teamSlug: string): string {
  return `refs/replay/${teamSlug}`;
}

/** One worktree directory per run, named from its team slug — team slugs are already unique per
 *  run (`provisionReplayTeam`), so two concurrent launches can never collide on this path. */
export function worktreeDirName(teamSlug: string): string {
  return `replay-${teamSlug}`;
}

export const gitRevParseArgv = (ref: string): string[] => ["rev-parse", ref];

/** Points `ref` at `commit` without touching `HEAD` or any branch — `git update-ref`, not
 *  `checkout` or `branch`, is the only git command that moves a ref with no working tree and no
 *  effect on whatever branch the caller's own checkout is on. */
export const gitUpdateRefArgv = (ref: string, commit: string): string[] => ["update-ref", ref, commit];
export const gitUpdateRefDeleteArgv = (ref: string): string[] => ["update-ref", "-d", ref];

export const gitWorktreeAddArgv = (worktreePath: string, ref: string): string[] =>
  ["worktree", "add", "--detach", worktreePath, ref];
export const gitWorktreeRemoveArgv = (worktreePath: string): string[] =>
  ["worktree", "remove", "--force", worktreePath];
export const gitWorktreeListArgv = (): string[] => ["worktree", "list", "--porcelain"];

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
