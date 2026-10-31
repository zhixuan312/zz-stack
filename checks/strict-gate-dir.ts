// Two claims: every gate module is reached, and none is typed by widening to `any`.
// COUPLED: strict-tooling-zero.ts runs the compiler over this subtree; this reads what it accepts.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const fail: string[] = [];

const modules = readdirSync("scripts/gate/checks").filter((f) => f.endsWith(".ts"));
// DELIBERATE: a floor, not an exact count — the exact number is wrong the first time a module
// is added or split. What must hold is that gate.ts imports every module that exists.
if (modules.length < 30) fail.push(`scripts/gate/checks holds only ${modules.length} modules — something was lost`);
const gate = readFileSync("scripts/gate.ts", "utf8");
// A module that registers nothing is reached differently, and still has to be reached. A
// module carrying a top-level `check(` must be imported by gate.ts, which is the order the
// checks run in and the only thing that runs them; a module carrying none — `suite-runner.ts`
// holds shared machinery and registers nothing — must be imported by something else under
// scripts/gate/, because a module nobody imports is dead.
const gateTree = readdirSync("scripts/gate", { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith(".ts"))
  .map((e) => readFileSync(join(e.parentPath, e.name), "utf8")).join("\n");
for (const m of modules) {
  const registers = /^check\(/m.test(readFileSync(join("scripts/gate/checks", m), "utf8"));
  if (registers) {
    if (!gate.includes(`./gate/checks/${m}`)) fail.push(`scripts/gate.ts does not import ${m}`);
    continue;
  }
  if (!new RegExp(`from "(?:\\./|\\.\\./checks/)${m.replace(".", "\\.")}"`).test(gateTree)) {
    fail.push(`${m} registers no check and nothing under scripts/gate/ imports it — it is dead`);
  }
  continue;
}
// Every check(...) registration still present. A type fix that drops one is invisible otherwise.
let registered = 0;
for (const m of modules) registered += [...readFileSync(join("scripts/gate/checks", m), "utf8").matchAll(/^check\(/gm)].length;
if (registered < 100) fail.push(`only ${registered} check() registrations found across the gate modules — ` +
                                `some were lost`);
for (const f of modules) {
  const src = readFileSync(join("scripts/gate/checks", f), "utf8");
  src.split("\n").forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "");
    if (/:\s*any\b|<any>|as\s+any\b/.test(code)) fail.push(`scripts/gate/checks/${f}:${i + 1} uses any`);
  });
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
