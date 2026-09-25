/**
 * `release_verify` (Task I-24, FR-50, AC-50.1): the automatic, no-gate check a released candidate
 * crosses after `release_record` moves it to `released` — judged on REAL use, never on replays.
 * Replaying past initiatives before a release cost more tokens than the evidence was worth, so an
 * improvement is released once built, gated and approved, and this file decides afterwards
 * whether it stands.
 *
 * The evidence is the evaluation machinery EVALUATE already uses, pointed at the released
 * subject: once it has the protocol's `improvement.release.minPostReleaseRuns` real runs, the
 * agent observes them (`plugin_profile`) and evaluates them under the SAME protocol version the
 * base was scored under (`evaluation_start`/`evaluation_assess`/`evaluation_score`). This file
 * reads that evaluation back and compares it with the base subject's own newest established or
 * provisional score; the decision itself is `verifyDecision` (`release-rules.ts`), pure.
 *
 * State lives on `zz.release_attempt.verification` (null until a decision) rather than on a
 * status column: the attempt IS `released` for the whole time verification waits, and only moves
 * to `rolled_back` later, through `release_record`, once `rollback.ts` has actually restored the
 * prior version. So a resolved verdict is a CAS on `verification` carrying no verdict yet, and a
 * `rolled_back` verdict does NOT itself change `status` — it hands back a `rollback_plan` for the
 * CLI, exactly the way `release_apply` hands back a `patch`/`plan` for
 * `packages/tools/src/release/apply.ts` to execute and report back through `release_record`.
 */
import { ReleasePolicy } from "@zz/contracts";
import type pg from "pg";

import { withIdempotency, type IdempotencyOutcome, type MutatorOutcome } from "./idempotency.js";
import { servesOwnDoor } from "./plugin-eval.js";
import { unboundedRunsClause } from "./plugin-profile.js";
import { releaseActorRefusal } from "./release-record.js";
import { verifyDecision } from "./release-rules.js";
import { Refusal } from "../refusal.js";

/** The protocol version's `improvement.release`, or the refusal naming why there is none. No
 *  fallback policy: a release judged against numbers nobody agreed is judged against nothing. */
export async function loadReleasePolicy(p: pg.Pool, protocolVersionId: string): Promise<ReleasePolicy | { error: string }> {
  const row = (await p.query<{ improvement_policy: { release?: unknown } | null }>(
    "select improvement_policy from zz.eval_protocol_version where id = $1::uuid", [protocolVersionId])).rows[0];
  const parsed = ReleasePolicy.safeParse(row?.improvement_policy?.release);
  if (parsed.success) return parsed.data;
  return {
    error: `ERROR: protocol version ${protocolVersionId} carries no usable improvement.release ` +
      "({ minPostReleaseRuns, regressionBand }) — revise the protocol in DEFINE/QUALIFY; a release is " +
      `never judged against invented numbers (${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")})`,
  };
}

interface AttemptRow {
  readonly id: string;
  readonly status: string;
  readonly candidate_id: string;
  readonly base_subject_version_id: string;
  readonly released_subject_version_id: string | null;
  readonly verification: VerificationState | null;
  readonly applied_by: string | null;
  readonly required_owners: string[];
}

interface Evidence {
  readonly post_release_runs: number;
  readonly released_eval_run_id: string | null;
  readonly released_overall: number | null;
  readonly base_eval_run_id: string | null;
  readonly base_overall: number | null;
  readonly delta: number | null;
  readonly regression_band: number;
  readonly guardrail_status: string | null;
}

interface VerificationState {
  readonly verdict: "established" | "rolled_back" | "not_established";
  readonly reason: string;
  readonly evidence: Evidence;
  readonly rollback_plan: RollbackPlan | null;
}

interface RollbackPlan {
  readonly plugin: string;
  readonly declared_version: string;
  readonly prior_subject_version_id: string;
  readonly branch: string;
}

/** What to run next when the released subject has enough real runs and nobody has evaluated
 *  them yet: every argument the four calls need, so a fresh conversation needs nothing else. */
interface EvaluationRequired {
  readonly subject_version_id: string;
  readonly protocol_version_id: string;
  readonly evidence_window: { readonly last_runs: number };
  readonly steps: string;
}

export interface VerifyOutcome {
  readonly verdict: "established" | "rolled_back" | "not_established" | null;
  readonly reason: string;
  readonly evidence: Evidence | null;
  readonly rollback_plan: RollbackPlan | null;
  readonly released_subject_version_id: string;
  readonly runs_needed?: number;
  readonly evaluation_required?: EvaluationRequired;
  readonly status: string;
}

