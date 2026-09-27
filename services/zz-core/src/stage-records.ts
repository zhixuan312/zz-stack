/**
 * What a record-producing stage still owes, and the platform's own closing step told apart from a
 * flow's own documents.
 *
 * Split out of `tools/initiative-status.ts`, which reached the 700-line ceiling the gate enforces.
 * Both are about the record a stage writes and the handover every flow ends with, not about
 * assembling an initiative's state, and neither is imported by anything else — so the seam is the
 * subject, not the line count.
 *
 * Not to be confused with `eval/stage-record.ts`, which WRITES a stage's record. This reads one.
 */

/** What a stage's record says it still owes, first first, each as the sentence `next_move.why`
 *  carries. Empty for a record that owes nothing or has discharged it.
 *
 *  COUPLED: the record shape eval/stage-record.ts writes — `owes`, one key per act once it
 *  lands, `qualify_owed` and `qualified.<measure>`. Read here rather than imported: the
 *  evaluation modules are reached from the evaluation side only (checks/eval-tools-moved.ts). */
export function owedActs(
  record: Readonly<Record<string, string>> | undefined, initiative: string,
  /** The document the stage produced, as it stands now. */
  produced: string,
): string[] {
  if (!record?.owes) return [];
  // Bound to a version the document no longer quotes: it was revised to a newer protocol version,
  // and that version is neither bound nor qualified, whatever this record says of the old one.
  const stale = !!record.affirmed_digest && !produced.includes(record.affirmed_digest);
  if (stale) {
    return [`protocol.md now quotes a protocol version this initiative has not bound — call ` +
      `protocol_affirm with that version (initiative: "${initiative}"), then evaluator_qualify for ` +
      "each model-backed measure it names, before EVALUATE scores"];
  }
  const owed = (record.qualify_owed ?? "").split(",").filter(Boolean)
    .filter((k) => !record[`qualified.${k}`]);
  // Not protocol_read's: on a revise it answers the version being replaced, and binding that one
  // would affirm the old protocol under the new document.
  const version = record.protocol_version_id ?? "<the protocol_version_id protocol_record returned, the version protocol.md quotes>";
  const why: Record<string, string> = {
    protocol_affirm: `protocol.md is approved but not bound to the protocol — call protocol_affirm("${version}", ` +
      `initiative: "${initiative}"). Nothing qualifies or scores against an unaffirmed version`,
    evaluator_qualify: `the affirmed protocol's model-backed evaluators are not all qualified — call ` +
      `evaluator_qualify("${version}", measure_key, initiative: "${initiative}") for ` +
      `${owed.length ? owed.join(", ") : "each model-backed measure"} before EVALUATE scores`,
  };
  return record.owes.split(",").filter((act) => act && !record[act]).map((act) => why[act] ?? `call ${act}`);
}

/** The platform's own closing step, told apart from the flow's own documents.
 *
 * `deriveChain` appends it with `role: "handover"`; a flow that declares its own is matched
 * by name. One branch below must skip it and another must find it, and both go through this
 * one test. */
export function isHandover(d: { name: string; role?: string }): boolean {
  return d.role === "handover" || d.name === "handover.md";
}
