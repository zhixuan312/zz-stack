/**
 * EVALUATE (Task I-13, AC-8.1, AC-9.1, AC-12.1): `evaluation_start`, `evaluation_assess` and
 * `evaluation_score` — binding one protocol-bound evidence snapshot to a subject, running every
 * measure the protocol's dimensions name, and reducing the result to `scoreRun`'s one number.
 *
 * `evaluation_start` is the only writer of `zz.eval_evidence_snapshot` (Task I-7's
 * `zz.eval_observation_snapshot` bound to a `zz.eval_protocol_version`) and of `zz.eval_run` at
 * `run_status = 'pending'`. `release_verify` (release-verify.ts) reads the same runs back: a
 * released subject is judged by an evaluation of its real post-release runs, started here.
 *
 * `evaluation_assess` writes the rows `planAssessment` (evaluate-measures.ts) routes:
 * `deterministic`/`outcome` read a named fact off the run's own bound observation snapshot, by a
 * dotted `definition.factPath`, ONCE per run under the run-level ref; `bounded_semantic`/
 * `generative_critic` ask the measure's bound evaluator only about refs of the kind the measure
 * judges, and only when that evaluator is qualified — otherwise one run-level row records the
 * exclusion by name and no model is called; `human` is recorded as excluded (no ingestion
 * pipeline yet).
 *
 * `evaluation_score` reduces those rows back (`reduceMeasureAnswers`), calls `scoreRun` (pure,
 * `score.ts`) once for the run's own numbers and once per resample of the subjects for
 * `evaluate-interval.ts`'s bootstrap of that same overall, computes `coverage_met` and `qualification_met` (see `qualificationMet` below — the
 * bootstrap-protocol override this file must apply is Task I-29's: `scoring.establishment.bootstrap
 * = true` forces `qualification_met = false` regardless of what every measure's own evaluator
 * qualification says), evaluates the protocol's own `improvement.criticalGuardrails` (Task I-29's
 * own second fix — the ONLY guardrail mechanism now; a per-measure `definition.guardrail` flag is
 * no longer read anywhere), and stores the result on `zz.eval_run`.
 */
import { createHash } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EVAL_STATE_ENUMS, EstablishmentPolicy, QualificationPolicy, parseCaller } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import type pg from "pg";
import { z } from "zod";

import {
  answerMeasure, evaluateGuardrails, excludedAnswer, isRunLevelRef, parseCriticalGuardrails, planAssessment,
  readingsOf, recordMeasureAnswer, reduceMeasureAnswers, runLevelRef,
  type AnsweredMeasure, type CriticalGuardrail, type DimensionRow, type MeasureAnswer, type MeasureRow,
  type SnapshotFacts,
} from "./evaluate-measures.js";
import { bootstrapInterval, resolveUncertainty } from "./evaluate-interval.js";
import { canonicalJson, decideBeforeWork, withIdempotency, type IdempotencyOutcome, type MutatorOutcome } from "./idempotency.js";
import { recordStage } from "./stage-record.js";
import { resolveProtocol, unaffirmedRefusal } from "./qualify.js";
import { scoreRun } from "./score.js";
import { resolveSubjectRef } from "./subject-ref.js";
import { logActivity } from "../persist.js";
import { userRoot } from "../paths.js";
import { db, teamFor } from "../platform-db.js";
import { Refusal } from "../refusal.js";
import type { DimensionScoreRow, MeasureScoreRow } from "./findings-doc.js";

const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const noDb = () => text("ERROR: this deployment has no platform database, so no evaluation can be run");
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const QUALIFICATION_RANK: readonly string[] = EVAL_STATE_ENUMS.qualificationState;
const rankOf = (state: string): number => Math.max(QUALIFICATION_RANK.indexOf(state), 0);

async function pluginNameOf(p: pg.Pool, subjectVersionId: string): Promise<string | null> {
  if (!UUID_RE.test(subjectVersionId)) return null;
  const row = (await p.query<{ plugin: string; declared_version: string }>(`
    select pl.name as plugin, sv.declared_version
      from zz.eval_subject_version sv join zz.plugin pl on pl.id = sv.plugin_id
     where sv.id = $1::uuid`, [subjectVersionId])).rows[0];
  return row ? `${row.plugin}@${row.declared_version}` : null;
}

