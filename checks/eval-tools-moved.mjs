// Ten tools and three modules move; attest stays; nothing is served twice.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const fail = [];
const core = readFileSync("services/zz-core/src/server.ts", "utf8");

const EVAL_MODULES = ["plugin-eval", "plugin-judge", "plugin-record"];
const coreFactory = core.split("buildCoreServer")[1]?.split("buildEvalServer")[0] ?? core;
for (const m of EVAL_MODULES) {
  if (coreFactory.includes(m)) fail.push(`the core factory still registers ${m}`);
}
const evalFactory = core.split("buildEvalServer")[1] ?? "";
for (const m of EVAL_MODULES) {
  if (!evalFactory.includes(m)) fail.push(`the eval factory does not register ${m}`);
}

// The three support modules are imported only from the eval side.
const src = "services/zz-core/src";
for (const support of ["judge", "plugin-cases", "plugin-profile"]) {
  for (const f of readdirSync(join(src, "tools"))) {
    const body = readFileSync(join(src, "tools", f), "utf8");
    const importsIt = new RegExp(`from\\s+["'\`]\\.\\./${support}\\.js`).test(body);
    const isEvalModule = EVAL_MODULES.some((m) => f.startsWith(m));
    if (importsIt && !isEvalModule) fail.push(`${f} imports ${support} but is not an eval module`);
  }
}
// Control: attest MUST still be imported by initiative-acts, or it was moved by mistake.
const acts = readFileSync(join(src, "tools/initiative-acts.ts"), "utf8");
if (!/attest\.js/.test(acts)) fail.push("initiative-acts no longer imports attest — the attestation broke");

// No tool on both doors.
const names = (s) => new Set([...s.matchAll(/registerTool\(\s*\n?\s*"([a-z0-9_]+)"/g)].map((m) => m[1]));
const dup = [...names(coreFactory)].filter((t) => names(evalFactory).has(t));
if (dup.length) fail.push(`registered on both doors: ${dup.join(", ")}`);

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("eval tools moved: ok");
