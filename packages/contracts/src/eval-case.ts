/**
 * THE UNIT BEING MEASURED: one case, what a reviewer was allowed to see when labelling it,
 * and whether the case may be counted at all.
 *
 * WHAT A CASE IS FOR. Three arms are going to be compared on the same material. If the
 * material differs between arms — different cases, different evidence, different cutoffs —
 * the comparison measures the material and not the arms, and nothing in the resulting table
 * says so. So the inventory is pinned before anything runs, and each case carries the facts
 * that decide whether it can be used: the moment it is judged as of, what evidence existed by
 * then, what is deliberately withheld, and whether the world as it stood at that moment can
 * still be reconstructed.
 *
 * THE CUTOFF IS THE WHOLE POINT OF THE LABELLING RULE. A reviewer who can see how the case
 * turned out is not labelling the case, they are reading the answer — and their labels will
 * agree with the outcome beautifully while proving nothing about whether the judgement was
 * available at the time. {@link adjudicate} therefore VOIDS a label that cites evidence the
 * cutoff does not make visible, rather than discounting it: a label built partly on
 * unavailable evidence is not a weaker label, it is a different question answered.
 *
 * AND THE ADJUDICATOR IS HELD TO A STRICTER VERSION OF THE SAME RULE. Two reviewers who
 * disagree are resolved by a third — but a third who knows the outcome resolves every
 * disagreement in the outcome's favour and does it sincerely. There is no way to detect that
 * afterwards from the labels, so it is refused at the point of adjudication: an adjudicator
 * carrying later outcome information cannot resolve anything, and the disagreement stays
 * `disputed`. `disputed` is a real and useful state. It says the case was genuinely
 * ambiguous, which is information about the task; forcing it to a value would destroy that
 * and replace it with a coin flip wearing a reviewer's name.
 *
 * INELIGIBILITY IS NOT A SOFT WARNING. A case whose manifest was never pinned, or whose
 * historical context cannot be recovered, is excluded from the denominators — it is not
 * repaired by substituting today's manifest. Today's manifest is a different world: running a
 * case against it measures the method against conditions it never faced, and the result lands
 * in the same column as cases that were measured properly.
 *
 * SAMPLE ADEQUACY LIVES HERE TOO, because it is a question about the inventory rather than
 * about the arms. {@link sliceAdequacy} is the rule, and {@link SAMPLE_ADEQUACY_RULE_REF} is
 * the reference a protocol points at so that "there is a rule" is checkable rather than
 * asserted.
 */

/** A piece of evidence and when it became observable. Both halves are needed: a reference
 *  alone cannot be tested against a cutoff, and a cutoff cannot be enforced against evidence
 *  that does not say when it existed. */
export interface EvidenceRef {
  readonly ref: string;
  /** ISO-8601 date or timestamp. Compared lexically, which is correct for ISO-8601. */
  readonly observed_at: string;
}

/** The cut this protocol reports on.
 *
 *  This is `QualificationSlice` from `profiles.ts` — task, language, risk — plus `action`.
 *  The extra dimension is not decoration: a threshold qualified for classifying in English at
 *  low risk says nothing about whether the same judgement may AUTHORISE something, and an
 *  evaluation that reported across both would average a cheap decision with an expensive one.
 *  It is a deliberately finer cut than any corpus already judged here, which is a cost paid in
 *  denominators — see {@link sliceAdequacy}. */
export interface EvalSlice {
  readonly language: string;
  readonly risk: string;
  readonly action: string;
  readonly task_kind: string;
}

/** A stable key for a slice. Field order is fixed here so two callers building the same slice
 *  in a different field order still land in the same bucket. */
export function sliceKey(slice: EvalSlice): string {
  return [slice.language, slice.risk, slice.action, slice.task_kind].join("|");
}

/** Whether the world as it stood at the case's cutoff can still be reconstructed.
 *
 *  `only_todays_manifest` is named for what it actually is rather than for how it feels. It is
 *  not a degraded form of `recorded_at_cutoff`; it is the absence of the thing, with a
 *  plausible substitute standing where it should be. */
export type HistoricalContext = "recorded_at_cutoff" | "unavailable" | "only_todays_manifest";

/** One case in the pinned inventory. */
export interface EvalCase {
  readonly case_id: string;
  /** Which initiative this case came out of. The development/held-out split is declared as a
   *  list of initiative ids, and without this field that declaration attaches to nothing: once
   *  the inventory is enumerated, no case could be told held out from development. */
  readonly initiative_id: string;
  readonly slice: EvalSlice;
  /** The moment the case is judged as of. Evidence observed after it is not visible. */
  readonly cutoff: string;
  /** The manifest in force at the cutoff. `null` is a case nobody pinned one for. */
  readonly manifest_ref: string | null;
  readonly historical_context: HistoricalContext;
  readonly evidence: readonly EvidenceRef[];
  /** References deliberately kept from reviewers, by ref. Withheld is not the same as absent:
   *  the evidence exists and the labelling task is defined without it. */
  readonly withheld: readonly string[];
}

