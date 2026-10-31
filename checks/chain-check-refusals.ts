#!/usr/bin/env node
/**
 * chain-check records a refusal where its walk expects JSON and still ends on its summary: run as
 * built against a stub door that answers every tool with a refusal, it exits 1 with the refusal
 * named in a FAILED line, never a SyntaxError with a stack.
 *
 * No deployment: the stub is an HTTP server in this process on a loopback port.
 * Reads the built `packages/tools/dist`.
 * Run: node checks/chain-check-refusals.ts
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const REFUSAL = "ERROR: this token acts for no team — switch to a team with team_switch first.";

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c: Buffer) => { body += c; });
  req.on("end", () => {
    const msg = JSON.parse(body || "{}") as { id?: number; method?: string; params?: { protocolVersion?: string } };
    if (msg.id === undefined) { res.writeHead(202).end(); return; }
    const result = msg.method === "initialize"
      // The client's own version, echoed: the stub agrees with whatever @zz/mcp-client asks for.
      ? { protocolVersion: msg.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "stub", version: "0" } }
      : msg.method === "tools/list" ? { tools: [] }
      : { content: [{ type: "text", text: REFUSAL }], isError: true };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;

const run = await new Promise<{ code: number | null; out: string }>((resolve) => {
  const child = spawn(process.execPath, ["packages/tools/dist/testing/chain-check.js"], {
    env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent", ZZ_GATEWAY: `http://127.0.0.1:${port}`, ZZ_PAT: "zzp_stub" },
  });
  let out = "";
  child.stdout.on("data", (c: Buffer) => { out += c; });
  child.stderr.on("data", (c: Buffer) => { out += c; });
  child.on("close", (code) => resolve({ code, out }));
});
server.close();

const fail: string[] = [];
if (run.code !== 1) fail.push(`exit ${run.code}, not 1`);
if (/SyntaxError|\n\s+at /.test(run.out)) fail.push("it ended on a stack trace");
if (!/platform checks passed/.test(run.out)) fail.push("it printed no summary");
if (!/FAILED: initiative_open answers with JSON\s+ERROR: this token acts for no team/.test(run.out)) {
  fail.push("no FAILED line names the refusal initiative_open answered");
}
if (fail.length) {
  console.error(`FAIL: ${fail.join("; ")}\n--- chain-check said:\n${run.out.slice(0, 2000)}`);
  process.exit(1);
}
console.log("chain-check-refusals: a refusal where the walk expects JSON is a FAILED line in the summary, not a crash: ok");
