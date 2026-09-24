#!/usr/bin/env node
// Reports a skill this session loaded from the ZZ shelf to the platform, as skill_read.
// Run by a PostToolUse hook on the Skill tool. Always exits 0 and prints nothing. The
// credential comes from zz-mcp-headers.sh beside this file — the same resolution the MCP
// connection uses, so there is one place a token is found.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CORE = "https://api.165-232-169-165.nip.io/core/mcp";
const SHELF = new Set(["zz-core","zz-access","sdlc","zz-plugin-eval"]);

function headers() {
  try {
    const out = execFileSync(join(dirname(fileURLToPath(import.meta.url)), "zz-mcp-headers.sh"),
                             { encoding: "utf8", timeout: 3000 });
    return JSON.parse(out);
  } catch { return {}; }
}

let raw = "";
process.stdin.on("data", (d) => { raw += d; }).on("end", async () => {
  try {
    const input = JSON.parse(raw || "{}").tool_input || {};
    const named = String(input.skill || input.name || input.command || "").replace(/^\//, "").trim();
    const [plugin, name] = named.includes(":") ? named.split(":", 2) : ["", named];
    if (!name || !SHELF.has(plugin)) return;
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
