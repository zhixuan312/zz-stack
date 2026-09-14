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
import { check } from "../run.mjs";
import { catalogRoot, flows, platformSkills, skillsOf } from "../facts.mjs";

check("no tool description teaches a path form the platform refuses", () => {
  // document_read said "Read a file from your .zz artifact store" while safePath had just
  // started REFUSING a .zz/ prefix — the tool's own description inviting the shape its
  // implementation rejects, in the sentence a model reads before deciding how to call it.
  // Three tools carried it.
  const bad = [];
  // Every service source, not each service's server.ts. admin.ts registers twenty tools of
  // its own and was never looked at, and a description there is read by exactly the same
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
  // zz-access told people to store a key with `set_credential`. The tools are
  // `credential_set` and `set_team_credential`; nothing has ever been called `set_credential`.
  // An agent following that goes looking for a tool the platform does not have, and this
  // repository has spent a day on what happens next — it reaches for a block's tool whose name
  // is close, then reports that the platform cannot do the thing.
  //
  // Only the platform's own verb shapes are checked. A block tool named in a skill is that
  // block's business and may be absent from this deployment; a `set_`/`approve_`/`journal_` name
  // is ours, and if we do not serve it, nobody does.
  // The PLATFORM'S OWN namespace, not every verb. `read_api_spec` and `get_platform_overview`
  // are block tools that the building-block contract REQUIRES every block to publish, and
  // skills name them properly; a rule wide enough to catch `set_credential` by its verb also
  // catches those, and a check that cries wolf gets an exception list and then gets ignored.
  // These stems are ours and no block publishes them.
  // `render_` IS OURS AND WAS MISSING, which is how a skill kept telling an admin to call
  // render_agent_definition for a whole session after that tool was deleted. Both tools that
  // ever carried the stem — render_agent_definition and render_harness_config — were the
  // platform's, and no block publishes it.
  // `revise_` AND `reindex_` WERE STEMS AND ARE NOW NAMES. They earned their place as stems
  // when the tools were `revise_document` and `reindex_knowledge`; the noun-first rename left
  // both stems matching nothing of ours, so a block publishing `revise_booking` would have
  // been reported as a platform tool that does not exist. The two names they covered are
  // spelled out instead — the same coverage, and no stem staking a claim on a word we no
  // longer own.
  //
  // THE SAME THING HAPPENED AGAIN TO /manage, one rename later. `my_credential`, `admin_`,
  // `set_[a-z_]*credential` and `delete_[a-z_]*credential` were this door's stems, and after
  // Task I-22 not one of them matched a tool that exists — so a skill naming a dead /manage
  // tool would have been waved through by the check whose whole job is to catch that. The
  // thirty names are written out for the same reason the two above are: a closed set we own
  // outright, with no stem claiming `set_`, `admin_` or `my_` on behalf of a door that no
  // longer speaks that way. They are exactly `Object.values(MANAGE_ALIAS)` plus `whoami`;
  // checks/manage-surface.mjs is what keeps the door itself matching that list.
  const MANAGE = ["whoami", "person_add", "person_deactivate", "person_list", "team_create",
    "team_archive", "team_list", "team_switch", "team_mine", "member_add", "member_remove",
    "pat_issue", "pat_revoke", "pat_list", "flow_install", "flow_uninstall", "install_list",
    "tool_grant", "tool_revoke", "enrolment_issue", "block_connect", "block_disconnect",
    "platform_list", "credential_set", "credential_list", "credential_delete",
    "credential_admin_set", "credential_admin_delete", "client_setup", "catalog_list"];
  const OURS = new RegExp(`^(journal_|okr_|document_revise|knowledge_reindex|initiative_|render_|skill_read$|skill_list$|document_write|document_read|document_patch|document_list|source_add|source_list|knowledge_search|${MANAGE.map((n) => `${n}$`).join("|")})`);
  const served = new Set();
  // zz-core asked as a SERVICE and the gateway's doors by name: zz-core's registrations are
  // spread across modules, so a list of its files goes short the moment a door is added.
  for (const { name } of zzCoreTools()) served.add(name);
  // THE GATEWAY AS A SERVICE. Its access door moved out of server.ts into access-door.ts,
  // and a list of files goes short the moment a door is added.
  for (const m of gatewaySource().matchAll(/registerTool\(\s*\n?\s*"([a-z_0-9]+)"/g)) served.add(m[1]);
  if (served.size < 30) return null;   // the shape of those files changed; other checks say so
  served.add("credential_required");   // served by a block only to someone who cannot reach it
  // A block's own tools are named in skills too and are that block's business, so anything a
  // block registers is left alone even where this deployment cannot reach it. That used to be
  // a loop over casebox/RuleMill/bookit reading blocks/<b>/skills — and its body was a single
  // `continue`, so it read nothing and decided nothing. It became a no-op when those blocks
  // moved to their own repository, and looked like the mechanism enforcing this paragraph.
  // The `OURS` stems above are what actually does it: a name outside them is a block's.
  const bad = [];
  const every = [...platformSkills().map((s) => s.path)];
  for (const f of flows) for (const s of skillsOf(f)) every.push(s.path);
  for (const f of every) {
    const txt = readFileSync(f, "utf8");
    for (const m of txt.matchAll(/`([a-z][a-z0-9_]{3,40})[`(]/g)) {
      const name = m[1];
      if (!OURS.test(name) || served.has(name)) continue;
      bad.push(`${f.replace(root + "/", "")} names \`${name}\`, which no platform server registers`);
    }
  }
  return bad.length ? [...new Set(bad)].join("; ") : null;
});

check("the backbone's roster of platform tools is the tools zz-core serves", () => {
  // zz-backbone names all twenty-one and tells an agent that anything NOT on the list belongs
  // to a building block. That makes the list load-bearing: an agent uses it to decide whether
  // `document_approve` is a gate or somebody's booking approval, and one session got that wrong
  // four times in a row and told the person the platform had no approve action at all. The
  // noun-first rename narrows that confusion without ending it: `document_approve` says which
  // noun it acts on, and a block is still free to publish `approve_slot`.
  //
  // A hand-written roster is exactly the thing that stops being true — a tool added to zz-core
  // and not to the skill is a tool the next agent is told does not belong to us. So the list is
  // checked against the registrations rather than trusted.
  const src = zzCoreSource();
  const served = new Set();
  for (const m of src.matchAll(/registerTool\(\s*\n?\s*"([a-z_0-9]+)"/g)) served.add(m[1]);
  if (served.size < 10) return null;   // the shape of the source changed; a later check says so
  const skill = readFileSync(join(root, "skills/zz-backbone/SKILL.md"), "utf8");
  const start = skill.indexOf("THE PLATFORM'S TOOLS ARE THESE");
  if (start < 0) return "zz-backbone no longer carries a roster of the platform's tools";
  const table = skill.slice(start, skill.indexOf("A tool NOT on that list", start));
  const listed = new Set([...table.matchAll(/`([a-z_0-9]+)`/g)].map((m) => m[1]));
  const missing = [...served].filter((t) => !listed.has(t)).sort();
  const extra = [...listed].filter((t) => !served.has(t)).sort();
  const bad = [];
  if (missing.length) {
    bad.push(`zz-core serves ${missing.join(", ")} and the roster omits them — an agent reading ` +
             "that skill is told they belong to a building block");
  }
  if (extra.length) bad.push(`the roster names ${extra.join(", ")}, which zz-core does not serve`);
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
  for (const t of registered(core, 0)) surfaceOf.set(t, "/core/mcp");
  const manageRegion = between(gw, "async function buildAccessServer", "\nserveMcp(app,");
  if (!manageRegion.text) return `the access server cannot be located: ${manageRegion.why}`;
  for (const t of registered(manageRegion.text, 0)) surfaceOf.set(t, "/manage/mcp");
  // Everything in admin.ts is on /manage too, since the admin door was retired: registerShelf
  // and registerAdminTools are both mounted by buildAccessServer. What used to separate them
  // was the URL; what separates them now is the caller's role, which is a different check
  // ("the shelf is on the door everyone has, and installing is not").
  for (const t of registered(adm, 0)) surfaceOf.set(t, "/manage/mcp");

  const bad = [];
  for (const f of flows) {
    const mf = join(f.dir, "flow.json");
    const m = JSON.parse(readFileSync(mf, "utf8"));
    const reach = new Set(["/core/mcp", ...(m.servers ?? []).map((sv) => sv.path)]);
    const skillsDir = join(f.dir, "skills");
    if (!existsSync(skillsDir)) continue;
    for (const sk of readdirSync(skillsDir)) {
      const md = join(skillsDir, sk, "SKILL.md");
      if (!existsSync(md)) continue;
      const txt = readFileSync(md, "utf8");
      for (const [tool, surface] of surfaceOf) {
        // Named as a CALL — `tool(` or `tool` in backticks — not merely mentioned in prose.
        if (!new RegExp("`" + tool + "[(`]").test(txt)) continue;
        if (!reach.has(surface)) {
          bad.push(`${f.owner}/${f.flow}/${sk} instructs ${tool} (${surface}), which its package cannot reach`);
        }
      }
    }
  }
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
  // the only place it can be reached — which is how set_team_credential shipped: the feature
  // that exists so a new joiner works on day one was invisible at the exact moment somebody
  // was blocked on a missing key.
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
      // — zz-backbone narrates the initiative that held `2026-08-29` in a folder called
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
        // a block's allowlist. zz-backbone enumerates them; these are the ones block skills
        // actually reach for.
        if (["skill_read", "knowledge_add", "document_write", "document_read", "document_patch",
             "document_list", "document_approve", "initiative_close", "source_add", "source_list",
             "knowledge_search", "initiative_status", "session_whoami",
             "document_revise", "knowledge_reindex",
             "knowledge_supersede", "document_present", "skill_list", "knowledge_reconcile"].includes(name)) continue;
        if (!allow.includes(`"${name}"`)) {
          bad.push(`${slug}/${skill} tells an agent to call \`${name}()\` and it is not on ${slug}'s tools list in blocks.ts — the skill says take it, the platform never hands it over`);
        }
      }
    }
  }
  return bad.length ? [...new Set(bad)].join("; ") : null;
});
