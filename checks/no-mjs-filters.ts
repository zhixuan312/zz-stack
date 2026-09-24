// Asserts that no discovery site under scripts/ or checks/ filters on .mjs alone, rather than
// enumerating the sites that must change.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
};
const SUSPECT = [
  /sourceFiles\([^)]*\[\s*"\.mjs"\s*\]/,            // [".mjs"] alone
  /sourceFiles\([^)]*\[\s*"\.mjs"\s*,\s*"\.sh"\s*\]/, // [".mjs", ".sh"]
  /sourceFiles\([^)]*\[\s*"\.sh"\s*,\s*"\.mjs"\s*\]/, // [".sh", ".mjs"]
  /endsWith\(\s*["'`]\.mjs["'`]\s*\)/,
  /\\\.\(\s*mjs\s*\|/,                                // /\.(mjs|sh)$/
  /\.mjs\)\?\["'`]/,
  /\\\.mjs/,                                          // any escaped .mjs inside a regex literal
];
const fail: string[] = [];
// DELIBERATE: these files spell out .mjs and must keep doing so — each hunts .mjs for a
// living, so naming it is the point. Flipping one breaks the guard rather than the bug.
// COUPLED: a new check that hunts .mjs must be added here, or this check flags it.
const HUNTERS = new Set([
  "checks/no-mjs-filters.ts",        // its SUSPECT array must name what it hunts
  "checks/rename-complete.ts",       // asserts .mjs remnants are gone; empty match is its pass
  "checks/literal-paths-resolve.ts", // flags literal paths that still say .mjs
  "checks/entry-points-resolve.ts",  // flags npm scripts and shell scripts that still say .mjs
  "checks/docs-name-real-files.ts",  // flags stale .mjs in prose and runtime strings
  "checks/lock-current.ts",          // asserts no .mjs survives in the lock
  "checks/skill-commands-runnable.ts", // flags a SKILL.md still instructing a .mjs
]);
for (const f of [...walk("scripts"), ...walk("checks")].filter((x) => x.endsWith(".ts"))) {
  if (HUNTERS.has(f)) continue;
  const src = readFileSync(f, "utf8");
  src.split("\n").forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "");
    if (/^\s*\*/.test(line)) return;                  // block-comment prose
    if (SUSPECT.some((re) => re.test(code))) {
      fail.push(`${f}:${i + 1} still selects .mjs — ${line.trim().slice(0, 100)}`);
    }
  });
}
if (fail.length) {
  console.error("a discovery site still filters on .mjs; after the rename it matches nothing " +
                "and everything asserted over it passes:\n" + fail.join("\n"));
  process.exit(1);
}
