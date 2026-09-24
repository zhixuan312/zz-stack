// A lock is correct only if regenerating it changes nothing. Anything else means the committed
// lock describes a tree that no longer exists.
//
// DELIBERATE: both locks are put back as they were found, pass or fail. Regenerating them in
// place and leaving the result would make the next gate run pass against a lock the gate wrote,
// and content would move under a frozen version with nothing to notice.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const fail: string[] = [];
const before = readFileSync("plugins.lock.json", "utf8");
const skillsBefore = readFileSync("skills.lock.json", "utf8");
try {
  // DELIBERATE: skills first. plugin-versions copies each plugin's `skills` submap out of
  // skills.lock.json as it finds it on disk, so running it first leaves that submap one
  // generation behind and the pair never reaches a fixed point in a single pass.
  execFileSync("node", ["scripts/skill-versions.ts", "--write"], { stdio: "pipe" });
  execFileSync("node", ["scripts/plugin-versions.ts", "--write"], { stdio: "pipe" });
  if (readFileSync("plugins.lock.json", "utf8") !== before) {
    fail.push("plugins.lock.json changed when regenerated — the committed lock is stale");
  }
  // DELIBERATE: idempotent, not committed. `git status` answers whether the tree matches HEAD,
  // which is false for any uncommitted change, so it calls a correct lock dirty during the very
  // work that produces it. The byte comparison establishes it instead.
  if (readFileSync("skills.lock.json", "utf8") !== skillsBefore) {
    fail.push("skills.lock.json changed when regenerated — the committed lock is stale");
  }
  // No lock entry may still name a .mjs path.
  if (/\.mjs/.test(readFileSync("plugins.lock.json", "utf8"))) {
    fail.push("plugins.lock.json still references a .mjs path");
  }
} finally {
  writeFileSync("plugins.lock.json", before);
  writeFileSync("skills.lock.json", skillsBefore);
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
