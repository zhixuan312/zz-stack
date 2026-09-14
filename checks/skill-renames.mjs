// Two skills renamed, every caller moved, and history still resolves.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SKILL_ALIAS } from "../packages/contracts/dist/index.js";
const fail = [];

for (const [oldName, newName] of Object.entries(SKILL_ALIAS)) {
  if (!existsSync(`catalog/zz/zz-core/skills/${newName}/SKILL.md`)) fail.push(`${newName} does not exist`);
  if (existsSync(`catalog/zz/zz-core/skills/${oldName}`)) fail.push(`${oldName} still exists`);
  const fm = readFileSync(`catalog/zz/zz-core/skills/${newName}/SKILL.md`, "utf8");
  if (!new RegExp(`^name:\\s*${newName}`, "m").test(fm)) fail.push(`${newName}'s frontmatter name is wrong`);
}
// No caller left behind, anywhere except the alias map itself.
const walk = (d) => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? (["node_modules", "dist", "_versions"].includes(f) ? [] : walk(p)) : [p];
});
for (const dir of ["services", "packages", "scripts", "catalog", "marketplace", "skills"]) {
  if (!existsSync(dir)) continue;
  for (const p of walk(dir)) {
    if (!/\.(ts|mjs|js|json|md)$/.test(p) || p.includes("/alias")) continue;
    const body = readFileSync(p, "utf8");
    for (const oldName of Object.keys(SKILL_ALIAS)) {
      if (new RegExp(`(^|[^a-z-])${oldName}([^a-z-]|$)`).test(body)) fail.push(`${p} still names ${oldName}`);
    }
  }
}
// Control: the step resolver folds the old name onto the new one, so old rows still count.
const { resolveStep } = await import("../packages/tools/dist/testing/tool-report.js");
if (resolveStep("zz-backbone") !== "zz-platform") fail.push("an old step name no longer resolves");
if (resolveStep("sdlc-spec") !== "sdlc-spec") fail.push("an unrenamed step was altered by the alias");
if (fail.length) { console.error([...new Set(fail)].join("\n")); process.exit(1); }
console.log("skill renames: ok");
