/**
 * A flow's manifest: that it parses, that it names things that exist, and that it is read
 * through one reader wherever it is read.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { consoleSource, firstOf, root, sourceFiles, unbuilt, withoutComments, zzCoreSource } from "../read.ts";
import { check } from "../run.ts";
import { BASELINE, NAMING, catalogPackages, flows, skillsDirOf } from "../facts.ts";

/** A caught value is never typed as an Error — narrow the shape actually being read rather
 *  than assume it. `unknown?.message` narrows to `{}`, which has no properties at all. */
function errMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as Record<string, unknown>).message;
    if (m !== undefined && m !== null) return String(m);
  }
  return String(err);
}

check("every flow.json parses, and its entry names a skill it ships", () => {
  const bad: string[] = [];
  for (const f of flows) {
    let m;
    try {
      m = JSON.parse(readFileSync(join(f.dir, "flow.json"), "utf8"));
    } catch (err) {
      bad.push(`${f.flow}: unparseable (${errMessage(err)})`);
      continue;
    }
    if (m.name !== f.flow) bad.push(`${f.flow}: name is "${m.name}"`);
    // `entry` names the skill a reader starts from, so it has to be one. A package with no
    // skills is not required to name one.
    //
    // skillsDirOf, not join(f.dir, "skills"): the baseline's manifest is in the catalog and its
    // skills are not, so reading the entry's own directory would report every command zz-core
    // declares as naming a skill nobody ships.
    const skillsDir = skillsDirOf(f);
    const entrySkills = existsSync(skillsDir)
      ? readdirSync(skillsDir).filter((s) => existsSync(join(skillsDir, s, "SKILL.md")))
      : [];
    // The baseline is exempt from this half only. Its front door `zz-router` is generated per
    // person from the flows they installed — client-package.ts builds it into the package and it
    // is on nobody's disk — so there is no shipped skill for `entry` to name. The skills it does
    // ship are held to every other rule below.
    if (!m.entry && entrySkills.length && f.flow !== BASELINE) {
      bad.push(`${f.flow}: ships skills and declares no entry`);
    }
    // Every skill a manifest names, not just the entry. Nothing else verifies that a stage's
    // skill exists.
    for (const [field, names] of [["stages", (m.stages ?? []).map((x: { name: string }) => x.name)],
                                  ["commands", Object.values(m.commands ?? {}) as string[]]] as [string, string[]][]) {
      for (const n of new Set(names ?? [])) {
        if (!entrySkills.includes(n)) {
          bad.push(`${f.flow}: ${field} names '${n}' and no such skill is shipped`);
        }
      }
    }
    if (m.entry && !entrySkills.includes(m.entry)) {
      bad.push(`${f.flow}: entry is "${m.entry}" and no such skill is shipped` +
               (entrySkills.length ? ` (has: ${entrySkills.join(", ")})` : " (it ships none)"));
    }
    // `commands` is the field; `standalone` is refused with a pointer to it. The strict schema
    // already refuses it, but zod says `Unrecognized key(s): 'standalone'` without saying what to
    // write instead, and the schema is published as JSON at /schemas/manifest.json.
    if ("standalone" in m) {
      bad.push(`${f.flow}: declares 'standalone'; it is replaced by 'commands', a map from ` +
               "the name a person types to the skill that carries the method");
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("no two flows collapse to the same command namespace", () => {
  // A command is `/<plugin>:<file>`, and the plugin name is the flow's name with a trailing
  // `-flow` removed — `/sdlc:flow`, not `/sdlc-flow:sdlc-flow`. That derivation can map two
  // flows onto one name, and one plugin then shadows the other in a person's marketplace with
  // no error. COUPLED: the rule itself is `pluginName` in client-package.ts; this checks that it
  // stays injective across the catalog.
  if (NAMING.error || !NAMING.pluginName) return NAMING.error ?? "NAMING has no pluginName";
  const shortOf = NAMING.pluginName;
  // Not pre-seeded with the baseline. The baseline has a catalog entry (`catalog/zz/zz-core/`),
  // so reserving its name here would report the plugin against itself. The loop below still
  // refuses any two packages that collapse to one name, and the baseline is one of the two.
  const seen = new Map();
  const clashes = [];
  for (const f of flows) {
    const manifest = join(f.dir, "flow.json");
    const name = JSON.parse(readFileSync(manifest, "utf8")).name ?? f.flow;
    const short = shortOf(name);
    if (seen.has(short)) clashes.push(`${seen.get(short)} and ${name} both become "${short}"`);
    else seen.set(short, name);
  }
  return clashes.length ? clashes.join("; ") : null;
});

check("every catalog entry has a flow.json and declares what it is", () => {
  // One manifest name, one rule: a manifest filed under some other name is invisible to every
  // reader. A skills-only package with no manifest at all is supported — catalogSkillRoots
  // serves a package owned by the caller's own team whether or not any flow is installed — so
  // "content and no manifest" is not the rule.
  const bad = [];
  // Every package, because the subject is a package with no manifest. Iterating `flows` here
  // would have been looking only at the ones that already have one.
  for (const f of catalogPackages) {
    const dir = f.dir;
    const manifest = join(dir, "flow.json");
    if (!f.hasManifest) {
      // A stray .json is a suspected misnamed manifest, not any JSON at all: a manifest declares
      // a `name`, and a JSON file that declares none is content. Reading the file rather than
      // its extension is what tells them apart.
      const strays = readdirSync(dir).filter((f) => {
        if (!f.endsWith(".json")) return false;
        try {
          return typeof JSON.parse(readFileSync(join(dir, f), "utf8")).name === "string";
        } catch { return false; }
      });
      if (strays.length) {
        bad.push(`${f.owner}/${f.flow} carries ${strays.join(", ")} and no flow.json — ` +
                 "every reader looks for flow.json, so this package is invisible");
      }
      continue;   // skills-only, which is a package kind, not a mistake
    }
    const m = JSON.parse(readFileSync(manifest, "utf8"));
    if ("shelved" in m && m.shelved !== true) bad.push(`${f.owner}/${f.flow}: shelved must be true or absent`);
    // A shelved entry is shipped by the shelf, so it needs a description to show on the
    // card; a flow gets one from cardDescription and may fall back.
    if (m.shelved && !m.description) bad.push(`${f.owner}/${f.flow}: shelved entry with no description`);
    for (const sv of m.servers ?? []) {
      if (!sv.name || !sv.path?.startsWith("/")) bad.push(`${f.owner}/${f.flow}: server needs name and an absolute path`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("a package declares whether it is a flow, and the console reads the declaration", () => {
  // A package is a flow if and only if it declares `documents` (ARCHITECTURE.md). `stages` does
  // not discriminate — every package whose agent opens a skill has steps.
  //
  // `documents` and `stages` travel together in one direction only: declaring documents obliges
  // a `stages`, because a flow's documents have to be produced by something. Stages with no
  // documents is an ordinary non-flow package. `entry` and `stages` do not travel together at
  // all; an entry and zero stages is a supported shape.
  const bad = [];
  for (const f of flows) {
    const manifest = join(f.dir, "flow.json");
    if (!existsSync(manifest)) continue;
    const m = JSON.parse(readFileSync(manifest, "utf8"));
    const stages = (m.stages ?? []).length;
    const documents = (m.documents ?? []).length;
    if (documents && !stages) {
      bad.push(`${f.owner}/${f.flow} declares ${documents} document(s) and no stages — a ` +
               "document has to be produced by something, and `stages` is what produces it");
    }
    if (stages && !m.entry) {
      bad.push(`${f.owner}/${f.flow} declares ${stages} stage(s) and no entry — a package ` +
               "with a method needs a door: the skill its agent opens first");
    }
    // A single stage whose name is the entry skill, producing nothing, is not a method. Named
    // here so it cannot come back under another name.
    if (!documents && stages === 1 && m.stages[0].name === m.entry) {
      bad.push(`${f.owner}/${f.flow} declares one stage repeating its entry "${m.entry}" and ` +
               "no documents — that is not a method, it is a placeholder; delete it");
    }
  }
  // And the console must read that declaration rather than reconstruct it: it carries both
  // `documents`, which says what the package is, and `stages`, which says how it gets there, and
  // it never decides what a package is from `entry`. There is no filter to check — the console
  // lists plugins, and every catalog package is one whether or not it declares a method.
  const consoleSrc = consoleSource();
  for (const field of ["documents", "stages"]) {
    if (!new RegExp(`manifest\\.${field}`).test(consoleSrc)) {
      bad.push(`the console no longer reads manifest.${field} — a console that does not read ` +
               "a package's own declarations is back to guessing shape from contents");
    }
  }
  for (const m of consoleSrc.matchAll(/\.filter\(\([^)]*\) => ([^\n]*)\)/g)) {
    if (/manifest\.entry/.test(m[1])) {
      bad.push("the console decides what a package is from `entry` — that is inference. " +
               "`documents` is the declaration and the only one.");
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("a flow.json is validated wherever it is read", () => {
  // A manifest decides which documents gate, in what order, and therefore which writes the
  // platform refuses. Several places read one, and a cast instead of a parse lets `gate: "false"`
  // through as a truthy string — a document declared not to be a gate becomes one.
  //
  // COUPLED: @zz/contracts holds the schema. Anywhere a flow.json is parsed, that must parse it.
  const bad: string[] = [];
  for (const f of sourceFiles(["services", "packages", "scripts"], [".ts"])) {
    if (f.startsWith("packages/catalog/")) continue;   // the reader every other caller uses
    const src = readFileSync(join(root, f), "utf8");
    src.split("\n").forEach((ln, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(ln)) return;
      if (!/flow\.json|manifestPath|\bmanifest\b/.test(ln)) return;
      if (!/JSON\.parse\(/.test(ln)) return;
      // Parsed and then asserted, rather than validated.
      if (/\bas\s+\{|\bas\s+CatalogManifest\b|\bas\s+FlowManifest\b/.test(ln)) {
        bad.push(`${f}:${i + 1} casts a manifest instead of parsing it with CatalogManifest`);
      }
    });
  }
  return bad.length
    ? `${firstOf(bad)} — \`gate: "false"\` is a truthy string, so a cast turns "not a gate" into a gate`
    : null;
});

check("a stray file in the catalog cannot empty it", () => {
  const nothingToRun = unbuilt();
  if (nothingToRun) return nothingToRun;
  // The catalog's two levels are walked once, through @zz/catalog, which tolerates a file where
  // an owner directory was expected. A single try around both levels does not: a stray file
  // throws ENOTDIR, the catch returns whatever had accumulated, and `.DS_Store` sorts first, so
  // what comes back is nothing at all — no platform skills, no stage skills, no team overlays.
  // This runs the walk over a catalog containing exactly that stray file.
  const bad = [];
  for (const rel of sourceFiles(["services", "packages"], [".ts"])) {
    if (rel === join("packages", "catalog", "src", "index.ts")) continue;
    readFileSync(join(root, rel), "utf8").split("\n").forEach((ln, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(ln)) return;
      if (/readdirSync\([^)]*CATALOG_DIR/.test(ln)) {
        bad.push(`${rel}:${i + 1} walks the catalog itself — catalogPackages() is that walk, ` +
                 "and a second one is a second answer to what a stray file means");
      }
    });
  }
  const core = withoutComments(zzCoreSource());
  if (!/catalogPackages\(\)/.test(core)) {
    bad.push("zz-core no longer asks @zz/catalog which packages exist — its skill roots are " +
             "the one reader that must see a package with no flow.json");
  }
  // A catalog with a stray file at its root, a package that ships a manifest, and one that
  // ships only skills — which is a package kind the platform supports.
  const dir = join(root, "node_modules", ".zz-catalog-probe");
  // Cleared first, because `mkdir -p` adds and never removes. The probe's expected answer is an
  // exact package list, so a package left behind by a previous run fails this check with a ghost
  // that is in no source file, under node_modules where nobody looks.
  rmSync(dir, { recursive: true, force: true });
  for (const p of [join(dir, "zz", "zz-handover"), join(dir, "ops", "ops-flow", "skills")]) {
    execFileSync("mkdir", ["-p", p]);
  }
  writeFileSync(join(dir, ".DS_Store"), "");
  writeFileSync(join(dir, "zz", "zz-handover", "flow.json"), JSON.stringify({ name: "zz-handover" }));
  const probe = `
    import { catalogPackages, catalogEntries } from ${JSON.stringify(join(root, "packages/catalog/dist/index.js"))};
    const names = catalogPackages().map((p) => p.owner + "/" + p.name).sort();
    const entries = catalogEntries().map((e) => e.flow).sort();
    process.stdout.write(JSON.stringify({ names, entries }));
  `;
  let got;
  try {
    got = JSON.parse(execFileSync("node", ["--input-type=module", "-e", probe],
      { encoding: "utf8", env: { ...process.env, ZZ_CATALOG_DIR: dir } }));
  } catch (err) {
    const stderr = err && typeof err === "object" ? (err as Record<string, unknown>).stderr : undefined;
    return `the catalog walk could not be run: ${String(stderr ?? err).slice(-200)}`;
  }
  if (got.names.join(",") !== "ops/ops-flow,zz/zz-handover") {
    bad.push(`a stray file at the catalog root left ${JSON.stringify(got.names)} — every ` +
             "package after it in sort order is gone, and skill_read would find nothing");
  }
  // And the narrower question must still be the narrower one: only the package with a
  // manifest is an entry, and the skills-only package is a package all the same.
  if (got.entries.join(",") !== "zz-handover") {
    bad.push(`catalogEntries returned ${JSON.stringify(got.entries)} — it is keyed on the ` +
             "manifest, and a skills-only package is not one");
  }
  return bad.length ? bad.join("; ") : null;
});

check("a flow's manifest is read through one reader", () => {
  // @zz/catalog's manifestAt exists because reading a flow.json is three decisions, not one:
  // does the file exist, is it JSON, and does it satisfy the schema the platform enforces. A
  // reader that answers them differently audits a store against rules nothing enforces, and
  // reports an invalid manifest as a missing one.
  const bad = [];
  const READER = join("packages", "catalog", "src", "index.ts");
  for (const rel of sourceFiles(["packages", "services"], [".ts"])) {
    if (rel === READER) continue;                       // the reader itself
    // DELIBERATE: withoutComments, not codeOnly. Half of what this looks for is a string literal
    // — the path to the file — so blanking strings makes the second arm below match nothing in
    // the repository and pass on every file.
    const code = withoutComments(readFileSync(join(root, rel), "utf8"));
    // The schema belongs to @zz/contracts and the reader is the only thing that runs it over a
    // file. Anywhere else, a manifest is being validated a second way.
    for (const m of code.matchAll(/CatalogManifest\.(safe)?[Pp]arse\(/g)) {
      const line = code.slice(0, m.index).split("\n").length;
      bad.push(`${rel}:${line} runs the manifest schema itself — @zz/catalog's manifestAt is ` +
               "the one reader, and it answers 'missing', 'not JSON' and 'not a manifest' as " +
               "three different sentences rather than one catch");
    }
    // And a file that reads the manifest file has to reach it through the catalog package. The
    // mention has to be part of a path being built or a file being read, not any occurrence of
    // the name: zz-core's flow guard names `catalog/<owner>/<flow>/flow.json` inside a refusal
    // that tells an admin which file to check, which is prose and not a second reader.
    const READS = /(?:readFileSync|existsSync|statSync|readdirSync|join)\s*\([^)]*["'`][^"'`]*flow\.json/;
    if (!READS.test(code)) continue;
    if (/\bmanifestAt\b|\bcatalogManifest\b|\bcatalogEntr(y|ies)\b/.test(code)) continue;
    bad.push(`${rel} builds a path to a flow.json and reads it without @zz/catalog — one file, ` +
             "one reader, or the audit and the platform disagree about what a manifest is");
  }
  return bad.join("\n");
});

check("plugins.lock.json says what the catalog ships, on both version and digest", () => {
  // A plugin's version is the platform's release version, so content can move under it between
  // releases with nothing to notice. The lock hash is what makes the version true — skill-shape.ts's
  // lock check one level up, applied to plugins.
  //
  // COUPLED: pluginLock() is the same function plugin-versions.ts calls and the same enumeration
  // the packager ships from. Run in a subprocess because it reads two directories that are
  // absolute in the image and relative here.
  const lockPath = join(root, "plugins.lock.json");
  if (!existsSync(lockPath)) {
    return "plugins.lock.json does not exist — run `node scripts/plugin-versions.ts --write`";
  }
  const probe = `
    const { pluginLock } = await import(${JSON.stringify(join(root, "services/gateway/dist/package/plugin-lock.js"))});
    process.stdout.write(JSON.stringify(pluginLock(${JSON.stringify(root)})));
  `;
  let live;
  try {
    live = JSON.parse(execFileSync("node", ["--input-type=module", "-e", probe], {
      encoding: "utf8",
      env: { ...process.env,
             ZZ_CATALOG_DIR: join(root, "catalog"),
             ZZ_SKILLS_DIR: join(root, "skills") },
    }));
  } catch (err) {
    const stderr = err && typeof err === "object" ? (err as Record<string, unknown>).stderr : undefined;
    return `the plugin enumeration could not be run: ${String(stderr ?? err).slice(-300)}`;
  }
  // An empty enumeration must fail, not pass. A wrong directory finds nothing, and nothing
  // agrees with nothing — a green tick over a lock that vouches for no plugin at all.
  if (!live.length) return "the plugin enumeration returned nothing — the extraction is broken";

  const recorded = JSON.parse(readFileSync(lockPath, "utf8"));
  const bad: string[] = [];
  for (const p of live) {
    const was = recorded[p.name];
    if (!was) {
      bad.push(`${p.name} ships and plugins.lock.json has never heard of it — run ` +
               "`node scripts/plugin-versions.ts --write`");
      continue;
    }
    if (was.version === p.version && was.digest !== p.digest) {
      bad.push(`${p.name} still declares ${p.version} and its content moved ` +
               `(${was.digest} -> ${p.digest}) — bump the version in its flow.json, or re-run ` +
               "`node scripts/plugin-versions.ts --write` if the change is deliberate");
    } else if (was.version !== p.version) {
      // The branch above reads "content moved and the version did not", so a version moving
      // collapses the conjunction and a lock a whole release out of date passes silently.
      //
      // plugins.lock.json is an input, not a record: release.ts registers zz.plugin_version from
      // it and never regenerates it, so a stale lock writes the previous release's plugin
      // versions into the database and nothing downstream can say which version anything
      // belonged to.
      bad.push(`plugins.lock.json records ${p.name} at ${was.version} and the catalog now ` +
               `declares ${p.version} — run \`node scripts/plugin-versions.ts --write\`. The ` +
               "release registers zz.plugin_version FROM this file and never regenerates it, " +
               "so a stale entry here registers the previous release's version.");
    }
  }
  for (const name of Object.keys(recorded)) {
    if (!live.some((p: { name: string }) => p.name === name)) {
      bad.push(`plugins.lock.json still lists ${name}, which the catalog no longer ships — ` +
               "re-run `node scripts/plugin-versions.ts --write`");
    }
  }
  return bad.length ? firstOf(bad) : null;
});

check("a plugin's recorded membership is the one it ships", () => {
  // Which skill versions were in this plugin version. zz.skill_version has no plugin column and
  // zz.skill.flow is current registration rather than per-version, so release is the only moment
  // anybody knows. This refuses a lock whose membership has drifted from the catalog: a wrong
  // membership is worse than a missing one, because the profile resolves events through it and
  // reports the result as fact.
  const lockPath = join(root, "plugins.lock.json");
  if (!existsSync(lockPath)) return null;   // the check above already says this
  const recorded = JSON.parse(readFileSync(lockPath, "utf8"));
  const bad = [];
  for (const [plugin, entry] of Object.entries(recorded) as [string, { skills?: Record<string, unknown> }][]) {
    // catalogPackages is an array of {owner, flow, dir} with dir already absolute, so the plugin
    // name is its flow with the -flow suffix off, the rule pluginName() applies everywhere else.
    const dirs = plugin === BASELINE
      ? [join(root, "skills")]
      : catalogPackages.filter((e) => e.flow.replace(/-flow$/, "") === plugin)
                       .map((e) => join(e.dir, "skills"));
    if (!dirs.length || !dirs.some((d) => existsSync(d))) continue;
    const onDisk = new Set(dirs.flatMap((d) => existsSync(d)
      ? readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
      : []));
    const inLock = new Set(Object.keys(entry.skills ?? {}));
    for (const name of onDisk) {
      if (!inLock.has(name)) bad.push(`${plugin} ships skill ${name} and the lock does not record it`);
    }
    for (const name of inLock) {
      if (!onDisk.has(name)) bad.push(`the lock says ${plugin} contains ${name}, which it does not ship`);
    }
  }
  return bad.length
    ? `${firstOf(bad)} — re-run \`node scripts/plugin-versions.ts --write\``
    : null;
});
