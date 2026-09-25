/**
 * `evaluation_assess`'s own per-measure execution, and `evaluation_score`'s own reduction of the
 * rows it wrote into `scoreRun`'s input shape (Task I-13, AC-8.1, AC-9.1).
 *
 * FIXED (fix dispatch on initiative 2026-09-24-plugin-eval-next-version, task I-29's own two
 * follow-on seams): `deterministic`/`outcome` used to read only two hard-coded facts off
 * `zz.eval_observation_snapshot`'s own raw columns, because OBSERVE (Task I-7) stored only their
 * digest and never the ~18 facts it actually computes. Migration 002 gives the snapshot a `facts`
 * column carrying the whole map (observe-facts.ts's `OBSERVATION_FACT_KEYS`), so a measure now
 * names ANY of them by a dotted `definition.factPath`, normalised to `[0,1]` by a rule the measure
 * itself declares — see `deterministicAnswer`/`normalizeFactValue` below. `outcome` reads the same
 * way; it still has no replay/case data source of its own (a later task), so it is scored
 * identically to `deterministic` until one exists.
 *
 * One measure, one evaluator type, one answer:
 *   - `deterministic` / `outcome` read a NAMED fact off the run's bound observation snapshot, by
 *     dotted path. A missing fact, an unresolved path, or a value the declared normalisation rule
 *     cannot make sense of is excluded with a named reason — never a bare 0.
 *   - `bounded_semantic` / `generative_critic` ask the measure's bound `evaluator_version_id`
 *     through `askEvaluatorQuestion` (`semantic.ts`), and derive a `[0,1]` value from the answer —
 *     see `valueFromAnswer`. The answer comes back UNRECORDED (`AnsweredMeasure.pending`): the
 *     caller asks every measure before it opens its idempotency transaction and records each one
 *     with `recordMeasureAnswer` inside it, so a model call never holds a pool connection open and
 *     a rolled-back ledger write takes its `zz.assessment` rows with it.
 *   - `human` has no label-ingestion pipeline yet; its measures are recorded as `null`, excluded
 *     the same way an unqualified evaluator's answer is.
 *
 * `definition` is a protocol measure's freeform jsonb (spec v8 fixes no shape for it — this
 * task's own plan boundary, "final deliverable content is not in this plan", is what leaves the
 * shape below to this file rather than to the contract): for `deterministic`/`outcome`,
 * `{ factPath: string, normalize?: "rate" | "inverted_rate" | "threshold", max?: number, min?:
 * number }` — `normalize` defaults to `"rate"` when omitted, so the two original facts
 * (`usable_run_coverage`, `tool_coverage`, already rates in `[0,1]`) need not declare one.
 * `qualification?: {positive, zero}` is the SAME vocabulary `qualify.ts` already reads off a
 * measure for anchor-building — reused here, never redefined, so a protocol author writes one
 * vocabulary and both EVALUATE and QUALIFY read it. `improvement.criticalGuardrails` (protocol-
 * level, `@zz/contracts`'s `Guardrail`) is now the ONLY guardrail mechanism — see
 * `evaluateGuardrails` below; a measure's own `definition` no longer carries `guardrail`/
 * `guardrailThreshold`.
 */
import type pg from "pg";

import {
  askEvaluatorQuestion, insertEvaluatorAnswer, type AskedEvaluatorAnswer, type EvaluatorAssessmentResult,
} from "../semantic.js";

export interface SnapshotFacts {
  readonly usable_run_count: number;
  readonly total_run_count: number;
  readonly coverage: { surface?: { observed?: number; total?: number } } | null;
  /** The full map migration 002 stores — `null` for a snapshot that carries none,
   *  which excludes every deterministic/outcome measure with a named
   *  reason rather than guessing at a value. Loosely typed (`unknown` per entry): this file
   *  narrows each entry it actually reads through `asFactLike`, rather than importing
   *  observe-facts.ts's `ObservedFact` union and coupling to its exact shape. */
  readonly facts: Record<string, unknown> | null;
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

/** Walks a dot-separated path over a plain object — the same "reach a figure on the sheet" idea
 *  the removed legacy ruler applied, rewritten here against OBSERVE's own facts map rather than
 *  the whole legacy profile sheet. `undefined` the moment the
 *  path runs off the object (a non-object node, or a missing key) — never a thrown error, since a
 *  bad path is this function's caller's business to report, not this function's to crash over. */
function getByPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (at, segment) => (at !== null && typeof at === "object" ? (at as Record<string, unknown>)[segment] : undefined),
    obj,
  );
}

