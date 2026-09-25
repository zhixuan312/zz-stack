/**
 * Closing an initiative: the one act that ends it.
 *
 * It writes the field a team's counts are read from — `outcome` — exactly once, on the document the
 * flow names or, for an abandon that never reached that document, on the furthest one the work did
 * reach.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { documentApplies, OUTCOME_STOPPED, closeInitiative, parseCaller, parseEnvelope } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import { z } from "zod";

import { closingDocRuledOut, factsFor, factsForWrite, OPEN_RECORD, openRecord, recordAbandoned } from "../initiative-record.js";
import { chainFor, frontmatterStatus } from "../chain.js";
import { oneLine } from "../document-rules.js";
import { documentGuards } from "../guards.js";
import { moduleForFlow } from "../host/index.js";
import { claimFor } from "../host/store.js";
import { safeName, safePath, userRoot, writeGuard } from "../paths.js";
import { logActivity, persistDocument, putEnvelopeField } from "../persist.js";
import { teamFor } from "../platform-db.js";
import { packagedModules } from "../reviewed-modules.js";

/** The action a completed flow grants. The module declares it on its closing step and this is the
 *  only place the service names it.
 *  COUPLED: rename it on that step too, or `actionClaim` refuses with a sentence about the step
 *  rather than about the name, and a reader goes looking in the wrong file. */
