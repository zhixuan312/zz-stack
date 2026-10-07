/**
 * The next move of an initiative that has closed: a correction awaiting its own approval, the
 * handover a finished close owes, or closed.
 *
 * Split out of `initiative-status.ts`, which reached the 700-line ceiling the gate enforces. It is
 * the closed branch of `initiativeState` and nothing else calls it, so the seam is the subject:
 * once an outcome is recorded the flow's chain has nothing left to answer, and what remains is
 * what the close itself still owes.
 */
import { OUTCOME_STOPPED } from "@zz/contracts";

import type { DocRow } from "../indexing.js";
import { isHandover } from "../stage-records.js";

/** The document facts the closed branch reads — a subset of `initiativeState`'s own. */
interface ClosedDoc {
  name: string; role?: string; exists: boolean; status: string | null; gate: boolean;
  approved_by?: string; approved_at?: string;
}

export interface Move { action: string; document?: string; stage?: string; waiting_on: string; why: string }

/** What a closed initiative waits on, if anything.
 *
 * The platform appends the handover to every flow, so what gets captured does not depend on the
 * flow author. Its completion signal is handover.md's own approval (zero knowledge nodes is a
 * legitimate outcome), read through `states` like every other gated document. A FINISHED close
 * owes it, so until it is approved the next move is the handover, not `closed`; an abandoned close
 * owes nothing. It stays writeable after the close (guards.ts).
 *
 * COUPLED: a close that still owes the handover, or a correction, is not `closed`, so the
 * no-argument listing shows it among the initiatives with work left and `nextMoveLine` names it
 * after every call. A flow that declares no handover at all is closed rather than stuck. */
export function closedMove(
  name: string, outcome: string, closedAt: string | null, states: ClosedDoc[], rows: Map<string, DocRow>,
): Move {
  const handover = states.find(isHandover);
  const owed = outcome !== OUTCOME_STOPPED && handover !== undefined && handover.status !== "approved";
  // A correction: a gated document approved before, a draft now, written after the close. It
  // awaits its own approval while the close and its ledger row stand. A stop waives the gate of the
  // document it lands on, so a draft it closed on is not one; a stop owes a correction only on the
  // document it stamped while approved — its approved revision carries the outcome — whichever
  // document that is.
  const corrected = (d: ClosedDoc): boolean => {
    const row = rows.get(d.name);
    return d.gate && d.status !== "approved" && !isHandover(d) && row?.approved_revision != null &&
      !!closedAt && Date.parse(row.updated_at) > Date.parse(closedAt) &&
      (outcome !== OUTCOME_STOPPED || !!row.approved_outcome);
  };
  const correction = states.find(corrected);
  if (correction) {
    return { action: "await_approval", document: correction.name, waiting_on: "stakeholder",
             why: `closed with outcome: ${outcome}, and ${correction.name} ` +
                  `v${rows.get(correction.name)?.current_version} is a correction awaiting its own ` +
                  `approval — document_approve("${name}/${correction.name}") signs it; the close ` +
                  "and its ledger row stand and are not recorded again." };
  }
  if (owed && handover.exists) {
    return { action: "await_approval", document: handover.name, waiting_on: "stakeholder",
             why: `closed with outcome: ${outcome}, and a finished close owes the handover: ` +
                  `${handover.name} is written and waiting on a verdict — ` +
                  `document_approve("${name}/${handover.name}") records it.` };
  }
  if (owed) {
    return { action: "write_document", document: handover.name, waiting_on: "agent",
             why: `closed with outcome: ${outcome}. A finished close owes the handover — it is ` +
                  "where the platform collects what this cycle taught: skill_read(\"zz-handover\") " +
                  `and run it; it writes ${handover.name} and mints what generalises.` };
  }
  const note = handover?.status === "approved"
    ? ` The handover is recorded: ${handover.name} was approved by ${handover.approved_by ?? "somebody"}` +
      `${handover.approved_at ? ` on ${handover.approved_at}` : ""}.`
    : outcome === OUTCOME_STOPPED
      ? " An abandoned close does not owe the handover; if the cycle taught something worth " +
        "keeping, `skill_read(\"zz-handover\")` mints it and writes handover.md."
      : "";
  return { action: "closed", waiting_on: "nobody",
           why: `closed with outcome: ${outcome}. The ledger row is the record.${note}` };
}
