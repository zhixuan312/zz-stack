// The inverse assertion. Rather than listing the sites that must change — a list that goes
// stale the moment anything moves — this asserts that NO discovery site filters on .mjs alone
// anywhere in the tooling. It cannot miss a site the way an enumeration can.
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
// TWO FILES LEGITIMATELY SPELL OUT .mjs AND MUST NOT BE FLIPPED. This check's own SUSPECT
// array has to name the thing it hunts, so it matches itself; and rename-complete.ts exists to
// assert .mjs remnants are GONE, so an empty match is its pass condition — the exact inverse of
// the silent-class risk. Flipping either would break the guard rather than the bug.
const HUNTERS = new Set([
  "checks/no-mjs-filters.ts",        // its SUSPECT array must name what it hunts
  "checks/rename-complete.ts",       // asserts .mjs remnants are gone; empty match is its pass
  "checks/literal-paths-resolve.ts", // flags literal paths that still say .mjs
  "checks/entry-points-resolve.ts",  // flags npm scripts and shell scripts that still say .mjs
  "checks/docs-name-real-files.ts",  // flags stale .mjs in prose and runtime strings
  "checks/lock-current.ts",          // asserts no .mjs survives in the lock
  "checks/skill-commands-runnable.ts", // flags a SKILL.md still instructing a .mjs
]);
// Seven files, and the list is explicit rather than a heuristic on purpose: each one hunts
// .mjs for a living, so each must spell it out, and a clever rule that inferred "this looks
// like a hunter" would eventually excuse a file that is simply stale. A named list with a
// reason per entry is auditable; a heuristic is not.
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
