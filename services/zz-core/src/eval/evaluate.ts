/**
 * EVALUATE (AC-8.1, AC-9.1, AC-12.1, FR-29, FR-30): the /eval door's own three acts.
 * `evaluation_start` and `evaluation_assess` are `evaluate-run.ts`'s; this file owns the third
 * and the door.
 *
 * `evaluation_score` reduces the rows `evaluation_assess` wrote back (`reduceMeasureAnswers`),
 * calls `scoreRun` (pure, `score.ts`) once for the run's own numbers and once per resample of the
 * subjects for `evaluate-interval.ts`'s bootstrap of that same overall, computes `coverage_met`
 * and `qualification_met` (see `qualificationMet` below — a bootstrap protocol forces
 * `qualification_met = false` regardless of what every measure's own evaluator qualification
 * says), reads the guardrails off the run's own measures' `guardrail_threshold` column, and writes
 * the whole result in one transaction: the score columns on `zz.eval_run`, one
 * `zz.eval_run_dimension` row per dimension of the protocol, and `scored_at` as the terminal
 * marker (FR-29, Rule 4). A scored run therefore refuses every later re-scoring or result
 * rewrite — its result is published, and a re-score is a new run.
 *
 * `release_verify` (release-verify.ts) reads the same runs back: a released subject is judged by
 * an evaluation of its real post-release runs, started through this door.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EVAL_STATE_ENUMS, EstablishmentPolicy, QualificationPolicy, parseCaller } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import type pg from "pg";
import { z } from "zod";

import {
  evaluateGuardrails, guardrailsOfMeasures, isRunLevelRef, readingsOf, reduceMeasureAnswers,
  type CriticalGuardrail, type DimensionRow, type MeasureAnswer,
} from "./evaluate-measures.js";
import {
  STORED_ANSWERS_SQL, assessEvaluation, latestQualification, loadDimensions, loadRunContext,
  loadSnapshotFacts, startEvaluation, type RunContext,
} from "./evaluate-run.js";
import { bootstrapInterval, resolveUncertainty } from "./evaluate-interval.js";
import { decideBeforeWork, withIdempotency, type IdempotencyOutcome, type MutatorOutcome } from "./idempotency.js";
import { snapshotSubjectRefs } from "./observe.js";
import { recordStage } from "./stage-record.js";
import { scoreRun } from "./score.js";
import { platformEvent } from "../indexing.js";
import { PLATFORM_VERSION } from "../platform-version.js";
import { db } from "../platform-db.js";
import { Refusal } from "../refusal.js";
import type { DimensionScoreRow, MeasureScoreRow } from "./findings-doc.js";

const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const noDb = () => text("ERROR: this deployment has no platform database, so no evaluation can be run");

const QUALIFICATION_RANK: readonly string[] = EVAL_STATE_ENUMS.qualificationState;
const rankOf = (state: string): number => Math.max(QUALIFICATION_RANK.indexOf(state), 0);

interface ProtocolPolicy {
  qualification: QualificationPolicy | null; bootstrap: boolean; uncertainty: Record<string, unknown>;
}

async function loadProtocolPolicy(p: pg.Pool, protocolVersionId: string): Promise<ProtocolPolicy> {
  const row = (await p.query<{ qualification_policy: unknown; scoring_policy: unknown }>(`
    select qualification_policy, scoring_policy
      from zz.eval_protocol_version where id = $1::uuid`,
    [protocolVersionId])).rows[0];
  const qual = QualificationPolicy.safeParse(row?.qualification_policy);
  const scoring = row?.scoring_policy as { establishment?: unknown; uncertainty?: unknown } | undefined;
  const establishment = EstablishmentPolicy.safeParse(scoring?.establishment ?? {});
  return {
    qualification: qual.success ? qual.data : null,
    bootstrap: establishment.success ? establishment.data.bootstrap : false,
    uncertainty: (scoring?.uncertainty as Record<string, unknown>) ?? {},
  };
}

/** AC-12.1: whether every model-backed measure's evaluator is qualified enough to back this run's
 *  status — and, for a bootstrap protocol, whether it is allowed to establish at all, which it
 *  never is. `scoring.establishment.bootstrap = true` means this protocol has no history of its
 *  own yet to qualify evaluators against, so `evaluation_score` must treat `qualification_met` as
 *  false regardless of what any individual qualification row says — a bootstrap protocol's run
 *  can be `provisional` at best until a later, non-bootstrap protocol revision clears it
 *  (score.ts's own status rule then does the rest). */
