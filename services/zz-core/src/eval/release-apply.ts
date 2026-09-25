/**
 * `release_apply`'s and `release_record`'s own DB logic (Task I-23, FR-49, AC-49.1): the
 * compare-and-swap FR-49 asks for, split from `release.ts`'s registration the same way
 * `release-rules.ts` split the pure decision out of `release_prepare` (Task I-22's own module
 * note) — this file is the part that touches the database and the artifact store; `release.ts`
 * keeps only the two tools' registration and description.
 *
 * Design point, stated once, here: zz-core runs server-side in a container with no checkout of
 * the plugin's repository (worker_rules.md's own framing). Every OTHER split this initiative made
 * — replay (`replay-runs.ts` + `packages/tools/src/replay/launch.ts`) and candidate build
 * (`candidate-build.ts`, run inside `candidate_validate` itself, server-side, because THAT step
 * never leaves the platform's own checkout) — draws the same line: the server owns the decision,
 * the lock/CAS and the record; a local CLI with a shell does the git work. `release_apply`
 * follows the replay split exactly: this module decides and records, `packages/tools/src/
 * release/apply.ts` (a fresh CLI — there is no candidate/simulated-person turn to run here, just
 * "apply this diff, hash it, commit, gate, release") does the checkout work and reports back
 * through `release_record` below.
 *
 * `currentReleasedSubjectVersionId` (the "currently released subject" FR-49 compares against):
 * not a column anywhere. The SAME plugin can be released by this eval system's own
 * `release_apply` (which then owns the answer, through the release_attempt it just wrote) or,
 * before this system has ever released it once, by an ordinary platform release outside this
 * system entirely (`register-plugins.ts`, run from `scripts/release.ts`, is what really moves
 * `zz.plugin_version` for a catalog plugin). So the answer is read in that same order: this
 * system's own most recent `released` attempt for the plugin, if one exists; otherwise the
 * plugin's own catalog head — the exact (plugin, declared_version) pair `subject.ts`'s own
 * `resolveSubject` treats as "the newest release" — joined back to whichever `eval_subject_version`
 * row was captured for it. A plugin whose head version was never captured by `plugin_locate`
 * resolves to null here, which the caller turns into an explicit refusal rather than guessing a
 * stale_baseline verdict from nothing.
 *
 * Approval binding: the SAME mechanism `protocol_affirm` uses for `protocol.md` (`protocol.ts`'s
 * own module note) — read `<initiative>/improvement.md` off disk, require `status: approved` and
 * the document's body to quote the exact digest — checked against the release_attempt's OWN
 * `approved_patch_digest` (what `release_prepare` actually wrote into the document, its own
 * ground truth), never against this call's own `approved_patch_digest` ARGUMENT: checking the
 * caller's argument would make a caller who simply passes the wrong digest read as "nobody
 * approved this" (`approval_required`) rather than the more specific `digest_mismatch`
 * `releaseDecision` exists to report for exactly that case — a properly approved candidate,
 * applied with the wrong digest, has to fail on the digest check, not be misreported as
 * unapproved. The one difference from `protocol_affirm`: `required_owners` here is TEAM SLUGS
 * (`zz.plugin.release_owners`, `register-plugins.ts`'s own `[ownerTeam]`), never email addresses,
 * so an approving PERSON's `approved_by` email is resolved to the team they act for (`teamFor`,
 * `platform-db.ts` — the same function every other tool on this door uses to find whose store a
 * person writes into) before it is compared against `required_owners`. FR-48's own words are
 * "authorizes promotion for the approving ownership domain" — a person approves as themselves,
 * but what the platform checks is the domain (team) that approval speaks for.
 *
 * `release_apply` needed no `initiative` argument in the spec's own frozen interface table — the
 * same gap `release_prepare` already crossed (that file's own module note: "there is no other way
 * to locate a team-scoped document from a bare candidate_id"). Added here for the identical
 * reason: `improvement.md`'s approval has to be read from somewhere, and a bare candidate_id names
 * no path of its own.
 */
import { existsSync, readFileSync } from "node:fs";

import { documentBody, parseEnvelope } from "@zz/contracts";
import type pg from "pg";

