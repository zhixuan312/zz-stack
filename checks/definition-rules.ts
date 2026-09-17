// THE DEFINITION, ENFORCED RATHER THAN WRITTEN DOWN.
//
// `2026-09-16-plugin-is-the-only-concept/explore.md` states thirteen rules this platform is
// built on. A rule with no check is a rule that holds until somebody edits the file that
// happens to satisfy it, so each one that can be decided from the SOURCE or the SCHEMA is
// decided here, by its own clause, with its own message naming the rule.
//
// WHAT IS DELIBERATELY NOT HERE, so the absence is a decision rather than a gap:
//
//   R5  (a status exists only where a gate does) and R13 (no initiative was created by a
//       probe) are about DATA. This gate is offline by design — it proves things about the
//       source — so those two belong to the doctor, which runs against a live deployment.
//   R2  (a door is a plugin's declared server) is already checked where it is measured:
//       checks/eval-door.ts asserts pluginForDoor names the right plugin for each door, and
//       catalog-manifest asserts every declared server is a door the gateway mounts.
//   R10 (quantitative deterministic, qualitative by model) is not checkable in the direction
//       that matters. "No counted metric comes from a model call" can be looked for; "every
//       countable thing is counted" cannot, and claiming the second from the first would be
//       the overclaiming this file exists to prevent.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MANAGE_ALIAS } from "../packages/contracts/dist/index.js";
import { root, sourceFiles } from "../scripts/gate/read.ts";

const fail: string[] = [];
// MANAGE_ALIAS is a table of names that CHANGED, so a tool that has always had one name is
// invisible to it. `whoami` is the only one, and checks/manage-surface.ts names it explicitly
// for the same reason.
const manageNames = [...new Set([...Object.values(MANAGE_ALIAS), "whoami"])];
const src = (rel: string): string => { try { return readFileSync(join(root, rel), "utf8"); } catch { return ""; } };
const ts = (dirs: string[]): string[] => sourceFiles(dirs, [".ts"]).filter((f) => !f.includes("/dist/"));

// ── R1 · every capability is a plugin, and nothing else is installable ───────────────────
//
// The block concept is gone from the code; this is what keeps it gone. Named tables rather
// than the word "block", because the word is ordinary English — `bug.impact = 'blocks_work'`
// is the verb, and a check that cannot tell them apart is a check somebody turns off.
{
  const schema = ts(["services/gateway/migrations"]).length
    ? "" : "";                                    // migrations are .sql; read them below
  void schema;
  const sql = sourceFiles(["services/gateway/migrations"], [".sql"])
    .map((f) => src(f)).join("\n");
  const live = new Set<string>();
  for (const m of sql.matchAll(/create table (?:if not exists )?(?:zz\.)?(\w+)/gi)) live.add(m[1]);
  for (const m of sql.matchAll(/drop table (?:if exists )?(?:zz\.)?(\w+)/gi)) live.delete(m[1]);
  for (const gone of ["block", "block_version", "block_tool", "block_token", "tool_grant"]) {
    if (live.has(gone)) {
      fail.push(`R1: zz.${gone} still stands — a plugin is the only installable thing on this ` +
                "platform, and a second registry of what can be reached is a second answer to it");
    }
  }
}

// ── R3 · a flow is derived, never stored ────────────────────────────────────────────────
//
// `isFlow(manifest) = documents.length > 0`, computed on read. A stored copy is a second
// source of truth that can disagree with the manifest, which is what `kind: "platform"` was
// before it became `shelved` — one field that could say "not a flow" and put zz-admin in the
// flow menu beside a real one.
{
  const contracts = src("packages/contracts/src/index.ts");
  if (/\bis_?flow\b\s*:/i.test(contracts)) {
    fail.push("R3: a manifest or a row declares its own flow-ness — `isFlow` is derived from " +
              "`documents.length > 0` and a stored copy is a second answer that can disagree");
  }
  if (!/export function isFlow/.test(src("packages/catalog/src/index.ts"))) {
    fail.push("R3: @zz/catalog no longer exports `isFlow`, so the one place that decides what a " +
              "flow is has moved or gone and every caller is deciding for itself again");
  }
}

