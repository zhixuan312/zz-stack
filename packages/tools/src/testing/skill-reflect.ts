/**
 * skill-reflect — read the evidence, propose ONE change to ONE skill, in the skill's own words
 *
 *   zz-tool skill-reflect --skill ops-select --file catalog/.../SKILL.md [--since '7 days']
 *   zz-tool skill-reflect --file skills/casebox-stg-usage/SKILL.md --json
 *   zz-tool skill-reflect --file … --psql '<command>'    # a database somewhere else
 *
 * WHAT THIS IS. The reflect half of reflective prompt evolution: a system whose components are
 * text, an evaluation that produces a score, and — the part most setups cannot produce —
 * natural-language feedback saying WHY something failed. The platform's refusals are exactly
 * that. `expected "zhixuan" at app_code` is not a count, it is a sentence naming the rule that
 * was broken, written by the system that broke on it.
 *
 * WHAT IT DELIBERATELY IS NOT. It does not rewrite a skill. It proposes ONE addition, bounded,
 * quoting the evidence that earned it — because the loop's own rule is one change per round,
 * and a rewrite makes the next measurement unattributable to anything.
 *
 * THE HONEST LIMIT, PRINTED ON EVERY RUN. A proposal derived from a scenario's refusals and
 * then measured on that same scenario is fitted to it, not an improvement to the skill. That
 * is not a flaw in this tool and no amount of code fixes it: it needs a second scenario the
 * proposal was not derived from. Until there is one, every result here is provisional and says
 * so, because a loop that cannot tell fitting from learning will report the first as the second
 * indefinitely.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

import { die, optional, parseArgs } from "../lib/cli.js";
import { DEFAULT_PSQL } from "../lib/psql.js";
import { readRows, score, type StepScore } from "./step-score.js";

// `||`, not `??`: an unset variable arrives from a container as "", which `??` keeps.
const MODEL = process.env.JUDGE_MODEL || "sonnet";

const SYSTEM = [
  "You improve one skill file for an agent platform, from evidence.",
  "",
  "You are given: the skill's current text, and the refusals its calls actually produced.",
  "Those refusals are the platform's or a building block's own sentences saying which rule was",
  "broken. They are the only evidence there is. Do not invent others.",
  "",
  "Propose EXACTLY ONE addition to the skill: a short passage, in the same voice as the file,",
  "that would have prevented the most frequent refusal. Rules:",
  "- One change. Not a rewrite, not a list of improvements.",
  "- Quote the refusal that earned it, verbatim, so a later reader can check the reasoning.",
  "- Say what to DO, not what to avoid. 'Read the schema before the first call' beats",
  "  'do not guess arguments'.",
  "- If the refusals are the block's own defect (a bare HTTP status, an HTML page, a missing",
  "  tool), say so and propose NOTHING for the skill. A skill cannot fix somebody else's server,",
  "  and pretending otherwise adds words that will never help.",
  "- If nothing in the evidence warrants a change, say so plainly. A round with no change is a",
  "  correct outcome, not a failure.",
  "",
  "Answer as JSON: {\"change\": boolean, \"why\": string, \"passage\": string, \"anchor\": string}",
  "`anchor` is a short exact line from the skill AFTER which the passage should be inserted.",
  "`passage` is markdown, at most 12 lines. Empty when change is false.",
].join("\n");

interface Proposal {
  change: boolean;
  why: string;
  passage: string;
  anchor: string;
}

async function ask(prompt: string): Promise<Proposal> {
  // THROUGH THE LOCAL CLI, for the same two reasons as eval-judge. The platform's own cheap model
  // behind LLM_BASE_URL is the right home for a loop that runs in production, but that key
  // answers 401 today — which means this tool, the reflect half of the whole improvement loop,
  // has been unusable for as long as that has been true and said nothing about it. And reading
  // refusals to work out which rule a skill is missing is not a flash-tier task.
  //
  // NO TOOLS. Given a filesystem the reflector reads the repository and proposes changes from
  // what it finds there, which is a different and much weaker thing than proposing them from the
  // evidence it was handed.
  const said = await new Promise<string>((resolve, reject) => {
    const child = execFile("claude",
      ["-p", "--model", MODEL, "--output-format", "json", "--disallowed-tools", "*"],
      { maxBuffer: 64 * 1024 * 1024, timeout: 600_000 },
      (err, stdout) => (err && !stdout ? reject(err) : resolve(stdout)));
    child.stdin?.end(`${SYSTEM}\n\n---\n\n${prompt}`);
  }).catch((err: Error) => die(`the reflection model could not be reached: ${err.message}`));

  let text = said;
  try {
    const frame = JSON.parse(said) as { result?: string; is_error?: boolean };
    if (frame.is_error) die(`the reflection model errored: ${String(frame.result ?? "").slice(0, 300)}`);
    text = frame.result ?? said;
  } catch { /* not the wrapper frame — treat the whole reply as the answer */ }

  // The model's answer is READ, never trusted to be shaped right. A reflection step that
  // crashes on its own output is a loop that stops the first time a model adds a code fence.
  const json = /\{[\s\S]*\}/.exec(text);
  if (!json) die(`the reflection model did not answer with JSON:\n${text.slice(0, 400)}`);
  try {
    const p = JSON.parse(json[0]) as Proposal;
    return {
      change: Boolean(p.change),
      why: String(p.why ?? "").trim(),
      passage: String(p.passage ?? "").trim(),
      anchor: String(p.anchor ?? "").trim(),
    };
  } catch (err) {
    return die(`the reflection model's JSON did not parse: ${String((err as Error).message)}`);
  }
}

