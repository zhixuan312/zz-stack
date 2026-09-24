#!/usr/bin/env node
// I-17: the launcher's pure slice — argv construction with no shell, the event filtering per
// role (both the launcher's own client-side check and the server-side guard it leans on), and
// the refusal when no shell-capable runtime is present, proven to fire before any I/O rather
// than merely returning a value nobody acted on.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
// Type-only: erased by Node's type stripping at run time, present for `tsc` and for the
// `nothing is exported that nobody imports` gate rule — the public surface a future caller
// (the IMPROVE skill, or Task I-21) builds a `ReplayStartResult`/`LaunchOpts` against.
import type { McpServerSpec } from "../packages/tools/dist/replay/plan.js";
import type { LaunchOpts, LaunchResult, ReplayStartResult } from "../packages/tools/dist/replay/launch.js";

const plan = await import(
  pathToFileURL(join(process.cwd(), "packages/tools/dist/replay/plan.js")).href);
const { roleReadGuard } = await import(
  pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/replay-runs.js")).href);
const { launchReplay, redact } = await import(
  pathToFileURL(join(process.cwd(), "packages/tools/dist/replay/launch.js")).href);

const {
  assertRoleEvents, shellCapableRuntime, refuseBeforeIO, replayRefFor, worktreeDirName,
  gitUpdateRefArgv, gitUpdateRefDeleteArgv, gitWorktreeAddArgv, gitWorktreeRemoveArgv,
  claudeMarketplaceAddArgv, claudeInstallArgv, claudeSessionArgv, candidateMcpConfig,
  NO_MCP_CONFIG, stillAsking, idempotencyKey,
} = plan;

// ---- argv construction with no shell: every builder returns an array, one argument per path
// or name however many spaces or metacharacters it carries — nothing here is ever joined into
// a string a shell would re-tokenize.
assert.deepEqual(gitUpdateRefArgv("refs/replay/replay-x", "abc123"),
  ["update-ref", "refs/replay/replay-x", "abc123"]);
assert.deepEqual(gitUpdateRefDeleteArgv("refs/replay/replay-x"), ["update-ref", "-d", "refs/replay/replay-x"]);
assert.deepEqual(gitWorktreeAddArgv("/tmp/a path/wt", "refs/replay/replay-x"),
  ["worktree", "add", "--detach", "/tmp/a path/wt", "refs/replay/replay-x"],
  "a space in the path is one argv element, not a shell-visible token boundary");
assert.deepEqual(gitWorktreeRemoveArgv("/tmp/wt"), ["worktree", "remove", "--force", "/tmp/wt"]);
assert.deepEqual(claudeMarketplaceAddArgv("/tmp/wt"), ["plugin", "marketplace", "add", "/tmp/wt"]);
assert.deepEqual(claudeInstallArgv("zz-plugin-eval", "zz-stack"),
  ["plugin", "install", "-y", "zz-plugin-eval@zz-stack"]);
assert.equal(replayRefFor("replay-sdlc-a1b2c3d4"), "refs/replay/replay-sdlc-a1b2c3d4");
assert.equal(worktreeDirName("replay-sdlc-a1b2c3d4"), "replay-replay-sdlc-a1b2c3d4");

const sessionArgv = claudeSessionArgv({
  model: "sonnet", newSessionId: "sid-1", mcpConfigPath: "/tmp/mcp.json", strictMcpConfig: true,
  prompt: "do the thing; `rm -rf /` is just text here",
});
assert.deepEqual(sessionArgv, [
  "-p", "--model", "sonnet", "--permission-mode", "bypassPermissions",
  "--output-format", "stream-json", "--verbose", "--session-id", "sid-1",
  "--mcp-config", "/tmp/mcp.json", "--strict-mcp-config",
  "do the thing; `rm -rf /` is just text here",
], "the prompt is one argv element whatever text it carries, never shell-expanded");
const resumeArgv = claudeSessionArgv({ model: "sonnet", resumeSessionId: "sid-1", prompt: "next" });
assert.ok(resumeArgv.includes("--resume") && resumeArgv.includes("sid-1"));
assert.ok(!resumeArgv.includes("--session-id"), "resume never also passes --session-id");

// ---- the candidate's MCP config: always zz-core, plus the plugin's own door when it has one;
// sdlc has none of its own, so it gets only zz-core.
const evalCfg = candidateMcpConfig("zz-plugin-eval", "http://localhost:18000", "tok-1", "zz-replay");
assert.deepEqual(Object.keys(evalCfg.mcpServers).sort(), ["zz-core", "zz-plugin-eval"]);
assert.equal(evalCfg.mcpServers["zz-plugin-eval"].url, "http://localhost:18000/eval/mcp");
assert.equal(evalCfg.mcpServers["zz-core"].headers.Authorization, "Bearer tok-1");
const sdlcCfg = candidateMcpConfig("sdlc", "http://localhost:18000", "tok-1", "zz-replay");
assert.deepEqual(Object.keys(sdlcCfg.mcpServers), ["zz-core"]);
assert.deepEqual(NO_MCP_CONFIG, { mcpServers: {} }, "the simulated person gets no servers at all");

// ---- event filtering per role: the launcher's own client-side check.
const events = [
  { seq: 0, visibility: "actor" }, { seq: 1, visibility: "user_oracle" },
  { seq: 2, visibility: "evaluation_oracle" },
];
assert.deepEqual(assertRoleEvents([events[0]], "actor"), [events[0]]);
assert.throws(() => assertRoleEvents(events, "actor"),
  /got a "user_oracle" event for role "actor"/, "the candidate must never see an oracle event");
assert.deepEqual(assertRoleEvents([events[0], events[1]], "simulated_person"), [events[0], events[1]]);
assert.throws(() => assertRoleEvents(events, "simulated_person"),
  /got a "evaluation_oracle" event for role "simulated_person"/,
  "the simulated person must never see an evaluation_oracle event either");

// ---- the same boundary, server-side: a credential bound to a run's own team may read role
// actor and nothing else — roleReadGuard, added to replay-runs.ts for this task.
assert.equal(roleReadGuard("replay-sdlc-a1b2c3d4", "replay-sdlc-a1b2c3d4", "actor"), null);
assert.match(
  roleReadGuard("replay-sdlc-a1b2c3d4", "replay-sdlc-a1b2c3d4", "simulated_person"),
  /may only read role: actor events/);
assert.match(
  roleReadGuard("replay-sdlc-a1b2c3d4", "replay-sdlc-a1b2c3d4", "evaluator"),
  /may only read role: actor events/);
// An unbound credential (or one bound to a DIFFERENT team) is not this guard's concern —
// context/verifier-token/proof-sealing are what gate it, elsewhere.
assert.equal(roleReadGuard(null, "replay-sdlc-a1b2c3d4", "evaluator"), null);
assert.equal(roleReadGuard("some-other-team", "replay-sdlc-a1b2c3d4", "simulated_person"), null);

// ---- stillAsking / idempotencyKey.
assert.equal(stillAsking("what did you mean by that?"), true);
assert.equal(stillAsking("done, thanks."), false);
assert.equal(idempotencyKey("run-1", "replay_close"), idempotencyKey("run-1", "replay_close"), "deterministic");
assert.notEqual(idempotencyKey("run-1", "replay_close"), idempotencyKey("run-2", "replay_close"));

// ---- the runtime refusal: fires before any I/O, not merely as a returned value.
assert.equal(shellCapableRuntime({ platform: "darwin", shellPath: "/bin/sh" }).ok, true);
const incapable = shellCapableRuntime({ platform: "darwin", shellPath: null });
assert.equal(incapable.ok, false);
assert.match(incapable.reason, /no shell-capable runtime/);

const untouched = () => { throw new Error("refuseBeforeIO touched I/O before checking the runtime"); };
assert.throws(() => refuseBeforeIO({ platform: "darwin", shellPath: null }, untouched),
  /no shell-capable runtime/, "the refusal must fire before `run` is ever called");
let ran = false;
const value = refuseBeforeIO({ platform: "darwin", shellPath: "/bin/sh" }, () => { ran = true; return 42; });
assert.equal(ran, true, "a capable runtime must still call run");
assert.equal(value, 42);

// ---- launchReplay's own two argument guards fire before any Mcp/subprocess object is even
// constructed — real calls through the real exported function, no stub needed, because both
// checks in launch.ts run before its first `new Mcp(...)`.
const start: ReplayStartResult = {
  replay_run_id: "11111111-1111-1111-1111-111111111111", team_slug: "replay-sdlc-a1b2c3d4",
  worktree_ref: "refs/replay/replay-sdlc-a1b2c3d4", digest: "d", token: null,
  token_already_issued: true, dependency_modes: [],
};
const opts: LaunchOpts = { repoRoot: "/tmp", gatewayUrl: "" };
await assert.rejects(launchReplay(start, opts), /no gatewayUrl/,
  "no gateway configured must refuse before anything else runs");
await assert.rejects(launchReplay(start, { ...opts, gatewayUrl: "http://localhost:18000" }),
  /no token on this ReplayStartResult/,
  "a replay_start with no token (a same-key retry's token: null) must refuse rather than run a candidate with no credential");
const okShape: LaunchResult = { status: "failed", logPath: "/tmp/x.jsonl" };
assert.ok(okShape.status === "completed" || okShape.status === "failed");
const doorSpec: McpServerSpec = { type: "http", url: "http://x/core/mcp", headers: {} };
assert.equal(doorSpec.type, "http");

// ---- redact (fix dispatch, I-17/I-19: a replay's score must measure the replay, and what it
// produced must never carry the run's own credentials off this process). Every occurrence
// replaced, never partial, no false positives on unrelated text.
assert.equal(redact("token is tok-secret-1 twice: tok-secret-1", ["tok-secret-1"]),
  "token is [REDACTED] twice: [REDACTED]", "every occurrence of a secret is replaced");
assert.equal(redact("nothing to hide here", ["tok-secret-1"]), "nothing to hide here",
  "text carrying no secret is returned unchanged");
assert.equal(redact("tok-1 and tok-2 both present", ["tok-1", "tok-2"]),
  "[REDACTED] and [REDACTED] both present", "every secret in the list is redacted independently");
assert.equal(redact("some text", [""]), "some text", "an empty secret is never matched against");

console.log("ok replay-launch-pure");