import type { MutatorOutcome } from "./idempotency.js";
import { releaseDecision } from "./release-rules.js";
import { safeName, safePath } from "../paths.js";
import { teamFor } from "../platform-db.js";
import { Refusal } from "../refusal.js";

// The one shape every function here needs from either a pool or a client already inside a
// transaction — mirrors idempotency.ts's own `Queryable`, kept as its own copy rather than a
// shared import for the same reason that file gives: a `Pick<Pool | PoolClient, "query">` union
// is not callable, and a structural interface both satisfy is simpler than reaching across files
// for one type.
interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

// -------------------------------------------------------------------------------------------
// Reads.

interface ApplyCandidateRow {
  readonly id: string; readonly status: string; readonly base_subject_version_id: string;
  readonly patch_digest: string; readonly patchset: { diff?: string } | null;
}

async function loadCandidateForApply(runner: Queryable, candidateId: string): Promise<ApplyCandidateRow | null> {
  const row = (await runner.query<ApplyCandidateRow>(`
    select id::text as id, status, base_subject_version_id::text as base_subject_version_id,
           patch_digest, patchset
      from zz.candidate where id = $1::uuid`, [candidateId])).rows[0];
  return row ?? null;
}

interface PreparedAttempt {
  readonly id: string; readonly required_owners: string[]; readonly base_subject_version_id: string;
  readonly approved_patch_digest: string;
}

/** The newest attempt `release_prepare` left `prepared` for this candidate. `release_prepare`
 *  inserts a fresh row on every call (its own module note: a refused document write must not
 *  lose the recorded attempt, so nothing dedupes across calls), so more than one can exist for
 *  one candidate; "the newest `prepared` one" is what a caller who called `release_prepare` again
 *  — after fixing whatever made an earlier attempt un-appliable — means. */
async function loadPreparedAttempt(runner: Queryable, candidateId: string): Promise<PreparedAttempt | null> {
  const row = (await runner.query<PreparedAttempt>(`
    select id::text as id, required_owners, approved_patch_digest,
           base_subject_version_id::text as base_subject_version_id
      from zz.release_attempt
     where candidate_id = $1::uuid and status = 'prepared'
     order by created_at desc limit 1`, [candidateId])).rows[0];
  return row ?? null;
}

/** See the module note. Null means neither source has an answer. */
async function currentReleasedSubjectVersionId(runner: Queryable, pluginId: string): Promise<string | null> {
  const released = (await runner.query<{ id: string }>(`
    select ra.released_subject_version_id::text as id
      from zz.release_attempt ra
      join zz.candidate c on c.id = ra.candidate_id
      join zz.eval_subject_version sv on sv.id = c.base_subject_version_id
     where sv.plugin_id = $1::uuid and ra.status = 'released'
     order by ra.created_at desc limit 1`, [pluginId])).rows[0];
  if (released?.id) return released.id;

  // No release this eval system ever made — fall back to the catalog's own head, the same
  // (plugin, declared_version) pair subject.ts's resolveSubject treats as "the newest release",
  // joined to whichever eval_subject_version row plugin_locate already captured for it.
  const head = (await runner.query<{ id: string }>(`
    select sv.id::text as id
      from zz.plugin p
      join zz.plugin_version pv on pv.plugin_id = p.id
      join zz.eval_subject_version sv on sv.plugin_id = p.id and sv.declared_version = pv.version
     where p.id = $1::uuid
     order by pv.version desc, sv.captured_at desc
     limit 1`, [pluginId])).rows[0];
  return head?.id ?? null;
}

/** Live, not the `release_eligible` flag frozen onto the candidate's own `proof_passed` status at
 *  proof time (`release_prepare`'s own module note explains why it never reads THAT flag either):
 *  release_apply may run long after proof, so this reads the candidate's stored proof evaluation
 *  fresh rather than trusting a status byte that could have drifted. */
async function proofEligible(runner: Queryable, candidateId: string): Promise<boolean> {
  const row = (await runner.query<{ aggregate_score: { release_eligible?: boolean } }>(`
    select aggregate_score
      from zz.candidate_evaluation
     where candidate_id = $1::uuid and split = 'proof'
     order by created_at desc limit 1`, [candidateId])).rows[0];
  return !!row?.aggregate_score?.release_eligible;
}

