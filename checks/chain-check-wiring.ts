// chain-check covers every registered core tool, is invoked by release, and is NOT in the gate.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const fail = [];

// 1. Every tool each door registers is exercised THROUGH THAT DOOR'S CLIENT.
//
// This used to scan one directory and ask only "is this name mentioned". When Task I-19 moved
// the ten plugin_* tools to /eval/mcp and Task I-20 moved their modules out of tools/, the
// check went QUIETER RATHER THAN REDDER: the names left the directory it scanned, so it
// stopped requiring them at all, while chain-check went on calling them on the core door — ten
// "tool not found"s waiting at release, which is the only place this runs.
//
// A check that relaxes as the thing it guards changes is worse than one that is merely narrow,
// because its silence reads as coverage. So the door is part of the assertion now: a tool is
// covered when it is called through the client for the door that serves it, and moving a tool
// between doors without moving its call is a failure rather than a silence.
//
// AND THE DOOR IS DERIVED, NOT THE DIRECTORY. The first fix for the above — a working-tree
// edit during Task I-20, never committed in that form — keyed the two doors to `src/tools` and
// `src/eval`, which is the SAME root cause one layer along: a check that
// scans a DIRECTORY when the question is about a DOOR. It would have gone quiet again the next
// time a module moved. What actually decides which door serves a tool is which factory
// registers it, so that is what this reads — `eval-door.ts` is the function the service mounts
// on the evaluation path, the modules it imports are that door's by construction, and every
// other tool zz-core registers is on the core door wherever its file happens to sit.
const SRC = "services/zz-core/src";
const EVAL_DOOR = `${SRC}/eval-door.ts`;
/** chain-check AND WHAT IT WALKS THROUGH.
 *
 * The probe is one walk written across more than one file: the bug tracker moved into
 * `chain-bugs.ts` because it is a different subject from the document chain, and reading only
 * the entry point would have reported three tools as unexercised the moment they moved. What
 * this rule is about is whether a live door gets called, not which file the call is written in.
 *
 * Followed by IMPORT rather than by reading the directory: a file sitting beside chain-check
 * that nothing imports is not part of the walk, and counting it would let a tool look exercised
 * by a module that never runs. */
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
 *  does not import, and a scan of the door files alone would not have seen it. */
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
  // THE CONTROL ON EACH HALF. An empty set is a door whose every assertion below is satisfied
  // by a chain-check that calls nothing at all, which is what a broken derivation produces.
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

// 2. release.mjs invokes it.
const rel = readFileSync("scripts/release.ts", "utf8");
if (!/chain-check/.test(rel)) fail.push("release.mjs does not invoke chain-check");

// 3. Control: the OFFLINE gate must NOT invoke it. This check fails in both directions.
const gate = readFileSync("scripts/gate.ts", "utf8");
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
