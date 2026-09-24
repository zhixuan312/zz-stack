/**
 * The launcher's process layer (Task I-17): a session-local `CLAUDE_CONFIG_DIR`, the plugin
 * installed into it from the pinned worktree, and one headless `claude -p` turn at a time —
 * proven against real flags by `testing/eval-step.sh`, not invented here. Every subprocess runs
 * through `execFileSync` with an argv array built in `plan.ts`; nothing here interpolates a
 * string into a shell.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { claudeInstallArgv, claudeMarketplaceAddArgv, claudeSessionArgv, type SessionArgvOpts } from "./plan.js";

const EXEC_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** A fresh `CLAUDE_CONFIG_DIR` — nothing under the person's own `~/.claude` is ever read or
 *  written by a replay session. Removed by the caller once the session is done with it. */
export function makeConfigDir(): string {
  return mkdtempSync(join(tmpdir(), "zz-replay-config-"));
}

export function removeConfigDir(dir: string): void {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

/** Adds a local marketplace pointed at `marketplaceRoot` (the pinned worktree's own repository
 *  root, which carries `.claude-plugin/marketplace.json`) and installs `plugin` from it — the
 *  "install at an exact digest" step: the marketplace's own source is a directory on a commit
 *  the worktree already pinned, never a GitHub fetch of whatever `main` happens to be. Returns
 *  the marketplace's own declared name, which `claude plugin install` needs as `plugin@name`. */
export function installPlugin(
  claudeBin: string, configDir: string, marketplaceRoot: string, plugin: string,
): string {
  const marketplaceJsonPath = join(marketplaceRoot, ".claude-plugin", "marketplace.json");
  if (!existsSync(marketplaceJsonPath)) {
    throw new Error(`installPlugin: no .claude-plugin/marketplace.json under ${marketplaceRoot}`);
  }
  const declared = JSON.parse(readFileSync(marketplaceJsonPath, "utf8")) as { name?: string };
  const marketplaceName = declared.name || "zz-stack";
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
  execFileSync(claudeBin, claudeMarketplaceAddArgv(marketplaceRoot),
    { env, timeout: EXEC_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });
  execFileSync(claudeBin, claudeInstallArgv(plugin, marketplaceName),
    { env, timeout: EXEC_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });
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
  claudeBin: string, configDir: string, argvOpts: SessionArgvOpts, cwd: string, logPath: string,
): TurnResult {
  const argv = claudeSessionArgv(argvOpts);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
  let raw: string;
  try {
    raw = execFileSync(claudeBin, argv, {
      cwd, env, encoding: "utf8", timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    raw = e.stdout || "";
    appendFileSync(logPath, raw + `\n# turn failed: ${(e.stderr || e.message || "unknown error").slice(-500)}\n`, "utf8");
    throw new Error(`claude turn failed: ${(e.stderr || e.message || "unknown error").slice(-500)}`);
  }
  appendFileSync(logPath, raw.endsWith("\n") ? raw : raw + "\n", "utf8");
  return { ...parseTranscript(raw), raw };
}
