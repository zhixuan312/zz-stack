// Scoped to this task's subtree, because the project as a whole is still red until I-12.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const r = spawnSync("npx", ["tsc", "--noEmit", "-p", "tsconfig.tooling.json"], { encoding: "utf8" });
const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
const mine = out.split("\n").filter((l) => /^checks\/[^(]*\(\d+,\d+\): error TS/.test(l));
const fail: string[] = [];
if (mine.length) fail.push(`${mine.length} strict error(s) remain under checks/:\n` + mine.slice(0, 20).join("\n"));
// Zero errors reached by widening is not zero errors.
// A DETECTOR MUST NAME WHAT IT DETECTS. The two regexes below contain the literal strings
// "any" and "@ts-expect-error", so scanning this file with them flags the detector itself —
// the same self-exemption every other self-scanning check in this tree already carries.
// THE WHOLE DETECTOR FAMILY IS EXEMPT, not just this file. strict-gate-dir and
// strict-scripts-dir carry the same two regexes for their own subtrees, so scanning them for
// the literals those regexes are made of reports the detectors instead of the code. Each of
// the three covers a different directory and none scans the others' subject.
const DETECTORS = new Set([
  "strict-checks-dir.ts", "strict-gate-dir.ts", "strict-scripts-dir.ts",
  "strict-catalog-skills.ts",
]);
// Four now, one per converted subtree, and the list is by name rather than by pattern on
// purpose: a rule like /^strict-/ would silently excuse any future file that happened to be
// named that way, which is precisely the "green by absence" failure this repository exists to
// refuse. Each entry here is a file that must name `any` in order to detect it.
for (const f of readdirSync("checks").filter((x) => x.endsWith(".ts") && !DETECTORS.has(x))) {
  const src = readFileSync(join("checks", f), "utf8");
  src.split("\n").forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "");
    if (/:\s*any\b|<any>|as\s+any\b/.test(code)) fail.push(`checks/${f}:${i + 1} uses any`);
    if (/@ts-expect-error|@ts-ignore/.test(code)) fail.push(`checks/${f}:${i + 1} silences the compiler`);
  });
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
