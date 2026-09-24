/**
 * The two knowledge shelves: `scope: "platform"` is read by every team, `scope: "team"` is
 * one team's own. Checks here hold the scope, the registry tag a platform node owes,
 * supersession staying on one shelf, and the handover chain every flow ends with.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { catalogSource, gatewaySource, root, withoutComments, zzCoreSource } from "../read.ts";
import { check } from "../run.ts";
import { catalogRoot, flows } from "../facts.ts";

check("_knowledge is never recorded as an initiative", () => {
  // `_knowledge` is the reserved directory the knowledge store lives in. Both the insert and
  // the update in reconcileRuns must exclude it, or runs are filed against an initiative row
  // nobody can open.
  const src = readFileSync(join(root, "services/gateway/src/runs.ts"), "utf8");
  const ins = /insert into zz\.initiative[\s\S]*?on conflict/.exec(src)?.[0] ?? "";
  const bad: string[] = [];
  if (!ins) return "reconcileRuns no longer inserts initiatives — this check reads nothing";
  // Comments are stripped first: the word `_knowledge` in the comment explaining the
  // exclusion would otherwise satisfy the test.
  const sql = ins.replace(/--[^\n]*/g, "");
  if (!/_knowledge/.test(sql)) {
    bad.push("the insert into zz.initiative does not exclude _knowledge, though the update " +
             "below it does — that disagreement is what created the rows");
  }
  // A backtick inside a SQL comment closes the template literal the statement lives in, so no
  // SQL comment in runs.ts may contain one.
  const lits = src.match(/`[\s\S]*?`/g) ?? [];
  for (const l of lits) {
    if (/^\s*--.*`/m.test(l.slice(1, -1))) bad.push("a SQL comment inside a template literal contains a backtick");
  }
  return bad.length ? bad.join("; ") : null;
});

check("every flow ends with the platform's handover", () => {
  // The handover step is appended below the manifest by initiative_status, so every flow ends
  // the same way and no manifest can drop it. Three things must hold together: the step is
  // named where the next move is computed, the skill it names exists, and that skill is a
  // platform entry rather than one a team installs.
  //
  // Comments stripped: both clauses below ask what the code does, and a comment naming
  // `action: "handover"` or `zz-handover` would satisfy them on a service that deleted both.
  const src = withoutComments(zzCoreSource());
  const bad: string[] = [];
  // Asserts the half zz-core owns: that it can tell a handover document apart, by role or by
  // name, wherever a next move is computed. A platform that could not would report a derived
  // handover as an ordinary pending document and tell an agent to write one before the close.
  //
  // DELIBERATE: this does not assert the derivation. `withHandover` lives in @zz/catalog so
  // zz-core and the console read one answer, and that zz-core calls it is asserted by "every
  // flow that gates a document also carries the handover", further down this file.
  if (!/isHandover/.test(src) || !/handover\.md/.test(src)) {
    bad.push("zz-core cannot tell a handover document apart, so a derived handover reads as an " +
             "ordinary pending document and an agent is told to write one before the close");
  }
  if (!/zz-handover/.test(src)) bad.push("nothing in zz-core names the handover skill");
  // The flow that closes has to know the step exists, or the agent closes, reports finished,
  // and meets the appended handover step on its next initiative_status call unwarned.
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
      // A skill that performs the close, not one that names the act: a call with an argument,
      // or the plain English for doing it.
      if (!/initiative_close\(\s*(initiative|"|<)/.test(text) && !/closes? the initiative/i.test(text)) continue;
      if (!/handover|zz-handover/.test(text)) {
        bad.push(`${f.owner}/${f.flow}/${sk} calls initiative_close() and never mentions the handover that follows it`);
      }
    }
  }
  // zz-handover is a platform skill, the bookend to zz-platform: the spine loads at the start
  // of every flow, the handover runs at the end of every one.
  const learnSkill = join(root, "skills", "zz-handover", "SKILL.md");
  if (!existsSync(learnSkill)) {
    bad.push("skills/zz-handover is missing — every flow names the handover and nothing performs it");
  }
  return bad.length ? bad.join("; ") : null;
});

check("the platform's own knowledge has a home, and it is reserved", () => {
  // The platform is a tenant: an ordinary team with the ordinary store and the same
  // `_knowledge/` every tenant has. Two things must hold together — the bootstrap creates it,
  // and team_create refuses it. Seeded but claimable lets a tenant read and write the
  // platform's own record; reserved but never seeded is a name with nothing behind it.
  const identity = readFileSync(join(root, "services/gateway/src/identity.ts"), "utf8");
  const db = withoutComments(readFileSync(join(root, "services/gateway/src/db.ts"), "utf8"));
  const admin = withoutComments(gatewaySource());
  const bad: string[] = [];
  const m = /export const PLATFORM_TEAM = "([a-z0-9][a-z0-9_-]*)"/.exec(identity);
  if (!m) {
    bad.push("identity.ts does not name the platform's team");
  } else {
    // It is a team slug like any other, so the guard keeping a slug out of a filesystem path
    // applies to this one too.
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(m[1])) {
      bad.push(`PLATFORM_TEAM "${m[1]}" is not a legal team slug`);
    }
    // The use, not the import: the identifier appearing anywhere in the file would pass on
    // the import line alone.
    if (!/insert into team[\s\S]{0,200}PLATFORM_TEAM/.test(db)) {
      bad.push("the bootstrap never seeds the platform team");
    }
    // And not behind an optional setting. Seeded below the BOOTSTRAP_TEAM block and inside its
    // early return, the insert is present and unreachable for an install that leaves
    // BOOTSTRAP_TEAM empty.
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
  // A lesson written for one team stays useful to one team until somebody generalises it.
  // zz-handover records what a cycle taught that team, and some of it is a fact about a
  // plugin, a provider or an interface every team depends on — so the promoting act is its own
  // skill, and zz-handover has to say where its platform-layer findings go.
  const bad = [];
  const distil = join(root, "skills/zz-handover/SKILL.md");
  if (!existsSync(distil)) {
    bad.push("skills/zz-handover is missing — nothing promotes a tenant's finding to platform knowledge");
    return bad.join("; ");
  }
  const text = readFileSync(distil, "utf8");
  // It must name the closed subject vocabulary it writes against and the evidence rule.
  // `plugin:`, not `block:` — a plugin is the only installable thing here. SUBJECT_KINDS in
  // zz-core is the authority; a tag outside it is refused at the write.
  for (const need of ["knowledge_add", "plugin:", "flow:", "evidence"]) {
    if (!text.includes(need)) bad.push(`zz-handover never mentions ${need}`);
  }
  const learn = readFileSync(join(root, "skills/zz-handover/SKILL.md"), "utf8");
  if (!learn.includes("zz-handover")) {
    bad.push("zz-handover does not name zz-handover — its platform-layer findings have no onward path");
  }
  return bad.length ? bad.join("; ") : null;
});

check("the shelf is on the door everyone has, and each admin act is in its tier", () => {
  // catalog_list is registered for everybody: gated behind `sup` or `lead`, discovery
  // disappears with no error anywhere. Installing is not a platform act — a person installs a
  // plugin in their own client and the platform records none of it. The admin acts are
  // separated by role, written in which tier each tool is registered under.
  //
  // Comments stripped first: the raw text passes on a commented-out registerShelf call.
  const liveText = (t: string): string => t.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  // The whole gateway: buildAccessServer is in access-door.ts, not server.ts.
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
    ["member_add", "lead", "team membership is a team admin's act"],
    ["person_add", "sup", "creating a principal is a platform act"],
  ]) {
    const got = tierOf(name);
    if (got === null) bad.push(`${name} is not registered anywhere`);
    else if (got !== want) bad.push(`${name} is registered for '${got}' and must be '${want}' — ${why}`);
  }
  // Visibility must never exceed executability. Both tier predicates are derived from the same
  // functions the handlers call, never from platformRole: a superadmin on a member-scope PAT is
  // not super for the request, so they must not be offered tools that will refuse them.
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
  // A default would make silence sayable again; the choice is forced between two sayable
  // answers.
  const src = zzCoreSource();
  const at = src.indexOf(`registerTool(\n    "knowledge_add"`);
  if (at < 0) return "knowledge_add is no longer registered";
  const body = withoutComments(src.slice(at, src.indexOf("\n  );", at)));
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
  // DELIBERATE: directional. Asserting that both roots and the word platform merely appear
  // lets an inverted implementation — the platform branch resolving userRoot() — satisfy every
  // assertion while filing every node on the wrong shelf.
  const src = zzCoreSource();
  const at = src.indexOf(`registerTool(\n    "knowledge_add"`);
  if (at < 0) return "knowledge_add is no longer registered";
  const body = withoutComments(src.slice(at, src.indexOf("\n  );", at)));
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
  // The skill's rubric — a platform node promotes facts about a registry entry, not about the
  // team — where it can be enforced. Reuses SUBJECT_KINDS rather than restating the kinds.
  //
  // DELIBERATE: not anchored on ERROR: with a quote-excluding character class. The refusal's
  // quoted scope value sits between the anchor and the phrase, so such a class would stop
  // before reaching it and the check could never pass.
  const src = zzCoreSource();
  const at = src.indexOf(`registerTool(\n    "knowledge_add"`);
  if (at < 0) return "knowledge_add is no longer registered";
  const body = withoutComments(src.slice(at, src.indexOf("\n  );", at)));
  if (!/SUBJECT_KINDS/.test(body)) {
    return "knowledge_add does not consult SUBJECT_KINDS — a platform node's tags are unchecked, or the five kinds were restated somewhere they can drift";
  }
  if (!/needs a registry-entry tag/.test(body)) {
    return "no refusal for a platform-scoped node carrying no registry-entry tag";
  }
  return null;
});

check("a team-scoped node cannot be written by somebody in no team", () => {
  // userRoot() falls back to a personal directory outside teams/ when teamFor() is falsy, so a
  // team-scoped write from a teamless caller would report success and land where team-gated
  // search can never reach it.
  const src = zzCoreSource();
  const at = src.indexOf(`registerTool(\n    "knowledge_add"`);
  if (at < 0) return "knowledge_add is no longer registered";
  const body = withoutComments(src.slice(at, src.indexOf("\n  );", at)));
  const bad: string[] = [];
  if (!/you are not in a team/.test(body)) {
    bad.push("knowledge_add does not refuse a team-scoped write from a caller with no team — the node would land in a personal directory nothing can search");
  }
  // Both halves: a refusal firing for every scope would satisfy the clause above while
  // breaking platform writes, which need no team.
  if (!/scope\s*===\s*"team"|"team"\s*===\s*scope/.test(body)) {
    bad.push("the teamless refusal is not scoped to `scope: \"team\"` — a platform-scoped write from a teamless caller must still succeed");
  }
  return bad.length ? bad.join("; ") : null;
});

check("every act on the knowledge base leaves a record naming who did it", () => {
  // knowledge_search left no record of who read what, and that is the question deciding
  // whether a node earned its place. A tool_call row cannot serve: it carries no actor,
  // because it measures a skill rather than a person.
  //
  // Derived from the module rather than a list of names, so a fourth knowledge tool inherits
  // this. DELIBERATE: scoped to tools/knowledge.ts — knowledge_reconcile lives elsewhere and
  // reads zz.decision and zz.event rather than the shelves, so it is not an act on the
  // knowledge base.
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
    const body = withoutComments(src.slice(at, src.indexOf("\n  );", at)));
    if (!/platformEvent\(/.test(body)) {
      bad.push(`${name} leaves no record naming the caller — it acts on the knowledge base and ` +
               "the journal cannot say who, when, or on what");
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("supersession stays on one shelf and knows which", () => {
  // Ids restart at 0001 on each shelf, so the same number exists in two places. A resolver
  // returning only a path would pick whichever it looked at first and relabel somebody else's
  // node.
  const src = zzCoreSource();
  const at = src.indexOf(`registerTool(\n    "knowledge_supersede"`);
  if (at < 0) return "knowledge_supersede is no longer registered";
  const body = withoutComments(src.slice(at, src.indexOf("\n  );", at)));
  const bad: string[] = [];
  if (!/userRoot\(\)/.test(body)) bad.push("supersede cannot see the team shelf");
  if (!/knowledgeRoot\(\)/.test(body)) bad.push("supersede cannot see the platform shelf");
  if (!/ERROR:[^\n]*shelf/.test(body)) bad.push("no refusal for a cross-shelf supersession");
  return bad.length ? bad.join("; ") : null;
});

check("every flow that gates a document also carries the handover", () => {
  // Derived from the manifest rather than configured: the rule is only flows that gate and
  // produce files, so a flow added later inherits it.
  //
  // COUPLED: `withHandover` lives in @zz/catalog, not in zz-core, so the console and the
  // platform resolve a flow's documents through one answer. This checks that one place plus
  // the fact that zz-core still delegates.
  const src = catalogSource();
  const at = src.indexOf("export function withHandover(");
  if (at < 0) return "withHandover is gone or was renamed — both the platform and the console resolve a flow's documents through it";
  const body = withoutComments(src.slice(at, src.indexOf("\n}", at)));
  const bad: string[] = [];
  if (!/handover\.md/.test(body)) bad.push("withHandover does not derive handover.md");
  if (!/\.gate/.test(body)) bad.push("the derivation does not test for a gated document");
  if (!/withHandover\(/.test(withoutComments(zzCoreSource()))) {
    bad.push("zz-core does not call withHandover — deriveChain must delegate, or the platform and the console describe different flows again");
  }
  if (!/What this initiative taught/.test(body)) {
    bad.push("the derived entry declares no sections — sectionCheck returns early without them and the three headings would be unenforced");
  }
  return bad.length ? bad.join("; ") : null;
});

check("the handover carries a gate and does not carry the close", () => {
  // gate: true is what makes a person sign it. closing or requiredForClose would make
  // initiative_close() demand a document that cannot exist until after the close.
  const src = catalogSource();
  // Anchored on the field only the entry has: the derivation is preceded by a comment block
  // mentioning handover.md several times, so indexOf on the bare name lands in prose.
  const at = src.indexOf('name: "handover.md"');
  if (at < 0) return "no handover.md entry is derived anywhere";
  const region = withoutComments(src.slice(at, at + 700));
  const bad: string[] = [];
  if (!/gate:\s*true/.test(region)) bad.push("the handover is not gated, so nobody signs it");
  if (/requiredForClose:\s*true/.test(region)) bad.push("the handover is requiredForClose, which makes the close demand a document that cannot exist yet");
  if (/closing:\s*true/.test(region)) bad.push("the handover is marked closing, which takes the close away from the flow's real closing document");
  if (!/requires:/.test(region)) bad.push("the handover declares no `requires`, so nothing orders it after the flow's closing document");
  return bad.length ? bad.join("; ") : null;
});

check("a closed initiative owes nothing, and can still be handed over", () => {
  // Closing is terminal and allowed at any point: work stops, and an initiative closed halfway
  // is closed rather than short of something. The ledger row is the record.
  //
  // Both clauses read comment-stripped source. The forbidding clause is the one where a
  // comment makes a correct repository falsely red.
  const src = withoutComments(zzCoreSource());
  const bad: string[] = [];
  if (/knowledgeMentions/.test(src)) {
    bad.push("knowledgeMentions still exists -- the blind substring signal must stay deleted");
  }
  // `withoutComments` replaces a comment with its own newlines wherever it sits and leaves
  // string and regex literals intact.
  if (/action:\s*"handover"/.test(src)) {
    bad.push('initiative_status still reports action: "handover" -- a closed initiative owes ' +
             "nothing, so there is no state after the close to wait in");
  }
  // The handover must still be writeable after the close: guards.ts lets a closed initiative
  // satisfy a prerequisite its close skipped.
  const guards = readFileSync(join(root, "services/zz-core/src/guards.ts"), "utf8");
  const at = guards.indexOf("does not exist yet");
  if (at < 0) {
    bad.push("the prerequisite guard is gone -- nothing sequences an OPEN initiative's documents");
  } else if (!/outcome/.test(guards.slice(Math.max(0, at - 2000), at + 600))) {
    bad.push("the prerequisite guard does not consult the outcome -- a closed initiative cannot " +
             "write a handover whose prerequisite its close deliberately skipped");
  }
  return bad.length ? bad.join("; ") : null;
});

check("close names the handover document and not a file that was abolished", () => {
  // A tool's own return text is documentation and rots like it.
  const src = zzCoreSource();
  const at = src.indexOf(`registerTool(\n    "initiative_close"`);
  if (at < 0) return "close is no longer registered";
  const body = withoutComments(src.slice(at, src.indexOf("\n  );", at)));
  const bad: string[] = [];
  if (/learnings\.md/.test(body)) bad.push("close still names learnings.md, which zz-handover abolished");
  if (!/handover\.md/.test(body)) bad.push("close does not name the handover document the initiative now needs");
  return bad.length ? bad.join("; ") : null;
});

check("the retired sdlc closing skill is gone, everywhere it was not history", () => {
  // DELIBERATE: the needle is built at runtime and never spelled in this file. The walk below
  // reads the whole repository, this module included, so a literal would find its own source.
  // Neither the title nor any comment here may contain it.
  //
  // The gate's own source stays inside the walk: the removal must also retire any gate check
  // naming the skill. CHANGELOG.md is exempt because it is history.
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
  // The second phrase matches across whitespace because the sentence line-wraps in the source.
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
  // `scope` is required with no default, so a skill whose worked example omits it instructs an
  // agent to make a call the platform refuses.
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
  // DELIBERATE: narrow. Only the claim that learnings.md still exists is banned — zz-handover
  // names the file while recounting the design that failed, and banning the word outright
  // would delete that record.
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
  // `chain.documents` carries a derived handover.md that cannot exist at close time, so
  // including it in the gate set makes `gates.every(approved)` permanently false and the
  // false-abandon refusal unreachable.
  const src = zzCoreSource();
  const at = src.indexOf("does not look abandoned");
  if (at < 0) return "the abandon-contradiction refusal is gone";
  const region = src.slice(Math.max(0, at - 1800), at);
  const i = region.lastIndexOf("const gates =");
  if (i < 0) return "the abandon check no longer computes a gate set this check can read";
  // Scoped to the gate expression, not the surrounding region: `requiredPresent` two lines
  // below calls existsSync for an unrelated reason, which would leave the escape hatch open.
  const expr = withoutComments(region.slice(i, region.indexOf("requiredPresent", i)));
  if (!/handover\.md/.test(expr) && !/existsSync/.test(expr)) {
    return "the abandon check counts the derived handover.md among the gates a finished initiative must have passed — it can never exist at close time, so the refusal can never fire";
  }
  return null;
});

check("a search counts a superseded result the same way it excludes one", () => {
  // `buildSearchPredicate` excludes a superseded row on two signals — a node carries
  // `lifecycle: superseded`, mapped to `status`, and a document keeps `status: approved` and
  // names its successor in `superseded_by`. The counter must read both, or it reports 0 for
  // every document search.
  const src = readFileSync(join(root, "services/zz-core/src/tools/knowledge-search.ts"), "utf8");
  const pred = withoutComments(readFileSync(join(root, "services/zz-core/src/tools/search-predicate.ts"), "utf8"));
  if (!/superseded_by is null and status <> 'superseded'/.test(pred)) {
    return "the predicate no longer excludes superseded rows on both signals, so this check is "
         + "written about a rule that has moved — rewrite it rather than leave it passing";
  }
  const counter = /const superseded = results\.filter\(([^)]*)\)/.exec(src)?.[1] ?? "";
  // The return expression, not the block: the type annotation inside `isSuperseded` carries
  // the string `superseded_by`, so testing the whole body proves nothing.
  const body = /const isSuperseded[\s\S]{0,400}?return ([^;]+);/.exec(src)?.[1] ?? "";
  if (!counter.includes("isSuperseded") || !body) {
    return "superseded_in_results is counted inline rather than by a predicate this can read — "
         + "the count and the exclusion are the same question and must be answered the same way";
  }
  if (!/superseded_by/.test(body)) {
    return "superseded_in_results counts on `status` alone, so it answers for a node and never "
         + "for a document: a document keeps `status: approved` and names its successor in "
         + "`superseded_by`, and 210 of them on this deployment do";
  }
  return null;
});
