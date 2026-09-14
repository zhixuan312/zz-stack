/**
 * The evaluation door — the second MCP surface this one process serves.
 *
 * WHY A DOOR AND NOT A TOOL GROUP. The core door is in the client package's REQUIRED baseline
 * plugin, so a tool registered there is on every account on this platform, whether or not that
 * person has ever evaluated anything. The ten `plugin_*` tools are one flow's instrument:
 * `catalog/zz/zz-plugin-eval/flow.json` declares this path in its `servers`, so they arrive
 * with that flow's plugin and with nothing else. Somebody who has not installed
 * `zz-plugin-eval` now sees ten fewer tools to choose between — which is the whole point, since
 * a model picks a tool from the list it was given.
 *
 * ONE PROCESS, TWO DOORS — NOT A SECOND SERVICE. `serveMcp` takes a factory and runs it per
 * request, so two tool sets need no transport change, no new container, no duplicated
 * credential and no second copy of the "zz-core has no authentication of its own" premise.
 * The gateway authenticates `/eval/mcp` exactly as it authenticates `/core/mcp` — by the
 * identity gate every non-public path passes through — and forwards it to `/eval-mcp` here.
 * A third service remains possible later and none of this blocks it.
 *
 * A FILE OF ITS OWN, NOT A SECOND FUNCTION IN server.ts, for the reason orientation.ts exists:
 * server.ts binds :8000 at module scope and therefore cannot be imported, so a check that
 * wanted to know what this door actually serves would have had to grep for it. This exports
 * the very function the service mounts, so checks/eval-door.mjs opens a real client against
 * the real door and reads back the real tool list.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { serviceVersion } from "@zz/mcp-http";

import { recordingDoor } from "./door.js";
import { registerPluginEvalTools } from "./tools/plugin-eval.js";
import { registerPluginJudgeTools } from "./tools/plugin-judge.js";
import { registerPluginRecordTools } from "./tools/plugin-record.js";

/** What this door says about itself at `initialize`, before any tool is called.
 *
 * THE SAME CONTRACT orientation.ts's `CORE_INSTRUCTIONS` is held to, and for the same reasons:
 * it is an ADDITION and never a replacement (Claude Desktop parses this field without showing
 * it to the model), the first 512 characters have to be self-contained because that is what
 * Codex keeps, and the whole thing has to fit under the ~2KB Claude Code truncates at. So the
 * skill to read comes first and the detail comes after.
 *
 * THE NOUNS ARE THE NOUNS THIS DOOR SERVES, and checks/orientation.mjs derives that set from
 * the live `tools/list` and compares it with this text in both directions. This door serves
 * one noun, which makes that clause easy to satisfy and not worth skipping: the day an
 * eleventh tool arrives under a different prefix, this paragraph goes red rather than quietly
 * describing the door it used to be.
 *
 * IT NAMES THE OTHER DOOR ON PURPOSE. Everyone holding this one also holds `/core/mcp`, and a
 * paragraph that said only what is here would leave a reader to discover the rest by calling
 * something and being refused. */
const EVAL_INSTRUCTIONS =
  "zz-plugin-eval is this platform's instrument for judging a plugin: what its real runs did, " +
  "and whether installing it beats not installing it. It measures, and it never changes what " +
  "it measures. This is the /eval/mcp door and it serves that one job.\n\n" +
  'START HERE: skill_read("zz-plugin-eval") on the /core/mcp door — it carries the order these ' +
  "tools go in and what each kind of evidence is worth. The ruler is agreed BEFORE any scoring, " +
  "in a gated rulers.md; a score produced before that gate is evidence of nothing.\n\n" +
  "The nouns, one line each:\n" +
  "  plugin_*  find a plugin, profile what its runs did, agree a ruler, judge against it, and " +
  "record what was found\n\n" +
  "Everything else is on /core/mcp and not here: documents and their gates, your team's " +
  "knowledge store, skills, sources, and who you are — session_whoami there answers today's " +
  "date and which team you are acting for.\n\n" +
  "NOT FOR: changing a plugin, installing or removing one, or scoring against a ruler nobody " +
  "agreed to. This door reads evidence the platform already holds and records what it found.";

/** The evaluation door, built the way the service mounts it.
 *
 * `recordingDoor` is not optional decoration: it is what makes a thrown `Refusal` arrive in
 * this platform's refusal shape, and what puts these ten names into the surface the service
 * records about itself. A door built without it serves tools that fail differently from every
 * other tool here and that `eval_block_surface('platform')` cannot see. */
export function buildEvalServer(): McpServer {
  const server = recordingDoor(new McpServer(
    { name: "zz-plugin-eval", version: serviceVersion(import.meta.url) },
    // SECOND ARGUMENT, not the first. `instructions` is `ServerOptions`, beside `capabilities`;
    // the first argument is `Implementation` and carries only name/version/title. Put it in the
    // first and TypeScript rejects it — put it in an object the SDK spreads and it would be
    // dropped in silence.
    { instructions: EVAL_INSTRUCTIONS },
  ));
  registerPluginEvalTools(server);
  registerPluginJudgeTools(server);
  registerPluginRecordTools(server);
  return server;
}
