/**
 * `evaluation_assess`'s own per-measure execution, and `evaluation_score`'s own reduction of the
 * rows it wrote into `scoreRun`'s input shape (Task I-13, AC-8.1, AC-9.1).
 *
 * One measure, one evaluator type, one answer:
 *   - `deterministic` / `outcome` read a NAMED fact straight off `zz.eval_observation_snapshot`'s
 *     own stored columns — the same two facts `qualify-evidence.ts`'s `FACT_STATEMENTS` already
 *     reads (`usable_run_coverage`, `tool_coverage`), because OBSERVE (Task I-7) is DELIBERATE
 *     about storing only those counts and the digest over the rest, never the full facts object.
 *     `outcome` has no replay/case data source yet (a later task); until one exists it reads the
 *     same two stored facts, exactly as `qualify-evidence.ts`'s own header note says of `labels`.
 *   - `bounded_semantic` / `generative_critic` ask the measure's bound `evaluator_version_id`
 *     through `askEvaluator`, and derive a `[0,1]` value from the answer — see `valueFromAnswer`.
 *   - `human` has no label-ingestion pipeline yet; its measures are recorded as `null`, excluded
 *     the same way an unqualified evaluator's answer is.
 *
 * `definition` is a protocol measure's freeform jsonb (spec v8 fixes no shape for it — this
 * task's own plan boundary, "final deliverable content is not in this plan", is what leaves the
 * shape below to this file rather than to the contract): `{ factKey?, qualification?: {positive,
 * zero}, guardrail?: boolean, guardrailThreshold?: number }`. `qualification` is the SAME
 * `{positive, zero}` vocabulary `qualify.ts` already reads off a measure for anchor-building —
 * reused here, never redefined, so a protocol author writes one vocabulary and both EVALUATE and
 * QUALIFY read it.
 */
import { askEvaluator, type EvaluatorAssessmentResult } from "./evaluators.js";

export interface SnapshotFacts {
  readonly usable_run_count: number;
  readonly total_run_count: number;
  readonly coverage: { surface?: { observed?: number; total?: number } } | null;
}

export interface MeasureRow {
  readonly id: string;
  readonly key: string;
  readonly evaluator_type: "deterministic" | "outcome" | "bounded_semantic" | "generative_critic" | "human";
  readonly weight: number;
  readonly required: boolean;
  readonly definition: Record<string, unknown>;
  readonly evaluator_version_id: string | null;
}

export interface DimensionRow {
  readonly id: string;
  readonly key: string;
  readonly canonical_kind: string;
  readonly weight: number;
  readonly required: boolean;
  readonly applicable: boolean;
  readonly not_applicable_reason: string | null;
  readonly measures: MeasureRow[];
}

/** One measure's answer, in the shape `zz.eval_assessment.answer` stores it and
 *  `evaluation_score` reduces it back from. `value` is `null` for "no comparable answer" (human,
 *  an unqualified evaluator, a fact with a zero denominator) — never a bare 0, the same rule
 *  `score.ts`'s own header states for a dimension. */
export interface MeasureAnswer {
  readonly value: number | null;
  readonly excluded: boolean;
  readonly excluded_reason: string | null;
  readonly evaluator_version_id: string | null;
  readonly assessment_id: number | null;
  readonly qualification_id: string | null;
  readonly qualification_state: string | null;
  readonly detail: Record<string, unknown>;
}

const FACT_KEYS = ["usable_run_coverage", "tool_coverage"] as const;

function factValue(factKey: unknown, snapshot: SnapshotFacts): { n: number; d: number } | null {
  if (factKey === "usable_run_coverage") {
    const d = snapshot.total_run_count;
    return d > 0 ? { n: snapshot.usable_run_count, d } : null;
  }
  if (factKey === "tool_coverage") {
    const d = snapshot.coverage?.surface?.total ?? 0;
    const n = snapshot.coverage?.surface?.observed ?? 0;
    return d > 0 ? { n, d } : null;
  }
  return null;
}

/** deterministic / outcome: a named fact, read off the snapshot's own stored columns — no model,
 *  no subject_ref (the same value for every subject_ref this run assesses, until a replay/case
 *  data source exists to vary it by). */
function deterministicAnswer(measure: MeasureRow, snapshot: SnapshotFacts): MeasureAnswer {
  const factKey = measure.definition.factKey;
  const fact = factValue(factKey, snapshot);
  const known = FACT_KEYS.includes(factKey as (typeof FACT_KEYS)[number]);
  return {
    value: fact ? fact.n / fact.d : null,
    excluded: fact === null,
    excluded_reason: fact
      ? null
      : known ? `fact "${String(factKey)}" has a zero denominator in this run's observation snapshot`
              : `measure "${measure.key}" names no known factKey (one of ${FACT_KEYS.join(", ")})`,
    evaluator_version_id: null, assessment_id: null, qualification_id: null, qualification_state: null,
    detail: { fact_key: factKey ?? null, numerator: fact?.n ?? null, denominator: fact?.d ?? null },
  };
}

