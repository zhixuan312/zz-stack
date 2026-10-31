// What consumers receive. Three claims: JavaScript only, no source leaked, and reproducible.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const fail: string[] = [];
const walk = (dir: string, out: string[] = []): string[] => {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
};
const shipped = walk("marketplace");
for (const f of shipped) {
  if (f.endsWith(".ts")) fail.push(`${f} — TypeScript source reached the shipped tree`);
  if (f.endsWith(".map")) fail.push(`${f} — a source map reached the shipped tree`);
}
const js = shipped.filter((f) => /marketplace\/zz-access\/skills\/.*\.js$/.test(f));
if (js.length !== 6) fail.push(`${js.length} shipped skill scripts, expected 6`);
for (const f of js) {
  if (/\/\/# sourceMappingURL/.test(readFileSync(f, "utf8"))) {
    fail.push(`${f} carries an inline sourceMappingURL — the build is not deterministic`);
  }
}
// DELIBERATE: reproducible means two builds from the same catalog agree, so this builds twice and
// compares the two. The tree as found is not one of them: a committed shelf that is behind the
// catalog is stale, not non-deterministic, and that is scripts/gate/checks/marketplace.ts's verdict.
const digest = (): string => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p); else files.push(p);
    }
  };
  walk("marketplace");
  walk(".claude-plugin");
  const h = createHash("sha256");
  for (const f of files.sort()) { h.update(f); h.update(readFileSync(f)); }
  return h.digest("hex");
};
const build = (): string => { execFileSync("node", ["scripts/build-marketplace.ts"], { stdio: "pipe" }); return digest(); };
const first = build();
const second = build();
if (first !== second) {
  fail.push(`two builds of marketplace/ from the same catalog differ — the compile is not deterministic ` +
            `(${first.slice(0, 12)} -> ${second.slice(0, 12)})`);
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
