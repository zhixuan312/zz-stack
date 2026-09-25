/**
 * `release_apply`'s own DB logic (Task I-23, FR-49, AC-49.1): the compare-and-swap FR-49 asks
 * for, split from `release.ts`'s registration the same way `release-rules.ts` holds the pure
 * decision — this file is the part that touches the database and the artifact store.
 * `release_record`'s own half lives in `release-record.ts`.
 *
 * Design point, stated once, here: zz-core runs server-side in a container with no checkout of
 * the plugin's repository. The server owns the decision, the lock/CAS and the record; a local CLI
 * with a shell (`packages/tools/src/release/apply.ts`) does the git work — the same split the
 * candidate build (`candidate_validate` + `npm run candidate-build`) already draws — and reports
 * back through `release_record`.
 *
 * The "currently released subject" FR-49 compares against is not a column anywhere. It is the
 * head of `zz.plugin_version` ALONE — every release registers there, this eval system's own
 * (`release_record` records `released` only for a version `plugin_locate` found registered) and
 * an ordinary platform release outside it (`register-plugins`, from `plugins.lock.json`) alike —
 * the newest by semver (`newestVersion`, `release-rules.ts`, never a text sort or a SQL order),
 * leaving out every version a rollback retracted (`retractedVersions`, the same rule
 * `plugin_locate`'s head applies). DELIBERATE: never joined to `zz.eval_subject_version` to find
 * the head — a version registered at deploy that `plugin_locate` never captured was invisible to
 * that join, so a candidate based on 1.1.0 read 1.1.0 as current and shipped over 1.2.0. The
 * capture is looked up only AFTER the head is settled: a head newer than the base is
 * stale_baseline whether or not it was ever captured; a head that is not newer but has no capture
 * is refused explicitly (`plugin_locate` it first), never guessed.
 *
 * Which attempt applies: the one the approved `<initiative>/improvement.md` cites — never "the
 * newest prepared", which anybody calling `release_prepare` again could move out from under the
 * owners' approval. Only when the document cites no attempt yet does the newest prepared one
 * stand in, so its `approval_required` can still be recorded.
 *
 * Approval binding: read `<initiative>/improvement.md` off disk and require `status: approved`,
 * the body citing THIS attempt's `release_attempt_id` (and no other), and quoting the attempt's
 * OWN `approved_patch_digest` (what `release_prepare` wrote into the document), never this call's
 * own digest argument — a caller who passes the wrong digest must be told `digest_mismatch`, not
 * a confusing "not approved". The approver counts for exactly the owner teams they are a MEMBER
 * of (`release-owners.ts`), never the one team `teamFor` would resolve them to; and the caller
 * of `release_apply` itself must be a member of an owner team too.
 *
 * Exactly one applying attempt per plugin: the advisory lock serializes decisions, the check
 * after it refuses `release_in_progress` while any attempt of the plugin is applying (whichever
 * candidate), and 001's `release_attempt_applying_plugin_idx` makes the same fact a
 * database guarantee. An attempt left applying past `STALE_APPLYING_MS` has nobody left to
 * report for it; the refusal names it and the reconcile command that records what really happened.
 *
 * `release_apply` takes an `initiative` argument the spec's frozen interface table did not name:
 * `improvement.md`'s approval has to be read from somewhere, and a bare candidate_id names no path.
 */
import { existsSync, readFileSync } from "node:fs";

import { documentBody, parseEnvelope } from "@zz/contracts";
import type pg from "pg";

import type { MutatorOutcome } from "./idempotency.js";
import { retractedVersions } from "./release-retracted.js";
import { applyingRefusal, approvedOwners, compareSemver, newestVersion, releaseDecision, STALE_APPLYING_MS } from "./release-rules.js";
import { safeName, safePath } from "../paths.js";
import { Refusal } from "../refusal.js";
import { citedReleaseAttempt, memberTeams } from "../release-owners.js";

// Mirrors idempotency.ts's own `Queryable`: a `Pick<Pool | PoolClient, "query">` union is not
// callable, and a structural interface both satisfy is simpler than reaching across files.
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

/** The attempt this call applies — see the module note. `cited` is the one attempt the
 *  improvement.md body names: it must be a prepared attempt of THIS candidate, or the call is
 *  refused rather than silently applying some other row. With no citation yet, the newest
 *  prepared attempt stands in so `approval_required` is recorded against it. */
