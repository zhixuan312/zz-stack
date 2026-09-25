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
 * helpers below: `approvedOwners` (who approved, by membership), `newestVersion` (which version
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
  /** Whether the plugin's currently released subject is still the candidate's own base. */
  readonly base_is_current: boolean;
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
  /** Whether every held case has its repeats on both sides. Incomplete evidence can still roll
   *  back on a guardrail the runs collected so far already failed — nothing else. */
  readonly evidence_complete: boolean;
  readonly liveness_bound_reached: boolean;
  readonly resamples: number;
  readonly seed: string;
  readonly confidence: number;
}

type PairedDecision = ReturnType<typeof pairedDecision>;

type VerifyReduction =
  | { readonly kind: "pending" }
  | { readonly kind: "escalate"; readonly decision: PairedDecision }
  | {
      readonly kind: "resolve";
      readonly verdict: "established" | "rolled_back" | "not_established";
      readonly reason: string;
      /** Null only when no case had its repeats yet — a guardrail rollback on partial evidence. */
      readonly decision: PairedDecision | null;
    };

/** `release_verify`'s whole verdict, over whatever runs have been collected so far. The
 *  guardrails are read FIRST and over incomplete evidence too: a failed guardrail rolls back
 *  whatever the interval says, resolved or not, complete or not — waiting for more repeats (or
 *  for the liveness bound) while a released subject is visibly failing a required guardrail is the
 *  one delay FR-50 does not allow. Anything else on incomplete evidence is `pending`: the caller
 *  asks for the missing runs, or resolves `replays_unavailable` at the liveness bound. An
 *  unmeasured guardrail is missing evidence (`not_established`), never a failure. Only then does
 *  an unresolved interval either escalate one more repeat or, at the liveness bound, resolve
 *  `not_established` — no rollback without evidence. */
export function verifyReduction(input: VerifyReductionInput): VerifyReduction {
  const opts = { resamples: input.resamples, seed: input.seed, confidence: input.confidence };
  const decision = input.deltas.length ? pairedDecision(input.deltas, 0, opts) : null;
  if (input.guardrail_status === "fail") {
    return { kind: "resolve", verdict: "rolled_back", reason: "guardrail_failed", decision };
  }
  if (!input.evidence_complete) return { kind: "pending" };
  if (input.guardrail_status === "not_established") {
    return { kind: "resolve", verdict: "not_established", reason: "guardrails_not_established", decision };
  }
  if (!decision) return { kind: "resolve", verdict: "not_established", reason: "no_paired_cases", decision };
  if (decision.verdict === "unresolved") {
    return input.liveness_bound_reached
      ? { kind: "resolve", verdict: "not_established", reason: "verification_unresolved", decision }
      : { kind: "escalate", decision };
  }
  const regressed = rollbackDecision({ ...opts, deltas: input.deltas, guardrail_failed: false });
  return regressed
    ? { kind: "resolve", verdict: "rolled_back", reason: "regression_established", decision }
    : { kind: "resolve", verdict: "established", reason: "no_regression_established", decision };
}
