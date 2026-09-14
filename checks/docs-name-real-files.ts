// Every path named in prose or in a runtime string must exist. CHANGELOG.md is exempt BY NAME:
// it is a historical record and its .mjs mentions were true when written.
import { readFileSync, existsSync } from "node:fs";
const fail: string[] = [];
const DOCS = ["README.md", "ARCHITECTURE.md", "CONTRIBUTING.md",
              "deploy/README.md", "deploy/.env.example",
              "deploy/install-backup-cron.sh", "scripts/build-image.sh"];
for (const d of DOCS) {
  if (!existsSync(d)) { fail.push(`${d} does not exist — the sweep list is stale`); continue; }
  readFileSync(d, "utf8").split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/((?:scripts|checks|testing)\/[A-Za-z0-9._\/-]+\.(?:ts|mjs))/g)) {
      const p = m[1];
      if (p.endsWith(".mjs")) fail.push(`${d}:${i + 1} names ${p}, which no longer exists`);
      else if (!existsSync(p)) fail.push(`${d}:${i + 1} names ${p}, which does not exist`);
    }
  });
}
// The three functional runtime strings — NOT comments. A stale one is read by a human at the
// moment something has already failed, and followed literally.
for (const f of ["services/gateway/src/package/plugin-lock.ts",
                 "packages/tools/src/ops/register-plugins.ts"]) {
  readFileSync(f, "utf8").split("\n").forEach((line, i) => {
    if (/^\s*(\*|\/\/)/.test(line)) return;            // comments are swept, but not asserted here
    for (const m of line.matchAll(/(scripts\/[A-Za-z0-9._\/-]+\.mjs)/g)) {
      fail.push(`${f}:${i + 1} is a runtime string instructing a user to run ${m[1]}, which no longer exists`);
    }
  });
}
if (!/\.mjs/.test(readFileSync("CHANGELOG.md", "utf8"))) {
  fail.push("CHANGELOG.md no longer mentions .mjs — its history was rewritten, which this task forbids");
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
