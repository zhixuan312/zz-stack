// Commands come from the map. The deriver is gone, not merely unused.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const fail: string[] = [];

const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? (f === "node_modules" || f === "dist" ? [] : walk(p)) : [p];
});
for (const p of [...walk("services"), ...walk("packages"), ...walk("scripts")]) {
  if (!/\.(ts|mjs|js)$/.test(p)) continue;
  if (/\bcommandName\b/.test(readFileSync(p, "utf8"))) {
    fail.push(`${p} still references commandName — it must be deleted, not left dormant`);
  }
}

// CODE, NOT PROSE. Everything below asks what client-package.ts DOES, so it reads the file
// with its comments stripped. The first version of this check asked whether the word
// `commands` appeared anywhere in it, and that is true of a docstring, of an unrelated
// sentence about `claude plugin` commands, and of the string `commands/${cmd}.md` — so the
// whole platform-plugin branch could stop reading the manifest and this still said ok. That
// was measured, not guessed: the branch was replaced with an empty list and the check passed.
const pkg = readFileSync("services/gateway/src/client-package.ts", "utf8")
  .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

// The two readers of the declaration, each answering a different question: which skills this
// package promotes to commands, and what its entry skill is typed as. Named as calls, because
// importing a function and never calling it is what "bypassed, not deleted" looks like.
for (const [fn, what] of [["promoteCommands", "promote the skills the manifest declares as commands"],
                          ["entryCommand", "find what the entry skill is typed as"]]) {
  if (!new RegExp(`\\b${fn}\\s*\\(`).test(pkg)) {
    fail.push(`client-package.ts never calls ${fn}() — it must ${what} from the manifest's ` +
              "commands map, not derive a name from a skill");
  }
}
// The literal fallback must be gone — here and in the packager it lived in.
for (const f of ["services/gateway/src/client-package.ts", "services/gateway/src/package/skills.ts"]) {
  const src = readFileSync(f, "utf8").split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  if (/\?\s*["'`]flow["'`]\s*:/.test(src) || /:\s*["'`]flow["'`]\s*;/.test(src)) {
    fail.push(`the "flow" fallback survives in ${f}`);
  }
}
// Control: `entry` must still exist. It answers a different question and zz-router needs it.
if (!/\bentry\b/.test(pkg)) fail.push("entry was removed; zz-router needs it to name the front door");

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("commands declared: ok");
