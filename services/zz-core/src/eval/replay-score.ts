/**
 * `replay_score` (Task I-19, closing the gap I-17's own worker report left open — see
 * `notes.md`'s "OPEN (I-17 -> I-18/I-19)" line): the scoring path a `zz.replay_run` never had.
 *
 * `evaluate.ts`'s `evaluation_assess`/`evaluation_score` score an `eval_run` against an
 * `zz.eval_evidence_snapshot` — a replay run has neither: it names a case, a protocol version and
 * a subject (`subject_version_id` or `candidate_id`), nothing else. So this file is not a second
 * copy of that pair; it is a THIRD path through the SAME dimension/measure/scoreRun machinery
 * (`loadDimensions`, `answerMeasure`, `reduceMeasureAnswers`, `scoreRun` — all imported, never
 * re-derived), aimed at a replay run instead of an eval_run:
 *   - `deterministic`/`outcome` measures read a NAMED fact off `zz.eval_observation_snapshot`
 *     (`evaluate-measures.ts`'s own words) — a replay case has no such snapshot, so every one of
 *     these measures is asked against an all-zero `SnapshotFacts`, which `factValue` (that same
 *     file) already answers `null`/excluded for on a zero denominator. This is not a special case
 *     bolted on here; it is `answerMeasure`'s own existing "no comparable fact" path, reached
 *     honestly because a replay case truly carries none of OBSERVE's counted facts.
 *   - `bounded_semantic`/`generative_critic` measures ask the measure's own bound evaluator, the
 *     same as for an eval_run — the one live signal a replay case DOES carry.
 *   - `human` measures are excluded, same as everywhere else.
 *
 * One call does what `evaluation_assess` + `evaluation_score` do in two: a replay run has exactly
 * one subject and is scored once, so there is no second `subject_ref` to accumulate assessments
 * across before reducing — assess-then-score in the same transaction is the natural shape here,
 * not a shortcut around the eval_run path's own two-step contract.
 *
 * `subjectRef` is derived from the run row itself (`subject_version_id ?? candidate_id`), never
 * taken as an argument: a replay run already names its one subject, and a caller-supplied
 * subjectRef could disagree with it for no reason this file could ever explain.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseCaller } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import type pg from "pg";
import { z } from "zod";

import { answerMeasure, reduceMeasureAnswers, type MeasureAnswer, type SnapshotFacts } from "./evaluate-measures.js";
import { latestQualification, loadDimensions, loadProtocolPolicy, qualificationMet } from "./evaluate.js";
import { withIdempotency, type IdempotencyOutcome, type MutatorOutcome } from "./idempotency.js";
import { scoreRun } from "./score.js";
import { logActivity } from "../persist.js";
import { userRoot } from "../paths.js";
import { db } from "../platform-db.js";

const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const noDb = () => text("ERROR: this deployment has no platform database, so no replay run can be scored");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A replay case carries none of OBSERVE's counted facts (no `zz.eval_observation_snapshot`
// exists for it) — every `deterministic`/`outcome` measure is asked against this and answers
// excluded through `answerMeasure`'s own zero-denominator path, never a second exclusion rule
// written here.
const NO_SNAPSHOT: SnapshotFacts = { usable_run_count: 0, total_run_count: 0, coverage: null };

interface RunRow {
  id: string; status: string; protocol_version_id: string; protocol_version: number;
  subject_version_id: string | null; candidate_id: string | null;
}

async function loadRun(p: pg.Pool, replayRunId: string): Promise<RunRow | null> {
  if (!UUID_RE.test(replayRunId)) return null;
  const row = (await p.query<RunRow>(`
    select r.id::text as id, r.status, r.protocol_version_id::text as protocol_version_id,
           pv.version as protocol_version,
           r.subject_version_id::text as subject_version_id, r.candidate_id::text as candidate_id
      from zz.replay_run r
      join zz.eval_protocol_version pv on pv.id = r.protocol_version_id
     where r.id = $1::uuid`, [replayRunId])).rows[0];
  return row ?? null;
}

interface ReplayScoreResult {
  replay_run_id: string; assessment_count: number; overall: number | null;
  status: "established" | "provisional" | "not_established";
  guardrail_status: "pass" | "fail" | "not_established";
}

export function registerReplayScoreTools(server: McpServer): void {
  server.registerTool(
    "replay_score",
    {
      description:
        "WHEN a replay run's case has finished and its result needs an overall number the same " +
        "way EVALUATE scores an eval_run: runs every measure of every dimension in the run's own " +
        "protocol version against its one subject (subject_version_id or candidate_id, whichever " +
        "the run names), writes one zz.eval_assessment row per measure with replay_run_id set " +
        "(never eval_run_id), reduces them with the same scoreRun this platform scores an " +
        "eval_run with, and stores the result on zz.replay_run.score/guardrails. RETURNS " +
        "{ replay_run_id, assessment_count, overall, status, guardrail_status }. A deterministic/" +
        "outcome measure always excludes here — a replay case carries no observation snapshot for " +
        "it to read a fact off. REFUSES an unknown replay_run_id and a deployment with no " +
        "platform database. A mutator: writes through the FR-59 idempotency ledger, so a retried " +
        "call with the same idempotency_key replays the same score rather than re-asking every " +
        "model-backed measure a second time.",
      inputSchema: { replay_run_id: z.string(), idempotency_key: z.string().min(1) },
    },
    async ({ replay_run_id, idempotency_key }) => {
      const p = db();
      if (!p) return noDb();

      const run = await loadRun(p, replay_run_id);
      if (!run) return text(`ERROR: unknown replay_run_id ${replay_run_id}`);
      const subjectRef = run.subject_version_id ?? run.candidate_id;
      if (!subjectRef) {
        return text(`ERROR: replay_run ${replay_run_id} names neither a subject_version_id nor a candidate_id`);
      }

      const dims = await loadDimensions(p, run.protocol_version_id);
      const measures = dims.flatMap((d) => d.measures);
      const policy = await loadProtocolPolicy(p, run.protocol_version_id);
      const principal = parseCaller(requestHeaders()).email;

      const outcome: IdempotencyOutcome<ReplayScoreResult> = await withIdempotency(
        principal, "replay_score", idempotency_key, { replay_run_id },
        async (client): Promise<MutatorOutcome<ReplayScoreResult>> => {
          const answers: MeasureAnswer[] = [];
          for (const measure of measures) {
            const answer = await answerMeasure({
              measure, snapshot: NO_SNAPSHOT, subjectRef, principal,
              // `p`, never `client`: a qualification lookup reads committed state, the same pool
              // `latestQualification` already takes everywhere else it is called from.
              qualificationOf: (evId) => latestQualification(p, evId, run.protocol_version_id),
            });
            answers.push(answer);
            await client.query(`
              insert into zz.eval_assessment
                (replay_run_id, measure_id, evaluator_version_id, assessment_id, qualification_id,
                 subject_ref, evidence_ref, answer, policy_version, created_at)
              values ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6, $7, $8::jsonb, $9, now())`,
              [replay_run_id, measure.id, answer.evaluator_version_id, answer.assessment_id,
               answer.qualification_id, subjectRef, `replay_run:${replay_run_id}`,
               JSON.stringify(answer), String(run.protocol_version)]);
          }

          const byMeasure = new Map(measures.map((m, i) => [m.id, [answers[i]]]));
          const scoreInputDimensions = dims.map((d) => ({
            key: d.key, canonical_kind: d.canonical_kind, weight: d.weight, required: d.required,
            applicable: d.applicable, not_applicable_reason: d.not_applicable_reason,
            measures: d.measures.map((m) => ({
              weight: m.weight, required: m.required,
              value: reduceMeasureAnswers(byMeasure.get(m.id) ?? []),
            })),
          }));
          const guardrails = measures
            .map((m, i) => ({ m, a: answers[i] }))
            .filter(({ m }) => Boolean((m.definition as { guardrail?: unknown }).guardrail))
            .map(({ a }): "pass" | "fail" | "not_established" =>
              a.excluded || a.value === null ? "not_established" : a.value >= 0.5 ? "pass" : "fail");

          // No `zz.eval_observation_snapshot`/minCoverage concept applies to a single replay
          // case (DELIBERATE — one case is one case, not a coverage window to floor), so
          // `coverage_met` is trivially true; `qualification_met` still reads the SAME
          // evaluator-qualification policy an eval_run reads, because an unqualified evaluator's
          // answer is exactly as uninformative here as it is there.
          const qualification_met = await qualificationMet(p, dims, run.protocol_version_id, policy);
          const scored = scoreRun({
            dimensions: scoreInputDimensions, coverage_met: true, qualification_met, guardrails,
          });

          await client.query(
            "update zz.replay_run set score = $2::jsonb, guardrails = $3::jsonb where id = $1::uuid",
            [replay_run_id, JSON.stringify(scored), JSON.stringify(guardrails)]);

          const result: ReplayScoreResult = {
            replay_run_id, assessment_count: answers.length, overall: scored.overall,
            status: scored.status, guardrail_status: scored.guardrail_status,
          };
          return { result, result_table: "zz.replay_run", result_id: replay_run_id };
        },
      );

      let result: ReplayScoreResult;
      if (outcome.replayed) {
        const row = (await p.query<{ score: { overall: number | null; status: ReplayScoreResult["status"]; guardrail_status: ReplayScoreResult["guardrail_status"] } | null }>(
          "select score from zz.replay_run where id = $1::uuid", [outcome.result_id])).rows[0];
        const n = (await p.query<{ n: string }>(
          "select count(*)::text as n from zz.eval_assessment where replay_run_id = $1::uuid", [outcome.result_id]
        )).rows[0];
        result = {
          replay_run_id: outcome.result_id, assessment_count: Number(n?.n ?? 0),
          overall: row?.score?.overall ?? null, status: row?.score?.status ?? "not_established",
          guardrail_status: row?.score?.guardrail_status ?? "not_established",
        };
      } else {
        result = outcome.result;
      }

      logActivity(await userRoot(), null, {
        user: principal, action: "replay_score", replay_run_id, overall: result.overall, replayed: outcome.replayed,
      });
      return json(result);
    },
  );
}
