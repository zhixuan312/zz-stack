// Two claims: the subtree is clean, and annotating it did not change what the gate runs.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const fail: string[] = [];
const r = spawnSync("npx", ["tsc", "--noEmit", "-p", "tsconfig.tooling.json"], { encoding: "utf8" });
const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
const mine = out.split("\n").filter((l) => /^scripts\/gate\/[^(]*\(\d+,\d+\): error TS/.test(l));
if (mine.length) fail.push(`${mine.length} strict error(s) remain under scripts/gate/:\n` + mine.slice(0, 20).join("\n"));

const modules = readdirSync("scripts/gate/checks").filter((f) => f.endsWith(".ts"));
// DERIVED, NOT HARDCODED. A count written here is wrong the first time a module is added or
// split — which happened during this very conversion, when data-telemetry.ts was split for
// the 700-line ceiling. What must hold is that gate.ts imports every module that exists.
if (modules.length < 30) fail.push(`scripts/gate/checks holds only ${modules.length} modules — something was lost`);
const gate = readFileSync("scripts/gate.ts", "utf8");
// A MODULE THAT REGISTERS NOTHING IS REACHED DIFFERENTLY, AND STILL HAS TO BE REACHED.
// `gate.ts` is an ORDER of check modules — its own header says so — and `suite-runner.ts`
// holds the machinery the `suites-*` modules share and registers no check at all. Importing it
// there to satisfy a rule would put a file in the order that contributes nothing to it. So the
// question is asked of what the file DOES: a module carrying a top-level `check(` must be in
// gate.ts, because that import is the only thing that runs it; a module carrying none must be
// imported by SOMETHING under scripts/gate/, because a module nobody imports is dead code the
// directory still pays for. Neither arm is weaker than the rule it replaces, and the second
// catches an orphan the old one could not see.
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
                                `annotating this subtree appears to have removed some`);
for (const f of modules) {
  const src = readFileSync(join("scripts/gate/checks", f), "utf8");
  src.split("\n").forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "");
    if (/:\s*any\b|<any>|as\s+any\b/.test(code)) fail.push(`scripts/gate/checks/${f}:${i + 1} uses any`);
  });
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
