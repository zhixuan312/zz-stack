/**
 * Defects planted in the document envelope, its guards, its lifecycle and the prose that
 * ships beside them.
 *
 * WHAT THESE CHECKS PROTECT, IN ONE SENTENCE: the envelope is the platform's and the body is
 * the caller's, and there is no third source. Three routes to that third source have been
 * closed — `document_write` and `document_revise` refuse content that opens with frontmatter,
 * and `document_patch` refuses a find/replace that reaches the block — so the rows that matter
 * most here are the ones that re-open one of them: a guard whose answer is thrown away, a
 * refusal that stops firing, a stamp that invents a field for a document it does not govern.
 *
 * THIS FILE IS ONE OF THE FILES THESE CHECKS READ, and that is a hazard rather than a curiosity.
 * `makeWorkspace` runs `git add -A` inside the disposable copy, so an untracked spec file is a
 * TRACKED one by the time the gate runs, and `sourceFiles(["."], [".ts"])` and
 * `sourceFiles(["services", "packages", "scripts"], [".ts"])` both reach `scripts/mutation/`.
 * Three of the strings below would therefore fire their own target at BASELINE — the redaction
 * placeholder, the removed comment tool, and an undeclared slash command — and a target that is
 * already red is excluded from `new_failures`, so every row aimed at it reads SURVIVED whatever
 * the check actually did. Those three are assembled from halves, with the reason written above
 * each one. The alternative was to weaken the mutation; disclosing the assembly is the same
 * trade `specs-documents.ts` made for `NOT_YET_PLANTED`, and for the same reason.
 *
 * NOT COVERED HERE, and reported to the dispatcher rather than invented:
 *   - "every document ours to keep is discovered and dated" — its only live assertion is keyed
 *     to `STATE.md`, which this repository does not ship.
 *   - "no document is older than the code it describes" — it returns null on every path.
 *   - "the gate reads the files it says it reads" — every file it reads is under
 *     `scripts/gate/`, which `plant()` freezes by construction.
 */
import type { MutationSpec } from "./plant.ts";

