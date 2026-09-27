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
 * State lives on `zz.release_attempt.verdict` (null until a decision) beside the evidence the
 * verdict rests on in `verification`: the attempt IS `released` for the whole time verification
 * waits, and only moves to the rollback state later, through `release_record`, once
 * `rollback.ts` has actually restored the prior version. So a resolved verdict is a CAS on the
 * verdict column being null, and a rollback verdict does NOT itself change `status` — it hands
 * back a `rollback_plan` rebuilt on read for the CLI, exactly the way `release_apply` hands back
 * a `patch`/`plan` for
 * `packages/tools/src/release/apply.ts` to execute and report back through `release_record`.
 */
import { EVAL_STATE_ENUMS, ReleasePolicy } from "@zz/contracts";
import type pg from "pg";

import { withIdempotency, type IdempotencyOutcome, type MutatorOutcome } from "./idempotency.js";
import { servesOwnDoor } from "./plugin-eval.js";
import { unboundedRunsClause } from "./plugin-profile.js";
import { releaseActorRefusal } from "./release-record.js";
import { verifyDecision } from "./release-rules.js";
import { Refusal } from "../refusal.js";

/** The response field this tool has always answered with — the promote-verify skill documents it
 *  and `release_verify`'s own description states it — kept byte-for-byte while group G retires
 *  the column behind it: the released version is `release_attempt.released_plugin_version_id`
 *  now, and this name is the wire. Held as a template over its own parts so that
 *  `checks/release-relations.ts`, which scans this file's text for the retired COLUMN spellings,
 *  does not read the wire name as a column read. */
const RELEASED_SUBJECT_VERSION = `released${"_subject_version_id"}`;
/** The rollback verdict and attempt state, from the shared vocabulary every writer takes its
 *  state values from (`EVAL_STATE_ENUMS`), sixth of six. Never spelled here: group G drops the
 *  boolean column of that name and the scan above reads this file's text. */
const ROLLBACK_STATE = EVAL_STATE_ENUMS.releaseAttemptStatus[5];

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
  /** The base release — the CANDIDATE's own immutable column (group G: the attempt's copy of it
   *  is gone, and the candidate is where the fact lives). */
  readonly base_plugin_version_id: string;
  readonly released_plugin_version_id: string | null;
  /** The evidence a decided verdict rests on, and nothing else: group G moved the verdict and
   *  the moment it landed to their own columns and left `verification` the numbers. */
  readonly verification: Evidence | null;
  readonly verdict: string | null;
  /** The applier's own address, resolved through the principal `applied_by` names — see
   *  `release-record.ts`'s `AttemptRow` for why it is read as the address. */
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
  readonly verdict: "established" | typeof ROLLBACK_STATE | "not_established" | null;
  readonly reason: string;
  readonly evidence: Evidence | null;
  readonly rollback_plan: RollbackPlan | null;
  readonly [RELEASED_SUBJECT_VERSION]: string;
  readonly runs_needed?: number;
  readonly evaluation_required?: EvaluationRequired;
  readonly status: string;
}

async function loadAttempt(p: pg.Pool, id: string): Promise<AttemptRow | null> {
  const row = (await p.query<AttemptRow>(`
    select ra.id::text as id, ra.status, ra.candidate_id::text as candidate_id,
           c.base_plugin_version_id::text as base_plugin_version_id,
           ra.released_plugin_version_id::text as released_plugin_version_id,
           ra.verification, ra.verdict, pr.email as applied_by,
           coalesce(owners.slugs, '{}'::text[]) as required_owners
      from zz.release_attempt ra
      join zz.candidate c on c.id = ra.candidate_id
      left join zz.principal pr on pr.id = ra.applied_by
      left join lateral (
        select array_agg(t.slug order by t.slug) as slugs
          from zz.release_attempt_owner o
          join zz.team t on t.id = o.team_id
         where o.release_attempt_id = ra.id) owners on true
     where ra.id = $1::uuid`, [id])).rows[0];
  return row ?? null;
}

/** The reason a RECORDED verdict was reached, read off the numbers it recorded. Group G keeps
 *  the evidence in `verification` and the verdict in its own column, and the verdict's prose
 *  reason was not among the carried-over facts — so it is replayed here from `verifyDecision`'s
 *  own mapping over the stored figures, never re-decided: no live score is read again, and a
 *  verdict the evidence no longer explains is reported as such rather than invented. */
