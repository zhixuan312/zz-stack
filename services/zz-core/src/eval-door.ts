/**
 * The evaluation door — the second MCP surface this one process serves.
 *
 * WHY A DOOR AND NOT A TOOL GROUP. The core door is in the client package's REQUIRED baseline
 * plugin, so a tool registered there is on every account on this platform, whether or not that
 * person has ever evaluated anything. The tools on THIS door are one flow's instrument:
 * `catalog/zz/zz-plugin-eval/flow.json` declares this path in its `servers`, so they arrive
 * with that flow's plugin and with nothing else. Somebody who has not installed
 * `zz-plugin-eval` now sees every tool on this door gone from their list — which is the whole
 * point, since a model picks a tool from the list it was given.
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
 * the very function the service mounts, so checks/eval-door.ts opens a real client against
 * the real door and reads back the real tool list.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { serviceVersion } from "@zz/mcp-http";

import { recordingDoor } from "./door.js";
import { registerPluginEvalTools } from "./eval/plugin-eval.js";
import { registerPluginJudgeTools } from "./eval/plugin-judge.js";
import { registerPluginRecordTools } from "./eval/plugin-record.js";

/** What this door says about itself at `initialize`, before any tool is called.
 *
 * THE SAME CONTRACT orientation.ts's `CORE_INSTRUCTIONS` is held to, and for the same reasons:
 * it is an ADDITION and never a replacement (Claude Desktop parses this field without showing
 * it to the model), the first 512 characters have to be self-contained because that is what
 * Codex keeps, and the whole thing has to fit under the ~2KB Claude Code truncates at. So the
 * skill to read comes first and the detail comes after.
 *
 * THE NOUNS ARE THE NOUNS THIS DOOR SERVES, and checks/orientation.ts derives that set from
 * the live `tools/list` and compares it with this text in both directions. This door serves
 * five nouns — plugin, ruler, round, case and finding — and it served one until the renames
 * of Task I-21 split them out. That is exactly why the clause earns its keep: the paragraph
 * below had to change in the same commit as the registrations or this door would have gone on
 * announcing a vocabulary it no longer speaks. The day an eleventh tool arrives under a sixth
 * prefix, the same thing happens again.
 *
 * IT NAMES THE OTHER DOOR ON PURPOSE. Everyone holding this one also holds `/core/mcp`, and a
 * paragraph that said only what is here would leave a reader to discover the rest by calling
 * something and being refused. */
const EVAL_INSTRUCTIONS =
  "zz-plugin-eval is this platform's instrument for judging a plugin: what its real runs did, " +
  "and whether installing it beats not installing it. It measures, and it never changes what " +
  "it measures — from this platform's own record of what its doors did, and from no second " +
  "runner. This is the /eval/mcp door and it serves that one job.\n\n" +
  'START HERE: skill_read("zz-plugin-eval") on the /core/mcp door — it carries the order these ' +
  "tools go in and what each kind of evidence is worth. The ruler is agreed BEFORE any scoring, " +
  "in a gated rulers.md; a score produced before that gate is evidence of nothing.\n\n" +
  "The nouns, one line each:\n" +
  "  plugin_*   identify the plugin an evaluation is about, profile what its runs did, and " +
  "read it against the building-block contract\n" +
  "  ruler_*    the three-step gate, in this order: read what a ruler is written from, record " +
  "the ruler, record the stakeholder's approval of it\n" +
  "  round_*    score one version against the ruler in force, and read one round's marks back\n" +
  "  finding_*  record what a round concluded, as rows the next round can read\n\n" +
  "Everything else is on /core/mcp and not here: documents and their gates, your team's " +
  "knowledge store, skills, sources, and who you are — session_whoami there answers today's " +
  "date and which team you are acting for.\n\n" +
  "NOT FOR: changing a plugin, installing or removing one, or scoring against a ruler nobody " +
  "agreed to. This door reads evidence the platform already holds and records what it found.";

/** The evaluation door, built the way the service mounts it.
 *
 * `recordingDoor` is not optional decoration: it is what makes a thrown `Refusal` arrive in
 * this platform's refusal shape, and what puts these names — under THIS door's name — into the
 * surface the service records about itself. A door built without it serves tools that fail
 * differently from every other tool here and that no surface report can see. */
export function buildEvalServer(): McpServer {
  const server = recordingDoor(new McpServer(
    { name: "zz-plugin-eval", version: serviceVersion(import.meta.url) },
    // SECOND ARGUMENT, not the first. `instructions` is `ServerOptions`, beside `capabilities`;
    // the first argument is `Implementation` and carries only name/version/title. Put it in the
    // first and TypeScript rejects it — put it in an object the SDK spreads and it would be
    // dropped in silence.
    { instructions: EVAL_INSTRUCTIONS },
  ),
  // THE DOOR THIS IS, in the gateway's own word for it: `doorSurface("/eval/mcp")` is "eval"
  // and so is the left half of every `tool_key` recorded for a call through here. It is what
  // goes into zz.plugin_tool.door, so the surface we record can be read against the calls we
  // recorded. Stated here because the mount in server.ts is the wrong place to learn it from —
  // by then the registrations are over.
  "eval");
  registerPluginEvalTools(server);
  registerPluginJudgeTools(server);
  registerPluginRecordTools(server);
  return server;
}