async function loadPreparedAttempt(
  runner: Queryable, candidateId: string, cited: string | null,
): Promise<PreparedAttempt | null> {
  const row = (await runner.query<PreparedAttempt>(`
    select id::text as id, required_owners, approved_patch_digest,
           base_subject_version_id::text as base_subject_version_id
      from zz.release_attempt
     where candidate_id = $1::uuid and status = 'prepared' and ($2::uuid is null or id = $2::uuid)
     order by created_at desc limit 1`, [candidateId, cited])).rows[0];
  if (!row && cited) {
    throw new Refusal(
      `ERROR: improvement.md cites release_attempt ${cited}, which is not a prepared attempt of ` +
      `candidate ${candidateId} — it belongs to another candidate or already left 'prepared'; ` +
      "nothing was applied");
  }
  return row ?? null;
}

interface ReleasedHead {
  readonly version: string;
  /** The newest capture of that version, or null when `plugin_locate` never captured it. */
  readonly subject_id: string | null;
}

/** See the module note: the head of `zz.plugin_version` alone, by semver, retracted versions left
 *  out, and only then its capture. Null when the plugin has no registered version at all. Also
 *  what `release_record(rolled_back)` asks, inside its own transaction, to confirm the prior
 *  version is current once the rolled-back one is retracted. Sequential queries: `runner` may be
 *  one PoolClient, which runs one query at a time. */
export async function currentReleasedHead(runner: Queryable, pluginId: string): Promise<ReleasedHead | null> {
  const retracted = await retractedVersions(runner, pluginId);
  const versions = (await runner.query<{ version: string }>(`
    select pv.version from zz.plugin_version pv
     where pv.plugin_id = $1::uuid and pv.version <> all($2::text[])`, [pluginId, retracted])).rows;
  const version = newestVersion(versions.map((r) => r.version));
  if (version === null) return null;
  const captured = (await runner.query<{ id: string }>(`
    select id::text as id from zz.eval_subject_version
     where plugin_id = $1::uuid and declared_version = $2
     order by captured_at desc limit 1`, [pluginId, version])).rows[0];
  return { version, subject_id: captured?.id ?? null };
}

/** The commit the base subject was released from — where the CLI's worktree starts, never the
 *  checkout's own HEAD. This system's own release of it records the commit as `release_ref`; a
 *  third-party git source records the commit it captured as `release_identity.resolved_commit`.
 *  A catalog release outside this system records neither, so null: the CLI then refuses unless
 *  its operator names the commit (`--base-ref`). */
async function baseRefFor(runner: Queryable, baseSubjectId: string): Promise<string | null> {
  const released = (await runner.query<{ release_ref: string | null }>(`
    select release_ref from zz.release_attempt
     where released_subject_version_id = $1::uuid and status = 'released' and release_ref is not null
     order by created_at desc limit 1`, [baseSubjectId])).rows[0];
  if (released?.release_ref) return released.release_ref;
  const identity = (await runner.query<{ commit: string | null }>(
    "select release_identity->>'resolved_commit' as commit from zz.eval_subject_version where id = $1::uuid",
    [baseSubjectId])).rows[0];
  return identity?.commit ?? null;
}

/** What `planApply` reads of `<initiative>/improvement.md`: its gate status, its signer and its
 *  body. A parameter of `planApply` so a check can hand it a document without a request context
 *  (`safePath` resolves the caller's team store from the request). */
interface ImprovementDoc {
  readonly status: string | undefined;
  readonly approved_by: string;
  readonly body: string;
}
type ReadImprovementDoc = (initiative: string) => Promise<ImprovementDoc | null>;

async function readImprovementDoc(initiative: string): Promise<ImprovementDoc | null> {
  const badInitiative = safeName(initiative, "initiative");
  if (badInitiative) throw new Refusal(badInitiative);
  const target = await safePath(`${initiative}/improvement.md`);
  if (!existsSync(target)) return null;
  const raw = readFileSync(target, "utf8");
  const env = parseEnvelope(raw);
  return { status: env.status, approved_by: (env.approved_by ?? "").trim(), body: documentBody(raw) };
}

/** The owner teams the document approves for this attempt — see the module note and
 *  `approvedOwners` for what binds an approval to it. */
