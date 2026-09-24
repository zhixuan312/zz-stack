// Nothing in scope is .mjs, and every relative specifier names a .ts file that is really there.
//
// Clause 1 below is what keeps HEAD free of .mjs paths: none can exist in the working tree, so
// none can reach a commit, so HEAD can never list one.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const DIRS = ["scripts", "checks", "testing", "catalog/zz/zz-access/skills"];
const fail: string[] = [];
const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
};
// 1. Nothing in scope is still .mjs.
for (const dir of DIRS) {
  const mjs = walk(dir).filter((f) => f.endsWith(".mjs"));
  if (mjs.length) fail.push(`${dir}: ${mjs.length} .mjs file(s) remain — ${mjs.slice(0, 5).join(", ")}`);
}
// 2. Every relative specifier names a .ts file that exists. A stale one throws only when the
//    line is reached, which may be during a release.
for (const dir of DIRS) {
  for (const f of walk(dir).filter((x) => x.endsWith(".ts"))) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      const t = line.trim();
      if (/^(\/\/|\*|\/\*)/.test(t)) continue;                    // prose, not a specifier
      // A statement, not a string. Several gate checks build JS source as a string and run it as a
      // subprocess — flow-classification.ts carries a whole import statement inside quotes. That is
      // generated code for another process, not this file's own specifier, and matching it would
      // report a defect in a file that has none.
      if (!/^import\b/.test(t) && !/^\}/.test(t)) continue;
      for (const m of line.matchAll(/(?:from\s+|import\s+)["'](\.[^"']+)["']/g)) {
        const spec = m[1];
        if (spec.endsWith(".mjs")) { fail.push(`${f}: still imports ${spec}`); continue; }
        const target = join(f, "..", spec);
        // Only specifiers inside the scanned directories must end in .ts. A relative import reaching out of the
        // converted directories — ../packages/contracts/dist/index.js and its kin — is compiled
        // output of another package. Demanding .ts there would point the specifier at a file that
        // has never existed.
        if (!DIRS.some((d) => target === d || target.startsWith(d + "/"))) continue;
        if (!spec.endsWith(".ts")) {
          fail.push(`${f}: relative import ${spec} names a converted file without a .ts extension`);
          continue;
        }
        try { statSync(target); }
        catch { fail.push(`${f}: imports ${spec}, which does not exist`); }
      }
    }
  }
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
