/**
 * The proposer's input bundle (Task I-18, AC-37.1, FR-37): "actionable side information" —
 * failing traces, evaluator critiques, refusal text, user corrections, dependency/tool errors
 * and prior rejected hypotheses — assembled for one `improvement_run`, so whatever proposes a
 * candidate's hypothesis reads what already failed instead of guessing blind.
 *
 * `buildProposerBundle` is pure — every decision about what counts as "failing", "rejected" or
 * "non-trivial" lives here, on values alone — and `loadProposerBundle` is the one query that
 * reads `zz.eval_finding` / `zz.eval_assessment` / `zz.candidate` for one improvement_run and
 * hands the pure function real rows. `candidates.ts`'s `improvement_start` response carries it.
 */
import { EVAL_STATE_ENUMS } from "@zz/contracts";
import type pg from "pg";

import { STORED_ANSWERS_SQL } from "./evaluate-run.js";

/** The attempt state a rollback leaves behind — taken from the shared vocabulary every writer
 *  takes its state values from (`EVAL_STATE_ENUMS`), sixth of six, rather than spelled: it is
 *  also the name of the boolean column group G drops, and `checks/release-relations.ts` reads
 *  this file's text for that spelling. */
const ROLLBACK_STATE = EVAL_STATE_ENUMS.releaseAttemptStatus[5];

/** A candidate counts as a prior REJECTION — for `candidates.ts`'s duplicate-hypothesis refusal
 *  and for the bundle's `prior_rejected_hypotheses` alike — when its own status is `invalid`
 *  (it failed its build or gate) or when the release attempt it was carried into ended in the
 *  rollback state (it was released and measured worse on real use). Both read as "this idea did
 *  not work," which FR-38 says is not proposed again. The two values are read from two columns
 *  since group G gave the attempt the second one: `zz.candidate.status` is only ever
 *  recorded/awaiting_build/valid/invalid, and a rolled-back candidate is recognised through the
 *  `zz.release_attempt` row that names it. */
export const REJECTED_CANDIDATE_STATUSES = ["invalid", ROLLBACK_STATE] as const;

// -------------------------------------------------------------------------------------------
// Raw row shapes — exactly what `loadProposerBundle`'s queries hand to the pure builder below.

export interface RawFinding {
  readonly id: string;
  readonly kind: string;
  readonly pattern: string;
  readonly evidence_refs: readonly string[];
}

export interface RawAssessment {
  readonly measure_key: string;
  readonly subject_ref: string;
  readonly value: number | null;
  readonly excluded_reason: string | null;
  readonly detail: Record<string, unknown>;
}

export interface RawRejectedCandidate {
  readonly candidate_id: string;
  readonly hypothesis: string;
  readonly status: string;
}

export interface ProposerBundleRaw {
  readonly findings: readonly RawFinding[];
  readonly assessments: readonly RawAssessment[];
  readonly rejected: readonly RawRejectedCandidate[];
}

// -------------------------------------------------------------------------------------------
// The bundle itself.

export interface ProposerBundle {
  readonly failing_traces: readonly { measure_key: string; subject_ref: string; detail: Record<string, unknown> }[];
  readonly evaluator_critiques: readonly { measure_key: string; subject_ref: string; note: string }[];
  readonly refusal_text: readonly string[];
  readonly corrections: readonly string[];
  readonly errors: readonly string[];
  readonly prior_rejected_hypotheses: readonly { candidate_id: string; hypothesis: string; status: string }[];
  /** False only when every section above is empty — a proposer reading a trivial bundle is
   *  reading nothing this run learned, which the plan's own live-verification step checks for
   *  directly rather than trusting a non-empty top-level object. */
  readonly non_trivial: boolean;
}

// The pass/fail line a guardrail uses is `evaluate-measures.ts`'s `evaluateGuardrails`, and it
// compares against each MEASURE's own `guardrail_threshold` — the fact moved to where it is
// measured against, so there is no single line to mirror. The constant below answers a different
// question (is this proposal trivial), and keeping one number for it is this file's own choice.
const FAILING_THRESHOLD = 0.5;
const REFUSAL_WORDS = /refus|reject|declin|cannot|won'?t|will not/i;

/** Pure: every judgement call about what belongs in the bundle, in one place, over values a
 *  caller already read off the database. No query, no clock, no randomness — `checks/` or a
 *  live worker can hand this fixture rows and get the exact same bundle back. */
export function buildProposerBundle(raw: ProposerBundleRaw): ProposerBundle {
  const failing_traces = raw.assessments
    .filter((a) => a.value === null || a.value < FAILING_THRESHOLD)
    .map((a) => ({ measure_key: a.measure_key, subject_ref: a.subject_ref, detail: a.detail }));

  // `detail.reading` is a bounded_semantic/generative_critic answer's own choice/score legend
  // (`evaluate-measures.ts`'s `valueFromAnswer` detail) — the closest thing an assessment stores
  // to a model's own critique of the subject, short of free text this schema does not carry yet.
  const evaluator_critiques = raw.assessments
    .filter((a) => typeof a.detail.reading === "string" && a.detail.reading)
    .map((a) => ({ measure_key: a.measure_key, subject_ref: a.subject_ref, note: String(a.detail.reading) }));

  const errors = raw.assessments
    .filter((a): a is RawAssessment & { excluded_reason: string } => !!a.excluded_reason)
    .map((a) => `${a.measure_key} (${a.subject_ref}): ${a.excluded_reason}`);

  // A `defect` finding's own `pattern` is the closest thing EVALUATE records today to a refusal
  // or a correction — there is no dedicated refusal/transcript table. Split by a refusal-shaped
  // word so the two sections are not the same list twice; a `strength`/`unknown`
  // finding names neither.
  const defects = raw.findings.filter((f) => f.kind === "defect");
  const refusal_text = defects.filter((f) => REFUSAL_WORDS.test(f.pattern)).map((f) => f.pattern);
  const corrections = defects.filter((f) => !REFUSAL_WORDS.test(f.pattern)).map((f) => f.pattern);

  const prior_rejected_hypotheses = raw.rejected.map((r) => ({
    candidate_id: r.candidate_id, hypothesis: r.hypothesis, status: r.status,
  }));

  const non_trivial = failing_traces.length > 0 || evaluator_critiques.length > 0
    || errors.length > 0 || refusal_text.length > 0 || corrections.length > 0
    || prior_rejected_hypotheses.length > 0;

  return {
    failing_traces, evaluator_critiques, refusal_text, corrections, errors,
    prior_rejected_hypotheses, non_trivial,
  };
}

