// Break-test for the two plugin-lock gate checks.
//
// Plants each defect the checks exist to catch, asserts RED, restores, asserts GREEN. A check
// that has only ever been observed passing is a check nobody has evidence for -- and this
// repository has shipped that mistake before, which is why every new check here gets one.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const gate = () => spawnSync("node", ["scripts/gate.mjs", "--quiet"], { encoding: "utf8" });
const fail = (m) => { console.error("FAIL: " + m); process.exit(1); };
const LOCK = "plugins.lock.json";
if (!existsSync(LOCK)) fail(`${LOCK} does not exist — run plugin-versions.mjs --write first`);

const VICTIM = "catalog/sdlc/sdlc-flow/skills/sdlc-method/SKILL.md";
if (!existsSync(VICTIM)) fail(`${VICTIM} is gone — repoint this break-test`);
if (gate().status !== 0) fail("the gate is already red before planting anything");

// 1 — content moves, the declared version does not.
const body = readFileSync(VICTIM, "utf8");
writeFileSync(VICTIM, body + "\n<!-- planted by checks/gate-plugin-lock.mjs -->\n");
const redContent = gate().status !== 0;
writeFileSync(VICTIM, body);
if (!redContent) {
  fail("the gate stayed GREEN when a plugin's content changed under a frozen version — the " +
       "digest check does not work, and a plugin version vouches for nothing");
}

// 2 — the lock claims a member the plugin does not ship.
const lock = readFileSync(LOCK, "utf8");
const parsed = JSON.parse(lock);
const victimPlugin = Object.keys(parsed).find((k) => Object.keys(parsed[k].skills ?? {}).length);
if (!victimPlugin) fail("no plugin in the lock records any skills — nothing to perturb");
parsed[victimPlugin].skills["a-skill-that-does-not-exist"] = "000000000000";
writeFileSync(LOCK, JSON.stringify(parsed, null, 2) + "\n");
const redExtra = gate().status !== 0;
writeFileSync(LOCK, lock);
if (!redExtra) fail("the gate stayed GREEN when the lock claimed a skill the plugin does not ship");

// 3 — the lock omits a member the plugin does ship.
const parsed2 = JSON.parse(lock);
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
// This is the failure an audit predicted would be SILENT: if a directory override were wrong,
// zz would be hashed over an empty file list, computed and recorded would agree forever, and no
// zz content change would ever move the digest. It is not silent, for two independent reasons,
// and this asserts the second. First, plugin-lock omits a plugin whose tree it cannot read
// rather than hashing nothing -- verified directly: with ZZ_SKILLS_DIR pointing nowhere the
// enumeration returns five plugins and zz is absent, not present-and-empty. Second, an absence
// is exactly what this branch catches.
const parsed3 = JSON.parse(lock);
parsed3["a-plugin-the-catalog-does-not-ship"] = { version: "9.9.9", digest: "deadbeef", cases_digest: "", skills: {} };
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
// THIS ONE SHIPPED. The check read `was.digest !== p.digest && was.version === p.version`, so
// it could only fire when content moved and the version did NOT -- the moment a version moved,
// the conjunction collapsed and a lock a release out of date passed silently. 0.33.0 went out
// that way: plugins.lock.json still said sdlc 0.1.0 while the catalog declared 0.2.0, and
// because release.mjs registers zz.plugin_version FROM that file and never regenerates it, the
// database ended up describing 0.32.3. Every one of the release's 17 live probes was green,
// because each asks whether the deployment matches the CHECKOUT and the stale lock was part of
// the checkout. It agreed with itself.
const parsed4 = JSON.parse(lock);
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

if (gate().status !== 0) fail("the gate did not return to GREEN after restoring everything");
console.log("PASS: red on a frozen-version content change, red on an extra member, red on a " +
            "missing member, red on a plugin the catalog does not ship, red on a lock a " +
            "release behind the catalog, green otherwise.");