async function loadAttempt(p: pg.Pool, id: string): Promise<AttemptRow | null> {
  const row = (await p.query<AttemptRow>(`
    select id::text as id, status, candidate_id::text as candidate_id,
           base_subject_version_id::text as base_subject_version_id,
           released_subject_version_id::text as released_subject_version_id,
           verification, applied_by, required_owners
      from zz.release_attempt where id = $1::uuid`, [id])).rows[0];
  return row ?? null;
}

/** The protocol version the base was scored under — the one the candidate's own improvement run
 *  was opened from. The released subject is evaluated under the same version, or the two
 *  numbers measure different things. */
async function baseProtocolVersion(p: pg.Pool, candidateId: string): Promise<string | null> {
  const row = (await p.query<{ protocol_version_id: string }>(`
    select er.protocol_version_id::text as protocol_version_id
      from zz.candidate c
      join zz.improvement_run ir on ir.id = c.improvement_run_id
      join zz.eval_run er on er.id = ir.eval_run_id
     where c.id = $1::uuid`, [candidateId])).rows[0];
  return row?.protocol_version_id ?? null;
}

interface Subject { readonly plugin: string; readonly declared_version: string }

async function loadSubject(p: pg.Pool, subjectVersionId: string): Promise<Subject | null> {
  const row = (await p.query<Subject>(`
    select pl.name as plugin, sv.declared_version
      from zz.eval_subject_version sv join zz.plugin pl on pl.id = sv.plugin_id
     where sv.id = $1::uuid`, [subjectVersionId])).rows[0];
  return row ?? null;
}

/** Real runs of the released version — the same population `plugin_profile` observes. */
async function postReleaseRuns(p: pg.Pool, subject: Subject): Promise<number> {
  const row = (await p.query<{ n: string }>(
    `select count(*)::text as n ${unboundedRunsClause(servesOwnDoor(subject.plugin))}`,
    [subject.plugin, subject.declared_version])).rows[0];
  return Number(row?.n ?? 0);
}

/** The newest completed evaluation of the released subject under the base's protocol version,
 *  observed over at least `minRuns` runs — an evaluation of fewer judges too little use. */
async function releasedEvaluation(
  p: pg.Pool, subjectVersionId: string, protocolVersionId: string, minRuns: number,
): Promise<{ id: string; overall: number | null; guardrail_status: string | null } | null> {
  const row = (await p.query<{ id: string; overall: string | null; guardrail_status: string | null }>(`
    select er.id::text as id, er.overall_score::text as overall, er.guardrail_status
      from zz.eval_run er
      join zz.eval_evidence_snapshot es on es.id = er.evidence_snapshot_id
      join zz.eval_observation_snapshot os on os.id = es.observation_snapshot_id
     where er.subject_version_id = $1::uuid and er.protocol_version_id = $2::uuid
       and er.run_status = 'completed' and os.total_run_count >= $3
     order by er.created_at desc limit 1`, [subjectVersionId, protocolVersionId, minRuns])).rows[0];
  return row ? { id: row.id, overall: row.overall === null ? null : Number(row.overall), guardrail_status: row.guardrail_status } : null;
}

/** The base subject's own newest established or provisional score under the same protocol. */
async function baseScore(
  p: pg.Pool, subjectVersionId: string, protocolVersionId: string,
): Promise<{ id: string; overall: number } | null> {
  const row = (await p.query<{ id: string; overall: string }>(`
    select id::text as id, overall_score::text as overall
      from zz.eval_run
     where subject_version_id = $1::uuid and protocol_version_id = $2::uuid and run_status = 'completed'
       and score_status in ('established', 'provisional') and overall_score is not null
     order by created_at desc limit 1`, [subjectVersionId, protocolVersionId])).rows[0];
  return row ? { id: row.id, overall: Number(row.overall) } : null;
}

const rollbackBranchFor = (attemptId: string): string => `release/rollback-${attemptId}`;

const EVALUATION_STEPS =
  "Observe and evaluate the released subject's real runs, WITHOUT `initiative` on any of these four " +
  "calls (it would overwrite this initiative's own OBSERVE/EVALUATE records): " +
  "plugin_profile(subject_version_id, evidence_window) → evaluation_start(subject_version_id, " +
  "protocol_version_id, observation_snapshot_id) → evaluation_assess(eval_run_id, subject_refs: the run " +
  "ids and documents the snapshot's traces name, chosen as EVALUATE's skill says) → " +
  "evaluation_score(eval_run_id). Then call release_verify again.";

