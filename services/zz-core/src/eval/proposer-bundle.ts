/**
 * The proposer's input bundle (Task I-18, AC-37.1, FR-37): "actionable side information" —
 * failing traces, evaluator critiques, refusal text, user corrections, dependency/tool errors,
 * cost/latency and prior rejected hypotheses — assembled for one `improvement_run`, so whatever
 * proposes a candidate's hypothesis reads what already failed instead of guessing blind. The
 * skill that tells an agent HOW to read this bundle is a later task (I-28, the plan's own
 * boundary: "final deliverable content is not in this plan"); this module only builds it.
 *
 * Split the way `replay-runs.ts`'s own `dependencyAction`/`sealedRows` are: `buildProposerBundle`
 * is pure — every decision about what counts as "failing", "rejected" or "non-trivial" lives
 * here, on values alone — and `loadProposerBundle` is the one query that reads
 * `zz.eval_finding` / `zz.eval_assessment` / `zz.candidate` / `zz.replay_run` for one
 * improvement_run and hands the pure function real rows. Neither is registered as an MCP tool —
 * `candidates.ts`'s own `improvement_start` response is where a caller reaches this, once a
 * later task adds that field; today it exists so the query and the shape are settled and
 * testable ahead of that wiring.
 */
import type pg from "pg";

/** A candidate counts as a prior REJECTION for `candidates.ts`'s own duplicate-hypothesis refusal
 *  when its status is one of these. `invalid`/`proof_failed` are later stages' own verdicts
 *  (candidate_validate/candidate_prove); `rejected_precheck` is the status this same repeat check
 *  itself implies for a hypothesis that never got past it. All three read as "this idea did not
 *  work," which is exactly what FR-38's regularized search needs to avoid proposing again.
 *  Deliberately NOT `proof_not_established` (migration 081, fix dispatch on I-21) — an
 *  unestablished proof is an evidence gap, not a rejected idea, so it does not block
 *  `candidate_record`'s own repeat-hypothesis check the way a genuinely `proof_failed` one does.
 *
 *  NOT the same set this bundle's own `loadProposerBundle` below reads for
 *  `prior_rejected_hypotheses` — see `PROOF_SIGNAL_STATUSES`, just below. That set excludes
 *  `proof_failed` too: FR-28 forbids feeding a proof RESULT back into search, whether or not the
 *  status also happens to block re-recording the hypothesis through `candidate_record`. */
export const REJECTED_CANDIDATE_STATUSES = ["rejected_precheck", "invalid", "proof_failed"] as const;

/** What `loadProposerBundle` treats as a prior rejection worth showing a proposer/search session
 *  (FR-37's own "prior rejected hypotheses" side information) — deliberately narrower than
 *  `REJECTED_CANDIDATE_STATUSES` above. `proof_failed` and `proof_not_established` are BOTH proof
 *  signals: FR-28's "proof results must not be fed back into search" covers an unestablished
 *  proof exactly as it covers a failed one, even though only `proof_failed` also blocks
 *  `candidate_record`'s separate re-proposal check. Module-local: nothing outside this file's own
 *  `loadProposerBundle` needs this distinction. */
const PROOF_SIGNAL_STATUSES = ["proof_failed", "proof_not_established"] as const;
const PROPOSER_VISIBLE_REJECTION_STATUSES = (REJECTED_CANDIDATE_STATUSES as readonly string[])
  .filter((s) => !(PROOF_SIGNAL_STATUSES as readonly string[]).includes(s));

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

export interface RawCostLatency {
  readonly subject_ref: string;
  readonly cost: number | null;
  readonly duration_ms: number | null;
}

export interface ProposerBundleRaw {
  readonly findings: readonly RawFinding[];
  readonly assessments: readonly RawAssessment[];
  readonly rejected: readonly RawRejectedCandidate[];
  readonly cost_latency: readonly RawCostLatency[];
}

// -------------------------------------------------------------------------------------------
// The bundle itself.

export interface ProposerBundle {
  readonly failing_traces: readonly { measure_key: string; subject_ref: string; detail: Record<string, unknown> }[];
  readonly evaluator_critiques: readonly { measure_key: string; subject_ref: string; note: string }[];
  readonly refusal_text: readonly string[];
  readonly corrections: readonly string[];
  readonly errors: readonly string[];
  readonly cost_latency: readonly RawCostLatency[];
  readonly prior_rejected_hypotheses: readonly { candidate_id: string; hypothesis: string; status: string }[];
  /** False only when every section above is empty — a proposer reading a trivial bundle is
   *  reading nothing this run learned, which the plan's own live-verification step checks for
   *  directly rather than trusting a non-empty top-level object. */
  readonly non_trivial: boolean;
}

// The same pass/fail line evaluation.ts's own guardrail reduction uses (`m.value >= 0.5`) — one
// threshold for "did this measure come back bad," not a second one invented here.
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
  // or a correction — there is no dedicated refusal/transcript table yet (replay telemetry, once
  // a later task wires cost/latency into it, is that evidence surface's future home). Split by a
  // refusal-shaped word so the two sections are not the same list twice; a `strength`/`unknown`
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
    cost_latency: raw.cost_latency, prior_rejected_hypotheses, non_trivial,
  };
}

