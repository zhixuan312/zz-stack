/**
 * The two shelves, and the handover that fills them.
 *
 * A node is `scope: "platform"` or `scope: "team"` and the distinction is the entire design:
 * one shelf every team reads, one shelf that is this team's own. Checks here hold the
 * scope, the registry tag a platform node owes, supersession staying on one shelf, and the
 * handover chain every flow ends with — including that an approved handover actually minted
 * the team nodes its own prose promised.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { gatewaySource, root, zzCoreSource } from "../read.ts";
import { check } from "../run.ts";
import { catalogRoot, flows } from "../facts.ts";

check("_knowledge is never recorded as an initiative", () => {
  // It is the reserved directory the knowledge store lives in. reconcileRuns' UPDATE excluded
  // it and its INSERT did not, so every deployment grew a _knowledge initiative row — and runs
  // were filed against it: 299 on production, attributed to something nobody can open.
  //
  // Both statements, because one of them already knew.
  const src = readFileSync(join(root, "services/gateway/src/runs.ts"), "utf8");
  const ins = /insert into zz\.initiative[\s\S]*?on conflict/.exec(src)?.[0] ?? "";
  const bad: string[] = [];
  if (!ins) return "reconcileRuns no longer inserts initiatives — this check reads nothing";
  // THE COMMENTS ARE STRIPPED FIRST. Written without this, the test passed on the word
  // "_knowledge" appearing in the comment that explains the exclusion — so deleting the
  // exclusion itself left the check green. A check that cannot fail is not a check, and this
  // one was caught only because the failure mode was deliberately reproduced.
  const sql = ins.replace(/--[^\n]*/g, "");
  if (!/_knowledge/.test(sql)) {
    bad.push("the insert into zz.initiative does not exclude _knowledge, though the update " +
             "below it does — that disagreement is what created the rows");
  }
  // A backtick inside a SQL comment closes the template literal the statement lives in. That
  // has broken this repository twice; the comment added with the fix says so, and this keeps
  // the next person from re-adding one.
  const lits = src.match(/`[\s\S]*?`/g) ?? [];
  for (const l of lits) {
    if (/^\s*--.*`/m.test(l.slice(1, -1))) bad.push("a SQL comment inside a template literal contains a backtick");
  }
  return bad.length ? bad.join("; ") : null;
});

check("every flow ends with the platform's handover", () => {
  // Delivery ends at close; the cycle does not. What a run learned is worth more to the next
  // initiative than its deliverable, and it is gone when the conversation ends.
  //
  // That cannot be the flow author's decision. sdlc-flow wrote itself a recording stage,
  // ops-flow's close is mechanical, and a flow written next week does whatever its author
  // thought of — so "what gets captured" varied by flow, which is the definition of a thing
  // the platform should own. initiative_status appends the step BELOW the manifest, so every
  // flow ends the same way and no manifest can drop it.
  //
  // Three things have to hold together, and each has broken separately elsewhere: the step
  // is named where the next move is computed, the skill it names exists, and that skill is a
  // platform entry every team can read rather than one a team must install.
  const src = zzCoreSource();
  const bad: string[] = [];
  if (!/action: "handover"/.test(src)) {
    bad.push("initiative_status never returns action: handover — a closed initiative reports done with nothing handed over");
  }
  if (!/zz-handover/.test(src)) bad.push("nothing in zz-core names the handover skill");
  // And the flow that CLOSES has to know the step exists. A closing skill saying "you are
  // the last stage, nobody after you can do it" was true until the platform started
  // appending the handover below the manifest — after which the agent closes, reports
  // finished, and meets `action: handover` on its next call to initiative_status with
  // nothing having told it that was coming.
  for (const f of flows) {
    const fjp = join(f.dir, "flow.json");
    const skillsDir = join(f.dir, "skills");
    if (!existsSync(skillsDir)) continue;
    if (!(JSON.parse(readFileSync(fjp, "utf8")).documents ?? []).some((d: { closing?: boolean }) => d.closing)) continue;
    // The skill that calls initiative_close() is the one that has to say what follows it.
    for (const sk of readdirSync(skillsDir)) {
      const md = join(skillsDir, sk, "SKILL.md");
      if (!existsSync(md)) continue;
      const text = readFileSync(md, "utf8");
      // A skill that PERFORMS the close, not one that names the act. `initiative_close(initiative`
      // alone missed sdlc-flow, which writes "one `initiative_close()` call against spec.md" and then
      // said "Nothing runs after this stage" — the entry skill describing the whole
      // sequence, with the appended step absent from it. Matching any `initiative_close(` then caught
      // sdlc-method, which only says which fields come "from document_approve() and initiative_close()".
      //
      // So: a call with an argument, or the plain English for doing it.
      if (!/initiative_close\(\s*(initiative|"|<)/.test(text) && !/closes? the initiative/i.test(text)) continue;
      if (!/handover|zz-handover/.test(text)) {
        bad.push(`${f.owner}/${f.flow}/${sk} calls initiative_close() and never mentions the handover that follows it`);
      }
    }
  }
  // zz-handover stopped being a flow of its own on 2026-09-04 and became a PLATFORM SKILL, the
  // bookend to zz-platform: the spine is loaded at the start of every flow, the handover is
  // run at the end of every one. A capability every flow must finish with is not something a
  // team installs, and it was never really a flow — it had one stage and no gates.
  const learnSkill = join(root, "skills", "zz-handover", "SKILL.md");
  if (!existsSync(learnSkill)) {
    bad.push("skills/zz-handover is missing — every flow names the handover and nothing performs it");
  }
  return bad.length ? bad.join("; ") : null;
});

check("the platform's own knowledge has a home, and it is reserved", () => {
  // The platform learns things every day that belong to no tenant: that a block returns a
  // bare 422 and still has not been fixed, that most of a block's tools describe themselves by
  // restating their own name, that a rule we wrote was strict enough for six of six real
  // documents to break it. That knowledge is about REGISTRY ENTRIES — a block, a flow, a
  // provider, an interface — and it had no home, so it lived in a hand-written appendix, in
  // STATE.md paragraphs and in commit messages, none of which can be queried.
  //
  // The platform is a tenant. It gets an ordinary team with the ordinary store and the same
  // _knowledge/ every tenant has — zero new mechanism, which is the point. Two things have
  // to be true together: the bootstrap creates it, and team_create refuses it. Seeded but
  // claimable means a tenant can end up reading and writing the platform's own record;
  // reserved but never seeded means the home is a name with nothing behind it.
  const identity = readFileSync(join(root, "services/gateway/src/identity.ts"), "utf8");
  const db = readFileSync(join(root, "services/gateway/src/db.ts"), "utf8");
  const admin = gatewaySource();
  const bad: string[] = [];
  const m = /export const PLATFORM_TEAM = "([a-z0-9][a-z0-9_-]*)"/.exec(identity);
  if (!m) {
    bad.push("identity.ts does not name the platform's team");
  } else {
    // It is a team slug like any other — the guard that keeps a slug out of a filesystem
    // path applies to this one too, and a reserved name that cannot be a path is a trap.
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(m[1])) {
      bad.push(`PLATFORM_TEAM "${m[1]}" is not a legal team slug`);
    }
    // The USE, not the import. Testing for the identifier anywhere in the file passed on
    // the import line alone, so deleting the guard left this check green — the exact
    // failure it exists to catch.
    if (!/insert into team[\s\S]{0,200}PLATFORM_TEAM/.test(db)) {
      bad.push("the bootstrap never seeds the platform team");
    }
    // AND NOT BEHIND AN OPTIONAL SETTING. The seed sat below the BOOTSTRAP_TEAM block and
    // inside its early return, so an install that set a superadmin and left BOOTSTRAP_TEAM
    // empty — which deploy/README.md warns against and nothing prevents — reserved this slug
    // and never created it. That is the exact half-state the paragraph above forbids, and the
    // presence test could not see it: the insert was there, and unreachable.
    const platformAt = db.indexOf("PLATFORM_TEAM, \"ZZ Platform\"");
    const bootstrapAt = db.indexOf("process.env.BOOTSTRAP_TEAM");
    if (platformAt < 0) {
      bad.push("the platform team's seed is no longer where this can find it");
    } else if (bootstrapAt >= 0 && platformAt > bootstrapAt) {
      bad.push("the platform team is seeded after BOOTSTRAP_TEAM is read — an install that " +
               "leaves that empty returns first, and the platform's own team is never created");
    }
    if (!/===\s*PLATFORM_TEAM|PLATFORM_TEAM\s*===/.test(admin)) {
      bad.push("team_create does not reserve the platform team — a tenant could claim it");
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("the second distillation exists and is reachable", () => {
  // A lesson written for one team stays useful to one team until somebody generalises it,
  // and that is the only real advantage a shared knowledge base has over many separate
  // ones. It does not happen on its own: zz-handover records what a cycle taught THAT team,
  // and some of it is a fact about a plugin, a provider or an interface that every
  // team depends on.
  //
  // The tenant is deliberately not asked to sort their own experience into "ours" and
  // "everyone's" — that hands platform work to the user. So the promoting act has to exist
  // as its own skill, and zz-handover has to say where its platform-layer findings go, or the
  // handover ends in a file nobody reads twice.
  const bad = [];
  const distil = join(root, "skills/zz-handover/SKILL.md");
  if (!existsSync(distil)) {
    bad.push("skills/zz-handover is missing — nothing promotes a tenant's finding to platform knowledge");
    return bad.join("; ");
  }
  const text = readFileSync(distil, "utf8");
  // It must name the closed subject vocabulary it writes against, and the evidence rule —
  // an unsourced conclusion about a plugin is the thing nobody can check later.
  //
  // `plugin:`, not `block:`. A plugin is the only installable thing on this platform, so it
  // is what a knowledge node is about. SUBJECT_KINDS in zz-core is the authority and this
  // list follows it — the skill must teach the vocabulary the tool enforces, or an agent
  // writes a tag that is refused at the write.
  for (const need of ["knowledge_add", "plugin:", "flow:", "evidence"]) {
    if (!text.includes(need)) bad.push(`zz-handover never mentions ${need}`);
  }
  const learn = readFileSync(join(root, "skills/zz-handover/SKILL.md"), "utf8");
  if (!learn.includes("zz-handover")) {
    bad.push("zz-handover does not name zz-handover — its platform-layer findings have no onward path");
  }
  return bad.length ? bad.join("; ") : null;
});

check("the shelf is on the door everyone has, and installing is not", () => {
  // Seeing what your team COULD run and deciding what it DOES run are different acts, and
  // they are separated by ROLE. catalog_list is registered for everybody — a person's own
  // access, and browsing is nobody's privilege; flow_install is registered only for a caller
  // who administers a team, because it changes what a whole team runs.
  //
  // This used to be a separation by DOOR, /manage against /admin, and the door was retired
  // because it authorised nothing: any member could open /admin, see every tool, and be
  // refused by each. The invariant survived the door and is now written where it always
  // belonged — in which tier each tool is registered under.
  //
  // The failure this refuses is quiet in both directions. Gate the shelf behind `sup` or
  // `lead` and discovery disappears for everyone else, with no error anywhere — the tool
  // simply is not there, and the only way left to find a flow is to guess its name at
  // flow_install and read the refusal. Register flow_install unconditionally and any member
  // is offered a tool that changes what their whole team runs.
  //
  // Comments stripped first. Testing the raw text passed on `// registerShelf(server)` —
  // found by commenting the line out to check this check, which is the whole reason to try
  // breaking one rather than trusting that it works.
  const liveText = (t: string): string => t.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  // THE WHOLE GATEWAY: buildAccessServer is access-door.ts now, not server.ts.
  const server = liveText(gatewaySource());
  const admin = liveText(gatewaySource());
  const bad: string[] = [];
  // The access server is the one that mounts both halves; each lives with the code answering it.
  if (!/registerShelf\(server\)/.test(server)) {
    bad.push("the access surface does not mount the shelf — nobody can browse the catalog");
  }
  if (!/registerAdminTools\(server, id\)/.test(server)) {
    bad.push("the access surface does not mount the admin tools — administering the platform is unreachable");
  }
  // How each tool is registered, read straight off the source: an `if (sup)` or `if (lead)`
  // prefix is the tier, and its absence is "everyone".
  const tierOf = (name: string): string | null => {
    const m = new RegExp("(if \\((sup|lead)\\) )?server\\.registerTool\\(\\s*\\n?\\s*\"" + name + "\"").exec(admin + server);
    return m ? (m[2] ?? "everyone") : null;
  };
  for (const [name, want, why] of [
    ["catalog_list", "everyone", "browsing what your team could run is not a privilege"],
    ["whoami", "everyone", "it is the tool that explains a refusal, so a refused caller must have it"],
    ["flow_install", "lead", "installing changes what a whole team runs"],
    ["member_add", "lead", "team membership is a team admin's act"],
    ["person_add", "sup", "creating a principal is a platform act"],
  ]) {
    const got = tierOf(name);
    if (got === null) bad.push(`${name} is not registered anywhere`);
    else if (got !== want) bad.push(`${name} is registered for '${got}' and must be '${want}' — ${why}`);
  }
  // VISIBILITY MUST NEVER EXCEED EXECUTABILITY, and the tier predicates are how that holds.
  // Both must be derived from the same functions the handlers call, never from platformRole:
  // a superadmin on a member-scope PAT is not super for the request, so they must not be
  // offered the tools that will refuse them.
  if (!/const sup = !!id && isSuper\(id\);/.test(admin)) {
    bad.push("registerAdminTools does not derive `sup` from isSuper — visibility could exceed what a handler allows");
  }
  if (!/const lead = sup \|\| \(!!id && id\.teams\.some\(\(t\) => isTeamAdmin\(id, t\.slug\)\)\);/.test(admin)) {
    bad.push("registerAdminTools does not derive `lead` from isTeamAdmin — visibility could exceed what a handler allows");
  }
  // And the skill has to say so, or the tool exists and nobody is told to use it.
  const access = join(catalogRoot, "zz/zz-access/skills/zz-access/SKILL.md");
  if (existsSync(access) && !readFileSync(access, "utf8").includes("catalog_list")) {
    bad.push("zz-access never mentions catalog_list — the shelf is reachable and unmentioned");
  }
  return bad.length ? bad.join("; ") : null;
});

check("a knowledge node says which shelf it belongs on", () => {
  // The node format is frozen and carries no tier, so the shelf can only be said at the write.
  // A default here would make silence sayable again — which is exactly what initiative_close() had to be
  // repaired for, and what knowledge node 0097 records as the move that works: force a choice
  // between two sayable answers rather than nudging toward one.
  const src = zzCoreSource();
  const at = src.indexOf(`registerTool(\n    "knowledge_add"`);
  if (at < 0) return "knowledge_add is no longer registered";
  const body = src.slice(at, src.indexOf("\n  );", at));
  const bad: string[] = [];
  if (!/scope:\s*z\.enum\(\[\s*"team"\s*,\s*"platform"\s*\]\)/.test(body)) {
    bad.push("scope is missing or is not an enum of exactly team and platform");
  }
  if (/scope:\s*z\.enum\([^)]*\)\s*\.(optional|default)\(/.test(body)) {
    bad.push("scope is optional or defaulted — silence must not be a sayable answer");
  }
  if (!/ERROR:[^"'\n]*`scope`/.test(body)) bad.push("no refusal naming `scope`");
  return bad.length ? bad.join("; ") : null;
});

check("a knowledge node is written to the shelf its scope names", () => {
  // Before this, knowledge_add ignored the caller's team entirely: one hardcoded root, with a
  // comment saying so. DIRECTIONAL on purpose — asserting that both roots and the word
  // "platform" merely APPEAR lets an inverted implementation
  // (scope === "platform" ? userRoot() : knowledgeRoot()) satisfy every assertion while filing
  // every node on the wrong shelf.
  const src = zzCoreSource();
  const at = src.indexOf(`registerTool(\n    "knowledge_add"`);
  if (at < 0) return "knowledge_add is no longer registered";
  const body = src.slice(at, src.indexOf("\n  );", at));
  const bad: string[] = [];
  if (!/knowledgeRoot\(\)/.test(body)) bad.push("the platform shelf is unreachable from knowledge_add");
  if (!/userRoot\(\)/.test(body)) bad.push("the team shelf is unreachable from knowledge_add");
  const inverted = /scope\s*===\s*"platform"\s*\?\s*(await\s+)?userRoot\(\)/;
  const ternary = /scope\s*===\s*"platform"\s*\?\s*knowledgeRoot\(\)\s*:\s*(await\s+)?userRoot\(\)/;
  if (inverted.test(body)) {
    bad.push("the platform branch resolves userRoot() — the shelves are swapped, and every node would be filed on the wrong one");
  } else if (!ternary.test(body) && !/scope\s*===\s*"team"/.test(body)) {
    bad.push("the root is not chosen from `scope` in a form this check can read — write it as `scope === \"platform\" ? knowledgeRoot() : await userRoot()` so the direction is visible");
  }
  return bad.length ? bad.join("; ") : null;
});

check("a platform-scoped node is about a registry entry", () => {
  // The skill's own rubric says it "promotes facts about a registry entry, not about the
  // team". That was prose. This is the same rule where it can be enforced — and it reuses
  // SUBJECT_KINDS rather than restating the five, so the two cannot drift.
  //
  // NOT anchored on ERROR: with a quote-excluding class. The refusal this looks for is
  // ERROR: `scope: "platform"` needs a registry-entry tag — the quotes around the value sit
  // between the anchor and the phrase, so [^"'\n]* would stop before reaching it and the
  // check could never pass. That is knowledge node 0099's exact failure mode.
  const src = zzCoreSource();
  const at = src.indexOf(`registerTool(\n    "knowledge_add"`);
  if (at < 0) return "knowledge_add is no longer registered";
  const body = src.slice(at, src.indexOf("\n  );", at));
  if (!/SUBJECT_KINDS/.test(body)) {
    return "knowledge_add does not consult SUBJECT_KINDS — a platform node's tags are unchecked, or the five kinds were restated somewhere they can drift";
  }
  if (!/needs a registry-entry tag/.test(body)) {
    return "no refusal for a platform-scoped node carrying no registry-entry tag";
  }
  return null;
});

check("a team-scoped node cannot be written by somebody in no team", () => {
  // userRoot() falls back to a personal directory OUTSIDE teams/ when teamFor() is falsy
  // (server.ts:2374). knowledge_search and knowledge_reindex both refuse that caller;
  // knowledge_add did not — so a team node from them would have reported success and landed
  // where team-gated search can never reach it. Silent loss wearing a success message.
  const src = zzCoreSource();
  const at = src.indexOf(`registerTool(\n    "knowledge_add"`);
  if (at < 0) return "knowledge_add is no longer registered";
  const body = src.slice(at, src.indexOf("\n  );", at));
  const bad: string[] = [];
  if (!/you are not in a team/.test(body)) {
    bad.push("knowledge_add does not refuse a team-scoped write from a caller with no team — the node would land in a personal directory nothing can search");
  }
  // BOTH halves of AC-1.9. A refusal firing for every scope would satisfy the line above while
  // breaking platform writes for the same caller, which the platform shelf needs no team for.
  if (!/scope\s*===\s*"team"|"team"\s*===\s*scope/.test(body)) {
    bad.push("the teamless refusal is not scoped to `scope: \"team\"` — a platform-scoped write from a teamless caller must still succeed");
  }
  return bad.length ? bad.join("; ") : null;
});

check("every act on the knowledge base leaves a record naming who did it", () => {
  // WHAT THIS IS FOR. `knowledge_add` and `knowledge_supersede` each left three records — this
  // table, `_knowledge/log.md`, and the store's git history — and `knowledge_search` left none,
  // so the knowledge base could say what had been written into it and nothing whatever about
  // what anyone read out. "Which nodes does anybody actually read" is the question that decides
  // whether a node earned its place on a shelf of hundreds, and it had no answer.
  //
  // A tool_call row cannot serve, which is why this is a separate rule rather than a report:
  // tool_call deliberately carries NO ACTOR (tool-telemetry.ts, "no address on a measurement")
  // because it measures a skill rather than a person. The question here is about people.
  //
  // DERIVED FROM THE MODULE, not from a list of three names. The knowledge door's tools are
  // whatever `tools/knowledge.ts` registers, so a fourth one added later inherits this without
  // its author being told — which is the difference between a rule and a note. Scoped to that
  // file on purpose: `knowledge_reconcile` lives elsewhere and reads zz.decision and zz.event
  // rather than the shelves, so it is not an act on the knowledge base.
  const src = zzCoreSource();
  const MODULE = "services/zz-core/src/tools/knowledge.ts";
  const mod = readFileSync(join(root, MODULE), "utf8");
  const names = [...mod.matchAll(/registerTool\(\s*\n?\s*"(knowledge_[a-z_]+)"/g)].map((m) => m[1]);
  // A walk that finds nothing passes for the wrong reason. This module registers the knowledge
  // door; if it registers nothing, the check is reading a file that has moved.
  if (names.length < 2) {
    return `${MODULE} registers ${names.length} knowledge tool(s) — this check is reading the ` +
           "wrong file, or the module has moved, and it is measuring nothing";
  }
  const bad: string[] = [];
  for (const name of names) {
    const at = src.indexOf(`registerTool(\n    "${name}"`);
    if (at < 0) { bad.push(`${name} is no longer registered where this can read it`); continue; }
    const body = src.slice(at, src.indexOf("\n  );", at));
    if (!/knowledgeEvent\(/.test(body)) {
      bad.push(`${name} leaves no record naming the caller — it acts on the knowledge base and ` +
               "the journal cannot say who, when, or on what");
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("supersession stays on one shelf and knows which", () => {
  // Ids restart at 0001 on each new shelf, so the same number exists in two places. A resolver
  // returning only a path would silently pick whichever it looked at first, and a cross-shelf
  // supersession would quietly relabel somebody else's node.
  const src = zzCoreSource();
  const at = src.indexOf(`registerTool(\n    "knowledge_supersede"`);
  if (at < 0) return "knowledge_supersede is no longer registered";
  const body = src.slice(at, src.indexOf("\n  );", at));
  const bad: string[] = [];
  if (!/userRoot\(\)/.test(body)) bad.push("supersede cannot see the team shelf");
  if (!/knowledgeRoot\(\)/.test(body)) bad.push("supersede cannot see the platform shelf");
  if (!/ERROR:[^\n]*shelf/.test(body)) bad.push("no refusal for a cross-shelf supersession");
  return bad.length ? bad.join("; ") : null;
});

check("every flow that gates a document also carries the handover", () => {
  // The stakeholder's rule — only flows that gate and produce files — is a property the
  // manifest already states, so it is derived rather than configured. Five flows qualify
  // today; a sixth added later inherits it without its author remembering, which is the whole
  // point of deriving instead of declaring.
  const src = zzCoreSource();
  const at = src.indexOf("function deriveChain(");
  if (at < 0) return "deriveChain is gone or was renamed — every document list resolves through it";
  const body = src.slice(at, src.indexOf("\n}", at));
  const bad: string[] = [];
  if (!/handover\.md/.test(body)) bad.push("deriveChain does not derive handover.md");
  if (!/\.gate/.test(body)) bad.push("the derivation does not test for a gated document");
  if (!/What this initiative taught/.test(body)) {
    bad.push("the derived entry declares no sections — sectionCheck returns early without them and the three headings would be unenforced");
  }
  return bad.length ? bad.join("; ") : null;
});

check("the handover carries a gate and does not carry the close", () => {
  // gate: true is what makes a person sign it. closing/requiredForClose would make initiative_close()
  // demand a document that cannot exist until after the close — documentGuards skips a gated
  // document that is absent, and that is the only reason the sequence is not circular.
  const src = zzCoreSource();
  // ANCHORED ON THE ENTRY, not on the first textual occurrence of the name. The derivation
  // is preceded by a comment block that mentions handover.md several times, so indexOf on the
  // bare name lands in prose and the window never reaches the object literal — the check then
  // reports a correct implementation as broken. Same anchoring fault this gate has been bitten
  // by before; the entry is identified by the field that only the entry has.
  const at = src.indexOf('name: "handover.md"');
  if (at < 0) return "no handover.md entry is derived anywhere";
  const region = src.slice(at, at + 700);
  const bad: string[] = [];
  if (!/gate:\s*true/.test(region)) bad.push("the handover is not gated, so nobody signs it");
  if (/requiredForClose:\s*true/.test(region)) bad.push("the handover is requiredForClose, which makes the close demand a document that cannot exist yet");
  if (/closing:\s*true/.test(region)) bad.push("the handover is marked closing, which takes the close away from the flow's real closing document");
  if (!/requires:/.test(region)) bad.push("the handover declares no `requires`, so nothing orders it after the flow's closing document");
  return bad.length ? bad.join("; ") : null;
});

check("the handover is complete when its document is approved, not when a node mentions it", () => {
  // knowledgeMentions scanned every node file for the initiative's folder name as a SUBSTRING
  // — so any node mentioning an initiative completed it, whoever wrote it. Under "zero nodes
  // is legitimate" it became worse than loose: a careful handover that found nothing worth
  // recording was indistinguishable from one nobody ran.
  const src = zzCoreSource();
  const bad: string[] = [];
  if (/knowledgeMentions/.test(src)) {
    bad.push("knowledgeMentions still exists — the blind signal must be deleted, not bypassed");
  }
  const at = src.indexOf('action: "handover"');
  if (at < 0) { bad.push("initiative_status no longer reports a handover at all"); }
  else {
    const region = src.slice(Math.max(0, at - 1500), at + 1500);
    if (!/handover\.md/.test(region)) bad.push("the handover computation does not consult handover.md");
    if (!/waiting_on:\s*"agent"/.test(region)) bad.push('no waiting_on: "agent" state — an unwritten handover is indistinguishable from an unapproved one');
    if (!/waiting_on:\s*"human"/.test(region)) bad.push('no waiting_on: "human" state — an unapproved handover is indistinguishable from an unwritten one');
  }
  return bad.length ? bad.join("; ") : null;
});

check("close names the handover document and not a file that was abolished", () => {
  // initiative_close() told agents to "write learnings.md" for months after zz-handover abolished it.
  // Two independent agents hit that confusion in one day, and so did the author of the plan
  // this check comes from. A tool's own return text is documentation and rots like it.
  const src = zzCoreSource();
  const at = src.indexOf(`registerTool(\n    "initiative_close"`);
  if (at < 0) return "close is no longer registered";
  const body = src.slice(at, src.indexOf("\n  );", at));
  const bad: string[] = [];
  if (/learnings\.md/.test(body)) bad.push("close still names learnings.md, which zz-handover abolished");
  if (!/handover\.md/.test(body)) bad.push("close does not name the handover document the initiative now needs");
  return bad.length ? bad.join("; ") : null;
});

check("the retired sdlc closing skill is gone, everywhere it was not history", () => {
  // THE NEEDLE IS BUILT AT RUNTIME AND NEVER SPELLED IN THIS FILE. The walk below reads the
  // whole repository, this module included — so a check that grepped for the literal would
  // find its own source and could never go green. Neither this title nor any comment here
  // may contain it either.
  //
  // THE GATE STAYS INSIDE THE WALK, which is the one place that is deliberate rather than
  // incidental: the removal must also retire any existing gate check naming the skill, and
  // excluding the gate's own source would make exactly that unverifiable.
  //
  // CHANGELOG.md records the release that shipped the skill and is exempt: it is history,
  // rewriting it would make the record lie, and a check that demanded a clean tree could never
  // pass — the usual fate of which is that somebody deletes the check.
  const needle = ["sdlc", "record"].join("-");
  const bad: string[] = [];
  const skipped = /(^|\/)(CHANGELOG\.md|node_modules|\.git|dist)(\/|$)/;
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (skipped.test(p.slice(root.length + 1))) continue;
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(md|json|mjs|ts|js)$/.test(e.name)) continue;
      if (readFileSync(p, "utf8").includes(needle)) bad.push(p.slice(root.length + 1));
    }
  };
  walk(root);
  const dir = join(root, "catalog/sdlc/sdlc-flow/skills", needle);
  if (existsSync(dir)) bad.push(dir.slice(root.length + 1) + "/ still exists");
  return bad.length ? `${needle} survives in: ${bad.join(", ")}` : null;
});

check("the spine states the handover sequence and nothing it superseded", () => {
  // Two passages were stale, not one. :200-207 said "there is no document to write" and
  // described the substring-scan completion test; :272-274 said generalising is the platform
  // team's job while every team already did it unilaterally. A spine that still said either
  // would be this initiative's own contradiction, surviving the initiative.
  //
  // The second phrase uses \s+ because the sentence LINE-WRAPS in the source. Written without
  // it, the condition returned false against the unfixed file — reporting clean before and
  // after the change alike, and flagging the defect it exists to catch never.
  const src = readFileSync(join(root, "skills/zz-platform/SKILL.md"), "utf8");
  const bad: string[] = [];
  if (/there is no document to write/.test(src)) {
    bad.push("the spine still says there is no document to write — handover.md is one");
  }
  if (/until a knowledge\s+node carries this initiative's name/.test(src)) {
    bad.push("the spine still describes the substring-scan completion test, which was deleted");
  }
  if (/deciding which of them generalise is the platform team's job/.test(src)) {
    bad.push("the spine still assigns generalising to the platform team, which the platform does not do");
  }
  if (!/handover\.md/.test(src)) {
    bad.push("the spine never names the handover document every gated flow now owes");
  }
  return bad.length ? bad.join("; ") : null;
});

check("every skill that documents a knowledge_add call sends scope", () => {
  // FOUND BY EXECUTION, NOT BY THE PLAN. `scope` became required with no default, so a skill
  // whose worked example omits it is instructing an agent to make a call the platform now
  // refuses — and prose is exactly where that rots unnoticed. This closes the class rather
  // than the one instance execution happened to trip over.
  const bad: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (e.name !== "SKILL.md") continue;
      const src = readFileSync(p, "utf8");
      if (src.includes("knowledge_add") && !src.includes("scope")) {
        bad.push(p.slice(root.length + 1));
      }
    }
  };
  for (const d of ["skills", "catalog"]) {
    const full = join(root, d);
    if (existsSync(full)) walk(full);
  }
  return bad.length
    ? `these skills document a knowledge_add call without naming scope, which the platform now refuses: ${bad.join(", ")}`
    : null;
});

check("no skill states the abolished learnings.md completion test as current", () => {
  // FOUND BY EXECUTION. The spine was fixed and two ops-flow skills still said
  // `initiative_status` returns `action: handover` "until `learnings.md` exists" — the
  // substring-scan test this change deleted, described as current behaviour, in a flow that
  // now carries handover.md itself.
  //
  // NARROW ON PURPOSE: the phrase "learnings.md` exists" is the CLAIM. zz-handover names the
  // file twice while recounting the design that failed, and that history is worth keeping —
  // a check that banned the word outright would delete the record of why this exists.
  const bad: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (e.name !== "SKILL.md") continue;
      if (/learnings\.md`?\s+exists/.test(readFileSync(p, "utf8"))) bad.push(p.slice(root.length + 1));
    }
  };
  for (const d of ["skills", "catalog"]) {
    const full = join(root, d);
    if (existsSync(full)) walk(full);
  }
  return bad.length
    ? `these skills describe the deleted learnings.md test as how completion works today: ${bad.join(", ")}`
    : null;
});

check("the abandon-contradiction refusal is not disabled by the derived handover", () => {
  // REGRESSION GUARD, added after review found the derivation had silently defeated this.
  // `chain.documents` carries a derived handover.md that cannot exist at close time, so
  // including it in the gate set made `gates.every(approved)` permanently false and the
  // false-abandon refusal unreachable for every qualifying flow — the exact defect that
  // refusal exists to catch, and one this platform has already paid for once.
  const src = zzCoreSource();
  const at = src.indexOf("does not look abandoned");
  if (at < 0) return "the abandon-contradiction refusal is gone";
  const region = src.slice(Math.max(0, at - 1800), at);
  const i = region.lastIndexOf("const gates =");
  if (i < 0) return "the abandon check no longer computes a gate set this check can read";
  // SCOPED TO THE GATE EXPRESSION ITSELF, not to the surrounding region. A first version
  // allowed either fix — excluding the handover, or guarding existence — by testing the
  // whole region for `existsSync`. But `requiredPresent`, two lines below, calls existsSync
  // for an unrelated reason, so that escape hatch was always open and the check could never
  // fire. It passed on a mutant that reintroduced the very regression it was written for.
  const expr = region.slice(i, region.indexOf("requiredPresent", i));
  if (!/handover\.md/.test(expr) && !/existsSync/.test(expr)) {
    return "the abandon check counts the derived handover.md among the gates a finished initiative must have passed — it can never exist at close time, so the refusal can never fire";
  }
  return null;
});

check("an approved handover must have kept the team nodes it promised", () => {
  // FOUND BY REVIEW. document_approve() is a generic gate recorder with no side effect, so nothing
  // makes zz-handover's second pass happen — and reading "closed" the instant handover.md
  // was approved let an initiative report complete with every promised team node unwritten.
  // A promise recorded whose keeping went unverified: the same shape as the substring scan
  // this initiative deleted, one level up.
  //
  // The fix must not resurrect that anti-pattern, so the check below is what distinguishes
  // them: a NUMBER the document declares, against nodes whose STRUCTURED evidence names the
  // initiative — never a scan of node text for a mention.
  const src = zzCoreSource();
  // ANCHORED ON THE DECLARED COUNT AND READ FORWARD. A first version anchored on
  // `action: "closed"` and looked BACKWARD — but there are two such transitions now (the
  // zero-promise early return, and the promises-kept one), indexOf found the earlier one, and
  // the window never reached the evidence read below it. Anchoring on the token that appears
  // once, then reading forward over the logic it governs, is what makes this legible.
  // AND SOMETHING HAS TO WRITE IT. The server has always read this field and no skill ever
  // said to set it, so it was absent on every handover ever written — `Number(undefined ??
  // "0")` is zero, and "an approved handover kept what it promised" was satisfied by zero
  // every time. Round 1 of the 09-09 smoke closed with two team nodes promised in its own
  // prose and none on the shelf, and nothing anywhere disagreed. A read with no writer is
  // invisible: the code is present, the check runs, and it always passes.
  const knowledgeSkill = readFileSync(join(root, "skills/zz-handover/SKILL.md"), "utf8");
  if (!/proposed_team_nodes/.test(knowledgeSkill)) {
    return "the server counts handover.md's `proposed_team_nodes` and zz-handover never tells an agent to write it — the field is always absent, always reads as zero, and the promise-kept check can never fail";
  }
  const at = src.indexOf("proposed_team_nodes");
  if (at < 0) {
    return "the closed transition does not consult the count handover.md declared — an approved document whose promised team nodes were never written still reads as closed";
  }
  const region = src.slice(at, at + 2600);
  const bad: string[] = [];
  if (!/action:\s*"closed"/.test(region)) {
    bad.push("the declared count is read but no closed transition depends on it");
  }
  // Either spelling: the literal frontmatter key, or the parsed field. The first version
  // tested only `evidence:` and went red the moment the read was correctly routed through
  // parseEnvelope — a check coupled to one way of writing the right thing.
  if (!/\.evidence\b|evidence:/.test(region)) {
    bad.push("the count is not taken from nodes' structured evidence — a substring scan of node text is the anti-pattern this replaced and must not return");
  }
  return bad.length ? bad.join("; ") : null;
});
