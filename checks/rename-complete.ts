// Nothing in scope is .mjs, and every relative specifier names a .ts file that is really there.
//
// THERE WAS A THIRD CLAUSE AND IT IS DELETED, not moved. It read `git ls-tree -r HEAD` for the
// .mjs files tracked before the rename and required each to exist at the same path as .ts —
// the real assertion while the rename sat uncommitted, and this file's own header said so:
// "once the rename lands, HEAD lists .ts and the comparison becomes vacuously true". It landed.
// HEAD carries zero .mjs paths, in these four directories and in the whole repository, so the
// loop ran over an empty list and could not fail. Clause 1 below is what keeps it that way, and
// it makes the deleted clause permanently unreachable rather than merely quiet today: no .mjs
// can exist in the working tree, so none can reach a commit, so HEAD can never list one again.
// A clause no input can reach is a comment wearing an assertion's clothes.
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
      // A STATEMENT, NOT A STRING. Several gate checks build JS source as a string and run it
      // as a subprocess — flow-classification.ts:201 carries a whole import statement inside
      // quotes. That is generated code for another process, not this file's own specifier, and
      // matching it reports a defect in a file that has none.
      if (!/^import\b/.test(t) && !/^\}/.test(t)) continue;
      for (const m of line.matchAll(/(?:from\s+|import\s+)["'](\.[^"']+)["']/g)) {
        const spec = m[1];
        if (spec.endsWith(".mjs")) { fail.push(`${f}: still imports ${spec}`); continue; }
        const target = join(f, "..", spec);
        // ONLY SIBLINGS THIS RENAME TOUCHED must end in .ts. A relative import reaching OUT of
        // the converted directories — ../packages/contracts/dist/index.js and its kin — is
        // compiled output of another package. It was correct before this task and stays correct
        // after it, and demanding .ts there would point the specifier at a file that has never
        // existed. The spec keeps those dist imports exactly as they are.
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
