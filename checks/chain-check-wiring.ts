// chain-check covers every registered core tool, is invoked by release, and is not in the gate.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const fail = [];

// 1. Every tool each door registers is exercised through that door's client. A tool is
// covered when it is called through the client for the door that serves it, so moving a tool
// between doors without moving its call is a failure rather than a silence.
//
// DELIBERATE: the door is derived from which factory registers a tool, never from which
// directory the module sits in. `eval-door.ts` is the function the service mounts on the
// evaluation path, the modules it imports are that door's by construction, and every other
// tool zz-core registers is on the core door wherever its file sits. A directory-keyed
// version goes quiet the next time a module moves.
const SRC = "services/zz-core/src";
const EVAL_DOOR = `${SRC}/eval-door.ts`;
/** chain-check and what it walks through. The probe is one walk written across more than one
 * file, and this rule is about whether a live door gets called, not which file the call is
 * written in.
 *
 * DELIBERATE: followed by import rather than by reading the directory. A file beside
 * chain-check that nothing imports is not part of the walk, and counting it would let a tool
 * look exercised by a module that never runs. */
const CHAIN_DIR = "packages/tools/src/testing";
const chain = (() => {
  const entry = join(CHAIN_DIR, "chain-check.ts");
  let text = readFileSync(entry, "utf8");
  for (const m of text.matchAll(/^import\s[^"']*["']\.\/([\w.-]+)\.js["']/gm)) {
    const part = join(CHAIN_DIR, `${m[1]}.ts`);
    if (existsSync(part)) text += `\n${readFileSync(part, "utf8")}`;
  }
  return text;
})();

/** Every .ts under zz-core, so a registration in a module no door imports directly still
 *  counts — `initiative_open` is registered from `tools/initiative-open.ts`, which server.ts
 *  does not import. */
const walk = (d: string, out: string[] = []) => {
  for (const e of readdirSync(d)) {
    const full = join(d, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (e.endsWith(".ts")) out.push(full);
  }
  return out;
};
const toolsIn = (src: string) => [...src.matchAll(/registerTool\(\s*\n?\s*"([a-z0-9_]+)"/g)].map((m) => m[1]);

const evalTools = new Set();
if (!existsSync(EVAL_DOOR)) {
  fail.push(`${EVAL_DOOR} is gone — the evaluation door's surface cannot be derived, so every ` +
            "tool on it would be required on the core door's client instead");
} else {
  for (const m of readFileSync(EVAL_DOOR, "utf8")
         .matchAll(/import \{ register\w+ \} from "(\.\/[\w/-]+)\.js"/g)) {
    const mod = `${SRC}/${m[1].replace(/^\.\//, "")}.ts`;
    if (!existsSync(mod)) { fail.push(`${EVAL_DOOR} imports ${mod}, which is not there`); continue; }
    for (const t of toolsIn(readFileSync(mod, "utf8"))) evalTools.add(t);
  }
}
const allTools = new Set();
for (const f of walk(SRC)) for (const t of toolsIn(readFileSync(f, "utf8"))) allTools.add(t);
const coreTools = [...allTools].filter((t) => !evalTools.has(t));

/** Which helper in chain-check reaches which door — read out of chain-check itself, so a third
 *  client added there is picked up rather than needing this file edited to notice it. */
const clients = new Map();
for (const m of chain.matchAll(/const (\w+)\s*=\s*new Mcp\(`\$\{GW\}(\/[^`]*)`/g)) clients.set(m[1], m[2]);
const helperFor = new Map();
for (const m of chain.matchAll(/const (\w+)\s*=\s*\(tool: string[\s\S]{0,80}?=>\s*(\w+)\.call\(/g)) {
  const door = clients.get(m[2]);
  if (door && !helperFor.has(door)) helperFor.set(door, m[1]);
}

for (const [door, tools] of [["/core/mcp", coreTools], ["/eval/mcp", [...evalTools]]]) {
  // The control on each half: an empty set satisfies every assertion below, which is what a
  // broken derivation produces.
  if (!tools.length) {
    fail.push(`not one tool was attributed to ${door} — the derivation is broken, and every ` +
              "clause about what chain-check must exercise there passed on an empty set");
    continue;
  }
  const helper = helperFor.get(door);
  if (!helper) {
    fail.push(`chain-check opens no client on ${door}, so the ${tools.length} tools that door ` +
              "serves cannot be reached from it at all — every call would ask the wrong door");
    continue;
  }
  for (const t of tools) {
    if (!new RegExp(`\\b${helper}\\("${t}"`).test(chain)) {
      fail.push(`chain-check does not exercise ${t} through ${helper}() — ${door} serves it, ` +
                "so calling it any other way asks a door that does not have it");
    }
  }
}

// 2. release.ts invokes it.
const rel = readFileSync("scripts/release.ts", "utf8");
if (!/chain-check/.test(rel)) fail.push("release.ts does not invoke chain-check");

// 3. Control: the offline gate must not invoke it. This check fails in both directions.
const gate = readFileSync("scripts/gate.ts", "utf8");
const gateChecks = readdirSync("scripts/gate/checks")
  .map((f) => readFileSync(join("scripts/gate/checks", f), "utf8")).join("\n");
// DELIBERATE: what this forbids is execution, not mention. It matches the runnable artifact
// by name, or a chain-check argument inside a process-spawning call. Prose about chain-check
// is free, and several gate checks legitimately carry it — as does `build.ts`, which reads
// `chain-check.ts` to lint its source.
const RUNNABLE = /chain-check\.(?:js|mjs)\b/;
const SPAWNED = /(?:execFileSync|execSync|spawnSync|exec|spawn)\s*\([^)]*chain-check/;
if (RUNNABLE.test(gate + gateChecks) || SPAWNED.test(gate + gateChecks)) {
  fail.push("the offline gate invokes chain-check, which needs a deployment and a token");
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("chain-check wiring: ok");