interface RunContext {
  id: string; protocol_version_id: string; subject_version_id: string;
  evidence_snapshot_id: string; observation_snapshot_id: string;
  run_status: string; protocol_version: number;
}

async function loadRunContext(p: pg.Pool, evalRunId: string): Promise<RunContext | null> {
  if (!UUID_RE.test(evalRunId)) return null;
  const row = (await p.query<RunContext>(`
    select er.id::text as id, er.protocol_version_id::text as protocol_version_id,
           er.subject_version_id::text as subject_version_id,
           er.evidence_snapshot_id::text as evidence_snapshot_id,
           es.observation_snapshot_id::text as observation_snapshot_id,
           er.run_status, pv.version as protocol_version
      from zz.eval_run er
      join zz.eval_evidence_snapshot es on es.id = er.evidence_snapshot_id
      join zz.eval_protocol_version pv on pv.id = er.protocol_version_id
     where er.id = $1::uuid`, [evalRunId])).rows[0];
  return row ?? null;
}

async function loadDimensions(p: pg.Pool, protocolVersionId: string): Promise<DimensionRow[]> {
  const dims = (await p.query<Omit<DimensionRow, "measures">>(`
    select id::text as id, key, canonical_kind, weight::float8 as weight, required, applicable,
           not_applicable_reason
      from zz.eval_dimension where protocol_version_id = $1::uuid order by key`, [protocolVersionId])).rows;
  if (!dims.length) return [];
  const measures = (await p.query<MeasureRow & { dimension_id: string }>(`
    select m.id::text as id, m.dimension_id::text as dimension_id, m.key, m.evaluator_type,
           m.weight::float8 as weight, m.required, m.definition,
           m.evaluator_version_id::text as evaluator_version_id, ev.question
      from zz.eval_measure m
      left join zz.eval_evaluator_version ev on ev.id = m.evaluator_version_id
     where m.dimension_id = any($1::uuid[]) order by m.key`,
    [dims.map((d) => d.id)])).rows;
  return dims.map((d) => ({ ...d, measures: measures.filter((m) => m.dimension_id === d.id) }));
}

async function loadSnapshotFacts(p: pg.Pool, observationSnapshotId: string): Promise<SnapshotFacts> {
  const row = (await p.query<SnapshotFacts>(`
    select usable_run_count, total_run_count, coverage, facts
      from zz.eval_observation_snapshot where id = $1::uuid`, [observationSnapshotId])).rows[0];
  return row ?? { usable_run_count: 0, total_run_count: 0, coverage: null, facts: null };
}

async function latestQualification(
  p: pg.Pool, evaluatorVersionId: string, protocolVersionId: string,
): Promise<{ id: string; state: string } | null> {
  const row = (await p.query<{ id: string; state: string }>(`
    select id::text as id, state from zz.eval_evaluator_qualification
     where evaluator_version_id = $1::uuid and protocol_version_id = $2::uuid
     order by qualified_at desc limit 1`, [evaluatorVersionId, protocolVersionId])).rows[0];
  return row ?? null;
}

interface ProtocolPolicy {
  qualification: QualificationPolicy | null; bootstrap: boolean; uncertainty: Record<string, unknown>;
  /** `improvement.criticalGuardrails`, parsed by `parseCriticalGuardrails` — the ONLY guardrail
   *  mechanism (Task I-29's own fix dispatch). Read here, alongside `qualification_policy`/
   *  `scoring_policy`, so one query and one parse serve evaluation_score. */
  criticalGuardrails: CriticalGuardrail[];
}