interface ApprovalCheck { readonly approved: boolean; readonly team: string | null }

/** `protocol_affirm`'s own check (`protocol.ts`'s module note), reused for `improvement.md`:
 *  `status: approved`, and the body quotes `groundTruthDigest` — the release_attempt's OWN
 *  `approved_patch_digest`, what `release_prepare` actually wrote into the document, never this
 *  call's own `approved_patch_digest` argument (see `planApply`'s own note on why: a caller who
 *  passes the wrong digest must be told `digest_mismatch` by `releaseDecision`, not a confusing
 *  "not approved"). */
async function checkImprovementApproval(
  initiative: string, groundTruthDigest: string,
): Promise<ApprovalCheck> {
  const badInitiative = safeName(initiative, "initiative");
  if (badInitiative) throw new Refusal(badInitiative);
  const path = `${initiative}/improvement.md`;
  const target = await safePath(path);
  if (!existsSync(target)) return { approved: false, team: null };
  const raw = readFileSync(target, "utf8");
  const env = parseEnvelope(raw);
  if (env.status !== "approved") return { approved: false, team: null };
  if (!documentBody(raw).includes(groundTruthDigest)) return { approved: false, team: null };
  const approvedBy = (env.approved_by ?? "").trim();
  const team = approvedBy ? await teamFor(approvedBy) : null;
  return { approved: !!team, team };
}

// -------------------------------------------------------------------------------------------
// release_apply's own result shape, and the orchestrator withIdempotency calls into.

export interface ApplyResult {
  readonly status: "applying" | "refused";
  readonly reason: string | null;
  readonly release_attempt_id: string;
  readonly patch: { diff: string; patch_digest: string } | null;
  readonly plan: {
    plugin: string; declared_version: string; base_subject_version_id: string; branch: string;
  } | null;
}

const branchFor = (candidateId: string): string => `release/candidate-${candidateId}`;

/** Rebuilds `release_apply`'s response from the row alone — the FR-59 ledger stores only
 *  `result_table`/`result_id`, never the tool's own response body, so a REPLAYED call (and this
 *  function's own use from the fresh path too, so the two can never disagree about the shape)
 *  reads it back rather than trusting anything held in memory from the original call. A status
 *  the row has since moved past (`released`/`failed`/`rolled_back`, written by a later
 *  `release_record`) is reported as itself, not reinterpreted as `applying` — a replay answers
 *  "what is true about this attempt now", the same contract `protocol_record`'s own replay branch
 *  keeps by re-reading `content_digest` fresh rather than caching it. */
async function describeApplyOutcome(runner: Queryable, attemptId: string): Promise<ApplyResult> {
  const attempt = (await runner.query<{
    status: string; reason: string | null; candidate_id: string; base_subject_version_id: string;
  }>(`
    select status, reason, candidate_id::text as candidate_id,
           base_subject_version_id::text as base_subject_version_id
      from zz.release_attempt where id = $1::uuid`, [attemptId])).rows[0];
  if (!attempt) throw new Refusal(`ERROR: release_attempt ${attemptId} no longer exists`);

  if (attempt.status !== "applying") {
    return {
      status: attempt.status === "prepared" ? "refused" : (attempt.status as ApplyResult["status"]),
      reason: attempt.reason, release_attempt_id: attemptId, patch: null, plan: null,
    };
  }

  const candidate = await loadCandidateForApply(runner, attempt.candidate_id);
  const subject = (await runner.query<{ plugin: string; declared_version: string }>(`
    select pl.name as plugin, sv.declared_version
      from zz.eval_subject_version sv join zz.plugin pl on pl.id = sv.plugin_id
     where sv.id = $1::uuid`, [attempt.base_subject_version_id])).rows[0];

  return {
    status: "applying", reason: null, release_attempt_id: attemptId,
    patch: candidate ? { diff: candidate.patchset?.diff ?? "", patch_digest: candidate.patch_digest } : null,
    plan: subject ? {
      plugin: subject.plugin, declared_version: subject.declared_version,
      base_subject_version_id: attempt.base_subject_version_id, branch: branchFor(attempt.candidate_id),
    } : null,
  };
}

