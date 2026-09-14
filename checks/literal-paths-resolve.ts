// Every literal tooling path mentioned anywhere in scripts/ or checks/ must name a file that
// exists. This covers imports, spawns and readFileSync calls in one sweep, so a class of site
// nobody enumerated is still caught.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
};
const fail: string[] = [];
const files = [...walk("scripts"), ...walk("checks")].filter((f) => f.endsWith(".ts"));
for (const f of files) {
  const src = readFileSync(f, "utf8");
  src.split("\n").forEach((line, i) => {
    if (/^\s*\*/.test(line) || /^\s*\/\//.test(line)) return;      // prose
    for (const m of line.matchAll(/["'`]((?:\.{0,2}\/)?(?:scripts|checks|testing)\/[A-Za-z0-9._\/-]+\.(?:ts|mjs))["'`]/g)) {
      const spec = m[1];
      if (spec.endsWith(".mjs")) { fail.push(`${f}:${i + 1} names ${spec}, which no longer exists`); continue; }
      // A PLANTED PROBE IS MEANT TO BE ABSENT. Break-tests write a file, run the gate against it
      // and rmSync it in the same process; `zz-temp-` is this repository's marker for that.
      // Requiring one to exist in a checked-out tree asserts the opposite of what it is for.
      if (/(^|\/)zz-(temp|audit)-/.test(spec)) continue;
      // RESOLVED AGAINST THE FILE THAT NAMES IT, not the process's cwd. "../scripts/gate/read.ts"
      // written inside checks/ is correct; resolving it from the repository root tests a path one
      // directory ABOVE the repository and reports every correct relative import as missing.
      // EITHER RESOLUTION COUNTS. A literal path in this tree is sometimes an import specifier,
      // resolved against the file that writes it, and sometimes a path handed to readFileSync or
      // a subprocess, resolved against the repository root. Nothing in the text distinguishes
      // them, so the file must exist under one reading or the other — demanding a single one
      // reports correct code as broken.
      const fromFile = join(f, "..", spec);
      const fromRoot = spec.replace(/^\.\//, "");
      if (!existsSync(fromFile) && !existsSync(fromRoot)) {
        fail.push(`${f}:${i + 1} names ${spec}, which exists neither beside it nor at the repository root`);
      }
    }
  });
}
// The self-check that fails silently rather than loudly.
const sv = readFileSync("scripts/skill-versions.ts", "utf8");
if (/endsWith\(["'`]skill-versions\.mjs["'`]\)/.test(sv)) {
  fail.push("scripts/skill-versions.ts:~140 still compares argv[1] against skill-versions.mjs — " +
            "this does not throw, it silently takes the wrong branch");
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
