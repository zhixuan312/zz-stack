#!/usr/bin/env node
// Reports a skill this session loaded from the ZZ shelf to the platform, as skill_read.
// Run by a PostToolUse hook on the Skill tool. Always exits 0 and prints nothing. The
// credential comes from zz-mcp-headers.mjs beside this file, run by this same node — the
// resolution the MCP connection uses, so there is one place a token is found.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CORE = "https://api.zz-stack.com/core/mcp";
const SHELF = new Set(["zz-core","zz-access","sdlc","zz-plugin-eval"]);
const COMMANDS = {"sdlc":{"flow":"sdlc-flow"},"zz-plugin-eval":{"eval":"zz-plugin-eval"},"zz-access":{"connect":"zz-access","admin":"zz-admin","doctor":"zz-doctor","migrate":"zz-migrate","update":"zz-update"},"zz-core":{"breakout":"zz-breakout","deck":"zz-deck","tldr":"zz-tldr"}};

function headers() {
  try {
    const out = execFileSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "zz-mcp-headers.mjs")],
                             { encoding: "utf8", timeout: 3000 });
    return JSON.parse(out);
  } catch { return {}; }
}

let raw = "";
process.stdin.on("data", (d) => { raw += d; }).on("end", async () => {
  try {
    const input = JSON.parse(raw || "{}").tool_input || {};
    const named = String(input.skill || input.name || input.command || "").replace(/^\//, "").trim();
    const [plugin, opened] = named.includes(":") ? named.split(":", 2) : ["", named];
    if (!opened || !SHELF.has(plugin)) return;
    // The name typed is the command; the name zz-core resolves by is the skill's directory,
    // and the two differ for every promoted skill. Reporting the command found nothing.
    const name = (COMMANDS[plugin] ?? {})[opened] ?? opened;
    const h = headers();
    if (!h.Authorization) return;
    await fetch(CORE, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
                 authorization: h.Authorization, "x-zz-client": "zz-hook" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
                             params: { name: "skill_read", arguments: { name } } }),
      signal: AbortSignal.timeout(8000),
    }).then((r) => r.text()).catch(() => {});
  } catch { /* a report that cannot be made is not the session's problem */ }
});