/** FR-49's own compare-and-swap. Runs inside `withIdempotency`'s own transaction (`client`, not
 *  the pool), so the advisory lock below is xact-scoped and needs no separate unlock path — it
 *  releases automatically at COMMIT or ROLLBACK, the same guarantee `pg_advisory_xact_lock`
 *  exists for.
 *
 *  Two refusal shapes: an unknown candidate_id, no `prepared` attempt to apply, an unresolvable
 *  "currently released subject", or a bad `initiative` name are reported by THROWING — nothing
 *  this call could do has a persisted outcome, so the transaction rolls back and the FR-59 ledger
 *  never records the attempt (a retry, even with the same key, re-runs from scratch, exactly the
 *  behaviour `protocol_record`'s own validation-failure throw already establishes for "this call
 *  produced nothing to remember"). `releaseDecision`'s own refuse/apply verdicts, by contrast, are
 *  RETURNED as an ordinary `MutatorOutcome` — the row write they make (or, for `apply`, the CAS)
 *  has to commit and be ledgered, so throwing here would roll back the very state change the
 *  verdict is reporting. */
export async function planApply(
  client: pg.PoolClient, candidateId: string, approvedPatchDigest: string, initiative: string,
): Promise<MutatorOutcome<ApplyResult>> {
  const candidate = await loadCandidateForApply(client, candidateId);
  if (!candidate) throw new Refusal(`ERROR: no candidate ${candidateId}`);

  const subject = (await client.query<{ plugin_id: string }>(
    "select plugin_id::text as plugin_id from zz.eval_subject_version where id = $1::uuid",
    [candidate.base_subject_version_id])).rows[0];
  if (!subject) {
    throw new Refusal(
      `ERROR: candidate ${candidateId}'s base_subject_version_id ${candidate.base_subject_version_id} ` +
      "no longer resolves to a plugin");
  }

  // Every concurrent release_apply for THIS plugin blocks here until the one ahead of it commits
  // or rolls back, so the decision below is always made against a state nothing else in flight
  // can still change out from under it. `hashtext` over a namespaced string, not the bare uuid:
  // pg_advisory_xact_lock takes a bigint key, and prefixing the namespace keeps this lock's
  // keyspace disjoint from any other advisory lock this service ever takes on a uuid-shaped
  // input, now or later.
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [`release_apply:${subject.plugin_id}`]);

  const attempt = await loadPreparedAttempt(client, candidateId);
  if (!attempt) {
    throw new Refusal(
      `ERROR: no prepared release_attempt for candidate ${candidateId} — call release_prepare ` +
      "first, or this candidate's newest attempt already left 'prepared' (applying, released, " +
      "refused or failed)");
  }

  // approval is checked against the attempt's OWN recorded approved_patch_digest — the ground
  // truth improvement.md was actually written to quote (improvement-doc.ts renders
  // candidate.patch_digest at prepare time) — never against this call's own approvedPatchDigest
  // argument. Checking the caller's argument here would make a caller who simply passes the
  // WRONG digest read as "nobody approved this" instead of the more specific digest_mismatch
  // releaseDecision exists to report: a properly approved candidate, applied with the wrong
  // digest, must fail on the digest check, not be misreported as unapproved.
  const [eligible, approval, currentSubjectId] = await Promise.all([
    proofEligible(client, candidateId),
    checkImprovementApproval(initiative, attempt.approved_patch_digest),
    currentReleasedSubjectVersionId(client, subject.plugin_id),
  ]);
  if (!currentSubjectId) {
    throw new Refusal(
      `ERROR: cannot resolve this plugin's currently released subject_version — call ` +
      "plugin_locate for its released version at least once before releasing a candidate against it");
  }

  const decision = releaseDecision({
    current_subject_id: currentSubjectId,
    base_subject_id: attempt.base_subject_version_id,
    approved_patch_digest: approvedPatchDigest,
    patch_digest: candidate.patch_digest,
    required_owners: attempt.required_owners,
    approvals: approval.approved && approval.team ? [approval.team] : [],
    proof_eligible: eligible,
  });

  if (decision.kind === "refuse") {
    // approval_required is NOT terminal — the document may still be approved later, and a fresh
    // release_apply call (a fresh idempotency_key; the same one would only ever replay this exact
    // refusal, by design — see the module note on describeApplyOutcome) must still find this
    // candidate eligible, so `status` stays 'prepared'. Every OTHER reason IS terminal:
    // digest_mismatch and stale_baseline both mean THIS candidate can never legally apply against
    // THIS base again — a rebase is a NEW candidate, never a retry of this one — and
    // no_release_owners/not_eligible were already release_prepare's own gate, recomputed here only
    // to catch drift since prepare. `reason` is written either way, terminal or not, so a REPLAY
    // of an approval_required refusal (describeApplyOutcomeForReplay, below) reads the same
    // answer a fresh call would rather than a null the row never carried.
    const terminal = decision.reason !== "approval_required";
    await client.query(
      `update zz.release_attempt set reason = $2${terminal ? ", status = 'refused'" : ""}
        where id = $1::uuid and status = 'prepared'`,
      [attempt.id, decision.reason]);
    const result = await describeApplyOutcome(client, attempt.id);
    return { result, result_table: "zz.release_attempt", result_id: attempt.id };
  }

  // apply: prepared -> applying, guarded twice over — the CAS below is what makes THIS row move
  // at most once; migration 077's own partial unique index is what makes at most one row PER
  // CANDIDATE ever sit in applying/released at once, across every prepared row release_prepare
  // ever inserted for it. The advisory lock above serializes the DECISION; the index is what still
  // catches two DIFFERENT prepared rows for the same candidate both trying to become the live one,
  // which the lock alone (scoped to one plugin, not one row) does not by itself prevent.
  let applied;
  try {
    applied = await client.query(
      "update zz.release_attempt set status = 'applying' where id = $1::uuid and status = 'prepared' returning id",
      [attempt.id]);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      throw new Refusal(
        `ERROR: release_in_progress — another attempt for candidate ${candidateId} is already ` +
        "applying or released; migration 077's own partial unique index refused this one");
    }
    throw err;
  }
  if (!applied.rows.length) {
    throw new Refusal(
      `ERROR: candidate ${candidateId}'s attempt ${attempt.id} left 'prepared' before this call ` +
      "reached it — another release_apply already won the race");
  }

  const result = await describeApplyOutcome(client, attempt.id);
  return { result, result_table: "zz.release_attempt", result_id: attempt.id };
}

