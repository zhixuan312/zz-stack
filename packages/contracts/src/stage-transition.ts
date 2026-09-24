/**
 * A transition is a recorded fact or it is not a fact.
 *
 * A linked source shows that a version changed and cited an input. An approval time shows that
 * one approval was recorded before another. Neither shows which stage the work came back from,
 * and no combination of them does: the same pair of facts is produced by a straight run with a
 * late correction as by a genuine return upstream.
 *
 * So the two answers are two fields, and the guarantee is in the plumbing.
 * {@link observedTransitions} takes recorded events and nothing else, so no amount of links or
 * approvals can produce an observed transition. {@link inferredRelations} takes links and
 * approvals and nothing else, and its relations are stamped inferred at construction and carry
 * what they cannot establish written on them.
 *
 * The inference is kept rather than discarded: a run whose versions keep citing new inputs is
 * worth asking about. The defect would be filing it under the same name as a fact.
 */

/** Whether a row is something that happened or something somebody worked out. One union across
 *  both row shapes, so a consumer can ask any row what it is without first knowing which list it
 *  came out of. */
export type TransitionRelationKind = "observed" | "inferred";

/** An event as a recorder wrote it. `from` and `to` are opaque caller data: this module has no
 *  vocabulary of stages. What it guarantees is that nothing else gets to write here at all. */
export interface TransitionEvent {
  readonly kind: string;
  readonly from?: string;
  readonly to?: string;
  readonly run?: string;
  readonly at?: string;
}

/** A transition that was recorded as having happened, with the run that recorded it. */
export interface ObservedTransition {
  readonly kind: TransitionRelationKind;
  readonly from: string;
  readonly to: string;
  readonly run: string;
  readonly at: string | null;
}

/** Something the material suggests, with the basis it rests on and the question it cannot
 *  answer. `cannot_establish` is on every row rather than in documentation, because these rows
 *  travel and a reader three layers away needs the limit attached. */
export interface InferredRelation {
  readonly kind: TransitionRelationKind;
  readonly relation: "revision_cited_input" | "approvals_ordered";
  readonly basis: readonly string[];
  readonly cannot_establish: string;
}

/** An event that named itself a transition and was not one — kept so that a malformed
 *  recorder is visible as a malformed recorder rather than as a quiet zero. */
export interface RejectedEvent {
  readonly kind: string;
  readonly reason: string;
}

export interface TransitionRecord {
  readonly observed: readonly ObservedTransition[];
  readonly inferred: readonly InferredRelation[];
  readonly rejected: readonly RejectedEvent[];
}

/** The material a caller has. Every field is optional because callers really do have only one
 *  of them, and a caller holding links and approvals must be able to ask this question and get
 *  the honest empty answer rather than be unable to ask it. */
export interface TransitionInput {
  readonly events?: readonly TransitionEvent[];
  readonly linked_sources?: readonly string[];
  readonly approvals?: readonly { readonly at: string }[];
}

const STAGE_TRANSITION = "stage_transition";

const CANNOT_ESTABLISH =
  "that a version changed and cited an input, and that one approval was recorded before " +
  "another — not which stage the work returned from";

/**
 * Transitions from recorded events and from nothing else. There is no argument carrying links or
 * approvals, so the function cannot consult them however it is edited later.
 *
 * An event claiming to be a transition without naming where it went from, where it went to and
 * which run recorded it is rejected by name rather than dropped: "nothing happened" and
 * "somebody recorded something unusable" are different answers.
 */
function observedTransitions(
  events: readonly TransitionEvent[],
): { readonly rows: ObservedTransition[]; readonly rejected: RejectedEvent[] } {
  const rows: ObservedTransition[] = [];
  const rejected: RejectedEvent[] = [];
  for (const e of events) {
    if (e.kind !== STAGE_TRANSITION) continue;
    const missing = (["from", "to", "run"] as const).filter((k) => {
      const v = e[k];
      return typeof v !== "string" || v === "";
    });
    if (missing.length) {
      rejected.push({
        kind: e.kind,
        reason: `recorded as a transition without ${missing.join(", ")}, which is a fragment ` +
          "rather than a transition and is not completed from anything else here",
      });
      continue;
    }
    rows.push(Object.freeze({
      kind: "observed" as TransitionRelationKind,
      from: e.from as string,
      to: e.to as string,
      run: e.run as string,
      at: e.at ?? null,
    }));
  }
  return { rows, rejected };
}

/**
 * What the document activity suggests, stamped as a suggestion. Same construction, opposite
 * direction: no events parameter, so nothing recorded can leak into a relation and later be read
 * as observed. Each relation names its basis — the actual source ids, the actual approval times.
 */
function inferredRelations(
  linkedSources: readonly string[],
  approvals: readonly { readonly at: string }[],
): InferredRelation[] {
  const rows: InferredRelation[] = [];
  if (linkedSources.length > 0) {
    rows.push(Object.freeze({
      kind: "inferred" as TransitionRelationKind,
      relation: "revision_cited_input" as const,
      basis: Object.freeze([...linkedSources]),
      cannot_establish: CANNOT_ESTABLISH,
    }));
  }
  if (approvals.length > 1) {
    rows.push(Object.freeze({
      kind: "inferred" as TransitionRelationKind,
      relation: "approvals_ordered" as const,
      basis: Object.freeze(approvals.map((a) => a.at)),
      cannot_establish: CANNOT_ESTABLISH,
    }));
  }
  return rows;
}

/**
 * Both answers, never mixed. This function hands each half its own material and puts the two
 * results in two fields, so there is nowhere to write a body that promotes an inference when
 * there were no events, or suppresses one when there were.
 */
export function transitionsFor(input: TransitionInput): TransitionRecord {
  const { rows, rejected } = observedTransitions(input.events ?? []);
  return Object.freeze({
    observed: Object.freeze(rows),
    inferred: Object.freeze(inferredRelations(input.linked_sources ?? [], input.approvals ?? [])),
    rejected: Object.freeze(rejected),
  });
}
