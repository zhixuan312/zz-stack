/**
 * An initiative with NO FLOW, walked against a live deployment.
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
}

export async function walkFreeform({ call, check, record, writeDoc, SLUG }: FreeformDeps): Promise<void> {
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
    }
  }
}
