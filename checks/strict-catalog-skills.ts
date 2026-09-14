import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const ROOT = "catalog/zz/zz-access/skills";
const fail: string[] = [];
const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
};
const files = walk(ROOT).filter((f) => f.endsWith(".ts"));
if (files.length !== 5) fail.push(`${files.length} .ts skill scripts under ${ROOT}, expected 5`);

// They must be inside the project, or "zero errors" means "never looked".
const tooling = JSON.parse(readFileSync("tsconfig.tooling.json", "utf8").replace(/\/\*[\s\S]*?\*\//g, ""));
if (!(tooling.include ?? []).some((g: string) => g.startsWith("catalog/"))) {
  fail.push("tsconfig.tooling.json does not include catalog/ — these five files are not type-checked at all");
}
const r = spawnSync("npx", ["tsc", "--noEmit", "-p", "tsconfig.tooling.json"], { encoding: "utf8" });
const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
const mine = out.split("\n").filter((l) => l.startsWith("catalog/") && /error TS/.test(l));
if (mine.length) fail.push(`${mine.length} strict error(s) under ${ROOT}:\n` + mine.slice(0, 20).join("\n"));

for (const f of files) {
  const src = readFileSync(f, "utf8");
  src.split("\n").forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "");
    if (/:\s*any\b|<any>|as\s+any\b/.test(code)) fail.push(`${f}:${i + 1} uses any`);
    if (/^\s*(export\s+)?(enum|namespace)\s/.test(code)) fail.push(`${f}:${i + 1} is not erasable syntax`);
  });
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
