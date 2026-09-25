/**
 * The evaluation door — the second MCP surface this one process serves.
 *
 * A door and not a tool group: the core door is in the client package's required baseline
 * plugin, so a tool registered there is on every account. These tools are one flow's
 * instrument — `catalog/zz/zz-plugin-eval/flow.json` declares this path in its `servers` — so
 * they arrive with that flow's plugin and are absent from every list without it.
 *
 * One process, two doors. `serveMcp` takes a factory and runs it per request, so two tool sets
 * need no transport change, no new container and no second credential. The gateway
 * authenticates `/eval/mcp` exactly as `/core/mcp` and forwards it to `/eval-mcp` here.
 *
 * A file of its own rather than a second function in server.ts, which binds :8000 at module
 * scope and cannot be imported. This exports the function the service mounts, so
 * checks/eval-door.ts opens a real client against the real door and reads the real tool list.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { serviceVersion } from "@zz/mcp-http";

import { recordingDoor } from "./door.js";
import { registerCandidateBuildTools } from "./eval/candidate-build.js";
import { registerCandidateTools } from "./eval/candidates.js";
import { registerEvaluationTools } from "./eval/evaluate.js";
import { registerFailureDiscoverTools } from "./eval/discover.js";
import { registerObserveTools } from "./eval/observe.js";
import { registerPluginEvalTools } from "./eval/plugin-eval.js";
import { registerPluginJudgeTools } from "./eval/plugin-judge.js";
import { registerPluginRecordTools } from "./eval/plugin-record.js";
import { registerProtocolTools } from "./eval/protocol.js";
import { registerEvaluatorQualifyTools } from "./eval/qualify.js";
import { registerReleaseTools } from "./eval/release.js";
import { registerReplayCaseTools } from "./eval/replay-cases.js";
import { registerReplayCloseTools } from "./eval/replay-close.js";
import { registerReplayScoreTools } from "./eval/replay-score.js";
import { registerReplayRunTools } from "./eval/replay-runs.js";
import { registerSubjectTools } from "./eval/subject.js";

/** What this door says about itself at `initialize`, before any tool is called.
 *
 * The same contract as orientation.ts's `CORE_INSTRUCTIONS`: an addition and never a
 * replacement (Claude Desktop parses this field without showing it to the model), the first 512
 * characters self-contained because that is what Codex keeps, and the whole under the ~2KB
 * Claude Code truncates at. So the skill to read comes first and the detail after.
 *
 * COUPLED: checks/orientation.ts derives the noun set from the live `tools/list` and compares it
 * with this text in both directions, so the paragraph below has to change in the same commit as
 * a registration under a new prefix. This door serves twelve nouns — plugin, protocol, round,
 * finding, failure, evaluator, evaluation, replay, improvement, candidate, release and proposal.
 *
 * It names the other door on purpose: everyone holding this one also holds `/core/mcp`. */
const EVAL_INSTRUCTIONS =
  "zz-plugin-eval is this platform's instrument for judging a plugin by what its real runs " +
  "did. It measures, and never changes what it measures — from this platform's own record " +
  "of what its doors did, never a second runner. This is the /eval/mcp door.\n\n" +
  'START HERE: skill_read("zz-plugin-eval") on the /core/mcp door — it carries the order these ' +
  "tools go in and what the evidence is worth. A protocol is agreed BEFORE any scoring, " +
  "in a gated protocol.md; a score produced before that gate is evidence of nothing.\n\n" +
  "The nouns, one line each:\n" +
  "  plugin_*   identify the plugin an evaluation is about, profile what its runs did, and " +
  "read it against the conformance standard\n" +
  "  protocol_*  read whether this plugin's protocol is still compatible, record a new " +
  "version, bind approval\n" +
  "  round_*    read a historic ordinal round back; no new round is scored\n" +
  "  finding_*  record what an EVALUATE run concluded, close it when applied or rejected\n" +
  "  failure_*  mine an observation snapshot for failure modes, before any protocol exists\n" +
  "  evaluator_*  qualify one evaluator version against a protocol's policy, before its " +
  "answers count\n" +
  "  evaluation_*  bind a protocol version and an observation snapshot into one run, assess " +
  "and score it\n" +
  "  replay_*  derive replay cases and start, begin, read, close a run\n" +
  "  improvement_*  open an optimization run against plugin-owned findings\n" +
  "  candidate_*  persist a proposed patch before it executes, record its local build\n" +
  "  release_*  prepare, apply, record a candidate's promotion\n" +
  "  proposal_*  write an owner-facing proposal nobody here can promote\n\n" +
  "Everything else is on /core/mcp and not here: documents and their gates, your team's " +
  "knowledge store, skills, sources, and who you are — session_whoami there answers today's " +
  "date and which team you are acting for.\n\n" +
  "NOT FOR: changing a plugin, installing or removing one, or scoring against a ruler nobody " +
  "agreed to. This door reads evidence the platform already holds and records what it found.";

/** The evaluation door, built the way the service mounts it.
 *
 *  `recordingDoor` is what makes a thrown `Refusal` arrive in this platform's refusal shape and
 *  puts these names, under this door's name, into the surface the service records about itself. */
export function buildEvalServer(): McpServer {
  const server = recordingDoor(new McpServer(
    { name: "zz-plugin-eval", version: serviceVersion(import.meta.url) },
    // Second argument, not the first. `instructions` is `ServerOptions`, beside `capabilities`;
    // the first argument is `Implementation` and carries only name/version/title. In an object
    // the SDK spreads it would be dropped in silence.
    { instructions: EVAL_INSTRUCTIONS },
  ),
  // The door this is, in the gateway's own word for it: `doorSurface("/eval/mcp")` is "eval",
  // and so is the left half of every `tool_key` recorded for a call through here. It goes into
  // zz.plugin_tool.door, so the recorded surface can be read against the recorded calls.
  "eval");
  registerSubjectTools(server);
  registerObserveTools(server);
  registerPluginEvalTools(server);
  registerPluginJudgeTools(server);
  registerPluginRecordTools(server);
  registerProtocolTools(server);
  registerFailureDiscoverTools(server);
  registerEvaluatorQualifyTools(server);
  registerEvaluationTools(server);
  registerReplayCaseTools(server);
  registerReplayRunTools(server);
  registerReplayCloseTools(server);
  registerReplayScoreTools(server);
  registerCandidateTools(server);
  registerCandidateBuildTools(server);
  registerReleaseTools(server);
  return server;
}
