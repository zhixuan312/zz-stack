/**
 * What a plugin says it ships, against what is in its skills directory — in both directions.
 *
 * A set difference taken at read time, the same shape `plugin_profile` reports as
 * `named_not_exposed` and `exposed_not_named`, moved one layer down onto the manifest: a
 * package that ships something its manifest never names, and a manifest that names something
 * the package does not carry.
 *
 * It walks `flows` and resolves each package's tree through `skillsDirOf`. COUPLED:
 * `catalog-manifest.ts` covers one direction and never reads `libraries`, and
 * `checks/manifests-conform.ts` covers the other from a hardcoded list of four packages,
 * reading `<package>/skills` — which the baseline, whose skills sit beside the catalog, has no
 * directory for.
 *
 * Shipped means a directory with a SKILL.md in it, which is how every other rule here and the
 * packager itself decide the question. A declared name whose directory exists but carries no
 * SKILL.md reads as declared-and-not-shipped: nothing installs out of an empty directory.
 *
 * Both differences are accumulated across every package and reported together, so an executor
 * does not pay for a whole gate run per offender.
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
  // whether a capability belongs in this package or the next one. A package with no purpose
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