/** `release_apply`'s replay path — see `describeApplyOutcome`'s own note: the ledger stores only
 *  `result_table`/`result_id`, so a replayed call is reconstructed from CURRENT row state rather
 *  than a cached response body. Exported for `release.ts`, which is the only caller: a read-only
 *  reconstruction needs no transaction, so it runs directly against the pool. */
export async function describeApplyOutcomeForReplay(pool: pg.Pool, attemptId: string): Promise<ApplyResult> {
  return describeApplyOutcome(pool, attemptId);
}

// -------------------------------------------------------------------------------------------
// release_record.

interface RecordArgs {
  readonly release_attempt_id: string;
  readonly status: "released" | "failed";
  readonly release_ref: string | null;
  readonly released_subject_version_id: string | null;
  readonly failure_tail: string | null;
}

export interface RecordResult {
  readonly status: "released" | "failed";
  readonly release_attempt_id: string;
  readonly released_subject_version_id: string | null;
  readonly release_ref: string | null;
}

/** Records the CLI's own outcome (`packages/tools/src/release/apply.ts`) once it has applied the
 *  patch, run the gate and run the repository's release procedure, or failed at one of those
 *  steps. CAS-guarded the same way `planApply`'s own apply branch is: the final UPDATE's own
 *  `where status = 'applying'` is what actually decides whether this call's write lands, the SELECT
 *  above it exists only to produce a readable refusal rather than a bare "0 rows updated". */
