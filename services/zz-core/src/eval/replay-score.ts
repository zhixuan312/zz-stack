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
 *     these measures is asked against `NO_SNAPSHOT` (`facts: null`), which `deterministicAnswer`
 *     (that same file) already answers excluded for. This is not a special case bolted on here; it
 *     is `answerMeasure`'s own existing "this snapshot carries no facts" path, reached honestly
 *     because a replay case truly carries none of OBSERVE's counted facts. A critical guardrail
 *     bound to one of these measures therefore reads `not_established` on every replay run —
 *     `candidate_prove`/`release_verify` (Task I-29's own fix dispatch) treat that as missing
 *     evidence, never as a failure.
 *   - `bounded_semantic`/`generative_critic` measures ask the measure's own bound evaluator — but,
 *     as of this fix, against what the replay ACTUALLY PRODUCED, never a templated sentence
 *     naming an id. See the fix note below.
 *   - `human` measures are excluded, same as everywhere else.
 *
 * FIX (initiative 2026-09-24-plugin-eval-next-version, dispatch on I-17/I-19): a replay's score
 * never measured the replay. `launch.ts` ran a candidate session end to end and threw away what
 * it produced; this file asked every model-backed measure to judge
 * `Measure "<key>" against subject_ref "<id>"` — a sentence with no content in it at all, so two
 * sessions that produced entirely different output scored identically (both excluded, or both the
 * same evaluator answer on the same empty prompt). `replay_close`'s own `result.produced`
 * (migration 002's `zz.replay_run.produced`) is now the launcher's bounded, redacted record of
 * what the session actually wrote — its final transcript and the artifacts it left in its
 * worktree — and `producedSubjectText` below is what turns that into the text a model-backed
 * measure is asked to judge, with the case's own `evaluation_oracle` events passed alongside it
 * as `context` (the "judged against" half the contract names). A run with no `produced` on it yet
 * REFUSES rather than scoring an empty subject as if it meant something.
 *
 * One call does what `evaluation_assess` + `evaluation_score` do in two: a replay run has exactly
 * one subject and is scored once, so there is no second `subject_ref` to accumulate assessments
 * across before reducing. Every measure is ASKED before the transaction opens and RECORDED inside
 * it (evaluate-measures.ts's module note) — the assessment rows commit with the score or not at
 * all, and no model call holds a pool connection.
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

import {
  answerMeasure, evaluateGuardrails, recordMeasureAnswer, reduceMeasureAnswers,
  type AnsweredMeasure, type MeasureAnswer, type SnapshotFacts,
} from "./evaluate-measures.js";
import { latestQualification, loadDimensions, loadProtocolPolicy, qualificationMet } from "./evaluate.js";
import {
  decideBeforeWork, withIdempotency, type IdempotencyOutcome, type MutatorOutcome,
} from "./idempotency.js";
import { candidateCredentialRefusal } from "./replay-close.js";
import { visibleEvents } from "./replay-cases.js";
import { scoreRun } from "./score.js";
import { logActivity } from "../persist.js";
import { userRoot } from "../paths.js";
import { db } from "../platform-db.js";

const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const noDb = () => text("ERROR: this deployment has no platform database, so no replay run can be scored");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] : v) ?? "";

// A replay case carries none of OBSERVE's counted facts (no `zz.eval_observation_snapshot`
// exists for it) — every `deterministic`/`outcome` measure is asked against this and answers
// excluded through `answerMeasure`'s own zero-denominator path, never a second exclusion rule
// written here.
const NO_SNAPSHOT: SnapshotFacts = { usable_run_count: 0, total_run_count: 0, coverage: null, facts: null };

/** `zz.replay_run.produced` (migration 002), exactly as `replay_close`'s own `result.produced`
 *  schema and the launcher that fills it (`packages/tools/src/replay/launch.ts`) agree on it. */
export interface ProducedRecord {
  readonly transcript: string;
  readonly artifacts: readonly { readonly path: string; readonly sha256: string; readonly bytes: number; readonly head: string }[];
}

interface RunRow {
  id: string; status: string; case_id: string; protocol_version_id: string; protocol_version: number;
  subject_version_id: string | null; candidate_id: string | null; produced: ProducedRecord | null;
  team_slug: string; split: string | null;
}

async function loadRun(p: pg.Pool, replayRunId: string): Promise<RunRow | null> {
  if (!UUID_RE.test(replayRunId)) return null;
  const row = (await p.query<RunRow>(`
    select r.id::text as id, r.status, r.case_id::text as case_id,
           r.protocol_version_id::text as protocol_version_id, pv.version as protocol_version,
           r.subject_version_id::text as subject_version_id, r.candidate_id::text as candidate_id,
           r.produced, r.team_slug, c.split
      from zz.replay_run r
      join zz.eval_protocol_version pv on pv.id = r.protocol_version_id
      left join zz.replay_case c on c.id = r.case_id
     where r.id = $1::uuid`, [replayRunId])).rows[0];
  return row ?? null;
}

/** What a model-backed measure is actually asked to judge — pure over `produced`, so a check can
 *  assert two different produced records render two different subject texts without a database
 *  or a model in front of it. Never truncated further here: `launch.ts` is what bounds `head` and
 *  the artifact count before this ever sees them. */
export function producedSubjectText(produced: ProducedRecord): string {
  const artifactBlock = produced.artifacts.length
    ? produced.artifacts
        .map((a) => `- ${a.path} (${a.bytes} bytes, sha256 ${a.sha256}):\n${a.head}`)
        .join("\n\n")
    : "(the session wrote no files to its worktree)";
  return `TRANSCRIPT (the session's own final reply):\n${produced.transcript}\n\n` +
    `ARTIFACTS (files it wrote in its worktree):\n${artifactBlock}`;
}

interface OracleEvent { readonly seq: number; readonly actor: string; readonly visibility: string; readonly kind: string; readonly payload: unknown }

/** The case's own `evaluation_oracle` events — what a model-backed measure judges `produced`
 *  against — read through `visibleEvents`'s `evaluator` role (the same gate the launcher's own
 *  verifier-role read goes through) and narrowed further to `evaluation_oracle` alone: `actor`/
 *  `user_oracle` events describe the conversation that produced the output, not what "correct"
 *  looks like, and folding them into `context` would blur the two. `undefined` when a case
 *  carries none, so `askEvaluator` is asked with no CONTEXT section rather than an empty one. */
function oracleContext(events: readonly OracleEvent[]): string | undefined {
  const oracle = events.filter((e) => e.visibility === "evaluation_oracle");
  if (!oracle.length) return undefined;
  return oracle.map((e) => `[seq ${e.seq}] ${e.actor} — ${e.kind}: ${JSON.stringify(e.payload)}`).join("\n");
}

interface ReplayScoreResult {
  replay_run_id: string; assessment_count: number; overall: number | null;
  status: "established" | "provisional" | "not_established";
  guardrail_status: "pass" | "fail" | "not_established";
}

/** What a proof-split run's scoring answers instead (FR-28, FR-30): the score is stored on the
 *  run for `candidate_prove` to reduce server-side, and never handed back to whoever called — the
 *  launcher holds the same principal's credential the search agent does, and its log is read by
 *  that agent. A per-case proof number in a response is exactly the proof result search must
 *  never see. */
interface SealedScoreResult { replay_run_id: string; assessment_count: number; scored: true; sealed: true }

function sealIfProof(split: string | null, r: ReplayScoreResult): ReplayScoreResult | SealedScoreResult {
  return split === "proof"
    ? { replay_run_id: r.replay_run_id, assessment_count: r.assessment_count, scored: true, sealed: true }
    : r;
}

/** The tool's own orchestrator, extracted so a check can call it directly against a live pool —
 *  `requestHeaders()` (an HTTP request context) stays in the tool wrapper below; everything this
 *  function needs travels as an argument. */
export async function scoreReplay(
  p: pg.Pool, replayRunId: string, idempotencyKey: string, principal: string, patTeam: string | null = null,
): Promise<ReplayScoreResult | SealedScoreResult | { error: string }> {
  const run = await loadRun(p, replayRunId);
  if (!run) return { error: `ERROR: unknown replay_run_id ${replayRunId}` };
  // The candidate session holds a PAT for this same door, bound to the run's own replay team:
  // left open, it could score its own run. Same rule replay_begin/replay_close apply.
  const credentialErr = candidateCredentialRefusal("replay_score", patTeam, run.team_slug);
  if (credentialErr) return { error: credentialErr };
  const subjectRef = run.subject_version_id ?? run.candidate_id;
  if (!subjectRef) {
    return { error: `ERROR: replay_run ${replayRunId} names neither a subject_version_id nor a candidate_id` };
  }
  // FIX: scoring nothing is not a score. A run whose session never ran, or whose launcher never
  // reached replay_close's own result.produced, has no content a model-backed measure could ever
  // judge — refusing here, by name, is what stops that from silently landing as "every measure
  // excluded, overall: null" indistinguishable from a real, judged run that happened to score
  // nothing (fix 2, candidate-validate.ts, is what gives THAT case its own named reason too).
  if (!run.produced) {
    return {
      error: `ERROR: replay_run ${replayRunId} carries no produced output to score — call ` +
        "replay_close with result.produced (the launcher's own transcript/artifacts record) first",
    };
  }

  const prior = await decideBeforeWork(principal, "replay_score", idempotencyKey, { replay_run_id: replayRunId });
  if (prior.replayed) return sealIfProof(run.split, await readBack(p, prior.result_id));

  const subjectText = producedSubjectText(run.produced);
  const rawEvents = (await p.query<OracleEvent>(
    `select seq, actor, visibility, kind, payload from zz.replay_event where case_id = $1::uuid order by seq`,
    [run.case_id])).rows;
  const context = oracleContext(visibleEvents(rawEvents, "evaluator"));

  const dims = await loadDimensions(p, run.protocol_version_id);
  const measures = dims.flatMap((d) => d.measures);
  const policy = await loadProtocolPolicy(p, run.protocol_version_id);

  // Every model is asked before the transaction opens (evaluate-measures.ts's module note), and
  // the qualification lookups with them — nothing inside `fn` below touches the pool.
  const asked: AnsweredMeasure[] = [];
  for (const measure of measures) {
    asked.push(await answerMeasure({
      measure, snapshot: NO_SNAPSHOT, subjectRef, principal, subjectText, context,
      qualificationOf: (evId) => latestQualification(p, evId, run.protocol_version_id),
    }));
  }
  // No `zz.eval_observation_snapshot`/minCoverage concept applies to a single replay case
  // (DELIBERATE — one case is one case, not a coverage window to floor), so `coverage_met` is
  // trivially true; `qualification_met` still reads the SAME evaluator-qualification policy an
  // eval_run reads, because an unqualified evaluator's answer is exactly as uninformative here.
  const qualification_met = await qualificationMet(p, dims, run.protocol_version_id, policy);

  const outcome: IdempotencyOutcome<ReplayScoreResult> = await withIdempotency(
    principal, "replay_score", idempotencyKey, { replay_run_id: replayRunId },
    async (client): Promise<MutatorOutcome<ReplayScoreResult>> => {
      const answers: MeasureAnswer[] = [];
      for (const [i, measure] of measures.entries()) {
        const answer = await recordMeasureAnswer(client, asked[i]);
        answers.push(answer);
        await client.query(`
          insert into zz.eval_assessment
            (replay_run_id, measure_id, evaluator_version_id, assessment_id, qualification_id,
             subject_ref, evidence_ref, answer, policy_version, created_at)
          values ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6, $7, $8::jsonb, $9, now())`,
          [replayRunId, measure.id, answer.evaluator_version_id, answer.assessment_id,
           answer.qualification_id, subjectRef, `replay_run:${replayRunId}`,
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
      // Task I-29's own second fix: the protocol's own improvement.criticalGuardrails, evaluated
      // against each measure's already-reduced value — the SAME function evaluation_score calls,
      // over this run's single-subject answers rather than a multi-subject reduction.
      const valueByMeasureKey = new Map<string, number | null>(
        measures.map((m, i) => [m.key, reduceMeasureAnswers([answers[i]])]));
      const guardrailResults = evaluateGuardrails(policy.criticalGuardrails, valueByMeasureKey);
      const guardrails = guardrailResults.map((g) => g.status);
      const scored = scoreRun({
        dimensions: scoreInputDimensions, coverage_met: true, qualification_met, guardrails,
      });

      // `guardrails` stores the RICH array (`GuardrailResult[]`, not the bare status strings
      // `scoreRun` takes) — `summariseGuardrails` (candidate-validate.ts) reads `.status` off each
      // entry, the same shape `evaluation_score` now stores on `zz.eval_run.guardrails`.
      await client.query(
        "update zz.replay_run set score = $2::jsonb, guardrails = $3::jsonb where id = $1::uuid",
        [replayRunId, JSON.stringify(scored), JSON.stringify(guardrailResults)]);

      const result: ReplayScoreResult = {
        replay_run_id: replayRunId, assessment_count: answers.length, overall: scored.overall,
        status: scored.status, guardrail_status: scored.guardrail_status,
      };
      return { result, result_table: "zz.replay_run", result_id: replayRunId };
    },
  );

  return sealIfProof(run.split, outcome.replayed ? await readBack(p, outcome.result_id) : outcome.result);
}

async function readBack(p: pg.Pool, replayRunId: string): Promise<ReplayScoreResult> {
  const row = (await p.query<{ score: { overall: number | null; status: ReplayScoreResult["status"]; guardrail_status: ReplayScoreResult["guardrail_status"] } | null }>(
    "select score from zz.replay_run where id = $1::uuid", [replayRunId])).rows[0];
  const n = (await p.query<{ n: string }>(
    "select count(*)::text as n from zz.eval_assessment where replay_run_id = $1::uuid", [replayRunId]
  )).rows[0];
  return {
    replay_run_id: replayRunId, assessment_count: Number(n?.n ?? 0),
    overall: row?.score?.overall ?? null, status: row?.score?.status ?? "not_established",
    guardrail_status: row?.score?.guardrail_status ?? "not_established",
  };
}

export function registerReplayScoreTools(server: McpServer): void {
  server.registerTool(
    "replay_score",
    {
      description:
        "WHEN a replay run's case has finished and its result needs an overall number the same " +
        "way EVALUATE scores an eval_run: runs every measure of every dimension in the run's own " +
        "protocol version against what the run's own launcher recorded it produced " +
        "(zz.replay_run.produced — replay_close's own result.produced), judged against the " +
        "case's evaluation_oracle events as context, writes one zz.eval_assessment row per " +
        "measure with replay_run_id set (never eval_run_id), reduces them with the same " +
        "scoreRun this platform scores an eval_run with, and stores the result on " +
        "zz.replay_run.score/guardrails. RETURNS { replay_run_id, assessment_count, overall, " +
        "status, guardrail_status } — for a proof-split run only { replay_run_id, " +
        "assessment_count, scored: true, sealed: true }: a proof result is reduced by " +
        "candidate_prove and never handed back per case. A deterministic/outcome measure always excludes here — a " +
        "replay case carries no observation snapshot for it to read a fact off. REFUSES an " +
        "unknown replay_run_id; a credential scoped to the run's own replay team (the " +
        "candidate's); a run with no produced output yet (call replay_close with " +
        "result.produced first); and a deployment with no platform database. A mutator: writes " +
        "through the FR-59 idempotency ledger, so a retried call with the same idempotency_key " +
        "replays the same score rather than re-asking every model-backed measure a second time.",
      inputSchema: { replay_run_id: z.string(), idempotency_key: z.string().min(1) },
    },
    async ({ replay_run_id, idempotency_key }) => {
      const p = db();
      if (!p) return noDb();

      const principal = parseCaller(requestHeaders()).email;
      const patTeam = one(requestHeaders()["x-zz-pat-team"]) || null;
      const outcome = await scoreReplay(p, replay_run_id, idempotency_key, principal, patTeam);
      if ("error" in outcome) return text(outcome.error);

      logActivity(await userRoot(), null, {
        user: principal, action: "replay_score", replay_run_id,
        overall: "overall" in outcome ? outcome.overall : null, sealed: "sealed" in outcome,
      });
      return json(outcome);
    },
  );
}
