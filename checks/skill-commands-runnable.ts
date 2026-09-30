// The command a model is told to run must name a file the consumer will actually have.
// That means resolving it against the built tree, not against catalog/.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const fail: string[] = [];
const SKILLS = "catalog/zz/zz-access/skills";
for (const skill of readdirSync(SKILLS)) {
  const md = join(SKILLS, skill, "SKILL.md");
  if (!existsSync(md)) continue;
  const src = readFileSync(md, "utf8");
  for (const m of src.matchAll(/CLAUDE_PLUGIN_ROOT\}\/(skills\/[A-Za-z0-9._\/-]+\.(?:mjs|js|ts))/g)) {
    const rel = m[1];
    if (rel.endsWith(".mjs")) { fail.push(`${md} still instructs a .mjs file: ${rel}`); continue; }
    if (rel.endsWith(".ts")) { fail.push(`${md} instructs .ts — consumers receive .js: ${rel}`); continue; }
    const shipped = join("marketplace/zz-access", rel);
    if (!existsSync(shipped)) fail.push(`${md} instructs ${rel}, absent from the built tree at ${shipped}`);
  }
}
// COUPLED: checks/skill-homes.ts asserts source paths, which stay .ts. Conflating the two is
// the obvious wrong fix.
const homes = readFileSync("checks/skill-homes.ts", "utf8");
if (/catalog\/[A-Za-z0-9._\/-]+\.mjs/.test(homes)) fail.push("checks/skill-homes.ts still asserts a .mjs source path");
if (/catalog\/[A-Za-z0-9._\/-]+\.js["'`]/.test(homes)) {
  fail.push("checks/skill-homes.ts asserts a .js path under catalog/ — catalog holds SOURCE (.ts); " +
            "the .js exists only in the built marketplace tree");
}
// The file a consumer actually reads: the SKILL.md the packager wrote, under its command's name,
// from the catalog SKILL.md's text — so checking only the catalog source passes while the
// shipped skill is wrong.
for (const c of readdirSync("marketplace/zz-access/skills")) {
  const p = join("marketplace/zz-access/skills", c, "SKILL.md");
  if (!existsSync(p)) continue;
  const src = readFileSync(p, "utf8");
  for (const m of src.matchAll(/CLAUDE_PLUGIN_ROOT\}\/(skills\/[A-Za-z0-9._\/-]+\.(?:mjs|js|ts))/g)) {
    const rel = m[1];
    if (rel.endsWith(".mjs")) fail.push(`${p} still instructs ${rel} — rebuild marketplace/ in this task`);
    else if (rel.endsWith(".ts")) fail.push(`${p} instructs .ts — consumers receive .js: ${rel}`);
    else if (!existsSync(join("marketplace/zz-access", rel))) {
      fail.push(`${p} instructs ${rel}, which is absent from the built tree`);
    }
  }
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
