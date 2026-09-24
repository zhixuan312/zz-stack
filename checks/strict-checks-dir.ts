// Scoped to checks/: `tsc` errors from any other subtree are ignored here.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const r = spawnSync("npx", ["tsc", "--noEmit", "-p", "tsconfig.tooling.json"], { encoding: "utf8" });
const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
const mine = out.split("\n").filter((l) => /^checks\/[^(]*\(\d+,\d+\): error TS/.test(l));
const fail: string[] = [];
if (mine.length) fail.push(`${mine.length} strict error(s) remain under checks/:\n` + mine.slice(0, 20).join("\n"));
// Zero errors reached by widening is not zero errors.
// DELIBERATE: the whole strict-* detector family is exempt from the scan below, not just this
// file. Each carries the same two regexes, whose literals are the strings being detected, so
// scanning one reports the detector instead of the code. Each covers a different directory
// and none scans another's subject.
const DETECTORS = new Set([
  "strict-checks-dir.ts", "strict-gate-dir.ts", "strict-scripts-dir.ts",
  "strict-catalog-skills.ts",
]);
// DELIBERATE: the exemption list is by name, not a /^strict-/ pattern, which would silently
// excuse any future file named that way. Each entry must name what it detects in order to
// detect it.
for (const f of readdirSync("checks").filter((x) => x.endsWith(".ts") && !DETECTORS.has(x))) {
  const src = readFileSync(join("checks", f), "utf8");
  src.split("\n").forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "");
    if (/:\s*any\b|<any>|as\s+any\b/.test(code)) fail.push(`checks/${f}:${i + 1} uses any`);
    if (/@ts-expect-error|@ts-ignore/.test(code)) fail.push(`checks/${f}:${i + 1} silences the compiler`);
  });
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
