#!/usr/bin/env node
/**
 * Every tool says what it does to the world, and a client reads that off the live door.
 *
 * ChatGPT treats a tool with no `readOnlyHint` as a write and asks the person to confirm every
 * call, and its "always allow" lasts one conversation. No tool here declared one, so every look at
 * an initiative stopped on a dialog. `@zz/mcp-http` now names three kinds — READS, WRITES,
 * DESTROYS — and this holds every registration to one of them.
 *
 *   1. read: every `registerTool` in services/ passes `annotations:` one of the three (a spread of
 *      one, for a tool that adds `openWorldHint`), so a new tool cannot arrive unannotated and
 *      fall back to "write";
 *   2. read: no tool marked READS describes itself as a mutator or is named for a write — the
 *      misclassification that would let ChatGPT run a write unconfirmed;
 *   3. driven: the evaluation door and the core door, built the way zz-core builds them, serve
 *      every tool with a boolean `readOnlyHint`, and the two that anchor the reading —
 *      `initiative_status` reads, `document_write` writes — say so.
 *
 * Run: node checks/tool-annotations.ts   (also run by scripts/gate.ts)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { connectTo, coreDoor } from "./in-process.ts";

process.env.ZZ_CATALOG_DIR ??= join(process.cwd(), "catalog");

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

const walk = (d: string, out: string[] = []): string[] => {
  for (const e of readdirSync(d)) {
    if (e === "node_modules" || e === "dist") continue;
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
};

// 1 + 2. The source
const KIND = /^annotations:\s*(?:(READS|WRITES|DESTROYS)|\{\s*\.\.\.(READS|WRITES|DESTROYS)\s*,[^}]*\}),/;
const WRITE_NAME = /_(add|write|patch|revise|approve|close|open|delete|revoke|issue|record|create|archive|remove|switch|resolve|report|register|apply|start|stop|affirm|decide)$/;
let seen = 0;
for (const f of walk("services")) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/registerTool\(\s*"([a-z0-9_]+)"\s*,\s*\{/g)) {
    seen++;
    const name = m[1]!;
    const after = src.slice(m.index! + m[0].length).trimStart();
    const kind = KIND.exec(after);
    if (!kind) {
      fail.push(`${name} (${f}) passes no READS / WRITES / DESTROYS annotations as its first config ` +
                "field — ChatGPT will treat it as a write and confirm every call");
      continue;
    }
    if ((kind[1] ?? kind[2]) !== "READS") continue;
    const desc = after.slice(0, after.search(/\n\s*(inputSchema|outputSchema|_meta)\s*:/) + 1 || 4000);
    is(!/\bmutator\b/i.test(desc), `${name} is marked READS but describes itself as a mutator`);
    is(!WRITE_NAME.test(name), `${name} is marked READS but is named for a write`);
  }
}
is(seen >= 60, `only ${seen} registrations found under services/ — this scan is blind`);

// 3. The doors, as a client sees them
const toolsOf = async (server: McpServer) =>
  (await (await connectTo(server, "checks/tool-annotations.ts")).listTools()).tools;
try {
  const { buildEvalServer } = await import("../services/zz-core/dist/eval-door.js");
  const { server: core, registrars } = await coreDoor("0.0.0-tool-annotations-check");
  is(registrars.length > 0, "no tool modules found imported by services/zz-core/src/server.ts — this scan is blind");
  const served = [...await toolsOf(buildEvalServer()), ...await toolsOf(core)];
  is(served.length >= 40, `the doors served ${served.length} tools — this scan is blind`);
  for (const t of served) {
    is(typeof t.annotations?.readOnlyHint === "boolean", `${t.name} reaches a client with no readOnlyHint`);
  }
  const hint = (n: string) => served.find((t) => t.name === n)?.annotations?.readOnlyHint;
  is(hint("initiative_status") === true, "initiative_status does not reach a client as read-only");
  is(hint("document_write") === false, "document_write does not reach a client as a write");
  // The tools a door builder that reads one name per import, or only ./tools/, or registers with
  // no role, would never serve: their hints go unchecked if the door is built short.
  for (const n of ["bug_report", "bug_list", "bug_resolve", "bug_delete", "knowledge_reindex", "document_shown"]) {
    is(typeof hint(n) === "boolean", `${n} is not served by the door this check builds — the build is short`);
  }
} catch (err) {
  fail.push(`the doors could not be built or listed: ${err instanceof Error ? err.message : String(err)}`);
}

if (fail.length) {
  for (const f of fail) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log(`PASS ${seen} tools each declare READS, WRITES or DESTROYS, and the doors serve the hints`);
