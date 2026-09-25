/**
 * The pure rules the release path decides from (Task I-22/I-23/I-24, FR-49, FR-50, AC-49.1,
 * AC-50.1): promotion, the inputs `release_apply` feeds it, post-release verification and
 * rollback. Everything here is a function of its arguments — no database, no clock, no file —
 * so `checks/eval-release-rules.ts`, `checks/eval-release-apply-pure.ts` and
 * `checks/eval-release-verify-reduction.ts` import these straight off `dist/` and pin their exact
 * refusal order and reasons there rather than restated here.
 *
 * `releaseDecision` is FR-49's own compare-and-swap read as a pure function of five facts:
 * whether any owner is required at all, whether the candidate is still releasable, whether
 * every required owner has approved, whether the digest actually being applied is the one that
 * was approved, and whether the currently released subject is still the candidate's own
 * `base_subject_version_id`. The order matters and is checked in exactly this sequence, stopping
 * at the first hit, because each later branch assumes the earlier ones already passed —
 * `approval_required` firing on a third-party subject that never had an owner to approve would
 * misreport "nobody signed off" for "nobody COULD," and `stale_baseline` firing ahead of
 * `digest_mismatch` would send a caller to rebase a candidate whose real problem is a patch that
 * no longer matches what was approved.
 *
 * `release_prepare` (`release.ts`) does not call `releaseDecision`: at prepare time nothing has
 * been approved yet, so `approval_required` would fire on every legitimate call. Its own gate is
 * the first branch of this same order alone — `no_release_owners` — plus a `not_eligible` refusal
 * for a candidate that is not `valid` (built and gated). `release_apply`
 * (`release-apply.ts`) evaluates the whole order, and builds three of its five inputs with the
 * helpers below: `approvedOwners` (who approved, by membership), `newestVersion` (which version
 * is currently released) and `applyingRefusal` (whether another attempt already holds the plugin).
 *
 * `verifyDecision` is `release_verify`'s whole decision (FR-50, 002): a released improvement is
 * judged on real use, never on replays. Until the released subject has the protocol's
 * `minPostReleaseRuns` real runs, and an evaluation over them, it waits. Then a failed critical
 * guardrail rolls back, and so does a released score more than `regressionBand` below the base
 * subject's own; anything else is established. No rollback without evidence: with no base score
 * to compare against, the verdict is `not_established`, never a rollback. */

interface ReleaseDecisionInput {
  /** Whether the plugin's currently released subject is still the candidate's own base. */
  readonly base_is_current: boolean;
  readonly approved_patch_digest: string;
  readonly patch_digest: string;
  readonly required_owners: readonly string[];
  readonly approvals: readonly string[];
  /** Whether the candidate is still `valid` — built and gated, not yet released. */
  readonly releasable: boolean;
}

type ReleaseDecisionReason =
  | "no_release_owners"
  | "not_eligible"
  | "approval_required"
  | "digest_mismatch"
  | "stale_baseline";

type ReleaseDecisionResult =
  | { readonly kind: "apply" }
  | { readonly kind: "refuse"; readonly reason: ReleaseDecisionReason };

/** FR-49's own refusal order — see the module note for why each branch assumes the ones above it
 *  already passed. Pure: the same five facts always produce the same verdict. */
export function releaseDecision(input: ReleaseDecisionInput): ReleaseDecisionResult {
  if (input.required_owners.length === 0) return { kind: "refuse", reason: "no_release_owners" };
  if (!input.releasable) return { kind: "refuse", reason: "not_eligible" };
  const unapproved = input.required_owners.some((owner) => !input.approvals.includes(owner));
  if (unapproved) return { kind: "refuse", reason: "approval_required" };
  if (input.patch_digest !== input.approved_patch_digest) return { kind: "refuse", reason: "digest_mismatch" };
  if (!input.base_is_current) return { kind: "refuse", reason: "stale_baseline" };
  return { kind: "apply" };
}

// -------------------------------------------------------------------------------------------
// release_apply's decision inputs.

/** Semver precedence (semver.org section 11): numeric core first, then a pre-release below its
 *  own release, then the pre-release identifiers one by one — numeric ones numerically, numeric
 *  below alphanumeric, alphanumeric as ASCII text, and a shorter run of equal identifiers below a
 *  longer one. Build metadata (`+...`) is ignored. Never a text sort: text puts 0.9.0 above
 *  0.43.0, and rc.10 below rc.9. A version with no leading numeric core — `v1.0.0` included —
 *  sorts below every version that has one. Both "what is released now" readers — release_apply's
 *  head and plugin_locate's (subject.ts) — reduce zz.plugin_version through `newestVersion`
 *  below rather than trusting any SQL order. */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string): { core: number[] | null; pre: string[] } => {
    const m = /^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?/.exec(v.trim());
    return m ? { core: m[1].split(".").map(Number), pre: m[2] ? m[2].split(".") : [] } : { core: null, pre: [] };
  };
  const x = parse(a), y = parse(b);
  if (!x.core || !y.core) return (x.core ? 1 : 0) - (y.core ? 1 : 0);
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i += 1) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (!x.pre.length || !y.pre.length) return (x.pre.length ? -1 : 0) + (y.pre.length ? 1 : 0);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return Math.sign(Number(p) - Number(q));
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** The newest version by `compareSemver`, or null for none. First wins a tie. */
export function newestVersion(versions: readonly string[]): string | null {
  let best: string | null = null;
  for (const v of versions) if (best === null || compareSemver(v, best) > 0) best = v;
  return best;
}

