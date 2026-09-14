// Seven rename, three do not, and the skills follow.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { EVAL_ALIAS } from "../packages/contracts/dist/index.js";
const fail = [];

const registered = new Set();
for (const f of ["plugin-eval", "plugin-judge", "plugin-record"]) {
  const src = readFileSync(`services/zz-core/src/tools/${f}.ts`, "utf8");
  for (const m of src.matchAll(/registerTool\(\s*\n?\s*"([a-z0-9_]+)"/g)) registered.add(m[1]);
}
for (const want of ["ruler_read", "ruler_record", "ruler_affirm", "round_judge",
                    "round_scores", "case_record", "finding_record"]) {
  if (!registered.has(want)) fail.push(`${want} is not registered`);
}
// Control: the three correct names must be UNCHANGED. A sweep that renamed everything fails here.
for (const keep of ["plugin_locate", "plugin_profile", "plugin_conform"]) {
  if (!registered.has(keep)) fail.push(`${keep} was renamed; it was already correct`);
}
for (const old of Object.keys(EVAL_ALIAS)) {
  if (registered.has(old)) fail.push(`${old} is still registered`);
}
if (registered.size !== 10) fail.push(`the eval door registers ${registered.size} tools, expected 10`);

// AC-2.13: every description on this door says when / returns / refuses.
for (const f of ["plugin-eval", "plugin-judge", "plugin-record"]) {
  const src = readFileSync(`services/zz-core/src/tools/${f}.ts`, "utf8");
  for (const m of src.matchAll(/registerTool\(\s*\n?\s*"([a-z0-9_]+)"[\s\S]{0,80}?description:\s*([\s\S]{0,1200}?)inputSchema/g)) {
    const [, tool, desc] = m;
    if (!/when\b/i.test(desc)) fail.push(`${tool}'s description does not say WHEN it is called`);
    if (!/return|comes back|answers/i.test(desc)) fail.push(`${tool}'s description does not say what it RETURNS`);
    if (!/refus|reject|never|cannot/i.test(desc)) fail.push(`${tool}'s description does not say what it REFUSES`);
  }
}

// The six skills name the new tools and none of the old ones.
const skillsDir = "catalog/zz/zz-plugin-eval/skills";
for (const s of readdirSync(skillsDir)) {
  const body = readFileSync(join(skillsDir, s, "SKILL.md"), "utf8");
  for (const old of Object.keys(EVAL_ALIAS)) {
    if (new RegExp(`(^|[^a-z_])${old}([^a-z_]|$)`).test(body)) fail.push(`${s} still names ${old}`);
  }
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("eval names: ok");
