// The plant: name a dead tool in prose, prove red; use English, prove it stays green.
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const SK = "skills/zz-platform/SKILL.md";
const original = readFileSync(SK, "utf8");
const gate = () => { try { execFileSync("node", ["scripts/gate.mjs"], { stdio: "pipe" }); return 0; }
                     catch { return 1; } };
const fail = [];

if (gate() !== 0) { console.error("the gate is already red; the plant cannot measure anything"); process.exit(1); }

// 1. Prose naming a tool no door registers.
writeFileSync(SK, `${original}\n\nCall \`set_team_credential\` to store a key.\n`);
if (gate() === 0) fail.push("prose naming a dead tool did not turn the gate red");
writeFileSync(SK, original);

// 2. Prose naming a skill nobody ships.
writeFileSync(SK, `${original}\n\nLoad it with \`skill_read("zz-nonexistent")\`.\n`);
if (gate() === 0) fail.push("prose naming a dead skill did not turn the gate red");
writeFileSync(SK, original);

// 3. CONTROL — ordinary English must not fire, even using words that are also tool names.
writeFileSync(SK, `${original}\n\nA person may approve the document, or close the initiative.\n`);
if (gate() !== 0) fail.push("the check fires on ordinary English; it is too broad");
writeFileSync(SK, original);

// 4. The eight in-tree known-dead references are actually gone. CHANGELOG.md is excluded
//    below by the extension filter's tree roots — it records history, not the live surface.
const walk = (d) => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? (["node_modules", "dist"].includes(f) ? [] : walk(p)) : [p];
});
for (const dir of ["services", "scripts", "catalog", "skills", "packages"]) {
  if (!existsSync(dir)) continue;
  for (const p of walk(dir)) {
    if (!/\.(ts|mjs|js|md)$/.test(p)) continue;
    if (/set_team_credential|delete_team_credential/.test(readFileSync(p, "utf8"))) {
      fail.push(`${p} still names a tool registered nowhere`);
    }
  }
}
if (gate() !== 0) fail.push("the gate did not return green after restore");
if (fail.length) { console.error([...new Set(fail)].join("\n")); process.exit(1); }
console.log("prose-names plant: ok");
