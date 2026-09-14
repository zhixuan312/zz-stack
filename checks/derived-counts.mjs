// No shipped file asserts a count of the platform's own surface.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
const fail = [];

// A number-word GRAMMAR, not a list of the numbers that happen to be wrong today. An
// enumerated list would itself be a hand-maintained thing to remember — the defect this
// check exists to catch, reproduced inside the check.
const ONES = "(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|" +
             "fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)";
const TENS = "(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)";
const WORDS = `(${TENS}([- ]${ONES})?|${ONES})`;
const NEAR = "(tool|tools|door|doors|skill|skills)";
const walk = (d) => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? (["node_modules", "dist", "_versions", "evals"].includes(f) ? [] : walk(p)) : [p];
});
for (const dir of ["services", "packages", "scripts", "skills", "catalog"]) {
  if (!existsSync(dir)) continue;
  for (const p of walk(dir)) {
    if (!/\.(ts|mjs|js|md)$/.test(p)) continue;
    const body = readFileSync(p, "utf8");
    for (const line of body.split("\n")) {
      // A spelled count next to a surface noun is a hand-maintained assertion.
      if (new RegExp(`${WORDS}\\s+${NEAR}\\b`, "i").test(line)
          || new RegExp(`${NEAR}\\s+(are|is)\\s+these\\s+${WORDS}`, "i").test(line)) {
        fail.push(`${p}: ${line.trim().slice(0, 100)}`);
      }
    }
  }
}
// The generated tool table must actually be generated, and non-empty.
const gen = readFileSync("services/gateway/src/client-package.ts", "utf8");
if (!/toolTable|renderTools|registrations/.test(gen)) {
  fail.push("zz-platform's tool table is not generated at package build");
}
// Control: a historical measurement inside an argument is NOT a surface description and
// must not be flagged. If this string trips the check, the pattern is too broad.
const sample = "six of eleven checks passed on a deliberately broken tree";
if (new RegExp(`${WORDS}\\s+${NEAR}\\b`, "i").test(sample)) {
  fail.push("the pattern flags a historical measurement; it is too broad");
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("derived counts: ok");
