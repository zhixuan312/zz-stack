/**
 * A skill naming a tool: that the tool exists, that the door carries it, that the package
 * the skill ships in can actually reach it.
 *
 * A skill telling an agent to call a tool nobody registers produces a confident attempt and
 * a refusal the agent then explains to a person as though it were the platform's answer.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { between, firstOf, gatewaySource, root, sourceFiles, zzCoreSource, zzCoreTools } from "../read.mjs";
import { check, note } from "../run.mjs";
import { catalogRoot, claimsOurs, flows, platformSkills, platformSurface, skillsOf } from "../facts.mjs";


check("no tool description teaches a path form the platform refuses", () => {
  // document_read said "Read a file from your .zz artifact store" while safePath had just
  // started REFUSING a .zz/ prefix — the tool's own description inviting the shape its
  // implementation rejects, in the sentence a model reads before deciding how to call it.
  // Three tools carried it.
  const bad = [];
  // Every service source, not each service's server.ts. admin.ts registers a door's worth of
  // tools of its own and was never looked at, and a description there is read by exactly the same
  // model, before exactly the same call.
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
  // The sibling check catches a skill naming a skill nobody ships. A skill naming a TOOL
  // nobody ships fails the same way and worse: the model calls it, gets an unknown-tool
  // error mid-stage, and improvises around a step the flow declared mandatory. Skills are
  // the method — they are read by a model that will do exactly what they say.
  const registered = new Set();
  for (const rel of sourceFiles(["services"], [".ts"])) {
    for (const m of readFileSync(join(root, rel), "utf8")
                      .matchAll(/registerTool\(\s*\n?\s*"([a-z0-9_]+)"/g)) registered.add(m[1]);
  }
  if (registered.size === 0) return "found no registerTool calls at all — the extraction is broken";

  const skillFiles = sourceFiles(["catalog", "skills"], [".md"]);

  const bad = [];
  for (const rel of skillFiles) {
    const txt = readFileSync(join(root, rel), "utf8");
    for (const m of txt.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\s*\(/g)) {
      const name = m[1];
      if (registered.has(name)) continue;
      // Snake_case followed by "(" is how this codebase writes a tool call. Anything else
      // shaped like that in a skill is either a tool or a typo for one.
      //
      // PLATFORM tools only — the registry is read from services/, and a BLOCK's tools live
      // in another repository that is not required to be present. So a skill naming a real
      // block tool in call form, `usage_skill_view(...)`, would fail here. That is the
      // deliberate outcome: block tools are discovered at runtime and a skill must not
      // promise a particular one exists — ops-select names those two in backticks and says
      // so in the same sentence.
      bad.push(`${rel}: ${name}()`);
    }
  }
  return firstOf(bad, 12);
});

check("a skill never names a platform tool that does not exist", () => {
  // zz-access told people to store a key with a verb-first name — the verb, an underscore,
  // then the noun — that no door has ever registered. The tool is `credential_set`, and the
  // skill named a spelling of it that did not exist and never had.
  // An agent following that goes looking for a tool the platform does not have, and this
  // repository has spent a day on what happens next — it reaches for a block's tool whose name
  // is close, then reports that the platform cannot do the thing.
  //
  // Only the platform's own namespace is checked. A block tool named in a skill is that
  // block's business and may be absent from this deployment; a name under a noun WE register
  // tools under is ours, and if we do not serve it, nobody does. `read_api_spec` and
  // `get_platform_overview` are block tools the building-block contract REQUIRES every block
  // to publish, and no door here registers anything under `read` or `get`, so they are left
  // alone without anybody having to list them.
  //
  // WHICH NAMES ARE OURS IS DERIVED — `platformSurface()` at the top of this file says what
  // replaced the thirty-name `MANAGE` array and the `OURS` regex that consumed it, and why a
  // written-out roster of our own tool names could never have made this check fire.
  const s = platformSurface();
  if (s.served.size < 30) return null;   // the shape of those files changed; other checks say so
  // THE EXCLUSION IS DERIVED TOO, so its extraction failing quietly would WIDEN this check
  // into every argument name a skill teaches an agent to pass. Said out loud instead.
  if (s.closed < s.occurrences) {
    return `${s.occurrences - s.closed} of ${s.occurrences} inputSchema blocks under services/ ` +
           "could not be read, so the parameter names those registrations declare are not all " +
           "known and an argument would be reported as a tool that does not exist";
  }
  // A block's own tools are named in skills too and are that block's business, so anything a
  // block registers is left alone even where this deployment cannot reach it. That used to be
  // a loop over casebox/RuleMill/bookit reading blocks/<b>/skills — and its body was a single
  // `continue`, so it read nothing and decided nothing. It became a no-op when those blocks
  // moved to their own repository, and looked like the mechanism enforcing this paragraph.
  // The derived noun set is what actually does it: a name under a noun this platform registers
  // nothing beneath is somebody else's.
  const bad = [];
  const every = [...platformSkills().map((sk) => sk.path)];
  for (const f of flows) for (const sk of skillsOf(f)) every.push(sk.path);
  for (const f of every) {
    const txt = readFileSync(f, "utf8");
    // A CALL SHAPE, never a bare word: backticked, backtick-then-paren, or QUOTED. The quoted
    // form is how a skill writes a tool name inside an example argument or a JSON fragment —
    // `skill_read("zz-handover")` is quoted prose away from being written the other way, and a
    // name that only ever appears in quotes was invisible here. Measured before it was added:
    // across every skill on the shelf it introduced no finding of its own, so it widens the reach and
    // not the noise. A bare word still cannot fire, which is the whole defence against a tool
    // whose name is also English.
    for (const m of txt.matchAll(/`([a-z][a-z0-9_]{3,40})[`(]|"([a-z][a-z0-9_]{3,40})"/g)) {
      const name = m[1] ?? m[2];
      if (s.served.has(name) || !claimsOurs(name, s)) continue;
      bad.push(`${f.replace(root + "/", "")} names \`${name}\`, which no platform server registers`);
    }
  }
  return bad.length ? [...new Set(bad)].join("; ") : null;
});

check("zz-platform's roster of platform tools is the tools zz-core serves", () => {
  // zz-platform names all twenty-one and tells an agent that anything NOT on the list belongs
  // to a building block. That makes the list load-bearing: an agent uses it to decide whether
  // `document_approve` is a gate or somebody's booking approval, and one session got that wrong
  // four times in a row and told the person the platform had no approve action at all. The
  // noun-first rename narrows that confusion without ending it: `document_approve` says which
  // noun it acts on, and a block is still free to publish `approve_slot`.
  //
  // A hand-written roster is exactly the thing that stops being true — a tool added to zz-core
  // and not to the skill is a tool the next agent is told does not belong to us. So the list is
  // checked against the registrations rather than trusted.
  // AND WHICH DOOR EACH IS ON, not merely that zz-core serves it. `zzCoreSource()` is the whole
  // service as one text, so this clause was blind to the thing that changed: when the ten
  // `plugin_*` tools moved to /eval/mcp, zz-core still "served" all of them and this stayed
  // green — while zz-platform, which ships in the REQUIRED baseline package, went on telling
  // every account on the platform that ten tools it cannot reach were on its list. The roster
  // is load-bearing precisely because an agent uses it to decide whether a name is ours, and
  // "ours" and "yours to call" stopped being the same thing the day the second door opened.
  //
  // So the roster now carries a door per row and this compares that column. Same derivation as
  // the reachability check above: eval-door.ts is the factory the service mounts on the
  // evaluation path, so the modules it imports are that door's, and everything else zz-core
  // registers is on the core door wherever its file sits.
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
  // A THIRD DOOR APPEARS ON THIS ROSTER AT TASK I-38, and it is the gateway's. `knowledge_reindex`
  // left `/core` for `/manage`: rebuilding a team's index is an administrative act on a team
  // rather than a step in anybody's flow, and it takes a team argument no /core tool has.
  //
  // THE ROSTER MUST STILL CARRY IT, which is the whole reason this derivation widens instead of
  // the name being dropped. The list's own closing sentence is "a tool NOT on that list belongs
  // to a building block, whatever it is called" — so deleting the name would not make the
  // roster silent about it, it would make the roster WRONG about it, and an agent reading that
  // skill would be told a platform tool is somebody's block. Derived from the gateway's
  // registrations, so the door column is checked against the source rather than believed.
  //
  // NOT ADDED TO `served`, and the asymmetry is deliberate. `served` drives the completeness
  // test below — every tool zz-core registers must appear here — and the rest of /manage is
  // people, teams, tokens and installs. Those are zz-access's subject and
  // are taught by its skills; demanding them on a roster a DELIVERY agent reads would bury the
  // twenty names it exists to state. So /manage widens what the roster may NAME and what its
  // door column is judged against, and not what it must be exhaustive about.
  const MANAGE_FILES = ["services/gateway/src/access-door.ts", "services/gateway/src/admin.ts",
                        "services/gateway/src/admin/flows.ts"];
  const manageNames = new Set();
  for (const rel of MANAGE_FILES) {
    if (!existsSync(join(root, rel))) {
      return `${rel} is gone — the roster may name a /manage tool, so a scan that cannot read ` +
             "that door would report every such name as a tool the platform does not serve";
    }
    for (const m of readFileSync(join(root, rel), "utf8")
           .matchAll(/registerTool\(\s*\n?\s*"([a-z_0-9]+)"/g)) manageNames.add(m[1]);
  }
  // THE CONTROL. An empty /manage set turns the widening below into "and anything else", which
  // is the opposite of what it is for.
  if (!manageNames.size) return "no tool was found on /manage — the roster's third door is derived from nothing, so any name at all would be accepted as one";
  // A name zz-core also registers keeps zz-core's door: the two never overlap today, and if they
  // ever did, the roster should say the door the flow agent reaches, not the administrator's.
  for (const t of manageNames) if (!doorOfTool.has(t)) doorOfTool.set(t, "/manage/mcp");
  // WHICH /manage TOOLS THE ROSTER MUST CARRY, derived rather than named. Widening `extra` to
  // tolerate a /manage name would otherwise have made the row DELETABLE in silence: the
  // completeness test below runs over `served`, which no /manage tool is in, so dropping
  // `knowledge_reindex` from the table again would pass — and the roster's closing sentence
  // then tells every agent it belongs to a building block, which is the exact failure this
  // check exists to catch. Found by mutation while the widening was being tested.
  //
  // The rule is "it used to be on /core". A /manage tool with a TOOL_ALIAS entry MIGRATED —
  // that map is per door and holds the renames of tools whose old name lived on /core — so it
  // is a process tool that moved house, and a delivery agent still needs to be told it is
  // ours. The tools that were always /manage have MANAGE_ALIAS entries or none, are
  // zz-access's subject, and are deliberately not demanded here.
  //
  // PARSED FROM SOURCE, not imported: this gate runs before `tsc -b` has necessarily produced
  // any JavaScript, which is the rule facts.mjs states for every answer that lives in
  // TypeScript.
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
  // ROW BY ROW, so the door column is read as the claim it is. A row is `| what | door | tools |`.
  const listed = new Map();
  for (const line of table.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 4) continue;
    const door = (/^`(\/[a-z/]+)`$/.exec(cells[2]) ?? [])[1];
    if (!door) continue;
    for (const m of cells[3].matchAll(/`([a-z_0-9]+)`/g)) listed.set(m[1], door);
  }
  const bad = [];
  if (!listed.size) {
    return "the roster's rows no longer carry a door column this check can read — every tool " +
           "below would then be reported as omitted, so it says this instead";
  }
  const missing = [...served].filter((t) => !listed.has(t)).sort();
  const extra = [...listed.keys()].filter((t) => !served.has(t) && !manageNames.has(t)).sort();
  if (missing.length) {
    bad.push(`zz-core serves ${missing.join(", ")} and the roster omits them — an agent reading ` +
             "that skill is told they belong to a building block");
  }
  const droppedMigrants = migrated.filter((t) => !listed.has(t));
  if (droppedMigrants.length) {
    bad.push(`${droppedMigrants.join(", ")} moved from /core to /manage and the roster no longer ` +
             "names it — it is still the platform's tool, and this list's own closing sentence " +
             "says a tool NOT on it belongs to a building block, so omitting it does not make " +
             "the roster quiet about it, it makes the roster wrong about it");
  }
  if (extra.length) {
    bad.push(`the roster names ${extra.join(", ")}, which no door on this platform serves — ` +
             "neither zz-core nor the gateway registers it, so an agent is being told a name " +
             "that answers \"tool not found\" belongs to us");
  }
  // GROUPED BY THE CLAIM, not one sentence per tool: a whole row moving door is one mistake,
  // and ten copies of the same sentence is how a reader learns to skim a failure.
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
    // THE TAIL DEPENDS ON THE DIRECTION, because the two mistakes cost different things and a
    // reader acts on the sentence they are given. Claiming the baseline door for a tool that is
    // not on it tells everybody they have something they cannot call; claiming the evaluation
    // door for a baseline tool tells everybody to install a flow to reach what they already have.
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
  const bad = [];
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
  // COMPLETE AND UNREACHABLE is this platform's most expensive shape, because nothing fails.
  // The tool exists, the skill is well written, the agent is provisioned, and the call the
  // method depends on is simply not on any surface that agent carries.
  //
  // It has happened twice. catalog_list was member-safe and mounted only on /admin/mcp while
  // zz-access, the agent every account gets, carries /manage alone. Then zz-flow-builder —
  // "flow creation as a service: interview, draft, confirm, install" — instructed
  // flow_install, render_agent_definition, tool_grant and render_harness_config, all on
  // /admin/mcp, with `tools: []` and no `servers`, so its agent carried zz-core and nothing
  // else. Every account gets that agent, and every one of them was told to perform an install
  // it had no way to perform.
  //
  // Reachable = the baseline (/core, in every agent and the required package) plus whatever
  // the manifest declares: `tools` for blocks, `servers` for platform surfaces.
  const surfaceOf = new Map();
  const registered = (src, from, to) => {
    const body = to === undefined ? src.slice(from) : src.slice(from, to);
    return [...body.matchAll(/registerTool\(\s*\n?\s*"([a-z0-9_]+)"/g)].map((m) => m[1]);
  };
  const core = zzCoreSource();
  const gw = gatewaySource();
  const adm = readFileSync(join(root, "services/gateway/src/admin.ts"), "utf8");
  // ZZ-CORE SERVES TWO DOORS, AND THIS FILED BOTH UNDER /core/mcp. `zzCoreSource()` is the
  // whole of services/zz-core/src as one text, so every tool that service registers was mapped
  // to the door every account already carries — which makes the clause below unfalsifiable for
  // those tools: a package that declares no `servers` at all still "reaches" /core/mcp. Task
  // I-20 moved the ten `plugin_*` tools onto /eval/mcp, which only the flow that declares it
  // carries, so a skill of any other flow instructing one of them is now exactly the COMPLETE
  // AND UNREACHABLE shape above — and was invisible here.
  //
  // DERIVED FROM THE DOOR FILE'S OWN IMPORTS, not from where the modules sit. eval-door.ts is
  // the function the service mounts, so what it imports is that door's surface by
  // construction; a module that moves directory again changes nothing here. Same derivation
  // checks/eval-door.mjs uses, and for the same reason.
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
  // BOTH CONTROLS, because either half collapsing makes this check pass on nothing. No eval
  // tools and every zz-core tool is on /core/mcp again — the state this paragraph replaced.
  // No core tools and the /core/mcp baseline is unrepresented, so `reach` is never exercised.
  if (!evalTools.size) return `${EVAL_DOOR} registers no tool this check can see (${evalMods.length} module(s) imported), so zz-core's whole surface would be filed under /core/mcp`;
  for (const t of registered(core, 0)) surfaceOf.set(t, evalTools.has(t) ? "/eval/mcp" : "/core/mcp");
  if (![...surfaceOf.values()].includes("/core/mcp")) return "not one tool zz-core registers was attributed to /core/mcp — the split put everything on the evaluation door";
  const manageRegion = between(gw, "async function buildAccessServer", "\nserveMcp(app,");
  if (!manageRegion.text) return `the access server cannot be located: ${manageRegion.why}`;
  for (const t of registered(manageRegion.text, 0)) surfaceOf.set(t, "/manage/mcp");
  // Everything in admin.ts is on /manage too, since the admin door was retired: registerShelf
  // and registerAdminTools are both mounted by buildAccessServer. What used to separate them
  // was the URL; what separates them now is the caller's role, which is a different check
  // ("the shelf is on the door everyone has, and installing is not").
  for (const t of registered(adm, 0)) surfaceOf.set(t, "/manage/mcp");

  const bad = [];
  // THE OTHER DIRECTION IS REPORTED, NOT FAILED. A tool on a door a package reaches that none
  // of that package's skills names is a fact worth a reader's eye and not a defect: the tool
  // list reaches the agent with its own description, and a person may call it directly without
  // any skill pointing there. Failing on it would make "nobody wrote a sentence about this
  // yet" a release blocker. The two places where untaught IS fatal already fail on their own —
  // "every tool on the access door is taught by a skill that ships with it", because zz-access
  // is the only thing describing /manage, and "every zz-core tool is named by a skill somebody
  // loads". This line is per-PACKAGE, which neither of those is.
  //
  // THE DOORS THE MANIFEST ITSELF DECLARES, not the baseline every package carries. A report
  // that named the /core tools each package leaves unmentioned would say the same twenty
  // things about all four of them — the baseline's own coverage is the check named above, once
  // — and a report nobody reads is worth less than no report. What is left is the question a
  // reader can act on: this package asked for a door, and ships nothing that points at part
  // of it.
  const unnamed = [];
  for (const f of flows) {
    const mf = join(f.dir, "flow.json");
    const m = JSON.parse(readFileSync(mf, "utf8"));
    const declared = new Set((m.servers ?? []).map((sv) => sv.path).filter((p) => p !== "/core/mcp"));
    const reach = new Set(["/core/mcp", ...(m.servers ?? []).map((sv) => sv.path)]);
    const skillsDir = join(f.dir, "skills");
    if (!existsSync(skillsDir)) continue;
    const named = new Set();
    for (const sk of readdirSync(skillsDir)) {
      const md = join(skillsDir, sk, "SKILL.md");
      if (!existsSync(md)) continue;
      const txt = readFileSync(md, "utf8");
      for (const [tool, surface] of surfaceOf) {
        // Named as a CALL — `tool(` or `tool` in backticks — not merely mentioned in prose.
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
  // NAMED IN THE LINE ITSELF. `check()` runs this function before it prints its own ✓, so an
  // unattributed note appears ABOVE its check and reads as belonging to the one before.
  if (unnamed.length) note(`      reachability — exposed and unnamed (reported, not failed):\n${unnamed.join("\n")}`);
  return bad.length
    ? `${bad.join("; ")} — declare the surface in the manifest's \`servers\`, or stop instructing the tool`
    : null;
});

check("every tool in packages/tools is reachable from zz-tool", () => {
  // A tool that runs only when somebody remembers its dist path is a tool nobody runs. The
  // wrapper's alias table IS the surface — it is what the usage line prints and the only
  // thing that forwards the right environment — so a file that is not in it is dormant code
  // wearing an entry point.
  //
  // Both directions. An alias pointing at a file that no longer exists fails at the moment
  // somebody needs it, which is exactly when a broken tool costs most.
  const wrapper = readFileSync(join(root, "deploy/zz-tool"), "utf8");
  const aliased = new Set([...wrapper.matchAll(/\[[a-z-]+\]=([a-z-]+\/[a-z-]+)/g)].map((m) => m[1]));
  const bad = [];
  // AN ENTRY POINT IS `process.exit(main(…))`, which is the shape the sibling check
  // "a testing engine's exit status comes from its results" requires of every one of these
  // files. This looked for a bare `main();` line, and not one tool has ever been written
  // that way — so this direction of the check could not fire, in the check whose own comment
  // calls an unaliased tool "dormant code wearing an entry point". The two checks disagreed
  // about what an entry point is, and the one that decides coverage lost.
  for (const rel of sourceFiles(["packages/tools/src/ops", "packages/tools/src/testing"], [".ts"])) {
    const src = readFileSync(join(root, rel), "utf8");
    // A module imported by another tool is a library, not an entry point.
    if (!/^process\.exit\((await )?main\(/m.test(src)) continue;
    // And a SELF-CONTAINED check is not an operator's tool. zz-tool's own first line says it
    // runs tools on a deployment host; mcp-client-check takes no arguments, reads no
    // environment and contacts nothing — this gate runs it itself. A tool that reads its
    // configuration is one somebody points at a deployment, and belongs on both surfaces.
    // (This named classify-cases beside it, a tool whose source is no longer in the tree.)
    if (!/parseArgs\(|process\.env\./.test(src)) continue;
    const key = rel.replace("packages/tools/src/", "").replace(/\.ts$/, "");
    if (!aliased.has(key)) bad.push(`${key} is an entry point with no zz-tool alias`);
  }
  for (const rel of aliased) {
    if (!existsSync(join(root, "packages/tools/src", `${rel}.ts`))) {
      bad.push(`zz-tool aliases ${rel}, which does not exist`);
    }
  }
  // And an npm script, like every other tool has. Two ways in is not duplication here:
  // zz-tool runs it on a DEPLOY HOST inside the published image with no toolchain, and the
  // npm script runs it in a checkout. A tool with only one of them is reachable from only
  // one of the two places anybody actually stands, and the three added this release each
  // had only the first until this check asked.
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
  // /manage is the ONE door ZZ Access carries, and its two skills are the only thing that
  // tells an agent these tools exist. A tool registered there and unmentioned is dormant from
  // the only place it can be reached — which is how the team-wide credential setter shipped,
  // back when there was one: the feature that exists so a new joiner works on day one was
  // invisible at the exact moment somebody was blocked on a missing key.
  //
  // It got worse than one tool. When the admin door existed, its package shipped no skills at
  // all, so twenty tools — every principal, team, grant and token on the platform — were
  // registered and taught by nothing. Retiring that door put them on this one, which is why
  // this check now reads BOTH skills in the package: zz-access for the person in front of
  // you, zz-admin for everybody else. Which of the two teaches a tool is an editorial
  // decision; that one of them does is not.
  //
  // "Complete and unreachable" is the most expensive shape here, because nothing fails.
  const src = gatewaySource();
  const adm = readFileSync(join(root, "services/gateway/src/admin.ts"), "utf8");
  const region = between(src, "async function buildAccessServer", "\n// ------");
  if (!region.text) return `the access server's registrations cannot be located: ${region.why}`;
  const grab = (t) => [...t.matchAll(/registerTool\(\s*\n?\s*"([a-z0-9_]+)"/g)].map((m) => m[1]);
  const tools = [...new Set([...grab(region.text), ...grab(adm)])];
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
  // agent with its own description, so this is softer — but a tool no skill mentions is one
  // the flows were not written around, and knowledge_reindex was exactly that: the answer to
  // "search returned a document that is gone", named nowhere anybody would look for it.
  //
  // Skills, not documentation. The question is whether an agent following a method is ever
  // pointed at it, and a mention in the README does not do that.
  const core = zzCoreSource();
  const tools = [...core.matchAll(/registerTool\(\s*\n?\s*"([a-z0-9_]+)"/g)].map((m) => m[1]);
  let taught = "";
  for (const rel of sourceFiles(["skills", "catalog"], ["SKILL.md"])) {
    taught += readFileSync(join(root, rel), "utf8");
  }
  // AS A TOOL, not as a word. `\b<name>\b` accepted any prose use — and the tool now called
  // `knowledge_reconcile` was called `reconcile`, an ordinary English verb, so four skills
  // saying "contradictions reconciled in the open" and "reconciliation notes" satisfied this
  // check about a tool none of them mentions. The rename removes that particular collision and
  // not the rule: `document_list` and `skill_read` are still words a skill can use in prose. It is
  // genuinely taught, by zz-kb-usage, with both call forms; nothing here noticed that the
  // evidence came from somewhere else entirely. A check that would go on passing after the
  // one real mention was deleted is checking the wrong thing.
  //
  // Backticked or called is what naming a TOOL looks like in these files, and it is the same
  // convention the migration comments were held to: a name in backticks is one something can
  // verify. The one skill this newly caught was zz-okr, which named `okr_grade` properly and
  // mentioned okr_set only in a parenthesis in its own description — so the skill about
  // WRITING an OKR never named the tool that writes one.
  const bad = tools.filter((t) => !new RegExp(`\`${t}[(\`]|\\b${t}\\(`).test(taught));
  return bad.length
    ? `${bad.join(", ")} on /core and no skill names ${bad.length > 1 ? "them" : "it"} as a ` +
      "tool — a bare mention of the word is not teaching an agent to call it"
    : null;
});

check("no tool teaches a date format the platform does not use", () => {
  // Folders are named YYYY-MM-DD-<slug>, and 0.3.4 made them so precisely because the two
  // forms disagreed: one initiative held `updated_at: 2026-08-29` inside a folder called
  // `29-08-2026-…`. The platform stamps ISO and sorts on it.
  //
  // Four tool descriptions went on offering `23-08-2026-sample-intake` as the example. That is
  // prompt text a model reads and copies, so the platform was enforcing one convention and
  // demonstrating the other — and a folder is chosen before any document exists, so no later
  // stamp repairs it. Three of the four were on tools added after the change, by copying the
  // shape from the tool beside them.
  //
  // Comments are exempt: the incidents that produced this rule are narrated with the dates
  // they happened on, and rewriting those would be falsifying the record.
  // EVERY piece of prompt text, not the three files the four bad descriptions happened to be
  // in. A skill is prompt text by definition — more of it than any tool description — and an
  // example folder name in one is copied exactly as readily. Three of the four originals were
  // written by copying the shape from the tool beside them, which is the same way it spreads
  // between a skill and its neighbour.
  const bad = [];
  for (const f of sourceFiles(["services", "skills", "catalog"], [".ts", "SKILL.md", "system-prompt.md"])) {
    const src = readFileSync(join(root, f), "utf8");
    const isTs = f.endsWith(".ts");
    for (const [i, line] of src.split("\n").entries()) {
      if (isTs && /^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      if (isTs && !/description:|\.describe\(/.test(line) && !/^\s*"/.test(line)) continue;
      if (!/\b\d{2}-\d{2}-20\d{2}\b/.test(line)) continue;
      // A line carrying BOTH forms is contrasting them, which is how the rule gets explained
      // — zz-platform narrates the initiative that held `2026-08-29` in a folder called
      // `29-08-2026-…`, and rewriting that would falsify the record it exists to keep.
      if (/\b20\d{2}-\d{2}-\d{2}\b/.test(line)) continue;
      bad.push(`${f}:${i + 1} shows a DD-MM-YYYY date; folders are YYYY-MM-DD`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("a tool a block's own skill tells an agent to call is a tool the agent has", () => {
  // FOUND BY A RUN THAT DID EVERYTHING RIGHT. the block's usage skill names
  // `create_rule_now` as the route to take when `create_rule` is refused
  // by the interface. It was not on the block's allowlist in blocks.ts, so no agent has ever been
  // able to call it — and round 4 of the 09-09 smoke said so in as many words: "route 2
  // absent from this session's surface". The skill said take it; the platform had never
  // handed it over. Four rounds parked the same leg UNVERIFIED for want of one list entry.
  //
  // A skill and an allowlist drifting apart is silent in both directions: the skill reads
  // fine, the allowlist reads fine, and only an agent standing between them finds out.
  const coreTools = new Set(zzCoreTools().map((t) => t.name));
  const blocksSrc = readFileSync(join(root, "services/gateway/src/blocks.ts"), "utf8");
  const bad = [];
  const blocksDir = join(root, "blocks");
  if (!existsSync(blocksDir)) return null;
  for (const slug of readdirSync(blocksDir)) {
    const skillsDir = join(blocksDir, slug, "skills");
    if (!existsSync(skillsDir)) continue;
    // The block's own slice of the allowlist: from `slug:` to the end of its `tools:` array.
    const at = blocksSrc.indexOf(`${slug}:`);
    if (at < 0) continue;
    const toolsAt = blocksSrc.indexOf("tools: [", at);
    if (toolsAt < 0) continue;
    const allow = blocksSrc.slice(toolsAt, blocksSrc.indexOf("]", toolsAt));
    for (const skill of readdirSync(skillsDir)) {
      const f = join(skillsDir, skill, "SKILL.md");
      if (!existsSync(f)) continue;
      const text = readFileSync(f, "utf8");
      // CONSERVATIVE: a backticked identifier in CALL form, `name(`. That is how a skill
      // writes "call this", and it does not match prose, headings or field names.
      for (const m of text.matchAll(/`([a-z][a-z0-9_]{6,})\(/g)) {
        const name = m[1];
        // The platform's own tools are served by zz-core, not by the block, and are never on
        // a block's allowlist. DERIVED from zz-core's registrations rather than written out:
        // this was a nineteen-name array that had to be retyped at every rename, and the two
        // renames this fortnight each left it naming tools that no longer existed while a newly
        // named one read as a block tool the block had failed to allowlist. zz-core ONLY, not
        // every door — a block skill naming a /manage tool is not reaching for something the
        // block serves either, and widening this to the gateway would wave that through.
        if (coreTools.has(name)) continue;
        if (!allow.includes(`"${name}"`)) {
          bad.push(`${slug}/${skill} tells an agent to call \`${name}()\` and it is not on ${slug}'s tools list in blocks.ts — the skill says take it, the platform never hands it over`);
        }
      }
    }
  }
  return bad.length ? [...new Set(bad)].join("; ") : null;
});