const CLOSE_ACTION = "close:initiative";

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
        // The stop word is the outcome's, so what the caller says and what the ledger records are
        // the same word and a rename cannot leave one behind. `finished` is this tool's own — the
        // platform derives `delivered` or `accepted` from it and whether anybody signed off.
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
      // A close cannot name an acceptor and also say nobody signed off. Refused rather than
      // silently preferring the acceptor, and before the neither-supplied check below. Scoped to
      // `finished`: `accepted_by`/`no_signoff_reason` disambiguate a finished close into `accepted`
      // or `delivered`, and an `abandoned` close's outcome turns on neither.
      if (disposition === "finished" && acceptor && reason) {
        return text(
          "ERROR: `accepted_by` and `no_signoff_reason` are contradictory — one says who " +
          "accepted this, the other says nobody did. You supplied both (`" + acceptor +
          "` / `" + reason + "`). Send the one that is true; a close that names an acceptor " +
          "needs no reason.");
      }
      // An abandon must not contradict the record. `abandoned` says the work stopped before it was
      // done; when every gate the flow declares is approved and every document it requires to close
      // exists, that sentence is false.
      //
      // Refused, not silently corrected: `delivered` is a claim about the work and only the caller
      // can make it. The platform's job is to say the two do not agree.
      if (disposition === OUTCOME_STOPPED) {
        const chain = chainFor(root, join(initiative, "probe.md"));
        const dir = join(root, initiative);
        // FR-58 (Task I-26): a gate or a requiredForClose document the branch has ruled out
        // (`not_applicable`) is excluded here too, for the same reason handover.md is —
        // without this, ANY flow declaring a conditional gate could never trip the refusal
        // below: the ruled-out document never exists, `gatesPassed`/`requiredPresent` would
        // read false forever, and the false-abandon refusal would never fire even when every
        // APPLICABLE gate is passed and everything the branch actually required exists.
        // A damaged `_facts.json` reads as no facts here (`factsForWrite`): the abandon is the
        // way out of an initiative whose branch cannot be read, so it must not refuse on it.
        const facts = factsForWrite(root, initiative, true) ?? {};
        const ruledOut = (d: { name: string; when?: Record<string, string | string[]> }): boolean =>
          !!d.when && documentApplies(d, facts) === "not_applicable";
        // DELIBERATE: `handover.md` is excluded from the gate set. It is derived onto
        // `chain.documents` for every flow that gates a document and cannot exist at close time —
        // zz-handover writes it after the close — so leaving it in makes `gatesPassed` permanently
        // false and disables this refusal entirely. It is also not a gate the flow's own work has
        // to pass to be finished; it is what the platform asks for afterwards.
        const gates = chain.documents
          .filter((d) => d.gate === true && d.name !== "handover.md" && !ruledOut(d));
        const gatesPassed = gates.length > 0 && gates.every(
          (d) => frontmatterStatus(join(dir, d.name)) === "approved");
        const requiredForClose = chain.closeRequires
          .filter((n) => !ruledOut(chain.documents.find((d) => d.name === n) ?? { name: n }));
        const requiredPresent = requiredForClose.length > 0
          && requiredForClose.every((n) => existsSync(join(dir, n)));
        if (gatesPassed && requiredPresent) {
          return text(
            `ERROR: ${initiative} does not look abandoned. Every gate this flow declares is ` +
            `approved (${gates.map((d) => d.name).join(", ")}) and everything it requires to ` +
            `close exists (${requiredForClose.join(", ")}). \`${OUTCOME_STOPPED}\` says the ` +
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
      // facts on the store, not only arguments to this call. `closeInitiative` in `@zz/contracts`
      // performs it — this file names none of the three outcome words and cannot.
      const probe = join(initiative, "probe.md");
      const chain = chainFor(root, probe);
      // A freeform initiative closes too, and the caller says on what. There is no manifest to read
      // a closing document off, and the outcome is the row a team's counts are built from, so it
      // cannot sit on a document nobody chose. A flow that does declare one keeps answering for
      // itself and `document` is ignored — except on an abandon whose closing document was never
      // written, where there is nothing for the flow's answer to point at.
      //
      // An abandon is recorded wherever the work stopped. A flow's closing document is written by
      // its last stage, so an initiative that stopped at the plan has none; the close goes on the
      // furthest declared document that exists instead. A caller may still name one with
      // `document`.
      const stopped = disposition === OUTCOME_STOPPED;
      const dirOf = join(root, initiative);
      // FR-58 (Task I-28): the flow's declared closing document (`chain.closingDoc`) can itself
      // be `when`-conditional — `improvement.md`, promotable only — and ruled out on every other
      // branch. That is not "stopped before it was written"; it is "this branch closes
      // somewhere else", and the SAME fallback this call already used for an abandon whose
      // closing document was never reached now also fires for a finished close whose declared
      // document the branch ruled out. `closingDocRuledOut` is the one question guards.ts's
      // `closeCheck` asks too, so the two never disagree about which document a close lands on.
      const declaredDoc = chain.documents.find((d) => d.name === chain.closingDoc);
      const ruledOut = closingDocRuledOut(declaredDoc, factsForWrite(root, initiative, stopped) ?? {});
      const missing = stopped && !!chain.closingDoc && !existsSync(join(dirOf, chain.closingDoc));
      const furthest = (ruledOut || missing)
        ? [...chain.documents].reverse()
          .find((d) => d.name !== "handover.md" && existsSync(join(dirOf, d.name)))?.name
        : undefined;
      const named = (document ?? "").trim();
      const closingDoc = chain.closingDoc
        ? ((ruledOut || missing) ? named || furthest || "" : chain.closingDoc)
        : named;
      if (!closingDoc) {
        if (stopped) {
          // An empty initiative is abandoned on its own record, not on a document nobody wrote —
          // an initiative opened by mistake has no documents by definition and never will.
          //
          // `_open.json` is the platform's own record of the open, so it is where the platform
          // records that the open was undone. No ledger row is appended: a team's counts are built
          // from work that happened, and this is the record of work that did not.
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
          // And it closes once, like every other initiative. The kernel is what refuses, from the
          // fact this reads back; no gate posture is passed, because an initiative holding no
          // document declares no gate to anybody.
          //
          // COUPLED: `abandoned_at` is the marker, and initiative_status reads the same one — that
          // branch tests `rec?.abandoned_at` and prints `abandoned_by ?? null` beside it. Asking
          // `abandoned_by` here instead makes the two disagree on a record carrying one and not the
          // other (`openRecord` validates no field), and status would go on offering a close this
          // refuses.
          const undo = closeInitiative({ disposition, already: Boolean(rec.abandoned_at) });
          if (!undo.ok) {
            return text(
              `ERROR: ${undo.refusals.join("; ")}.\n\n${initiative} holds no document and was ` +
              `already abandoned on ${rec.abandoned_at}` +
              // Named only when the record names somebody: "abandoned by undefined" reports this
              // sentence's own missing field, not who did it.
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
      // An initiative closes once. A second close overwrites `outcome` on the document while
      // ledgerOnClose returns early when one is already there, so the document says the new word and
      // the ledger goes on saying the first.
      //
      // Refused rather than reconciled: an outcome that can be revised months later is one nobody
      // can rely on having read. A close that was genuinely wrong is a journal node saying so.
      const already = parseEnvelope(doc).outcome;
      // Closing is the sign-off, and the closer is the person who signed. Every call carries a
      // person's authority — a session is a principal, and an agent calls this under the authority
      // of whoever it works for — so `initiative_close(finished)` is somebody saying the work is
      // what they wanted. Silence means the closer accepted it, not that nobody did.
      //
      // Neither extra argument is required: `accepted_by` names somebody other than the closer, and
      // `no_signoff_reason` is the deliberate route for a close nobody accepted, which records
      // `delivered`.
      //
      // Only a finished close has a sign-off. `abandoned` says the work stopped before it was done,
      // so there is nothing for anybody to have accepted.
      const signedBy = disposition === OUTCOME_STOPPED || reason ? "" : (acceptor || who.email);
      // The kernel closes the work. This service reads the facts back and renders the sentence.
      //
      // `already` is a fact read back off the store, not an opinion: the kernel holds no filesystem,
      // refuses on it, and never writes it.
      //
      // COUPLED: `gatesRecorded` is deliberately not sent. `closeCheck`, one call below in
      // documentGuards, owns that question through `admitEntry` — the flow's gated documents that
      // were written, all approved, waived for a stop — and two implementations of one rule agree
      // until the day one is edited. The write path is the right owner: a gate rule enforced here is
      // one a second tool that writes an outcome would not inherit. The record's `gatePosture` is
      // `unstated` as a result, which is what this call declares about gates.
      //
      // The argument is `signedBy` and not `acceptor` because who counts as having signed off is a
      // policy about authority and belongs here. The kernel's rule is the narrower one — does an
      // acceptor exist.
      //
      // The grant is for a finished close on a governed flow, and only then. `closeCheck` answers a
      // document-level question: are the flow's gated documents written and approved. This answers a
      // procedure-level one through the reviewed module: is the whole declared chain satisfied, back
      // to the first step. The second subsumes the first for a flow that declares a module, and the
      // first is the only answer available for the flows that do not.
      //
      // An abandon claims nothing. The work is being reported as unfinished, which is what an
      // unsatisfied chain would have said anyway; what a grant gates is the claim that the flow was
      // completed.
      //
      // A waiver is read beside the refusal, never folded into it. `standing.clear` is the two read
      // together; `standing.unmet` stays the engine's own answer. So an initiative whose audit never
      // happened and whose gap somebody signed for can finish, and the record goes on saying the
      // audit is missing.
      if (disposition !== OUTCOME_STOPPED) {
        const governed = moduleForFlow(packagedModules, chain.name);
        if (governed && team) {
          const closingStep = [...governed.module.steps]
            .reverse().find((st) => st.grants.includes(CLOSE_ACTION));
          // FR-58 (Task I-27): a step whose own document(s) — `FlowDoc.stage`, the same
          // convention the console's `stageIndex` draws on — the branch has ruled
          // `not_applicable` owes this run nothing. Without this, a reviewed module gating a
          // conditional document (protocol.md under `when: protocol_action`, say) could never be
          // closed on the branch that rules it out: the document never exists to be written, so
          // the step's own completion rule would read `unmet` forever. A step with no document at
          // all, or one whose document still applies, is untouched — `documentApplies` answers
          // `applies` for anything carrying no `when`.
          const facts = factsFor(root, initiative);
          const ruledOutSteps = governed.module.steps
            .filter((st) => {
              const docs = chain.documents.filter((d) => d.stage === st.id);
              return docs.length > 0 && docs.every((d) => documentApplies(d, facts) === "not_applicable");
            })
            .map((st) => st.id);
          const claimed = closingStep
            ? await claimFor(team, initiative, governed.module, closingStep.id, CLOSE_ACTION, ruledOutSteps)
            : null;
          if (claimed && !claimed.grant.granted && !claimed.standing.clear) {
            return text(
              `ERROR: ${initiative} cannot claim ${CLOSE_ACTION} — ${claimed.grant.refusal}\n\n` +
              `The flow ${chain.name} declares a procedure and this run has not satisfied it. ` +
              `Still outstanding: ${claimed.standing.unmet.join("; ")}.\n` +
              `Record what is missing, or close as abandoned — stopping needs no grant, and a ` +
              `close that reports the work unfinished is always available.`);
          }
        }
      }

      const record = closeInitiative({
        disposition,
        accepted_by: signedBy,
        no_signoff_reason: reason || null,
        already: Boolean(already),
      });
      if (!record.ok) {
        // The kernel refused, and this puts back what it could not know: it holds no initiative
        // name and no word already on the document. Its refusals are printed as it wrote them, and
        // what this service adds is keyed on the fact it supplied rather than on the kernel's
        // wording — a branch matching its prose would be a second copy of its rules and would go
        // quiet the day one of them is reworded.
        //
        // One fact, so one branch: `already` is the only thing this call tells the kernel that the
        // kernel cannot say back in full.
        return text(`ERROR: ${record.refusals.join("; ")}.` + (already
          ? `\n\n${initiative} is already closed as \`${already}\`. The ledger row was appended ` +
            "at that close and is what the team's counts read, so changing the document now " +
            "would leave the two disagreeing. If that close was wrong, record WHY as a journal " +
            "node against this initiative — a correction somebody can find beats an overwrite " +
            "nobody can."
          : ""));
      }
      // The kernel returns null rather than guessing at a disposition it does not know, and a null
      // is one of the refusals above, so `ok` being true has already settled this. The schema
      // refuses an unknown disposition before either of them. What is left is the compiler.
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
        // Closed is complete: the close is terminal whatever it closed on, and status answers
        // `closed` from this moment. The handover is offered here rather than demanded.
        "Nothing further is owed. If this cycle taught something worth keeping, " +
        "`skill_read(\"zz-handover\")` mints it and writes handover.md — the close satisfies " +
        "that document's prerequisite, so it can be written even when the work stopped before " +
        "the document it would normally follow.",
      );
    },
  );
}
