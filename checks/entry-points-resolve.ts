// Entry points are what a human types. A stale one is not caught by any import graph.
//
// `.mjs` is judged by its EXTENSION and not by existence, and both messages say which they are:
// b896d7d3 renamed the tooling layer to TypeScript and nothing under scripts/, checks/ or testing/
// is written as `.mjs` any more, so a name that still ends that way is stale whether or not a file
// sits there. Saying "which no longer exists" while checking only the extension was the defect —
// the message claimed more than the check had looked at.
import { readFileSync, existsSync } from "node:fs";
const fail: string[] = [];
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
  for (const m of String(cmd).matchAll(/((?:scripts|checks|testing)\/[A-Za-z0-9._\/-]+\.(?:ts|mjs))/g)) {
    const p = m[1];
    if (p.endsWith(".mjs")) fail.push(`npm script "${name}" names ${p}, a .mjs path nothing under scripts/, checks/ or testing/ writes`);
    else if (!existsSync(p)) fail.push(`npm script "${name}" names ${p}, which does not exist`);
  }
}
for (const sh of ["deploy/install-backup-cron.sh", "scripts/build-image.sh"]) {
  const src = readFileSync(sh, "utf8");
  src.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/((?:scripts|checks)\/[A-Za-z0-9._\/-]+\.(?:ts|mjs))/g)) {
      const p = m[1];
      if (p.endsWith(".mjs")) fail.push(`${sh}:${i + 1} names ${p}, a .mjs path nothing under scripts/, checks/ or testing/ writes`);
      else if (!existsSync(p)) fail.push(`${sh}:${i + 1} names ${p}, which does not exist`);
    }
  });
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