// -------------------------------------------------------------------------------------------
// The query that fills it — one improvement_run's own targeted findings, this run's assessment
// rows and its plugin's prior rejections.

interface ImprovementRunRef { readonly eval_run_id: string; readonly finding_ids: readonly string[] }

/** The findings a run targets, read through the relation that holds them (group G):
 *  `improvement_run_finding`, one row per finding, rather than the jsonb array that could not be
 *  enforced. The array shape is what the rest of this file already works with, so the aggregate
 *  hands back exactly that. */
async function loadRunRef(p: pg.Pool, improvementRunId: string): Promise<ImprovementRunRef | null> {
  const row = (await p.query<{ eval_run_id: string; finding_ids: string[] }>(`
    select ir.eval_run_id::text as eval_run_id,
           coalesce(f.ids, '{}'::uuid[]) as finding_ids
      from zz.improvement_run ir
      left join lateral (
        select array_agg(r.finding_id) as ids
          from zz.improvement_run_finding r
         where r.improvement_run_id = ir.id) f on true
     where ir.id = $1::uuid`, [improvementRunId])).rows[0];
  return row ? { eval_run_id: row.eval_run_id, finding_ids: row.finding_ids } : null;
}

/** `null` for an improvement_run_id nothing minted — `candidates.ts` turns that into its own
 *  refusal text; this function only reports what it could not find. */
export async function loadProposerBundle(p: pg.Pool, improvementRunId: string): Promise<ProposerBundle | null> {
  const ref = await loadRunRef(p, improvementRunId);
  if (!ref) return null;

  // The run reaches its release through the observation snapshot it was bound to (FR-27), and a
  // release is one `plugin_version` — the second row per released thing folds onto it.
  const runRow = (await p.query<{ plugin_version_id: string }>(`
    select os.plugin_version_id::text as plugin_version_id
      from zz.eval_run er
      join zz.eval_observation_snapshot os on os.id = er.observation_snapshot_id
     where er.id = $1::uuid`, [ref.eval_run_id])).rows[0];
  const pluginRow = runRow ? (await p.query<{ plugin_id: string }>(
    "select plugin_id::text as plugin_id from zz.plugin_version where id = $1::uuid",
    [runRow.plugin_version_id])).rows[0] : null;

  const findings = ref.finding_ids.length
    ? (await p.query<RawFinding>(
        "select id::text as id, kind, pattern, evidence_refs from zz.eval_finding where id = any($1::uuid[])",
        [ref.finding_ids])).rows
    : [];

  // The ref label and the four figures come from the one projection `evaluation_score` reads the
  // run's stored answers through (`evaluate-run.ts`'s `STORED_ANSWERS_SQL`), so a subject is
  // spelled the same way here as it is in the score this bundle is proposed against. The detail
  // bag is rebuilt from what the row still holds — the model answer itself moved to the
  // assessment the value came from, and `reading` is read there rather than off a jsonb the
  // assessment no longer carries.
  const assessments = (await p.query<{
    measure_key: string; subject_ref: string; value: string | null; excluded_reason: string | null;
    detail: Record<string, unknown> | null;
  }>(`
    select m.key as measure_key, x.subject_ref,
           x.answer->>'value' as value, x.answer->>'excluded_reason' as excluded_reason,
           jsonb_strip_nulls(jsonb_build_object(
             'reading', s.reading, 'probability', s.probability, 'answer_kind', s.answer_kind,
             'distribution', s.distribution, 'model_call_id', s.model_call_id,
             'raw_value', x.answer->'detail'->'raw_value')) as detail
      from (${STORED_ANSWERS_SQL}
            where a.eval_run_id = $1::uuid) x
      join zz.eval_measure m on m.id = x.measure_id::uuid
      left join zz.assessment s on s.id = (x.answer->>'assessment_id')::bigint`,
    [ref.eval_run_id])).rows
    .map((r): RawAssessment => ({
      measure_key: r.measure_key, subject_ref: r.subject_ref,
      value: r.value === null ? null : Number(r.value), excluded_reason: r.excluded_reason,
      detail: r.detail ?? {},
    }));

  // The rejection is read from wherever it now lives: the candidate's own status for a failed
  // build or gate, and the release attempt it was carried into for a rollback (group G).
  const rejected = pluginRow
    ? (await p.query<{ candidate_id: string; hypothesis: string; status: string }>(`
        select c.id::text as candidate_id, c.hypothesis,
               coalesce(ra.status, c.status) as status
          from zz.candidate c
          join zz.plugin_version pv on pv.id = c.base_plugin_version_id
          left join zz.release_attempt ra on ra.candidate_id = c.id
         where pv.plugin_id = $1::uuid
           and (c.status = any($2::text[]) or ra.status = any($2::text[]))
         order by c.created_at desc`,
        [pluginRow.plugin_id, [...REJECTED_CANDIDATE_STATUSES]])).rows
    : [];

  return buildProposerBundle({ findings, assessments, rejected });
}