/** What one asked answer reduces to in `[0, 1]`. A `noul`'s own probability IS already the
 *  probability of `yes` (`semantic.ts`'s `readingOf` only thresholds it into a reading; the
 *  number itself is never rescaled), so it is the value directly. A `choice`/`score`'s
 *  distribution is read against the measure's own `{positive, zero}` vocabulary when the
 *  protocol names one — the probability mass on `positive` IS the value, the same number
 *  `qualify-evidence.ts`'s stability/anchor comparisons already treat as "the" answer. With no
 *  named vocabulary, the distribution's keys are read as an ordered scale (first = worst, last =
 *  best) and reduced to a probability-weighted position — a reasonable default for an
 *  unconfigured `score`/`choice` measure, not a fixed contract (this task's own plan boundary). */
function valueFromAnswer(r: EvaluatorAssessmentResult, definition: Record<string, unknown>): number | null {
  if (r.answer_kind === "noul") {
    return r.reading === "unavailable" || r.reading === "unclear" || r.probability === null
      ? null : r.probability;
  }
  if (!r.distribution) return null;
  const vocab = definition.qualification as { positive?: string; zero?: string } | undefined;
  if (vocab?.positive && r.distribution[vocab.positive] !== undefined) return r.distribution[vocab.positive];
  const keys = Object.keys(r.distribution);
  if (!keys.length) return null;
  const span = Math.max(keys.length - 1, 1);
  return keys.reduce((sum, k, i) => sum + (r.distribution?.[k] ?? 0) * (i / span), 0);
}

/** bounded_semantic / generative_critic: ask the bound evaluator, exclude the value (never the
 *  assessment row — the answer is still recorded) when the evaluator's qualification for THIS
 *  protocol version is missing or `unqualified` — the contract's own Errors clause: "an
 *  unqualified evaluator's measure is recorded but excluded, making the dimension missing". */
async function modelBackedAnswer(
  measure: MeasureRow, subjectText: string, context: string | undefined, principal: string,
  qualificationOf: (evaluatorVersionId: string) => Promise<{ id: string; state: string } | null>,
): Promise<MeasureAnswer> {
  if (!measure.evaluator_version_id) {
    return {
      value: null, excluded: true, excluded_reason: `measure "${measure.key}" names no evaluator`,
      evaluator_version_id: null, assessment_id: null, qualification_id: null, qualification_state: null,
      detail: {},
    };
  }
  const result = await askEvaluator(measure.evaluator_version_id, subjectText, context, principal);
  const qual = await qualificationOf(measure.evaluator_version_id);
  const unqualified = !qual || qual.state === "unqualified";
  const raw = valueFromAnswer(result, measure.definition);
  return {
    value: unqualified ? null : raw,
    excluded: unqualified || raw === null,
    excluded_reason: unqualified
      ? `evaluator is ${qual ? "unqualified" : "never qualified"} against this protocol version`
      : raw === null ? "the evaluator returned no comparable answer" : null,
    evaluator_version_id: measure.evaluator_version_id, assessment_id: result.assessment_id,
    qualification_id: qual?.id ?? null, qualification_state: qual?.state ?? null,
    detail: { answer_kind: result.answer_kind, reading: result.reading, probability: result.probability,
              distribution: result.distribution, raw_value: raw },
  };
}

/** One measure, one subject_ref, one answer — dispatched by `evaluator_type`. `human` measures
 *  have no ingestion pipeline yet (this task's own plan boundary): recorded as excluded, never
 *  asked, never guessed at. */
export async function answerMeasure(opts: {
  measure: MeasureRow; snapshot: SnapshotFacts; subjectRef: string; principal: string;
  qualificationOf: (evaluatorVersionId: string) => Promise<{ id: string; state: string } | null>;
}): Promise<MeasureAnswer> {
  const { measure, snapshot, subjectRef, principal, qualificationOf } = opts;
  if (measure.evaluator_type === "deterministic" || measure.evaluator_type === "outcome") {
    return deterministicAnswer(measure, snapshot);
  }
  if (measure.evaluator_type === "human") {
    return {
      value: null, excluded: true, excluded_reason: "no human-label ingestion pipeline exists yet",
      evaluator_version_id: null, assessment_id: null, qualification_id: null, qualification_state: null,
      detail: {},
    };
  }
  const subjectText = `Measure "${measure.key}" against subject_ref "${subjectRef}".`;
  return modelBackedAnswer(measure, subjectText, undefined, principal, qualificationOf);
}

/** `evaluation_score`'s reduction of every stored `zz.eval_assessment.answer` for one measure,
 *  across whatever `subject_ref`s were assessed, into the single weighted value `scoreRun` reads.
 *  The plain mean of the non-excluded values — `excluded` rows (an unqualified evaluator, a
 *  human measure, a zero-denominator fact) are dropped, never averaged in as 0 (`score.ts`'s own
 *  rule, applied one level down). `null` when every row was excluded or none exist. */
export function reduceMeasureAnswers(answers: readonly MeasureAnswer[]): number | null {
  const usable = answers.filter((a): a is MeasureAnswer & { value: number } => !a.excluded && a.value !== null);
  if (!usable.length) return null;
  return usable.reduce((s, a) => s + a.value, 0) / usable.length;
}
