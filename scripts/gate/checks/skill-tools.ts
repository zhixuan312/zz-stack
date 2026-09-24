/**
 * A skill naming a tool: that the tool exists, that the door carries it, that the package the
 * skill ships in can reach it. A skill naming a tool nobody registers produces a confident
 * call and an unknown-tool refusal mid-stage.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { between, firstOf, functionBody, gatewaySource, root, sourceFiles, zzCoreSource } from "../read.ts";
import { check, note } from "../run.ts";
import { catalogRoot, claimsOurs, flows, platformSkills, platformSurface, skillsOf } from "../facts.ts";


check("no tool description teaches a path form the platform refuses", () => {
  // A tool description must not teach a path form safePath refuses, such as a `.zz/` prefix:
  // it is the sentence a model reads before deciding how to call the tool.
  const bad: string[] = [];
  // Every service source, not each service's server.ts: admin.ts registers a door's worth of
  // tools whose descriptions the same model reads.
  for (const f of sourceFiles(["services"], [".ts"])) {
    const src = readFileSync(join(root, f), "utf8");
    // Description strings only: the guard that refuses the form has to be able to name it.
    for (const m of src.matchAll(/description:\s*\n?\s*((?:"[^"]*"\s*\+?\s*)+)/g)) {
      if (/\.zz[/ ]/.test(m[1])) {
        const line = src.slice(0, m.index).split("\n").length;
        bad.push(`${f}:${line} describes a .zz path`);
      }
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("no skill calls a tool the platform does not register", () => {
  // A skill naming a tool nobody ships makes the model call it, take an unknown-tool error
  // mid-stage, and improvise around a step the flow declared mandatory.
  const registered = new Set();
  for (const rel of sourceFiles(["services"], [".ts"])) {
    for (const m of readFileSync(join(root, rel), "utf8")
                      .matchAll(/registerTool\(\s*\n?\s*"([a-z0-9_]+)"/g)) registered.add(m[1]);
  }
  if (registered.size === 0) return "found no registerTool calls at all — the extraction is broken";

  const skillFiles = sourceFiles(["catalog", "skills"], [".md"]);

  const bad: string[] = [];
  for (const rel of skillFiles) {
    const txt = readFileSync(join(root, rel), "utf8");
    for (const m of txt.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\s*\(/g)) {
      const name = m[1];
      if (registered.has(name)) continue;
      // Snake_case followed by "(" is how this codebase writes a tool call, so anything else
      // shaped that way in a skill is a tool or a typo for one.
      //
      // DELIBERATE: platform tools only. The registry is read from services/, so a skill naming
      // another server's tool in call form fails here — a skill must not promise a tool this
      // platform does not serve.
      bad.push(`${rel}: ${name}()`);
    }
  }
  return firstOf(bad, 12);
});

check("a skill never names a platform tool that does not exist", () => {
  // Only the platform's own namespace is checked. Another server's tool named in a skill is that
  // server's business; a name under a noun this platform registers tools under is ours, and if we
  // do not serve it, nobody does.
  //
  // Which names are ours is derived by `platformSurface()`, not written out.
  const s = platformSurface();
  if (s.served.size < 30) return null;   // the shape of those files changed; other checks say so
  // The exclusion is derived too, so a quiet extraction failure would widen this into every
  // argument name a skill teaches. Said out loud instead.
  if (s.closed < s.occurrences) {
    return `${s.occurrences - s.closed} of ${s.occurrences} inputSchema blocks under services/ ` +
           "could not be read, so the parameter names those registrations declare are not all " +
           "known and an argument would be reported as a tool that does not exist";
  }
  // The derived noun set leaves other servers' tools alone: a name under a noun this platform
  // registers nothing beneath is somebody else's.
  const bad: string[] = [];
  const every = [...platformSkills().map((sk) => sk.path)];
  for (const f of flows) for (const sk of skillsOf(f)) every.push(sk.path);
  for (const f of every) {
    const txt = readFileSync(f, "utf8");
    // A call shape, never a bare word: backticked, backtick-then-paren, or quoted. The quoted
    // form is how a skill writes a tool name inside an example argument or a JSON fragment. A
    // bare word cannot fire, which is the defence against a tool whose name is also English.
    for (const m of txt.matchAll(/`([a-z][a-z0-9_]{3,40})[`(]|"([a-z][a-z0-9_]{3,40})"/g)) {
      const name = m[1] ?? m[2];
      if (s.served.has(name) || !claimsOurs(name, s)) continue;
      bad.push(`${f.replace(root + "/", "")} names \`${name}\`, which no platform server registers`);
    }
  }
  return bad.length ? [...new Set(bad)].join("; ") : null;
});

check("zz-platform's roster of platform tools is the tools zz-core serves", () => {
  // zz-platform's roster tells an agent that anything not on the list belongs to another
  // plugin, so the list is load-bearing and is checked against the registrations rather than
  // trusted.
  //
  // The roster carries a door per row and this compares that column: ours and yours-to-call
  // are not the same thing once a second door exists. eval-door.ts is the factory the service
  // mounts on the evaluation path, so the modules it imports are that door's, and everything
  // else zz-core registers is on the core door wherever its file sits.
  const doorOfTool = new Map();
  const EVAL_DOOR = "services/zz-core/src/eval-door.ts";
  if (!existsSync(join(root, EVAL_DOOR))) return `${EVAL_DOOR} is gone — the roster's door column cannot be checked against anything`;
  const evalNames = new Set();
  for (const m of readFileSync(join(root, EVAL_DOOR), "utf8")
         .matchAll(/import \{ register\w+ \} from "(\.\/[\w/-]+)\.js"/g)) {
    const mod = join(root, "services/zz-core/src", `${m[1].replace(/^\.\//, "")}.ts`);
    if (!existsSync(mod)) return `${EVAL_DOOR} imports ${m[1]}, which is not there`;
    for (const t of readFileSync(mod, "utf8").matchAll(/registerTool\(\s*\n?\s*"([a-z_0-9]+)"/g)) {
      evalNames.add(t[1]);
    }
  }
  const src = zzCoreSource();
  const served = new Set();
  for (const m of src.matchAll(/registerTool\(\s*\n?\s*"([a-z_0-9]+)"/g)) served.add(m[1]);
  if (served.size < 10) return null;   // the shape of the source changed; a later check says so
  for (const t of served) doorOfTool.set(t, evalNames.has(t) ? "/eval/mcp" : "/core/mcp");
  // The control on the split: both doors must have tools, or the column below is compared
  // against a map that answers the same thing to everything.
  if (!evalNames.size) return "no tool was attributed to the evaluation door, so the roster's door column is compared against a map that says /core/mcp to everything";
  if (![...doorOfTool.values()].includes("/core/mcp")) return "no tool was attributed to the core door — the derivation put the whole service behind the evaluation door";
  // A third door on this roster is the gateway's /manage: a tool that migrated there from /core
  // must still be carried, so a delivery agent is still told it is ours.
  //
  // DELIBERATE: /manage tools are not added to `served`. `served` drives the completeness test
  // below, and the rest of /manage is people, teams and tokens — zz-access's subject.
  // So /manage widens what the roster may name and what its door column is judged against, not
  // what it must be exhaustive about.
  //
  // COUPLED: extend MANAGE_FILES with each /manage module as it is created, or the roster's
  // rows for that module's tools read as names no door serves.
  const MANAGE_FILES = ["services/gateway/src/access-door.ts", "services/gateway/src/admin.ts",
                        "services/gateway/src/admin/flows.ts"];
  const manageNames = new Set<string>();
  for (const rel of MANAGE_FILES) {
    if (!existsSync(join(root, rel))) {
      return `${rel} is gone — the roster may name a /manage tool, so a scan that cannot read ` +
             "that door would report every such name as a tool the platform does not serve";
    }
    for (const m of readFileSync(join(root, rel), "utf8")
           .matchAll(/registerTool\(\s*\n?\s*"([a-z_0-9]+)"/g)) manageNames.add(m[1]);
  }
  // The control: an empty /manage set turns the widening below into "and anything else".
  if (!manageNames.size) return "no tool was found on /manage — the roster's third door is derived from nothing, so any name at all would be accepted as one";
  // A name zz-core also registers keeps zz-core's door: the two never overlap today, and if they
  // ever did, the roster should say the door the flow agent reaches, not the administrator's.
  for (const t of manageNames) if (!doorOfTool.has(t)) doorOfTool.set(t, "/manage/mcp");
  // Which /manage tools the roster must carry, derived rather than named: widening `extra` to
  // tolerate any /manage name would make such a row deletable in silence, since the
  // completeness test below runs over `served`, which no /manage tool is in.
  //
  // The rule is that it used to be on /core. A /manage tool with a TOOL_ALIAS entry migrated —
  // that map is per door and holds the renames of tools whose old name lived on /core — so a
  // delivery agent still needs to be told it is ours. Tools that were always /manage have
  // MANAGE_ALIAS entries or none and are not demanded here.
  //
  // Parsed from source, not imported: this gate runs before `tsc -b` has necessarily produced
  // any JavaScript.
  const aliasFile = "packages/contracts/src/alias.ts";
  if (!existsSync(join(root, aliasFile))) return `${aliasFile} is gone — the roster's /manage rows cannot be told from tools that were never on /core`;
  const aliasRegion = between(readFileSync(join(root, aliasFile), "utf8"),
                              "export const TOOL_ALIAS", "});");
  if (!aliasRegion.text) return `TOOL_ALIAS cannot be located in ${aliasFile}: ${aliasRegion.why}`;
  const coreAliasValues = new Set(
    [...aliasRegion.text.matchAll(/:\s*"([a-z0-9_]+)"/g)].map((m) => m[1]));
  if (!coreAliasValues.size) return `no entry was parsed out of TOOL_ALIAS in ${aliasFile}, so no /manage tool would ever be required on the roster`;
  const migrated = [...manageNames].filter((t) => coreAliasValues.has(t)).sort();
  const skill = readFileSync(join(root, "skills/zz-platform/SKILL.md"), "utf8");
  const start = skill.indexOf("THE PLATFORM'S TOOLS ARE THESE");
  if (start < 0) return "zz-platform no longer carries a roster of the platform's tools";
  const table = skill.slice(start, skill.indexOf("A tool NOT on that list", start));
  // Row by row, so the door column is read as the claim it is. A row is `| what | door | tools |`.
  const listed = new Map();
  for (const line of table.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 4) continue;
    const door = (/^`(\/[a-z/]+)`$/.exec(cells[2]) ?? [])[1];
    if (!door) continue;
    for (const m of cells[3].matchAll(/`([a-z_0-9]+)`/g)) listed.set(m[1], door);
  }
  const bad: string[] = [];
  if (!listed.size) {
    return "the roster's rows no longer carry a door column this check can read — every tool " +
           "below would then be reported as omitted, so it says this instead";
  }
  const missing = [...served].filter((t) => !listed.has(t)).sort();
  const extra = [...listed.keys()].filter((t) => !served.has(t) && !manageNames.has(t)).sort();
  if (missing.length) {
    bad.push(`zz-core serves ${missing.join(", ")} and the roster omits them — an agent reading ` +
             "that skill is told they belong to another plugin");
  }
  const droppedMigrants = migrated.filter((t) => !listed.has(t));
  if (droppedMigrants.length) {
    bad.push(`${droppedMigrants.join(", ")} moved from /core to /manage and the roster no longer ` +
             "names it — it is still the platform's tool, and this list's own closing sentence " +
             "says a tool NOT on it belongs to another plugin, so omitting it does not make " +
             "the roster quiet about it, it makes the roster wrong about it");
  }
  if (extra.length) {
    bad.push(`the roster names ${extra.join(", ")}, which no door on this platform serves — ` +
             "neither zz-core nor the gateway registers it, so an agent is being told a name " +
             "that answers \"tool not found\" belongs to us");
  }
  // Grouped by the claim, not one sentence per tool: a whole row moving door is one mistake.
  const wrongDoor = new Map();
  for (const [tool, door] of listed) {
    const actual = doorOfTool.get(tool);
    if (!actual || actual === door) continue;
    const key = `${door}\u0000${actual}`;
    if (!wrongDoor.has(key)) wrongDoor.set(key, []);
    wrongDoor.get(key).push(tool);
  }
  for (const [key, tools] of wrongDoor) {
    const [claimed, actual] = key.split("\u0000");
    const many = tools.length > 1;
    // The tail depends on the direction: claiming the baseline door for a tool that is not on
    // it tells everybody they have something they cannot call; claiming the evaluation door for
    // a baseline tool sends them to install a flow to reach what they already have.
    bad.push(`the roster puts ${tools.sort().join(", ")} on ${claimed} and ${many ? "they are" : "it is"} ` +
             `served on ${actual} — ` +
             (claimed === "/core/mcp"
               ? "zz-platform ships in the required baseline package, which carries /core/mcp, " +
                 `so every account on this platform is being told it can reach ${many ? "tools that are" : "a tool that is"} ` +
                 "not on its surface"
               : `${many ? "those are" : "that is"} on the door every account already carries, and the roster ` +
                 "sends the reader to install a flow to reach what they have"));
  }
  return bad.length ? bad.join("; ") : null;
});

check("every MCP tool description is well-formed", () => {
  const bad: string[] = [];
  for (const rel of sourceFiles(["services"], [".ts"])) {
    const src = readFileSync(join(root, rel), "utf8");
    // `description:` through to the line that ends the string concatenation.
    for (const m of src.matchAll(/registerTool\(\s*\n?\s*"([^"]+)",[\s\S]{0,80}?description:\s*([\s\S]*?),\n\s*inputSchema/g)) {
      const literal = [...m[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((s) => s[1]).join("");
      let depth = 0;
      for (const ch of literal) {
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        if (depth < 0) break;
      }
      if (depth !== 0) bad.push(`${rel}: ${m[1]}'s description has unbalanced brackets`);
    }
  }
  return bad.length ? `${bad.join("; ")} — an edit left a fragment behind` : null;
});

check("a skill never instructs a tool its package cannot reach", () => {
  // Complete and unreachable: the tool exists, the skill is well written, the agent is
  // provisioned, and the call the method depends on is on no surface that agent carries.
  // Nothing fails.
  //
  // Reachable = the baseline (/core, in every agent and the required package) plus whatever the
  // manifest declares in `servers`.
  const surfaceOf = new Map();
  const registered = (src: string, from: number, to?: number) => {
    const body = to === undefined ? src.slice(from) : src.slice(from, to);
    return [...body.matchAll(/registerTool\(\s*\n?\s*"([a-z0-9_]+)"/g)].map((m) => m[1]);
  };
  const core = zzCoreSource();
  const gw = gatewaySource();
  const adm = readFileSync(join(root, "services/gateway/src/admin.ts"), "utf8");
  // zz-core serves two doors. `zzCoreSource()` is the whole service as one text, so filing all
  // of it under /core/mcp makes the clause below unfalsifiable for those tools: a package that
  // declares no `servers` still reaches /core/mcp.
  //
  // COUPLED: derived from the door file's own imports, not from where the modules sit — the
  // same derivation checks/eval-door.ts uses.
  const EVAL_DOOR = "services/zz-core/src/eval-door.ts";
  if (!existsSync(join(root, EVAL_DOOR))) return `${EVAL_DOOR} is gone — every tool zz-core registers would be filed under /core/mcp, which is the door every account already has, so this check could not find an unreachable tool on the evaluation door`;
  const evalMods = [...readFileSync(join(root, EVAL_DOOR), "utf8")
    .matchAll(/import \{ register\w+ \} from "(\.\/[\w/-]+)\.js"/g)]
    .map((m) => `services/zz-core/src/${m[1].replace(/^\.\//, "")}.ts`);
  const evalTools = new Set();
  for (const rel of evalMods) {
    if (!existsSync(join(root, rel))) return `${EVAL_DOOR} imports ${rel}, which is not there`;
    for (const t of registered(readFileSync(join(root, rel), "utf8"), 0)) evalTools.add(t);
  }
  // Both controls, because either half collapsing makes this check pass on nothing: no eval
  // tools and every zz-core tool is on /core/mcp again, no core tools and `reach` is never
  // exercised.
  if (!evalTools.size) return `${EVAL_DOOR} registers no tool this check can see (${evalMods.length} module(s) imported), so zz-core's whole surface would be filed under /core/mcp`;
  for (const t of registered(core, 0)) surfaceOf.set(t, evalTools.has(t) ? "/eval/mcp" : "/core/mcp");
  if (![...surfaceOf.values()].includes("/core/mcp")) return "not one tool zz-core registers was attributed to /core/mcp — the split put everything on the evaluation door";
  const manageRegion = between(gw, "async function buildAccessServer", "\nserveMcp(app,");
  if (!manageRegion.text) return `the access server cannot be located: ${manageRegion.why}`;
  for (const t of registered(manageRegion.text, 0)) surfaceOf.set(t, "/manage/mcp");
  // Everything in admin.ts is on /manage too: registerShelf and registerAdminTools are both
  // mounted by buildAccessServer. What separates them is the caller's role, checked by "the
  // shelf is on the door everyone has, and installing is not".
  for (const t of registered(adm, 0)) surfaceOf.set(t, "/manage/mcp");

  const bad: string[] = [];
  // The other direction is reported, not failed. A tool on a door a package reaches that none
  // of that package's skills names is a fact worth a reader's eye and not a defect: the tool
  // list reaches the agent with its own description. The two places where untaught is fatal
  // fail on their own — "every tool on the access door is taught by a skill that ships with it"
  // and "every zz-core tool is named by a skill somebody loads". This line is per package.
  //
  // Only the doors the manifest itself declares, not the baseline every package carries: the
  // baseline's own coverage is the check named above.
  const unnamed: string[] = [];
  for (const f of flows) {
    const mf = join(f.dir, "flow.json");
    const m = JSON.parse(readFileSync(mf, "utf8"));
    const declared = new Set((m.servers ?? []).map((sv: { path: string }) => sv.path).filter((p: string) => p !== "/core/mcp"));
    const reach = new Set(["/core/mcp", ...(m.servers ?? []).map((sv: { path: string }) => sv.path)]);
    const skillsDir = join(f.dir, "skills");
    if (!existsSync(skillsDir)) continue;
    const named = new Set();
    for (const sk of readdirSync(skillsDir)) {
      const md = join(skillsDir, sk, "SKILL.md");
      if (!existsSync(md)) continue;
      const txt = readFileSync(md, "utf8");
      for (const [tool, surface] of surfaceOf) {
        // Named as a call — `tool(` or `tool` in backticks — not merely mentioned in prose.
        if (!new RegExp("`" + tool + "[(`]").test(txt)) continue;
        named.add(tool);
        if (!reach.has(surface)) {
          bad.push(`${f.owner}/${f.flow}/${sk} instructs ${tool} (${surface}), which its package cannot reach`);
        }
      }
    }
    const quiet = [...surfaceOf].filter(([t, s]) => declared.has(s) && !named.has(t)).map(([t]) => t);
    if (quiet.length) {
      unnamed.push(`      ${f.owner}/${f.flow} declares ${[...declared].join(", ")} and no skill of ` +
                   `its own names ${quiet.length} tool(s) there: ${quiet.sort().join(", ")}`);
    }
  }
  // Named in the line itself: `check()` runs this function before printing its own mark, so an
  // unattributed note appears above its check and reads as belonging to the one before.
  if (unnamed.length) note(`      reachability — exposed and unnamed (reported, not failed):\n${unnamed.join("\n")}`);
  return bad.length
    ? `${bad.join("; ")} — declare the surface in the manifest's \`servers\`, or stop instructing the tool`
    : null;
});

check("every tool in packages/tools is reachable from zz-tool", () => {
  // The wrapper's alias table is the surface — it is what the usage line prints and the only
  // thing forwarding the right environment — so a tool file not in it is dormant code wearing
  // an entry point. Both directions: an alias pointing at a file that no longer exists fails at
  // the moment somebody needs it.
  const wrapper = readFileSync(join(root, "deploy/zz-tool"), "utf8");
  const aliased = new Set([...wrapper.matchAll(/\[[a-z-]+\]=([a-z-]+\/[a-z-]+)/g)].map((m) => m[1]));
  const bad: string[] = [];
  // An entry point is `process.exit(main(…))`, the shape the sibling check "a testing engine's
  // exit status comes from its results" requires of every one of these files.
  for (const rel of sourceFiles(["packages/tools/src/ops", "packages/tools/src/testing"], [".ts"])) {
    const src = readFileSync(join(root, rel), "utf8");
    // A module imported by another tool is a library, not an entry point.
    if (!/^process\.exit\((await )?main\(/m.test(src)) continue;
    // And a self-contained check is not an operator's tool: zz-tool runs tools on a deployment
    // host, and mcp-client-check takes no arguments, reads no environment and contacts nothing.
    // A tool that reads its configuration is one somebody points at a deployment.
    if (!/parseArgs\(|process\.env\./.test(src)) continue;
    const key = rel.replace("packages/tools/src/", "").replace(/\.ts$/, "");
    if (!aliased.has(key)) bad.push(`${key} is an entry point with no zz-tool alias`);
  }
  for (const rel of aliased) {
    if (!existsSync(join(root, "packages/tools/src", `${rel}.ts`))) {
      bad.push(`zz-tool aliases ${rel}, which does not exist`);
    }
  }
  // And an npm script. Two ways in is not duplication: zz-tool runs it on a deploy host inside
  // the published image with no toolchain, the npm script runs it in a checkout.
  const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts ?? {};
  const scripted = new Set(Object.values(scripts)
    .map((v) => /packages\/tools\/dist\/([a-z-]+\/[a-z-]+)\.js/.exec(String(v))?.[1])
    .filter(Boolean));
  for (const rel of aliased) {
    if (!scripted.has(rel)) bad.push(`${rel} has no npm script — unreachable from a checkout`);
  }
  return bad.length ? bad.join("; ") : null;
});

check("every tool on the access door is taught by a skill that ships with it", () => {
  // /manage is the one door ZZ Access carries, and its skills are the only thing telling an
  // agent these tools exist — a tool registered there and unmentioned is unreachable in
  // practice, and nothing fails. Both skills in the package are read: zz-access for the person
  // in front of you, zz-admin for everybody else. Which of the two teaches a tool is editorial;
  // that one of them does is not.
  const src = gatewaySource();
  const adm = readFileSync(join(root, "services/gateway/src/admin.ts"), "utf8");
  // The function's own braces, not a comment divider: access-door.ts contains no divider, so a
  // region ending at one would run out of the file and into whatever `gatewaySource()`
  // concatenated next.
  const region = functionBody(src, "buildAccessServer");
  if (!region) return "the access server's registrations cannot be located: buildAccessServer() is not a function this can read";
  const grab = (t: string) => [...t.matchAll(/registerTool\(\s*\n?\s*"([a-z0-9_]+)"/g)].map((m) => m[1]);
  const tools = [...new Set([...grab(region), ...grab(adm)])];
  if (tools.length === 0) return "no tool found on /manage — the extraction is broken";
  const skillsDir = join(catalogRoot, "zz/zz-access/skills");
  const taught = readdirSync(skillsDir)
    .map((d) => join(skillsDir, d, "SKILL.md"))
    .filter((f) => existsSync(f))
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  if (!taught) return "zz-access ships no skills — every tool on this door is untaught";
  const bad = tools.filter((t) => !taught.includes(t));
  return bad.length
    ? `${bad.join(", ")} ${bad.length > 1 ? "are" : "is"} on /manage and no zz-access skill ` +
      `mentions ${bad.length > 1 ? "them" : "it"} — reachable and untaught is the same as absent`
    : null;
});

check("every zz-core tool is named by a skill somebody loads", () => {
  // A tool nothing teaches is reachable and unused. On /manage that is fatal, because
  // zz-access is the only thing describing that door; on /core the tool list reaches every
  // agent with its own description, so this is softer — but a tool no skill mentions is one the
  // flows were not written around.
  //
  // Skills, not documentation: the question is whether an agent following a method is ever
  // pointed at it.
  const core = zzCoreSource();
  const tools = [...core.matchAll(/registerTool\(\s*\n?\s*"([a-z0-9_]+)"/g)].map((m) => m[1]);
  let taught = "";
  for (const rel of sourceFiles(["skills", "catalog"], ["SKILL.md"])) {
    taught += readFileSync(join(root, rel), "utf8");
  }
  // As a tool, not as a word: a bare word-boundary match accepts any prose use, and
  // `document_list` and `skill_read` are words a skill can use in prose. Backticked or called
  // is what naming a tool looks like in these files.
  const bad = tools.filter((t) => !new RegExp(`\`${t}[(\`]|\\b${t}\\(`).test(taught));
  return bad.length
    ? `${bad.join(", ")} on /core and no skill names ${bad.length > 1 ? "them" : "it"} as a ` +
      "tool — a bare mention of the word is not teaching an agent to call it"
    : null;
});

check("no tool teaches a date format the platform does not use", () => {
  // Folders are named YYYY-MM-DD-<slug> and the platform stamps ISO and sorts on it, so a tool
  // description or skill offering a DD-MM-YYYY example is prompt text a model copies. A folder
  // is chosen before any document exists, so no later stamp repairs it.
  //
  // Every piece of prompt text, not only tool descriptions: a skill is prompt text by
  // definition, and an example folder name in one is copied as readily.
  const bad: string[] = [];
  for (const f of sourceFiles(["services", "skills", "catalog"], [".ts", "SKILL.md", "system-prompt.md"])) {
    const src = readFileSync(join(root, f), "utf8");
    const isTs = f.endsWith(".ts");
    for (const [i, line] of src.split("\n").entries()) {
      if (isTs && /^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      if (isTs && !/description:|\.describe\(/.test(line) && !/^\s*"/.test(line)) continue;
      if (!/\b\d{2}-\d{2}-20\d{2}\b/.test(line)) continue;
      // A line carrying both forms is contrasting them, which is how the rule gets explained.
      if (/\b20\d{2}-\d{2}-\d{2}\b/.test(line)) continue;
      bad.push(`${f}:${i + 1} shows a DD-MM-YYYY date; folders are YYYY-MM-DD`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});
