/**
 * Defects planted against the checks that hold the catalog and the console together.
 *
 * None of those four check files reads its subject directly: a manifest is a promise made in
 * JSON to code in another package, a lock file is a promise about content nobody re-derives at
 * read time, and the console is a separate repository tied to this one by a route string and a
 * version. So every defect below is planted in the promise or in the thing it describes, never
 * in the check that compares them.
 *
 * One assertion cannot be planted against: the console's compose literal, because every byte it
 * reads lives in `../zz-stack-dashboard`, outside this tree.
 */
import type { MutationSpec } from "./plant.ts";

const SDLC = "catalog/sdlc/sdlc-flow";
const ACCESS = "catalog/zz/zz-access";
const EVAL = "catalog/zz/zz-plugin-eval";
const LOCK = "plugins.lock.json";
const INITIATIVES = "services/gateway/src/console/initiatives.ts";

/** zz-plugin-eval's `purpose`, verbatim, so the blanking below replaces the whole sentence
 *  rather than half of it and leaves a manifest that still parses. */
const EVAL_PURPOSE =
  "To answer whether a plugin is worth having, from evidence the platform already holds — " +
  "what its real runs did, and what a recorded ablation says installing it is worth — " +
  "against a ruler somebody agreed before the scoring started. It measures and never " +
  "changes what it measures.";

