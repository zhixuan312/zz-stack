/**
 * A flow's manifest: that it parses, that it names things that exist, and that it is read
 * through one reader wherever it is read.
 *
 *

 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { codeOnly, consoleSource, firstOf, root, sourceFiles, unbuilt, withoutComments, zzCoreSource } from "../read.mjs";
import { check } from "../run.mjs";
import { NAMING, catalogPackages, flows } from "../facts.mjs";

check("every flow.json parses, and its entry names a skill it ships", () => {
  const bad = [];
  for (const f of flows) {
    let m;
    try {
      m = JSON.parse(readFileSync(join(f.dir, "flow.json"), "utf8"));
    } catch (err) {
      bad.push(`${f.flow}: unparseable (${err.message})`);
      continue;
    }
    if (m.name !== f.flow) bad.push(`${f.flow}: name is "${m.name}"`);
    // `entry` names the skill a reader starts from, so it has to BE one.
    //
    // This required the field and never looked at what it pointed to, and zz-admin
    // therefore declared `entry: "zz-admin"` while shipping no skills directory at all —
    // a manifest naming a document nobody wrote. Nothing broke, because every consumer
    // falls back: whenToUse returns "work that belongs to the zz-admin flow" instead of the
    // skill's own sentence. A field that can point at nothing is a field that eventually
    // does, quietly.
    //
    // A package with no skills is not required to name one. zz-admin was that for a while —
    // MCP wiring and nothing else — and it is why this rule reads the way it does; the
    // package itself has since been folded into zz-access, which ships two skills.
    const entrySkills = existsSync(join(f.dir, "skills"))
      ? readdirSync(join(f.dir, "skills")).filter((s) => existsSync(join(f.dir, "skills", s, "SKILL.md")))
      : [];
    if (!m.entry && entrySkills.length) bad.push(`${f.flow}: ships skills and declares no entry`);
    // EVERY skill a manifest names, not just the entry. sdlc-flow's `stages` listed
    // `sdlc-audit` twice — a skill that has never existed. sdlc-method says why: "There is no
    // generic audit skill", the auditors are sdlc-spec-audit and sdlc-plan-audit, and the
    // manifest kept the name from before that split. Nothing failed: the flow's stages come
    // from the skills an agent loads, and the smoke engine's stage-order check quietly drops
    // any stage it never sees a skill_view for — so a stage naming nothing was a stage
    // nothing verified.
    for (const [field, names] of [["stages", (m.stages ?? []).map((x) => x.name)],
                                  ["standalone", m.standalone]]) {
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
    // `clients` was removed from the manifest on 2026-09-12 with Codex and Hermes. A manifest
    // still carrying it is not harmless: the schema drops unknown keys, so the field would
    // read as an honoured declaration and silently do nothing.
    if ("clients" in m) {
      bad.push(`${f.flow}: declares 'clients', a field this platform no longer reads`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("no two flows collapse to the same command namespace", () => {
  // A command is `/<plugin>:<file>`, and the plugin name is the flow's name with a trailing
  // `-flow` removed — so `/sdlc:flow` rather than `/sdlc-flow:sdlc-flow`. That derivation
  // can map two different flows onto one name: `sdlc-flow` and a flow called plainly `sdlc`
  // both become `sdlc`, and one plugin then silently shadows the other in a person's
  // marketplace, with no error anywhere and no way to tell which one answered.
  //
  // The rule is in client-package.ts (pluginName); this is the check that it stays
  // injective across the catalog it is applied to.
  if (NAMING.error) return NAMING.error;
  const shortOf = NAMING.pluginName;
  // THE BASELINE'S NAME IS TAKEN. buildClientPackage always emits a plugin called `zz` —
  // the router and the platform's own MCP, which everything else needs — and
  // platformPlugins' docstring says "`zz` is deliberately not one of these". That is a
  // convention nothing enforced: a catalog package at catalog/<owner>/zz gives
  // pluginName("zz") = "zz", and then two plugins share a name, a marketplace entry, and a
  // directory. Files at the same tar path is a failure this file has already had once, in
  // the hermes router, "and the one that won on extraction was the wrong one".
  const seen = new Map([["zz", "the generated baseline plugin"]]);
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
  // One manifest name, one rule. zz-knowledge shipped nothing for weeks because it carried
  // plugin.json while every reader looks for flow.json — and nothing failed, it was simply
  // invisible.
  //
  // "Content and no manifest" was the wrong shape for that rule, and it forbade something
  // the platform supports and zz-flow-builder teaches: a SKILLS-ONLY package, no manifest at
  // all, that a team keeps its conventions in. catalogSkillRoots scans the filesystem and
  // serves a package owned by the caller's own team whether or not any flow is installed —
  // verified on the deployment, where skill_view returned a skill from a package with no
  // flow.json. This check would have failed the build the first time a team did as they were
  // told.
  //
  // What it looks for now is the actual zz-knowledge shape: a manifest filed under some other
  // name. And `agents/` still needs a manifest, because a preset is created from one.
  const bad = [];
  // EVERY package, because the subject is a package with no manifest. Iterating `flows` here
  // would have been looking only at the ones that already have one.
  for (const f of catalogPackages) {
    const dir = f.dir;
    const manifest = join(dir, "flow.json");
    if (!f.hasManifest) {
      // A stray .json is a suspected MISNAMED MANIFEST, not any JSON at all. zz-knowledge's was
      // plugin.json and declared a `name`, which is what a manifest does; a flow's
      // tests/scenarios.json declares scenarios and answers and is content. Reading the file
      // rather than its extension is what tells them apart — and it keeps the rule about
      // manifests instead of quietly becoming a rule about where data may live.
      const strays = readdirSync(dir).filter((f) => {
        if (!f.endsWith(".json")) return false;
        try {
          return typeof JSON.parse(readFileSync(join(dir, f), "utf8")).name === "string";
        } catch { return false; }
      });
      if (strays.length) {
        bad.push(`${f.owner}/${f.flow} carries ${strays.join(", ")} and no flow.json — ` +
                 "every reader looks for flow.json, so this package is invisible");
      } else if (existsSync(join(dir, "agents"))) {
        bad.push(`${f.owner}/${f.flow} ships an agent and no flow.json — ` +
                 "an agent preset is created from the manifest");
      }
      continue;   // skills-only, which is a package kind, not a mistake
    }
    const m = JSON.parse(readFileSync(manifest, "utf8"));
    if ("kind" in m) bad.push(`${f.owner}/${f.flow}: 'kind' is gone — it named a shape and meant ownership. Use 'shelved: true'.`);
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
  // THE FLOW-MENU BUG, made impossible. zz-admin sat in the console's flows tab beside
  // ops-flow because nothing in its manifest said it was not a flow, and the console had been
  // guessing shape from contents. Guessing is wrong even when it guesses right: the day it
  // guesses wrong there is nothing to point at.
  //
  // The rule, from ARCHITECTURE.md: a package is a flow if and only if it
  // declares a non-empty `stages`. Not gates, not documents, not skills — casebox-assist declares
  // one stage, no gate and no document, and is a flow.
  //
  // `entry` and `stages` travel together, in BOTH directions. A package whose agent opens a
  // skill does work that has a beginning, so it has at least one step and must say so; that
  // half is zz-access, which shipped an entry and no stages for months. A flow with no entry
  // has no door; that half has never happened and this is why.
  const bad = [];
  for (const f of flows) {
    const manifest = join(f.dir, "flow.json");
    if (!existsSync(manifest)) continue;
    const m = JSON.parse(readFileSync(manifest, "utf8"));
    const stages = (m.stages ?? []).length;
    if (m.entry && !stages) {
      bad.push(`${f.owner}/${f.flow} declares entry "${m.entry}" and no stages — it opens a ` +
               "skill and does work, so it is a flow and must declare at least one stage");
    }
    if (stages && !m.entry) {
      bad.push(`${f.owner}/${f.flow} declares ${stages} stage(s) and no entry — a flow needs ` +
               "a door: the skill its agent opens first");
    }
  }
  // And the console must READ that declaration rather than reconstruct it. The first fix
  // here filtered on `entry || stages`, which gave the right answer for the eight packages
  // that existed and would have kept giving an answer for a ninth that declared nothing.
  //
  // IT USED TO CHECK A FILTER, and there is no filter left to check. The console listed FLOWS,
  // so `catalogEntries().filter((e) => stages.length > 0)` was the line where the declaration
  // was read and this asserted its shape. The console lists PLUGINS now — one page where there
  // were two — and every catalog package is one whether or not it declares a method, so the
  // filter is gone on purpose and its absence is not evidence of anything.
  //
  // What the rule was always about survives unchanged: the console carries `stages` to the
  // reader, and it never decides what a package is from `entry`. Both halves are still
  // checkable, and the second half is the one that caught a real bug.
  const consoleSrc = consoleSource();
  if (!/manifest\.stages/.test(consoleSrc)) {
    bad.push("the console no longer reads manifest.stages — `stages` is a package's only " +
             "declaration of its method, and a console that does not read it is back to guessing");
  }
  for (const m of consoleSrc.matchAll(/\.filter\(\([^)]*\) => ([^\n]*)\)/g)) {
    if (/manifest\.entry/.test(m[1])) {
      bad.push("the console decides what a package is from `entry` — that is inference. " +
               "`stages` is the declaration and the only one.");
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("a flow.json is validated wherever it is read", () => {
  // A manifest decides which documents gate, in what order, and therefore which writes the
  // platform refuses. Four places read one — zz-core to build the chain it enforces, and
  // three tools to audit or drive a flow — and all four asserted the shape with a cast
  // instead of parsing it.
  //
  // The cost is not theoretical: `gate: "false"` is a STRING and therefore truthy, so a
  // manifest saying a document is not a gate made it one. In zz-core that refused writes the
  // flow depends on; in smoke-engine it set the premature-acceptance guard above any
  // threshold the flow can reach, so the guard blocks a run that is going correctly; in
  // manifest-audit it audits a store against rules the platform never enforced.
  //
  // @zz/contracts holds the schema and it says NO. Anywhere a flow.json is parsed, that is
  // what must parse it.
  const bad = [];
  for (const f of sourceFiles(["services", "packages", "scripts"], [".ts", ".mjs"])) {
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
  // zz-core walked the catalog's two levels for its skill roots — the same walk @zz/catalog
  // does, sorted for the same reason it states — but under a SINGLE try. A file where an
  // owner directory was expected threw ENOTDIR, and the catch beneath it, whose comment says
  // "no catalog mounted (local dev)", swallowed it and returned whatever had accumulated.
  //
  // `.DS_Store` sorts FIRST, so what accumulated was nothing: no platform skills, no flow
  // stage skills, no team overlays. skill_view finds nothing at all, and the only symptom is
  // that every skill has vanished. It is reachable on any host using the build override,
  // which mounts the working tree over the image's copy — which is where a stray file comes
  // from in the first place.
  //
  // @zz/catalog had the tolerance and said so in as many words: "a file where an owner
  // directory was expected". One walk now, and this RUNS it over a catalog with exactly that
  // stray file — a reading of the source cannot tell you which packages come back.
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
  const core = zzCoreSource();
  if (!/catalogPackages\(\)/.test(core)) {
    bad.push("zz-core no longer asks @zz/catalog which packages exist — its skill roots are " +
             "the one reader that must see a package with no flow.json");
  }
  // A catalog with a stray file at its root, a package that ships a manifest, and one that
  // ships only skills — which is a package kind the platform supports.
  const dir = join(root, "node_modules", ".zz-catalog-probe");
  for (const p of [join(dir, "zz", "zz-knowledge"), join(dir, "ops", "ops-flow", "skills")]) {
    execFileSync("mkdir", ["-p", p]);
  }
  writeFileSync(join(dir, ".DS_Store"), "");
  writeFileSync(join(dir, "zz", "zz-knowledge", "flow.json"), JSON.stringify({ name: "zz-knowledge" }));
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
    return `the catalog walk could not be run: ${String(err.stderr ?? err).slice(-200)}`;
  }
  if (got.names.join(",") !== "ops/ops-flow,zz/zz-knowledge") {
    bad.push(`a stray file at the catalog root left ${JSON.stringify(got.names)} — every ` +
             "package after it in sort order is gone, and skill_view would find nothing");
  }
  // And the narrower question must still be the narrower one: only the package with a
  // manifest is an entry, and the skills-only package is a package all the same.
  if (got.entries.join(",") !== "zz-knowledge") {
    bad.push(`catalogEntries returned ${JSON.stringify(got.entries)} — it is keyed on the ` +
             "manifest, and a skills-only package is not one");
  }
  return bad.length ? bad.join("; ") : null;
});

check("a flow's manifest is read through one reader", () => {
  // @zz/catalog's manifestAt exists because reading a flow.json is three decisions, not one:
  // does the file exist, is it JSON, and does it satisfy the schema the PLATFORM enforces. A
  // reader that answers them differently from the platform audits a store against rules
  // nothing enforces — manifest-audit's own docstring makes that argument about the envelope
  // parser it used to carry, and chain-check's makes it about walking a chain the deployment
  // does not have.
  //
  // Both of those were moved to manifestAt. smoke-engine was the third and was not: it parsed
  // the file itself inside a try that caught everything, so an INVALID manifest — `gate:
  // "false"`, a misspelled key — came back as `no manifest at <path>`, and the operator went
  // looking for a file that was sitting right there. Two of three is how this class of defect
  // always looks.
  const bad = [];
  const READER = join("packages", "catalog", "src", "index.ts");
  for (const rel of sourceFiles(["packages", "services"], [".ts"])) {
    if (rel === READER) continue;                       // the reader itself
    // withoutComments, not codeOnly: half of what this looks for IS a string literal — the
    // path to the file. Blanking the strings made the second arm below unable to see a single
    // `join(dir, "flow.json")` in the repository, and it passed on every file for that reason.
    const code = withoutComments(readFileSync(join(root, rel), "utf8"));
    // The schema belongs to @zz/contracts and the reader is the only thing that runs it over a
    // file. Anywhere else, a manifest is being validated a second way.
    for (const m of code.matchAll(/CatalogManifest\.(safe)?[Pp]arse\(/g)) {
      const line = code.slice(0, m.index).split("\n").length;
      bad.push(`${rel}:${line} runs the manifest schema itself — @zz/catalog's manifestAt is ` +
               "the one reader, and it answers 'missing', 'not JSON' and 'not a manifest' as " +
               "three different sentences rather than one catch");
    }
    // And a file that READS the manifest file has to reach it through the catalog package.
    //
    // The mention has to be part of a path being BUILT or a file being read, not any
    // occurrence of the name. zz-core's flow guard names `catalog/<owner>/<flow>/flow.json`
    // inside a refusal — the sentence that tells an admin which file to go and check — and
    // that is prose for a person, not a second reader. It passed for years because the file
    // it lived in also imported catalogManifest for an unrelated reason, so the exemption was
    // accidental; splitting server.ts moved the sentence into a file that did not, and the
    // check reported a defect that was never there.
    const READS = /(?:readFileSync|existsSync|statSync|readdirSync|join)\s*\([^)]*["'`][^"'`]*flow\.json/;
    if (!READS.test(code)) continue;
    if (/\bmanifestAt\b|\bcatalogManifest\b|\bcatalogEntr(y|ies)\b/.test(code)) continue;
    bad.push(`${rel} builds a path to a flow.json and reads it without @zz/catalog — one file, ` +
             "one reader, or the audit and the platform disagree about what a manifest is");
  }
  return bad.join("\n");
});

check("a plugin's content cannot move under a version nobody bumped", () => {
  // WHAT A PLUGIN VERSION IS WORTH, and it was worth nothing until this.
  //
  // A plugin is what a person installs. Its version is declared by hand in flow.json, and
  // `set-version.mjs` bumps every manifest in the workspace while never touching catalog/ — so
  // the one number a person cites when they say "sdlc 0.2 fixed it" was the one number nothing
  // checked. Content could move under it forever.
  //
  // This is skill-shape.mjs's lock check one level up, and its reasoning transfers whole: the
  // hash is not an alternative to the version, it is what makes the version true.
  //
  // THE RULE IS IMPORTED FROM THE TOOL THAT FIXES IT. pluginLock() is the same function
  // plugin-versions.mjs calls, which is the same enumeration the packager ships from. A second
  // implementation of "what does this plugin contain" would drift, and then the digest would
  // vouch for something nobody installs. Run in a subprocess because the enumeration reads
  // three directories that are absolute in the image and relative here — the shape
  // catalog-manifest already uses above, for the same reason.
  const lockPath = join(root, "plugins.lock.json");
  if (!existsSync(lockPath)) {
    return "plugins.lock.json does not exist — run `node scripts/plugin-versions.mjs --write`";
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
             ZZ_SKILLS_DIR: join(root, "skills"),
             ZZ_EVALS_DIR: join(root, "evals") },
    }));
  } catch (err) {
    return `the plugin enumeration could not be run: ${String(err.stderr ?? err).slice(-300)}`;
  }
  // An empty enumeration must FAIL, not pass. A wrong directory finds nothing, and nothing
  // agrees with nothing — a green tick over a lock that vouches for no plugin at all.
  if (!live.length) return "the plugin enumeration returned nothing — the extraction is broken";

  const recorded = JSON.parse(readFileSync(lockPath, "utf8"));
  const bad = [];
  for (const p of live) {
    const was = recorded[p.name];
    if (!was) {
      bad.push(`${p.name} ships and plugins.lock.json has never heard of it — run ` +
               "`node scripts/plugin-versions.mjs --write`");
      continue;
    }
    if (was.digest !== p.digest && was.version === p.version) {
      bad.push(`${p.name} still declares ${p.version} and its content moved ` +
               `(${was.digest} -> ${p.digest}) — bump the version in its flow.json, or re-run ` +
               "`node scripts/plugin-versions.mjs --write` if the change is deliberate");
    }
  }
  for (const name of Object.keys(recorded)) {
    if (!live.some((p) => p.name === name)) {
      bad.push(`plugins.lock.json still lists ${name}, which the catalog no longer ships — ` +
               "re-run `node scripts/plugin-versions.mjs --write`");
    }
  }
  return bad.length ? firstOf(bad) : null;
});

check("a plugin's recorded membership is the one it ships", () => {
  // WHICH SKILL VERSIONS WERE IN THIS PLUGIN VERSION, which nothing recorded until now.
  //
  // zz.skill_version has no plugin column, zz.skill.flow is CURRENT registration rather than
  // per-version, and flow_install overwrites its own history on reinstall. So "which version of
  // this skill was running" had no honest answer, and the evaluation track resolved it to
  // whatever happened to be current at read time -- a wrong answer indistinguishable from a
  // right one.
  //
  // Release is the only moment anybody actually knows, so release is where it is written. This
  // refuses a lock whose membership has drifted from the catalog, because a membership that is
  // wrong is worse than one that is missing: the profile would resolve events through it and
  // report the result as fact.
  const lockPath = join(root, "plugins.lock.json");
  if (!existsSync(lockPath)) return null;   // the check above already says this
  const recorded = JSON.parse(readFileSync(lockPath, "utf8"));
  const bad = [];
  for (const [plugin, entry] of Object.entries(recorded)) {
    // catalogPackages is an ARRAY of {owner, flow, dir}, not a function, and dir is already
    // absolute -- so the plugin name is its flow with the -flow suffix off, the same rule
    // pluginName() applies in the packager.
    const dirs = plugin === "zz"
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
    ? `${firstOf(bad)} — re-run \`node scripts/plugin-versions.mjs --write\``
    : null;
});
