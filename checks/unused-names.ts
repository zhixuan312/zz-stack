// Tier 3, reported by `npm run test:release` and never a gate failure: no unused local, import or
// parameter in any project of the build or in the tooling project.
// DELIBERATE: the flags are passed here, not set in tsconfig.base.json. `tsc -b` takes no compiler
// flags on its command line, and a build must not fail on an unused name.
// COUPLED: the projects are tsconfig.json's references; `tsc -p` reads each one's built declarations
// under dist/, so this runs after the build.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// DELIBERATE: JSON strings are skipped, not stripped, so a path holding `/*` survives.
const strip = (s: string) => s.replace(/"(?:[^"\\]|\\.)*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
  (m) => (m.startsWith('"') ? m : ""));
const root: unknown = JSON.parse(strip(readFileSync("tsconfig.json", "utf8")));
const refs = (root as { references?: { path: string }[] }).references ?? [];
const projects = [...refs.map((r) => r.path), "tsconfig.tooling.json"];

const findings: string[] = [];
for (const p of projects) {
  const r = spawnSync("npx", ["tsc", "--noEmit", "--noUnusedLocals", "--noUnusedParameters", "-p", p],
    { encoding: "utf8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const errors = out.split("\n").filter((l) => /error TS\d+:/.test(l));
  if (errors.length) findings.push(`${p}: ${errors.length}`, ...errors.slice(0, 20).map((e) => `  ${e}`));
  else if (r.status !== 0) findings.push(`${p}: tsc exited ${r.status} with no error lines — misconfigured, not clean:\n${out}`);
}
if (findings.length) { console.error(findings.join("\n")); process.exit(1); }
