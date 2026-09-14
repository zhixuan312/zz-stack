// The plant: name a tool that does not exist, prove red; restore, prove green.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const SK = "catalog/zz/zz-plugin-eval/skills/zz-plugin-locate/SKILL.md";
const original = readFileSync(SK, "utf8");
const gate = () => { try { execFileSync("node", ["scripts/gate.mjs"], { stdio: "pipe" }); return 0; }
                     catch { return 1; } };
const fail = [];

if (gate() !== 0) { console.error("the gate is already red; the plant cannot measure anything"); process.exit(1); }

// 1. A named tool that no door exposes.
writeFileSync(SK, `${original}\n\nCall \`plugin_invented\` to do the thing.\n`);
if (gate() === 0) fail.push("a skill naming a nonexistent tool did not turn the gate red");
writeFileSync(SK, original);

// 2. CONTROL — naming a tool that DOES exist must not fire.
writeFileSync(SK, `${original}\n\nCall \`plugin_profile\` to compute the facts.\n`);
if (gate() !== 0) fail.push("the check fires on a tool that legitimately exists; it is too broad");
writeFileSync(SK, original);

// 3. CONTROL — an English word that happens to be a tool name must not fire out of prose.
writeFileSync(SK, `${original}\n\nThe stakeholder may approve or close the work at their discretion.\n`);
if (gate() !== 0) fail.push("the check fires on ordinary prose using approve/close as English");
writeFileSync(SK, original);

if (gate() !== 0) fail.push("the gate did not return green after restore");
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("tool-reachability plant: ok");