export const COV_DOCUMENTS: readonly MutationSpec[] = [
  /* ── the write guards ─────────────────────────────────────────────────── */
  {
    check: "scripts/gate/checks/documents-guards.ts",
    target: "every tool that writes a file also indexes it",
    subject: "services/zz-core/src/tools/artifacts.ts",
    find: "      void indexDoc(root, rel, doc);",
    replace: "      void indexDoc;",
    planted: "source_add writes the source file and never tells the index, so the material a " +
      "revision rests on is on disk and invisible to every search that looks for it — the " +
      "knowledge_supersede failure, on the other write path",
  },
  {
    check: "scripts/gate/checks/documents-guards.ts",
    target: "every document write runs the guards",
    subject: "services/zz-core/src/tools/artifacts.ts",
    find: "      const bad = documentGuards(chain, root, path, fixed.content, team);\n" +
      "      if (bad) return text(bad);\n" +
      "      persistDocument(chain, root, path, target, fixed.content, \"patch\");",
    replace: "      void team;\n" +
      "      persistDocument(chain, root, path, target, fixed.content, \"patch\");",
    planted: "document_patch lands a document without asking whether it may — no ownership " +
      "check, no gate, no section rule — so a patch can move an approved document and the " +
      "store keeps the result",
  },
  {
    check: "scripts/gate/checks/documents-guards.ts",
    target: "no asymmetric fork in the document guards",
    subject: "services/zz-core/src/guards.ts",
    find: "  const stop = env.outcome === OUTCOME_STOPPED;",
    replace: "  const stop = env.outcome === OUTCOME_STOPPED;\n" +
      "  if (env.outcome === \"accepted\" && !env.accepted_by) {\n" +
      "    return \"ERROR: a close accepted by somebody names them in `accepted_by`, and no \" +\n" +
      "           \"accepted_by is recorded on this document.\";\n" +
      "  }",
    planted: "a close that says somebody accepted it must name them, and a close that says " +
      "nobody did need name nothing — so the cheaper road is to claim the work was delivered, " +
      "which is the asymmetry the platform has already shipped three times",
  },
  {
    // ASSEMBLED, AND HERE IS WHY. This check refuses any tracked `.ts` outside @zz/contracts
    // that writes its own redaction placeholder, and it sweeps `scripts/` — including this
    // file. Written out whole, the replacement below would make this spec file the defect and
    // turn the target red before a single mutation was planted.
    check: "scripts/gate/checks/documents-guards.ts",
    target: "a refusal is classified in one place",
    subject: "packages/tools/src/ops/watch-results.ts",
    find: "      const c = refusalClass(String(e.detail.refusal));",
    replace: "      const c = refusalClass(String(e.detail.refusal))\n" +
      "        .replace(/\\b\\d{4}-\\d{2}-\\d{2}\\b/g, \"<" + "date>\");",
    planted: "the alert that watches whether a refusal class got worse redacts a second time, " +
      "with its own vocabulary, after the gateway already redacted at write time — so the " +
      "classes it compares are not the classes the table holds and the comparison is between " +
      "two different groupings",
  },
  {
    check: "scripts/gate/checks/documents-guards.ts",
    target: "a guard's answer is never discarded",
    subject: "services/zz-core/src/tools/artifacts.ts",
    find: "      const edited = envelopeEditRefusal(body, result);\n" +
      "      if (edited) return text(edited);",
    replace: "      envelopeEditRefusal(body, result);",
    planted: "document_patch still calls the guard that stops a patch reaching the frontmatter " +
      "and throws away what it says, so `find: \"flow: ops-flow\"` edits the envelope again — " +
      "the third source the platform closed, re-opened by a line that compiles and reads as " +
      "protection",
  },
  {
    check: "scripts/gate/checks/documents-guards.ts",
    target: "nothing is written before the guards that would refuse it",
    subject: "services/zz-core/src/tools/initiative-acts.ts",
    find: "        pendingSource = {\n" +
      "          rel,\n" +
      "          doc: sourceDocument({ title, by: who.email, day, supports: parts[1],\n" +
      "                                content: source_content.trim() }),\n" +
      "        };",
    replace: "        const srcDoc = sourceDocument({ title, by: who.email, day, supports: parts[1],\n" +
      "                                content: source_content.trim() });\n" +
      "        pendingSource = { rel, doc: srcDoc };\n" +
      "        mkdirSync(resolve(join(root, rel), \"..\"), { recursive: true });\n" +
      "        writeFileSync(join(root, rel), srcDoc);",
    planted: "document_revise writes the source that explains the revision before the guards " +
      "run, so a revision the platform then refuses leaves that source on disk while the " +
      "caller is told the write failed — the store keeps material for a version that never " +
      "happened",
  },
  {
    check: "scripts/gate/checks/documents-guards.ts",
    target: "every exclusive input pair refuses both-supplied, distinctly",
    subject: "services/zz-core/src/tools/initiative-close.ts",
    find: "ERROR: `accepted_by` and `no_signoff_reason` are contradictory",
    replace: "ERROR: these two arguments are contradictory",
    planted: "the refusal for a close that both names an acceptor and says nobody signed off " +
      "stops naming which two arguments conflict, so the caller is told they contradicted " +
      "themselves and not what to take out",
  },
  {
    check: "scripts/gate/checks/documents-guards.ts",
    target: "the claim reader reads a criterion written as a checklist item",
    subject: "packages/indexing/src/rules.ts",
    find: "(?:[-*][ \\t]*)?(?:\\\\[[ x]\\\\][ \\t]*)?",
    replace: "",
    planted: "the claim reader goes back to anchoring on `**` at line start, so a criterion " +
      "written `- [ ] **AC-6.1** …` — which is how sdlc-flow writes every one of them — is " +
      "indexed not at all, while the console still shows the result under the heading " +
      "\"acceptance criteria\"",
  },
  {
    check: "scripts/gate/checks/documents-guards.ts",
    target: "a tool that builds a path from an initiative name checks it first",
    subject: "services/zz-core/src/tools/artifacts.ts",
    find: "      const badInitiative = safeName(initiative, \"initiative\");",
    replace: "      const badInitiative: string | null = null;",
    planted: "source_add builds `<initiative>/sources/…` out of the raw argument again, so a " +
      "name like `a/b` — which every other initiative-taking tool refuses — attaches material " +
      "to something no tool calls an initiative",
  },
  {
    check: "scripts/gate/checks/documents-guards.ts",
    target: "a refusal names a way out the tool it came from actually has",
    subject: "services/zz-core/src/document-rules.ts",
    find: "\"`title` — is a named argument",
    replace: "\"`flow` — is a named argument",
    planted: "the frontmatter refusal tells the caller to pass `flow` as an argument to the " +
      "call it came from, and neither document_write nor document_revise takes one — the " +
      "refusal that exists to teach the way out gives an instruction the tool cannot obey",
  },
  {
    check: "scripts/gate/checks/documents-guards.ts",
    target: "a refusal class keeps the number that IS the refusal",
    assertion: "a status-carrying number that must survive redaction (`http <code>`)",
    subject: "packages/contracts/src/index.ts",
    find: "  [/(?<!\\b(?:code|status|http)\\s)\\b\\d+\\b/g, \"<n>\"],",
    replace: "  [/(?<!\\b(?:code|status)\\s)\\b\\d+\\b/g, \"<n>\"],",
    planted: "the exemption narrows back to the two shapes a block happens to use, so the " +
      "platform's own transport refusals — `http 404`, `http 502`, `http 503` — all collapse " +
      "into one class, and a door that is not there counts as the same problem as an upstream " +
      "dying mid-response",
  },
  {
    check: "scripts/gate/checks/documents-guards.ts",
    target: "a path is resolved before the document at it is judged",
    assertion: "a tool that judges a document and never resolves its path at all",
    subject: "services/zz-core/src/tools/artifacts.ts",
    find: "      const target = await safePath(path);\n" +
      "      if (!existsSync(target)) return text(`ERROR: ${path} does not exist`);",
    replace: "      const target = join(root, path);\n" +
      "      if (!existsSync(target)) return text(`ERROR: ${path} does not exist`);",
    planted: "document_patch stops resolving the path through the store's own resolver, so a " +
      "path the store would never accept is judged as a document instead — and the refusal " +
      "that teaches the path form never reaches the caller who needs it",
  },

  /* ── the envelope ─────────────────────────────────────────────────────── */
  {
    check: "scripts/gate/checks/documents-envelope.ts",
    target: "nothing reads an envelope field except parseEnvelope",
    subject: "services/zz-core/src/tools/artifacts.ts",
    find: "        const env = parseEnvelope(existsSync(join(root, initiative, d))\n" +
      "          ? readFileSync(join(root, initiative, d), \"utf8\") : \"\");\n" +
      "        return env.status === \"approved\";",
    replace: "        const txt = existsSync(join(root, initiative, d))\n" +
      "          ? readFileSync(join(root, initiative, d), \"utf8\") : \"\";\n" +
      "        return /^status: approved/m.test(txt);",
    planted: "source_add decides whether a document was already approved with its own regex, " +
      "which reads the whole document rather than the frontmatter and takes the first match " +
      "rather than the last — so a body line that begins `status: approved` makes a draft " +
      "look signed",
  },
  {
    check: "scripts/gate/checks/documents-envelope.ts",
    target: "only an act may move the fields the platform owns",
    assertion: "an act that passes a `via` that is not its own name",
    subject: "services/zz-core/src/tools/initiative-acts.ts",
    find: "      const bad = documentGuards(chain, root, relPath, fixed.content, team, \"document_revise\");",
    replace: "      const bad = documentGuards(chain, root, relPath, fixed.content, team, \"document_approve\");",
    planted: "document_revise tells the guard it is the approval act, so the bypass that lets " +
      "an act move status, approved_by and the rest is held by a caller claiming somebody " +
      "else's name — and whichever act is named is the one the record will show",
  },
  {
    check: "scripts/gate/checks/documents-envelope.ts",
    target: "the envelope vocabulary is defined once",
    assertion: "no second literal copy of the vocabulary outside @zz/contracts",
    subject: "packages/tools/src/testing/manifest-audit.ts",
    find: "    if (status && !(STATUSES as readonly string[]).includes(status)) {",
    replace: "    if (status && ![\"draft\", \"approved\"].includes(status)) {",
    planted: "the store audit carries its own copy of the status vocabulary, so a status the " +
      "contract gains is enforced by the platform and refused by the audit — an audit whose " +
      "whole value is that it agrees with the thing it audits",
  },
  {
    check: "scripts/gate/checks/documents-envelope.ts",
    target: "the model writes the body and the platform writes the envelope",
    assertion: "document_revise refuses content that opens with frontmatter",
    subject: "services/zz-core/src/tools/initiative-acts.ts",
    find: "      const refusedFm = frontmatterRefusal(content, \"document_revise\") ?? fieldRefusal(fields)\n" +
      "        ?? tagRefusal(tags);",
    replace: "      void frontmatterRefusal;\n" +
      "      const refusedFm = fieldRefusal(fields) ?? tagRefusal(tags);",
    planted: "document_revise accepts content that opens with frontmatter again, so every " +
      "revision is a chance for the model to type the envelope — the third source, back on " +
      "the one path whose whole job is to rewrite an approved document",
  },
  {
    check: "scripts/gate/checks/documents-envelope.ts",
    target: "the envelope is stamped by what governs the document",
    assertion: "a declared but ungated document is stamped no status",
    subject: "services/zz-core/src/write-guards.ts",
    // Bounded by the line after it: `gated` is computed the same way in sectionCheck, and an
    // anchor that cannot say which of the two it means is not a measurement.
    find: "  const gated = chain.documents.some((d) => d.name === parts[1] && d.gate);\n" +
      "  const role = governed ? chain.roles[parts[1]] : undefined;",
    replace: "  const gated = governed;\n" +
      "  const role = governed ? chain.roles[parts[1]] : undefined;",
    planted: "every document the manifest declares is stamped `status: draft`, gate or no gate, " +
      "so an ungated document carries a verdict nobody was ever asked for — and document_write " +
      "then cannot rewrite it, because the absent status on the fresh envelope reads as an " +
      "attempt to remove a platform-owned field",
  },
  {
    check: "scripts/gate/checks/documents-envelope.ts",
    target: "nothing tells an agent to write a field the platform owns",
    assertion: "a message that tells the agent to put something in the frontmatter",
    subject: "services/zz-core/src/tools/initiative-status.ts",
    find: "             \"once the stakeholder agrees — nothing downstream may be written until that gate is recorded\",",
    replace: "             \"once the stakeholder agrees — or record status: approved with approved_by and approved_at in the frontmatter\",",
    planted: "the next move the platform computes every turn tells the agent to write the " +
      "approval into the frontmatter, which every write path refuses — so an agent following " +
      "the instruction it is told to trust is refused by the platform that gave it",
  },
  {
    check: "scripts/gate/checks/documents-envelope.ts",
    target: "where a frontmatter block starts and ends is spelled once",
    subject: "services/zz-core/src/persist.ts",
    find: "export function setEnvelopeField(doc: string, field: string, value: string): string {\n" +
      "  const m = doc.match(ENVELOPE_BLOCK);",
    replace: "export function setEnvelopeField(doc: string, field: string, value: string): string {\n" +
      "  const m = doc.match(/^---[ \\t]*\\n([\\s\\S]*?)\\n---\\n/);",
    planted: "the writer spells the frontmatter block again and its copy insists on a newline " +
      "after the closing fence, so a document that ends exactly at its fence has an envelope " +
      "to every other reader and none to this one — and the field it was asked to set is " +
      "silently not set",
  },
  {
    // The dispatcher's list files this id under documents-envelope.ts, where line 279 quotes
    // the name in a comment. It is REGISTERED in skill-prose.ts, and `check` is the file that
    // registers it, so that is what this row names.
    check: "scripts/gate/checks/skill-prose.ts",
    target: "no skill template hands a model a field the platform owns",
    assertion: "a fenced template carrying envelope keys the platform owns",
    subject: "catalog/sdlc/sdlc-flow/skills/sdlc-explore/SKILL.md",
    find: "# No frontmatter. document_write takes the BODY; the platform writes the envelope.",
    replace: "# The header this document opens with:\nflow: sdlc-flow\ntype: exploration\nstatus: draft",
    planted: "the explore template hands the model the envelope back — flow, type and a gate " +
      "verdict — so an agent copying the skeleton it was given is refused on the very first " +
      "save of the very first document of the flow",
  },

  /* ── the lifecycle ────────────────────────────────────────────────────── */
  {
    check: "scripts/gate/checks/documents-lifecycle.ts",
    target: "a document the flow does not declare can still record why it changed",
    assertion: "document_revise does not refuse an undeclared document",
    subject: "services/zz-core/src/tools/initiative-acts.ts",
    find: "      // is no gate on it, so there is no verdict to record. A revision is not a gate.",
    replace: "      // is no gate on it, so there is no verdict to record. A revision is not a gate.\n" +
      "      if (chain.documents.length && !chain.docs.has(parts[1]))\n" +
      "        return text(`ERROR: ${parts[1]} is not a document this flow declares`);",
    planted: "the refusal returns, so on a governed initiative an undeclared document can be " +
      "created and rewritten by document_write forever and is the one document that can never " +
      "record why it changed — the platform's own law inverted on exactly the documents no " +
      "flow is watching",
  },
  {
    check: "scripts/gate/checks/documents-lifecycle.ts",
    target: "document_present returns a document, not a rendering or a summary",
    assertion: "the refusal names the missing path",
    subject: "services/zz-core/src/tools/artifacts.ts",
    find: "ERROR: no document at \\`${rel}\\`.",
    replace: "ERROR: this tool cannot present that.",
    all: true,
    planted: "document_present stops saying which path was missing, so a caller who mistyped " +
      "one is handed a list of what the initiative holds and no way to tell that the thing " +
      "they asked for is not in it",
  },
  {
    check: "scripts/gate/checks/documents-lifecycle.ts",
    target: "an act and the act that undoes it are recorded the same way",
    subject: "services/gateway/src/admin/teams.ts",
    find: "  auditAdmin(id, \"remove_member\", `${team}:${email}`, { ...extraDetail }, team);",
    replace: "  auditAdmin(id, \"remove_member\", `${team}:${email}`, { ...extraDetail });",
    planted: "a team sees a member added to it and never sees them removed, because only half " +
      "the pair records the team the activity feed is scoped by — the gap falling on the half " +
      "somebody goes looking for after an incident",
  },
  {
    check: "scripts/gate/checks/documents-lifecycle.ts",
    target: "the store audit applies the platform's close rules, not stricter ones",
    assertion: "the closing document's own gate is required even on a stop",
    subject: "packages/tools/src/testing/manifest-audit.ts",
    find: "    if (d.gate && closed && (!stopped || d.closing) && status !== \"approved\") {",
    replace: "    if (d.gate && closed && !stopped && status !== \"approved\") {",
    planted: "the stop exemption swallows the closing document's own gate, so an initiative " +
      "abandoned on a document nobody approved passes the audit — the platform applies that " +
      "one gate before the exemption, and the audit that exists to be believed now disagrees",
  },
  {
    check: "scripts/gate/checks/documents-lifecycle.ts",
    target: "nothing can clear the field that says an initiative already closed",
    assertion: "no write path removes `outcome`",
    subject: "services/zz-core/src/tools/initiative-acts.ts",
    find: "        delete env.approved_by; delete env.approved_at; delete env.status;",
    replace: "        delete env.approved_by; delete env.approved_at; delete env.status; delete env.outcome;",
    planted: "revising an ungated closing document clears the field that says the initiative " +
      "closed, so the close can run a second time and append a second ledger row for the same " +
      "work — which is what the OKR grading and the cross-flow comparison count",
  },
  {
    check: "scripts/gate/checks/documents-lifecycle.ts",
    target: "the closing document is resolved from the list the flow declared",
    assertion: "closingDoc is computed from the untouched `list` parameter",
    subject: "services/zz-core/src/chain.ts",
    find: "    closingDoc: list.find((d) => d.closing)?.name ?? list[list.length - 1]?.name ?? \"\",",
    replace: "    closingDoc: documents.find((d) => d.closing)?.name ?? documents[documents.length - 1]?.name ?? \"\",",
    planted: "the closing document is read off the array the platform appended its handover to, " +
      "so any flow that marks no `closing` gets handover.md as its closing document — " +
      "silently, and only for the flows whose manifests say least",
  },

  /* ── the documents this repository ships ──────────────────────────────── */
  {
    // NOT a deleted file: a spec is a find/replace on one subject and cannot remove one. The
    // link is pointed somewhere that is not there, which is the defect this check is about.
    check: "scripts/gate/checks/docs-integrity.ts",
    target: "a document's links point at something that exists",
    subject: "README.md",
    find: "Start here: `deploy/README.md` (server install and day-2 operations).",
    replace: "Start here: [deploy/README.md](deploy/INSTALL.md) (server install and day-2 operations).",
    planted: "the one line telling an installer where to start is a link to a page that is not " +
      "in the repository, which is worse than no link: it reads as though the instructions " +
      "exist somewhere the reader cannot find",
  },
  {
    check: "scripts/gate/checks/docs-integrity.ts",
    target: "the README describes the tree it ships with",
    assertion: "the skill count the README states per flow",
    subject: "README.md",
    find: "software delivery, 13 skills",
    replace: "software delivery, 11 skills",
    planted: "the map a newcomer reads states a skill count the flow does not ship, so the " +
      "first fact they check against the tree is wrong and the two they do not check are " +
      "no longer worth checking either",
  },
  {
    // ASSEMBLED, AND HERE IS WHY. This check sweeps every tracked `.ts` in the repository for
    // the names of the comment tools the platform removed, and the mutation workspace commits
    // this file — so the tool name written out whole here would fire the target at baseline.
    check: "scripts/gate/checks/docs-integrity.ts",
    target: "what someone says about a document has one home",
    assertion: "a comment TOOL named in shipped text",
    subject: "skills/zz-platform/SKILL.md",
    find: "- **`source_add` is how information reaches work in flight.** Minutes, an",
    replace: "- **`add_" + "comment` is how a remark on a document is recorded.** Use it when\n" +
      "  somebody writes on a document from the web; `source_add` is for material.\n" +
      "- **`source_add` is how information reaches work in flight.** Minutes, an",
    planted: "the platform skill teaches a second, cheaper door for what somebody says about a " +
      "document — one that does not version it, does not name it in the envelope and does not " +
      "freeze it with the approval it changed — so whether a remark enters the record depends " +
      "on which door the person used",
  },

  /* ── the names shipped prose spells out ───────────────────────────────── */
  {
    check: "scripts/gate/checks/prose-names.ts",
    target: "no shipped prose names a skill no plugin ships",
    subject: "catalog/sdlc/sdlc-flow/skills/sdlc-method/SKILL.md",
    // SEAMED, AND HERE IS WHY. `zz-backbone` is one of the two names in SKILL_ALIAS, and
    // `checks/skill-renames.ts` sweeps `scripts/` with comments stripped and strings kept — so
    // the name written out whole here is this file naming a skill that no longer exists, and
    // the gate goes red at baseline. `find` is left alone: it quotes the healthy current name.
    find: "call, the way `zz-platform`",
    replace: "call, the way `zz-back" + "bone`",
    // REDACTED, BECAUSE THE REPORT IS A TRACKED FILE THIS REPOSITORY SWEEPS TOO. The payload
    // above is seamed so it never exists whole in this source — but `plant()` writes the
    // RECONSTRUCTED string into testing/mutation-report.json, and that file is swept like any
    // other. Seaming the spec without redacting the row just moves the finding from one
    // tracked file to another, which is what the gate caught. `redact` base64-encodes it in
    // the artifact, so the experiment stays exactly reproducible and the report is not the
    // disclosure.
    redact: true,
    planted: "the skill every sdlc stage is told to read first sends the reader to a component " +
      "nothing else in the platform calls by that name and no plugin ships, so the rule it " +
      "cites for closing an initiative cannot be found by anybody who goes looking for it",
  },
  {
    // ASSEMBLED, AND HERE IS WHY. This check sweeps `.ts` under scripts/ as well as shipped
    // markdown, keeping string literals, and the mutation workspace commits this file — so an
    // undeclared command written out whole here would fire the target at baseline.
    check: "scripts/gate/checks/prose-names.ts",
    target: "no shipped prose types a slash command the plugin does not declare",
    subject: "catalog/sdlc/sdlc-flow/skills/sdlc-flow/SKILL.md",
    find: "plugin adds **one command**, `/sdlc:flow`, wherever the runtime exposes commands; the other",
    replace: "plugin adds **one command**, `/sdlc" + ":start`, wherever the runtime exposes commands; the other",
    planted: "the flow's own skill types a command its manifest does not declare, so the one " +
      "instruction a person is given for starting the flow returns nothing — in the text read " +
      "by the one reader who cannot tell whether the fault is theirs",
  },
];