export async function verifyRelease(
  p: pg.Pool, releaseAttemptId: string, idempotencyKey: string, principal: string,
): Promise<VerifyOutcome | { error: string }> {
  const attempt = await loadAttempt(p, releaseAttemptId);
  if (!attempt) return { error: `ERROR: no release_attempt ${releaseAttemptId}` };
  // Only the principal who applied the attempt or an owner-team member may decide its fate.
  const refused = await releaseActorRefusal(p, attempt, principal);
  if (refused) return { error: refused };
  if (attempt.status !== "released" && attempt.status !== "rolled_back") {
    return {
      error: `ERROR: not_released — release_attempt ${releaseAttemptId} is ${attempt.status}, not ` +
        "released; post-release verification only runs against an attempt release_record has " +
        "already moved to released",
    };
  }
  const releasedId = attempt.released_subject_version_id;
  if (!releasedId) return { error: `ERROR: release_attempt ${releaseAttemptId} carries no released_subject_version_id to verify` };

  // Already resolved, on ANY idempotency_key — a rolled_back verdict may since have been
  // executed (status moved to rolled_back by release_record) or may still be awaiting
  // rollback.ts; either way this is a read-back, never a re-decision.
  if (attempt.verification?.verdict) {
    const v = attempt.verification;
    return { verdict: v.verdict, reason: v.reason, evidence: v.evidence, rollback_plan: v.rollback_plan,
      released_subject_version_id: releasedId, status: attempt.status };
  }

  const protocolVersionId = await baseProtocolVersion(p, attempt.candidate_id);
  if (!protocolVersionId) return { error: `ERROR: candidate ${attempt.candidate_id} no longer resolves to the eval_run it was proposed from` };
  const policy = await loadReleasePolicy(p, protocolVersionId);
  if ("error" in policy) return policy;
  const released = await loadSubject(p, releasedId);
  if (!released) return { error: `ERROR: released subject ${releasedId} no longer resolves to a plugin version` };

  const runs = await postReleaseRuns(p, released);
  const evaluated = await releasedEvaluation(p, releasedId, protocolVersionId, policy.minPostReleaseRuns);
  const base = await baseScore(p, attempt.base_subject_version_id, protocolVersionId);
  const decision = verifyDecision({
    post_release_runs: runs, min_post_release_runs: policy.minPostReleaseRuns,
    released: evaluated ? { overall: evaluated.overall, guardrail_status: evaluated.guardrail_status } : null,
    base_overall: base?.overall ?? null, regression_band: policy.regressionBand,
  });

  const pending = { verdict: null, evidence: null, rollback_plan: null, released_subject_version_id: releasedId, status: attempt.status };
  if (decision.kind === "pending") {
    if (decision.reason === "awaiting_post_release_runs") return { ...pending, reason: decision.reason, runs_needed: decision.runs_needed };
    return {
      ...pending, reason: decision.reason,
      evaluation_required: {
        subject_version_id: releasedId, protocol_version_id: protocolVersionId,
        evidence_window: { last_runs: runs }, steps: EVALUATION_STEPS,
      },
    };
  }

  const evidence: Evidence = {
    post_release_runs: runs, released_eval_run_id: evaluated?.id ?? null, released_overall: evaluated?.overall ?? null,
    base_eval_run_id: base?.id ?? null, base_overall: base?.overall ?? null, delta: decision.delta,
    regression_band: policy.regressionBand, guardrail_status: evaluated?.guardrail_status ?? null,
  };
  let rollback_plan: RollbackPlan | null = null;
  if (decision.verdict === "rolled_back") {
    const prior = await loadSubject(p, attempt.base_subject_version_id);
    rollback_plan = prior ? {
      plugin: prior.plugin, declared_version: prior.declared_version,
      prior_subject_version_id: attempt.base_subject_version_id, branch: rollbackBranchFor(attempt.id),
    } : null;
  }
  const verification: VerificationState = { verdict: decision.verdict, reason: decision.reason, evidence, rollback_plan };

  // One write, CAS'd on no verdict yet: two concurrent resolving calls record one decision.
  const ledger: IdempotencyOutcome<{ id: string }> = await withIdempotency(
    principal, "release_verify", idempotencyKey, { release_attempt_id: attempt.id },
    async (client): Promise<MutatorOutcome<{ id: string }>> => {
      const claimed = await client.query(
        `update zz.release_attempt set verification = $2::jsonb
           where id = $1::uuid and not coalesce(verification ? 'verdict', false)
         returning id`,
        [attempt.id, JSON.stringify(verification)]);
      if (!claimed.rows.length) {
        throw new Refusal(
          `ERROR: release_attempt ${attempt.id} already has a resolved verification — another ` +
          "release_verify call recorded it; call release_verify again to read it");
      }
      return { result: { id: attempt.id }, result_table: "zz.release_attempt", result_id: attempt.id };
    },
  );
  if (ledger.replayed) {
    const fresh = await loadAttempt(p, attempt.id);
    const v = fresh?.verification ?? verification;
    return { verdict: v.verdict, reason: v.reason, evidence: v.evidence, rollback_plan: v.rollback_plan,
      released_subject_version_id: releasedId, status: fresh?.status ?? attempt.status };
  }
  return { ...verification, released_subject_version_id: releasedId, status: attempt.status };
}
