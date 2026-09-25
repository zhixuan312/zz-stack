/**
 * The launcher's process layer (Task I-17): a session-local `CLAUDE_CONFIG_DIR`, the plugin
 * installed into it from the pinned worktree, and one headless `claude -p` turn at a time —
 * proven against real flags by `testing/eval-step.sh`, not invented here. Every subprocess runs
 * through `execFileSync` with an argv array built in `plan.ts`; nothing here interpolates a
 * string into a shell. Every `claude` process runs inside the OS sandbox `sandbox.ts` describes;
 * this file is where the paths that sandbox needs are resolved against the real filesystem.
 */
import { execFileSync } from "node:child_process";
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  candidateEnv, claudeInstallArgv, claudeMarketplaceAddArgv, claudeSessionArgv, SESSION_EXEC_TIMEOUT_MS,
  type SessionArgvOpts,
} from "./plan.js";
import { sandboxedCommand, type SandboxTool } from "./sandbox.js";

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** One session's private filesystem: a temporary `HOME` and, inside it, a fresh
 *  `CLAUDE_CONFIG_DIR`, plus the environment its `claude` processes run with (`candidateEnv`,
 *  plan.ts — an allowlist, never the launcher's own environment). Nothing under the operator's
 *  own `~/.claude` or `~/.zz` is ever read or written by a replay session. `replayToken`/
 *  `gatewayUrl` are the candidate's only; the simulated person gets neither. Removed by the
 *  caller once the session is done with it. */
interface SessionHome { readonly root: string; readonly configDir: string; readonly env: Record<string, string> }

/** No `.claude.json` is seeded: probed against claude 2.1.281 with an empty `HOME` and
 *  `CLAUDE_CONFIG_DIR`, `claude -p --permission-mode bypassPermissions` shows no onboarding or
 *  trust prompt — it writes its own `.claude.json` into the config dir and goes straight to the
 *  model request. `realpathSync` because the sandbox matches real paths (`/private/var/...`). */
export function makeSessionHome(extra: { replayToken?: string; gatewayUrl?: string } = {}): SessionHome {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "zz-replay-home-")));
  const configDir = join(root, ".claude");
  mkdirSync(configDir);
  mkdirSync(join(root, "tmp"));
  return { root, configDir, env: candidateEnv(process.env, { home: root, configDir, ...extra }) };
}

// -------------------------------------------------------------------------------------------
// The OS sandbox, resolved against this host.

/** Which sandbox this host can actually start, or null. Probed by running one trivial command
 *  inside it — the binary existing is not enough: `sandbox-exec` refuses to nest inside another
 *  sandbox, and `bwrap` needs unprivileged user namespaces the host may have disabled. */
export function detectSandbox(): SandboxTool | null {
  const probe = (file: string, args: string[]): boolean => {
    try { execFileSync(file, args, { timeout: 15_000, stdio: "ignore" }); return true; } catch { return false; }
  };
  if (process.platform === "darwin") {
    return existsSync("/usr/bin/sandbox-exec") &&
      probe("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"]) ? "sandbox-exec" : null;
  }
  if (process.platform === "linux") {
    return probe("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "--", "/bin/true"]) ? "bwrap" : null;
  }
  return null;
}

/** What every sandboxed `claude` process in one launch shares: the tool, what it may not read,
 *  and what it gets back read-only. Only the writable paths differ per process. */
export interface SandboxContext {
  readonly tool: SandboxTool;
  readonly denyRead: readonly { readonly path: string; readonly dir: boolean }[];
  readonly allowRead: readonly string[];
}

const real = (p: string): string | null => { try { return realpathSync(p); } catch { return null; } };

/** `claudeBin` as `execFileSync` would find it — absolute as given, otherwise the first match on
 *  `PATH`. */
function locate(bin: string): string | null {
  if (isAbsolute(bin)) return existsSync(bin) ? bin : null;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, bin))) return join(dir, bin);
  }
  return null;
}

/** Denied: the operator's real home directory (from the password database, not `$HOME`, which
 *  the launcher's own caller could have pointed anywhere) and `$HOME` when that differs, the
 *  operator's checkout, an explicit `ZZ_TOKEN_FILE`, and the launcher's own log directory (the
 *  simulated person's transcript, oracle-informed, lands there). Re-allowed read-only: wherever
 *  `claude` and the node running this launcher are installed, when that is under a denied path —
 *  a user-level install (`~/.local`, `~/.nvm`) is ordinary. */
export function sandboxContext(tool: SandboxTool, repoRoot: string, claudeBin: string, logDir: string): SandboxContext {
  const denyRead: { path: string; dir: boolean }[] = [];
  const deny = (p: string | undefined): void => {
    const r = p ? real(p) : null;
    if (r && !denyRead.some((d) => d.path === r)) denyRead.push({ path: r, dir: statSync(r).isDirectory() });
  };
  deny(userInfo().homedir);
  deny(process.env.HOME);
  deny(repoRoot);
  deny(process.env.ZZ_TOKEN_FILE);
  deny(logDir);

  const located = locate(claudeBin);
  if (!located) throw new Error(`launchReplay: '${claudeBin}' is not on PATH`);
  const installs = [dirname(located), dirname(real(located) ?? located), dirname(dirname(real(process.execPath) ?? process.execPath))];
  const allowRead = [...new Set(installs.map((p) => real(p) ?? p))]
    .filter((p) => denyRead.some((d) => p.startsWith(`${d.path}/`)));
  return { tool, denyRead, allowRead };
}

