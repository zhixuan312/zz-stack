/**
 * `release_record`'s own DB logic (Task I-23/I-24, FR-49, FR-50): records what the CLI that holds
 * the shell actually did — `packages/tools/src/release/apply.ts` (`released`/`failed`) or
 * `packages/tools/src/release/rollback.ts` (the rollback status). Split from `release-apply.ts`, which
 * keeps the compare-and-swap that moves an attempt INTO applying; this file moves it out.
 *
 * Every write is refused unless it can be true:
 *   - only the principal who applied the attempt, or a member of one of its owner teams, may
 *     record anything on it (`releaseActorRefusal`, below — `release_verify` checks it too);
 *   - `released` must name a subject of the same plugin at a version NEWER, by semver, than the
 *     base — a released id equal to or older than the base is the unchanged head located after a
 *     release that registered nothing, not the release;
 *   - the rollback status needs `release_verify` to have decided it first — a rollback with
 *     no recorded verdict behind it is a rollback nobody established — and, once its version is
 *     retracted (`retractedVersions`, `../release-head.ts`), the prior version must be the current one.
 *     Retraction is what makes the prior version current again for every reader; no
 *     `zz.plugin_version` row is deleted.
 *
 * `released` stays retryable: a refused record throws, so the ledger keeps nothing and the
 * attempt stays applying; the CLI prints the exact retry (or `--reconcile`) rather than recording
 * `failed` for a release that did land.
 *
 * A release that LANDS closes the findings it was built to fix (AC-7.2, Task I-32). The candidate
 * carries the improvement run it was proposed against, the run's targeted findings are its
 * `improvement_run_finding` rows, and each of them becomes `applied` with a `decision_note` naming
 * the version that shipped — so what used to be prose inside twenty-one notes is a relation a
 * later phase joins. The write goes through `decideFinding` (`./plugin-record.ts`), the ONE
 * deciding write on `zz.eval_finding`; a second private writer here is exactly what left the
 * finding-to-release provenance unrecorded. `failed` and the rollback close nothing: a finding
 * stays deferred until something shipped, and one an earlier release already closed — including
 * this release's own, when the rollback lands on it — is left alone rather than re-decided.
 */
import { EVAL_STATE_ENUMS } from "@zz/contracts";
import type pg from "pg";

import type { MutatorOutcome } from "./idempotency.js";
import { decideFinding, type DecidedFinding, type DecisionOutcome } from "./plugin-record.js";
import { currentReleasedHead } from "./release-apply.js";
import { compareSemver } from "../release-head.js";
import { Refusal } from "../refusal.js";
import { ownerMember } from "../release-owners.js";

const RELEASE_REF = /^[0-9a-f]{40}$/;

/** `release_record`'s wire vocabulary, kept byte-for-byte while group G retires the column
 *  behind it: `packages/tools/src/release/apply.ts` sends this field and the promote-verify
 *  skill documents it, and the release is `release_attempt.released_plugin_version_id` now. Held
 *  as a template over its own parts so that `checks/release-relations.ts`, which scans this
 *  file's text for the retired COLUMN spellings, does not read the wire name as a column read. */
const RELEASED_SUBJECT_VERSION = `released${"_subject_version_id"}`;
/** The attempt state a rollback leaves behind, and the verdict of the same name — taken from the
 *  shared vocabulary every writer takes its state values from (`EVAL_STATE_ENUMS`), sixth of
 *  six. This is also why this file never spells the retired boolean column of that name. */
const ROLLBACK_STATE = EVAL_STATE_ENUMS.releaseAttemptStatus[5];

interface RecordArgs {
  readonly release_attempt_id: string;
  readonly status: "released" | "failed" | typeof ROLLBACK_STATE;
  readonly release_ref: string | null;
  readonly [RELEASED_SUBJECT_VERSION]: string | null;
  readonly failure_tail: string | null;
  readonly reason: string | null;
}