/** One `ObservedFact`/`MissingFact` (observe-facts.ts), narrowed just enough to read here without
 *  importing that file's own union type — `value` is the one field every shape shares, and
 *  `numerator`/`denominator`/`coverage`/`reason` are read only when present. Not an `ObservedFact`
 *  itself: a `factPath` may resolve to something else entirely (a stray object with no `value`),
 *  and `null` is this function's honest answer for "not fact-shaped", distinct from a resolved
 *  fact whose own `value` happens to be `null`. */
interface FactLike {
  readonly value: number | null;
  readonly numerator?: number;
  readonly denominator?: number;
  readonly coverage?: unknown;
  readonly reason?: string;
}
function asFactLike(node: unknown): FactLike | null {
  if (!node || typeof node !== "object" || !("value" in node)) return null;
  const v = (node as Record<string, unknown>).value;
  if (v !== null && typeof v !== "number") return null;
  return node as FactLike;
}

/** deterministic/outcome measures declare one of these three (Task I-29's own fix dispatch,
 *  replacing the single implicit "read this fact as a rate" rule the two original facts got away
 *  with). `rate`/`inverted_rate` both need the raw fact value to already BE a rate in `[0,1]` —
 *  `usable_run_coverage`/`tool_coverage`/`tool_refusal_rate` and friends qualify; `latency_p50_ms`
 *  or `tokens_per_model_call_avg` do not, and normalising one of those as a rate is refused rather
 *  than silently producing a number `scoreRun`'s own `[0,1]` guard would otherwise throw on later.
 *  `threshold` is for exactly that shape: a measured quantity compared against a declared `max`
 *  and/or `min`, reduced to a pass/fail `1`/`0`. */
type NormalizeRule = "rate" | "inverted_rate" | "threshold";

interface NormalizeOutcome { readonly value: number | null; readonly reason: string | null }

function normalizeFactValue(raw: number, definition: Record<string, unknown>, factPath: string): NormalizeOutcome {
  const rule = (typeof definition.normalize === "string" ? definition.normalize : "rate") as NormalizeRule | string;
  if (rule === "rate" || rule === "inverted_rate") {
    if (raw < 0 || raw > 1) {
      return {
        value: null,
        reason: `fact "${factPath}"'s value ${raw} is not a rate in [0,1] — normalize:"${rule}" ` +
          "needs a rate-shaped fact (use normalize:\"threshold\" for a measured quantity instead)",
      };
    }
    return { value: rule === "inverted_rate" ? 1 - raw : raw, reason: null };
  }
  if (rule === "threshold") {
    const max = definition.max;
    const min = definition.min;
    if (typeof max !== "number" && typeof min !== "number") {
      return { value: null, reason: `measure declares normalize:"threshold" but names no max or min` };
    }
    const passesMax = typeof max !== "number" || raw <= max;
    const passesMin = typeof min !== "number" || raw >= min;
    return { value: passesMax && passesMin ? 1 : 0, reason: null };
  }
  return {
    value: null,
    reason: `measure declares unknown normalize rule "${rule}" (one of rate, inverted_rate, threshold)`,
  };
}

function excludedAnswer(reason: string): MeasureAnswer {
  return {
    value: null, excluded: true, excluded_reason: reason,
    evaluator_version_id: null, assessment_id: null, qualification_id: null, qualification_state: null,
    detail: {},
  };
}

/** deterministic / outcome: a named fact, read off the run's bound observation snapshot by a
 *  dotted `definition.factPath` — no model, no subject_ref (the same value for every subject_ref
 *  this run assesses, until a replay/case data source exists to vary it by). `protocol_record`
 *  (protocol-record.ts's own `factPathRefusal`) already refused a `factPath` naming no fact OBSERVE
 *  computes at all, at record time — so a resolution failure here means THIS snapshot in
 *  particular carries none (a snapshot with `facts: null`, or a path drift this file's own
 *  header note asks `checks/eval-fact-path.ts` to catch), not a malformed protocol. */
