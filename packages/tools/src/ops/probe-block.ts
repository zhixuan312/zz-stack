/**
 * Check a building block's MCP endpoint before you register it.
 *
 *   npm run probe-block -- https://host/mcp
 *   npm run probe-block -- https://host/mcp --header "X-API-Key: <key>"
 *   npm run probe-block -- https://host/mcp --header "…" --expect a,b,c
 *
 * Speaks MCP initialize then tools/list and prints what came back. Reads nothing, writes
 * nothing, and needs no access to the platform — it is the one thing you want the moment
 * another team hands you a URL and a credential, and it answers the question that comes
 * before every other one: does this endpoint work, and is it the one they described?
 *
 * The credential goes in --header rather than being assumed to be a bearer token, because a
 * block is somebody else's service and the header it authenticates on is theirs to choose.
 *
 * REGISTERING A BLOCK, once this probe passes, is four edits and none of them is a database
 * edit. deploy/README.md holds the list, under "Building blocks", and it is not repeated
 * here: this file said THREE for a day, having taken its list from blocks.ts's own comment
 * and missed the browser's MCP connection in librechat.yaml — which is the one the gate
 * exists to catch, because a block that reaches terminal clients and never the browser used
 * to fail silently.
 *
 * WHAT THIS REPLACED. add-block.py and connect-real-block.py both registered a block by
 * writing into the front end's own database, and they were two copies of one job —
 * add-block.py's --replace was connect-real-block.py's entire purpose. Both are gone. A
 * block reaches people through the gateway, and the browser reads what a team runs rather
 * than being written into. What survives is the part that was always worth having: the probe.
 */
import { Mcp, McpError } from "@zz/mcp-client";

import { die, optional, parseArgs } from "../lib/cli.js";

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const url = args.positional[0];
  if (!url) die('usage: probe-block <streamable-HTTP MCP url> [--header "Name: value"]...');

  const headers: Record<string, string> = {};
  for (const h of args.repeated.get("header") ?? []) {
    const at = h.indexOf(":");
    // `< 1`, not `< 0`: ":value" gave an empty name, which was accepted and then sent as a
    // header with no name — a malformed request that reads as the endpoint rejecting you.
    if (at < 1) die(`--header must be "Name: value", got ${JSON.stringify(h)}`);
    headers[h.slice(0, at).trim()] = h.slice(at + 1).trim();
  }

  // READ BEFORE THE NETWORK CALL, like the flags tool-report validates before its query: a
  // mistyped flag should cost nothing, and `--expect` is used forty lines below, past a
  // connection that can take thirty seconds to fail.
  //
  // Through optional(), so `--expect` with nothing after it is a mistyped flag rather than an
  // absent one. Read with `?? ""` it split to nothing, the allowlist comparison was skipped,
  // and the probe exited 0 — the operator asked the one question that flag exists for and was
  // told everything is fine.
  const expect = (optional(args, "expect", "the tool names the allowlist claims, comma-separated") ?? "")
    .split(",").map((t) => t.trim()).filter(Boolean);

  console.log(`initialize  ${url}`);
  const mcp = new Mcp(url, { client: "probe-block", timeoutMs: 30_000, headers });
  let tools;
  try {
    tools = await mcp.tools();
  } catch (err) {
    // The operator ran this to find out whether an endpoint works. A stack trace answers
    // that question worse than the sentence does.
    if (err instanceof McpError) die(err.message);
    throw err;
  }

  console.log(`  server: ${mcp.server.name ?? "?"} ${mcp.server.version ?? ""}`.trimEnd());
  console.log(`  ${tools.length} tools`);
  for (const t of tools) {
    console.log(`    ${t.name.padEnd(38)} ${(t.description ?? "").split("\n")[0].slice(0, 70)}`);
  }
  if (tools.length === 0) {
    console.error("  WARNING: the endpoint answered but offers no tools");
    return 1;
  }

  // THE ALLOWLIST IS ONLY CHECKABLE AGAINST THE LIVE BLOCK, and nothing was checking it.
  //
  // blocks.ts names the subset of a block's tools an agent should carry — a context budget,
  // not an authorisation boundary. A name in that list the block does not serve is dropped in
  // silence: the agent never receives the tool, and no error is raised anywhere, because a
  // wish list and the thing it wishes about are held by different parties. the block's list carried
  // `save_transition_blacklist` for a tool the block calls
  // `save_case_status_transition_blacklist`, so no delivery agent could restrict a status
  // transition — one wrong name in seventy-one, found by asking the block.
  //
  // The offline gate cannot ask: it has no network and no credential, by design. Neither can
  // the gateway, which holds the allowlist but has no key of its own to list a block's tools
  // with. The party that has both is whoever runs this probe, so this is where it goes.
  if (expect.length) {
    const have = new Set(tools.map((t) => t.name));
    const missing = expect.filter((t) => !have.has(t));
    console.log(`\n  allowlist: ${expect.length} named, ${expect.length - missing.length} served`);
    if (missing.length) {
      console.error(`  WARNING: this block does not serve ${missing.join(", ")} — an agent ` +
                    "given that allowlist silently never receives those tools");
      return 1;
    }
  }
  return 0;
}

process.exit(await main(process.argv.slice(2)));
