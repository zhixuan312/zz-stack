// Three tools leave the core door, and skill_list absorbs what block_skills did.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const fail = [];

const core = new Set();
for (const f of readdirSync("services/zz-core/src/tools").filter((f) => f.endsWith(".ts"))) {
  const src = readFileSync(join("services/zz-core/src/tools", f), "utf8");
  for (const m of src.matchAll(/registerTool\(\s*\n?\s*"([a-z0-9_]+)"/g)) core.add(m[1]);
}
for (const gone of ["encode_base64", "block_skills", "reindex_knowledge", "knowledge_reindex"]) {
  if (core.has(gone)) fail.push(`${gone} is still registered on the core door`);
}
if (core.size !== 19) fail.push(`core door registers ${core.size} tools, expected 19`);

// skill_list absorbed block_skills: it takes an owner and groups by it.
const skills = readFileSync("services/zz-core/src/tools/skills.ts", "utf8");
const block = skills.split('"skill_list"')[1]?.slice(0, 4000) ?? "";
if (!/owner/.test(block)) fail.push("skill_list does not accept an owner");
if (/JSON\.stringify\(\[\.\.\.names\]\.sort\(\)\)/.test(skills)) {
  fail.push("skill_list still returns a flat array of names");
}
// knowledge_reindex lives on /manage, superadmin-gated.
const admin = readFileSync("services/gateway/src/admin.ts", "utf8");
if (!/knowledge_reindex/.test(admin)) fail.push("knowledge_reindex is not on the /manage door");
const kr = admin.split('"knowledge_reindex"')[0].slice(-200);
if (!/if\s*\(\s*sup\s*\)/.test(kr)) fail.push("knowledge_reindex is not superadmin-gated");
// Control: encode_base64 must be gone from PROSE too, or a skill still tells a model to call it.
if (/encode_base64/.test(readFileSync("skills/zz-platform/SKILL.md", "utf8"))) {
  fail.push("zz-platform still names encode_base64");
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("core surface: ok");
