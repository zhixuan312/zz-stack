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
for (const m of modules) {
  if (!gate.includes(`./gate/checks/${m}`)) fail.push(`scripts/gate.ts does not import ${m}`);
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