export const COV_CATALOG: readonly MutationSpec[] = [
  // catalog-stages.ts
  {
    check: "scripts/gate/checks/catalog-stages.ts",
    target: "a document's requirement is met by the only thing its target can offer",
    assertion: "initiative_status resolves a requirement by asking whether its target is gated",
    subject: "services/zz-core/src/tools/initiative-status.ts",
    find: `      return t.gate ? t.status === "approved" : t.exists;`,
    replace: `      return t.status === "approved";`,
    planted: "a prerequisite is judged by an approval that will never come. Nothing approves " +
      "an ungated document, so its status stays draft for the life of the initiative — and " +
      "with this line every flow whose first document is ungated is told to close, with the " +
      "documents that follow it absent and both of them gates",
  },
  {
    check: "scripts/gate/checks/catalog-stages.ts",
    target: "a document's declared stage is a stage its flow has",
    subject: `${SDLC}/flow.json`,
    find: `      "stage": "sdlc-explore"`,
    replace: `      "stage": "sdlc-exploration"`,
    planted: "explore.md points at a stage the flow does not declare, so the console's " +
      "stepper draws a step for a document nothing produces and the document's own stage " +
      "resolves to nothing",
  },
  {
    check: "scripts/gate/checks/catalog-stages.ts",
    target: "every section a manifest declares is taught by one of its skills",
    subject: `${SDLC}/flow.json`,
    find: `        "Verification Plan",`,
    replace: `        "Verification plan",`,
    planted: "the manifest requires a heading in a spelling no skill teaches. normalizeSections " +
      "rewrites an author's heading to the manifest's on every write, so the flow silently " +
      "demands a section nobody is ever asked for and quietly renames the one they wrote",
  },
  {
    check: "scripts/gate/checks/catalog-stages.ts",
    target: "no shell freezes one flow's fixture paths",
    subject: "testing/eval-step.sh",
    find: `STEPS="catalog/$FLOW/tests/steps.json"`,
    replace: `STEPS="catalog/sdlc/sdlc-flow/tests/steps.json"`,
    planted: "the script that produces a run directory takes one flow's steps file as a " +
      "constant again, so a corpus authored for any other flow is one nothing can run — and " +
      "the block is in the launcher rather than in the engine, where nobody looks for it",
  },
  {
    check: "scripts/gate/checks/catalog-stages.ts",
    target: "no evaluation tool is wired to one flow",
    subject: "services/zz-core/src/eval/plugin-eval.ts",
    find: `  return entry ? join(entry.dir, "skills") : "";`,
    replace: `  return entry ? join(entry.dir, "skills") : "catalog/sdlc/sdlc-flow/skills";`,
    planted: "a plugin the catalog does not hold resolves to one named flow's skills " +
      "directory, so every evaluation of an unknown plugin silently reads sdlc's skills and " +
      "reports the result as that plugin's",
  },
  {
    check: "scripts/gate/checks/catalog-stages.ts",
    target: "a team overlay adds and cannot replace",
    subject: "services/zz-core/src/tools/skills.ts",
    find: `text(readFileSync(path, "utf8") + await teamOverlay(name))`,
    replace: `text((await teamOverlay(name)) || readFileSync(path, "utf8"))`,
    planted: "a team's overlay is returned INSTEAD of the skill rather than after it. Any team " +
      "with an overlay of that name shadows the platform's own text — zz-platform included — " +
      "so a rule the platform sets can be taken over by a file in a team's own store",
  },

  // catalog-manifest.ts
  {
    check: "scripts/gate/checks/catalog-manifest.ts",
    target: "no two flows collapse to the same command namespace",
    subject: `${ACCESS}/flow.json`,
    find: `\n  "name": "zz-access",`,
    replace: `\n  "name": "zz-core-flow",`,
    planted: "two catalog packages derive the same plugin name. `zz-core-flow` and `zz-core` " +
      "both become `zz-core`, so one plugin shadows the other in a person's marketplace — one " +
      "name, one directory, one entry, no error anywhere, and no way to tell which of the two " +
      "answered",
  },
  {
    check: "scripts/gate/checks/catalog-manifest.ts",
    target: "every catalog entry has a flow.json and declares what it is",
    assertion: "a declared server names an absolute path",
    subject: `${ACCESS}/flow.json`,
    find: `"path": "/manage/mcp"`,
    replace: `"path": "manage/mcp"`,
    planted: "the door this package declares is no longer an absolute path, so the URL a " +
      "person's client is handed for it is not the one the gateway mounts — the tools simply " +
      "are not there, and nothing says why",
  },
  {
    check: "scripts/gate/checks/catalog-manifest.ts",
    target: "a package declares whether it is a flow, and the console reads the declaration",
    assertion: "a package with a method declares the door its agent opens first",
    subject: `${EVAL}/flow.json`,
    find: `  "entry": "zz-plugin-eval",\n`,
    replace: "",
    planted: "a package with five stages no longer names the skill its agent opens first, so " +
      "an agent sent to run the method has no door into it and whenToUse falls back to a " +
      "sentence the platform generated rather than the one the skill wrote",
  },
  {
    check: "scripts/gate/checks/catalog-manifest.ts",
    target: "a flow.json is validated wherever it is read",
    subject: "scripts/release/fit-for-purpose.ts",
    // DELIBERATE: split across two lines. This file is under `scripts/`, so the check being
    // measured scans it, and one line carrying `manifest`, `JSON.parse(` and the cast together
    // satisfies all three of its predicates — red at baseline, and the row uncatchable. The
    // planted text is identical.
    find: `      const f = join(cat, owner, pkg, "flow.json");\n` +
      `      if (existsSync(f)) out.push({ owner, pkg, m: JSON.parse(readFileSync(f, "utf8")) });`,
    replace: `      const manifest = join(cat, owner, pkg, "flow.json");\n` +
      `      if (existsSync(manifest)) out.push({ owner, pkg, m: JSON.parse(readFileSync(manifest, "utf8"))` +
      ` as FlowManifest });`,
    planted: "the release's own fit-for-purpose review asserts a manifest's shape with a cast " +
      "instead of parsing it. `gate: \"false\"` is a truthy string, so the review reads a " +
      "document as gated that the platform does not — the release is judged against rules " +
      "nothing enforces",
  },
  {
    check: "scripts/gate/checks/catalog-manifest.ts",
    target: "a stray file in the catalog cannot empty it",
    subject: "packages/catalog/src/index.ts",
    find: `    } catch { continue; }          // a file where an owner directory was expected`,
    replace: `    } catch { return out; }          // a file where an owner directory was expected`,
    planted: "a file where an owner directory was expected ends the catalog walk instead of " +
      "being skipped. `.DS_Store` sorts first, so the answer is the empty list: no platform " +
      "skills, no flow stage skills, no team overlays, and the only symptom anybody sees is " +
      "that every skill has vanished",
  },
  {
    check: "scripts/gate/checks/catalog-manifest.ts",
    target: "a flow's manifest is read through one reader",
    subject: "services/zz-core/src/skill-roots.ts",
    find: `    const dir = join(pkgDir, "skills");\n    if (!existsSync(dir)) continue;`,
    replace: `    const dir = join(pkgDir, "skills");\n    if (!existsSync(dir) || !existsSync(join(pkgDir, "flow.json"))) continue;`,
    planted: "zz-core decides what a package is by looking for a flow.json itself, instead of " +
      "asking @zz/catalog. It re-introduces the regression the file's own comment describes: a " +
      "skills-only package — the shape a team keeps its own conventions in, and one the " +
      "platform supports — serves no skills at all",
  },
  {
    check: "scripts/gate/checks/catalog-manifest.ts",
    target: "plugins.lock.json says what the catalog ships, on both version and digest",
    subject: LOCK,
    // DELIBERATE: anchored on the bare key that follows the version, not on a version number
    // or a digest value — both change, and the anchor stops landing.
    //
    // The order matters. `JSON.parse` keeps the last of two duplicate keys, so an injected
    // `"version"` before the real one loses and the row survives, having measured nothing.
    // `"digest"` is the line after `"version"` in every block of this lock, so injecting there
    // puts the wrong value second. `all: true` over the bare key lands in every block and
    // needs no occurrence to be unique.
    all: true,
    find: `    "digest": "`,
    replace: `    "version": "0.0.1",\n    "digest": "`,
    planted: "the lock records a version the catalog no longer declares. The release registers " +
      "zz.plugin_version FROM this file and never regenerates it, so the release writes the " +
      "PREVIOUS release's number into the database and every recording made against the " +
      "version the release actually shipped is refused",
  },
  {
    check: "scripts/gate/checks/catalog-manifest.ts",
    target: "a plugin's recorded membership is the one it ships",
    subject: LOCK,
    find: `      "zz-platform": "dac29055d623"`,
    replace: `      "zz-platfrom": "dac29055d623"`,
    planted: "the lock's record of which skills were in this plugin version is wrong in both " +
      "directions at once — it names a skill the plugin does not ship and omits one it does. " +
      "A membership that is wrong is worse than one that is missing: the profile resolves " +
      "events through it and reports the result as fact",
  },

  // console.ts
  {
    check: "scripts/gate/checks/console.ts",
    target: "the initiatives route reads the team filter its caller sends",
    subject: INITIATIVES,
    find: `typeof req.query.team === "string" && req.query.team ? req.query.team : null`,
    replace: `typeof req.query.team_slug === "string" && req.query.team_slug ? req.query.team_slug : null`,
    planted: "the route reads a query key nobody sends. The console still links to " +
      "`/initiatives?team=<slug>` from the team page, the filter is silently ignored, and a " +
      "platform-scoped reader clicking into one team is handed every team's initiatives — with " +
      "the count beside the panel taken from those same rows, so the page agrees with itself " +
      "and disagrees with the Teams table two clicks away",
  },
  {
    check: "scripts/gate/checks/console.ts",
    target: "a console query is a literal check:sql can PREPARE",
    subject: INITIATIVES,
    find: `        where initiative <> '_knowledge' and team_slug = $1\n` +
      "        order by team_slug, initiative, path`, [want])",
    replace: `        where initiative <> '_knowledge' and team_slug = '\${want}'\n` +
      "        order by team_slug, initiative, path`)",
    planted: "one of the console's queries is assembled at request time from a value the caller " +
      "sent. There is no longer a complete statement for check:sql to PREPARE before a " +
      "release, so this query ships with nothing having compiled it — and the team slug is " +
      "pasted into the SQL text rather than bound. The route's team-filter check goes red " +
      "beside it, because dropping the bound parameter is what stops the text being a literal",
  },
  {
    check: "scripts/gate/checks/console.ts",
    target: "every console write route records the door it came through",
    subject: "services/gateway/src/console-write.ts",
    find: `kind: "document.approve", subject, detail: { via: "web" }`,
    replace: `kind: "document.approve", subject, detail: {}`,
    planted: "the approval a person presses in the browser leaves an audit row that does not " +
      "say a browser pressed it. The row exists and names the actor and the act, so nothing " +
      "looks missing — and the rule that every console act records the web door is " +
      "gone for the one act that most needs it",
  },
  {
    check: "scripts/gate/checks/console.ts",
    target: "a claim that states no verdict says so, rather than stating an empty one",
    subject: INITIATIVES,
    find: `verdict: row.verdict || null`,
    replace: `verdict: row.verdict`,
    planted: "a claim that states no verdict is returned as one whose verdict is the empty " +
      "string. The column is `not null default ''`, so the database cannot tell the two apart " +
      "and now neither can the API — every claim from a reader that produces no verdict reads " +
      "as a field that is broken rather than as a fact about that reader",
  },
  {
    check: "scripts/gate/checks/console.ts",
    target: "the server-held LLM client stays off the console",
    assertion: "a deployment with no LLM credential says so truthfully rather than at the call",
    subject: "services/gateway/src/generate.ts",
    find: `  return missingVars().length === 0;`,
    replace: `  return true;`,
    planted: "the question a route asks before it tries — can I even call the model — is " +
      "answered yes on a deployment with no credential configured. The route proceeds, the " +
      "call throws, and the person gets a failure where they should have got the sentence " +
      "naming exactly which variable to set",
  },
  {
    check: "scripts/gate/checks/console.ts",
    target: "every route this gateway serves has a caller",
    subject: INITIATIVES,
    // DELIBERATE: the new path is split so this file does not contain it. The check greps
    // `scripts/**` for a route's path to decide whether anything calls it and excludes only
    // the gate's own tree, so a spec file spelling the orphaned path would vouch for the route
    // it just orphaned.
    find: `app.get("/api/console/initiatives", handler("initiatives"`,
    replace: `app.get("/api/console/initiative` + `-index", handler("initiatives"`,
    planted: "the initiatives list is served at a path nothing asks for. The console still " +
      "calls `/api/console/initiatives`, so the page that lists every initiative gets a 404 " +
      "and the gateway carries a route with no caller in either repository",
  },

  // plugin-declaration.ts
  {
    check: "scripts/gate/checks/plugin-declaration.ts",
    target: "a plugin manifest says what the plugin is for",
    subject: `${EVAL}/flow.json`,
    find: `"purpose": "${EVAL_PURPOSE}"`,
    replace: `"purpose": " "`,
    planted: "the package stops saying what belongs in it. `description` still tells a reader " +
      "what it does; the sentence that decides whether the next capability goes here or in a " +
      "new package is blank, so the package accretes whatever was convenient and there is " +
      "nothing written to argue against",
  },

  // Two ids filed under console.ts by the coverage split, registered elsewhere
  // `cov-catalog.json` and `uncovered-by-file.json` list these under console.ts, which only
  // mentions them in prose. They are registered in hygiene.ts and docs-integrity.ts, and
  // `check` names the file that registers each: the report's drift detection hashes that file.
  {
    check: "scripts/gate/checks/hygiene.ts",
    target: "nothing is exported that nobody imports",
    subject: "services/gateway/src/console/catalog.ts",
    // DELIBERATE: the symbol's name is split so it never occurs whole in this file. The check
    // asks whether any other file names the export and it reads `scripts/**`, so a spec file
    // spelling the name would be the importer that keeps it alive.
    find: `function disk` + `Plugins(): DiskPlugin[] {`,
    replace: `export function disk` + `Plugins(): DiskPlugin[] {`,
    planted: "a helper that only its own file calls is given a public door. The compiler has " +
      "nothing to say about it — an export is a legitimate surface as far as tsc is concerned " +
      "— so it is dead code that reads as an interface, and the next person moving this module " +
      "keeps a caller that does not exist",
  },
  {
    check: "scripts/gate/checks/docs-integrity.ts",
    target: "a gate check cited elsewhere is cited by a name that exists",
    subject: "ARCHITECTURE.md",
    find: `\`check "a plugin manifest says what the plugin is for"\``,
    replace: `\`check "a plugin manifest declares what the plugin is for"\``,
    planted: "the document that says the repository is wrong where it disagrees with it cites " +
      "enforcement by a name no check has. A reader checking whether `purpose` is really " +
      "required greps for the check, finds nothing, and cannot tell a rule that moved from a " +
      "rule that was never there",
  },
];
