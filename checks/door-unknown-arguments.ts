#!/usr/bin/env node
// An argument a tool does not take is refused by name, on every door serveMcp mounts.
//
// In the zz-core evaluation two runs were refused with the SDK's own text — "Invalid input at
// path", "required at name" — for passing `doc_path` and `skill`; neither refusal said which name
// was wrong. And on a scratch stack `initiative_open {"slug":"rp-typo","flwo":"sdlc-flow"}` opened a
// freeform initiative for good: the SDK dropped the misspelt `flow` and the call succeeded. serveMcp
// patches the SDK's validation path, so this drives it over HTTP against the installed SDK.
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import express from "express";
import { z } from "zod";

const { serveMcp } = await import(pathToFileURL(join(process.cwd(), "packages/mcp-http/dist/index.js")).href);
const { refusalOwner } = await import(pathToFileURL(join(process.cwd(), "packages/contracts/dist/index.js")).href);

const app = express();
app.use(express.json());
serveMcp(app, "/mcp", () => {
  const server = new McpServer({ name: "check", version: "0" });
  server.registerTool("document_read", { description: "d", inputSchema: { path: z.string(), version: z.number().optional() } },
    async ({ path }: { path: string }) => ({ content: [{ type: "text" as const, text: `read ${path}` }] }));
  server.registerTool("session_whoami", { description: "w" },
    async () => ({ content: [{ type: "text" as const, text: "you" }] }));
  return server;
});
const http: Server = app.listen(0, "127.0.0.1");
await new Promise((r) => http.once("listening", r));
const { port } = http.address() as { port: number };

const client = new Client({ name: "check", version: "0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));

const textOf = (r: unknown): string =>
  (((r as { content?: unknown }).content as { text?: string }[] | undefined) ?? []).map((c) => c.text ?? "").join("");

try {
  const wrong = await client.callTool({ name: "document_read", arguments: { doc_path: "x/spec.md" } });
  assert.equal(wrong.isError, true);
  const said = textOf(wrong);
  assert.match(said, /takes no `doc_path`/, `the refusal names the argument the caller passed: ${said}`);
  assert.match(said, /`path`, `version`/, `and the ones the tool takes: ${said}`);
  assert.match(said, /path/, `and keeps what the schema itself refused: ${said}`);
  assert.doesNotMatch(said, /MCP error -32602: .*MCP error/, "the SDK's prefix is not doubled");

  const missing = await client.callTool({ name: "document_read", arguments: {} });
  assert.doesNotMatch(textOf(missing), /takes no/, "a call with no unknown name keeps the SDK's own refusal");

  const extra = await client.callTool({ name: "document_read", arguments: { path: "x/spec.md", doc_path: "y" } });
  assert.equal(extra.isError, true, `a call the schema would accept is refused for its extra name: ${textOf(extra)}`);
  assert.match(textOf(extra), /Invalid arguments for tool document_read: it takes no `doc_path`; its arguments are `path`, `version`/);
  // The telemetry owns it as the call's shape, as it owns the SDK's own schema refusals.
  for (const r of [wrong, extra]) assert.equal(refusalOwner(textOf(r)), "ours", textOf(r));

  const bare = await client.callTool({ name: "session_whoami", arguments: { team: "x" } });
  assert.equal(bare.isError, true, "a tool with no arguments refuses one");
  assert.match(textOf(bare), /Invalid arguments for tool session_whoami: it takes no arguments; `team` was passed/);

  const right = await client.callTool({ name: "document_read", arguments: { path: "x/spec.md" } });
  assert.equal(textOf(right), "read x/spec.md", "a call naming only declared arguments is untouched");
  assert.equal(textOf(await client.callTool({ name: "session_whoami", arguments: {} })), "you");
} finally {
  await client.close();
  http.close();
}
console.log("ok door-unknown-arguments");
