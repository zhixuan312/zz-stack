// Each case is discovered once, and the manifest says from where.
//
// THE DUPLICATION IS ON DISK ON PURPOSE AND IS NOT THE DEFECT. `build-marketplace.ts:89`
// opens by deleting `marketplace/` and regenerating it from `catalog/`, so every case exists
// twice by construction, and the copy has to keep travelling: `client-package.ts:203-216` says
// `claude plugin eval` resolves an installed plugin to its cache directory and looks for
// `evals/` below it, and a run that finds none "silently becomes a baseline-only one with no
// comparison in it at all". Delete the mirror and every installed-plugin run stops measuring
// anything while still producing a number. Hence the mirror CONTROL at the bottom — this check
// must be impossible to satisfy by deleting the copy.
//
// The defect is a sweep that reads both trees. Measured 2026-09-13: the run targeted the
// repository root, resolved all four plugins at once, and discovered
// `audit-catches-an-unverified-claim` twice — once under each tree — so three runs of one case
// were paid for twice, all six failing. A walk of a checkout cannot tell a source from its own
// build output. A manifest that names its authored suite can, which is what `evals` is for.
//
// WHAT CHANGED AGAINST THE PLAN'S DRAFT OF THIS CHECK, and why each change is a tightening:
//   - `discovered` was `readdirSync(dir)`, which counts every entry, not every case. The
//     baseline's suite lives at the repository root beside `evals/results/`, so that spelling
//     reported twelve cases where there are eleven — a check whose own count is wrong is a
//     check nobody can quote. It reads the directories that actually hold a `case.yaml` now.
//   - A declaration pointing INTO `marketplace/` would have satisfied the draft exactly while
//     naming the build output as the source. That is the one mistake this task exists to stop.
//   - Uniqueness alone is satisfiable by declaring any existing directory, including an empty
//     one: eleven cases discovered as zero is "no duplicates". So the declared suites and the
//     authored cases are compared BOTH WAYS — nothing authored goes undiscovered, and nothing
//     is discovered that is not authored.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename, dirname, relative } from "node:path";
const fail: string[] = [];

/** Every directory below `root` that holds a `case.yaml` — the case itself, not its parent. */
const caseDirs = (root: string): string[] => {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      if (f.isDirectory()) walk(join(d, f.name));
      else if (f.name === "case.yaml") out.push(d);
    }
  };
  walk(root);
  return out;
};

// The two AUTHORED trees. `catalog/` holds the three catalog-resident packages; the repository
// root's `evals/` is the baseline's, because zz-core ships no file from `catalog/zz/zz-core/` —
// `platformOwnEvals()` walks ZZ_EVALS_DIR and `baselineFiles()` walks ZZ_SKILLS_DIR, both of
// which are this repository's root. `skill-homes.ts` carries the same exception for skills.
const authored = ["catalog", "evals"].flatMap(caseDirs);
const mirrored = caseDirs("marketplace");

// Every plugin declares its suite location, and it is a real directory in an authored tree.
const manifests: string[] = [];
const mwalk = (d: string) => {
  for (const f of readdirSync(d, { withFileTypes: true })) {
    if (f.isDirectory()) mwalk(join(d, f.name));
    else if (f.name === "flow.json") manifests.push(join(d, f.name));
  }
};
mwalk("catalog");

const suites = [];
for (const p of manifests) {
  const m = JSON.parse(readFileSync(p, "utf8"));
  if (!m.evals) { fail.push(`${p} does not declare where its eval suite lives`); continue; }
  const dir = join(dirname(p), m.evals);
  if (!existsSync(dir)) { fail.push(`${p} declares evals: ${m.evals}, which does not exist`); continue; }
  // `marketplace/` is OUTPUT. A manifest that names it declares the copy as the source, which
  // is the 2026-09-13 defect written into the manifest instead of left to a walk.
  if (!relative("marketplace", dir).startsWith("..")) {
    fail.push(`${p} declares evals: ${m.evals}, which is inside marketplace/ — that tree is ` +
              `regenerated from catalog/ on every build, so it is a copy, never the source`);
    continue;
  }
  suites.push({ manifest: p, dir });
}

// The sweep reads the declared suites and nothing else. A duplicate on disk is fine; a sweep
// that reaches both copies is not.
const discovered = suites.flatMap((s) => caseDirs(s.dir));
const byName = new Map();
for (const d of discovered) byName.set(basename(d), [...(byName.get(basename(d)) || []), d]);
for (const [name, where] of byName) {
  if (where.length > 1) fail.push(`the declared sweep discovers ${name} ${where.length} times: ${where.join(", ")}`);
}

// BOTH DIRECTIONS, because uniqueness on its own is satisfied by discovering nothing.
const found = new Set(discovered);
for (const d of authored) {
  if (!found.has(d)) fail.push(`${d} holds a case no manifest's declared suite reaches — it is ` +
                               `authored and the sweep would never run it`);
}
for (const d of discovered) {
  if (!authored.includes(d)) fail.push(`the declared sweep reaches ${d}, which is in neither authored tree`);
}

// CONTROLS. Each one is a way this check could pass while proving nothing.
if (!manifests.length) fail.push("no flow.json was found under catalog/ — the manifest scan read nothing");
if (!discovered.length) fail.push("the declared suites hold no case at all — every clause above is vacuous");
if (!mirrored.length) {
  fail.push("no case.yaml exists under marketplace/ — the mirror was deleted. It travels with " +
            "an installed plugin; without it `claude plugin eval` finds no suite below the " +
            "plugin's cache directory and reports a baseline-only run with no comparison in it");
} else {
  const mirrorNames = new Set(mirrored.map((d) => basename(d)));
  for (const d of authored) {
    if (!mirrorNames.has(basename(d))) {
      fail.push(`${basename(d)} is authored and has no copy under marketplace/ — the plugin ` +
                `that ships it would install with a suite nobody can run against it`);
    }
  }
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log(`eval suite: ok (${discovered.length} cases declared by ${suites.length} manifests, ` +
            `${mirrored.length} mirrored under marketplace/ as expected)`);