function deterministicAnswer(measure: MeasureRow, snapshot: SnapshotFacts): MeasureAnswer {
  const factPath = measure.definition.factPath;
  if (typeof factPath !== "string" || !factPath.trim()) {
    return excludedAnswer(`measure "${measure.key}" declares no definition.factPath`);
  }
  if (!snapshot.facts) {
    return excludedAnswer(
      `measure "${measure.key}"'s factPath "${factPath}" cannot be read — this run's observation ` +
      "snapshot carries no facts (a context with no observation snapshot at all, such as a " +
      "replay/verify run)");
  }
  const fact = asFactLike(getByPath(snapshot.facts, factPath));
  if (!fact) {
    return excludedAnswer(
      `measure "${measure.key}"'s factPath "${factPath}" names no fact this observation snapshot carries`);
  }
  if (fact.value === null) {
    return excludedAnswer(`fact "${factPath}" is missing in this run's observation snapshot: ${fact.reason ?? "no reason recorded"}`);
  }
  const { value, reason } = normalizeFactValue(fact.value, measure.definition, factPath);
  return {
    value, excluded: value === null, excluded_reason: reason,
    evaluator_version_id: null, assessment_id: null, qualification_id: null, qualification_state: null,
    detail: {
      fact_path: factPath, normalize: (measure.definition.normalize as string | undefined) ?? "rate",
      raw_value: fact.value, numerator: fact.numerator ?? null, denominator: fact.denominator ?? null,
      coverage: fact.coverage ?? null,
    },
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
function valueFromAnswer(r: Omit<EvaluatorAssessmentResult, "assessment_id">, definition: Record<string, unknown>): number | null {
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
): Promise<AnsweredMeasure> {
  if (!measure.evaluator_version_id) {
    return {
      value: null, excluded: true, excluded_reason: `measure "${measure.key}" names no evaluator`,
      evaluator_version_id: null, assessment_id: null, qualification_id: null, qualification_state: null,
      detail: {}, pending: null,
    };
  }
  const asked = await askEvaluatorQuestion({
    evaluator_version_id: measure.evaluator_version_id, subject_text: subjectText, context, askedBy: principal,
  });
  const result = asked.result;
  const qual = await qualificationOf(measure.evaluator_version_id);
  const unqualified = !qual || qual.state === "unqualified";
  const raw = valueFromAnswer(result, measure.definition);
  return {
    value: unqualified ? null : raw,
    excluded: unqualified || raw === null,
    excluded_reason: unqualified
      ? `evaluator is ${qual ? "unqualified" : "never qualified"} against this protocol version`
      : raw === null ? "the evaluator returned no comparable answer" : null,
    evaluator_version_id: measure.evaluator_version_id, assessment_id: null,
    qualification_id: qual?.id ?? null, qualification_state: qual?.state ?? null,
    detail: { answer_kind: result.answer_kind, reading: result.reading, probability: result.probability,
              distribution: result.distribution, raw_value: raw },
    pending: asked,
  };
}

/** A measure's answer before it is recorded: `pending` is the model answer still to be written
 *  to `zz.assessment` (null for a measure no model was asked about), and `assessment_id` stays
 *  null until `recordMeasureAnswer` writes it. */
export type AnsweredMeasure = MeasureAnswer & { readonly pending: AskedEvaluatorAnswer | null };

/** Records `answered`'s pending model answer through `runner` — the caller's own transaction
 *  client — and returns the storable `MeasureAnswer` with its `assessment_id`, `pending` dropped
 *  so it never reaches `zz.eval_assessment.answer`. */
export async function recordMeasureAnswer(runner: pg.PoolClient, answered: AnsweredMeasure): Promise<MeasureAnswer> {
  const { pending, ...answer } = answered;
  if (!pending) return answer;
  const recorded = await insertEvaluatorAnswer(runner, pending);
  return { ...answer, assessment_id: recorded.assessment_id };
}

/** One measure, one subject_ref, one answer — dispatched by `evaluator_type`. `human` measures
 *  have no ingestion pipeline yet (this task's own plan boundary): recorded as excluded, never
 *  asked, never guessed at. */
export async function answerMeasure(opts: {
  measure: MeasureRow; snapshot: SnapshotFacts; subjectRef: string; principal: string;
  qualificationOf: (evaluatorVersionId: string) => Promise<{ id: string; state: string } | null>;
  /** What a model-backed measure is actually asked to judge. Callers that have real content for
   *  this subject_ref — replay-score.ts's own produced transcript/artifacts, for one — pass it
   *  here; omitted, this falls back to the same templated sentence naming subjectRef this
   *  function has always asked with (evaluation_assess's own eval_run path: a NAMED fact off an
   *  observation snapshot is what deterministic/outcome measures read, and no richer subject
   *  text exists yet for its model-backed measures either — a pre-existing gap this task does
   *  not fix, only extends the seam past). */
  subjectText?: string;
  /** What the subject is judged against, e.g. a case's own evaluation_oracle events — passed to
   *  the evaluator as `context`, never folded into `subjectText` itself, so the SUBJECT/CONTEXT
   *  split `semantic.ts`'s own state string keeps is still visible to whatever reads the raw
   *  assessment back later. */
  context?: string;
}): Promise<AnsweredMeasure> {
  const { measure, snapshot, subjectRef, principal, qualificationOf, subjectText, context } = opts;
  if (measure.evaluator_type === "deterministic" || measure.evaluator_type === "outcome") {
    return { ...deterministicAnswer(measure, snapshot), pending: null };
  }
  if (measure.evaluator_type === "human") {
    return {
      value: null, excluded: true, excluded_reason: "no human-label ingestion pipeline exists yet",
      evaluator_version_id: null, assessment_id: null, qualification_id: null, qualification_state: null,
      detail: {}, pending: null,
    };
  }
  const text = subjectText ?? `Measure "${measure.key}" against subject_ref "${subjectRef}".`;
  return modelBackedAnswer(measure, text, context, principal, qualificationOf);
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

// -------------------------------------------------------------------------------------------
// Guardrails (Task I-29's own fix dispatch, FR-6, FR-20, FR-23): `improvement.criticalGuardrails`
// is now the ONLY guardrail mechanism — evaluation_score, replay_score, candidate_prove and
// release_verify all read it through the two functions below, rather than each scanning a
// per-measure `definition.guardrail` flag of its own (the duplicate this fix removes).

/** One `Guardrail` (`@zz/contracts`) as this file evaluates it: a measure key and the threshold
 *  its NORMALISED value (the same [0,1] `reduceMeasureAnswers` already produced — never the raw
 *  fact) must meet or exceed to pass. `@zz/contracts`'s own zod schema already requires both
 *  fields on every entry it lets `protocol_record` write; `parseCriticalGuardrails` stays
 *  defensive of a bare string or a missing threshold anyway, because it also reads
 *  `improvement_policy` straight back off the database, which is one write path removed from
 *  that schema's own validation. */
export interface CriticalGuardrail { readonly key: string; readonly threshold: number }

export interface GuardrailResult extends CriticalGuardrail {
  readonly value: number | null;
  readonly status: "pass" | "fail" | "not_established";
}

const DEFAULT_GUARDRAIL_THRESHOLD = 0.5;

export function parseCriticalGuardrails(raw: unknown): CriticalGuardrail[] {
  if (!Array.isArray(raw)) return [];
  const out: CriticalGuardrail[] = [];
  for (const g of raw) {
    if (g && typeof g === "object" && typeof (g as Record<string, unknown>).key === "string") {
      const r = g as Record<string, unknown>;
      const threshold = typeof r.threshold === "number" ? r.threshold : DEFAULT_GUARDRAIL_THRESHOLD;
      out.push({ key: r.key as string, threshold });
    }
  }
  return out;
}

/** A run's own critical guardrails, evaluated against whatever this run already reduced each
 *  named measure key to (`valueByMeasureKey` — the same `reduceMeasureAnswers` output
 *  `evaluation_score`/`replay_score` compute per measure for scoring, keyed by `MeasureRow.key`
 *  rather than by `id`, because a protocol names its guardrails by measure key). A key the run
 *  never assessed at all (not present in the map) reads exactly as one whose every assessment was
 *  excluded — `not_established`, never a silently-passing `undefined`. Missing evidence is never
 *  failure (FR-9): `not_established` is its own status, distinct from `fail`, and every caller of
 *  this function is expected to keep that distinction rather than treating "not pass" as "fail". */
export function evaluateGuardrails(
  critical: readonly CriticalGuardrail[], valueByMeasureKey: ReadonlyMap<string, number | null>,
): GuardrailResult[] {
  return critical.map((g) => {
    const value = valueByMeasureKey.get(g.key) ?? null;
    const status: GuardrailResult["status"] =
      value === null ? "not_established" : value >= g.threshold ? "pass" : "fail";
    return { ...g, value, status };
  });
}
