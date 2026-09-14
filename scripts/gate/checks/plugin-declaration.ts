/**
 * What a plugin SAYS it ships, against what is in its skills directory — in both directions.
 *
 * WHY THIS IS COMPUTED AND NOT ASSERTED. `plugin_profile` reports a plugin's fit as
 * `named_not_exposed` and `exposed_not_named`, and that pair is the one description in this
 * repository that has never drifted, precisely because nobody maintains it — it is a set
 * difference taken at read time. This is that difference, moved one layer down onto the
 * manifest, and taken both ways: a package that ships something its manifest never names, and
 * a manifest that names something the package does not carry.
 *
 * WHAT WAS ACTUALLY UNCOVERED BEFORE IT. Three rules already touched parts of this and none of
 * them closed it:
 *   - `catalog-manifest.mjs` asks whether `entry`, `commands` and `stages` name something
 *     shipped. That is one direction, and it never reads `libraries` — so a library named in a
 *     manifest and absent from disk was nobody's business.
 *   - `checks/manifests-conform.mjs` asks the other direction, from a hardcoded list of four
 *     packages, and reads `<package>/skills` for each. The baseline keeps its skills BESIDE the
 *     catalog rather than inside it, so that read finds no directory, reports an empty set, and
 *     has been silently exempting the baseline's whole tree from the rule it exists to enforce.
 *     An empty listing and a compliant package are indistinguishable to it.
 *   - Nothing asked about `purpose` outside that same hardcoded list.
 * This walks `flows` and resolves each package's tree through `skillsDirOf`, which is where the
 * baseline's exemption came from and is therefore where it stops.
 *
 * SHIPPED MEANS A DIRECTORY WITH A SKILL.md IN IT, which is how every other rule here and the
 * packager itself decide the question. A declared name whose directory exists but carries no
 * SKILL.md therefore reads as declared-and-not-shipped, which is the honest reading: nothing
 * installs out of an empty directory.
 *
 * EVERY OFFENDER IN ONE RUN. Failing on the first one makes an executor fix them one at a time
 * and pay for a whole gate run between each, so both differences are accumulated across every
 * package and reported together.
 *
 * IT HARD-FAILS FROM ITS FIRST RELEASE. There is no warn-only phase and none is coming: a
 * promised later flip to blocking is the documented way a standard in this repository becomes
 * decoration.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { type CatalogPackage, flows, skillsDirOf } from "../facts.ts";
import { check } from "../run.ts";

/** Every manifest, parsed once, carrying its parse failure instead of throwing it.
 *
 *  A throw out of one package would end the run at that package and hide every other
 *  package's findings, which is the behaviour this module exists to avoid. */
function manifests() {
  return flows.map((f) => {
    try {
      return { f, m: JSON.parse(readFileSync(join(f.dir, "flow.json"), "utf8")), err: null };
    } catch (err) {
      return { f, m: null, err: err instanceof Error ? err.message : String(err) };
    }
  });
}

/** What a manifest claims as its own: the entry, whatever the commands point at, the
 *  libraries, and the name of every stage. Four fields, because those are the four a package
 *  can name a skill in, and a fifth would need adding here the day the standard grows one. */
function declaredSkills(m: {
  entry?: string;
  commands?: Record<string, string>;
  libraries?: string[];
  stages?: { name?: string }[];
}) {
  return new Set([
    m.entry,
    ...Object.values(m.commands ?? {}),
    ...(m.libraries ?? []),
    ...(m.stages ?? []).map((s) => s?.name),
  ].filter((n): n is string => typeof n === "string" && Boolean(n.trim())));
}

/** What a package actually carries, from the tree the packager reads. */
function shippedSkills(f: CatalogPackage) {
  const dir = skillsDirOf(f);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "SKILL.md")))
    .map((e) => e.name)
    .sort();
}

check("a plugin declares every skill it ships, and ships every skill it declares", () => {
  const all = manifests();
  if (!all.length) return "no catalog manifests were found — this cannot verify anything";
  const bad = [];
  let read = 0;
  for (const { f, m, err } of all) {
    if (err) {
      bad.push(`${f.flow}: flow.json does not parse (${err}), so nothing it declares can be read`);
      continue;
    }
    const declared = declaredSkills(m);
    const shipped = shippedSkills(f);
    read += declared.size + shipped.length;
    for (const name of shipped.filter((s) => !declared.has(s))) {
      bad.push(`${f.flow} ships ${name} and its manifest names it nowhere — add it to entry, ` +
               "commands, libraries or stages, or stop shipping it");
    }
    for (const name of [...declared].sort().filter((s) => !shipped.includes(s))) {
      bad.push(`${f.flow} declares ${name} and ships no such skill — ` +
               `${join(skillsDirOf(f), name)}/SKILL.md is not there`);
    }
  }
  // A manifest that declares nothing over a tree that carries nothing is not a pass; it is
  // this rule reading an empty repository and reporting silence as compliance.
  if (!read) return "nothing was named on either side — this cannot verify anything";
  return bad.length ? bad.join("\n      ") : null;
});

check("a plugin manifest says what the plugin is for", () => {
  // `description` is what a reader sees in a listing; `purpose` is the sentence that decides
  // whether a capability belongs in THIS package or the next one. A package with no purpose
  // accretes whatever was convenient, and there is then no written thing to argue against.
  const all = manifests();
  if (!all.length) return "no catalog manifests were found — this cannot verify anything";
  const bad = [];
  for (const { f, m, err } of all) {
    if (err) {
      bad.push(`${f.flow}: flow.json does not parse (${err})`);
      continue;
    }
    if (typeof m.purpose !== "string" || !m.purpose.trim()) {
      bad.push(`${f.flow} declares no purpose — the manifest says what the package is called ` +
               "and not what belongs in it");
    }
  }
  return bad.length ? bad.join("\n      ") : null;
});
