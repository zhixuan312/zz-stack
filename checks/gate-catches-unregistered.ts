// Tested by mutation: a green gate is what success looks like and what a blinded discovery
// scan looks like, so only the plant tells them apart.
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
const PLANT = "checks/zz-audit-plant.ts";
const fail: string[] = [];
const runGate = () => spawnSync("node", ["scripts/gate.ts"], { encoding: "utf8", timeout: 900_000 });
try {
  // (a) planted: a working, unregistered check must turn the gate red and be named.
  writeFileSync(PLANT, "process.exit(0);\n");
  const planted = runGate();
  const said = `${planted.stdout ?? ""}${planted.stderr ?? ""}`;
  if (planted.status === 0) {
    fail.push("the gate stayed GREEN with an unregistered .ts check planted — the discovery scan " +
              "does not see .ts, so it is enforcing nothing");
  } else if (!said.includes("zz-audit-plant")) {
    fail.push("the gate went red but never named the plant — it failed for some other reason");
  }
} finally {
  rmSync(PLANT, { force: true });
}
if (existsSync(PLANT)) fail.push(`${PLANT} was not removed`);
// (b) unplanted: the gate must be green, proving the registration regexes still recognise
// every correctly-registered check rather than reporting them all as unregistered.
const clean = runGate();
if (clean.status !== 0) {
  const said = `${clean.stdout ?? ""}${clean.stderr ?? ""}`;
  fail.push(`the gate is red with no plant present:\n${said.split("\n").slice(-25).join("\n")}`);
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
