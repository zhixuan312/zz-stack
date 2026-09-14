// Each case is discovered once, and the manifest says from where.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
const fail = [];

const cases = [];
const walk = (d) => readdirSync(d).forEach((f) => {
  const p = join(d, f);
  if (statSync(p).isDirectory()) walk(p);
  else if (f === "case.yaml") cases.push(p);
});
for (const t of ["catalog", "marketplace"]) if (existsSync(t)) walk(t);

// The duplication exists on disk by construction; what must not happen is discovering both.
const byName = new Map();
for (const p of cases) {
  const n = basename(dirname(p));
  byName.set(n, [...(byName.get(n) || []), p]);
}
const dupes = [...byName].filter(([, ps]) => ps.length > 1);

// Every plugin declares its suite location.
const manifests = [];
const mwalk = (d) => readdirSync(d).forEach((f) => {
  const p = join(d, f);
  if (statSync(p).isDirectory()) mwalk(p);
  else if (f === "flow.json") manifests.push(p);
});
mwalk("catalog");
for (const p of manifests) {
  const m = JSON.parse(readFileSync(p, "utf8"));
  if (!m.evals) { fail.push(`${p} does not declare where its eval suite lives`); continue; }
  if (!existsSync(join(dirname(p), m.evals))) fail.push(`${p} declares evals: ${m.evals}, which does not exist`);
}
// The sweep reads the declared tree only. A duplicate on disk is fine; discovering both is not.
const discovered = manifests.flatMap((p) => {
  const m = JSON.parse(readFileSync(p, "utf8"));
  const d = join(dirname(p), m.evals || "evals");
  return existsSync(d) ? readdirSync(d) : [];
});
if (new Set(discovered).size !== discovered.length) {
  fail.push(`the declared sweep discovers ${discovered.length} cases with only ${new Set(discovered).size} distinct`);
}
// Control: the marketplace mirror must STILL exist. It travels with an installed plugin.
if (dupes.length === 0) fail.push("no case exists in both trees; the marketplace mirror was deleted");

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log(`eval suite: ok (${discovered.length} cases, ${dupes.length} mirrored on disk as expected)`);