/** Whether a case may be counted, and why not when it may not. `reasons` is empty exactly
 *  when `eligible` is true, so a reader never has to consult both to learn one thing. */
export interface EligibilityVerdict {
  readonly eligible: boolean;
  readonly reasons: readonly string[];
}

/** Decides whether a case may enter a denominator. Nothing here repairs a case; a case that
 *  cannot be reconstructed is dropped, named, and counted in no arm's denominator. */
export function eligibilityOf(evalCase: EvalCase): EligibilityVerdict {
  const reasons: string[] = [];
  if (evalCase.manifest_ref === null) {
    reasons.push("no manifest was pinned for this case, and today's cannot stand in for one that was never recorded");
  }
  if (evalCase.historical_context === "unavailable") {
    reasons.push("the context in force at the cutoff cannot be reconstructed");
  }
  if (evalCase.historical_context === "only_todays_manifest") {
    reasons.push("only today's manifest survives, which describes a world this case never faced");
  }
  if (!evalCase.evidence.length) {
    reasons.push("the case carries no evidence references, so nothing can be labelled against it");
  }
  return Object.freeze({ eligible: reasons.length === 0, reasons: Object.freeze(reasons) });
}

/** What one reviewer decided, and what they consulted to decide it. `evidence_seen` is what
 *  makes the cutoff rule enforceable rather than promised. */
export interface ReviewerLabel {
  readonly reviewer_id: string;
  readonly value: string;
  readonly evidence_seen: readonly string[];
}

/** The third reviewer, and the one fact that disqualifies them.
 *
 *  `resolves_to` is declared up front rather than computed, because an adjudicator picks
 *  between the values on the table and picking a value nobody proposed is not adjudication. */
export interface Adjudicator {
  readonly adjudicator_id: string;
  readonly saw_later_outcome: boolean;
  readonly resolves_to: string;
}

/** How a case's label was settled. `void` is the case nobody could label legitimately;
 *  `disputed` is the case two people legitimately disagreed about. Collapsing the two would
 *  hide a procedural failure inside a finding about task difficulty. */
export type LabelStatus = "agreed" | "adjudicated" | "disputed" | "void";

/** The settled label, or the reason there is none. `value` is null for every status but
 *  `agreed` and `adjudicated`, so no reader has to know the difference to stay safe. */
export interface AdjudicatedLabel {
  readonly status: LabelStatus;
  readonly value: string | null;
  readonly reasons: readonly string[];
  /** Labels discarded for citing material the cutoff does not make visible, by reviewer. */
  readonly voided_reviewers: readonly string[];
}

/**
 * Settles one case's label from what the reviewers said.
 *
 * Order matters and is the argument of the whole function: visibility is enforced FIRST, so a
 * label that should never have counted cannot create agreement, cannot create a disagreement
 * for an adjudicator to resolve, and cannot become the resolved value.
 */
export function adjudicate(
  evalCase: EvalCase,
  labels: readonly ReviewerLabel[],
  adjudicator: Adjudicator | null,
): AdjudicatedLabel {
  const withheld = new Set(evalCase.withheld);
  const visible = new Set(
    evalCase.evidence
      .filter((e) => e.observed_at <= evalCase.cutoff && !withheld.has(e.ref))
      .map((e) => e.ref));

  const voided_reviewers: string[] = [];
  const reasons: string[] = [];
  const valid: ReviewerLabel[] = [];
  for (const label of labels) {
    const unseeable = label.evidence_seen.filter((ref) => !visible.has(ref));
    if (unseeable.length) {
      voided_reviewers.push(label.reviewer_id);
      reasons.push(`${label.reviewer_id} cited material the cutoff does not make visible: ${unseeable.join(", ")}`);
      continue;
    }
    valid.push(label);
  }

  if (!valid.length) {
    reasons.push("no label survived the cutoff rule, so this case has no adjudicated value");
    return frozenLabel("void", null, reasons, voided_reviewers);
  }

  const values = [...new Set(valid.map((l) => l.value))];
  if (values.length === 1) return frozenLabel("agreed", values[0], reasons, voided_reviewers);

  // A DISAGREEMENT, AND THREE WAYS IT STAYS ONE. No adjudicator; an adjudicator who knows how
  // the case turned out; an adjudicator choosing a value no reviewer proposed. Each leaves the
  // case `disputed` — which is a finding about the case, not a failure to produce one.
  if (!adjudicator) {
    reasons.push(`reviewers disagreed (${values.join(" vs ")}) and no adjudicator was appointed`);
    return frozenLabel("disputed", null, reasons, voided_reviewers);
  }
  if (adjudicator.saw_later_outcome) {
    reasons.push(
      `${adjudicator.adjudicator_id} held information about how the case turned out, which is ` +
      "not available at the cutoff, so the disagreement stands unresolved");
    return frozenLabel("disputed", null, reasons, voided_reviewers);
  }
  if (!values.includes(adjudicator.resolves_to)) {
    reasons.push(
      `${adjudicator.adjudicator_id} resolved to "${adjudicator.resolves_to}", which no ` +
      "surviving reviewer proposed, so the disagreement stands unresolved");
    return frozenLabel("disputed", null, reasons, voided_reviewers);
  }
  reasons.push(`${adjudicator.adjudicator_id} resolved a disagreement between ${values.join(" and ")}`);
  return frozenLabel("adjudicated", adjudicator.resolves_to, reasons, voided_reviewers);
}

