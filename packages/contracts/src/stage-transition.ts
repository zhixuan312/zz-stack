/**
 * A TRANSITION IS A RECORDED FACT OR IT IS NOT A FACT.
 *
 * Somebody wants to know how often work went backwards. The material to hand is a list of
 * documents with the inputs each version cited, and a list of approvals with times on them. It
 * is very easy to turn that into a number: this version cited that source, this approval came
 * after that one, therefore the work returned from one place to another. The number looks like
 * a measurement and it is an arrangement of two other measurements.
 *
 * WHAT THOSE TWO THINGS ACTUALLY SHOW. A linked source shows that a version changed and cited
 * an input. An approval time shows that one approval was recorded before another. Neither
 * shows which stage the work came back FROM, and no combination of them does: a document can
 * cite an input nobody sent it back over, two approvals can be ordered by nothing more than
 * who was awake, and the same pair of facts is produced by a straight run through with a late
 * correction as by a genuine return upstream. CHRONOLOGY IS NOT CAUSALITY, and a citation is
 * not a route.
 *
 * SO THE TWO ANSWERS ARE TWO FIELDS, and the guarantee is in the plumbing rather than in this
 * paragraph. {@link observedTransitions} takes recorded events and nothing else — links and
 * approvals are not parameters of it, so no amount of either can produce an observed
 * transition. {@link inferredRelations} takes links and approvals and nothing else, and the
 * relations it builds are stamped inferred at construction and carry what they cannot
 * establish written on them.
 *
 * AND THE INFERENCE IS KEPT, which is the half that is easy to lose in the course of being
 * careful. Throwing the relation away because it is not proof discards a real signal somebody
 * looked for: a run whose versions keep citing new inputs is a run worth asking about. The
 * defect is not noticing it. The defect is filing it under the same name as a fact.
 */

/** Whether a row is something that happened or something somebody worked out. One union
 *  across both row shapes, so a consumer can ask any row what it is without first knowing
 *  which list it came out of — the question "is this observed?" has to be askable, or the
 *  distinction is only a matter of which array somebody looked in. */
export type TransitionRelationKind = "observed" | "inferred";

/** An event as a recorder wrote it. `from` and `to` are OPAQUE CALLER DATA: this module has no
 *  vocabulary of stages, cannot check one against a list it does not have, and would be the
 *  wrong place for that list even if it had it. A recorder that writes nonsense here writes
 *  nonsense; what this module guarantees is that nothing else gets to write here at all. */
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
 *  answer. `cannot_establish` is on every row rather than in documentation because these rows
 *  travel: a reader who meets one three layers away needs its limit attached to it. */
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
 * TRANSITIONS FROM RECORDED EVENTS, AND FROM NOTHING ELSE.
 *
 * The parameter list is the guarantee. There is no argument here carrying links or approvals,
 * so the function cannot consult them however it is edited later — an edit that wanted to
 * would have to widen the signature, which is a visible change to a reviewer rather than an
 * extra clause inside a body.
 *
 * An event that claims to be a transition without naming where it went from, where it went to
 * and which run recorded it is not a recorded transition; it is a fragment. It is rejected by
 * name rather than dropped, because the difference between "nothing happened" and "somebody
 * recorded something unusable" is the difference between a clean run and a broken recorder.
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
 * WHAT THE DOCUMENT ACTIVITY SUGGESTS, STAMPED AS A SUGGESTION.
 *
 * Same construction, opposite direction: no events parameter, so nothing recorded can leak
 * into a relation and be read later as having been observed. Each relation names its basis —
 * the actual source ids, the actual approval times — so a reader can go and look at the same
 * material rather than take the relation's word for it.
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
 * BOTH ANSWERS, NEVER MIXED.
 *
 * This function does no work of its own beyond handing each half its own material and putting
 * the two results in two fields. That is deliberate: a body that combined them — promoting an
 * inference when there were no events, say, or suppressing an inference when there were — is
 * exactly the code path the contract forbids, and the way to not have it is to not have
 * anywhere to write it.
 */
export function transitionsFor(input: TransitionInput): TransitionRecord {
  const { rows, rejected } = observedTransitions(input.events ?? []);
  return Object.freeze({
    observed: Object.freeze(rows),
    inferred: Object.freeze(inferredRelations(input.linked_sources ?? [], input.approvals ?? [])),
    rejected: Object.freeze(rejected),
  });
}