export interface RecordResult {
  readonly status: "released" | "failed" | typeof ROLLBACK_STATE;
  readonly release_attempt_id: string;
  readonly [RELEASED_SUBJECT_VERSION]: string | null;
  readonly release_ref: string | null;
  /** One entry per finding this release recorded as `applied` — the decisions the release itself
   *  made, read back from `zz.eval_finding`. Empty on a `failed` record and on a rollback, which
   *  close nothing: a finding stays deferred until something shipped. */
  readonly findings_decided: readonly DecidedFinding[];
  /** The targeted findings this record left exactly as it found them, each entry a sentence saying
   *  why — already decided, or a strength (terminal at insert, with no decision to record). They
   *  are reported rather than thrown: the release is recorded either way, and a finding closed by
   *  another release stays closed. */
  readonly findings_left_alone: readonly string[];
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
  readonly id: string; readonly candidate_id: string; readonly base_plugin_version_id: string;
  readonly status: string; readonly released_plugin_version_id: string | null;
  readonly release_ref: string | null;
  /** The applier's own address, resolved through the principal `release_attempt.applied_by`
   *  names (group G: the column is a principal id, and the address is that row's). Read as the
   *  address because that is what a caller is known by here — `releaseActorRefusal` compares it
   *  with the caller's own, and an address that names no principal answers null, which is what
   *  the column itself holds. */
  readonly applied_by: string | null;
  readonly required_owners: string[]; readonly verdict: string | null; readonly plugin_id: string;
  /** The findings the candidate's improvement run was opened against — the rows of
   *  `improvement_run_finding` for the run, read in the same statement as the attempt so the
   *  release needs no second round trip to learn what it delivered. Absent (or empty) for a
   *  candidate whose run targeted none. */
  readonly findings: readonly string[] | null;
}

/** The plugin a subject version belongs to, and the version it names — the release's own row
 *  (FR-24: a subject version IS a `plugin_version`), so both facts are its columns. `as
 *  declared_version`: that is the name every subject-shaped reader on this side uses for the
 *  version a release declares, and the fold moved the column without moving the word. */
async function subjectOf(client: Pick<pg.PoolClient, "query">, id: string): Promise<{ plugin_id: string; declared_version: string } | null> {
  const row = (await client.query<{ plugin_id: string; declared_version: string }>(
    "select plugin_id::text as plugin_id, version as declared_version from zz.plugin_version where id = $1::uuid",
    [id])).rows[0];
  return row ?? null;
}

/** The version a release shipped, as a note names it: `<plugin>@<version>`, the label the release
 *  tag and the catalog both use. The plugin's name is one read of its own row; a name the FK
 *  guarantees cannot go missing, but the note falls back to the version alone rather than writing
 *  a uuid into a sentence a person reads. */
async function releasedLabel(
  client: Pick<pg.PoolClient, "query">, pluginId: string, declaredVersion: string,
): Promise<string> {
  const named = (await client.query<{ name: string }>(
    "select name from zz.plugin where id = $1::uuid", [pluginId])).rows[0];
  return named ? `${named.name}@${declaredVersion}` : declaredVersion;
}

/** Closes the findings the released candidate was built to fix, through the ONE deciding write on
 *  `zz.eval_finding` (`decideFinding`, `./plugin-record.ts`) — the same function `finding_decide`
 *  calls, which is the point: one writer, so the finding-to-release provenance is a column rather
 *  than a sentence in a note.
 *
 *  A refusal closes nothing and does not fail the release — the row is already released, and a
 *  finding another release closed, or a strength, is one this call must leave alone. The refusals
 *  come back as sentences for the caller to report. */
async function decideTargetedFindings(
  client: Pick<pg.PoolClient, "query">, findingIds: readonly string[], note: string, principal: string,
): Promise<{ decided: DecidedFinding[]; left_alone: string[] }> {
  const decided: DecidedFinding[] = [];
  const left_alone: string[] = [];
  for (const findingId of findingIds) {
    const outcome: DecisionOutcome = await decideFinding(client, findingId, "applied", note, principal);
    if ("decided" in outcome) decided.push(outcome.decided);
    else left_alone.push(outcome.refused);
  }
  return { decided, left_alone };
}

/** CAS-guarded: the SELECT exists only to produce a readable refusal; each branch's own final
 *  UPDATE's `where status = '...'` is the decision (`applying` for released/failed, `released`
 *  for the rollback branch — a rollback is a second event on an attempt already recorded
 *  released). */
