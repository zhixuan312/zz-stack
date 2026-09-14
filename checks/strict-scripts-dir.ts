import { spawnSync } from "node:child_process";
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
const r = spawnSync("npx", ["tsc", "--noEmit", "-p", "tsconfig.tooling.json"], { encoding: "utf8" });
const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
const mine = out.split("\n").filter((l) =>
  /^(scripts|testing)\/[^(]*\(\d+,\d+\): error TS/.test(l) && !l.startsWith("scripts/gate/"));
if (mine.length) fail.push(`${mine.length} strict error(s) remain:\n` + mine.slice(0, 20).join("\n"));

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
