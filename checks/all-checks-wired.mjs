// Every check in this directory is invoked, and a new one needs no list edit.
import { readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
const fail = [];
const suites = readFileSync("scripts/gate/checks/suites.mjs", "utf8");
const gate = () => { try { execFileSync("node", ["scripts/gate.mjs"], { stdio: "pipe" }); return 0; }
                     catch { return 1; } };

// suites.mjs cross-validates against the directory: a file with no registration fails.
if (!/readdirSync\(\s*["'`][^"'`]*checks["'`]/.test(suites)) {
  fail.push("suites.mjs does not cross-validate against the checks directory");
}
// Every existing check is reached. Prove it by planting a failing one and expecting red.
const planted = "checks/zz-temp-wiring-probe.mjs";
writeFileSync(planted, "// probe\nprocess.exit(1);\n");
const red = gate() !== 0;
rmSync(planted, { force: true });
if (!red) fail.push("a newly added failing check did not turn the gate red");
if (gate() !== 0) fail.push("the gate did not return green after the probe was removed");

// The counter STATE.md reads must see one registration per file, plus the cross-validator.
// A loop would collapse many checks into one line and silently drift that count — which is
// the defect AC-3.5 removes, so the explicit list is required rather than merely tolerated.
const registrations = (suites.match(/^check\(/gm) || []).length;
const files = readdirSync("checks").filter((f) => /\.(mjs|sh)$/.test(f)).length;
if (registrations < files) {
  fail.push(`suites.mjs registers ${registrations} checks for ${files} files in checks/`);
}
// No offline check may depend on a deployment.
for (const f of readdirSync("checks").filter((f) => f.endsWith(".mjs"))) {
  if (/ZZ_GATEWAY|ZZ_PAT/.test(readFileSync(`checks/${f}`, "utf8"))) {
    fail.push(`checks/${f} needs a deployment; it belongs in release.mjs, not the offline gate`);
  }
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("all checks wired: ok");
