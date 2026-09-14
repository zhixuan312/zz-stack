/**
 * The three acts: approving a document, closing an initiative, and revising an approved one.
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
import { OUTCOMES, OUTCOME_STOPPED, parseCaller, parseEnvelope } from "@zz/contracts";
import { indexDoc } from "@zz/indexing";
import { requestHeaders, text } from "@zz/mcp-http";
import { z } from "zod";

import { shownSinceLastChange } from "../attest.js";
import { chainFor, frontmatterStatus } from "../chain.js";
import { fieldRefusal, frontmatterRefusal, oneLine, renderEnvelope } from "../document-rules.js";
import { documentGuards } from "../guards.js";
import { sourceDocument } from "../indexing.js";
import { DOC_REF, safeName, safePath, tagRefusal, titleSlug, userRoot, writeGuard } from "../paths.js";
import { logActivity, persistDocument, putEnvelopeField } from "../persist.js";
import { teamFor } from "../platform-db.js";
import { isoToday, normalizeSections } from "../write-guards.js";

import { registerInitiativeOpenTool } from "./initiative-open.js";

export function registerInitiativeActTools(server: McpServer): void {
  // OPENING IS THE FOURTH ACT, and it lives in its own file for one reason: this one is at
  // 640 lines against the 700 the repository enforces, and a tool whose refusals are the
  // point does not fit in sixty. It is registered from here rather than from server.ts so
  // the acts stay one registration to the door — see initiative-open.ts for why the date is
  // the platform's and why a missing flow is a choice.
  registerInitiativeOpenTool(server);

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
      const chain = await chainFor(root, relPath, team);
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
      const signer = (on_behalf_of ?? "").trim() || who.email;
      let doc = readFileSync(target, "utf8");
      const already = parseEnvelope(doc).status === "approved";
      doc = putEnvelopeField(doc, "status", "approved");
      doc = putEnvelopeField(doc, "approved_by", signer);
      doc = putEnvelopeField(doc, "approved_at", isoToday());
      const fixed = normalizeSections(chain, relPath, doc);
      const bad = await documentGuards(chain, root, relPath, fixed.content, team, "document_approve");
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
    "initiative_close",
    {
      description:
        "Close an initiative, in one call. You say what you KNOW — the work `finished` or was " +
        "`abandoned`, and who accepted it if anyone did — and THE PLATFORM derives the outcome: " +
        "finished with an acceptor is `accepted`, finished without one is `delivered`, stopped " +
        "is `abandoned`. You never write `outcome` yourself and writing it by hand is refused. " +
        "Closing without an acceptor is a legitimate route and costs a sentence saying why " +
        "nobody signed off — an honest close is never the expensive one, but it is never free " +
        "either.",
      inputSchema: {
        initiative: z.string().describe("The initiative folder, e.g. '2026-08-23-sample-queue'"),
        // The stop word is the OUTCOME's, deliberately: what the caller says and what the
        // ledger records are the same word for the same thing, and coupling them here means a
        // rename cannot leave one behind. `finished` is this tool's own — the platform
        // derives `delivered` or `accepted` from it and whether anybody signed off.
        disposition: z.enum(["finished", OUTCOME_STOPPED]).describe(
          `\`finished\`: the work was completed. \`${OUTCOME_STOPPED}\`: it stopped before it was.`),
        accepted_by: z.string().optional().describe(
          "The person who said this is what they wanted. Give it whenever somebody did — " +
          "their name, or the address they wrote from. Omit only when nobody has."),
        document: z.string().optional().describe(
          "Which document records the close. REQUIRED for a freeform initiative, where no " +
          "flow declares a closing document; ignored where one does, because the flow has " +
          "already answered."),
        no_signoff_reason: z.string().optional().describe(
          "Required when `finished` carries no `accepted_by`: one line on why nobody signed off."),
      },
    },
    async ({ initiative, disposition, accepted_by, no_signoff_reason, document }) => {
      const who = parseCaller(requestHeaders());
      const root = await userRoot();
      const team = await teamFor(who.email);
      const badName = safeName(initiative, "initiative");
      if (badName) return text(badName);
      const acceptor = (accepted_by ?? "").trim();
      const reason = (no_signoff_reason ?? "").trim();
      // A CLOSE CANNOT NAME AN ACCEPTOR AND ALSO SAY NOBODY SIGNED OFF.
      //
      // Supplying both used to silently prefer the acceptor: the reason reached neither the
      // document, the activity log, nor the response. Refused instead, and before the
      // neither-supplied check below, so both forced-choice defects sit next to each other.
      // Scoped to `finished`, like the check below it: `accepted_by`/`no_signoff_reason` exist
      // to disambiguate a FINISHED close into `accepted` or `delivered`, and an `abandoned`
      // close's outcome does not turn on either of them.
      if (disposition === "finished" && acceptor && reason) {
        return text(
          "ERROR: `accepted_by` and `no_signoff_reason` are contradictory — one says who " +
          "accepted this, the other says nobody did. You supplied both (`" + acceptor +
          "` / `" + reason + "`). Send the one that is true; a close that names an acceptor " +
          "needs no reason.");
      }
      if (disposition === "finished" && !acceptor && !reason) {
        return text(
          "ERROR: finished with nobody named needs `no_signoff_reason` — one line on why " +
          "nobody signed off. If somebody DID say this is what they wanted, pass their name " +
          "as `accepted_by` instead and the close records an acceptance.");
      }
      // AN ABANDON MUST NOT CONTRADICT THE RECORD.
      //
      // `abandoned` says the work stopped before it was done. When every gate the flow
      // declares is approved AND every document it requires to close exists, that sentence is
      // false, and the platform was writing it down anyway. Six initiatives on 2026-09-06
      // carry it with all six stages ticked, three of three gates approved and a verification
      // guide delivered — a page that reads "closed without finishing" above a row of green
      // ticks, which is the platform contradicting itself in one screen.
      //
      // What produced them was a harness that offered every run the same exit on the same
      // cycle after a transient block failure. That is our fault and not the platform's. But
      // a record the platform cannot tell is wrong is a record it will keep taking, so the
      // check belongs here rather than in whatever is driving.
      //
      // Refused, not silently corrected. `delivered` is a claim about the work and only the
      // caller can make it — the platform's job is to say the two do not agree.
      if (disposition === OUTCOME_STOPPED) {
        const chain = await chainFor(root, join(initiative, "probe.md"), team);
        const dir = join(root, initiative);
        // THE HANDOVER IS EXCLUDED, and leaving it in silently disabled this whole refusal.
        //
        // `chain.documents` now carries a derived `handover.md` for every flow that gates a
        // document, and that document CANNOT exist at close time — zz-handover writes it
        // after the close. So `frontmatterStatus` returned null for it, `every(...)` was
        // permanently false, `gatesPassed` could never be true, and the refusal below could
        // never fire — for all five qualifying flows. That is exactly the false-abandon
        // defect the comment above records six initiatives hitting on 2026-09-06, reopened
        // by the derivation that was supposed to be additive.
        //
        // documentGuards solves the same problem 4,200 lines up by skipping a gated document
        // that is not on disk yet (`if (!existsSync(f)) continue`); this site was never given
        // that guard. Skipping absent documents would also work, but naming the handover is
        // the more honest fix: it is not a gate the flow's own work has to pass to be
        // finished, it is what the platform asks for afterwards, so it does not belong in a
        // question about whether the delivery was complete.
        const gates = chain.documents.filter((d) => d.gate === true && d.name !== "handover.md");
        const gatesPassed = gates.length > 0 && gates.every(
          (d) => frontmatterStatus(join(dir, d.name)) === "approved");
        const requiredPresent = chain.closeRequires.length > 0
          && chain.closeRequires.every((n) => existsSync(join(dir, n)));
        if (gatesPassed && requiredPresent) {
          return text(
            `ERROR: ${initiative} does not look abandoned. Every gate this flow declares is ` +
            `approved (${gates.map((d) => d.name).join(", ")}) and everything it requires to ` +
            `close exists (${chain.closeRequires.join(", ")}). \`${OUTCOME_STOPPED}\` says the ` +
            "work stopped before it was done, and the record says it was done — a reader would " +
            "meet \"closed without finishing\" above a row of ticks.\n\n" +
            "If it IS finished, close it as `finished`: with `accepted_by` when somebody said " +
            "it is what they wanted, or with `no_signoff_reason` when nobody has. If it is " +
            "genuinely abandoned, say what is missing — a gate left open or a required " +
            "document never written is what makes that word true, and neither is the case here."
          );
        }
      }

      // Typed from OUTCOMES so the compiler holds this to the contract's vocabulary. It is
      // the one place the platform DERIVES an outcome, so it names all three words by
      // necessity — but naming them and being checked against them are different things, and
      // without the annotation a typo here would have shipped a word nothing else accepts.
      const outcome: (typeof OUTCOMES)[number] = disposition === OUTCOME_STOPPED ? OUTCOME_STOPPED
        : acceptor ? "accepted" : "delivered";
      const probe = join(initiative, "probe.md");
      const chain = await chainFor(root, probe, team);
      // A FREEFORM INITIATIVE CLOSES TOO, and the caller says on what.
      //
      // This refused outright when `chain.closingDoc` was empty — "the flow governing '<x>'
      // declares no closing document" — and EMPTY_CHAIN's closingDoc is `""`, so no freeform
      // initiative could ever be closed. The sentence also named a flow that does not exist.
      //
      // ASKED, NOT DERIVED. There is no manifest to read a closing document off, and the
      // alternatives are all guesses: the newest file, the only file, a document the platform
      // invents. The outcome is the row a team's counts are built from, so the one thing it
      // cannot sit on is a document nobody chose. A flow that DOES declare one keeps
      // answering for itself — `document` is ignored there rather than fought with, because
      // the flow's declaration is the more authoritative of the two.
      const closingDoc = chain.closingDoc || (document ?? "").trim();
      if (!closingDoc) {
        return text(
          `ERROR: no flow governs '${initiative}', so nothing declares which document records ` +
          "the close — name it: `document: \"<name>.md\"`. That is not a limitation of " +
          "freeform work, it is the one question a manifest would have answered. The outcome " +
          "is what the team's counts read, and it must not sit on a document the platform " +
          "picked for you.");
      }
      const badDoc = safeName(closingDoc, "document");
      if (badDoc) return text(badDoc);
      const relPath = `${initiative}/${closingDoc}`;
      const blocked = writeGuard(relPath);
      if (blocked) return text(blocked);
      const target = await safePath(relPath);
      if (!existsSync(target)) {
        return text(`ERROR: ${relPath} does not exist — a close is recorded ON a document, so it must be written first.`);
      }
      let doc = readFileSync(target, "utf8");
      // AN INITIATIVE CLOSES ONCE.
      //
      // A second close overwrote `outcome` on the document, and ledgerOnClose returns early
      // when one is already there — so the document said the new word and the team's ledger
      // went on saying the first. The ledger is what the OKR grading and the cross-flow
      // comparison COUNT, so "how many were accepted this quarter" and what the closing
      // document says would disagree, with nothing to notice.
      //
      // Refused rather than reconciled: a record's value is that it is not edited afterwards,
      // and an outcome that can be revised months later is one nobody can rely on having read.
      // If a close was genuinely wrong, that is a fact about the record worth writing down —
      // a journal node saying so, not a quiet overwrite.
      const already = parseEnvelope(doc).outcome;
      if (already) {
        return text(
          `ERROR: ${initiative} is already closed as \`${already}\`, and an initiative closes ` +
          "once. The ledger row was appended at that close and is what the team's counts read, " +
          "so changing the document now would leave the two disagreeing. If that close was " +
          "wrong, record WHY as a journal node against this initiative — a correction somebody " +
          "can find beats an overwrite nobody can.");
      }
      doc = putEnvelopeField(doc, "outcome", outcome);
      doc = putEnvelopeField(doc, "closed_by", who.email);
      if (acceptor) doc = putEnvelopeField(doc, "accepted_by", acceptor);
      if (!acceptor && reason) doc = putEnvelopeField(doc, "no_signoff_reason", reason);
      const bad = await documentGuards(chain, root, relPath, doc, team, "initiative_close");
      if (bad) return text(bad);
      persistDocument(chain, root, relPath, target, doc, `close ${outcome}`);
      logActivity(root, relPath,
        { user: who.email, action: "initiative_close", initiative, outcome, accepted_by: acceptor || null });
      return text(
        `${initiative} closed as ${outcome}, recorded by ${who.email}.\n` +
        (acceptor ? `Accepted by ${acceptor}.\n`
                  : `Nobody signed off — recorded reason: ${oneLine(reason)}.\n`) +
        "A ledger row was appended. The ledger is read by counting these, so the word matters.\n" +
        "Closed is not yet complete — one step remains, and it belongs to the platform rather " +
        "than to this flow. Run `skill_read(\"zz-handover\")` next: it mints whatever " +
        "generalises from this cycle and writes handover.md. That document is gated — a team " +
        "member approves it, and only then does `initiative_status` read `action: \"closed\"`.",
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
        blocks: z.array(z.string()).optional().describe(
          "On a SELECTION document: the building blocks chosen, replacing the previous set. " +
          "Leave it out to keep what the document already names — a revision that says " +
          "nothing about the blocks has not changed them."),
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
             self_edit, stakeholder, tags, title, blocks, fields }) => {
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
      const chain = await chainFor(root, relPath, team);
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
      // Carried forward from the previous envelope unless this revision names a new set. A
      // re-selection is exactly the case this exists for, and it is also the case where
      // silently keeping the old set would leave the later stages calling blocks the revised
      // document no longer chooses.
      const chosen = (blocks ?? []).map((b) => b.trim()).filter(Boolean);
      if (chosen.length) env.blocks = chosen.join(", ");
      if (note) env.revision_note = note.replace(/\n/g, " ").slice(0, 200);
      const doc = renderEnvelope(env,
        ["flow", "type", "title", "stakeholder", "tags", "blocks", "version", "updated_at", "status", "sources", "revision_note"]) +
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
      const bad = await documentGuards(chain, root, relPath, fixed.content, team, "document_revise");
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