async function improvementApprovals(
  runner: Queryable, doc: ImprovementDoc | null, attempt: PreparedAttempt,
): Promise<string[]> {
  if (!doc) return [];
  return approvedOwners({
    status: doc.status, cited_attempt_id: citedReleaseAttempt(doc.body), attempt_id: attempt.id,
    quotes_digest: doc.body.includes(attempt.approved_patch_digest),
    approver_teams: doc.approved_by ? await memberTeams(runner, doc.approved_by) : [],
    required_owners: attempt.required_owners,
  });
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
    base_ref: string | null;
  } | null;
}

const branchFor = (candidateId: string): string => `release/candidate-${candidateId}`;

/** Rebuilds `release_apply`'s response from the row alone — the FR-59 ledger stores only
 *  `result_table`/`result_id`, so a replayed call (and the fresh path too, so the two never
 *  disagree) reads it back. A status the row has since moved past is reported as itself. */
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
      base_ref: await baseRefFor(runner, attempt.base_subject_version_id),
    } : null,
  };
}

/** The release_in_progress refusal: a live attempt is waited for; a stale one is named with the
 *  command that finds out what really happened to it and records that. */
function inProgressRefusal(
  pluginName: string, held: { attempt_id: string; stale: boolean }, heldCandidate: string, candidateId: string,
): Refusal {
  return new Refusal(held.stale
    ? `ERROR: release_in_progress — release_attempt ${held.attempt_id} of ${pluginName} has been ` +
      `applying for over ${STALE_APPLYING_MS / 60_000} minutes, so the process applying it is gone. ` +
      "Reconcile it first — it records released if that release landed and failed if it did not: " +
      `zz-tool release-apply --reconcile ${held.attempt_id} --candidate ${heldCandidate} ` +
      `--plugin ${pluginName} --release-version <the version its release command publishes> ` +
      "--release-tag <the tag that command pushes> --repo <clone>"
    : `ERROR: release_in_progress — release_attempt ${held.attempt_id} of ${pluginName} is applying ` +
      `now; candidate ${candidateId} may not apply until it records released or failed`);
}

/** FR-49's own compare-and-swap. Runs inside `withIdempotency`'s transaction, so the advisory
 *  lock is xact-scoped and releases at COMMIT or ROLLBACK.
 *
 *  Two refusal shapes: anything with no persisted outcome (an unknown candidate, no prepared
 *  attempt, a cited attempt that is not this candidate's prepared one, a caller who is no owner,
 *  an attempt already applying, no registered or no captured current subject, a bad initiative)
 *  THROWS, so the transaction rolls back and the ledger records nothing; `releaseDecision`'s
 *  verdicts are RETURNED, because the row write they make has to commit and be ledgered. */
