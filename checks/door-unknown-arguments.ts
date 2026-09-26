#!/usr/bin/env node
// A call refused by a tool's schema names the arguments the tool does not take.
//
// In the zz-core evaluation two runs were refused with the SDK's own text — "Invalid input at
// path", "required at name" — for passing `doc_path` and `skill`; neither refusal said which name
// was wrong. recordingDoor patches the SDK's validation path, so this pins it to the installed SDK.
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const { recordingDoor } = await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/door.js")).href);

const server = recordingDoor(new McpServer({ name: "check", version: "0" }), "core");
server.registerTool("document_read", { description: "d", inputSchema: { path: z.string(), version: z.number().optional() } },
  async ({ path }: { path: string }) => ({ content: [{ type: "text" as const, text: `read ${path}` }] }));
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const client = new Client({ name: "check", version: "0" });
await client.connect(b);

const textOf = (r: unknown): string =>
  (((r as { content?: unknown }).content as { text?: string }[] | undefined) ?? []).map((c) => c.text ?? "").join("");

const wrong = await client.callTool({ name: "document_read", arguments: { doc_path: "x/spec.md" } });
assert.equal(wrong.isError, true);
const said = textOf(wrong);
assert.match(said, /takes no `doc_path`/, `the refusal names the argument the caller passed: ${said}`);
assert.match(said, /`path`, `version`/, `and the ones the tool takes: ${said}`);
assert.doesNotMatch(said, /MCP error -32602: .*MCP error/, "the SDK's prefix is not doubled");

const missing = await client.callTool({ name: "document_read", arguments: {} });
assert.doesNotMatch(textOf(missing), /takes no/, "a call with no unknown name keeps the SDK's own refusal");

const extra = await client.callTool({ name: "document_read", arguments: { path: "x/spec.md", doc_path: "y" } });
assert.equal(textOf(extra), "read x/spec.md", "a call the schema accepts is untouched, extra names and all");

await client.close();
console.log("ok door-unknown-arguments");
