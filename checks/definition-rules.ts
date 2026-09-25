// The thirteen rules this platform is built on, from
// `2026-09-16-plugin-is-the-only-concept/explore.md`. Each rule decidable from the source or
// the schema is decided here, by its own clause, with its own message naming the rule.
//
// DELIBERATE: three are not here.
//
//   R5's data half (a status exists only where a gate does) and R13 (no initiative was created
//       by a probe) are about data, and this gate is offline — they belong to the doctor.
//   R2  (a door is a plugin's declared server) is checked where it is measured:
//       checks/eval-door.ts and catalog-manifest.
//   R10 (quantitative deterministic, qualitative by model) is not checkable in the direction
//       that matters: "no counted metric comes from a model call" can be looked for, "every
//       countable thing is counted" cannot.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MANAGE_ALIAS } from "../packages/contracts/dist/index.js";
import { root, sourceFiles } from "../scripts/gate/read.ts";

const fail: string[] = [];
// MANAGE_ALIAS holds names that changed, so a tool that has always had one name is invisible
// to it. `whoami` is the only one. COUPLED: checks/manage-surface.ts names it for the same
// reason.
const manageNames = [...new Set([...Object.values(MANAGE_ALIAS), "whoami"])];
const src = (rel: string): string => { try { return readFileSync(join(root, rel), "utf8"); } catch { return ""; } };
const ts = (dirs: string[]): string[] => sourceFiles(dirs, [".ts"]).filter((f) => !f.includes("/dist/"));

// R1 · every capability is a plugin, and nothing else is installable
//
// Named tables rather than the word "block", because the word is ordinary English —
// `bug.impact = 'blocks_work'` is the verb.
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

// R3 · a flow is derived, never stored
//
// `isFlow(manifest) = documents.length > 0`, computed on read. A stored copy is a second
// source of truth that can disagree with the manifest.
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

// R4 · gating is a manifest fact, never a property of the file
//
// The same document may be gated in one flow and not in another, so nothing may decide it
// from a NAME. This looks for a gate decision keyed on a literal document filename.
//
// DELIBERATE: `handover.md` is exempt and is the only name that is. It is the platform's own
// document, appended by deriveChain to any flow that gates at least one document, so code
// naming it is naming its own declaration rather than reading a flow's.
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

// R5 (the write half) · nothing can PUT a status where no gate exists
//
// The data half of R5 is a doctor probe, because the gate is offline. This is the half the
// gate can hold: both writers that can create the violation. `stampEnvelope` writes
// `status: draft` and `document_approve` writes `status: approved`, and each must condition on
// the manifest's gate rather than on the manifest merely declaring the document.
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

// R7 · who the caller is arrives with the request, never as an argument
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

// R8 · domain picks the door; role picks what you see on it
//
// DELIBERATE: the table is frozen here. Nothing in either repository declares a tool's domain,
// and R10 forbids asking a model a question with a determinate answer, so the answer is
// written down once where a reviewer can disagree with a line of it.
//
// Checked both directions: a tool with no domain is unclassified, and a domain naming a tool
// no door serves is stale.
const DOMAIN_DOOR: Record<string, string> = {
  work: "core", knowledge: "core", defect: "core",
  catalog: "manage", access: "manage",
  evaluation: "eval",
};
const TOOL_DOMAIN: Record<string, string> = {
  // Work — an initiative, its records, and reading the doctrine a step needs. Reading a skill
  // is part of doing the work; managing what is on the shelf is Catalog.
  document_approve: "work", document_list: "work", document_patch: "work",
  document_present: "work", document_read: "work", document_revise: "work",
  document_write: "work", initiative_close: "work", initiative_open: "work",
  initiative_status: "work", source_add: "work", source_list: "work",
  skill_list: "work", skill_read: "work", session_whoami: "work",
  // A checkpoint a stage reaches while doing the work — one bounded question, answered as
  // evidence for the stage's own decision and never as the decision. Scoring a plugin is
  // Evaluation's.
  assess: "work",
  // Knowledge — the journal, and rebuilding the index that stores it.
  knowledge_add: "knowledge", knowledge_search: "knowledge", knowledge_supersede: "knowledge",
  knowledge_reconcile: "knowledge", knowledge_reindex: "knowledge",
  // Defect — reporting something broken is about the platform rather than the initiative, so
  // it is neither Work nor Access. Filing and answering are one subject; role decides which
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
  // Evaluation — the only subject in which a model's judgement becomes a score.
  plugin_locate: "evaluation", plugin_profile: "evaluation", plugin_conform: "evaluation",
  plugin_register: "evaluation",
  protocol_read: "evaluation", protocol_record: "evaluation", protocol_affirm: "evaluation",
  round_scores: "evaluation",
  finding_record: "evaluation", finding_decide: "evaluation", failure_discover: "evaluation",
  evaluator_qualify: "evaluation",
  evaluation_start: "evaluation", evaluation_assess: "evaluation", evaluation_score: "evaluation",
  replay_case_set_build: "evaluation",
  replay_start: "evaluation", replay_begin: "evaluation", replay_read: "evaluation", replay_close: "evaluation",
  replay_score: "evaluation",
  improvement_start: "evaluation", candidate_record: "evaluation", candidate_validate: "evaluation",
  candidate_search: "evaluation", candidate_prove: "evaluation", release_prepare: "evaluation",
  release_apply: "evaluation", release_record: "evaluation", release_verify: "evaluation",
  proposal_prepare: "evaluation",
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

// R11 · attribution is looked up, never inferred
//
// Which plugin a call belongs to is a fact about the door it arrived on, knowable before the
// call is answered and the same for every caller — never the caller's last-read skill.
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

// R12 · one subject, one table
//
// A knowledge node lives in zz.knowledge_node, not zz.doc: sharing a `status` column in which
// `approved` means a person agreed and `adopted` means this is the best we know makes every
// query about one subject remember to exclude the others.
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
