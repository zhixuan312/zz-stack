/**
 * The plant: name a tool that does not exist, prove the gate says so; restore, prove it stops.
 *
 * WHY THIS READS CHECK NAMES AND NOT THE EXIT STATUS. Written as `gate() === 0`, this measured
 * nothing in this repository. Appending ANY line to a shipped SKILL.md turns the gate red four
 * times over — "a skill that changed says so in its version", "plugins.lock.json says what the
 * catalog ships", "the committed marketplace is what the catalog renders" and "a suite's output
 * reaches neither the lock nor the package somebody installs" all fire on the edit itself,
 * whatever the edit says. Measured: the invented-tool case failed 7 checks and BOTH controls
 * failed 5, so a plant reading only the exit code would have recorded "the check fires on a
 * tool that legitimately exists" and "the check fires on ordinary prose" against a check that
 * does neither. Red for unrelated reasons is the failure mode a break-test exists to avoid, and
 * the first version of this one was made entirely of it.
 *
 * So the question asked here is "did THIS check fail", by name, which is falsifiable in both
 * directions and independent of whatever else the tree is in the middle of.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SK = "catalog/zz/zz-plugin-eval/skills/zz-plugin-locate/SKILL.md";
const EXISTS = "a skill never names a platform tool that does not exist";
const REACHES = "a skill never instructs a tool its package cannot reach";

const original = readFileSync(SK, "utf8");
if (!original.trim()) { console.error(`${SK} is empty — refusing to plant into it`); process.exit(1); }

/** The gate's failing checks, by name, with the sentence each gave. */
function failing() {
  let out;
  try {
    out = execFileSync("node", ["scripts/gate.mjs", "--quiet"], { encoding: "utf8", stdio: "pipe" });
  } catch (err) {
    out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  const lines = out.split("\n");
  const found = new Map();
  for (const [i, line] of lines.entries()) {
    const m = /^\s*✗ (.+)$/.exec(line);
    if (m) found.set(m[1], (lines[i + 1] ?? "").trim());
  }
  return found;
}

const fail = [];
const restore = () => writeFileSync(SK, original);

// The two checks this plant is about must be GREEN to start with, or nothing below separates
// the defect being planted from one that was already there. The rest of the gate may be red for
// its own reasons and that is deliberately not this plant's business.
let now = failing();
for (const name of [EXISTS, REACHES]) {
  if (now.has(name)) fail.push(`"${name}" is already failing before anything was planted — this plant cannot measure it`);
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }

// 1. A named tool that no door exposes.
writeFileSync(SK, `${original}\nCall \`plugin_invented\` to do the thing.\n`);
now = failing();
if (!now.has(EXISTS)) fail.push("a skill naming a nonexistent tool did not fail the check that exists to catch it");
else console.log(`  planted \`plugin_invented\` -> ✗ ${EXISTS}\n      ${now.get(EXISTS)}`);
restore();

// 1b. THE SAME NAME IN THE OTHER CALL SHAPE. A skill writes a tool name in quotes as readily as
// in backticks — inside an example argument, a JSON fragment, a sentence naming the call — and
// an extractor that reads only one of the two is a check that half its input walks past.
writeFileSync(SK, `${original}\nThe locator dispatches to "plugin_invented" for anything unmatched.\n`);
now = failing();
if (!now.has(EXISTS)) fail.push('a nonexistent tool named in QUOTES rather than backticks was not caught');
else console.log(`  planted "plugin_invented" -> ✗ ${EXISTS}\n      ${now.get(EXISTS)}`);
restore();

// 2. CONTROL — naming a tool that DOES exist, on a door this package reaches, must not fire.
writeFileSync(SK, `${original}\nCall \`plugin_profile\` to compute the facts.\n`);
now = failing();
if (now.has(EXISTS)) fail.push(`the check fires on a tool that legitimately exists; it is too broad: ${now.get(EXISTS)}`);
if (now.has(REACHES)) fail.push(`a tool on a door this package DOES declare was reported unreachable: ${now.get(REACHES)}`);
restore();

// 3. CONTROL — an English word that happens to be a tool name must not fire out of prose.
writeFileSync(SK, `${original}\nThe stakeholder may approve or close the work at their discretion.\n`);
now = failing();
if (now.has(EXISTS)) fail.push(`the check fires on ordinary prose using approve/close as English: ${now.get(EXISTS)}`);
restore();

// 4. THE OTHER HALF OF THE PROPERTY. A tool that exists, on a door this package does NOT
// declare, is the COMPLETE AND UNREACHABLE shape — the one where nothing fails at run time and
// an agent is simply told to do something it has no surface for. `team_switch` is on /manage,
// and zz-plugin-eval declares /eval. Without this case the plant proves only that a made-up
// name is caught, which is the easy half.
writeFileSync(SK, `${original}\nRun \`team_switch\` before locating anything.\n`);
now = failing();
if (!now.has(REACHES)) fail.push("a skill instructing a real tool on a door its package does not declare was not caught");
else console.log(`  planted \`team_switch\` -> ✗ ${REACHES}\n      ${now.get(REACHES)}`);
restore();

// 5. And it stops when the planting does — a check that stays red after restore is measuring
// the tree it was run in rather than the defect.
now = failing();
for (const name of [EXISTS, REACHES]) {
  if (now.has(name)) fail.push(`"${name}" is still failing after restore: ${now.get(name)}`);
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("tool-reachability plant: ok");
