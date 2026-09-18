/**
 * CLOSING WITHOUT A DECLARED CLOSING DOCUMENT, walked against a live deployment.
 *
 * Two shapes, one subject. A FREEFORM initiative has no manifest, so it has no closing
 * document at all; a GOVERNED initiative that is ABANDONED has one and does not reach it,
 * because stopping short is what abandoning means. Both are closes the platform records
 * somewhere other than where a manifest said it would, and both were unasserted.
 *
 * SPLIT OUT OF chain-check.ts BY SUBJECT, the way chain-bugs.ts and chain-shelf.ts were. That
 * file walks a GOVERNED initiative: a manifest declares the documents, the order and the gates,
 * and every assertion there is about that discipline holding. Freeform is the opposite case and
 * a supported one — a person opens an initiative without naming a flow, the platform enforces
 * no order, and what still has to work is every act that does not depend on a manifest:
 * writing, approving, and closing on a document the caller names.
 *
 * `checks/chain-check-wiring.ts` follows this import, so a tool exercised here counts as
 * exercised — the walk is what matters, not which file it is written in.
 */
import { parseEnvelope } from "@zz/contracts";

/** The pieces chain-check owns, handed in rather than re-made, so this walks the same door
 *  into the same result set. */
interface FreeformDeps {
  call: (tool: string, args: unknown) => Promise<string>;
  check: (name: string, got: string, wantError: boolean, because?: RegExp) => void;
  record: (ok: boolean, name: string, got: string) => void;
  writeDoc: (path: string, body: string) => Promise<string>;
  /** This run's slug, which every folder it opens is named from. */
  SLUG: string;
  /** The flow the governed half of this walk declares, and the document it opens on —
   *  read from that flow's own manifest by chain-check, never named here. */
  FLOW: string;
  OPENS_ON: string;
}

