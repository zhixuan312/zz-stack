/**
 * call — one platform tool, from a terminal, and print what it said.
 *
 *   ZZ_URL=… ZZ_TOKEN=… npm run call -- /manage/mcp team_list
 *   ZZ_URL=… ZZ_TOKEN=… npm run call -- /core/mcp initiative_status
 *   ZZ_URL=… ZZ_TOKEN=… npm run call -- /eval/mcp plugin_locate
 *   ZZ_URL=… ZZ_TOKEN=… npm run call -- /core/mcp --list
 *
 * Every other tool here answers one question and is shaped around it, so none can call an
 * arbitrary tool. The gap is felt at two moments: setting a deployment up (`team_create`,
 * `member_add`, `pat_issue` — the calls that come before anybody has a working client), and
 * reading the record back after an evaluation (`initiative_status`, `source_list`) without asking
 * the agent under test what it thinks happened.
 *
 * DELIBERATE: not a second MCP client. It is @zz/mcp-client with an argv in front of it, so the
 * version, the handshake and the reading of a streamable-HTTP answer stay in the one place that
 * defines them. The gate refuses a second client by name.
 *
 * The answer goes to stdout and nothing else does, so a caller can pipe it. A refusal is an
 * answer — the platform's refusals are prose that teaches the rule. What sets the exit status is
 * whether the call completed, not whether the platform agreed; `--strict` makes a refusal a
 * failure too.
 */
import { DOORS_PRINTED, isDoor } from "@zz/contracts";
import { Mcp, McpError } from "@zz/mcp-client";

import { die, envRequired, optional, parseArgs, platformToken } from "../lib/cli.js";

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv, ["list", "strict", "json"]);
  const door = args.positional[0];
  const tool = args.positional[1];
  const listing = args.flags.has("list");

  if (!door || (!tool && !listing)) {
    die("usage: call <door> <tool> ['<json args>']   |   call <door> --list\n" +
        `       doors: ${DOORS_PRINTED.join("  ")}`);
  }
  // From @zz/contracts, where the gateway's door set is stated once and the gate holds it against
  // server.ts's own DOORS. Retyped here, the list goes stale and a retired door passes validation
  // and fails as a connection error with nothing pointing at the cause.
  if (!isDoor(door)) {
    die(`${JSON.stringify(door)} is not a door on this gateway — ` +
        `expected ${DOORS_PRINTED.join(", ")}`);
  }

  // Parsed before the network call. A mistyped argument object should cost nothing, and the
  // connection below can take thirty seconds to fail.
  const raw = args.positional[2];
  let toolArgs: unknown = {};
  if (raw !== undefined) {
    try {
      toolArgs = JSON.parse(raw);
    } catch (err) {
      die(`the arguments are not JSON: ${String((err as Error).message)}\n` +
          `       got: ${raw.slice(0, 120)}`);
    }
    if (toolArgs === null || typeof toolArgs !== "object" || Array.isArray(toolArgs)) {
      die("the arguments must be a JSON object, e.g. '{\"team\":\"x\"}'");
    }
  }

  const base = envRequired("ZZ_URL", "the gateway to call, e.g. https://api.example.com")
    .replace(/\/+$/, "");
  // Resolved, not demanded: ~/.zz/token is written by the platform's own install step — see
  // platformToken().
  const pat = platformToken();
  const timeout = Number(optional(args, "timeout", "milliseconds to wait for one call") ?? "180000");

  const mcp = new Mcp(`${base}${door}`, { pat, client: "call", timeoutMs: timeout });

  if (listing) {
    const tools = await mcp.tools();
    for (const t of tools) console.log(t.name);
    // Non-zero on an empty door: a door that offers nothing is either the wrong door or a
    // caller with no authority there, and both read as success if the answer is silence.
    if (!tools.length) {
      console.error(`${door} offers no tools to this caller — wrong door, or no authority on it`);
      return 2;
    }
    return 0;
  }

  const said = await mcp.call(tool, toolArgs);
  console.log(said);
  // A refusal is an answer, and the default status says the call completed. The platform's
  // refusals are written to teach the rule, so a caller reading stdout has what it needs;
  // --strict is for a script that wants the refusal to stop it.
  if (args.flags.has("strict") && /^ERROR[: ]/m.test(said)) return 1;
  return 0;
}

try {
  process.exit(await main(process.argv.slice(2)));
} catch (err) {
  // McpError carries the status; anything else is this tool's own fault and says so plainly.
  const message = err instanceof McpError ? err.message : String((err as Error).message ?? err);
  console.error(message);
  process.exit(2);
}
