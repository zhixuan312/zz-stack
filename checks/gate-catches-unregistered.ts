// Tested by mutation: a green gate is what success looks like and what a blinded discovery
// scan looks like, so only the plant tells them apart.
import { writeFileSync, rmSync, existsSync } from "node:fs";

import { gate, restoreOnInterrupt } from "../testing/gate-plant.ts";

const PLANT = "checks/zz-audit-plant.ts";
const fail: string[] = [];
const runGate = () => gate([], 900_000);
// The plant is removed however this ends: on exit, after a throw, and on an interrupt, which stops
// the gate in flight first.
restoreOnInterrupt(() => rmSync(PLANT, { force: true }));
try {
  // (a) planted: a working, unregistered check must turn the gate red and be named.
  writeFileSync(PLANT, "process.exit(0);\n");
  const planted = await runGate();
  const said = planted.out;
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
const clean = await runGate();
if (clean.status !== 0) {
  const said = clean.out;
  fail.push(`the gate is red with no plant present:\n${said.split("\n").slice(-25).join("\n")}`);
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