async function loadProtocolPolicy(p: pg.Pool, protocolVersionId: string): Promise<ProtocolPolicy> {
  const row = (await p.query<{ qualification_policy: unknown; scoring_policy: unknown; improvement_policy: unknown }>(`
    select qualification_policy, scoring_policy, improvement_policy
      from zz.eval_protocol_version where id = $1::uuid`,
    [protocolVersionId])).rows[0];
  const qual = QualificationPolicy.safeParse(row?.qualification_policy);
  const scoring = row?.scoring_policy as { establishment?: unknown; uncertainty?: unknown } | undefined;
  const establishment = EstablishmentPolicy.safeParse(scoring?.establishment ?? {});
  const improvement = row?.improvement_policy as { criticalGuardrails?: unknown } | undefined;
  return {
    qualification: qual.success ? qual.data : null,
    bootstrap: establishment.success ? establishment.data.bootstrap : false,
    uncertainty: (scoring?.uncertainty as Record<string, unknown>) ?? {},
    criticalGuardrails: parseCriticalGuardrails(improvement?.criticalGuardrails),
  };
}

/** AC-12.1 / plan I-29: whether every model-backed measure's evaluator is qualified enough to
 *  back this run's status — and, for a bootstrap protocol, whether it is allowed to establish at
 *  all, which it never is. `scoring.establishment.bootstrap = true` means this protocol has no
 *  history of its own yet to qualify evaluators against, so `evaluation_score` must treat
 *  `qualification_met` as false regardless of what any individual qualification row says — a
 *  bootstrap protocol's run can be `provisional` at best until a later, non-bootstrap protocol
 *  revision clears it (score.ts's own status rule then does the rest). */
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

