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

if (gate().status !== 0) fail("the gate did not return to GREEN after restoring everything");
console.log("PASS: red on a frozen-version content change, red on an extra member, red on a " +
            "missing member, green otherwise.");
