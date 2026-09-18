/**
 * The acts: approving a document and revising an approved one. Opening and closing an
 * initiative are their own files, registered from here so the acts stay one registration.
 *
 * AN ACT IS THE ONLY THING THAT MAY MOVE THE FIELDS THE PLATFORM OWNS. `status`,
 * `approved_by`, `approved_at`, `outcome`, `closed_by` are stamped from the session and the
 * clock, and every write path refuses them typed by a caller — which is a rule that means
 * something only because these three are the exception and there is no fourth.
 *
 * `document_revise` exists because an approved document cannot be written over: the
 * approver's name would stand on bytes they never read. It bumps the version, returns the
 * document to draft, clears the stale approval and keeps the approved copy in `_versions/`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseCaller, parseEnvelope } from "@zz/contracts";
import { indexDoc } from "@zz/indexing";
import { requestHeaders, text } from "@zz/mcp-http";
import { z } from "zod";

import { shownSinceLastChange } from "../attest.js";
import { chainFor } from "../chain.js";
import { fieldRefusal, frontmatterRefusal, oneLine, renderEnvelope } from "../document-rules.js";
import { documentGuards } from "../guards.js";
import { sourceDocument } from "../indexing.js";
import { DOC_REF, safePath, tagRefusal, titleSlug, userRoot, writeGuard } from "../paths.js";
import { logActivity, persistDocument, putEnvelopeField } from "../persist.js";
import { teamFor } from "../platform-db.js";
import { isoToday, normalizeSections } from "../write-guards.js";

import { registerInitiativeCloseTool } from "./initiative-close.js";
import { registerInitiativeOpenTool } from "./initiative-open.js";

export function registerInitiativeActTools(server: McpServer): void {
  // OPENING IS THE FOURTH ACT, and it lives in its own file for one reason: this one is at
  // 640 lines against the 700 the repository enforces, and a tool whose refusals are the
  // point does not fit in sixty. It is registered from here rather than from server.ts so
  // the acts stay one registration to the door — see initiative-open.ts for why the date is
  // the platform's and why a missing flow is a choice.
  registerInitiativeOpenTool(server);
  // CLOSING IS THE FIFTH, in its own file for the same reason: it is one subject — the act
  // that writes the outcome a team's counts are read from — and this file is at the ceiling.
  registerInitiativeCloseTool(server);

  server.registerTool(
    "document_approve",
    {
      description:
        "Record an approval on a document, in one call. THE PLATFORM writes `status: approved`, " +
        "`approved_by` from the identity of this session and `approved_at` from the system " +
        "clock — you write none of the three, and writing them by hand is refused. " +
        "Call it the MOMENT the person agrees, in whatever words the agreement arrived: an " +
        "approval that exists only in the chat does not exist, and the person must never be " +
        "the one who discovers that later. Do not ask them to confirm a second time, and do " +
        "not ask them to edit frontmatter. Use `on_behalf_of` only when the verdict is " +
        "someone else's and they are not this session — a stakeholder who said it elsewhere.",
      inputSchema: {
        path: z.string().describe("e.g. '2026-08-23-sample-queue/spec.md'"),
        on_behalf_of: z.string().optional().describe(
          "The person whose decision this is, when that is not the caller. Omit for the " +
          "normal case: you acting with someone's authority IS their decision, under their name."),
      },
    },
    async ({ path: relPath, on_behalf_of }) => {
      const who = parseCaller(requestHeaders());
      const root = await userRoot();
      const team = await teamFor(who.email);
      const parts = relPath.replace(/^\/+/, "").split("/");
      if (parts.length !== 2) return text("ERROR: path must be '<initiative>/<document>.md'");
      const blocked = writeGuard(relPath);
      if (blocked) return text(blocked);
      const target = await safePath(relPath);
      if (!existsSync(target)) {
        return text(`ERROR: ${relPath} does not exist — approve records a verdict on a document that is already written`);
      }
      const chain = chainFor(root, relPath);
      // ONLY A FLOW CAN SAY A DOCUMENT IS NOT ITS BUSINESS.
      //
      // This was `if (!chain.docs.has(parts[1]))` unconditionally, and a freeform initiative
      // resolves to EMPTY_CHAIN, whose `docs` is an empty Set — so EVERY approval on a
      // freeform initiative was refused, with an error naming a flow that does not exist.
      // A gate is a person saying yes and the platform stamping it, not a manifest; an
      // initiative that declared no chain has nothing to measure a document against, so
      // whatever is in the folder is approvable. A flow that DID declare its documents still
      // refuses one it never named — that is the flow's own discipline and it is untouched.
      if (chain.documents.length && !chain.docs.has(parts[1])) {
        return text(`ERROR: ${parts[1]} is not a document this flow declares`);
      }
      // AND DECLARING A DOCUMENT IS NOT GATING IT. This checked only that the flow NAMES the
      // document, never that it ADJUDICATES it — so `document_approve` would stamp
      // `status: approved` on explore.md, spec-audit.md and plan-audit.md, every one of which
      // sdlc-flow declares without a gate. That is where 179 of the rows came from.
      //
      // Fixing `stampEnvelope` was only half of it: that stops the platform WRITING
      // `status: draft` where no gate exists, and this stops a caller writing `approved` there.
      // Without both, the correction is undone by the next agent who approves an audit report
      // because a person said it looked fine — which is a real thing to say and not a verdict
      // the platform has anywhere to put.
      //
      // The refusal names the alternative, because the caller is not doing anything wrong: an
      // ungated document is finished BY BEING WRITTEN, and saying so is the whole answer.
      const entry = chain.documents.find((d) => d.name === parts[1]);
      if (entry && entry.gate !== true) {
        return text(
          `ERROR: ${parts[1]} carries no gate in ${chain.name ?? "this flow"}, so there is ` +
          "nothing to approve. A status records that a person was asked and answered; this " +
          "document was never put to anyone. It is complete because it was written — say so " +
          "and carry on. Which documents gate is the flow manifest's answer, and it can differ " +
          "between flows: the same name may be gated in one and not in another.");
      }
      const signer = (on_behalf_of ?? "").trim() || who.email;
      let doc = readFileSync(target, "utf8");
      const already = parseEnvelope(doc).status === "approved";
      doc = putEnvelopeField(doc, "status", "approved");
      doc = putEnvelopeField(doc, "approved_by", signer);
      doc = putEnvelopeField(doc, "approved_at", isoToday());
      const fixed = normalizeSections(chain, relPath, doc);
      const bad = documentGuards(chain, root, relPath, fixed.content, team, "document_approve");
      if (bad) return text(bad);
      // READ BEFORE THE WRITE, because persistDocument logs and this asks about the log.
      const fetched = shownSinceLastChange(root, relPath);
      persistDocument(chain, root, relPath, target, fixed.content, "document_approve");
      logActivity(root, relPath, { user: who.email, action: "document_approve", path: relPath, signer, fetched });
      return text(
        `${relPath} approved — recorded under ${signer}` +
        (on_behalf_of ? ` (on their behalf, by ${who.email})` : "") + ".\n" +
        (already ? "It was already approved; the record now carries this verdict instead.\n" : "") +
        (fixed.renamed.length ? `Renamed to the heading this flow declares: ${fixed.renamed.join(", ")}.\n` : "") +
        // SAID, NOT REFUSED, and the wording is the whole point.
        //
        // What this catches is real and was invisible: an initiative closed with four of its
        // six approvals carrying no `document_present` since the content last moved — an
        // eleven-task plan among them, approved twice, fetched never. Nothing disagreed,
        // because nothing was looking.
        //
        // It does not refuse, and it must not start to. `zz-platform` chose that, and there
        // is a second reason on top: a refusal here lands on the ONE call whose job is to
        // record a decision a person already made, so the cost of a false positive is a
        // model telling somebody their own approval was rejected. A line the caller reads
        // costs a fetch; a refusal costs the person's verdict.
        //
        // Addressed to the caller's next action rather than scolding the last one — the
        // approval is already recorded, so "fetch it before the next gate" is the only
        // advice that can still be taken.
        (fetched === false
          ? "\nNOT FETCHED: no `document_present` on this path since its content last changed, so " +
            "the record cannot show anyone saw these bytes before the verdict. The approval " +
            "stands — this is a note, not a refusal. Before the next gate, call " +
            "`document_present` and put what it returns in front of the person; a standing " +
            "\"approve without checking with me\" waives their REVIEW, not the fetch, because " +
            "the fetch is the part that reaches the record.\n"
          : "") +
        "The approved copy is frozen in _versions/. Downstream documents may now be written.",
      );
    },
  );

  server.registerTool(
    "document_revise",
    {
      description:
        "Revise a document and record WHY it changed, in one call. Send the BODY — the " +
        "platform writes the frontmatter. The platform bumps the " +
        "`version` (v1 -> v2), puts `status` back to draft so the gate goes to a human again, " +
        "clears the stale approval, and links the material behind the change; the previously " +
        "approved version stays in _versions/. " +
        "EVERY VERSION SAYS WHY IT CHANGED, one way or the other. If a person said something " +
        "new — a second brain dump, pasted notes, a decision taken elsewhere — pass their " +
        "words as source_content and they are stored as a source and linked, so v2 explains " +
        "itself. If you simply edited your own document, name WHAT you edited as self_edit. " +
        "A revision naming neither is refused, and naming both is refused. " +
        "Never overwrite an approved document with document_write.",
      inputSchema: {
        path: z.string().describe("e.g. '2026-08-23-sample-queue/intent.md'"),
        content: z.string().describe("The full revised document, body and all."),
        source_content: z.string().optional()
          .describe("The input that caused this change, verbatim (the person's own words). Stored as a source and linked."),
        source_title: z.string().optional()
          .describe("Short title for that input, e.g. 'Second brain dump — SLA and approvals'."),
        sources: z.array(z.string()).optional()
          .describe("Existing source files this revision is based on, e.g. ['sources/2026-08-23-sample-review.md']."),
        stakeholder: z.string().optional().describe("Who asked for this, where the document records one."),
        tags: z.array(z.string()).optional().describe("Index tags for this document."),
        title: z.string().optional().describe("Document title for the index."),
        fields: z.record(z.string()).optional()
          .describe("This FLOW's own frontmatter fields. Not envelope names."),
        note: z.string().optional().describe("One line on what changed and why."),
        self_edit: z.string().optional().describe(
          "WHAT you edited, when nothing outside the document caused this version — " +
          "'tightened the wording of AC-3', 'fixed the broken table'. It is a DECLARATION, " +
          "not a justification: nobody owes the platform a reason for editing their own " +
          "document. Send it INSTEAD OF source_content/sources/note, never alongside them — " +
          "they are opposite claims about the same version and supplying both is refused."),
      },
    },
    async ({ path: relPath, content, source_content, source_title, sources, note,
             self_edit, stakeholder, tags, title, fields }) => {
      const refusedFm = frontmatterRefusal(content, "document_revise") ?? fieldRefusal(fields)
        ?? tagRefusal(tags);
      if (refusedFm) return text(refusedFm);
      // WHAT CAUSED THIS VERSION, ASKED ONCE.
      //
      // The three fields below are the only ways a revision can point at something outside
      // itself, and `explained` further down used to re-derive the same predicate from the
      // same three arguments. Two copies of "was this caused by anything" is a rule that can
      // be half-changed — the file has already paid for that once with fieldRefusal.
      //
      // Emptiness is measured the way `explained` measured it: a blank string and `sources:
      // []` are not causes, so passing one of those with `self_edit` is not a contradiction.
      const selfEdit = (self_edit ?? "").trim();
      const causes = [
        source_content && source_content.trim() ? "source_content" : null,
        sources && sources.length ? "sources" : null,
        note && note.trim() ? "note" : null,
      ].filter((c): c is string => c !== null);
      // A VERSION CANNOT BOTH HAVE NO EXTERNAL CAUSE AND HAVE ONE.
      //
      // `self_edit` says nothing outside the document produced this version. Each of the
      // three fields above says something did. Taking both would mean writing a record that
      // contradicts itself, and there is no rule for deciding which half to believe —
      // silently preferring one is how initiative_close() and knowledge_reconcile() lost supplied values before
      // they were repaired. Refused, in the same shape as those two.
      if (selfEdit && causes.length) {
        return text(
          "ERROR: `self_edit` says nothing external caused this version, but you also " +
          "supplied `" + causes.join("`, `") + "`. Send the cause, or send `self_edit`, " +
          "not both.");
      }
      // A VERSION THAT NAMES NOTHING IS A CHANGE NOBODY CAN REDO.
      //
      // Silence used to be accepted and nudged: the success text said the record could not
      // tell "there was no cause" from "the cause was not captured", and one initiative
      // received that sentence four times and changed nothing. A nudge on the way out is
      // read after the write has already landed, which is the wrong end of the call.
      //
      // The gap it left is not tidiness. An approved spec is the thing the next reader
      // reasons from, and v2 arriving with nothing attached means they cannot tell a
      // decision taken elsewhere and incorporated from somebody's second thought — the two
      // carry opposite weight and look identical in the record.
      //
      // `self_edit` is why this can be required at all, and it is kept for exactly that:
      // the cost of the rule is one short declaration, not an invented source for a typo
      // fix. Both routes are named here because a caller who reaches this refusal has a
      // legitimate revision and the only question left is which claim to make.
      if (!selfEdit && !causes.length) {
        return text(
          "ERROR: nothing says what caused this version. An approved document does not " +
          "change with the reason left off the record: the next reader cannot tell a " +
          "decision taken elsewhere from a second thought. If a person said something " +
          "that made you change it, pass their words as `source_content`. If you simply " +
          "edited your own document, name what you edited as `self_edit` — a declaration " +
          "of WHAT changed, never a justification for changing it. Send one, not both.");
      }
      const who = parseCaller(requestHeaders());
      const root = await userRoot();
      const team = await teamFor(who.email);
      const parts = relPath.replace(/^\/+/, "").split("/");
      if (parts.length !== 2) return text("ERROR: path must be '<initiative>/<document>.md'");
      const blocked = writeGuard(relPath);
      if (blocked) return text(blocked);
      const target = await safePath(relPath);
      if (!existsSync(target)) return text(`ERROR: ${relPath} does not exist — document_write creates a document; document_revise changes one`);
      const chain = chainFor(root, relPath);
      // Narrowed by a flow's declaration, never by its absence — see document_approve above.
      // Unconditionally, this refused every revision on a freeform initiative.
      if (chain.documents.length && !chain.docs.has(parts[1]))
        return text(`ERROR: ${parts[1]} is not a document this flow declares`);

      const prevEnv = parseEnvelope(readFileSync(target, "utf8"));
      // AN INITIATIVE CLOSES ONCE, and this was the way round that.
      //
      // initiative_close() refuses a second close by reading `outcome` off the document, and
      // ledgerOnClose refuses a second row by reading it off the file on disk. document_revise
      // DELETED that field — it clears the governance fields so the gate goes back to a
      // person — while leaving `closed_by` and `accepted_by` standing. closeCheck fires only
      // on content that HAS an outcome, so nothing refused it. One revision of the closing
      // document reopened a closed initiative, left it stamped with who closed it and no
      // outcome, and let initiative_close() run again and append a SECOND ledger row for the same work.
      // _ledger.md is what the OKR grading and the cross-flow comparison count.
      //
      // Refused for the reason initiative_close() already gives, in the same words: a record's value is
      // that it is not edited afterwards.
      // A CLOSED RECORD MAY BE CORRECTED. WHAT CLOSED IT MAY NOT BE.
      //
      // This refused every revision of a closing document, and the reason it gave was true of
      // the code as it stood then: document_revise DELETED `outcome`, which reopened the
      // initiative and let initiative_close() append a second ledger row for the same work. That delete
      // is gone — `outcome` is carried forward from the previous envelope now, and the line
      // below makes that explicit rather than incidental — so the failure the refusal names
      // cannot happen: initiative_close() reads `outcome` off the document and refuses a second close,
      // and ledgerOnClose reads it off disk and returns before appending.
      //
      // What is left is the real rule, and it is narrower: an initiative closes ONCE, on ONE
      // verdict. Correcting what a report SAYS is a different act from changing what it
      // concluded, and refusing both cost the more useful one. A closed report whose numbers
      // were wrong stayed wrong, and the only remedy on offer — a journal node beside it —
      // is not read by anybody opening the report.
      //
      // Nothing here is a quiet overwrite. document_revise freezes the approved copy in
      // `_versions/`, bumps the version, records a revision_note, and returns the document to
      // draft so a PERSON approves the new text. The signed version stays retrievable and the
      // ledger never moves.
      const closedOutcome = prevEnv.outcome;
      const prevVersion = parseInt(prevEnv.version || "1", 10) || 1;
      const nextVersion = prevVersion + 1;
      const wasApproved = prevEnv.status === "approved";

      // The body, and only the body. This used to merge the caller's own frontmatter over
      // the previous envelope and then override the owned fields, which left `stakeholder`,
      // `tags` and `title` as YAML the model still composed — the third source the envelope
      // is not supposed to have. They are named arguments now, like everywhere else.
      const body = content;
      const linked = new Set<string>(
        (prevEnv.sources || "").split(",").map((x) => x.trim()).filter(Boolean));
      // A source ref is a path inside the initiative, so it has no room for a separator:
      // the list is written comma-joined and read comma-split.
      for (const src of sources ?? []) {
        if (!DOC_REF.test(src.trim())) {
          return text(`ERROR: source "${src}" must be a path inside the initiative — ` +
                      "letters, digits, dot, dash, underscore and / only");
        }
        linked.add(src.trim());
      }

      // The input that caused the change is knowledge too: it is stored beside the document
      // it changed, so v2 always says what made it differ.
      //
      // PREPARED HERE, WRITTEN AFTER THE GUARDS PASS. It used to be written at this point,
      // forty lines before documentGuards ran — so a revision the platform then REFUSED left
      // the source on disk, indexed into zz.doc and logged to activity, while the caller was
      // told the write had failed and reasonably believed nothing had happened. The store
      // kept a source document for a revision that never occurred, and it sat uncommitted
      // until some later act swept it into a commit under that act's name.
      //
      // Only the NAME is needed up here, because the document links to it by name. Nothing
      // has to exist on disk for that.
      let capturedSource: string | null = null;
      let pendingSource: { rel: string; doc: string } | null = null;
      if (source_content && source_content.trim()) {
        const title = (source_title || `Input behind v${nextVersion}`).trim();
        const slug = titleSlug(title, "source");
        const day = isoToday();
        let rel = `${parts[0]}/sources/${day}-${slug}.md`;
        let n = 2;
        while (existsSync(join(root, rel))) rel = `${parts[0]}/sources/${day}-${slug}-${n++}.md`;
        pendingSource = {
          rel,
          doc: sourceDocument({ title, by: who.email, day, supports: parts[1],
                                content: source_content.trim() }),
        };
        capturedSource = rel.slice(parts[0].length + 1);
        linked.add(capturedSource);
      }

      // WHETHER THE CAUSE WAS EXTERNAL, which by here is a real two-way question rather
      // than a three-way one. The refusal above spent the third state: a version with
      // nothing attached no longer reaches this line, so `explained` false means
      // `self_edit` was sent and says so, not that nobody wrote anything down.
      //
      // Links inherited from the previous version explain THAT version, not this one, so
      // they are not consulted here — a v1 with three sources does not make v2 explained.
      //
      // A reason is still not owed to anybody. What is required is which KIND of change
      // this was, and `self_edit` answers that in a few words without inventing a source.
      const explained = causes.length > 0;
      const env: Record<string, string> = { ...prevEnv };
      if (stakeholder?.trim()) env.stakeholder = oneLine(stakeholder);
      if (title?.trim()) env.title = oneLine(title);
      const revTags = (tags ?? []).map((t) => t.trim()).filter(Boolean);
      if (revTags.length) env.tags = revTags.join(", ");
      // Name checked by fieldRefusal above, like document_write's — this was the second copy of
      // that predicate, and a rule with two copies is a rule that can be half-changed.
      for (const [k, v] of Object.entries(fields ?? {})) {
        if (String(v).trim()) env[k.trim()] = oneLine(String(v));
      }
      // `outcome` is CARRIED, not merely left alone. Deleting it was the whole defect — it is
      // the field initiative_close() and ledgerOnClose both read to know an initiative was already
      // closed — and "we happen not to touch it" is not a guarantee the next edit inherits.
      // Written back from what the document said before this revision, every time.
      if (closedOutcome) env.outcome = closedOutcome;
      env.version = String(nextVersion);
      // A REVISION RETURNS THE GATE TO A PERSON — unless the initiative already closed, in
      // which case the gate is not a live question any more.
      //
      // Clearing the approval on a closed record produces a state the platform itself
      // refuses: closeCheck holds that a closing document carrying an outcome must be
      // approved, because the ledger row was written at that close and the document has to
      // agree with it. So a revision that reset the status could never be written at all,
      // which is how "a closed report cannot be corrected" survived as an accident of two
      // guards meeting rather than as a rule anybody had decided.
      //
      // What replaces the signature is not nothing. document_revise freezes the approved copy
      // in `_versions/` before writing, bumps the version, and records a revision_note saying
      // what changed — so the text a person actually signed stays retrievable, and the
      // correction is discoverable beside it rather than pretending to be the original.
      if (closedOutcome) {
        env.status = "approved";
      } else {
        delete env.approved_by; delete env.approved_at;
        env.status = "draft";
      }
      env.updated_at = isoToday();
      // `flow` and `type` are manifest facts, and stampEnvelope only ever ADDS them — it
      // cannot correct one that is already there and wrong. Since `given` is the caller's
      // whole frontmatter merged in, a revision could relabel which flow governs a document
      // and therefore which gates, which required documents and which closing rule apply to
      // it. The manifest decides both, every time.
      if (chain.name) env.flow = chain.name;
      const role = chain.documents.find((d) => d.name === parts[1])?.role;
      if (role) env.type = role;
      if (linked.size) env.sources = [...linked].join(", ");
      if (note) env.revision_note = note.replace(/\n/g, " ").slice(0, 200);
      const doc = renderEnvelope(env,
        ["flow", "type", "title", "stakeholder", "tags", "version", "updated_at", "status", "sources", "revision_note"]) +
        "\n" + body.replace(/^\n+/, "");
      // A revision is a write, and this was the one write path that checked nothing.
      //
      // Three of the checks are inert here by construction, and that is why the gap survived
      // a reading: this tool forces `status: draft` and deletes approved_by, approved_at and
      // outcome, so statusCheck, attributionCheck and closeCheck have nothing to fire on. The
      // rest do. (The count of the whole set is not written here — see documentGuards.)
      //
      // sectionCheck exempts a GATED document in draft — half-written is allowed while it is
      // being written. selection.md is not gated, so its declared sections are required on
      // every write, and revising one was a way to delete `## What past work recorded` from
      // a document that had it, with no refusal. The section a flow declares required is not
      // less required in v2.
      const fixed = normalizeSections(chain, relPath, doc);
      // `via` — document_revise is an ACT, and one whose whole job is to move the governance
      // fields: status back to draft, the stale approval cleared. Without saying so it would
      // be refused by the guard that exists to stop a model writing those by hand, which is
      // the correct guard refusing the one caller that is allowed to.
      const bad = documentGuards(chain, root, relPath, fixed.content, team, "document_revise");
      if (bad) return text(bad);

      // The revision is allowed, so the source that explains it is written now — before
      // persistDocument, so both land in ONE commit. They are one act: a correction arrived
      // and the document moved because of it, and a history that separates them invites the
      // reader to wonder which caused which.
      if (pendingSource) {
        const srcTarget = await safePath(pendingSource.rel);
        mkdirSync(resolve(srcTarget, ".."), { recursive: true });
        writeFileSync(srcTarget, pendingSource.doc);
        void indexDoc(root, pendingSource.rel, pendingSource.doc);
        logActivity(root, pendingSource.rel,
          { user: who.email, action: "source_add", path: pendingSource.rel, supports: parts[1] });
      }
      // Through persistDocument, like the other two paths, rather than a writeFileSync and
      // an indexDoc of its own. Keeping a second copy of "how a document is written down" is
      // how this tool came to be the only one that stamped nothing, snapshotted nothing and
      // checked nothing: each step was added to the shared writer and this one did not get
      // it. snapshotOnApproval and ledgerOnClose are inert here — a revision is a draft with
      // the outcome cleared — and being inert in the shared path is the point.
      persistDocument(chain, root, relPath, target, fixed.content, "revise");
      // THE TWO FIELDS BELOW ARE A PAIR, and the pair is what carries the three states. A
      // flag on its own collapses "no cause existed" and "the cause was not captured" into
      // one identical false — and the second is the one worth counting, because it is the
      // only one anybody can fix.
      //
      // Deliberately ABOVE this call and not inside it. The gate check that holds both names
      // to this payload reads a 600-character window either side of `action:
      // "document_revise"`, so a comment inside the object naming them would satisfy the
      // check on its own and keep passing after the field itself was deleted. A comment that
      // can stand in for the thing it describes is how a check quietly stops checking.
      logActivity(root, relPath, {
        user: who.email, action: "document_revise", path: relPath,
        version: nextVersion, sources: [...linked].join(","), explained,
        self_edit: selfEdit || null,
      });
      return text(
        // SAY WHAT ACTUALLY HAPPENED. This announced "status draft" unconditionally, and on
        // a closed record the status stays approved — so the one message a caller reads
        // described the opposite of what was written.
        `${relPath} revised: v${prevVersion} -> v${nextVersion}, status ${env.status}.\n` +
        (fixed.renamed.length
          ? `Renamed to the heading this flow declares: ${fixed.renamed.join(", ")}.\n` : "") +
        (closedOutcome
          ? `This initiative is CLOSED as \`${closedOutcome}\`, and the close is untouched: the ` +
            `ledger row stands and no second one can be written. The text a person signed is ` +
            `frozen as ${parts[0]}/_versions/${parts[1].replace(/\.md$/, "")}.v${prevVersion}.md. ` +
            `What changed here is what the report SAYS, not what it concluded — if the verdict ` +
            `itself was wrong, that is a journal node, not a revision.\n`
          : wasApproved
          ? `The v${prevVersion} approval is preserved in ${parts[0]}/_versions/ and no longer applies.\n`
          : "") +
        (capturedSource ? `The input behind it is stored as ${parts[0]}/${capturedSource}.\n` : "") +
        (linked.size ? `Linked sources: ${[...linked].join(", ")}\n` : "") +
        // TWO STATES, TWO SENTENCES — and the third one is gone from here because it is
        // gone from the tool. This branch used to carry a nudge for the version that named
        // no cause at all: "pass their words as source_content next time", read after the
        // write had landed, by a caller who in a third of cases had nothing to pass. One
        // initiative received it four times and changed nothing. That case is refused on
        // the way in now, so the only unexplained version reaching this line is one that
        // declared itself as such, and what it gets back is a confirmation, not a nudge.
        (selfEdit
          ? `Recorded as a self-edit: ${oneLine(selfEdit)}\n` +
            "Nothing outside the document caused this version, and the record says so — " +
            "which is a different fact from nobody having written the cause down.\n"
          : "") +
        "Nothing downstream may be written until this document is approved again.",
      );
    },
  );
}
