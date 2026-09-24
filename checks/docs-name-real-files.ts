// Every path named in prose or in a runtime string must exist. DELIBERATE: CHANGELOG.md is
// exempt by name — it is a historical record and its .mjs mentions were true when written.
import { readFileSync, existsSync } from "node:fs";
const fail: string[] = [];
const DOCS = ["README.md", "ARCHITECTURE.md", "CONTRIBUTING.md",
              "deploy/README.md", "deploy/.env.example", "deploy/RESTORE-AND-CUTOVER.md",
              "deploy/install-backup-cron.sh", "scripts/build-image.sh"];
for (const d of DOCS) {
  if (!existsSync(d)) { fail.push(`${d} does not exist — the sweep list is stale`); continue; }
  readFileSync(d, "utf8").split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/((?:scripts|checks|testing)\/[A-Za-z0-9._\/-]+\.(?:ts|mjs))/g)) {
      const p = m[1];
      if (p.endsWith(".mjs")) fail.push(`${d}:${i + 1} names ${p}, which no longer exists`);
      else if (!existsSync(p)) fail.push(`${d}:${i + 1} names ${p}, which does not exist`);
    }
    // Migrations too: the sweep above reads only .ts and .mjs, and a restore rehearsal is
    // followed literally.
    for (const m of line.matchAll(/(services\/gateway\/migrations\/[A-Za-z0-9._-]+\.sql)/g)) {
      if (!existsSync(m[1])) {
        fail.push(`${d}:${i + 1} names ${m[1]}, which does not exist — an operator following ` +
                  "this document pipes a missing file into psql");
      }
    }
  });
}
// The functional runtime strings, not comments. A stale one is read by a human at the moment
// something has already failed, and followed literally.
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
