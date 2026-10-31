#!/usr/bin/env node
/**
 * testing/eval-step.sh runs a step the way its steps.json entry says: an interviewing step is told
 * the stakeholder answers, and the stakeholder remembers the conversation; `--from` continues the
 * initiative the latest run recorded; and the run names no gateway it does not use.
 *
 *   node checks/eval-step-harness.ts
 *
 * `claude` is a stub first on PATH that records every call. Called as the agent it asks a question
 * on each of its first two turns and writes the document the step owes; called as the stakeholder
 * (`--append-system-prompt`) it answers in one line.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = "testing/eval-step.sh";
const fail: string[] = [];
const work = mkdtempSync(join(tmpdir(), "eval-step-"));
const bin = join(work, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "claude"), `#!/usr/bin/env node
const fs = require("fs");
const argv = process.argv.slice(2), log = process.env.STUB_LOG;
fs.appendFileSync(log + "/calls.jsonl", JSON.stringify(argv) + "\\n");
if (argv.includes("--append-system-prompt")) { process.stdout.write("Weekly, please."); process.exit(0); }
const n = fs.readFileSync(log + "/calls.jsonl", "utf8").trim().split("\\n")
  .filter((l) => !JSON.parse(l).includes("--append-system-prompt")).length;
const content = [{ type: "text", text: n <= 2 ? "Which day should it run?" : "Written." }];
if (n === 1) content.push({ type: "tool_use", name: "mcp__zz-core__document_write", input: { path: "stub-initiative/spec.md" } });
console.log(JSON.stringify({ type: "assistant", message: { content } }));
console.log(JSON.stringify({ type: "result", total_cost_usd: 0 }));
`);
chmodSync(join(bin, "claude"), 0o755);

/** One run of the script under the stub; every call it made, agent and stakeholder apart. */
function run(name: string, args: string[]) {
  const log = join(work, name), out = join(log, "out");
  mkdirSync(log);
  const r = spawnSync("bash", [SCRIPT, "--flow", "sdlc/sdlc-flow", "--only", "r01", "--out", out, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_LOG: log, ZZ_TOKEN: "stub", ZZ_URL: "https://not-this.invalid" },
  });
  if (r.status !== 0) fail.push(`${name}: eval-step exited ${r.status}: ${`${r.stdout}${r.stderr}`.trim().split("\n").pop()}`);
  let calls: string[][] = [];
  try { calls = readFileSync(join(log, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)); } catch { /* no call */ }
  const persona = calls.filter((a) => a.includes("--append-system-prompt"));
  const agent = calls.filter((a) => !a.includes("--append-system-prompt"));
  return { agent, persona, prompt: agent[0]?.at(-1) ?? "", out };
}
const flag = (argv: string[], f: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);

// 1. An interviewing step: told somebody answers, and the stakeholder is one conversation.
{
  const r = run("interviews", ["--step", "sdlc-spec", "--max-turns", "3"]);
  if (/nobody to ask/i.test(r.prompt)) fail.push("an interviewing step is told there is nobody to ask");
  if (!/stakeholder will answer/i.test(r.prompt)) fail.push("an interviewing step is never told the stakeholder will answer its questions");
  if (r.persona.length !== 2) fail.push(`the stakeholder was asked ${r.persona.length} time(s), not twice`);
  else {
    const first = flag(r.persona[0], "--session-id"), second = flag(r.persona[1], "--resume");
    if (!first) fail.push("the stakeholder's first answer starts no session, so it remembers nothing");
    if (!second || second !== first) fail.push(`the stakeholder's second answer does not resume its first (${String(first)} then ${String(second)})`);
  }
  const ran = readFileSync(join(r.out, "run.txt"), "utf8");
  if (ran.includes("not-this.invalid")) fail.push("run.txt records $ZZ_URL as the gateway, and the run never uses it");
}

// 2. Control: a step that does not interview is still told nobody can answer.
{
  const r = run("solo", ["--step", "sdlc-explore"]);
  if (!/nobody to ask/i.test(r.prompt)) fail.push("a step that does not interview is no longer told there is nobody to ask");
  if (r.persona.length) fail.push("a step that does not interview was given a stakeholder");
}

// 3. --from after two runs into one directory continues the later one.
{
  const from = join(work, "earlier-runs");
  mkdirSync(from);
  writeFileSync(join(from, "produced.txt"), "r01 2026-10-01-earlier/explore.md\nr01 2026-10-02-latest/explore.md\n");
  const r = run("from", ["--step", "sdlc-spec", "--from", from, "--max-turns", "1"]);
  if (!r.prompt.includes("initiative 2026-10-02-latest")) {
    fail.push(`--from continued ${/initiative (\S+)\./.exec(r.prompt)?.[1] ?? "nothing"}, not the latest run's initiative`);
  }
}

// 4. The script advertises no gateway variable it does not read.
if (readFileSync(SCRIPT, "utf8").includes("ZZ_URL")) fail.push(`${SCRIPT} names ZZ_URL, and every call goes to the installed client's gateway`);

rmSync(work, { recursive: true, force: true });
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("eval-step harness: ok");