export async function walkFreeform({ call, check, record, writeDoc, SLUG, FLOW, OPENS_ON }: FreeformDeps): Promise<void> {
    // FREEFORM IS ACCEPTED. A missing flow is a choice the platform supports, and a door that
    // refused it would make every freeform initiative unreachable — with nothing here to say
    // so, because every other assertion in this probe declares a flow.
    const freeSlug = `${SLUG}-freeform`;
    const free = await call("initiative_open", { slug: freeSlug });
    check("opening without a flow is accepted", free, false);
    const freeName = (JSON.parse(free) as { initiative?: string; next_move?: unknown }).initiative;
    record(JSON.parse(free).next_move === null,
      "a freeform initiative is given no next move",
      `freeform next_move was ${JSON.stringify(JSON.parse(free).next_move)}, expected null`);
    check("a write into an initiative nobody opened is refused",
      await writeDoc(`${SLUG}-never-opened/spec.md`, "x"), true, /initiative_open/);
    if (freeName) {
      check("a freeform initiative still takes a document",
        await writeDoc(`${freeName}/notes.md`, "hand-assembled"), false);
      check("a freeform initiative still records a gate",
        await call("document_approve", { path: `${freeName}/notes.md`, on_behalf_of: "Chain Check" }),
        false);
      // AND AN APPROVED FREEFORM DOCUMENT IS NOT PATCHED AFTERWARDS. `document_approve`
      // accepts any document in a freeform folder on purpose — a gate is a person saying
      // yes, not a manifest — but `approvedDocumentGuard` asked the manifest whether the
      // document was gated and, finding none, abstained. So the approver's name could be
      // left standing on bytes they never read, by the one path where the platform had
      // already recorded a real signature.
      check("an approved freeform document is not patched afterwards",
        await call("document_patch", {
          path: `${freeName}/notes.md`, find: "hand-assembled", replace: "quietly changed",
        }), true, /document_revise/);
      check("a freeform initiative still closes, on the document it names",
        await call("initiative_close", {
          initiative: freeName, disposition: "finished", accepted_by: "Chain Check",
          document: "notes.md",
        }), false);
      // AND A CLOSE THAT NAMES NOBODY RECORDS THE CALLER, because the call carries a person's
      // authority: closing IS the sign-off. Asserted on the document rather than on the
      // response — "not refused" is a claim about the call, this is a claim about the record.
      const freeDoc = await call("document_read", { path: `${freeName}/notes.md` });
      const freeEnv = parseEnvelope(freeDoc);
      record(freeEnv.outcome === "accepted" && !!freeEnv.accepted_by,
             "a finished close records an acceptor", freeDoc);

      // AND AN ABANDON RECORDS NONE. `abandoned` says the work stopped before it was done, so
      // nobody got what they wanted — a close that stamped the caller as the acceptor put
      // `accepted_by` on a record whose outcome says the opposite, and it reached a real
      // initiative before anything noticed.
      const stopped = await call("initiative_open", { slug: `${SLUG}-stopped` });
      const stoppedName = (JSON.parse(stopped) as { initiative?: string }).initiative;
      if (stoppedName) {
        check("an initiative that stopped short takes a document",
          await writeDoc(`${stoppedName}/notes.md`, "stopped here"), false);
        check("an initiative that stopped short closes as abandoned",
          await call("initiative_close", {
            initiative: stoppedName, disposition: "abandoned", document: "notes.md",
          }), false);
        const stoppedDoc = await call("document_read", { path: `${stoppedName}/notes.md` });
        const stoppedEnv = parseEnvelope(stoppedDoc);
        record(stoppedEnv.outcome === "abandoned" && stoppedEnv.accepted_by === undefined,
               "an abandoned close records no acceptor", stoppedDoc);
        // AND THE CLOSED RECORD IS NOT QUIETLY OVERWRITTEN. A closed document may be
        // CORRECTED — document_revise freezes the signed text, bumps the version and makes
        // you say what caused the change — but document_write does none of that, and the
        // only thing that used to refuse it here was an accident: the fresh envelope
        // dropped `outcome`, and removing a platform-owned field is refused. The envelope
        // is carried forward now, so that accident is gone and the rule needs its own
        // guard. Asserted on an ABANDONED close because that is the case no other guard
        // covers: it lands on the furthest document that exists, which nobody approved.
        check("a closed document is not overwritten by document_write",
          await writeDoc(`${stoppedName}/notes.md`, "rewritten after the close"),
          true, /document_revise/);
    }
  }

  // AN INITIATIVE ABANDONED PART-WAY REACHES THE LEDGER, on a GOVERNED flow.
  //
  // Abandoning is the close that does not land on the closing document — the work stopped
  // before that document was written, which is what abandoning means — so
  // `initiative_close` records it on the furthest document that exists. `ledgerOnClose`
  // then returned without appending, because the document it was stamped on was not the
  // manifest's `closing` one, while the tool's own reply said "a ledger row was appended".
  // The ledger is what the team's counts are totalled from, and the abandoned close is the
  // outcome those counts most need.
  //
  // It cannot be asserted from the freeform walk beside it: a freeform chain has no
  // closing document, so that branch was never taken and every freeform abandon appended
  // its row correctly. Only a flow that names one reaches the bug.
  const stopSlug = `${SLUG}-stopped-gov`;
  const stopOpen = await call("initiative_open", { slug: stopSlug, flow: FLOW });
  check("a governed initiative opens for the abandon walk", stopOpen, false);
  const stopName = (JSON.parse(stopOpen) as { initiative?: string }).initiative;
  if (stopName) {
    const ledgerBefore = await call("document_read", { path: "_ledger.md" });
    check("a governed initiative that stopped short takes its first document",
      await writeDoc(`${stopName}/${OPENS_ON}`, OPENS_ON), false);
    check("a governed initiative closes as abandoned before its closing document exists",
      await call("initiative_close", { initiative: stopName, disposition: "abandoned" }), false);
    const ledgerAfter = await call("document_read", { path: "_ledger.md" });
    const stopRow = `| ${stopName} |`;
    record(ledgerAfter.includes(stopRow) && !ledgerBefore.includes(stopRow),
      "an abandoned close appends a ledger row even off the closing document",
      ledgerAfter.slice(-200));
  }

}
