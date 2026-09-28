/**
 * The plant: name a tool that does not exist, prove the gate says so; restore, prove it stops.
 *
 * It reads check names, not the exit status. Appending any line to a shipped SKILL.md turns
 * the gate red four times over — "a skill that changed says so in its version",
 * "plugins.lock.json says what the catalog ships", "the committed marketplace is what the
 * catalog renders" and "a suite's output reaches neither the lock nor the package somebody
 * installs" all fire on the edit itself, whatever the edit says. So the question asked here is
 * whether this check failed, by name, which is falsifiable in both directions and independent
 * of whatever else the tree is in the middle of.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { failing } from "../testing/gate-plant.ts";

const SK = "catalog/zz/zz-plugin-eval/skills/zz-plugin-identify/SKILL.md";
const EXISTS = "a skill never names a platform tool that does not exist";
const REACHES = "a skill never instructs a tool its package cannot reach";

const original = readFileSync(SK, "utf8");
if (!original.trim()) { console.error(`${SK} is empty — refusing to plant into it`); process.exit(1); }

const fail = [];
const restore = () => writeFileSync(SK, original);

// The two checks this plant is about must be green to start with, or nothing below separates
// the defect being planted from one that was already there. DELIBERATE: the rest of the gate
// may be red for its own reasons and this plant does not read that.
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

// 1b. The same name in the other call shape: a skill writes a tool name in quotes as readily
// as in backticks, so an extractor reading only one of the two walks past half its input.
writeFileSync(SK, `${original}\nThe locator dispatches to "plugin_invented" for anything unmatched.\n`);
now = failing();
if (!now.has(EXISTS)) fail.push('a nonexistent tool named in QUOTES rather than backticks was not caught');
else console.log(`  planted "plugin_invented" -> ✗ ${EXISTS}\n      ${now.get(EXISTS)}`);
restore();

// 2. Control — naming a tool that does exist, on a door this package reaches, must not fire.
writeFileSync(SK, `${original}\nCall \`plugin_profile\` to compute the facts.\n`);
now = failing();
if (now.has(EXISTS)) fail.push(`the check fires on a tool that legitimately exists; it is too broad: ${now.get(EXISTS)}`);
if (now.has(REACHES)) fail.push(`a tool on a door this package DOES declare was reported unreachable: ${now.get(REACHES)}`);
restore();

// 3. Control — an English word that happens to be a tool name must not fire out of prose.
writeFileSync(SK, `${original}\nThe stakeholder may approve or close the work at their discretion.\n`);
now = failing();
if (now.has(EXISTS)) fail.push(`the check fires on ordinary prose using approve/close as English: ${now.get(EXISTS)}`);
restore();

// 4. The other half of the property: a tool that exists, on a door this package does not
// declare, where nothing fails at run time and an agent is told to do something it has no
// surface for. `team_switch` is on /manage and zz-plugin-eval declares /eval.
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
