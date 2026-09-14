// Two claims: the project is wired into the build, and its strictness is the inherited
// strictness rather than a softer local copy. The second matters more — a tsconfig that
// silently relaxes noUnusedLocals would show a much smaller error count and look like progress.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const fail: string[] = [];
// JSON STRINGS ARE SKIPPED, NOT STRIPPED. "scripts/**/*.ts" contains a literal /**/ that a
// naive block-comment strip reads as an empty comment and removes, turning the glob into
// "scripts*.ts" — so this check used to fail against the exact spelling it demands.
const strip = (s: string) => s.replace(/"(?:[^"\\]|\\.)*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
  (m) => (m.startsWith('"') ? m : ""));
const tooling = JSON.parse(strip(readFileSync("tsconfig.tooling.json", "utf8")));
const root = JSON.parse(strip(readFileSync("tsconfig.json", "utf8")));

if (tooling.extends !== "./tsconfig.base.json") {
  fail.push(`tsconfig.tooling.json extends ${JSON.stringify(tooling.extends)}, not the base`);
}
const co = tooling.compilerOptions ?? {};
for (const [k, v] of Object.entries({
  noEmit: true, declaration: false, erasableSyntaxOnly: true,
  rewriteRelativeImportExtensions: true, verbatimModuleSyntax: true,
  allowImportingTsExtensions: true,
})) {
  if (co[k] !== v) fail.push(`tsconfig.tooling.json compilerOptions.${k} is ${JSON.stringify(co[k])}, expected ${v}`);
}
// A local re-declaration of an inherited strictness flag is how a conversion gets cheaper
// without getting better. None of these may appear here at all.
for (const k of ["strict", "noUnusedLocals", "noUnusedParameters", "noImplicitAny"]) {
  if (k in co) fail.push(`tsconfig.tooling.json re-declares ${k} — it must inherit from the base`);
}
for (const g of ["scripts/**/*.ts", "checks/**/*.ts", "testing/**/*.ts"]) {
  if (!(tooling.include ?? []).includes(g)) fail.push(`tsconfig.tooling.json include is missing ${g}`);
}
// NOT A tsc -b REFERENCE, DELIBERATELY. Two standing gate checks require every entry in
// tsconfig.json's `references` to be a workspace package with its own package.json, and
// scripts/ and checks/ are neither. They are also noEmit, so they have no place in a BUILD
// graph. The tooling project is run on its own, and this asserts the reference is absent and
// the script that runs it exists — a config nothing invokes enforces nothing.
if ((root.references ?? []).some((r: { path: string }) => r.path === "./tsconfig.tooling.json")) {
  fail.push("tsconfig.json references ./tsconfig.tooling.json — it is not a workspace package, " +
            "and two standing gate checks refuse a reference that is not one");
}
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
if (pkg.scripts?.["typecheck:tooling"] !== "tsc --noEmit -p tsconfig.tooling.json") {
  fail.push('package.json has no "typecheck:tooling" script running ' +
            "`tsc --noEmit -p tsconfig.tooling.json` — nothing would run the tooling project");
}
const r = spawnSync("npx", ["tsc", "--noEmit", "-p", "tsconfig.tooling.json"], { encoding: "utf8" });
if (r.status !== 0) {
  fail.push(`the tooling project does not typecheck clean:\n${r.stdout ?? ""}${r.stderr ?? ""}`);
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
