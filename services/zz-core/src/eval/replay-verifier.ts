/**
 * The verifier_token's reach (FR-28, FR-30, FR-31): what a `context: "verifier"` call to
 * `replay_start`/`replay_read` may do with the token `candidate_prove` minted, split out of
 * `replay-runs.ts` so the binding is decided in one place both tools share.
 *
 * A token names ONE proof allocation: one candidate, one case set (migration 088's
 * `zz.replay_verifier_token.case_set_id`), the `proof` split, and the candidate's own base
 * subject for the baseline side. `candidate_prove` runs the other side as `candidate_id`;
 * `release_verify` (the same table, after promotion) runs it as the released subject
 * (`released_subject_version_id`), so either names that side. Before this file, a token named
 * only its candidate, so whoever held it could start or read any proof-split run it liked, and
 * `candidate_prove` handed back
 * the proof case ids to drive it with — enough for the search side to read per-case proof
 * scores and oracle events through `replay_read`. Now:
 *   - `verifierStartRefusal`: `replay_start` under a token must name the allocation's own case
 *     set, `split: "proof"`, and the allocation's candidate, base or released subject — and
 *     never a `case_id`: the proof case is drawn server-side (`verifierCaseDraw`), so no proof
 *     case id ever reaches a caller.
 *   - `verifierReadRefusal`: `replay_read` under a token reads only a run THAT allocation started,
 *     never an `evaluator`-role event, and a run's events only while it is still live (the
 *     launcher reads them once, before its sessions start).
 *   - `sealProofRead`: a proof-split run's own score, guardrails, cost, duration, model usage and
 *     case id are never returned by `replay_read`, whoever asks — `candidate_prove` reduces them
 *     server-side and answers with the verdict alone.
 *
 * RESIDUAL, stated plainly: the token reaches the launcher through the IMPROVE agent (it is in
 * `candidate_prove`'s response, and the agent sets `VERIFIER_TOKEN` for the launcher), and the
 * agent holds the same principal's PAT the launcher does. Nothing here separates the two
 * identities. The boundary is what each tool hands back under that token — no proof case id, no
 * per-case proof score, no evaluator-oracle event, no run outside the allocation — not who holds
 * it. While a proof run is live, the agent could read its `simulated_person` events (the
 * `user_oracle` timeline the launcher needs to drive the simulated person); that window is the
 * part of FR-30 this design does not close.
 */
import { sha256, type Db } from "@zz/contracts";

/** The allocation a presented verifier_token resolves to. */
export interface VerifierAllocation {
  readonly id: string;
  readonly candidate_id: string;
  readonly case_set_id: string;
  readonly base_subject_version_id: string;
  /** release_verify's own token: the released subject its non-baseline side runs as. */
  readonly released_subject_version_id: string | null;
}

/** The allocation a presented token names, or null when it is missing, revoked, expired, or was
 *  minted before migration 088 bound tokens to a case set — an unbound token is refused, never
 *  treated as a token for every case set. */
export async function verifierAllocation(p: Db, token: string | undefined): Promise<VerifierAllocation | null> {
  if (!token) return null;
  const row = (await p.query<VerifierAllocation>(
    `select t.id::text as id, t.candidate_id::text as candidate_id, t.case_set_id::text as case_set_id,
            c.base_subject_version_id::text as base_subject_version_id,
            t.released_subject_version_id::text as released_subject_version_id
       from zz.replay_verifier_token t
       join zz.candidate c on c.id = t.candidate_id
      where t.token_hash = $1 and t.revoked_at is null and t.expires_at > now()
        and t.case_set_id is not null`,
    [sha256(token)])).rows[0];
  return row ?? null;
}