/** One sandboxed `execFileSync`, writable only where `writable` says. */
function execSandboxed(
  sandbox: SandboxContext, writable: readonly string[], bin: string, args: string[],
  opts: { cwd: string; env: Record<string, string>; timeout: number; maxBuffer?: number },
): string {
  const cmd = sandboxedCommand(sandbox.tool, { denyRead: sandbox.denyRead, allowRead: sandbox.allowRead, writable },
    bin, args, opts.cwd);
  return execFileSync(cmd.file, cmd.argv, { ...opts, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function removeSessionHome(home: SessionHome): void {
  if (existsSync(home.root)) rmSync(home.root, { recursive: true, force: true });
}

/** Adds a local marketplace pointed at `marketplaceRoot` (the pinned worktree's own repository
 *  root, which carries `.claude-plugin/marketplace.json`) and installs `plugin` from it — the
 *  "install at an exact digest" step: the marketplace's own source is a directory on a commit
 *  the worktree already pinned, never a GitHub fetch of whatever `main` happens to be. Returns
 *  the marketplace's own declared name, which `claude plugin install` needs as `plugin@name`. */
export function installPlugin(
  claudeBin: string, home: SessionHome, sandbox: SandboxContext, marketplaceRoot: string, plugin: string,
): string {
  const marketplaceJsonPath = join(marketplaceRoot, ".claude-plugin", "marketplace.json");
  if (!existsSync(marketplaceJsonPath)) {
    throw new Error(`installPlugin: no .claude-plugin/marketplace.json under ${marketplaceRoot}`);
  }
  const declared = JSON.parse(readFileSync(marketplaceJsonPath, "utf8")) as { name?: string };
  const marketplaceName = declared.name || "zz-stack";
  const opts = { cwd: home.root, env: home.env, timeout: SESSION_EXEC_TIMEOUT_MS };
  execSandboxed(sandbox, [home.root], claudeBin, claudeMarketplaceAddArgv(marketplaceRoot), opts);
  execSandboxed(sandbox, [home.root], claudeBin, claudeInstallArgv(plugin, marketplaceName), opts);
  return marketplaceName;
}

/** One `--mcp-config` file, written once per session — never the plugin's own shipped
 *  `.mcp.json`, so a session-local run never depends on (or leaks a credential toward)
 *  whichever gateway that file happens to be pointed at. */
export function writeMcpConfig(dir: string, config: unknown): string {
  const path = join(dir, `mcp-${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify(config), "utf8");
  return path;
}

interface StreamFrame {
  readonly type?: string;
  readonly message?: { readonly content?: { readonly type?: string; readonly text?: string }[] };
  readonly total_cost_usd?: number;
}

/** The last assistant text block in a `stream-json` transcript, and the run's own reported cost
 *  — the same two facts `testing/eval-step.sh`'s inline `node -e` readers pull out, read here
 *  without shelling out to `node -e` a second time. */
function parseTranscript(raw: string): { lastText: string; costUsd: number } {
  let lastText = "";
  let costUsd = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let frame: StreamFrame;
    try { frame = JSON.parse(line) as StreamFrame; } catch { continue; }
    if (frame.type === "result" && typeof frame.total_cost_usd === "number") costUsd += frame.total_cost_usd;
    if (frame.type === "assistant") {
      for (const c of frame.message?.content ?? []) {
        if (c.type === "text" && c.text?.trim()) lastText = c.text.trim();
      }
    }
  }
  return { lastText, costUsd };
}

interface TurnResult { readonly lastText: string; readonly costUsd: number; readonly raw: string }

/** One headless turn. `< /dev/null` on stdin (no interactive prompt possible), `bypassPermissions`
 *  (a replay session has no person watching to approve a tool call) and `stream-json --verbose`
 *  so the transcript can be parsed rather than screen-scraped — all three lifted from
 *  `testing/eval-step.sh`, which has run this exact invocation shape live. */
export function runTurn(
  claudeBin: string, home: SessionHome, sandbox: SandboxContext, argvOpts: SessionArgvOpts, cwd: string,
  logPath: string,
): TurnResult {
  const argv = claudeSessionArgv(argvOpts);
  // Writable: the session's own home, and its working directory — the clone, for the candidate;
  // its own home again, for the simulated person.
  const writable = [...new Set([home.root, cwd])];
  let raw: string;
  try {
    raw = execSandboxed(sandbox, writable, claudeBin, argv,
      { cwd, env: home.env, timeout: SESSION_EXEC_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    raw = e.stdout || "";
    appendFileSync(logPath, raw + `\n# turn failed: ${(e.stderr || e.message || "unknown error").slice(-500)}\n`, "utf8");
    throw new Error(`claude turn failed: ${(e.stderr || e.message || "unknown error").slice(-500)}`);
  }
  appendFileSync(logPath, raw.endsWith("\n") ? raw : raw + "\n", "utf8");
  return { ...parseTranscript(raw), raw };
}