export function registerEvaluationTools(server: McpServer): void {
  server.registerTool(
    "evaluation_start",
    {
      description:
        "WHEN a protocol version and an observation snapshot are ready to be scored together: " +
        "atomically binds them into one immutable zz.eval_evidence_snapshot, and opens one zz.eval_run at run_status='pending' " +
        "against it. RETURNS { eval_run_id, evidence_snapshot_id, run_status }. REFUSES an " +
        "observation_snapshot_id nothing minted; a protocol_version_id nothing minted, or one " +
        "protocol_affirm has not bound to an approved protocol.md (named, with its version); and an " +
        "observation snapshot belonging to a DIFFERENT subject than subject_version_id names — " +
        "\"ERROR: observation snapshot belongs to subject <x>, not <y>\" — never silently scoring " +
        "one plugin's evidence against another's identity. A mutator: writes through the FR-59 " +
        "idempotency ledger, so a retried call with the same idempotency_key replays the same run " +
        "rather than opening a second one.",
      inputSchema: {
        subject_version_id: z.string(), protocol_version_id: z.string(),
        observation_snapshot_id: z.string(), idempotency_key: z.string().min(1),
      },
    },
    async ({ subject_version_id, protocol_version_id, observation_snapshot_id, idempotency_key }) => {
      const p = db();
      if (!p) return noDb();
      if (!UUID_RE.test(subject_version_id)) return text("ERROR: unknown subject_version_id");

      const snapshot = (await p.query<{ id: string; subject_version_id: string; coverage: unknown }>(`
        select id::text as id, subject_version_id::text as subject_version_id, coverage
          from zz.eval_observation_snapshot where id = $1::uuid`, [observation_snapshot_id])).rows[0];
      if (!snapshot) return text("ERROR: unknown observation_snapshot_id — call plugin_profile first");
      if (snapshot.subject_version_id !== subject_version_id) {
        const [given, actual] = await Promise.all([
          pluginNameOf(p, subject_version_id), pluginNameOf(p, snapshot.subject_version_id)]);
        return text(`ERROR: observation snapshot belongs to subject ${actual ?? snapshot.subject_version_id}, ` +
                    `not ${given ?? subject_version_id}`);
      }
      const protocol = await resolveProtocol(p, protocol_version_id);
      if (!protocol) return text("ERROR: unknown protocol_version_id");
      const unaffirmed = unaffirmedRefusal(protocol_version_id, protocol);
      if (unaffirmed) return text(unaffirmed);

      const principal = parseCaller(requestHeaders()).email;
      const outcome: IdempotencyOutcome<{ eval_run_id: string; evidence_snapshot_id: string; run_status: string }> =
        await withIdempotency(
          principal, "evaluation_start", idempotency_key,
          { subject_version_id, protocol_version_id, observation_snapshot_id },
          async (client): Promise<MutatorOutcome<{ eval_run_id: string; evidence_snapshot_id: string; run_status: string }>> => {
            const digest = sha256(canonicalJson({ observation_snapshot_id, protocol_version_id }));
            const ins = await client.query<{ id: string }>(`
              insert into zz.eval_evidence_snapshot
                (observation_snapshot_id, subject_version_id, protocol_version_id,
                 coverage, content_digest, created_at)
              values ($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5, now())
              on conflict (observation_snapshot_id, protocol_version_id) do nothing
              returning id::text as id`,
              [observation_snapshot_id, subject_version_id, protocol_version_id,
               JSON.stringify(snapshot.coverage), digest]);
            let evidenceSnapshotId = ins.rows[0]?.id;
            if (!evidenceSnapshotId) {
              const sel = await client.query<{ id: string }>(`
                select id::text as id from zz.eval_evidence_snapshot
                 where observation_snapshot_id = $1::uuid and protocol_version_id = $2::uuid`,
                [observation_snapshot_id, protocol_version_id]);
              evidenceSnapshotId = sel.rows[0]?.id;
            }
            if (!evidenceSnapshotId) throw new Error("could not resolve zz.eval_evidence_snapshot id");
            const run = await client.query<{ id: string }>(`
              insert into zz.eval_run (subject_version_id, protocol_version_id, evidence_snapshot_id,
                                        run_status, coverage, created_at)
              values ($1::uuid, $2::uuid, $3::uuid, 'pending', $4::jsonb, now())
              returning id::text as id`,
              [subject_version_id, protocol_version_id, evidenceSnapshotId, JSON.stringify(snapshot.coverage)]);
            const evalRunId = run.rows[0]?.id;
            if (!evalRunId) throw new Error("insert into zz.eval_run produced no row");
            return {
              result: { eval_run_id: evalRunId, evidence_snapshot_id: evidenceSnapshotId, run_status: "pending" },
              result_table: "zz.eval_run", result_id: evalRunId,
            };
          },
        );

      let result: { eval_run_id: string; evidence_snapshot_id: string; run_status: string };
      if (outcome.replayed) {
        const row = (await p.query<{ id: string; evidence_snapshot_id: string; run_status: string }>(`
          select id::text as id, evidence_snapshot_id::text as evidence_snapshot_id, run_status
            from zz.eval_run where id = $1::uuid`, [outcome.result_id])).rows[0];
        if (!row) throw new Refusal("ERROR: idempotency ledger points at an eval_run this call cannot read back");
        result = { eval_run_id: row.id, evidence_snapshot_id: row.evidence_snapshot_id, run_status: row.run_status };
      } else {
        result = outcome.result;
      }
      logActivity(await userRoot(), null,
        { user: principal, action: "evaluation_start", eval_run_id: result.eval_run_id, replayed: outcome.replayed });
      return json(result);
    },
  );

  server.registerTool(
    "evaluation_assess",
    {
      description:
        "WHEN eval_run_id is pending or running: resolves every subject_ref to its real content — " +
        "an <initiative>/<doc>.md ref is read off the caller's own team's artifact store (one under " +
        "_knowledge/ is a knowledge node), bug:<id> from its bug report, a bare run_id (plugin_profile's " +
        "traces.run_refs) from its own zz.event rows — then routes each measure: deterministic/outcome " +
        "read a named fact off the run's bound observation snapshot ONCE per run; bounded_semantic/" +
        "generative_critic ask the measure's bound evaluator only about refs of the kind it judges " +
        "(definition.subjectKind, else its question's \"Read this run/document/bug report/record\"), " +
        "and only when that evaluator is qualified against this protocol version — otherwise one " +
        "row records the exclusion by name and no model is called; human is recorded as excluded. " +
        "RETURNS { eval_run_id, assessment_count, measures_assessed, model_calls, excluded }. " +
        "REFUSES an eval_run_id nothing " +
        "minted, an eval_run already completed/failed/cancelled, an empty subject_refs list, and " +
        "BY NAME any subject_ref that resolves to neither a real document nor a real run — a " +
        "model asked to judge nothing is never silently handed a templated sentence naming the " +
        "ref instead. A mutator: writes through the FR-59 idempotency ledger.",
      inputSchema: {
        eval_run_id: z.string(), subject_refs: z.array(z.string()).min(1),
        idempotency_key: z.string().min(1),
      },
    },
    async ({ eval_run_id, subject_refs, idempotency_key }) => {
      const p = db();
      if (!p) return noDb();
      const run = await loadRunContext(p, eval_run_id);
      if (!run) return text("ERROR: unknown eval_run_id");
      if (["completed", "failed", "cancelled"].includes(run.run_status)) {
        return text(`ERROR: eval_run ${eval_run_id} is ${run.run_status} and cannot be assessed again`);
      }

      const dims = await loadDimensions(p, run.protocol_version_id);
      const measures = dims.flatMap((d) => d.measures);
      const snapshot = await loadSnapshotFacts(p, run.observation_snapshot_id);
      const principal = parseCaller(requestHeaders()).email;

      // Resolved BEFORE withIdempotency, the same order resolveSnapshot/resolveEvaluatorVersion
      // already establish elsewhere in this door: a subject_ref that resolves to nothing refuses
      // the whole call and writes no ledger row, rather than being discovered mid-transaction
      // after some measures already ran against a real ref.
      const team = await teamFor(principal);
      const resolvedRefs = new Map<string, string>();
      for (const subjectRef of subject_refs) {
        const resolved = await resolveSubjectRef(p, team, subjectRef);
        if ("error" in resolved) return text(resolved.error);
        resolvedRefs.set(subjectRef, resolved.text);
      }

      // Every model is asked BEFORE the transaction opens (evaluate-measures.ts's module note):
      // an evaluator call can take ~100s, and a transaction held across it pins a pool
      // connection. A replay is recognised first, so a retried call never re-asks a model.
      const ledgerArgs = { eval_run_id, subject_refs };
      const prior = await decideBeforeWork(principal, "evaluation_assess", idempotency_key, ledgerArgs);
      const answered: { subjectRef: string; measure: MeasureRow; answer: AnsweredMeasure }[] = [];
      if (!prior.replayed) {
        const runLevel = runLevelRef(run.observation_snapshot_id);
        const qualification = new Map<string, { id: string; state: string } | null>();
        for (const m of measures) {
          if (m.evaluator_version_id && !qualification.has(m.evaluator_version_id)) {
            qualification.set(m.evaluator_version_id, await latestQualification(p, m.evaluator_version_id, run.protocol_version_id));
          }
        }
        const alreadyAssessed = new Set((await p.query<{ measure_id: string }>(
          `select distinct measure_id::text as measure_id from zz.eval_assessment
            where eval_run_id = $1::uuid`, [eval_run_id])).rows.map((r) => r.measure_id));
        const plan = planAssessment({
          measures, subjectRefs: subject_refs, runLevel, alreadyAssessed,
          textOf: (ref) => resolvedRefs.get(ref),
          qualified: (m) => {
            const q = m.evaluator_version_id ? qualification.get(m.evaluator_version_id) : null;
            return !!q && q.state !== "unqualified";
          },
        });
        for (const item of plan) {
          const q = item.measure.evaluator_version_id ? qualification.get(item.measure.evaluator_version_id) ?? null : null;
          const answer: AnsweredMeasure = item.ask
            ? await answerMeasure({
                measure: item.measure, snapshot, subjectRef: item.subjectRef, principal,
                subjectText: resolvedRefs.get(item.subjectRef),
                qualificationOf: async () => q,
              })
            : { ...excludedAnswer(item.excluded_reason ?? "excluded"), evaluator_version_id: item.measure.evaluator_version_id,
                qualification_id: q?.id ?? null, qualification_state: q?.state ?? null, pending: null };
          answered.push({ subjectRef: item.subjectRef, measure: item.measure, answer });
        }
      }

      type AssessResult = { assessment_count: number; measures_assessed: number; model_calls: number;
                            excluded: { measure: string; subject_ref: string; reason: string | null }[] };
      const outcome: IdempotencyOutcome<AssessResult> = prior.replayed
        ? prior
        : await withIdempotency(
          principal, "evaluation_assess", idempotency_key, ledgerArgs,
          async (client): Promise<MutatorOutcome<AssessResult>> => {
            if (run.run_status === "pending") {
              await client.query("update zz.eval_run set run_status = 'running' where id = $1::uuid", [eval_run_id]);
            }
            for (const { subjectRef, measure, answer: pending } of answered) {
              const answer: MeasureAnswer = await recordMeasureAnswer(client, pending);
              await client.query(`
                insert into zz.eval_assessment
                  (eval_run_id, measure_id, evaluator_version_id, assessment_id, qualification_id,
                   subject_ref, evidence_ref, answer, policy_version, created_at)
                values ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6, $7, $8::jsonb, $9, now())`,
                [eval_run_id, measure.id, answer.evaluator_version_id, answer.assessment_id,
                 answer.qualification_id, subjectRef, `observation_snapshot:${run.observation_snapshot_id}`,
                 JSON.stringify(answer), String(run.protocol_version)]);
            }
            return {
              result: {
                assessment_count: answered.length, measures_assessed: measures.length,
                model_calls: answered.filter((a) => a.answer.pending !== null).length,
                excluded: answered.filter((a) => a.answer.excluded)
                  .map((a) => ({ measure: a.measure.key, subject_ref: a.subjectRef, reason: a.answer.excluded_reason })),
              },
              result_table: "zz.eval_run", result_id: eval_run_id,
            };
          },
        );

      // A replay answers from the rows this run holds — the same fields, read back, never re-asked.
      const stored = outcome.replayed
        ? (await p.query<{ key: string; subject_ref: string; answer: MeasureAnswer }>(`
            select m.key, ea.subject_ref, ea.answer from zz.eval_assessment ea
              join zz.eval_measure m on m.id = ea.measure_id
             where ea.eval_run_id = $1::uuid`, [eval_run_id])).rows
        : [];
      const response: AssessResult = outcome.replayed
        ? {
            assessment_count: stored.length, measures_assessed: measures.length,
            model_calls: stored.filter((r) => r.answer.assessment_id !== null).length,
            excluded: stored.filter((r) => r.answer.excluded)
              .map((r) => ({ measure: r.key, subject_ref: r.subject_ref, reason: r.answer.excluded_reason })),
          }
        : outcome.result;
      logActivity(await userRoot(), null,
        { user: principal, action: "evaluation_assess", eval_run_id, replayed: outcome.replayed });
      return json({ eval_run_id, ...response });
    },
  );

  server.registerTool(
    "evaluation_score",
    {
      description:
        "WHEN evaluation_assess has run against every subject_ref this evaluation needs: reduces " +
        "the stored zz.eval_assessment rows measure by measure and calls the pure scoreRun once " +
        "for the run's own dimension_scores and once per resample of its subjects for a percentile " +
        "bootstrap interval of that same overall. A dimension scores from whichever of its measures were scored and reports its " +
        "coverage (scored weight over declared weight); overall is null only when nothing scored, " +
        "and the status reads the coverage. Computes coverage_met from the protocol's own EstablishmentPolicy.minCoverage " +
        "and qualification_met from every model-backed measure's evaluator qualification against " +
        "QualificationPolicy.boundedSemanticMinimum — a bootstrap protocol " +
        "(scoring.establishment.bootstrap=true) forces qualification_met=false regardless (plan " +
        "I-29). RETURNS { overall_score, score_status, establishment_blocked_by (every reason it is not established), score_coverage, score_interval, dimension_scores, " +
        "guardrail_status, coverage, readings } — readings is every stored answer, per measure key, " +
        "per subject_ref, with its assessment_id, which is what a finding cites — and stores the " +
        "score on zz.eval_run, moving run_status to " +
        "'completed'. REFUSES an eval_run_id nothing minted and a run with no assessment recorded " +
        "against it. A mutator: writes through the FR-59 idempotency ledger.",
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
      const run = await loadRunContext(p, eval_run_id);
      if (!run) return text("ERROR: unknown eval_run_id");

      const dims = await loadDimensions(p, run.protocol_version_id);
      const measures = dims.flatMap((d) => d.measures);
      const assessed = (await p.query<{ n: string }>(
        "select count(*)::text as n from zz.eval_assessment where eval_run_id = $1::uuid", [eval_run_id])).rows[0];
      if (Number(assessed?.n ?? 0) === 0) {
        return text(`ERROR: eval_run ${eval_run_id} has no assessment recorded — call evaluation_assess first`);
      }

      const rows = (await p.query<{ measure_id: string; subject_ref: string; answer: MeasureAnswer }>(
        "select measure_id::text as measure_id, subject_ref, answer from zz.eval_assessment where eval_run_id = $1::uuid",
        [eval_run_id])).rows;
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
      const criticalKeys = new Set(policy.criticalGuardrails.map((g) => g.key));

      // The doc-friendly per-measure detail findings.md reads back (Task I-13's own generator,
      // findings-doc.ts) — denominators and guardrail flags scoreRun's own output does not carry.
      // `guardrail` is now membership in the protocol's OWN `improvement.criticalGuardrails`
      // (Task I-29's own fix dispatch) rather than a per-measure `definition.guardrail` flag —
      // display only; `evaluateGuardrails` below is what actually decides pass/fail/not_established.
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

      // Task I-29's own second fix: the protocol's own improvement.criticalGuardrails, evaluated
      // against each measure's already-reduced [0,1] value — keyed by measure KEY (a guardrail
      // names a key, not a row id), one entry per measure this run actually has an id for.
      const valueByMeasureKey = new Map<string, number | null>(measures.map((m) => [m.key, overallDetail.get(m.id)!.value]));
      const guardrailResults = evaluateGuardrails(policy.criticalGuardrails, valueByMeasureKey);
      const guardrails = guardrailResults.map((g) => g.status);

      const scored = scoreRun({ dimensions: scoreInputDimensions, coverage_met, qualification_met, guardrails });

      const dimension_scores: DimensionScoreRow[] = dims.map((d) => {
        const outScore = scored.dimensions.find((s) => s.key === d.key);
        const measuresRows = d.measures.map((m) => overallDetail.get(m.id)!);
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

      const principal = parseCaller(requestHeaders()).email;
      const outcome: IdempotencyOutcome<{ id: string }> = await withIdempotency(
        principal, "evaluation_score", idempotency_key, { eval_run_id },
        async (client): Promise<MutatorOutcome<{ id: string }>> => {
          await client.query(`
            update zz.eval_run
               set run_status = 'completed', score_status = $2, overall_score = $3,
                   score_interval = $4::jsonb, dimension_scores = $5::jsonb, guardrail_status = $6,
                   guardrails = $7::jsonb,
                   coverage = coalesce(coverage, '{}'::jsonb) || $8::jsonb
             where id = $1::uuid`,
            [eval_run_id, scored.status, scored.overall, JSON.stringify(score_interval),
             JSON.stringify(dimension_scores), scored.guardrail_status, JSON.stringify(guardrailResults),
             JSON.stringify({ measures: scored.coverage, measures_floor: scored.coverage_floor, establishment_blocked_by })]);
          return { result: { id: eval_run_id }, result_table: "zz.eval_run", result_id: eval_run_id };
        },
      );

      logActivity(await userRoot(), null, {
        user: principal, action: "evaluation_score", eval_run_id, score_status: scored.status,
        overall_score: scored.overall, replayed: outcome.replayed,
      });
      const coverage = (await p.query<{ coverage: unknown }>(
        "select coverage from zz.eval_run where id = $1::uuid", [eval_run_id])).rows[0]?.coverage ?? null;
      const recorded = await recordStage(initiative, "zz-plugin-evaluate", { eval_run_id });
      return json({
        eval_run_id, overall_score: scored.overall, score_status: scored.status, establishment_blocked_by,
        score_coverage: scored.coverage, coverage_floor: scored.coverage_floor,
        score_interval, dimension_scores, guardrail_status: scored.guardrail_status, coverage, readings, ...recorded,
      });
    },
  );
}
