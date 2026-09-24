// Every literal tooling path mentioned anywhere in scripts/ or checks/ must name a file that
// exists — imports, spawns and reads in one sweep, so a class of site nobody enumerated is
// still caught.
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
// One file is data about a plan rather than code that dereferences a path: the edit-surface
// ledger carries a row per deliverable the approved specification declares, most of them
// future tasks' outputs that do not exist yet. A ledger row is not an import, a spawn or a
// read, and its paths being absent is the normal state of a plan partway through.
//
// DELIBERATE: the exemption is carved here rather than inside the scanned file. An exemption
// that assembles its strings at runtime blinds this check for every later reader, and any
// real import can climb through the same idiom.
const LEDGER = "scripts/tenant-info/ledger.ts";

const files = [...walk("scripts"), ...walk("checks")].filter((f) => f.endsWith(".ts"));
for (const f of files) {
  if (f === LEDGER) continue;
  const src = readFileSync(f, "utf8");
  src.split("\n").forEach((line, i) => {
    if (/^\s*\*/.test(line) || /^\s*\/\//.test(line)) return;      // prose
    for (const m of line.matchAll(/["'`]((?:\.{0,2}\/)?(?:scripts|checks|testing)\/[A-Za-z0-9._\/-]+\.(?:ts|mjs))["'`]/g)) {
      const spec = m[1];
      // A path inside a string that is itself inside a string is a fixture, not a reference:
      // `checks/tenant-checks-registered.ts` hands a classifier whole fragments of TypeScript
      // as data, and nothing in it opens, imports or spawns what those fragments name.
      //
      // The rule is lexical and narrow: the inner quote is inside an unclosed outer one on
      // the same line. A real import, spawn or read is never nested that way.
      const before = line.slice(0, m.index);
      const unclosed = (quote: string): boolean =>
        (before.match(new RegExp(`(?<!\\\\)${quote}`, "g")) ?? []).length % 2 === 1;
      if (unclosed("'") || unclosed("`")) continue;
      if (spec.endsWith(".mjs")) { fail.push(`${f}:${i + 1} names ${spec}, which no longer exists`); continue; }
      // A planted probe is meant to be absent: a break-test writes a file, runs the gate
      // against it and removes it in the same process. `zz-temp-` is the marker for that.
      if (/(^|\/)zz-(temp|audit)-/.test(spec)) continue;
      // Either resolution counts. A literal path here is sometimes an import specifier,
      // resolved against the file that writes it, and sometimes a path handed to a read or a
      // subprocess, resolved against the repository root. Nothing in the text distinguishes
      // them, so the file must exist under one reading or the other.
      const fromFile = join(f, "..", spec);
      const fromRoot = spec.replace(/^\.\//, "");
      if (!existsSync(fromFile) && !existsSync(fromRoot)) {
        fail.push(`${f}:${i + 1} names ${spec}, which exists neither beside it nor at the repository root`);
      }
    }
  });
}
// skill-versions.ts decides whether it was run directly by comparing argv[1] against its own
// file name. A stale `.mjs` name there does not throw; it silently takes the wrong branch.
const sv = readFileSync("scripts/skill-versions.ts", "utf8");
if (/endsWith\(["'`]skill-versions\.mjs["'`]\)/.test(sv)) {
  fail.push("scripts/skill-versions.ts:~140 still compares argv[1] against skill-versions.mjs — " +
            "this does not throw, it silently takes the wrong branch");
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