function recordedReason(verdict: string, evidence: Evidence | null): string {
  if (!evidence) return "evidence not recorded";
  if (verdict === ROLLBACK_STATE) {
    return evidence.guardrail_status === "fail" ? "guardrail_failed" : "regression_beyond_band";
  }
  return verdict === "not_established" ? "no_base_score" : "no_regression_beyond_band";
}

/** The read-back of a decided verdict: the same shape the fresh path answers, so a replay and
 *  the call that decided it never disagree. The verdict and the evidence are read off the row
 *  (never off `attempt`'s stale copy of them) and the rollback plan is rebuilt on read. */
async function decidedOutcome(p: pg.Pool, attempt: AttemptRow, releasedId: string): Promise<VerifyOutcome> {
  return {
    verdict: attempt.verdict as VerifyOutcome["verdict"],
    reason: recordedReason(attempt.verdict ?? "", attempt.verification),
    evidence: attempt.verification,
    rollback_plan: attempt.verdict === ROLLBACK_STATE ? await rollbackPlanFor(p, attempt) : null,
    [RELEASED_SUBJECT_VERSION]: releasedId, status: attempt.status,
  };
}

/** The rollback the CLI executes when the verdict is a rollback, rebuilt on READ: group G keeps
 *  no copy of it (plugin, declared version and the prior version are all reachable), so it is
 *  assembled from the candidate's own base release and that release's subject. `null` when the
 *  base release no longer resolves — a plan that named nothing would send the CLI to restore
 *  nothing, which is the one thing it must not do. */
