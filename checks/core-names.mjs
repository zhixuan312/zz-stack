// Every core tool matches the convention, and no old name survives anywhere.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { TOOL_ALIAS } from "../packages/contracts/dist/index.js";
const fail = [];

const NOUNS = ["session", "skill", "initiative", "document", "source", "knowledge"];
const registered = new Set();
for (const f of readdirSync("services/zz-core/src/tools").filter((f) => f.endsWith(".ts"))) {
  const src = readFileSync(join("services/zz-core/src/tools", f), "utf8");
  for (const m of src.matchAll(/registerTool\(\s*\n?\s*"([a-z0-9_]+)"/g)) registered.add(m[1]);
}
for (const t of registered) {
  if (!NOUNS.some((n) => t.startsWith(`${n}_`))) fail.push(`${t} does not start with a core noun`);
}
// Control: the door must hold 19. A convention check that passed on an empty door is useless.
if (registered.size !== 19) fail.push(`core door registers ${registered.size} tools, expected 19`);

// Every description states when / returns / refuses (AC-2.13, FR-16).
for (const f of readdirSync("services/zz-core/src/tools").filter((f) => f.endsWith(".ts"))) {
  const src = readFileSync(join("services/zz-core/src/tools", f), "utf8");
  for (const m of src.matchAll(/registerTool\(\s*\n?\s*"([a-z0-9_]+)"[\s\S]{0,80}?description:\s*([\s\S]{0,1200}?)inputSchema/g)) {
    const [, tool, desc] = m;
    if (!/when\b/i.test(desc)) fail.push(`${tool}'s description does not say WHEN it is called`);
    if (!/return|comes back|answers/i.test(desc)) fail.push(`${tool}'s description does not say what it RETURNS`);
    if (!/refus|reject|never|cannot/i.test(desc)) fail.push(`${tool}'s description does not say what it REFUSES`);
  }
}

// No old name survives in code or prose. This is the half that fails silently.
const walk = (d) => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? (["node_modules", "dist", "_versions"].includes(f) ? [] : walk(p)) : [p];
});
const trees = ["services", "packages", "scripts", "checks", "catalog", "marketplace", "skills"];
for (const old of Object.keys(TOOL_ALIAS)) {
  const re = new RegExp(`(^|[^a-z0-9_])${old}([^a-z0-9_]|$)`);
  for (const dir of trees) {
    for (const p of walk(dir)) {
      if (!/\.(ts|mjs|js|json|md|ya?ml)$/.test(p)) continue;
      if (p.includes("/alias")) continue;             // the alias map is where old names belong
      if (re.test(readFileSync(p, "utf8"))) fail.push(`${p} still names ${old}`);
    }
  }
}
if (fail.length) { console.error([...new Set(fail)].join("\n")); process.exit(1); }
console.log("core names: ok");
