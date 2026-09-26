/**
 * `release_record`'s own DB logic (Task I-23/I-24, FR-49, FR-50): records what the CLI that holds
 * the shell actually did — `packages/tools/src/release/apply.ts` (`released`/`failed`) or
 * `packages/tools/src/release/rollback.ts` (`rolled_back`). Split from `release-apply.ts`, which
 * keeps the compare-and-swap that moves an attempt INTO applying; this file moves it out.
 *
 * Every write is refused unless it can be true:
 *   - only the principal who applied the attempt, or a member of one of its owner teams, may
 *     record anything on it (`releaseActorRefusal`, below — `release_verify` checks it too);
 *   - `released` must name a subject of the same plugin at a version NEWER, by semver, than the
 *     base — a released id equal to or older than the base is the unchanged head located after a
 *     release that registered nothing, not the release;
 *   - `rolled_back` needs `release_verify` to have decided `rolled_back` first — a rollback with
 *     no recorded verdict behind it is a rollback nobody established — and, once its version is
 *     retracted (`retractedVersions`, `../release-head.ts`), the prior version must be the current one.
 *     Retraction is what makes the prior version current again for every reader; no
 *     `zz.plugin_version` row is deleted.
 *
 * `released` stays retryable: a refused record throws, so the ledger keeps nothing and the
 * attempt stays applying; the CLI prints the exact retry (or `--reconcile`) rather than recording
 * `failed` for a release that did land.
 */
import type pg from "pg";

import type { MutatorOutcome } from "./idempotency.js";
import { currentReleasedHead } from "./release-apply.js";
import { compareSemver } from "../release-head.js";
import { Refusal } from "../refusal.js";
import { ownerMember } from "../release-owners.js";

const RELEASE_REF = /^[0-9a-f]{40}$/;

interface RecordArgs {
  readonly release_attempt_id: string;
  readonly status: "released" | "failed" | "rolled_back";
  readonly release_ref: string | null;
  readonly released_subject_version_id: string | null;
  readonly failure_tail: string | null;
  readonly reason: string | null;
}

export interface RecordResult {
  readonly status: "released" | "failed" | "rolled_back";
  readonly release_attempt_id: string;
  readonly released_subject_version_id: string | null;
  readonly release_ref: string | null;
}

/** `release_record` and `release_verify` act only for the principal whose `release_apply` moved
 *  the attempt to applying, or for a member of one of its owner teams (`release-owners.ts`).
 *  Anyone else on the /eval door could otherwise record an outcome that never happened or decide
 *  the fate of a release they have no stake in. Null means allowed. */
export async function releaseActorRefusal(
  runner: Pick<pg.PoolClient, "query">,
  attempt: { readonly id: string; readonly applied_by: string | null; readonly required_owners: readonly string[] },
  principal: string,
): Promise<string | null> {
  if (attempt.applied_by && attempt.applied_by.toLowerCase() === principal.trim().toLowerCase()) return null;
  if (await ownerMember(runner, principal, attempt.required_owners)) return null;
  return `ERROR: not_owner — ${principal || "this caller"} neither applied release_attempt ${attempt.id} ` +
    `nor is a member of one of its owner teams (${attempt.required_owners.join(", ") || "none"}); ` +
    "only they may record or verify it";
}

interface AttemptRow {
  readonly id: string; readonly candidate_id: string; readonly base_subject_version_id: string;
  readonly status: string; readonly released_subject_version_id: string | null;
  readonly release_ref: string | null; readonly applied_by: string | null;
  readonly required_owners: string[]; readonly verdict: string | null; readonly plugin_id: string;
}

async function subjectOf(client: Pick<pg.PoolClient, "query">, id: string): Promise<{ plugin_id: string; declared_version: string } | null> {
  const row = (await client.query<{ plugin_id: string; declared_version: string }>(
    "select plugin_id::text as plugin_id, declared_version from zz.eval_subject_version where id = $1::uuid",
    [id])).rows[0];
  return row ?? null;
}

/** CAS-guarded: the SELECT exists only to produce a readable refusal; each branch's own final
 *  UPDATE's `where status = '...'` is the decision (`applying` for released/failed, `released`
 *  for rolled_back — a rollback is a second event on an attempt already recorded released). */