interface ApprovalFacts {
  readonly status: string | undefined;
  /** The one `release_attempt_id` improvement.md's body cites, or null. */
  readonly cited_attempt_id: string | null;
  readonly attempt_id: string;
  /** Whether improvement.md's body quotes the attempt's own approved_patch_digest. */
  readonly quotes_digest: boolean;
  /** Every team the approving person is a member of — by membership, never their active team. */
  readonly approver_teams: readonly string[];
  readonly required_owners: readonly string[];
}

/** The owner teams an approved improvement.md speaks for: none unless the document is approved,
 *  cites THIS attempt and quotes its digest; otherwise every required owner the approver is a
 *  member of. An approval of an earlier attempt's document, or by somebody in no owner team,
 *  approves nothing here. */
export function approvedOwners(f: ApprovalFacts): string[] {
  if (f.status !== "approved" || f.cited_attempt_id !== f.attempt_id || !f.quotes_digest) return [];
  return f.required_owners.filter((owner) => f.approver_teams.includes(owner));
}

/** Longer than the apply CLI's own gate (15 min) and release (20 min) timeouts together: an
 *  attempt applying past this has nobody left to report for it. */
export const STALE_APPLYING_MS = 40 * 60_000;

interface ApplyingAttempt { readonly id: string; readonly applying_at: string | null }

/** `release_in_progress` when any attempt of the plugin is already applying — whoever's
 *  candidate it is, because two candidates on the same base would otherwise both pass the
 *  compare-and-swap. `stale` tells the caller whether to wait or to reconcile it. */
export function applyingRefusal(
  applying: readonly ApplyingAttempt[], nowMs: number,
): { readonly attempt_id: string; readonly stale: boolean } | null {
  const held = applying[0];
  if (!held) return null;
  const since = held.applying_at ? Date.parse(held.applying_at) : NaN;
  return { attempt_id: held.id, stale: Number.isNaN(since) || nowMs - since >= STALE_APPLYING_MS };
}

// -------------------------------------------------------------------------------------------
// release_verify's decision and FR-50's rollback rule.

interface VerifyInput {
  /** Real runs of the released subject so far. */
  readonly post_release_runs: number;
  readonly min_post_release_runs: number;
  /** The newest completed evaluation of the released subject over at least that many runs, under
   *  the base's protocol version, or null when there is none yet. */
  readonly released: { readonly overall: number | null; readonly guardrail_status: string | null } | null;
  /** The base subject's own newest established or provisional score under the same protocol. */
  readonly base_overall: number | null;
  readonly regression_band: number;
}

type VerifyDecision =
  | { readonly kind: "pending"; readonly reason: "awaiting_post_release_runs"; readonly runs_needed: number }
  | { readonly kind: "pending"; readonly reason: "awaiting_evaluation" | "released_score_not_established" }
  | {
      readonly kind: "resolve";
      readonly verdict: "established" | "rolled_back" | "not_established";
      readonly reason: "guardrail_failed" | "regression_beyond_band" | "no_regression_beyond_band" | "no_base_score";
      /** released − base, when both exist. */
      readonly delta: number | null;
    };

/** See the module note. The guardrail is read before the score: a released subject visibly
 *  failing a critical guardrail rolls back whatever its overall number says. */
export function verifyDecision(input: VerifyInput): VerifyDecision {
  if (input.post_release_runs < input.min_post_release_runs) {
    return { kind: "pending", reason: "awaiting_post_release_runs", runs_needed: input.min_post_release_runs - input.post_release_runs };
  }
  if (!input.released) return { kind: "pending", reason: "awaiting_evaluation" };
  const delta = input.released.overall !== null && input.base_overall !== null ? input.released.overall - input.base_overall : null;
  if (input.released.guardrail_status === "fail") return { kind: "resolve", verdict: "rolled_back", reason: "guardrail_failed", delta };
  if (input.released.overall === null) return { kind: "pending", reason: "released_score_not_established" };
  if (input.base_overall === null) return { kind: "resolve", verdict: "not_established", reason: "no_base_score", delta: null };
  return delta! < -input.regression_band
    ? { kind: "resolve", verdict: "rolled_back", reason: "regression_beyond_band", delta }
    : { kind: "resolve", verdict: "established", reason: "no_regression_beyond_band", delta };
}
