// A BREAK TEST. checks/node-floor.ts passing on this machine proves nothing — this machine
// satisfies the floor. What has to be proven is that it FAILS, and fails informatively, when
// the floor is not met. So the floor is temporarily raised past any plausible runtime and the
// check is required to go red naming both versions.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const PKG = "package.json";
const original = readFileSync(PKG, "utf8");
const fail = [];
try {
  const pkg = JSON.parse(original);
  pkg.engines = { node: ">=999.0.0" };
  writeFileSync(PKG, JSON.stringify(pkg, null, 2) + "\n");
  const r = spawnSync("node", ["checks/node-floor.ts"], { encoding: "utf8" });
  if (r.status === 0) {
    fail.push("node-floor passed against a floor of >=999.0.0 — it is not reading the floor");
  }
  const said = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (!said.includes("999")) fail.push("node-floor failed but never named the REQUIRED version");
  if (!said.includes(process.version.replace(/^v/, "").split(".")[0])) {
    fail.push("node-floor failed but never named the RUNNING version");
  }
} finally {
  writeFileSync(PKG, original);
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