async function qualificationMet(
  p: pg.Pool, dims: DimensionRow[], protocolVersionId: string, policy: ProtocolPolicy,
): Promise<boolean> {
  if (policy.bootstrap) return false;
  const minimum = policy.qualification?.boundedSemanticMinimum ?? "operationally_qualified";
  // Only a REQUIRED measure of an APPLICABLE dimension can withhold establishment — the same
  // pair `scoreRun`'s own `allRequiredPresent` reads. An optional model-backed measure with a
  // thin evaluator drops out of its own dimension's re-normalisation (score.ts's own rule); it
  // does not veto the whole run.
  const modelBacked = dims.filter((d) => d.applicable).flatMap((d) => d.measures)
    .filter((m) => m.required &&
      (m.evaluator_type === "bounded_semantic" || m.evaluator_type === "generative_critic"));
  if (!modelBacked.length) return true;
  for (const m of modelBacked) {
    if (!m.evaluator_version_id) return false;
    const q = await latestQualification(p, m.evaluator_version_id, protocolVersionId);
    if (!q || rankOf(q.state) < rankOf(minimum)) return false;
  }
  return true;
}

/** `EstablishmentPolicy.minCoverage` is `FreeformRecord` (spec v8 fixes no shape — this task's
 *  own plan boundary leaves it to this file): `minUsableRuns` and `minSubjectRefs`, the two
 *  numbers `evaluation_score` can actually check against what this run holds. Either left out
 *  (or the whole policy left out) is satisfied trivially — a protocol that names no coverage
 *  floor imposes none. */
function coverageMet(minCoverage: Record<string, unknown> | undefined, usableRunCount: number, subjectRefCount: number): boolean {
  const minRuns = minCoverage?.minUsableRuns;
  if (typeof minRuns === "number" && usableRunCount < minRuns) return false;
  const minRefs = minCoverage?.minSubjectRefs;
  if (typeof minRefs === "number" && subjectRefCount < minRefs) return false;
  return true;
}

/** `evaluation_score`, as a function of the pool and the caller rather than of an HTTP request:
 *  the handler below is its only production caller, and it is exported so a check can drive the
 *  same code against a throwaway database, where the request headers a handler reads do not
 *  exist. */
