// The plant: break each rule, prove red; restore, prove green; and a control that must not fire.
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
const MF = "catalog/zz/zz-plugin-eval/flow.json";
const original = readFileSync(MF, "utf8");
const gate = () => { try { execFileSync("node", ["scripts/gate.mjs"], { stdio: "pipe" }); return 0; }
                     catch { return 1; } };
const fail = [];
const restore = () => writeFileSync(MF, original);

if (gate() !== 0) { console.error("the gate is already red; the plant cannot measure anything"); process.exit(1); }

// 1. A shipped skill that is not declared.
const stray = "catalog/zz/zz-plugin-eval/skills/zz-plugin-stray";
mkdirSync(stray, { recursive: true });
writeFileSync(`${stray}/SKILL.md`, "---\nname: zz-plugin-stray\n---\n# stray\n");
if (gate() === 0) fail.push("an undeclared shipped skill did not turn the gate red");
rmSync(stray, { recursive: true, force: true });

// 2. A declared skill that is not shipped.
const m = JSON.parse(original); m.libraries = [...(m.libraries || []), "zz-plugin-absent"];
writeFileSync(MF, JSON.stringify(m, null, 2));
if (gate() === 0) fail.push("a declared-but-absent skill did not turn the gate red");
restore();

// 3. A missing purpose.
const m2 = JSON.parse(original); delete m2.purpose;
writeFileSync(MF, JSON.stringify(m2, null, 2));
if (gate() === 0) fail.push("a manifest with no purpose did not turn the gate red");
restore();

// 4. CONTROL — a harmless edit must NOT fire the check. An over-broad rule that reddens on
//    any manifest change is as useless as one that never reddens.
const m3 = JSON.parse(original); m3.description = `${m3.description} `;
writeFileSync(MF, JSON.stringify(m3, null, 2));
if (gate() !== 0) fail.push("the check fires on a harmless description edit; it is too broad");
restore();

if (gate() !== 0) fail.push("the gate did not return green after restore");
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("plugin-declaration plant: ok");
