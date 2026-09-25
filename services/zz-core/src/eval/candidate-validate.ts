/**
 * `candidate_validate`'s status walk: everything between `candidate_record`'s ledger row and a
 * releasable candidate. `candidates.ts` keeps only the tool's registration and description; the
 * decisions about a recorded build live in `candidate-build-rules.ts`.
 *
 * A candidate is judged twice, and neither time here by a model: before release, by its own
 * build and gate, run locally by `npm run candidate-build` (zz-core never builds one); after
 * release, by real use (`release_verify`, release-verify.ts). So a passed build is all it takes
 * to make a candidate `valid` — releasable once its owners approve improvement.md.
 *
 * The walk: `recorded` → `awaiting_build`, answered with `build_required`; the CLI records the
 * build (`candidate_build_record`, candidate-build.ts); the next call consumes it → `valid`,
 * `invalid`, or back to `recorded` when nothing about the patch was judged (a timeout, a host
 * problem). A `valid` or `invalid` candidate keeps the build it was judged by, so improvement.md
 * and the console can say how it was built.
 */
import type pg from "pg";

import { BUILD_LEASE_MS, buildRequired, judgeBuild } from "./candidate-build-rules.js";
import { withIdempotency, type IdempotencyOutcome, type MutatorOutcome } from "./idempotency.js";
import { Refusal } from "../refusal.js";

interface CandidateRow {
  readonly id: string;
  readonly status: string;
  readonly patch_digest: string;
  readonly build_requested_at: Date | null;
  readonly build_recorded_at: Date | null;
  readonly build_result: unknown;
}

async function loadCandidate(p: pg.Pool, candidateId: string): Promise<CandidateRow | null> {
  const row = (await p.query<CandidateRow>(`
    select id::text as id, status, patch_digest, build_requested_at, build_recorded_at, build_result
      from zz.candidate where id = $1::uuid`, [candidateId])).rows[0];
  return row ?? null;
}

/** An `awaiting_build` lease (`BUILD_LEASE_MS`) that ended with nothing recorded goes back to
 *  `recorded`, so the next call asks for a fresh build — a recorded build is kept until a call
 *  consumes it. */
async function releaseExpiredBuild(p: pg.Pool, candidateId: string): Promise<void> {
  await p.query(`
    update zz.candidate
       set status = 'recorded', build_requested_at = null, build_requested_by = null
     where id = $1::uuid and status = 'awaiting_build' and build_recorded_at is null
       and build_requested_at < now() - make_interval(secs => $2)`,
    [candidateId, BUILD_LEASE_MS / 1000]);
}

/** What `candidate_validate` answers once a candidate is releasable. */
interface ValidOutcome {
  readonly candidate_id: string;
  readonly status: "valid";
  readonly patch_digest: string;
  readonly releasable: true;
  readonly build: unknown;
  readonly next: string;
}

const validOutcome = (c: { id: string; patch_digest: string }, build: unknown): ValidOutcome => ({
  candidate_id: c.id, status: "valid", patch_digest: c.patch_digest, releasable: true, build,
  next: "Built and gated. An owned subject goes to release_prepare(initiative) (PROMOTE/VERIFY); " +
        "a subject with no release owners goes to proposal_prepare(initiative).",
});

type BuildRequired = ReturnType<typeof buildRequired>;

export async function validateCandidate(
  p: pg.Pool, candidateId: string, idempotencyKey: string, principal: string,
): Promise<ValidOutcome | BuildRequired | { error: string }> {
  await releaseExpiredBuild(p, candidateId);
  const candidate = await loadCandidate(p, candidateId);
  if (!candidate) return { error: `ERROR: no candidate ${candidateId}` };

  if (candidate.status === "valid") return validOutcome(candidate, candidate.build_result);

  if (candidate.status === "recorded") {
    // Compare-and-set on the status: a concurrent call against the same candidate finds it
    // awaiting_build already and answers the same build_required below.
    const asked = await p.query<{ build_requested_at: Date }>(`
      update zz.candidate
         set status = 'awaiting_build', build_requested_at = now(), build_requested_by = $2,
             build_result = null, build_recorded_at = null
       where id = $1::uuid and status = 'recorded'
      returning build_requested_at`, [candidateId, principal]);
    const at = asked.rows[0]?.build_requested_at;
    if (at) return buildRequired(candidateId, candidate.patch_digest, new Date(at));
    return validateCandidate(p, candidateId, idempotencyKey, principal);
  }

  if (candidate.status !== "awaiting_build") {
    return {
      error: `ERROR: candidate_validate is only callable for status in (recorded, awaiting_build, valid); ` +
        `candidate ${candidateId} is ${candidate.status}`,
    };
  }
  // Asked for, not yet recorded: the same instruction again, never a refusal — the agent that
  // lost the first answer reads the command from this one.
  if (!candidate.build_recorded_at) {
    return buildRequired(candidateId, candidate.patch_digest, new Date(candidate.build_requested_at ?? Date.now()));
  }

  // A recorded build: judged once, by whichever call consumes it. candidate_build_record refuses
  // a second record while one waits, so the status alone is the compare-and-set: a second
  // concurrent call finds nothing awaiting_build to consume.
  const verdict = judgeBuild(candidateId, candidate.patch_digest, candidate.build_result);
  const next = verdict.next;
  const outcome: IdempotencyOutcome<{ id: string }> = await withIdempotency(
    principal, "candidate_validate", idempotencyKey, { candidate_id: candidateId },
    async (client): Promise<MutatorOutcome<{ id: string }>> => {
      const moved = await client.query(`
        update zz.candidate
           set status = $2::text,
               build_requested_at = case when $2::text = 'recorded' then null else build_requested_at end,
               build_requested_by = case when $2::text = 'recorded' then null else build_requested_by end,
               build_result = case when $2::text = 'recorded' then null else build_result end,
               build_recorded_at = case when $2::text = 'recorded' then null else build_recorded_at end
         where id = $1::uuid and status = 'awaiting_build' and build_recorded_at is not null`,
        [candidateId, next]);
      if (!moved.rowCount) {
        throw new Refusal(`ERROR: candidate ${candidateId}'s recorded build was consumed by another ` +
          "candidate_validate call — call it again to read where the candidate stands");
      }
      return { result: { id: candidateId }, result_table: "zz.candidate", result_id: candidateId };
    },
  );
  if (outcome.replayed) {
    const now = await loadCandidate(p, candidateId);
    if (now?.status === "valid") return validOutcome(now, now.build_result);
  }
  if (verdict.next !== "valid") return { error: verdict.error };
  return validOutcome(candidate, candidate.build_result);
}
