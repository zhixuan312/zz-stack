/**
 * Closing an initiative: the one act that ends it.
 *
 * ITS OWN FILE because it is its own subject and the acts file is at the repository's 700-line
 * ceiling. What makes this act different from the other three is that it writes the field a
 * team's counts are read from — `outcome` — and it writes it exactly once, on a document that
 * the flow names or, for an abandon that never reached that document, on the furthest one the
 * work did reach.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OUTCOME_STOPPED, closeInitiative, parseCaller, parseEnvelope } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import { z } from "zod";

import { OPEN_RECORD, openRecord, recordAbandoned } from "../initiative-record.js";
import { chainFor, frontmatterStatus } from "../chain.js";
import { oneLine } from "../document-rules.js";
import { documentGuards } from "../guards.js";
import { safeName, safePath, userRoot, writeGuard } from "../paths.js";
import { logActivity, persistDocument, putEnvelopeField } from "../persist.js";
import { teamFor } from "../platform-db.js";

export function registerInitiativeCloseTool(server: McpServer): void {
  server.registerTool(
    "initiative_close",
    {
      description:
        "Close an initiative, in one call. You say what you KNOW — the work `finished` or was " +
        "`abandoned`, and who accepted it if anyone did — and THE PLATFORM derives the outcome: " +
        "finished with an acceptor is `accepted`, finished without one is `delivered`, stopped " +
        "is `abandoned`. CLOSING IS THE SIGN-OFF: the close carries your authority, so you are " +
        "the acceptor unless you name another in `accepted_by` — or say in `no_signoff_reason` " +
        "that nobody accepted it, which is the deliberate route to `delivered`. " +
        "You never write `outcome` yourself and writing it by hand is refused. " +
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
          "Somebody OTHER than you who said this is what they wanted. Omit it and the close " +
          "records you: calling this is the sign-off."),
        document: z.string().optional().describe(
          "Which document records the close. REQUIRED for a freeform initiative, where no " +
          "flow declares a closing document. Ignored where one does — except on an " +
          "`abandoned` close whose closing document was never written, which records on the " +
          "furthest document the work reached, or on this one when you name it."),
        no_signoff_reason: z.string().optional().describe(
          "For a finished close that NOBODY accepted — one line on why. The outcome is then " +
          "`delivered`. Leave it out unless that is true; closing is otherwise an acceptance."),
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
        const chain = chainFor(root, join(initiative, "probe.md"));
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

      // The close is performed below, once the closing document has been read: whether anybody
      // signed off, whether the work was already closed and whether its gates were recorded are
      // facts ON the store, not only arguments to this call. It is performed BY
      // `closeInitiative` in `@zz/contracts`, which is the one place the platform holds those
      // rules — this file names none of the three outcome words and cannot.
      const probe = join(initiative, "probe.md");
      const chain = chainFor(root, probe);
      // A FREEFORM INITIATIVE CLOSES TOO, and the caller says on what.
      //
      // This refused outright when `chain.closingDoc` was empty — "the flow governing '<x>'
      // declares no closing document" — and EMPTY_CHAIN's closingDoc is `""`, so no freeform
      // initiative could ever be closed. The sentence also named a flow that does not exist.
      //
      // ASKED, NOT DERIVED. There is no manifest to read a closing document off, and the
      // alternatives are all guesses: the newest file, the only file, a document the platform
      // invents. The outcome is the row a team's counts are built from, so the one thing it
      // cannot sit on is a document nobody chose. A flow that DOES declare one keeps answering
      // for itself and `document` is ignored — except on an abandon whose closing document was
      // never written, where there is nothing for the flow's answer to point at.
      // AN ABANDON IS RECORDED WHEREVER THE WORK STOPPED.
      //
      // A flow's closing document is written by its LAST stage, so an initiative that stopped
      // at the plan has none — and requiring it made "abandoned" mean "write the review you
      // never did first". The close goes on the furthest declared document that exists
      // instead: the record then sits at the point the work actually reached, which is what
      // the word says. A caller may still name one with `document`.
      const stopped = disposition === OUTCOME_STOPPED;
      const dirOf = join(root, initiative);
      const furthest = stopped
        ? [...chain.documents].reverse()
          .find((d) => d.name !== "handover.md" && existsSync(join(dirOf, d.name)))?.name
        : undefined;
      const named = (document ?? "").trim();
      const closingDoc = chain.closingDoc
        ? (stopped && !existsSync(join(dirOf, chain.closingDoc)) ? named || furthest || "" : chain.closingDoc)
        : named;
      if (!closingDoc) {
        if (stopped) {
          // AN EMPTY INITIATIVE IS ABANDONED ON ITS OWN RECORD, not on a document nobody wrote.
          //
          // This refused: "an outcome is recorded ON a document, so there is nothing here to
          // mark. Write the first one". That is right for work that PRODUCED something and
          // wrong for the case it actually caught — an initiative opened by mistake, which has
          // no documents by definition and never will. The two rules were each correct alone
          // and together left no exit: it stayed open in initiative_status forever, or somebody
          // manufactured a document a stage never produced, which this platform refuses
          // everywhere else.
          //
          // `_open.json` is the platform's own record of the open, so it is where the platform
          // records that the open was undone. No ledger row is appended: a team's counts are
          // built from work that happened, and this is the record of work that did not.
          const rec = openRecord(root, initiative);
          if (!rec) {
            return text(
              `ERROR: ${initiative} has neither a document nor an open record, so there is ` +
              "nothing here to mark and nothing that says it was ever opened.");
          }
          if (readdirSync(join(root, initiative)).some((f: string) => f.endsWith(".md"))) {
            return text(
              `ERROR: ${initiative} holds documents but none its flow declares, so the close ` +
              "has nowhere it belongs by default. Name one: `document: \"<name>.md\"`.");
          }
          // AND IT CLOSES ONCE, like every other initiative.
          //
          // This path wrote `_open.json` again and answered success, so the one act the
          // platform refuses to perform twice was performed twice here and nothing said so.
          // It looked harmless because the second write is the same bytes — but "an
          // initiative closes once" is a rule about the ACT, not about the diff, and a path
          // exempt from it is a path where a caller cannot tell a close from a no-op.
          //
          // The kernel is the one that refuses, from the fact this reads back: no gate posture
          // is passed because an initiative holding no document declares no gate to anybody.
          //
          // `abandoned_at` IS THE MARKER, AND IT MUST BE THE SAME ONE initiative_status READS.
          // That branch tests `rec?.abandoned_at` and prints `abandoned_by ?? null` beside it,
          // so the date is what says an abandon happened and the name is what says who. Asking
          // `abandoned_by` here instead would have made the two disagree on a record carrying
          // one and not the other — `openRecord` casts whatever JSON it finds and validates no
          // field, so that record is a shape this platform can meet. The direction of the
          // disagreement is what makes it worth a line: status would go on offering a close
          // while this refused it, which is the platform instructing an act its own gate
          // refuses — the trap gateCheck's comment records already paying for once.
          const undo = closeInitiative({ disposition, already: Boolean(rec.abandoned_at) });
          if (!undo.ok) {
            return text(
              `ERROR: ${undo.refusals.join("; ")}.\n\n${initiative} holds no document and was ` +
              `already abandoned on ${rec.abandoned_at}` +
              // Named only when the record names somebody. "abandoned by undefined" is not a
              // fact about who did it, it is this sentence reporting its own missing field.
              `${rec.abandoned_by ? `, by ${rec.abandoned_by}` : ""}, on its own open record. ` +
              "Nothing here is left to mark. If that was wrong, record WHY as a journal " +
              "node against this initiative — a correction somebody can find beats a second " +
              "write nobody can.");
          }
          recordAbandoned(root, initiative, who.email);
          logActivity(root, `${initiative}/${OPEN_RECORD}`,
            { user: who.email, action: "initiative_close", initiative, outcome: OUTCOME_STOPPED });
          return text(
            `${initiative} abandoned — it holds no document, so the outcome is recorded on its ` +
            "own open record and no ledger row is appended. A team's counts are built from work " +
            "that happened; this is the record of work that did not.");
        }
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
      // CLOSING IS THE SIGN-OFF, and the closer is the person who signed.
      //
      // Every call carries a person's authority — a session is a principal, and an agent calls
      // this under the authority of whoever it works for. So `initiative_close(finished)` IS
      // somebody saying the work is what they wanted, and asking them to name themselves again
      // was ceremony: three initiatives closed `delivered` — "nobody signed it off" — with the
      // caller's own name on the close and on the approval of the very document it was written
      // on. Silence means the closer accepted it, not that nobody did.
      //
      // Two arguments still mean what they always did, and neither is required: `accepted_by`
      // names somebody OTHER than the closer, and `no_signoff_reason` is the deliberate route
      // for a close nobody accepted — automation finishing a queue, work shipped while the
      // stakeholder is away. That close records `delivered`, which is now what it says rather
      // than what a caller forgot to say.
      // AND ONLY A FINISHED CLOSE HAS ONE. `abandoned` says the work stopped before it was
      // done, so there is nothing for anybody to have accepted — stamping the closer as the
      // acceptor put "accepted_by" on a record whose outcome is that nobody got what they
      // wanted, which is the contradiction this tool refuses in the other direction.
      const signedBy = disposition === OUTCOME_STOPPED || reason ? "" : (acceptor || who.email);
      // THE KERNEL CLOSES THE WORK. This service reads the facts back and renders the sentence.
      //
      // It used to re-derive the outcome here — `stopped ? stopped : signedBy ? "accepted" :
      // "delivered"` — under a comment claiming to be "the one place the platform DERIVES an
      // outcome". That stopped being true when the rule landed in `@zz/contracts`, and calling
      // `deriveOutcome` closed that half. THE OTHER HALF WAS STILL HERE: whether the work had
      // already been closed, and whether its declared gates were recorded, are refusals
      // `closeInitiative` models — so the platform held one rule in the kernel and two beside
      // it, and the gate could only ever check the one it could see.
      //
      // `already` is a FACT READ BACK OFF THE STORE, not an opinion: the kernel holds no
      // filesystem, refuses on it, and never writes it.
      //
      // WHAT IS DELIBERATELY NOT SENT, and it is the interesting half. `closeInitiative` also
      // refuses over `gatesRecorded`, and this call does not supply it — not because the rule
      // is unwanted but because it already has an owner, and a rule with two owners has none.
      // `closeCheck`, one call below in documentGuards, answers exactly this question through
      // `admitEntry`: the flow's gated documents that were written, all approved, waived for a
      // stop. A copy here computed the same predicate from the same two functions, and two
      // implementations of one rule agree until the day one is edited.
      //
      // THE WRITE PATH IS THE RIGHT OWNER, which is why the copy went rather than the original.
      // documentGuards exists because these checks were once listed at each call site, so
      // "every new write path started with none of them and got whichever ones its author
      // remembered". A gate rule enforced HERE is a rule a second tool that writes an outcome
      // would not inherit; enforced there, nothing can write a closed document past it. The
      // record's `gatePosture` is `unstated` as a result, which is what this call honestly has
      // to say about gates: it declares none, so there is nothing unrecorded to refuse over.
      //
      // WHAT IS STILL THIS SERVICE'S OWN, and why the argument is `signedBy` and not `acceptor`.
      // Who counts as having signed off is a policy about AUTHORITY and it belongs here: closing
      // is the sign-off, so the closer signs unless they name somebody else, and a
      // `no_signoff_reason` says nobody did. `signedBy` above is that policy's answer. The
      // kernel's rule is the narrower one — does an acceptor exist.
      const record = closeInitiative({
        disposition,
        accepted_by: signedBy,
        no_signoff_reason: reason || null,
        already: Boolean(already),
      });
      if (!record.ok) {
        // THE KERNEL REFUSED, AND THIS PUTS BACK WHAT IT COULD NOT KNOW.
        //
        // Its sentences are general on purpose: it holds no initiative name and no word already
        // on the document. So its refusals are printed as it wrote them and what this service
        // can add is added after them — keyed on the FACT IT SUPPLIED rather than on the
        // kernel's wording, because a branch that matched its prose would be a second copy of
        // its rules and would go quiet the day one of them is reworded.
        //
        // ONE FACT, SO ONE BRANCH. `already` is the only thing this call tells the kernel that
        // the kernel cannot say back in full, and a list built to hold one string is a shape
        // kept for a second entry nobody has.
        return text(`ERROR: ${record.refusals.join("; ")}.` + (already
          ? `\n\n${initiative} is already closed as \`${already}\`. The ledger row was appended ` +
            "at that close and is what the team's counts read, so changing the document now " +
            "would leave the two disagreeing. If that close was wrong, record WHY as a journal " +
            "node against this initiative — a correction somebody can find beats an overwrite " +
            "nobody can."
          : ""));
      }
      // The kernel returns null rather than guessing at a disposition it does not know, and a
      // null is one of the refusals above — so `ok` being true has already settled this. The
      // schema refuses an unknown disposition before either of them. What is left is the
      // compiler, which cannot see any of that, and a refusal is the only honest thing to write
      // under a branch that says the outcome is missing.
      const outcome = record.outcome;
      if (outcome === null) {
        return text(`ERROR: no outcome can be derived from a disposition of ${JSON.stringify(disposition)}.`);
      }
      doc = putEnvelopeField(doc, "outcome", outcome);
      doc = putEnvelopeField(doc, "closed_by", who.email);
      if (signedBy) doc = putEnvelopeField(doc, "accepted_by", signedBy);
      if (!signedBy && reason) doc = putEnvelopeField(doc, "no_signoff_reason", reason);
      const bad = documentGuards(chain, root, relPath, doc, team, "initiative_close");
      if (bad) return text(bad);
      persistDocument(chain, root, relPath, target, doc, `close ${outcome}`);
      logActivity(root, relPath,
        { user: who.email, action: "initiative_close", initiative, outcome, accepted_by: signedBy || null });
      return text(
        `${initiative} closed as ${outcome}, recorded by ${who.email}.\n` +
        (signedBy ? `Accepted by ${signedBy}${!acceptor ? " — closing it is saying so" : ""}.\n`
          : disposition === OUTCOME_STOPPED
            ? "Nobody accepted it, because it stopped before it was done.\n"
            : `Nobody signed off — recorded reason: ${oneLine(reason)}.\n`) +
        "A ledger row was appended. The ledger is read by counting these, so the word matters.\n" +
        // CLOSED IS COMPLETE. This said the opposite -- "one step remains", the handover, and
        // "only then does initiative_status read closed". Both halves are gone: the close is
        // terminal whatever it closed on, and status answers `closed` from this moment.
        //
        // The handover is OFFERED here rather than demanded, and the distinction is the whole
        // point. A tool's own return text is documentation and rots like it; this one told
        // people for months that they owed a document its own gate would refuse them.
        "Nothing further is owed. If this cycle taught something worth keeping, " +
        "`skill_read(\"zz-handover\")` mints it and writes handover.md — the close satisfies " +
        "that document's prerequisite, so it can be written even when the work stopped before " +
        "the document it would normally follow.",
      );
    },
  );
}
