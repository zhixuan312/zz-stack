// Commands come from the manifest's declaration, never derived from a skill's name.
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

// DELIBERATE: code, not prose. Everything below asks what client-package.ts does, so it reads
// the file with its comments stripped. The word `commands` also appears in a docstring and in
// the path string `commands/<cmd>.md`, so a grep of the raw file stays green on a branch that
// has stopped reading the manifest.
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
// Neither file falls back to a literal "flow" type.
for (const f of ["services/gateway/src/client-package.ts", "services/gateway/src/package/skills.ts"]) {
  const src = readFileSync(f, "utf8").split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  if (/\?\s*["'`]flow["'`]\s*:/.test(src) || /:\s*["'`]flow["'`]\s*;/.test(src)) {
    fail.push(`the "flow" fallback survives in ${f}`);
  }
}
// DELIBERATE: `entry` must still exist. It answers a different question and zz-router needs it.
if (!/\bentry\b/.test(pkg)) fail.push("entry was removed; zz-router needs it to name the front door");

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("commands declared: ok");