// ── R4 · gating is a manifest fact, never a property of the file ────────────────────────
//
// The same document may be gated in one flow and not in another, so nothing may decide it
// from a NAME. This looks for a gate decision keyed on a literal document filename.
//
// `handover.md` IS EXEMPT, and it is the only name that is. Every other document here is a
// flow's to declare; the handover is the PLATFORM's, appended by deriveChain to any flow that
// gates at least one document and gated by the platform itself. Code that names it is naming
// its own declaration rather than reading a flow's — two places do, and both are right:
// deriveChain appending it, and the close guard excluding it from the gates a DELIVERY must
// pass, because it is what the platform asks for after the close rather than before it.
{
  for (const f of ts(["services", "packages"])) {
    const t = src(f);
    for (const m of t.matchAll(/\bgate\w*\b[^;\n]{0,160}?["'](?:spec|plan|review|explore)\.md["']/gi)) {
      const line = t.slice(0, m.index).split("\n").length;
      fail.push(`R4: ${f}:${line} decides something about a gate from a document's NAME. ` +
                "Whether a document is gated is its flow manifest's answer, per flow and per " +
                "document; a flow that renames spec.md keeps its gate, and one that gates " +
                "explore.md is right to.");
    }
  }
}

// ── R5 (the write half) · nothing can PUT a status where no gate exists ─────────────────
//
// The data half of R5 is a doctor probe, because the gate is offline. This is the half the
// gate CAN hold: the two writers that can create the violation.
//
// `stampEnvelope` writes `status: draft` and conditioned it on `governed` — the manifest
// DECLARES this document — where the rule is `gated`. `document_approve` writes
// `status: approved` and checked only `chain.docs.has(...)`, which is the same predicate
// spelled differently. Fixing one and not the other fixes nothing durable: the platform stops
// creating the rows and the next caller who approves an audit report recreates them.
{
  const stamp = src("services/zz-core/src/write-guards.ts");
  if (!/if \(gated && present\.status === undefined\)/.test(stamp)) {
    fail.push("R5: stampEnvelope no longer conditions `status` on the manifest's gate — a " +
              "document the flow declares WITHOUT a gate would be stamped a draft, and a " +
              "status records a verdict nobody was asked for");
  }
  const acts = src("services/zz-core/src/tools/initiative-acts.ts");
  if (!/entry\.gate !== true/.test(acts)) {
    fail.push("R5: document_approve does not refuse a document its flow declares without a " +
              "gate. Declaring a document is not gating it — approving an ungated one writes " +
              "the exact rows the rule forbids, whatever stampEnvelope does");
  }
}

// ── R7 · who the caller is arrives with the request, never as an argument ────────────────
//
// Identity is resolved from the credential. A tool that takes the caller as a parameter is a
// tool whose answer the caller chooses, and every authorisation decision behind it is then
// about a claim rather than a fact.
{
  const BANNED = /\b(caller|actor|as_user|acting_as|on_behalf|principal|my_email)\b\s*:\s*z\./;
  for (const f of ts(["services"])) {
    const t = src(f);
    for (const m of t.matchAll(new RegExp(BANNED, "g"))) {
      const line = t.slice(0, m.index).split("\n").length;
      fail.push(`R7: ${f}:${line} takes who the caller is as a tool argument. It arrives on the ` +
                "request — a credential the platform resolved — and a parameter is a claim.");
    }
  }
}

// R8 · DOMAIN PICKS THE DOOR; ROLE PICKS WHAT YOU SEE ON IT.
//
// The two cuts are different and they were confused: filing a bug was on /core and answering
// one on /manage, because answering is an operator's act. Apply the test that settles it — a
// superadmin with every plugin installed, so nothing is hidden — and the two answer differently
// with nothing but the caller between them.
//
// THE TABLE IS FROZEN HERE, and it has to be. The test as explore.md states it is a question a
// PERSON answers; nothing in either repository declares a tool's domain, so a check could only
// ask a model, which R10 forbids for a question with a determinate answer. A frozen table is
// the answer written down once, where a reviewer can disagree with a line of it.
//
// Both directions, so neither half can rot quietly: a tool with no domain is unclassified and a
// domain naming a tool that no door serves is stale.
const DOMAIN_DOOR: Record<string, string> = {
  work: "core", knowledge: "core", defect: "core",
  catalog: "manage", access: "manage",
  evaluation: "eval",
};
const TOOL_DOMAIN: Record<string, string> = {
  // Work — an initiative, its records, and reading the doctrine a step needs. Reading a skill
  // is part of DOING the work; managing what is on the shelf is Catalog.
  document_approve: "work", document_list: "work", document_patch: "work",
  document_present: "work", document_read: "work", document_revise: "work",
  document_write: "work", initiative_close: "work", initiative_open: "work",
  initiative_status: "work", source_add: "work", source_list: "work",
  skill_list: "work", skill_read: "work", session_whoami: "work",
  // Knowledge — the journal, and rebuilding the index that stores it.
  knowledge_add: "knowledge", knowledge_search: "knowledge", knowledge_supersede: "knowledge",
  knowledge_reconcile: "knowledge", knowledge_reindex: "knowledge",
  // Defect — a seventh domain, and the audit that found R8 unimplementable was right that it
  // was missing. Reporting something broken is not Work (it is about the platform, not about
  // the initiative) and not Access. Filing and answering are one subject; role decides which
  // half you see.
  bug_report: "defect", bug_list: "defect", bug_resolve: "defect", bug_delete: "defect",
  // Catalog — what is on the shelf, and how to install from it.
  catalog_list: "catalog", client_setup: "catalog",
  // Access — who may do what, and the credential that says so.
  person_add: "access", person_list: "access", person_deactivate: "access",
  enrolment_issue: "access", team_create: "access", team_archive: "access",
  team_list: "access", team_mine: "access", team_switch: "access",
  member_add: "access", member_remove: "access",
  pat_issue: "access", pat_list: "access", pat_revoke: "access", whoami: "access",
  // Evaluation — the only subject in which a model's judgement is admissible.
  plugin_locate: "evaluation", plugin_profile: "evaluation", plugin_conform: "evaluation",
  ruler_read: "evaluation", ruler_record: "evaluation", ruler_affirm: "evaluation",
  round_judge: "evaluation", round_scores: "evaluation",
  case_record: "evaluation", finding_record: "evaluation",
};
{
  const serves = new Map<string, string>();   // tool -> the door that registers it
  const core = src("services/zz-core/src/server.ts");
  for (const f of ts(["services/zz-core/src/tools"])) {
    for (const m of src(f).matchAll(/registerTool\(\s*\n?\s*"([a-z0-9_]+)"/g)) serves.set(m[1], "core");
  }
  for (const f of ts(["services/zz-core/src/eval"])) {
    for (const m of src(f).matchAll(/registerTool\(\s*\n?\s*"([a-z0-9_]+)"/g)) serves.set(m[1], "eval");
  }
  void core;
  for (const t of Object.values(JSON.parse(JSON.stringify(manageNames)) as string[])) serves.set(t, "manage");
  for (const [tool, door] of serves) {
    const domain = TOOL_DOMAIN[tool];
    if (!domain) {
      fail.push(`R8: ${tool} is served on /${door} and no domain claims it — a tool whose ` +
                "subject nobody wrote down is a tool whose door nobody can argue with");
      continue;
    }
    const want = DOMAIN_DOOR[domain];
    if (want !== door) {
      fail.push(`R8: ${tool} is served on /${door} and its domain (${domain}) names /${want}. ` +
                "The subject decides the door; role decides only who sees it on that door.");
    }
  }
  for (const tool of Object.keys(TOOL_DOMAIN)) {
    if (!serves.has(tool)) {
      fail.push(`R8: the domain table claims ${tool} and no door serves it — a stale entry ` +
                "makes the table look complete while a real tool goes unclassified");
    }
  }
}

// ── R11 · attribution is looked up, never inferred ──────────────────────────────────────
//
// Which plugin a call belongs to is a fact about the DOOR it arrived on. It was inferred from
// the caller's most recently read skill: 3,928 tool calls on /core, 192 attributed, 150 of
// those naming a plugin that declares no server at all.
{
  const tel = src("services/gateway/src/tool-telemetry.ts");
  if (/plugin\s*=\s*await\s+pluginFor\(/.test(tel) || /pluginFor\(\s*step/.test(tel)) {
    fail.push("R11: telemetry attributes a call to a plugin from the caller's step trace. " +
              "The door it arrived on IS a plugin's declared server, and that is knowable " +
              "before the call is answered and the same for every caller.");
  }
  if (!/pluginForDoor\(/.test(tel)) {
    fail.push("R11: telemetry no longer resolves the plugin from the door — either attribution " +
              "has moved back to a guess, or it is not being recorded at all");
  }
}

// ── R12 · one subject, one table ────────────────────────────────────────────────────────
//
// zz.doc held documents, sources and knowledge nodes under one `status` column in which
// `approved` means a person agreed and `adopted` means this is the best we know. Every query
// about one subject had to remember to exclude the others, and three forgot.
{
  const idx = src("packages/indexing/src/index.ts");
  if (!/insert into zz\.knowledge_node/.test(idx)) {
    fail.push("R12: the indexer no longer writes zz.knowledge_node — a knowledge node is back " +
              "in the document table, where `adopted` and `approved` share a column again");
  }
  for (const f of ts(["services", "packages"])) {
    const t = src(f);
    if (/from zz\.doc\b[\s\S]{0,200}?initiative\s*=\s*'_knowledge'/.test(t)) {
      fail.push(`R12: ${f} reads knowledge nodes out of zz.doc — they are their own subject in ` +
                "zz.knowledge_node, and a query that still excludes or selects them here is " +
                "reading a table that no longer holds them");
    }
  }
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("definition rules: ok — R1, R3, R4, R5 (write half), R7, R8, R11 and R12 hold in the source");
