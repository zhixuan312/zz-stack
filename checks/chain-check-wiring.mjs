// chain-check covers every registered core tool, is invoked by release, and is NOT in the gate.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const fail = [];

// 1. Every tool the core door registers is exercised.
const toolsDir = "services/zz-core/src/tools";
const registered = new Set();
for (const f of readdirSync(toolsDir).filter((f) => f.endsWith(".ts"))) {
  const src = readFileSync(join(toolsDir, f), "utf8");
  for (const m of src.matchAll(/registerTool\(\s*\n?\s*"([a-z0-9_]+)"/g)) registered.add(m[1]);
}
const chain = readFileSync("packages/tools/src/testing/chain-check.ts", "utf8");
const missing = [...registered].filter((t) => !chain.includes(`"${t}"`));
if (missing.length) fail.push(`chain-check does not exercise: ${missing.join(", ")}`);
if (registered.size === 0) fail.push("no registrations found — the derivation itself is broken");

// 2. release.mjs invokes it.
const rel = readFileSync("scripts/release.mjs", "utf8");
if (!/chain-check/.test(rel)) fail.push("release.mjs does not invoke chain-check");

// 3. Control: the OFFLINE gate must NOT invoke it. This check fails in both directions.
const gate = readFileSync("scripts/gate.mjs", "utf8");
const gateChecks = readdirSync("scripts/gate/checks")
  .map((f) => readFileSync(join("scripts/gate/checks", f), "utf8")).join("\n");
// WHAT THIS FORBIDS IS EXECUTION, not mention. Two earlier spellings of this control were
// both wrong in the same direction — too coarse — and each was found only by being wired:
//   `run.*chain-check`      matched `runsCheck("chain-check-wiring.mjs")`, the registration of
//                           THIS check, so the check accused the gate of running the very tool
//                           it exists to keep out.
//   `chain-check(?![-\w])`  matched `build.mjs` READING `chain-check.ts` to lint its source —
//                           a static analysis, which is exactly what the gate should be doing.
// So: the runnable artifact by name, or a chain-check argument inside a process-spawning call.
// Prose about chain-check is free, and five gate checks legitimately carry it.
const RUNNABLE = /chain-check\.(?:js|mjs)\b/;
const SPAWNED = /(?:execFileSync|execSync|spawnSync|exec|spawn)\s*\([^)]*chain-check/;
if (RUNNABLE.test(gate + gateChecks) || SPAWNED.test(gate + gateChecks)) {
  fail.push("the offline gate invokes chain-check, which needs a deployment and a token");
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("chain-check wiring: ok");