/** Null when a verifier-context `replay_start` stays inside `alloc`; otherwise the refusal. */
export function verifierStartRefusal(alloc: VerifierAllocation, args: {
  readonly split: string; readonly case_set_id: string; readonly case_id?: string;
  readonly candidate_id?: string; readonly subject_version_id?: string;
}): string | null {
  const scope = `this verifier_token is bound to candidate ${alloc.candidate_id}'s proof allocation`;
  if (args.split !== "proof") return `ERROR: ${scope} — a verifier context replays split: proof only`;
  if (args.case_set_id !== alloc.case_set_id) return `ERROR: ${scope} on case set ${alloc.case_set_id}, not ${args.case_set_id}`;
  if (args.case_id) {
    return "ERROR: a verifier context never names a case_id — the proof case is drawn server-side, " +
      "and no proof case id is ever handed to a caller";
  }
  if (args.candidate_id && args.candidate_id !== alloc.candidate_id) return `ERROR: ${scope}, not candidate ${args.candidate_id}`;
  if (args.subject_version_id && args.subject_version_id !== alloc.base_subject_version_id &&
      args.subject_version_id !== alloc.released_subject_version_id) {
    return `ERROR: ${scope} — subject ${args.subject_version_id} is neither its base subject nor its released subject`;
  }
  return null;
}

/** The side a verifier-context `replay_start` runs: the baseline is the base subject; anything
 *  else the start was admitted for (the candidate, or release_verify's released subject) is the
 *  other side. */
export function verifierSide(alloc: VerifierAllocation, subjectVersionId: string | undefined): "candidate" | "baseline" {
  return subjectVersionId && subjectVersionId === alloc.base_subject_version_id ? "baseline" : "candidate";
}

/** The proof case a verifier-context `replay_start` runs next for one side: the replayable
 *  proof case in the allocation's own set with the fewest runs of that side so far (failed and
 *  cancelled ones do not count; runs from any allocation count, the same rows `candidate_prove`/
 *  `release_verify` plan over), no run of any kind still live against it, lowest id on a tie —
 *  so repeated starts go where the planner is short without the caller ever naming a case. A
 *  completed-but-unscored run counts here and not in the planner; that only skews which case is
 *  drawn next, never whether proof resolves. `client` is the caller's own transaction. */
export async function verifierCaseDraw(
  client: Db, alloc: VerifierAllocation, side: "candidate" | "baseline",
): Promise<{ id: string } | null> {
  const row = (await client.query<{ id: string }>(`
    select c.id::text as id
      from zz.replay_case c
     where c.case_set_id = $1::uuid and c.split = 'proof' and c.status = 'replayable'
       and not exists (
         select 1 from zz.replay_run r where r.case_id = c.id and r.status in ('registered', 'running')
       )
     order by (
       select count(*) from zz.replay_run r
        where r.case_id = c.id and r.status not in ('failed', 'cancelled')
          and (case when $2 = 'candidate'
                    then r.candidate_id = $3::uuid or r.subject_version_id = $5::uuid
                    else r.subject_version_id = $4::uuid end)
     ), c.id
     limit 1`,
    [alloc.case_set_id, side, alloc.candidate_id, alloc.base_subject_version_id,
     alloc.released_subject_version_id])).rows[0];
  return row ?? null;
}

const LIVE = new Set(["registered", "running"]);

/** Null when a verifier-context `replay_read` of `run` stays inside `alloc`; otherwise the
 *  refusal. `role` is the event role asked for, if any. */
export function verifierReadRefusal(
  alloc: VerifierAllocation,
  run: { readonly verifier_allocation_id: string | null; readonly status: string },
  role: string | undefined,
): string | null {
  if (run.verifier_allocation_id !== alloc.id) {
    return "ERROR: this verifier_token reads only replay runs its own proof allocation started";
  }
  if (role === "evaluator") {
    return "ERROR: a verifier context never reads evaluator-role events — replay_score reads them server-side";
  }
  if (role && !LIVE.has(run.status)) {
    return `ERROR: this proof run is already ${run.status} — its events are read once, while it is live`;
  }
  return null;
}

/** A proof-split row with every per-case result field blanked, whoever reads it. */
export function sealProofRead<T extends {
  split: string | null; case_id: string | null; score: unknown; guardrails: unknown;
  model_usage: unknown; cost: string | null; duration_ms: string | null;
}>(row: T): T {
  if (row.split !== "proof") return row;
  return { ...row, case_id: null, score: null, guardrails: null, model_usage: null, cost: null, duration_ms: null };
}
