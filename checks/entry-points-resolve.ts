// Entry points are what a human types. A stale one is not caught by any import graph.
import { readFileSync, existsSync } from "node:fs";
const fail: string[] = [];
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
  for (const m of String(cmd).matchAll(/((?:scripts|checks|testing)\/[A-Za-z0-9._\/-]+\.(?:ts|mjs))/g)) {
    const p = m[1];
    if (p.endsWith(".mjs")) fail.push(`npm script "${name}" names ${p}, which no longer exists`);
    else if (!existsSync(p)) fail.push(`npm script "${name}" names ${p}, which does not exist`);
  }
}
for (const sh of ["deploy/install-backup-cron.sh", "scripts/build-image.sh"]) {
  const src = readFileSync(sh, "utf8");
  src.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/((?:scripts|checks)\/[A-Za-z0-9._\/-]+\.(?:ts|mjs))/g)) {
      const p = m[1];
      if (p.endsWith(".mjs")) fail.push(`${sh}:${i + 1} names ${p}, which no longer exists`);
      else if (!existsSync(p)) fail.push(`${sh}:${i + 1} names ${p}, which does not exist`);
    }
  });
}
// The dist-running scripts must NOT have been swept up: they are compiled output of code
// that was already TypeScript, and rewriting them would break every one of them.
const dist = Object.entries(pkg.scripts ?? {}).filter(([, c]) => /dist\/.*\.js\b/.test(String(c)));
// 20, was 21. `refresh-block-tools` is gone: it measured what a THIRD PARTY's tools cost us,
// and this platform has no third-party servers to measure.
if (dist.length !== 20) {
  fail.push(`${dist.length} npm scripts run a dist/*.js path, expected 20 — the conversion ` +
            `reached code that was already TypeScript`);
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