function evidenceFor(s: StepScore): string {
  return [
    `Skill: ${s.step}, version ${s.version}`,
    `Calls in this window: ${s.calls}`,
    `Refusals the flow could have avoided: ${s.ours} (${(s.rate * 100).toFixed(1)}%)`,
    `Refusals belonging to the block it called: ${s.theirs}`,
    `Platform guardrails (working as intended, not defects): ${s.guardrail}`,
    "",
    "The sentences, most frequent first:",
    ...s.says.map((x) => `  ${x.n}x  ${x.text}`),
  ].join("\n");
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv, ["json"]);
  const psql = args.flags.get("psql") || DEFAULT_PSQL;
  const since = args.flags.get("since") || "7 days";
  const file = optional(args, "file", "the path to the skill being reflected on");

  const rows = readRows(psql, since);
  const { steps, blocks } = score(rows);
  if (!steps.length) {
    console.log(`\n  No attributed calls in the last ${since}. There is nothing to reflect on —`);
    console.log("  run the flow first. A proposal with no evidence behind it is a guess.\n");
    return 0;
  }

  // The step with the most refusals THE FLOW COULD HAVE AVOIDED. Not the busiest step, and not
  // the one with the most refusals overall — a step that met a broken block all day is not the
  // step to edit.
  const wanted = optional(args, "skill", "which step to reflect on, instead of the worst");
  const target = wanted ? steps.find((s) => s.step === wanted) : steps.find((s) => s.ours > 0);
  if (!target) {
    console.log("\n  No step in this window produced a refusal the flow could have avoided.");
    console.log("  That is a correct outcome: nothing here needs changing.\n");
    return 0;
  }
  if (!file) die(`--file is required: the path to ${target.step}'s SKILL.md`);

  const text = readFileSync(file, "utf8");
  const prompt = [
    "THE EVIDENCE", "", evidenceFor(target), "",
    "WHAT THE BLOCKS DID, for context — these are not the skill's fault and it cannot fix them:",
    ...blocks.map((b) => `  ${b.block} @ ${b.version}: ${b.theirs} of ${b.calls} calls refused`),
    "", "THE SKILL AS IT STANDS", "", text,
  ].join("\n");

  const p = await ask(prompt);

  if (args.flags.has("json")) {
    console.log(JSON.stringify({ step: target.step, version: target.version, file, ...p }, null, 2));
    return 0;
  }

  console.log(`\n== REFLECTION on ${target.step} @ ${target.version}\n`);
  console.log(evidenceFor(target).replace(/^/gm, "  "));
  console.log("");
  if (!p.change) {
    console.log("  PROPOSAL: no change.");
    console.log(`  ${p.why}`);
    console.log("");
    return 0;
  }
  console.log("  PROPOSAL, one change:");
  console.log(`  ${p.why}`);
  console.log("");
  console.log(`  after the line: ${p.anchor}`);
  console.log("");
  console.log(p.passage.replace(/^/gm, "  | "));
  console.log("");
  console.log("  BEFORE THIS COUNTS AS AN IMPROVEMENT it has to be measured on a scenario it was");
  console.log("  NOT derived from. This proposal was read off one scenario's refusals; measuring");
  console.log("  it on that same scenario fits the skill to the scenario and reports it as");
  console.log("  learning. Add a second scenario, or treat the next number as provisional.");
  console.log("");
  return 0;
}

try {
  process.exit(await main(process.argv.slice(2)));
} catch (err) {
  console.error(String((err as Error)?.message ?? err));
  process.exit(2);
}