export async function scoreEvaluation(
  p: pg.Pool, principal: string,
  args: { eval_run_id: string; idempotency_key: string; initiative?: string },
): Promise<{
  eval_run_id: string; overall_score: number | null; score_status: string; establishment_blocked_by: string[];
  score_coverage: number | null; coverage_floor: number;
  score_interval: { lower: number | null; upper: number | null; level: number; iterations: number;
    n_subjects: number; degenerate: boolean; note: string | null };
  dimension_scores: DimensionScoreRow[]; guardrail_status: string; guardrails: CriticalGuardrail[];
  coverage: { measures: number | null; measures_floor: number; establishment_blocked_by: string[] };
  readings: Record<string, Record<string, unknown>[]>; replayed: boolean; record_refused?: string;
} | { readonly error: string }> {
  const { eval_run_id, idempotency_key, initiative } = args;
  const run: RunContext | null = await loadRunContext(p, eval_run_id);
  if (!run) return { error: "ERROR: unknown eval_run_id" };

  // A scored run's result is published — findings cite it and release_verify reads it — so it is
  // never scored again: a re-score is a new eval_run. The retry of the call that scored it is
  // recognised first and answers as that call did.
  const alreadyScored = `ERROR: eval_run ${eval_run_id} is already scored and its score is ` +
    "published; scoring it again would overwrite that result. A re-score is a new eval_run — " +
    "call evaluation_start";
  if (run.scored_at !== null &&
      !(await decideBeforeWork(principal, "evaluation_score", idempotency_key, { eval_run_id })).replayed) {
    return { error: alreadyScored };
  }

  const dims = await loadDimensions(p, run.protocol_version_id);
  const measures = dims.flatMap((d) => d.measures);
  /** A dimension's own row id, by key — what `zz.eval_run_dimension` points at. */
  const dimensionIdByKey = new Map(dims.map((d) => [d.key, d.id]));
  const assessed = (await p.query<{ n: string }>(
    "select count(*)::text as n from zz.eval_assessment where eval_run_id = $1::uuid", [eval_run_id])).rows[0];
  if (Number(assessed?.n ?? 0) === 0) {
    return { error: `ERROR: eval_run ${eval_run_id} has no assessment recorded — call evaluation_assess first` };
  }

  const rows = (await p.query<{ measure_id: string; subject_ref: string; answer: MeasureAnswer }>(
    `${STORED_ANSWERS_SQL} where a.eval_run_id = $1::uuid`, [eval_run_id])).rows;
  const pushInto = <K,>(map: Map<K, MeasureAnswer[]>, key: K, value: MeasureAnswer): void => {
    const list = map.get(key);
    if (list) list.push(value); else map.set(key, [value]);
  };
  const byMeasure = new Map<string, MeasureAnswer[]>();
  const bySubjectAndMeasure = new Map<string, Map<string, MeasureAnswer[]>>();
  // Run-level rows (a fact read once per run, a run-level exclusion) are not a subject: they
  // count toward no subject floor and are folded into every subject's own score below.
  const runLevel = new Map<string, MeasureAnswer[]>();
  const subjectRefs = new Set<string>();
  for (const r of rows) {
    pushInto(byMeasure, r.measure_id, r.answer);
    if (isRunLevelRef(r.subject_ref)) { pushInto(runLevel, r.measure_id, r.answer); continue; }
    subjectRefs.add(r.subject_ref);
    const perSubject = bySubjectAndMeasure.get(r.subject_ref) ?? new Map<string, MeasureAnswer[]>();
    bySubjectAndMeasure.set(r.subject_ref, perSubject);
    pushInto(perSubject, r.measure_id, r.answer);
  }
  const readings = readingsOf(rows, new Map(measures.map((m) => [m.id, m.key])));

  const policy = await loadProtocolPolicy(p, run.protocol_version_id);
  const snapshot = await loadSnapshotFacts(p, run.observation_snapshot_id);
  // The run's guardrails are its own measures' bars (`eval_measure.guardrail_threshold`), so the
  // list is read off the measures this run was assessed under rather than a policy object.
  const criticalGuardrails: CriticalGuardrail[] = guardrailsOfMeasures(measures);
  const criticalKeys = new Set(criticalGuardrails.map((g) => g.key));

  // The doc-friendly per-measure detail findings.md reads back (findings-doc.ts) — denominators
  // and guardrail flags scoreRun's own output does not carry. `guardrail` is membership in the
  // run's own guardrail list — display only; `evaluateGuardrails` below is what decides
  // pass/fail/not_established.
  const measureDetail = (values: Map<string, MeasureAnswer[]>): Map<string, MeasureScoreRow> => {
    const out = new Map<string, MeasureScoreRow>();
    for (const m of measures) {
      const answers = values.get(m.id) ?? [];
      const value = reduceMeasureAnswers(answers);
      out.set(m.id, {
        key: m.key, evaluator_type: m.evaluator_type, weight: m.weight, required: m.required,
        value, excluded: value === null, guardrail: criticalKeys.has(m.key),
        excluded_reason: value === null ? (answers[0]?.excluded_reason ?? "no assessment recorded") : null,
      });
    }
    return out;
  };

  const overallDetail = measureDetail(byMeasure);
  const scoreInputDimensions = dims.map((d) => ({
    key: d.key, canonical_kind: d.canonical_kind, weight: d.weight, required: d.required,
    applicable: d.applicable, not_applicable_reason: d.not_applicable_reason,
    measures: d.measures.map((m) => ({ weight: m.weight, required: m.required, value: overallDetail.get(m.id)!.value })),
  }));

  const minCoverageRow = (await p.query<{
    scoring_policy: { establishment?: { minCoverage?: Record<string, unknown> } };
  }>("select scoring_policy from zz.eval_protocol_version where id = $1::uuid",
    [run.protocol_version_id])).rows[0];
  const coverage_met = coverageMet(
    minCoverageRow?.scoring_policy?.establishment?.minCoverage,
    snapshot.usable_run_count, subjectRefs.size);
  const qualification_met = await qualificationMet(p, dims, run.protocol_version_id, policy);

  // The guardrails, evaluated against each measure's already-reduced [0,1] value — keyed by
  // measure KEY (a guardrail names a key, not a row id), one entry per measure this run has.
  const valueByMeasureKey = new Map<string, number | null>(measures.map((m) => [m.key, overallDetail.get(m.id)!.value]));
  const guardrailResults = evaluateGuardrails(criticalGuardrails, valueByMeasureKey);
  const guardrails = guardrailResults.map((g) => g.status);

  const scored = scoreRun({ dimensions: scoreInputDimensions, coverage_met, qualification_met, guardrails });

  const dimension_scores: DimensionScoreRow[] = dims.map((d) => {
    const outScore = scored.dimensions.find((s) => s.key === d.key);
    // A dimension that does not apply was never assessed; its measures carry its reason, not
    // an exclusion that reads as missing evidence.
    const measuresRows = d.measures.map((m) => d.applicable ? overallDetail.get(m.id)!
      : { ...overallDetail.get(m.id)!, excluded_reason: `not applicable: ${d.not_applicable_reason ?? "the protocol says so"}` });
    return {
      key: d.key, canonical_kind: d.canonical_kind, score: outScore?.score ?? null,
      coverage: outScore?.coverage ?? null, applicable: d.applicable,
      not_applicable_reason: d.not_applicable_reason, weight: d.weight, required: d.required,
      measures_scored: measuresRows.filter((m) => !m.excluded).length, measures_total: measuresRows.length,
      measures: measuresRows,
    };
  });

  // The run's own overall, recomputed over a resample of its subjects — what the interval
  // is an interval OF. Run-level rows (the facts) are in every resample, as in the run.
  const subjects = [...subjectRefs];
  const overallOf = (indices: readonly number[]): number | null => {
    const merged = new Map<string, MeasureAnswer[]>([...runLevel].map(([k, v]) => [k, [...v]]));
    for (const i of indices) {
      for (const [measureId, answers] of bySubjectAndMeasure.get(subjects[i]) ?? []) {
        const list = merged.get(measureId);
        if (list) list.push(...answers); else merged.set(measureId, [...answers]);
      }
    }
    const detail = measureDetail(merged);
    return scoreRun({
      dimensions: dims.map((d) => ({
        key: d.key, canonical_kind: d.canonical_kind, weight: d.weight, required: d.required,
        applicable: d.applicable, not_applicable_reason: d.not_applicable_reason,
        measures: d.measures.map((m) => ({ weight: m.weight, required: m.required, value: detail.get(m.id)!.value })),
      })),
      coverage_met: true, qualification_met: true, guardrails: [],
    }).overall;
  };
  const score_interval = bootstrapInterval(subjects.length, overallOf, resolveUncertainty(policy.uncertainty, eval_run_id));

  // Why a score is not established, said rather than left for a reader to reverse-engineer
  // from three flags: every required measure left unscored, and each policy not met.
  const establishment_blocked_by = scored.status === "established" ? [] : [
    ...dimension_scores.flatMap((d) => d.measures.filter((m) => m.required && m.excluded)
      .map((m) => `required measure ${m.key} not scored: ${m.excluded_reason ?? "no assessment"}`)),
    ...(coverage_met ? [] : [`coverage floor not met: ${snapshot.usable_run_count} usable run(s), ${subjectRefs.size} subject ref(s)`]),
    ...(qualification_met ? [] : ["a required model-backed measure's evaluator is below the protocol's qualification minimum, or the protocol is a bootstrap"]),
  ];

  const outcome: IdempotencyOutcome<{ id: string }> = await withIdempotency(
    principal, "evaluation_score", idempotency_key, { eval_run_id },
    async (client): Promise<MutatorOutcome<{ id: string }>> => {
      // The terminal test is repeated here because a concurrent score under another key can
      // score the run between the check above and this write: `scored_at` is null only while the
      // run carries no published result, and the one statement that sets it is this one.
      const written = await client.query(`
        update zz.eval_run
           set scored_at = now(), score_status = $2, overall_score = $3,
               score_lower = $4, score_upper = $5, measure_coverage = $6,
               establishment_blocked_by = $7::text[], scorer_version = $8, guardrail_status = $9
         where id = $1::uuid and scored_at is null`,
        [eval_run_id, scored.status, scored.overall, score_interval.lower, score_interval.upper,
         scored.coverage, establishment_blocked_by, PLATFORM_VERSION, scored.guardrail_status]);
      if (written.rowCount !== 1) throw new Refusal(alreadyScored);
      // The per-dimension published results, written once, in the same transaction as the score
      // they belong to: a run that published no dimension published no score either.
      for (const d of dimension_scores) {
        await client.query(`
          insert into zz.eval_run_dimension (eval_run_id, protocol_version_id, dimension_id, score, coverage)
          values ($1::uuid, $2::uuid, $3::uuid, $4, $5)`,
          [eval_run_id, run.protocol_version_id, dimensionIdByKey.get(d.key), d.score, d.coverage]);
      }
      return { result: { id: eval_run_id }, result_table: "zz.eval_run", result_id: eval_run_id };
    },
  );

  const recorded = await recordStage(initiative, "zz-plugin-evaluate", { eval_run_id });
  return {
    eval_run_id, overall_score: scored.overall, score_status: scored.status, establishment_blocked_by,
    score_coverage: scored.coverage, coverage_floor: scored.coverage_floor,
    score_interval, dimension_scores, guardrail_status: scored.guardrail_status, guardrails: guardrailResults,
    coverage: { measures: scored.coverage, measures_floor: scored.coverage_floor, establishment_blocked_by },
    readings, replayed: outcome.replayed, ...recorded,
  };
}