export async function planApply(
  client: Queryable, candidateId: string, approvedPatchDigest: string, initiative: string,
  principal: string, readDoc: ReadImprovementDoc = readImprovementDoc,
): Promise<MutatorOutcome<ApplyResult>> {
  const candidate = await loadCandidateForApply(client, candidateId);
  if (!candidate) throw new Refusal(`ERROR: no candidate ${candidateId}`);

  const subject = (await client.query<{
    plugin_id: string; plugin: string; release_owners: string[]; declared_version: string;
  }>(`
    select sv.plugin_id::text as plugin_id, pl.name as plugin, pl.release_owners, sv.declared_version
      from zz.eval_subject_version sv join zz.plugin pl on pl.id = sv.plugin_id
     where sv.id = $1::uuid`, [candidate.base_subject_version_id])).rows[0];
  if (!subject) {
    throw new Refusal(
      `ERROR: candidate ${candidateId}'s base_subject_version_id ${candidate.base_subject_version_id} ` +
      "no longer resolves to a plugin");
  }

  // A third-party/not-yet-owned candidate never gets a prepared attempt (release_prepare refuses
  // it first), so without this check the attempt lookup below would hide the real reason.
  if (subject.release_owners.length === 0) {
    throw new Refusal(
      `ERROR: no_release_owners — candidate ${candidateId}'s own base subject records no ` +
      "release_owners, so it cannot be promoted. It may still receive an owner-facing proposal " +
      "— call proposal_prepare instead, naming this candidate's own improvement_run_id.");
  }
  const callerTeams = await memberTeams(client, principal);
  if (!subject.release_owners.some((owner) => callerTeams.includes(owner))) {
    throw new Refusal(
      `ERROR: not_owner — ${principal || "this caller"} is not a member of an owner team of ` +
      `${subject.plugin} (${subject.release_owners.join(", ")}); only an owner may apply its release`);
  }

  // Every concurrent release_apply for THIS plugin blocks here until the one ahead of it commits
  // or rolls back. `hashtext` over a namespaced string keeps this lock's keyspace disjoint from
  // any other advisory lock this service takes on a uuid-shaped input.
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [`release_apply:${subject.plugin_id}`]);

  // ISO 8601 through to_json, never `::text`: the session's DateStyle/TimeZone decide what text a
  // timestamptz renders as, and an unparseable one would read every live attempt as stale.
  const applying = (await client.query<{ id: string; candidate_id: string; applying_at: string | null }>(`
    select id::text as id, candidate_id::text as candidate_id, to_json(applying_at)#>>'{}' as applying_at
      from zz.release_attempt
     where plugin_id = $1::uuid and status = 'applying'`, [subject.plugin_id])).rows;
  const held = applyingRefusal(applying, Date.now());
  if (held) {
    const heldCandidate = applying.find((a) => a.id === held.attempt_id)?.candidate_id ?? "<its candidate>";
    throw inProgressRefusal(subject.plugin, held, heldCandidate, candidateId);
  }

  const doc = await readDoc(initiative);
  const attempt = await loadPreparedAttempt(client, candidateId, doc ? citedReleaseAttempt(doc.body) : null);
  if (!attempt) {
    throw new Refusal(
      `ERROR: no prepared release_attempt for candidate ${candidateId} — call release_prepare ` +
      "first, or this candidate's newest attempt already left 'prepared' (applying, released, " +
      "refused or failed)");
  }

  // One query at a time: `client` is a single PoolClient, which queues concurrent queries anyway
  // and warns that doing so is deprecated.
  const approvals = await improvementApprovals(client, doc, attempt);
  const head = await currentReleasedHead(client, subject.plugin_id);
  if (!head) {
    throw new Refusal(
      `ERROR: ${subject.plugin} has no registered release in zz.plugin_version, so there is no ` +
      "currently released subject to compare this candidate's base against");
  }
  // A head newer than the base is stale whether or not it was captured; one that is not newer
  // must be captured, or there is nothing to compare the base against (module note).
  const headIsNewer = compareSemver(head.version, subject.declared_version) > 0;
  if (!headIsNewer && !head.subject_id) {
    throw new Refusal(
      `ERROR: ${subject.plugin} ${head.version} is registered but was never captured — call ` +
      `plugin_locate for ${subject.plugin} ${head.version} before releasing a candidate against it`);
  }

  const decision = releaseDecision({
    base_is_current: !headIsNewer && head.subject_id === attempt.base_subject_version_id,
    approved_patch_digest: approvedPatchDigest,
    patch_digest: candidate.patch_digest,
    required_owners: attempt.required_owners,
    approvals,
    releasable: candidate.status === "valid",
  });

  if (decision.kind === "refuse") {
    // approval_required is NOT terminal — the document may still be approved later, so `status`
    // stays 'prepared'. Every other reason is: digest_mismatch and stale_baseline mean THIS
    // candidate can never legally apply against THIS base again. `reason` is written either way,
    // so a replay reads the same answer a fresh call would.
    const terminal = decision.reason !== "approval_required";
    await client.query(
      `update zz.release_attempt set reason = $2${terminal ? ", status = 'refused'" : ""}
        where id = $1::uuid and status = 'prepared'`,
      [attempt.id, decision.reason]);
    const result = await describeApplyOutcome(client, attempt.id);
    return { result, result_table: "zz.release_attempt", result_id: attempt.id };
  }

  // prepared -> applying. The CAS makes THIS row move at most once; 001's two indexes
  // keep one live attempt per candidate and one applying attempt per plugin — both
  // still catch a race the lock alone would not.
  let applied;
  try {
    applied = await client.query(`
      update zz.release_attempt set status = 'applying', applied_by = $2, applying_at = now()
       where id = $1::uuid and status = 'prepared' returning id`,
      [attempt.id, principal]);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      throw new Refusal(
        `ERROR: release_in_progress — another attempt of ${subject.plugin} is already applying, or ` +
        `candidate ${candidateId} is already released; the database refused this one`);
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

/** `release_apply`'s replay path — see `describeApplyOutcome`. Read-only, so it runs on the pool. */
export async function describeApplyOutcomeForReplay(pool: pg.Pool, attemptId: string): Promise<ApplyResult> {
  return describeApplyOutcome(pool, attemptId);
}
