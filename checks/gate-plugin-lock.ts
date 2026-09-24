// Break-test for the two plugin-lock gate checks.
//
// Plants each defect the checks exist to catch, asserts red, restores, asserts green. A check
// that has only ever been observed passing is a check nobody has evidence for.
import { readFileSync, writeFileSync, existsSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

interface LockEntry { version: string; digest: string; skills: Record<string, string> }
type Lock = Record<string, LockEntry>;

const gate = () => spawnSync("node", ["scripts/gate.ts", "--quiet"], { encoding: "utf8" });
function fail(m: string): never { console.error("FAIL: " + m); process.exit(1); }
const LOCK = "plugins.lock.json";
if (!existsSync(LOCK)) fail(`${LOCK} does not exist — run plugin-versions.ts --write first`);

const VICTIM = "catalog/sdlc/sdlc-flow/skills/sdlc-method/SKILL.md";
if (!existsSync(VICTIM)) fail(`${VICTIM} is gone — repoint this break-test`);
if (gate().status !== 0) fail("the gate is already red before planting anything");

// Every `gate()` below regenerates `marketplace/` out of `catalog/`, and the planted cases write
// the lock files directly, so a run against a planted defect leaves those three carrying it.
// Restoring only the catalog file leaves the gate red on a stale lock or shelf that this file
// planted, not one the tree has.
//
// DELIBERATE: snapshotted rather than restored with `git checkout`. These paths are regenerated
// constantly and somebody may have uncommitted work in them.
const DERIVED = ["marketplace", "plugins.lock.json", "skills.lock.json"];
const snapshot = mkdtempSync(join(tmpdir(), "zz-plugin-lock-derived-"));
for (const path of DERIVED) cpSync(path, join(snapshot, path), { recursive: true });
const restoreDerived = (): void => {
  for (const path of DERIVED) cpSync(join(snapshot, path), path, { recursive: true });
};

// 1 — content moves, the declared version does not.
const body = readFileSync(VICTIM, "utf8");
writeFileSync(VICTIM, body + "\n<!-- planted by checks/gate-plugin-lock.ts -->\n");
const redContent = gate().status !== 0;
writeFileSync(VICTIM, body);
if (!redContent) {
  fail("the gate stayed GREEN when a plugin's content changed under a frozen version — the " +
       "digest check does not work, and a plugin version vouches for nothing");
}

// 2 — the lock claims a member the plugin does not ship.
const lock = readFileSync(LOCK, "utf8");
const parsed: Lock = JSON.parse(lock);
const victimPlugin = Object.keys(parsed).find((k) => Object.keys(parsed[k].skills ?? {}).length);
if (!victimPlugin) fail("no plugin in the lock records any skills — nothing to perturb");
parsed[victimPlugin].skills["a-skill-that-does-not-exist"] = "000000000000";
writeFileSync(LOCK, JSON.stringify(parsed, null, 2) + "\n");
const redExtra = gate().status !== 0;
writeFileSync(LOCK, lock);
if (!redExtra) fail("the gate stayed GREEN when the lock claimed a skill the plugin does not ship");

// 3 — the lock omits a member the plugin does ship.
const parsed2: Lock = JSON.parse(lock);
const dropped = Object.keys(parsed2[victimPlugin].skills)[0];
delete parsed2[victimPlugin].skills[dropped];
writeFileSync(LOCK, JSON.stringify(parsed2, null, 2) + "\n");
const redMissing = gate().status !== 0;
writeFileSync(LOCK, lock);
if (!redMissing) {
  fail(`the gate stayed GREEN when the lock omitted ${dropped}, which ${victimPlugin} ships — ` +
       "a membership that is silently short is one the profile resolves events through anyway");
}

// 4 — a plugin the lock records and the enumeration no longer finds.
//
// A wrong directory override would hash a plugin over an empty file list, and computed and
// recorded would then agree forever. Two things stop that: plugin-lock omits a plugin whose
// tree it cannot read rather than hashing nothing, and an absence is what this branch catches.
const parsed3: Lock = JSON.parse(lock);
parsed3["a-plugin-the-catalog-does-not-ship"] = { version: "9.9.9", digest: "deadbeef", skills: {} };
writeFileSync(LOCK, JSON.stringify(parsed3, null, 2) + "\n");
const redGhost = gate().status !== 0;
writeFileSync(LOCK, lock);
if (!redGhost) {
  fail("the gate stayed GREEN with a plugin in the lock that the catalog does not ship — so a " +
       "plugin that vanished from the enumeration would pass unnoticed, which is the whole " +
       "failure mode the omit-rather-than-hash-empty rule exists to make loud");
}

// 5 — the lock is a whole release behind the catalog.
//
// A check written `was.digest !== p.digest && was.version === p.version` fires only when
// content moves and the version does not, so a lock a whole release out of date passes.
//
// COUPLED: release.ts registers zz.plugin_version from plugins.lock.json and never regenerates
// it, and the live probes ask whether the deployment matches the checkout, so a stale lock
// agrees with itself all the way to the database.
const parsed4: Lock = JSON.parse(lock);
const victim4 = Object.keys(parsed4)[0];
const realVersion = parsed4[victim4].version;
parsed4[victim4].version = "0.0.1-stale";
writeFileSync(LOCK, JSON.stringify(parsed4, null, 2) + "\n");
const redStale = gate().status !== 0;
writeFileSync(LOCK, lock);
if (!redStale) {
  fail(`the gate stayed GREEN with ${victim4} locked at 0.0.1-stale while the catalog declares ` +
       `${realVersion} — so a release would register the PREVIOUS release's plugin versions, ` +
       "and nothing anywhere would say so");
}

restoreDerived();
rmSync(snapshot, { recursive: true, force: true });
if (gate().status !== 0) fail("the gate did not return to GREEN after restoring everything");
console.log("PASS: red on a frozen-version content change, red on an extra member, red on a " +
            "missing member, red on a plugin the catalog does not ship, red on a lock a " +
            "release behind the catalog, green otherwise.");