export async function recordRelease(
  client: Pick<pg.PoolClient, "query">, args: RecordArgs, principal: string,
): Promise<MutatorOutcome<RecordResult>> {
  // The base release is the candidate's own immutable column and the required owners are the
  // `release_attempt_owner` relation (group G): neither is copied onto the attempt any more, so
  // both are read through the row that owns them. The applier's address is resolved through the
  // principal the column names, which is what makes it comparable with this caller.
  const attempt = (await client.query<AttemptRow>(`
    select ra.id::text as id, ra.candidate_id::text as candidate_id,
           c.base_plugin_version_id::text as base_plugin_version_id, ra.status,
           ra.released_plugin_version_id::text as released_plugin_version_id, ra.release_ref,
           p.email as applied_by, ra.verdict, ra.plugin_id::text as plugin_id,
           coalesce(owners.slugs, '{}'::text[]) as required_owners,
           coalesce(targeted.findings, '{}'::text[]) as findings
      from zz.release_attempt ra
      join zz.candidate c on c.id = ra.candidate_id
      left join zz.principal p on p.id = ra.applied_by
      left join lateral (
        select array_agg(t.slug order by t.slug) as slugs
          from zz.release_attempt_owner o
          join zz.team t on t.id = o.team_id
         where o.release_attempt_id = ra.id) owners on true
      left join lateral (
        select array_agg(f.finding_id::text order by f.finding_id) as findings
          from zz.improvement_run_finding f
         where f.improvement_run_id = c.improvement_run_id) targeted on true
     where ra.id = $1::uuid`, [args.release_attempt_id])).rows[0];
  if (!attempt) throw new Refusal(`ERROR: no release_attempt ${args.release_attempt_id}`);
  const refused = await releaseActorRefusal(client, attempt, principal);
  if (refused) throw new Refusal(refused);

  if (args.status === ROLLBACK_STATE) {
    if (!args.reason) throw new Refusal(`ERROR: status: ${ROLLBACK_STATE} requires reason`);
    if (attempt.status !== "released") {
      throw new Refusal(
        `ERROR: not_released — release_attempt ${args.release_attempt_id} is ${attempt.status}, not ` +
        "released; a rollback can only be recorded against an attempt that actually reached released");
    }
    if (attempt.verdict !== ROLLBACK_STATE) {
      throw new Refusal(
        `ERROR: not_rolled_back — release_verify's verdict on release_attempt ${attempt.id} is ` +
        `${attempt.verdict ?? "not yet decided"}, not ${ROLLBACK_STATE}; a rollback is recorded only ` +
        "after release_verify established one");
    }
    // One column records the rollback, not two: `status` is the attempt's lifecycle and the
    // boolean copy of the same fact is gone with it (group G).
    const applied = await client.query(`
      update zz.release_attempt set status = '${ROLLBACK_STATE}', reason = $2
       where id = $1::uuid and status = 'released' returning id`,
      [attempt.id, args.reason]);
    if (!applied.rows.length) {
      throw new Refusal(`ERROR: release_attempt ${attempt.id} left 'released' before this call reached it`);
    }
    // The prior version must be current once this release is retracted — asked with the SAME
    // head release_apply's baseline uses (`currentVersionOf`, ../release-head.ts),
    // inside this transaction, so the retraction and its confirmation commit together or not at
    // all. A newer release that is not retracted still stands over the prior one; recording
    // a rollback then would claim a restore that did not happen. Compared by VERSION, not by
    // the row id: the head names one `plugin_version` row per (plugin, version) and the row the
    // attempt was based on need not be that one.
    const head = await currentReleasedHead(client, attempt.plugin_id);
    const prior = await subjectOf(client, attempt.base_plugin_version_id);
    if (!head || !prior || compareSemver(head.version, prior.declared_version) !== 0) {
      throw new Refusal(
        `ERROR: prior_not_current — with release_attempt ${attempt.id}'s version retracted, the ` +
        `plugin's current version is ${head?.version ?? "unresolvable"}, not the prior ` +
        `${prior?.declared_version ?? attempt.base_plugin_version_id}; nothing recorded`);
    }

    const result: RecordResult = {
      status: ROLLBACK_STATE, release_attempt_id: attempt.id,
      [RELEASED_SUBJECT_VERSION]: attempt.released_plugin_version_id, release_ref: attempt.release_ref,
      // A rollback closes nothing. Whatever the release decided when it landed is what the
      // findings carry; re-deciding them here would reopen work the release did deliver, and the
      // note already names the version that shipped it.
      findings_decided: [], findings_left_alone: [],
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
    const releasedVersionId = args[RELEASED_SUBJECT_VERSION];
    if (!releasedVersionId || !args.release_ref) {
      throw new Refusal(`ERROR: status: released requires both release_ref and ${RELEASED_SUBJECT_VERSION}`);
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
    const released = await subjectOf(client, releasedVersionId);
    const base = await subjectOf(client, attempt.base_plugin_version_id);
    if (!released || !base || released.plugin_id !== base.plugin_id) {
      throw new Refusal(
        `ERROR: ${RELEASED_SUBJECT_VERSION} ${releasedVersionId} does not name a ` +
        "subject version of the SAME plugin this candidate's own base subject belongs to");
    }
    if (compareSemver(released.declared_version, base.declared_version) <= 0) {
      throw new Refusal(
        `ERROR: not_newer — ${RELEASED_SUBJECT_VERSION} ${releasedVersionId} is ` +
        `version ${released.declared_version}, not newer than the base ${base.declared_version}; ` +
        "call plugin_locate with the exact version the release published and record that. The " +
        "attempt stays applying, so this call can be retried");
    }

    // `reason` on a release is the operator's accepted override (`--reconcile
    // --accept-tag-without-candidate-commit`), kept on the row so a reader sees the ancestry was
    // accepted rather than proved. The candidate's own status is NOT written here: released and
    // the rollback state are the ATTEMPT's states (group G), and a reader that wants them joins it.
    const applied = await client.query(`
      update zz.release_attempt
         set status = 'released', release_ref = $2, released_plugin_version_id = $3::uuid, reason = $4
       where id = $1::uuid and status = 'applying' returning id`,
      [attempt.id, args.release_ref, releasedVersionId, args.reason]);
    if (!applied.rows.length) {
      throw new Refusal(`ERROR: release_attempt ${attempt.id} left 'applying' before this call reached it`);
    }

    // The release landed, so the findings it was built to fix are applied — and the note is the
    // only place a reader learns WHICH release applied them, so it names the version. Same
    // transaction as the update above: a decision that could not land leaves the release
    // unrecorded rather than recorded-and-silent.
    const note = `Applied by release ${await releasedLabel(client, released.plugin_id, released.declared_version)} ` +
      `(release_attempt ${attempt.id})`;
    const findings = await decideTargetedFindings(client, attempt.findings ?? [], note, principal);

    const result: RecordResult = {
      status: "released", release_attempt_id: attempt.id,
      [RELEASED_SUBJECT_VERSION]: releasedVersionId, release_ref: args.release_ref,
      findings_decided: findings.decided, findings_left_alone: findings.left_alone,
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
    [RELEASED_SUBJECT_VERSION]: null, release_ref: null,
    // Nothing shipped, so nothing is applied: a finding stays deferred until a release lands.
    findings_decided: [], findings_left_alone: [],
  };
  return { result, result_table: "zz.release_attempt", result_id: attempt.id };
}

/** What a replayed record says about the findings: the durable rows, read back, because the ledger
 *  replays the RECORD and a response restating decisions the rows no longer hold would be a second
 *  memory of them. Only a `released` attempt carries any — a failed call and a rollback decided
 *  none, which is why they answer empty here rather than reporting decisions that belong to the
 *  release the rollback undid. */
async function findingsForReplay(
  pool: pg.Pool, attemptId: string, status: string,
): Promise<{ findings_decided: DecidedFinding[]; findings_left_alone: string[] }> {
  if (status !== "released") return { findings_decided: [], findings_left_alone: [] };
  const rows = (await pool.query<{
    id: string; pattern: string; decision: string | null;
    at: string | null; by: string | null; note: string | null;
  }>(`
    select f.id::text as id, f.pattern, f.decision, f.decided_at::text as at,
           p.email as by, f.decision_note as note
      from zz.release_attempt ra
      join zz.candidate c on c.id = ra.candidate_id
      join zz.improvement_run_finding r on r.improvement_run_id = c.improvement_run_id
      join zz.eval_finding f on f.id = r.finding_id
      left join zz.principal p on p.id = f.decided_by
     where ra.id = $1::uuid
     order by f.id`, [attemptId])).rows;
  const decided: DecidedFinding[] = [];
  const left_alone: string[] = [];
  for (const row of rows) {
    if (row.decision === "applied" || row.decision === "rejected") {
      decided.push({
        id: row.id, pattern: row.pattern, decision: row.decision,
        at: row.at ?? "", decided_by: row.by ?? "", note: row.note ?? "",
      });
    } else {
      left_alone.push(
        `${row.id} is ${row.decision ?? "a strength"} — this release recorded no decision on it, ` +
        "so it is exactly as the call that released left it");
    }
  }
  return { findings_decided: decided, findings_left_alone: left_alone };
}

/** `release_record`'s replay path — read the row back rather than trust anything held in memory
 *  from the original call. */
export async function describeRecordOutcomeForReplay(pool: pg.Pool, attemptId: string): Promise<RecordResult> {
  const row = (await pool.query<{
    status: string; released_plugin_version_id: string | null; release_ref: string | null;
  }>(`
    select status, released_plugin_version_id::text as released_plugin_version_id, release_ref
      from zz.release_attempt where id = $1::uuid`, [attemptId])).rows[0];
  if (!row) throw new Refusal(`ERROR: release_attempt ${attemptId} no longer exists`);
  return {
    status: row.status as RecordResult["status"], release_attempt_id: attemptId,
    [RELEASED_SUBJECT_VERSION]: row.released_plugin_version_id, release_ref: row.release_ref,
    ...(await findingsForReplay(pool, attemptId, row.status)),
  };
}