export async function recordRelease(client: pg.PoolClient, args: RecordArgs): Promise<MutatorOutcome<RecordResult>> {
  const attempt = (await client.query<{ id: string; candidate_id: string; base_subject_version_id: string; status: string }>(`
    select id::text as id, candidate_id::text as candidate_id,
           base_subject_version_id::text as base_subject_version_id, status
      from zz.release_attempt where id = $1::uuid`, [args.release_attempt_id])).rows[0];
  if (!attempt) throw new Refusal(`ERROR: no release_attempt ${args.release_attempt_id}`);
  if (attempt.status !== "applying") {
    throw new Refusal(
      `ERROR: not_applying — release_attempt ${args.release_attempt_id} is ${attempt.status}, not ` +
      "applying; release_record only records the outcome of a call release_apply already moved " +
      "into applying, and never overwrites an attempt already released/refused/failed");
  }

  if (args.status === "released") {
    if (!args.released_subject_version_id || !args.release_ref) {
      throw new Refusal("ERROR: status: released requires both release_ref and released_subject_version_id");
    }
    const [newSubject, baseSubject] = await Promise.all([
      client.query<{ plugin_id: string }>(
        "select plugin_id::text as plugin_id from zz.eval_subject_version where id = $1::uuid",
        [args.released_subject_version_id]),
      client.query<{ plugin_id: string }>(
        "select plugin_id::text as plugin_id from zz.eval_subject_version where id = $1::uuid",
        [attempt.base_subject_version_id]),
    ]);
    if (!newSubject.rows[0] || !baseSubject.rows[0]
        || newSubject.rows[0].plugin_id !== baseSubject.rows[0].plugin_id) {
      throw new Refusal(
        `ERROR: released_subject_version_id ${args.released_subject_version_id} does not name a ` +
        "subject version of the SAME plugin this candidate's own base subject belongs to");
    }

    const applied = await client.query(`
      update zz.release_attempt
         set status = 'released', release_ref = $2, released_subject_version_id = $3::uuid
       where id = $1::uuid and status = 'applying' returning id`,
      [attempt.id, args.release_ref, args.released_subject_version_id]);
    if (!applied.rows.length) {
      throw new Refusal(`ERROR: release_attempt ${attempt.id} left 'applying' before this call reached it`);
    }
    await client.query("update zz.candidate set status = 'released' where id = $1::uuid", [attempt.candidate_id]);

    const result: RecordResult = {
      status: "released", release_attempt_id: attempt.id,
      released_subject_version_id: args.released_subject_version_id, release_ref: args.release_ref,
    };
    return { result, result_table: "zz.release_attempt", result_id: attempt.id };
  }

  // failed — the repository is already back at its pre-apply commit by the time this is called
  // (packages/tools/src/release/apply.ts's own contract); this only records that it happened.
  if (!args.failure_tail) throw new Refusal("ERROR: status: failed requires failure_tail");
  const applied = await client.query(`
    update zz.release_attempt set status = 'failed', reason = $2
     where id = $1::uuid and status = 'applying' returning id`,
    [attempt.id, args.failure_tail]);
  if (!applied.rows.length) {
    throw new Refusal(`ERROR: release_attempt ${attempt.id} left 'applying' before this call reached it`);
  }

  const result: RecordResult = {
    status: "failed", release_attempt_id: attempt.id,
    released_subject_version_id: null, release_ref: null,
  };
  return { result, result_table: "zz.release_attempt", result_id: attempt.id };
}

/** `release_record`'s replay path — mirrors `describeApplyOutcomeForReplay`: read the row back
 *  rather than trust anything held in memory from the original call. */
export async function describeRecordOutcomeForReplay(pool: pg.Pool, attemptId: string): Promise<RecordResult> {
  const row = (await pool.query<{
    status: string; released_subject_version_id: string | null; release_ref: string | null;
  }>(`
    select status, released_subject_version_id::text as released_subject_version_id, release_ref
      from zz.release_attempt where id = $1::uuid`, [attemptId])).rows[0];
  if (!row) throw new Refusal(`ERROR: release_attempt ${attemptId} no longer exists`);
  return {
    status: row.status as RecordResult["status"], release_attempt_id: attemptId,
    released_subject_version_id: row.released_subject_version_id, release_ref: row.release_ref,
  };
}
