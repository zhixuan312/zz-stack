// Every plugin declares what it is, what it ships, and what each stage leaves behind.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { CatalogManifest } from "../packages/contracts/dist/index.js";
const fail: string[] = [];
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? (["node_modules", "dist", "_versions"].includes(f) ? [] : walk(p)) : [p];
});

const plugins = [
  ["zz-core",        "catalog/zz/zz-core"],
  ["sdlc-flow",      "catalog/sdlc/sdlc-flow"],
  ["zz-access",      "catalog/zz/zz-access"],
  ["zz-plugin-eval", "catalog/zz/zz-plugin-eval"],
];
for (const [name, dir] of plugins) {
  const mf = join(dir, "flow.json");
  if (!existsSync(mf)) { fail.push(`${name} has no manifest at ${mf}`); continue; }
  const m = JSON.parse(readFileSync(mf, "utf8"));
  const parsed = CatalogManifest.safeParse(m);
  if (!parsed.success) fail.push(`${name} fails the schema: ${JSON.stringify(parsed.error.issues)}`);
  if (!m.purpose) fail.push(`${name} declares no purpose`);
  if (m.standalone) fail.push(`${name} still declares standalone`);

  // Every shipped skill is declared, somewhere.
  const shipped = existsSync(join(dir, "skills")) ? readdirSync(join(dir, "skills")) : [];
  const declared = new Set([
    m.entry, ...Object.values(m.commands || {}), ...(m.libraries || []),
    ...(m.stages || []).map((s: { name: string }) => s.name),
  ].filter(Boolean));
  const undeclared = shipped.filter((s) => !declared.has(s));
  if (undeclared.length) fail.push(`${name} ships undeclared skills: ${undeclared.join(", ")}`);

  // DELIBERATE: no hand-written `produces` loop here. `CatalogManifest.safeParse` above is
  // the same rule applied by the contract that defines it — `produces` is required on
  // FlowStage. The generic form, over every flow, is scripts/gate/checks/stage-produces.ts.
}
// Control: zz-core must declare no documents, or it has been wrongly made a flow.
//
// DELIBERATE: the read is guarded because the file may not be there. Unguarded, a missing
// manifest dies on an ENOENT stack trace before the `zz-core has no catalog entry` line
// below can print.
const CORE = "catalog/zz/zz-core/flow.json";
const core = existsSync(CORE) ? JSON.parse(readFileSync(CORE, "utf8")) : {};
if ((core.documents || []).length) fail.push("zz-core declares documents; it is not a flow");

// The baseline plugin is zz-core at every site, not just in the manifest: no plugin is named
// zz, so the old name anywhere points at nothing. The sites are build output, a lock file,
// source files and prose.
if (existsSync("marketplace/zz")) fail.push("marketplace/zz still exists; it is marketplace/zz-core now");
if (!existsSync(CORE)) fail.push("zz-core has no catalog entry");
const lock = JSON.parse(readFileSync("plugins.lock.json", "utf8"));
if (lock.zz) fail.push("plugins.lock.json still keys the baseline as zz");
if (!lock["zz-core"]) fail.push("plugins.lock.json has no zz-core key");
const NAME_SITES: [string, RegExp][] = [
  ["services/gateway/src/client-package.ts", /name:\s*"zz"/],
  ["services/gateway/src/package/skills.ts", /\(\s*"zz"\s*,/],
  ["services/gateway/src/package/plugin-lock.ts", /name:\s*"zz"|"zz"\s*\)/],
  ["services/gateway/src/console/catalog.ts", /plugin:\s*"zz"/],
];
for (const [f, pat] of NAME_SITES) {
  if (pat.test(readFileSync(f, "utf8"))) fail.push(`${f} still names the baseline plugin "zz"`);
}
// The command prefix in prose too — a `/zz:` command in a skill is one no client can run.
for (const dir of ["skills", "catalog", "marketplace"]) {
  if (!existsSync(dir)) continue;
  for (const p of walk(dir)) {
    if (!/\.md$/.test(p)) continue;
    if (/\/zz:[a-z]/.test(readFileSync(p, "utf8"))) fail.push(`${p} still uses the /zz: command prefix`);
  }
}
// Control: the Postgres schema keeps the name zz.
if (!/schema|"zz"/.test(readFileSync("services/gateway/src/db.ts", "utf8"))) {
  fail.push("the Postgres schema name zz was renamed; it must not change");
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("manifests conform: ok");
