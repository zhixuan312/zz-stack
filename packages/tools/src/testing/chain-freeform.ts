/**
 * Closing without a declared closing document, walked against a live deployment.
 *
 * Two shapes, one subject. A freeform initiative has no manifest, so no closing document at all;
 * a governed initiative that is abandoned has one and does not reach it. Both are closes the
 * platform records somewhere other than where a manifest said it would.
 *
 * Split out of chain-check.ts by subject: that file walks a governed initiative, where a
 * manifest declares the documents, the order and the gates. Freeform is the supported opposite —
 * no flow named, no order enforced — and what still has to work is writing, approving and
 * closing on a document the caller names.
 *
 * COUPLED: `checks/chain-check-wiring.ts` follows this import, so a tool exercised here counts
 * as exercised.
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
    // Freeform is accepted: a missing flow is a choice the platform supports, and a door that
    // refused it would make every freeform initiative unreachable.
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
      // And an approved freeform document is not patched afterwards. `document_approve` accepts
      // any document in a freeform folder — a gate is a person saying yes, not a manifest — so
      // a guard that asked the manifest whether the document was gated would abstain and leave
      // the approver's name standing on bytes they never read.
      check("an approved freeform document is not patched afterwards",
        await call("document_patch", {
          path: `${freeName}/notes.md`, find: "hand-assembled", replace: "quietly changed",
        }), true, /document_revise/);
      check("a freeform initiative still closes, on the document it names",
        await call("initiative_close", {
          initiative: freeName, disposition: "finished", accepted_by: "Chain Check",
          document: "notes.md",
        }), false);
      // And a close that names nobody records the caller: the call carries a person's
      // authority, so closing is the sign-off. Asserted on the document, not on the response.
      const freeDoc = await call("document_read", { path: `${freeName}/notes.md` });
      const freeEnv = parseEnvelope(freeDoc);
      record(freeEnv.outcome === "accepted" && !!freeEnv.accepted_by,
             "a finished close records an acceptor", freeDoc);

      // And an abandon records none: `abandoned` says the work stopped before it was done, so
      // stamping the caller as the acceptor would put `accepted_by` on a record whose outcome
      // says the opposite.
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
        // And the closed record is not quietly overwritten. A closed document may be corrected
        // — document_revise freezes the signed text, bumps the version and requires a cause —
        // but document_write does none of that. Asserted on an abandoned close, which lands on
        // the furthest document that exists and which nobody approved, because no other guard
        // covers that case.
        check("a closed document is not overwritten by document_write",
          await writeDoc(`${stoppedName}/notes.md`, "rewritten after the close"),
          true, /document_revise/);
    }
  }

  // An initiative abandoned part-way reaches the ledger, on a governed flow.
  //
  // Abandoning is the close that does not land on the closing document, so `initiative_close`
  // records it on the furthest document that exists. `ledgerOnClose` must still append: the
  // ledger is what the team's counts are totalled from, and the abandoned close is the outcome
  // those counts most need.
  //
  // It cannot be asserted from the freeform walk beside it: a freeform chain has no closing
  // document, so only a flow that names one reaches this branch.
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
