// A lock is correct only if regenerating it changes nothing. Anything else means the committed
// lock describes a tree that no longer exists.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const fail: string[] = [];
const before = readFileSync("plugins.lock.json", "utf8");
// SKILLS FIRST. plugin-versions copies each plugin's `skills` submap out of skills.lock.json as
// it finds it on disk, so running it first leaves that submap one generation behind and the
// pair never reaches a fixed point in a single pass.
execFileSync("node", ["scripts/skill-versions.ts", "--write"], { stdio: "pipe" });
execFileSync("node", ["scripts/plugin-versions.ts", "--write"], { stdio: "pipe" });
if (readFileSync("plugins.lock.json", "utf8") !== before) {
  fail.push("plugins.lock.json changed when regenerated — the committed lock is stale");
}
// IDEMPOTENT, NOT COMMITTED. `git status` answers whether the tree matches HEAD, which is a
// different question and is false for any uncommitted change — so it reports a correct lock as
// dirty during the very work that produces it. What matters is that regenerating changes
// nothing, which the byte comparison above already establishes for plugins.lock.json; this does
// the same for skills.lock.json.
const skillsBefore = readFileSync("skills.lock.json", "utf8");
execFileSync("node", ["scripts/skill-versions.ts", "--write"], { stdio: "pipe" });
if (readFileSync("skills.lock.json", "utf8") !== skillsBefore) {
  fail.push("skills.lock.json changed when regenerated — the committed lock is stale");
}
// No lock entry may still name a .mjs path.
const lock = readFileSync("plugins.lock.json", "utf8");
if (/\.mjs/.test(lock)) fail.push("plugins.lock.json still references a .mjs path");
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
