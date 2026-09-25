/**
 * The pure rules the release path decides from (Task I-22/I-23/I-24, FR-49, FR-50, AC-49.1,
 * AC-50.1): promotion, the inputs `release_apply` feeds it, post-release verification and
 * rollback. Everything here is a function of its arguments — no database, no clock, no file —
 * so `checks/eval-release-rules.ts`, `checks/eval-release-apply-pure.ts` and
 * `checks/eval-release-verify-reduction.ts` import these straight off `dist/` and pin their exact
 * refusal order and reasons there rather than restated here.
 *
 * `releaseDecision` is FR-49's own compare-and-swap read as a pure function of five facts:
 * whether any owner is required at all, whether proof established release eligibility, whether
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
 * for a candidate that has not itself reached `proof_passed`. `release_apply`
 * (`release-apply.ts`) evaluates the whole order, and builds three of its five inputs with the
 * helpers below: `approvedOwners` (who approved, by membership), `newestSubject` (which subject
 * is currently released) and `applyingRefusal` (whether another attempt already holds the plugin).
 *
 * `verifyReduction` is `release_verify`'s whole decision once every held case has its repeats, and
 * `rollbackDecision` is the FR-50 rule inside it: the same percentile-bootstrap interval
 * `candidate_prove` uses (`pairedDecision`, `stats.ts`), with `mme` fixed at 0 — FR-50's own
 * "below 0", any established regression — and the protocol's own `confidence`, the SAME value the
 * reduction's unresolved check used, so one interval decides both. A guardrail failure decides on
 * its own, ahead of the statistics and without a resolved interval: FR-50 names a required-
 * guardrail failure and a statistically established regression as two independent triggers.
 */
import { pairedDecision } from "./stats.js";

interface ReleaseDecisionInput {
  readonly current_subject_id: string;
  readonly base_subject_id: string;
  readonly approved_patch_digest: string;
  readonly patch_digest: string;
  readonly required_owners: readonly string[];
  readonly approvals: readonly string[];
  readonly proof_eligible: boolean;
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
  if (!input.proof_eligible) return { kind: "refuse", reason: "not_eligible" };
  const unapproved = input.required_owners.some((owner) => !input.approvals.includes(owner));
  if (unapproved) return { kind: "refuse", reason: "approval_required" };
  if (input.patch_digest !== input.approved_patch_digest) return { kind: "refuse", reason: "digest_mismatch" };
  if (input.current_subject_id !== input.base_subject_id) return { kind: "refuse", reason: "stale_baseline" };
  return { kind: "apply" };
}

// -------------------------------------------------------------------------------------------
// release_apply's decision inputs.

/** Semver order: numeric core first, then a pre-release below its own release, then the
 *  pre-release text. Never a text sort — text puts 0.9.0 above 0.43.0, which made the "newest"
 *  release an old one. A version with no numeric core sorts below every version that has one. */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string): { core: number[] | null; pre: string } => {
    const m = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?/.exec(v.trim());
    return m ? { core: m[1].split(".").map(Number), pre: m[2] ?? "" } : { core: null, pre: "" };
  };
  const x = parse(a), y = parse(b);
  if (!x.core || !y.core) return (x.core ? 1 : 0) - (y.core ? 1 : 0);
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i += 1) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

interface VersionedSubject { readonly id: string; readonly declared_version: string }

/** The currently released subject: the newest, by semver, of whatever this eval system itself
 *  released and the catalog's own registered versions — the caller has already left out every
 *  version a rollback retracted. First wins a tie, so the caller lists this system's own released
 *  subject first: an equal version is the same release seen from both sides. */
export function newestSubject(subjects: readonly VersionedSubject[]): VersionedSubject | null {
  let best: VersionedSubject | null = null;
  for (const s of subjects) {
    if (!best || compareSemver(s.declared_version, best.declared_version) > 0) best = s;
  }
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
// release_verify's reduction and FR-50's rollback rule.

interface RollbackDecisionInput {
  readonly deltas: readonly number[];
  readonly guardrail_failed: boolean;
  readonly resamples: number;
  readonly seed: string;
  readonly confidence: number;
}

/** FR-50: true when a required guardrail has already failed, or when the released version's own
 *  paired per-case deltas against its predecessor show a bootstrap interval, at the protocol's own
 *  confidence, entirely below zero — an established regression, never merely "not an established
 *  improvement" (an interval that straddles zero is not itself grounds for rollback). */
export function rollbackDecision(input: RollbackDecisionInput): boolean {
  if (input.guardrail_failed) return true;
  const decision = pairedDecision(
    input.deltas, 0, { resamples: input.resamples, seed: input.seed, confidence: input.confidence });
  return decision.upper < 0;
}

interface VerifyReductionInput {
  readonly deltas: readonly number[];
  readonly guardrail_status: "pass" | "fail" | "not_established";
  readonly liveness_bound_reached: boolean;
  readonly resamples: number;
  readonly seed: string;
  readonly confidence: number;
}

type VerifyReduction =
  | { readonly kind: "escalate"; readonly decision: ReturnType<typeof pairedDecision> }
  | {
      readonly kind: "resolve";
      readonly verdict: "established" | "rolled_back" | "not_established";
      readonly reason: string;
      readonly decision: ReturnType<typeof pairedDecision>;
    };

/** `release_verify`'s verdict once every held case has its repeats. The guardrails are read
 *  FIRST: a failed guardrail rolls back whatever the interval says, resolved or not — waiting for
 *  more repeats while a released subject is failing a required guardrail is the one delay FR-50
 *  does not allow. An unmeasured guardrail is missing evidence (`not_established`), never a
 *  failure. Only then does an unresolved interval either escalate one more repeat or, at the
 *  liveness bound, resolve `not_established` — no rollback without evidence. */
export function verifyReduction(input: VerifyReductionInput): VerifyReduction {
  const decision = pairedDecision(
    input.deltas, 0, { resamples: input.resamples, seed: input.seed, confidence: input.confidence });
  if (input.guardrail_status === "fail") {
    return { kind: "resolve", verdict: "rolled_back", reason: "guardrail_failed", decision };
  }
  if (input.guardrail_status === "not_established") {
    return { kind: "resolve", verdict: "not_established", reason: "guardrails_not_established", decision };
  }
  if (decision.verdict === "unresolved") {
    return input.liveness_bound_reached
      ? { kind: "resolve", verdict: "not_established", reason: "verification_unresolved", decision }
      : { kind: "escalate", decision };
  }
  const regressed = rollbackDecision({
    deltas: input.deltas, guardrail_failed: false, resamples: input.resamples, seed: input.seed,
    confidence: input.confidence,
  });
  return regressed
    ? { kind: "resolve", verdict: "rolled_back", reason: "regression_established", decision }
    : { kind: "resolve", verdict: "established", reason: "no_regression_established", decision };
}
