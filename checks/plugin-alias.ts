// A renamed plugin still resolves, and the updater's copy of the map matches the contract's.
//
// COUPLED: `zz-update` carries the rename map inline because it runs on somebody else's
// machine, from inside a plugin directory with no workspace around it, and cannot import
// @zz/contracts. This holds that copy to `PLUGIN_ALIAS` in packages/contracts.
import { readFileSync } from "node:fs";

import { PLUGIN_ALIAS } from "../packages/contracts/dist/index.js";

const fail = [];
const SCRIPT = "catalog/zz/zz-access/skills/zz-update/update.ts";
const src = readFileSync(SCRIPT, "utf8");

// DELIBERATE: the type annotation is optional in the pattern. The source this reads is
// TypeScript, so `const PLUGIN_ALIAS: Record<string, string> = {` is the same declaration.
const m = /const PLUGIN_ALIAS(?:\s*:[^=]+)?\s*=\s*\{([^}]*)\}/.exec(src);
if (!m) {
  fail.push(`${SCRIPT} no longer declares PLUGIN_ALIAS where this can read it — the updater ` +
            "either stopped handling renames, or handles them somewhere nothing checks");
} else {
  const theirs = Object.fromEntries(
    [...m[1].matchAll(/([A-Za-z0-9_-]+)\s*:\s*"([^"]+)"/g)].map((e) => [e[1], e[2]]));
  for (const [from, to] of Object.entries(PLUGIN_ALIAS)) {
    if (theirs[from] !== to) {
      fail.push(`@zz/contracts renames ${from} to ${to}; ${SCRIPT} says ` +
                `${theirs[from] ? `${from} -> ${theirs[from]}` : `nothing about ${from}`} — ` +
                "somebody a release behind runs the updater and is not told what replaced it");
    }
  }
  for (const from of Object.keys(theirs)) {
    if (!PLUGIN_ALIAS[from]) {
      fail.push(`${SCRIPT} renames ${from}, which @zz/contracts does not — the updater would ` +
                "move somebody onto a plugin this platform does not claim to have renamed");
    }
  }
}

// The rename must point at a plugin the shelf actually carries, or the updater installs a name
// that does not resolve.
const shelf = JSON.parse(readFileSync(".claude-plugin/marketplace.json", "utf8"));
const ships = new Set((shelf.plugins ?? []).map((p: { name: string }) => p.name));
if (!ships.size) fail.push("the rendered marketplace lists no plugin — this check is reading nothing");
for (const [from, to] of Object.entries(PLUGIN_ALIAS)) {
  if (!ships.has(to)) fail.push(`PLUGIN_ALIAS renames ${from} to ${to}, which this shelf does not ship`);
  if (ships.has(from)) fail.push(`PLUGIN_ALIAS renames ${from} away, but the shelf still ships it`);
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log(`plugin alias: ok — ${Object.keys(PLUGIN_ALIAS).length} rename(s), each pointing at a plugin the shelf ships`);