export async function recordRelease(
  client: Pick<pg.PoolClient, "query">, args: RecordArgs, principal: string,
): Promise<MutatorOutcome<RecordResult>> {
  const attempt = (await client.query<AttemptRow>(`
    select id::text as id, candidate_id::text as candidate_id,
           base_subject_version_id::text as base_subject_version_id, status,
           released_subject_version_id::text as released_subject_version_id, release_ref,
           applied_by, required_owners, verification->>'verdict' as verdict, plugin_id::text as plugin_id
      from zz.release_attempt where id = $1::uuid`, [args.release_attempt_id])).rows[0];
  if (!attempt) throw new Refusal(`ERROR: no release_attempt ${args.release_attempt_id}`);
  const refused = await releaseActorRefusal(client, attempt, principal);
  if (refused) throw new Refusal(refused);

  if (args.status === "rolled_back") {
    if (!args.reason) throw new Refusal("ERROR: status: rolled_back requires reason");
    if (attempt.status !== "released") {
      throw new Refusal(
        `ERROR: not_released — release_attempt ${args.release_attempt_id} is ${attempt.status}, not ` +
        "released; a rollback can only be recorded against an attempt that actually reached released");
    }
    if (attempt.verdict !== "rolled_back") {
      throw new Refusal(
        `ERROR: not_rolled_back — release_verify's verdict on release_attempt ${attempt.id} is ` +
        `${attempt.verdict ?? "not yet decided"}, not rolled_back; a rollback is recorded only ` +
        "after release_verify established one");
    }
    const applied = await client.query(`
      update zz.release_attempt set status = 'rolled_back', rolled_back = true, reason = $2
       where id = $1::uuid and status = 'released' returning id`,
      [attempt.id, args.reason]);
    if (!applied.rows.length) {
      throw new Refusal(`ERROR: release_attempt ${attempt.id} left 'released' before this call reached it`);
    }
    // The prior version must be current once this release is retracted — asked with the SAME
    // head release_apply's baseline uses (`currentVersionOf`, ../release-head.ts),
    // inside this transaction, so the retraction and its confirmation commit together or not at
    // all. A newer release that is not retracted still stands over the prior one; recording
    // rolled_back then would claim a restore that did not happen. Compared by VERSION, not by
    // subject id: the head's newest capture of the prior version need not be the very row the
    // attempt was based on.
    const head = await currentReleasedHead(client, attempt.plugin_id);
    const prior = await subjectOf(client, attempt.base_subject_version_id);
    if (!head || !prior || compareSemver(head.version, prior.declared_version) !== 0) {
      throw new Refusal(
        `ERROR: prior_not_current — with release_attempt ${attempt.id}'s version retracted, the ` +
        `plugin's current version is ${head?.version ?? "unresolvable"}, not the prior ` +
        `${prior?.declared_version ?? attempt.base_subject_version_id}; nothing recorded`);
    }
    // Migration 001 — candidate.status gains rolled_back for exactly this write, never on its own.
    await client.query("update zz.candidate set status = 'rolled_back' where id = $1::uuid", [attempt.candidate_id]);

    const result: RecordResult = {
      status: "rolled_back", release_attempt_id: attempt.id,
      released_subject_version_id: attempt.released_subject_version_id, release_ref: attempt.release_ref,
    };
    return { result, result_table: "zz.release_attempt", result_id: attempt.id };
  }

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
    // The commit the release tag names, as `git rev-parse` prints it. Anything else — a tag
    // name, a `<plugin>@<version>` label, an abbreviated sha — is a ref the next release's
    // `resolveBase` may not resolve, recorded as if it were one.
    if (!RELEASE_REF.test(args.release_ref)) {
      throw new Refusal(
        `ERROR: release_ref ${args.release_ref} is not a full 40-hex commit sha — record the commit ` +
        "the release tag names (git rev-parse <tag>^{commit}). The attempt stays applying");
    }
    // Sequential: one PoolClient runs one query at a time.
    const released = await subjectOf(client, args.released_subject_version_id);
    const base = await subjectOf(client, attempt.base_subject_version_id);
    if (!released || !base || released.plugin_id !== base.plugin_id) {
      throw new Refusal(
        `ERROR: released_subject_version_id ${args.released_subject_version_id} does not name a ` +
        "subject version of the SAME plugin this candidate's own base subject belongs to");
    }
    if (compareSemver(released.declared_version, base.declared_version) <= 0) {
      throw new Refusal(
        `ERROR: not_newer — released_subject_version_id ${args.released_subject_version_id} is ` +
        `version ${released.declared_version}, not newer than the base ${base.declared_version}; ` +
        "call plugin_locate with the exact version the release published and record that. The " +
        "attempt stays applying, so this call can be retried");
    }

    // `reason` on a release is the operator's accepted override (`--reconcile
    // --accept-tag-without-candidate-commit`), kept on the row so a reader sees the ancestry was
    // accepted rather than proved.
    const applied = await client.query(`
      update zz.release_attempt
         set status = 'released', release_ref = $2, released_subject_version_id = $3::uuid, reason = $4
       where id = $1::uuid and status = 'applying' returning id`,
      [attempt.id, args.release_ref, args.released_subject_version_id, args.reason]);
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

  // failed — the CLI's own contract: its worktree and branch are already gone, and the release
  // it reports as failed never registered a version.
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

/** `release_record`'s replay path — read the row back rather than trust anything held in memory
 *  from the original call. */
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
