// The written record matches the delivered surface, and nothing exceeds the ceiling.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
const fail = [];

const arch = readFileSync("ARCHITECTURE.md", "utf8");
const standalone = existsSync("PLUGIN-STANDARD.md") ? readFileSync("PLUGIN-STANDARD.md", "utf8") : "";
const standard = arch + standalone;
for (const rule of ["produces", "documents", "libraries", "commands", "purpose"]) {
  if (!new RegExp(`\\b${rule}\\b`).test(standard)) fail.push(`the standard does not state ${rule}`);
}
if (standalone && !/PLUGIN-STANDARD/.test(arch)) fail.push("ARCHITECTURE.md does not point at the standard");

// The 700-line ceiling, on every file this initiative writes or grows.
const walk = (d) => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? (["node_modules", "dist", "_versions"].includes(f) ? [] : walk(p)) : [p];
});
const touched = ["ARCHITECTURE.md", "STATE.md", ...(standalone ? ["PLUGIN-STANDARD.md"] : []),
                 ...walk("skills"), ...walk("scripts/gate/checks"), ...walk("checks")];
for (const p of touched) {
  if (!/\.(md|mjs|ts)$/.test(p)) continue;
  const n = readFileSync(p, "utf8").split("\n").length;
  if (n > 700) fail.push(`${p} is ${n} lines, over the 700 ceiling`);
}
// AC-3.7: the fit-for-purpose review is a real step in the only release procedure that exists.
const rel = readFileSync("scripts/release.mjs", "utf8");
if (!/fit[- ]for[- ]purpose|surface.*deliver.*purpose/i.test(rel)) {
  fail.push("release.mjs has no fit-for-purpose review step");
}

// STATE.md puts unproven work in 6b, not 6.
const state = readFileSync("STATE.md", "utf8");
if (!/6b/.test(state)) fail.push("STATE.md has no 6b section for what has not yet run in front of anyone");
// Control: zz-platform keeps its prose. A rewrite that replaced the law with a table
// would pass a check that only looked for the table.
const plat = readFileSync("skills/zz-platform/SKILL.md", "utf8");
if (plat.split("\n").length < 200) fail.push("zz-platform lost its prose; the law is not a table");
if (!/\|/.test(plat.split("\n").slice(0, 120).join("\n"))) fail.push("zz-platform has no state table near the top");
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("docs current: ok");
