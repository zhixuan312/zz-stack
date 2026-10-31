// No file in scripts/ (outside scripts/gate/) or testing/ reaches the compiler's zero by widening
// to `any`. COUPLED: strict-tooling-zero.ts runs the compiler; this reads what it accepts.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (p.startsWith("scripts/gate")) continue;
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
};
const fail: string[] = [];

for (const f of [...walk("scripts"), ...walk("testing")].filter((x) => x.endsWith(".ts"))) {
  const src = readFileSync(f, "utf8");
  src.split("\n").forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "");
    if (/:\s*any\b|<any>|as\s+any\b/.test(code)) fail.push(`${f}:${i + 1} uses any`);
    // unknown asserted straight to a type is any with extra steps.
    if (/JSON\.parse\([^)]*\)\s+as\s+(?!unknown)[A-Z]/.test(code)) {
      fail.push(`${f}:${i + 1} asserts a JSON.parse result straight to a type without narrowing`);
    }
  });
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