export function registerEvaluationTools(server: McpServer): void {
  server.registerTool(
    "evaluation_start",
    {
      description:
        "WHEN a protocol version and an observation snapshot are ready to be scored together: " +
        "opens exactly one zz.eval_run bound to that snapshot, carrying the team it is opened in, " +
        "the principal who opened it and, when `initiative` names one, the initiative. RETURNS " +
        "{ eval_run_id, observation_snapshot_id, run_refs, refusal_refs } — the last two are the " +
        "snapshot's own runs and refused door calls, the subject_refs evaluation_assess takes, so " +
        "a conversation holding only the snapshot id has them. REFUSES an observation_snapshot_id " +
        "nothing minted; a protocol_version_id nothing minted, or one protocol_affirm has not " +
        "bound to an approved protocol.md (named, with its version); an observation snapshot " +
        "belonging to a DIFFERENT subject than subject_version_id names — " +
        "\"ERROR: observation snapshot belongs to subject <x>, not <y>\" — never silently scoring " +
        "one plugin's evidence against another's identity; a caller resolving to no team or no " +
        "principal, because a run with no team and no starter is one nobody can read back; and an " +
        "initiative that names nothing in the caller's own team. A mutator: writes through the " +
        "FR-59 idempotency ledger, so a retried call with the same idempotency_key replays the " +
        "same run rather than opening a second one.",
      inputSchema: {
        subject_version_id: z.string(), protocol_version_id: z.string(),
        observation_snapshot_id: z.string(), idempotency_key: z.string().min(1),
        initiative: z.string().optional().describe(
          "The initiative this evaluation runs in, so the run names the piece of work it was " +
          "opened under. Omitted, the run carries no initiative."),
      },
    },
    async ({ subject_version_id, protocol_version_id, observation_snapshot_id, idempotency_key, initiative }) => {
      const p = db();
      if (!p) return noDb();
      const principal = parseCaller(requestHeaders()).email;
      const started = await startEvaluation(p, principal,
        { subject_version_id, protocol_version_id, observation_snapshot_id, idempotency_key, initiative });
      if ("error" in started) return text(started.error);
      platformEvent({
        actor: principal, kind: "evaluation_start", initiative, eval_run_id: started.eval_run_id, replayed: started.replayed });
      return json({ ...started, ...(await snapshotSubjectRefs(p, started.observation_snapshot_id)) });
    },
  );

  server.registerTool(
    "evaluation_assess",
    {
      description:
        "WHEN eval_run_id is open and unscored: resolves every subject_ref to its real content — " +
        "an <initiative>/<doc>.md ref is read off the caller's own team's artifact store (one under " +
        "_knowledge/ is a knowledge node), bug:<id> from its bug report, a bare run_id (plugin_profile's " +
        "traces.run_refs) from its own zz.event rows, event:<id> (traces.refusal_refs) as that one door call " +
        "— then routes each measure: deterministic/outcome " +
        "read a named fact off the run's bound observation snapshot ONCE per run; bounded_semantic/" +
        "generative_critic ask the measure's bound evaluator only about refs of the kind it judges " +
        "(eval_measure.subject_kind, else its question's \"Read this run/document/bug report/record\"), " +
        "and only when that evaluator is qualified against this protocol version — otherwise one " +
        "row records the exclusion by name and no model is called; human is recorded as excluded. " +
        "Each stored row names its subject the typed way: a subject_kind and exactly the one child " +
        "key that kind requires. " +
        "RETURNS { eval_run_id, assessment_count, measures_assessed, model_calls, excluded }. " +
        "REFUSES an eval_run_id nothing minted, an eval_run already scored — its result is " +
        "published and its evidence is closed, so a re-assessment is a new run — and " +
        "BY NAME any subject_ref that resolves to neither a real document nor a real run, and any " +
        "ref whose subject resolves to no row the typed column could name: a " +
        "model asked to judge nothing is never silently handed a templated sentence naming the " +
        "ref instead. A mutator: writes through the FR-59 idempotency ledger.",
      inputSchema: {
        eval_run_id: z.string(),
        subject_refs: z.array(z.string()).describe(
          "The run ids, documents, bug reports and knowledge nodes to judge. Empty reads the run's " +
          "facts alone — for a plugin whose use left none of those, like a door used only outside " +
          "initiatives."),
        idempotency_key: z.string().min(1),
      },
    },
    async ({ eval_run_id, subject_refs, idempotency_key }) => {
      const p = db();
      if (!p) return noDb();
      const principal = parseCaller(requestHeaders()).email;
      const assessed = await assessEvaluation(p, principal, { eval_run_id, subject_refs, idempotency_key });
      if ("error" in assessed) return text(assessed.error);
      platformEvent({ actor: principal, kind: "evaluation_assess", eval_run_id, replayed: assessed.replayed });
      return json({ eval_run_id, ...assessed });
    },
  );

  server.registerTool(
    "evaluation_score",
    {
      description:
        "WHEN evaluation_assess has run against every subject_ref this evaluation needs: reduces " +
        "the stored zz.eval_assessment rows measure by measure and calls the pure scoreRun once " +
        "for the run's own dimensions and once per resample of its subjects for a percentile " +
        "bootstrap interval of that same overall. A dimension scores from whichever of its measures were scored and reports its " +
        "coverage (scored weight over declared weight); overall is null only when nothing scored, " +
        "and the status reads the coverage. Computes coverage_met from the protocol's own EstablishmentPolicy.minCoverage " +
        "and qualification_met from every model-backed measure's evaluator qualification against " +
        "QualificationPolicy.boundedSemanticMinimum — a bootstrap protocol " +
        "(scoring.establishment.bootstrap=true) forces qualification_met=false regardless. " +
        "Reads the run's critical guardrails off its own measures' guardrail_threshold, and " +
        "writes the whole result in one transaction: the score columns on zz.eval_run, one " +
        "zz.eval_run_dimension row per dimension of the protocol, and scored_at as the terminal " +
        "marker. RETURNS { overall_score, score_status, establishment_blocked_by (every reason it " +
        "is not established), score_coverage, score_interval, dimension_scores, " +
        "guardrail_status, coverage, readings } — readings is every stored answer, per measure key, " +
        "per subject_ref, with its assessment_id, which is what a finding cites. REFUSES an " +
        "eval_run_id nothing minted, a run with no assessment recorded " +
        "against it, and a run already scored — its score is published, so a re-score is a new " +
        "eval_run. A mutator: writes through the FR-59 idempotency ledger; a retry with the key that " +
        "scored the run replays rather than refusing.",
      inputSchema: {
        eval_run_id: z.string(), idempotency_key: z.string().min(1),
        initiative: z.string().optional().describe(
          "The initiative this evaluation runs in: records eval_run_id as its EVALUATE record, which " +
          "initiative_status hands to EXPLAIN when it starts in a new conversation."),
      },
    },
    async ({ eval_run_id, idempotency_key, initiative }) => {
      const p = db();
      if (!p) return noDb();
      const principal = parseCaller(requestHeaders()).email;
      const scored = await scoreEvaluation(p, principal, { eval_run_id, idempotency_key, initiative });
      if ("error" in scored) return text(scored.error);
      platformEvent({
        actor: principal, kind: "evaluation_score", initiative, eval_run_id,
        score_status: scored.score_status, overall_score: scored.overall_score, replayed: scored.replayed,
      });
      return json(scored);
    },
  );
}