// -------------------------------------------------------------------------------------------
// The query that fills it — one improvement_run's own targeted findings, this run's assessment
// rows, its plugin's prior rejections, and whatever replay telemetry already names its subject.

interface ImprovementRunRef { readonly eval_run_id: string; readonly finding_ids: readonly string[] }

async function loadRunRef(p: pg.Pool, improvementRunId: string): Promise<ImprovementRunRef | null> {
  const row = (await p.query<{ eval_run_id: string; finding_ids: string[] }>(
    "select eval_run_id::text as eval_run_id, finding_ids from zz.improvement_run where id = $1::uuid",
    [improvementRunId])).rows[0];
  return row ? { eval_run_id: row.eval_run_id, finding_ids: row.finding_ids } : null;
}

/** `null` for an improvement_run_id nothing minted — `candidates.ts` turns that into its own
 *  refusal text; this function only reports what it could not find. */
export async function loadProposerBundle(p: pg.Pool, improvementRunId: string): Promise<ProposerBundle | null> {
  const ref = await loadRunRef(p, improvementRunId);
  if (!ref) return null;

  const runRow = (await p.query<{ subject_version_id: string; protocol_version_id: string }>(
    "select subject_version_id::text as subject_version_id, protocol_version_id::text as protocol_version_id " +
    "from zz.eval_run where id = $1::uuid", [ref.eval_run_id])).rows[0];
  const pluginRow = runRow ? (await p.query<{ plugin_id: string }>(
    "select plugin_id::text as plugin_id from zz.eval_subject_version where id = $1::uuid",
    [runRow.subject_version_id])).rows[0] : null;

  const findings = ref.finding_ids.length
    ? (await p.query<RawFinding>(
        "select id::text as id, kind, pattern, evidence_refs from zz.eval_finding where id = any($1::uuid[])",
        [ref.finding_ids])).rows
    : [];

  const assessments = (await p.query<{
    measure_key: string; subject_ref: string; value: string | null; excluded_reason: string | null;
    detail: Record<string, unknown> | null;
  }>(`
    select m.key as measure_key, a.subject_ref,
           a.answer->>'value' as value, a.answer->>'excluded_reason' as excluded_reason,
           a.answer->'detail' as detail
      from zz.eval_assessment a
      join zz.eval_measure m on m.id = a.measure_id
     where a.eval_run_id = $1::uuid`, [ref.eval_run_id])).rows
    .map((r): RawAssessment => ({
      measure_key: r.measure_key, subject_ref: r.subject_ref,
      value: r.value === null ? null : Number(r.value), excluded_reason: r.excluded_reason,
      detail: r.detail ?? {},
    }));

  // FR-28: `prior_rejected_hypotheses` below is proposer/search-facing evidence, so it reads
  // PROPOSER_VISIBLE_REJECTION_STATUSES — never REJECTED_CANDIDATE_STATUSES itself, which still
  // names proof_failed for candidate_record's OWN, separate re-proposal refusal. A proof result
  // (proof_failed or proof_not_established alike) must not be fed back into search; see the
  // module note above both constants.
  const rejected = pluginRow
    ? (await p.query<{ candidate_id: string; hypothesis: string; status: string }>(`
        select c.id::text as candidate_id, c.hypothesis, c.status
          from zz.candidate c
          join zz.eval_subject_version sv on sv.id = c.base_subject_version_id
         where sv.plugin_id = $1::uuid and c.status = any($2::text[])
         order by c.created_at desc`,
        [pluginRow.plugin_id, PROPOSER_VISIBLE_REJECTION_STATUSES])).rows
    : [];

  // FR-28/FR-30: this bundle is what a search/proposer session reads (improvement_start's own
  // response, and candidate_search's own re-read of it once a run is terminal) — a search
  // context never sees a split: proof row, whether that row is a case, a result reference or,
  // as here, a cost/latency figure derived from one. Joined to zz.replay_case for the same
  // reason replay-runs.ts's own sealedRows filters by split rather than by table: the boundary
  // is the row's own case, not which column happens to be read off it.
  const costLatency = (await p.query<{ subject_ref: string; cost: string | null; duration_ms: string | null }>(`
    select coalesce(rr.subject_version_id::text, rr.candidate_id::text) as subject_ref, rr.cost, rr.duration_ms
      from zz.replay_run rr
      join zz.replay_case rc on rc.id = rr.case_id
     where rr.protocol_version_id = $1::uuid and (rr.cost is not null or rr.duration_ms is not null)
       and rc.split is distinct from 'proof'`,
    [runRow?.protocol_version_id ?? null])).rows
    .map((r): RawCostLatency => ({
      subject_ref: r.subject_ref, cost: r.cost === null ? null : Number(r.cost),
      duration_ms: r.duration_ms === null ? null : Number(r.duration_ms),
    }));

  return buildProposerBundle({ findings, assessments, rejected, cost_latency: costLatency });
}
