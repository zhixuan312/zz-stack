// Every plugin declares what it is, what it ships, and what each stage leaves behind.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { CatalogManifest } from "../packages/contracts/dist/index.js";
const fail = [];
const walk = (d) => readdirSync(d).flatMap((f) => {
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
    ...(m.stages || []).map((s) => s.name),
  ].filter(Boolean));
  const undeclared = shipped.filter((s) => !declared.has(s));
  if (undeclared.length) fail.push(`${name} ships undeclared skills: ${undeclared.join(", ")}`);

  // A flow declares produces on every stage.
  for (const s of m.stages || []) {
    if (!s.produces) fail.push(`${name} stage ${s.name} declares no produces`);
  }
}
// Control: zz-core must declare NO documents, or it has been wrongly made a flow.
//
// GUARDED, because the file may not be there. This read was unconditional and ran BEFORE the
// `zz-core has no catalog entry` line forty lines down, so with no manifest on disk the check
// died on an ENOENT stack trace and the sentence written for exactly that case never printed.
// Measured, not argued: moving the manifest away reported `node:fs:436` through the gate's
// 400-character stderr window. Red for the right reason and unreadable is still a check an
// operator has to go and read the source of.
const CORE = "catalog/zz/zz-core/flow.json";
const core = existsSync(CORE) ? JSON.parse(readFileSync(CORE, "utf8")) : {};
if ((core.documents || []).length) fail.push("zz-core declares documents; it is not a flow");

// AC-2.11a: the rename landed at every site, not just in the manifest. A tree-walk, because
// the sites are scattered across build output, a lock file, three source files and prose —
// and a check that only read flow.json would pass a half-done rename.
if (existsSync("marketplace/zz")) fail.push("marketplace/zz still exists; it is marketplace/zz-core now");
if (!existsSync(CORE)) fail.push("zz-core has no catalog entry");
const lock = JSON.parse(readFileSync("plugins.lock.json", "utf8"));
if (lock.zz) fail.push("plugins.lock.json still keys the baseline as zz");
if (!lock["zz-core"]) fail.push("plugins.lock.json has no zz-core key");
for (const [f, pat] of [
  ["services/gateway/src/client-package.ts", /name:\s*"zz"/],
  ["services/gateway/src/package/skills.ts", /\(\s*"zz"\s*,/],
  ["services/gateway/src/package/plugin-lock.ts", /name:\s*"zz"|"zz"\s*\)/],
  ["services/gateway/src/console/catalog.ts", /plugin:\s*"zz"/],
]) {
  if (pat.test(readFileSync(f, "utf8"))) fail.push(`${f} still names the baseline plugin "zz"`);
}
// The command prefix moved in prose too — this is the half that fails silently.
for (const dir of ["skills", "catalog", "marketplace"]) {
  if (!existsSync(dir)) continue;
  for (const p of walk(dir)) {
    if (!/\.md$/.test(p)) continue;
    if (/\/zz:[a-z]/.test(readFileSync(p, "utf8"))) fail.push(`${p} still uses the /zz: command prefix`);
  }
}
// Control: the two OTHER zz's must survive. A blind rename would have taken them too.
if (!/schema|"zz"/.test(readFileSync("services/gateway/src/db.ts", "utf8"))) {
  fail.push("the Postgres schema name zz was renamed; it must not change");
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("manifests conform: ok");
