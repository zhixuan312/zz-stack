// Counts, not spot checks. A rename that drops files is the failure this catches, and it is
// invisible to anything that only looks at what is present.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
// NO HARDCODED DENOMINATOR. Earlier tasks in this plan add check files of their own, so any
// count written here is wrong by the time it runs — and a hand-kept denominator that drifts is
// a defect this repository has already paid for once. The count comes from git instead.
//
// RUN THIS BEFORE THE RENAME IS COMMITTED. `git ls-tree HEAD` reports the CURRENT commit, so
// once the rename lands, HEAD lists .ts and the "nothing was lost" comparison below becomes
// vacuously true. On an uncommitted working tree it is the real assertion. The task is not
// complete until this has passed once against the uncommitted tree.
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
// 2. Nothing was LOST. git knows how many .mjs were tracked before this commit; every one of
//    them must now exist at the same path with a .ts extension.
const previously = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], { encoding: "utf8" })
  .split("\n")
  .filter((p) => p.endsWith(".mjs") && DIRS.some((d) => p.startsWith(d + "/")));
for (const old of previously) {
  const expected = old.replace(/\.mjs$/, ".ts");
  try { statSync(expected); }
  catch { fail.push(`${old} was tracked at HEAD but ${expected} does not exist — the rename lost a file`); }
}
// 3. Every relative specifier names a .ts file that exists. A stale one throws only when the
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