function frozenLabel(
  status: LabelStatus,
  value: string | null,
  reasons: readonly string[],
  voided: readonly string[],
): AdjudicatedLabel {
  return Object.freeze({
    status, value, reasons: Object.freeze([...reasons]), voided_reviewers: Object.freeze([...voided]),
  });
}

/** Whether a slice holds enough eligible cases to say anything against a tolerance.
 *
 *  `undecidable` covers both halves of "the question cannot be asked yet": an inventory that
 *  has not been enumerated, and a tolerance nobody has set. */
export type Adequacy = "adequate" | "underpowered" | "empty" | "undecidable";

/** The reference a protocol carries so that "a sample-adequacy rule exists" is checkable
 *  against something rather than asserted in prose. It names the function below, in this file,
 *  which is the rule — there is no second copy of it anywhere. */
export const SAMPLE_ADEQUACY_RULE_REF = "packages/contracts/src/eval-case.ts#sliceAdequacy";

/**
 * THE RULE, AND WHERE IT COMES FROM.
 *
 * The judged corpus this platform already holds — `testing/tenant-info/` — carries 600 judged
 * queries with exactly one judgment each. Because each eligible query has exactly one relevant
 * artifact, the per-case outcome is BINARY: a slice of n cases can only ever report a rate
 * from the ladder 0/n, 1/n … n/n. Its held-out answerable slices are en 58, zh 20 and mixed
 * 20, and the consequence was observed there rather than argued here: at n = 20 a single miss
 * lands on 0.95 exactly and a second one fails it. A slice in which one case decides the
 * verdict is not a measurement of a method, it is a measurement of that case.
 *
 * So: a slice supports a tolerance t only when it can absorb two failures and still clear it,
 * `(n - 2) / n >= t`, which is `n >= 2 / (1 - t)`. At t = 0.95 that is n >= 40 — en clears it,
 * zh and mixed do not, which is the same verdict a reader of those three numbers would reach
 * unaided. That agreement is the reason to trust the rule, not a coincidence to note.
 *
 * THIS PROTOCOL'S CUT IS FINER THAN THAT ONE. Those slices are language alone; a slice here is
 * language x risk x action x task_kind, and every additional dimension divides the same cases
 * further. A four-way cut over an inventory of that size has cells in the single digits, and
 * this rule will call most of them underpowered. That is the rule working.
 */
export function sliceAdequacy(
  eligible: number | null,
  tolerance: number | null,
): { readonly adequacy: Adequacy; readonly minimum: number | null; readonly reason: string } {
  if (eligible === null) {
    return frozenAdequacy("undecidable", null, "the inventory has not been enumerated, so this slice has no denominator yet");
  }
  if (eligible === 0) {
    return frozenAdequacy("empty", null, "no eligible case falls in this slice");
  }
  if (tolerance === null) {
    return frozenAdequacy("undecidable", null, "no tolerance is set for this metric, so no sample size can be called adequate for it");
  }
  if (tolerance >= 1 || tolerance < 0) {
    return frozenAdequacy("undecidable", null, `a tolerance of ${tolerance} is not a proportion this rule can size a sample against`);
  }
  const minimum = Math.ceil(2 / (1 - tolerance));
  return eligible >= minimum
    ? frozenAdequacy("adequate", minimum, `${eligible} eligible cases absorb two failures and still clear ${tolerance}`)
    : frozenAdequacy("underpowered", minimum,
      `${eligible} eligible cases cannot absorb two failures at ${tolerance}; ${minimum} would be needed, ` +
      "and below it one case decides the verdict");
}

function frozenAdequacy(
  adequacy: Adequacy,
  minimum: number | null,
  reason: string,
): { readonly adequacy: Adequacy; readonly minimum: number | null; readonly reason: string } {
  return Object.freeze({ adequacy, minimum, reason });
}
