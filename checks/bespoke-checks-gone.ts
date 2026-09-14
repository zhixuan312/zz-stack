// Anchored on the registrations, not on a substring: the word "never imported" also appears in
// the surviving header prose, and a bare grep would report failure on a correct deletion.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const fail: string[] = [];
const build = readFileSync("scripts/gate/checks/build.ts", "utf8");
for (const name of ["every script parses", "no script uses a name it never imported"]) {
  if (new RegExp(`^check\\(\\s*["'\`]${name}`, "m").test(build)) {
    fail.push(`scripts/gate/checks/build.ts still registers "${name}"`);
  }
}
// Not merely moved somewhere else in the tree.
for (const f of readdirSync("scripts/gate/checks").filter((x) => x.endsWith(".ts"))) {
  const src = readFileSync(join("scripts/gate/checks", f), "utf8");
  for (const name of ["every script parses", "no script uses a name it never imported"]) {
    if (new RegExp(`^check\\(\\s*["'\`]${name}`, "m").test(src)) {
      fail.push(`"${name}" was moved to scripts/gate/checks/${f} rather than deleted`);
    }
  }
}
// BOTH surviving neighbours must survive. Three checks live close together here: one sits
// BETWEEN the two deletions and is the easiest to remove by accident.
for (const survivor of ["every package manifest carries the same version",
                        "nothing in testing/ computes"]) {
  if (!new RegExp(`^check\\(\\s*["'\`]${survivor}`, "m").test(build)) {
    fail.push(`the neighbouring check "${survivor}…" was deleted too — it is not in scope`);
  }
}
// The incident history is kept.
if (!/0\.26\.1/.test(build)) {
  fail.push("the 0.26.1 incident narrative was deleted along with the checks — it is the reason " +
            "checks/node-floor.ts exists and is still true");
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