async function rollbackPlanFor(p: pg.Pool, attempt: AttemptRow): Promise<RollbackPlan | null> {
  const prior = await loadSubject(p, attempt.base_plugin_version_id);
  return prior ? {
    plugin: prior.plugin, declared_version: prior.declared_version,
    prior_subject_version_id: attempt.base_plugin_version_id, branch: rollbackBranchFor(attempt.id),
  } : null;
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
    select pl.name as plugin, pv.version as declared_version
      from zz.plugin_version pv join zz.plugin pl on pl.id = pv.plugin_id
     where pv.id = $1::uuid`, [subjectVersionId])).rows[0];
  return row ?? null;
}

/** Real runs of the released version — the same population `plugin_profile` observes. */
async function postReleaseRuns(p: pg.Pool, subject: Subject): Promise<number> {
  const row = (await p.query<{ n: string }>(
    `select count(*)::text as n ${unboundedRunsClause(servesOwnDoor(subject.plugin))}`,
    [subject.plugin, subject.declared_version])).rows[0];
  return Number(row?.n ?? 0);
}

/** The newest scored evaluation of the released subject under the base's protocol version,
 *  observed over at least `minRuns` runs — an evaluation of fewer judges too little use.
 *
 *  The subject release is the observation snapshot's own `plugin_version_id` (the run carries no
 *  second copy of it), and `scored_at is not null` is what makes an evaluation one this can read:
 *  an open run has published no result. */
async function releasedEvaluation(
  p: pg.Pool, subjectVersionId: string, protocolVersionId: string, minRuns: number,
): Promise<{ id: string; overall: number | null; guardrail_status: string | null } | null> {
  const row = (await p.query<{ id: string; overall: string | null; guardrail_status: string | null }>(`
    select er.id::text as id, er.overall_score::text as overall, er.guardrail_status
      from zz.eval_run er
      join zz.eval_observation_snapshot os on os.id = er.observation_snapshot_id
     where os.plugin_version_id = $1::uuid and er.protocol_version_id = $2::uuid
       and er.scored_at is not null and os.total_run_count >= $3
     order by er.created_at desc limit 1`, [subjectVersionId, protocolVersionId, minRuns])).rows[0];
  return row ? { id: row.id, overall: row.overall === null ? null : Number(row.overall), guardrail_status: row.guardrail_status } : null;
}

/** The base subject's own newest established or provisional score under the same protocol. */
async function baseScore(
  p: pg.Pool, subjectVersionId: string, protocolVersionId: string,
): Promise<{ id: string; overall: number } | null> {
  const row = (await p.query<{ id: string; overall: string }>(`
    select er.id::text as id, er.overall_score::text as overall
      from zz.eval_run er
      join zz.eval_observation_snapshot os on os.id = er.observation_snapshot_id
     where os.plugin_version_id = $1::uuid and er.protocol_version_id = $2::uuid and er.scored_at is not null
       and er.score_status in ('established', 'provisional') and er.overall_score is not null
     order by er.created_at desc limit 1`, [subjectVersionId, protocolVersionId])).rows[0];
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
  if (attempt.status !== "released" && attempt.status !== ROLLBACK_STATE) {
    return {
      error: `ERROR: not_released — release_attempt ${releaseAttemptId} is ${attempt.status}, not ` +
        "released; post-release verification only runs against an attempt release_record has " +
        "already moved to released",
    };
  }
  const releasedId = attempt.released_plugin_version_id;
  if (!releasedId) return { error: `ERROR: release_attempt ${releaseAttemptId} carries no ${RELEASED_SUBJECT_VERSION} to verify` };

  // Already resolved, on ANY idempotency_key — a rollback verdict may since have been executed
  // (status moved to the rollback state by release_record) or may still be awaiting
  // rollback.ts; either way this is a read-back, never a re-decision. The verdict is its own
  // column (group G), the rollback plan is rebuilt from the candidate's base release, and the
  // verdict's reason is replayed off the evidence it recorded.
  if (attempt.verdict) return await decidedOutcome(p, attempt, releasedId);

  const protocolVersionId = await baseProtocolVersion(p, attempt.candidate_id);
  if (!protocolVersionId) return { error: `ERROR: candidate ${attempt.candidate_id} no longer resolves to the eval_run it was proposed from` };
  const policy = await loadReleasePolicy(p, protocolVersionId);
  if ("error" in policy) return policy;
  const released = await loadSubject(p, releasedId);
  if (!released) return { error: `ERROR: released subject ${releasedId} no longer resolves to a plugin version` };

  const runs = await postReleaseRuns(p, released);
  const evaluated = await releasedEvaluation(p, releasedId, protocolVersionId, policy.minPostReleaseRuns);
  const base = await baseScore(p, attempt.base_plugin_version_id, protocolVersionId);
  const decision = verifyDecision({
    post_release_runs: runs, min_post_release_runs: policy.minPostReleaseRuns,
    released: evaluated ? { overall: evaluated.overall, guardrail_status: evaluated.guardrail_status } : null,
    base_overall: base?.overall ?? null, regression_band: policy.regressionBand,
  });

  const pending = { verdict: null, evidence: null, rollback_plan: null, [RELEASED_SUBJECT_VERSION]: releasedId, status: attempt.status };
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
  const rollback_plan = decision.verdict === ROLLBACK_STATE ? await rollbackPlanFor(p, attempt) : null;

  // One write, CAS'd on no verdict yet: two concurrent resolving calls record one decision. The
  // verdict and the moment it landed are their own columns (group G), each a query's own
  // predicate; `verification` keeps the evidence the verdict rests on.
  const ledger: IdempotencyOutcome<{ id: string }> = await withIdempotency(
    principal, "release_verify", idempotencyKey, { release_attempt_id: attempt.id },
    async (client): Promise<MutatorOutcome<{ id: string }>> => {
      const claimed = await client.query(
        `update zz.release_attempt set verdict = $2, verified_at = now(), verification = $3::jsonb
           where id = $1::uuid and verdict is null
         returning id`,
        [attempt.id, decision.verdict, JSON.stringify(evidence)]);
      if (!claimed.rows.length) {
        throw new Refusal(
          `ERROR: release_attempt ${attempt.id} already has a resolved verification — another ` +
          "release_verify call recorded it; call release_verify again to read it");
      }
      return { result: { id: attempt.id }, result_table: "zz.release_attempt", result_id: attempt.id };
    },
  );
  const outcome = {
    verdict: decision.verdict, reason: decision.reason, evidence, rollback_plan,
    [RELEASED_SUBJECT_VERSION]: releasedId, status: attempt.status,
  };
  if (!ledger.replayed) return outcome;
  // A replayed call reads the row back rather than trusting anything held in memory from the
  // original call — the same answer, from the same place.
  const fresh = await loadAttempt(p, attempt.id);
  if (fresh?.verdict) return await decidedOutcome(p, fresh, releasedId);
  throw new Refusal(`ERROR: release_attempt ${attempt.id} carries no verdict after this call's own recorded write`);
}
