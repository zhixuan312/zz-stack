/**
 * Commit-result reconciliation: what a caller may conclude from each of the three shapes the
 * mutation kernel can reply with, COMPUTED from the reply rather than asserted by the branch
 * that produced it.
 *
 * THE THREE REPLIES ARE THE WHOLE VOCABULARY. `MutationOutcomeSchema` in
 * `tenant-information.ts` is a discriminated union on `committed` with exactly three arms, and
 * this module adds no fourth. In particular a committed write whose read model has not caught
 * up is NOT a fourth kind of answer: `projection: "pending"` and `history_export: "pending"`
 * describe derived data lagging behind a durable transaction, so they become follow-up work
 * attached to an `applied` reconciliation and never a state of their own. The moment lag gets
 * its own top-level result, every caller has to decide for itself whether that result means
 * the write happened — and half of them will decide wrong.
 *
 * THE CANONICAL NO-OP IS DURABLE. `committed: true, changed: false` with a null
 * `transaction_id` and a null `commit_sequence` is what the kernel returns when the requested
 * edit was already the state of the artifact: nothing was written, so there is no transaction
 * and no sequence to name. The contract permits it and this module accepts it as `applied`.
 * What it must not do is paper over the nulls — minting a transaction id so the record looks
 * uniform, or defaulting the sequence to `0` because a number reads better than a null, puts
 * a reference in the ledger that names nothing and cannot be followed back.
 *
 * WHY THERE IS AN AUDIT AND NOT FOUR BOOLEANS. `invented`, `replay`, `substitutedEtag` and
 * `newIdempotencyKey` are all negative: every one of them is a claim that reconciliation did
 * NOT do something. A field assigned `false` by the same branch that decided what to do
 * satisfies every assertion anybody will ever write about it and detects nothing, because the
 * branch is reporting on itself. So reconciliation happens in two halves that do not share a
 * belief:
 *
 *   · {@link planFor} reads the outcome and decides — a state, the references to carry, the
 *     follow-up work, and the request (if any) to send next. It sets none of the four flags.
 *   · {@link audit} takes the raw outcome and that plan and compares them. It does not know
 *     which branch built the plan, and it enumerates the plan's OWN keys rather than a list of
 *     fields somebody remembered to write down — so a branch that fills in a field the no-op
 *     path leaves null, or alters one it was supposed to copy, or adds a reference from
 *     nowhere, is caught by the same comparison in every case.
 *
 * {@link reconcileDetectorProbe} plants one fault per flag into the REAL plans and shows each
 * detector fire, because four booleans that are always false are indistinguishable from four
 * constants and a reader cannot tell which they are looking at.
 */

import type { MutationError, MutationIndeterminate, MutationResult } from "./tenant-information.js";

// ---------------------------------------------------------------------------------------
// What arrives

/**
 * The refusal arm as it arrives at this boundary.
 *
 * `committed` and `message` come from {@link MutationError} so there is no second copy of
 * them. `code` is widened to `string` on purpose: `MutationErrorSchema` is what rejects an
 * unrecognised code at the parse boundary, and downstream of that the kernel is still a
 * separate process that may be a version ahead. A code this build has never heard of is a
 * definite refusal — the caller's write did not happen — and the honest reconciliation of it
 * is `failed`, not a crash and not an indeterminate.
 */
export interface CommitRefusal extends Omit<MutationError, "code"> {
  readonly code: string;
}

/** A reply from the mutation kernel: committed, refused, or of unknown commit status. */
export type CommitOutcome = MutationResult | CommitRefusal | MutationIndeterminate;

/**
 * The caller's own side of the same operation — everything the kernel's reply cannot carry.
 *
 * The reply names what the kernel knows. It does not know which `expected_etag` the request
 * was formed against, nor, for a committed result, which idempotency key it was sent under,
 * nor whether the caller's post-commit bookkeeping afterwards succeeded. All three decide
 * what reconciliation should do, so all three come from here.
 *
 * `control_record: "failed"` is the post-commit control-record update that did not land. It
 * is repaired FROM the durable transaction the kernel already committed; re-running the
 * mutation to produce a second copy of a record that already exists is the defect, not the
 * repair.
 */
export interface OriginalOperation {
  readonly idempotency_key?: string;
  readonly expected_etag?: string;
  readonly control_record?: "current" | "failed";
}

// ---------------------------------------------------------------------------------------
// What comes back

/**
 * The references a durable write carries forward. Every field is COPIED from the outcome; a
 * null here means the kernel reported null and reconciliation left it alone.
 *
 * All six are nullable, including `artifact_id` and `etag` which the committed arm always
 * carries — because {@link audit} reads this record key by key, and a shape whose nulls are
 * declared per-branch would give the audit a different set of keys to compare depending on
 * which branch ran.
 */
export interface DurableWrite {
  readonly transaction_id: string | null;
  readonly artifact_id: string | null;
  readonly revision: number | null;
  readonly content_hash: string | null;
  readonly etag: string | null;
  readonly commit_sequence: number | null;
}

/**
 * One piece of work reconciliation asks for next.
 *
 * `await_projection` and `await_history_export` are catch-up on derived data — they change
 * nothing in the store and they say nothing about whether the write landed. `repair_control_record`
 * rewrites the caller's own record from `transaction_id`. `resolve_commit_status` asks the
 * kernel what became of `transaction_id`, under the idempotency key the original request
 * already used. `refresh_and_reintend` is the one step that hands the work back: the artifact
 * must be re-read and a NEW intended edit formed, because the edit that was refused was
 * reasoned against a version that no longer exists.
 *
 * `dispatch_mutation` re-performs the business effect. It is listed because a plan that
 * schedules one has to be expressible for {@link audit} to catch it; nothing in
 * {@link planFor} produces one.
 */
export interface FollowUpStep {
  readonly kind:
    | "await_projection"
    | "await_history_export"
    | "repair_control_record"
    | "resolve_commit_status"
    | "refresh_and_reintend"
    | "dispatch_mutation";
  /** The durable transaction this step works from, or null when it works from none. */
  readonly transaction_id: string | null;
  /** The idempotency identity this step acts under, or null when it acts under none. */
  readonly idempotency_key: string | null;
}

/**
 * A request reconciliation proposes sending. The slot exists so the audit has something to
 * read; {@link planFor} never fills it, and the reason is the whole point of the stale-etag
 * rule — a refusal for a stale `expected_etag` is not a transport failure to paper over, it
 * is the store saying the caller reasoned about a version that has since moved. The repair is
 * to look again and decide again, which happens above this module and comes back as a
 * different request.
 */
export interface ProposedRequest {
  readonly expected_etag: string | null;
  readonly idempotency_key: string | null;
}

/** What reconciliation decided, before anything has checked it. */
export interface ReconciliationPlan {
  /**
   * `applied` — the write is durable, including the canonical no-op, and including a commit
   * whose projection has not caught up. `failed` — a definite refusal; the write did not
   * happen and will not happen without a new decision. `reconciling` — the commit status is
   * unknown and must be established against the transaction that was already started.
   */
  readonly state: "applied" | "failed" | "reconciling";
  /** The original transaction and result references, and only where the write was durable. */
  readonly durable: DurableWrite | null;
  readonly followUp: readonly FollowUpStep[];
  readonly nextRequest: ProposedRequest | null;
}

/** A plan, plus what comparing it against the reply it came from found. */
export interface Reconciliation extends ReconciliationPlan {
  /** A carried reference is not the one the kernel reported — minted, defaulted or altered. */
  readonly invented: boolean;
  /** Which references, named, so the report is actionable rather than a bare boolean. */
  readonly inventedFields: readonly string[];
  /** The business effect is scheduled again although the kernel said it is durable. */
  readonly replay: boolean;
  /** A request is proposed carrying an `expected_etag` other than the one the original was
   *  formed against — the newest etag slipped into the old edit. */
  readonly substitutedEtag: boolean;
  /** Some step acts under an idempotency key that is not the original operation's. */
  readonly newIdempotencyKey: boolean;
}

// ---------------------------------------------------------------------------------------
// Deciding

/**
 * The refusal code that means the caller's `expected_etag` no longer matches — the one
 * `mutationErrorCodes` declares for it, and no synonym. A code this build does not recognise
 * still reconciles to a definite refusal; it simply gets no step telling the caller what to
 * re-read, because nothing here knows that it should.
 */
const STALE_ETAG_CODE = "REVISION_CONFLICT";

const step = (
  kind: FollowUpStep["kind"],
  transaction_id: string | null,
  idempotency_key: string | null,
): FollowUpStep => ({ kind, transaction_id, idempotency_key });

/**
 * Read the reply and decide.
 *
 * Sets no flag and makes no claim about its own honesty — that is {@link audit}'s job, and
 * keeping the two apart is what makes the flags mean anything.
 */
function planFor(outcome: CommitOutcome, original: OriginalOperation): ReconciliationPlan {
  if (outcome.committed === true) {
    // Copied field for field. The no-op's nulls travel as nulls: there was no transaction and
    // no sequence, and a record that says so can be read back, while a record that invents
    // them cannot be told apart from a real write until somebody follows the reference.
    const durable: DurableWrite = {
      transaction_id: outcome.transaction_id,
      artifact_id: outcome.artifact_id,
      revision: outcome.revision,
      content_hash: outcome.content_hash,
      etag: outcome.etag,
      commit_sequence: outcome.commit_sequence,
    };

    // Catch-up work, attached to a durable write rather than standing in for one. The state
    // above is already `applied` and none of these can change it.
    const followUp: FollowUpStep[] = [];
    if (outcome.projection === "pending") {
      followUp.push(step("await_projection", outcome.transaction_id, null));
    }
    if (outcome.history_export === "pending") {
      followUp.push(step("await_history_export", outcome.transaction_id, null));
    }
    // Repaired from the transaction that already committed. Note this step carries the
    // ORIGINAL key when there is one: it is bookkeeping about an operation that finished, not
    // a new operation.
    if (original.control_record === "failed") {
      followUp.push(step("repair_control_record", outcome.transaction_id,
        original.idempotency_key ?? null));
    }

    return { state: "applied", durable, followUp, nextRequest: null };
  }

  if (outcome.committed === "unknown") {
    // The transaction was started and its fate is unknown. Asking what became of THAT
    // transaction, under the key it was already sent with, is the only thing that can settle
    // it — a fresh key would ask the store a question about an operation it has never seen,
    // and the store would answer by performing it.
    return {
      state: "reconciling",
      durable: null,
      followUp: [step("resolve_commit_status", outcome.transaction_id,
        original.idempotency_key ?? outcome.idempotency_key)],
      nextRequest: null,
    };
  }

  // A refusal is definite: nothing was written. A stale etag additionally means the reasoning
  // behind the edit is out of date, which is work for whoever formed the edit and not
  // something this module can do on their behalf — hence a step, and still no request.
  return {
    state: "failed",
    durable: null,
    followUp: outcome.code === STALE_ETAG_CODE
      ? [step("refresh_and_reintend", null, null)]
      : [],
    nextRequest: null,
  };
}

// ---------------------------------------------------------------------------------------
// Checking

/**
 * Compare a plan against the reply it was built from.
 *
 * TAKES THE PLAN, so the probe can hand it one with a planted fault and show each flag come
 * back the bad way. It is given no hint about which branch built what, and it reads the plan's
 * own keys rather than a remembered list of fields — the distinction that matters, because a
 * check written as "the no-op path leaves these three null" shares the no-op path's idea of
 * which three, and a branch that fills in a fourth is invisible to it.
 */
function audit(
  outcome: CommitOutcome,
  original: OriginalOperation,
  plan: ReconciliationPlan,
): Reconciliation {
  const reported = outcome as unknown as Record<string, unknown>;

  // Every reference the plan carries, paired with the name of the field it claims to have
  // come from. Enumerated from the plan, so a key added to the carried record — or a step
  // naming a transaction — is compared without anybody extending this function.
  const carried: (readonly [string, unknown])[] = [];
  if (plan.durable !== null) carried.push(...Object.entries(plan.durable));
  for (const s of plan.followUp) carried.push(["transaction_id", s.transaction_id] as const);

  // A carried value must be the value the kernel reported under that name. This catches three
  // different defects with one comparison: a null filled in (the reply said null, the plan
  // says `0`), a reference minted (the reply has no such field at all, so the lookup is
  // `undefined`), and a copied value altered (`revision: 3` against a reported `2`).
  const inventedFields = [...new Set(
    carried
      .filter(([, value]) => value !== null && value !== undefined)
      .filter(([name, value]) => reported[name] !== value)
      .map(([name]) => name),
  )];

  // Scoped to a committed reply, deliberately. Re-sending an indeterminate operation UNDER ITS
  // OWN KEY is what an idempotency key is for and is not a duplicate effect; re-sending it
  // under a new one is, and that is `newIdempotencyKey` below rather than this flag saying the
  // same thing twice. After a definite refusal nothing landed, so nothing can be repeated.
  //
  // BOTH SLOTS, because a plan has two ways to ask for the write again. Reading only the step
  // list misses the proposed request entirely, and a request that reuses the original etag and
  // the original key trips no other flag — it is a clean-looking duplicate of a write the
  // kernel has already told us is durable.
  const replay = outcome.committed === true
    && (plan.nextRequest !== null || plan.followUp.some((s) => s.kind === "dispatch_mutation"));

  // No proposed request can be innocent of substitution unless it carries the etag the
  // original was formed against: a changed etag with an unchanged edit IS the substitution.
  const substitutedEtag = plan.nextRequest !== null
    && plan.nextRequest.expected_etag !== (original.expected_etag ?? null);

  // The original key, from the caller where it is known and otherwise from the reply — the
  // indeterminate arm is the one shape that carries its own. Null when neither has it, which
  // makes any key the plan names a key from nowhere.
  const originalKey = original.idempotency_key
    ?? (outcome.committed === "unknown" ? outcome.idempotency_key : null);
  const proposedKeys = [
    ...plan.followUp.map((s) => s.idempotency_key),
    plan.nextRequest === null ? null : plan.nextRequest.idempotency_key,
  ];
  const newIdempotencyKey = proposedKeys.some((k) => k !== null && k !== originalKey);

  return {
    ...plan,
    invented: inventedFields.length > 0,
    inventedFields,
    replay,
    substitutedEtag,
    newIdempotencyKey,
  };
}

/**
 * Reconcile one reply from the mutation kernel.
 *
 * The second argument is what the reply cannot carry — see {@link OriginalOperation}. It is
 * optional because the indeterminate arm carries its own identity and the committed arm needs
 * none to be recorded; supply it whenever the original `expected_etag` or key is known, and
 * always when the post-commit control record failed.
 *
 * NOT A TOOL: `reconcile` here is the English verb for settling what a mutation reply means,
 * and a pure function in this package. The MCP tool of that name was renamed
 * `knowledge_reconcile`; this reconciles a commit result against the operation that produced
 * it and reaches no door at all.
 */
export function reconcile(
  outcome: CommitOutcome,
  original: OriginalOperation = {},
): Reconciliation {
  return audit(outcome, original, planFor(outcome, original));
}

// ---------------------------------------------------------------------------------------
// Showing each flag can come back the bad way

/** One probe row: a plan variant and the four negative flags read off it. */
export interface ReconcileProbeRow {
  readonly variant: string;
  readonly state: string;
  readonly invented: boolean;
  readonly inventedFields: readonly string[];
  readonly replay: boolean;
  readonly substitutedEtag: boolean;
  readonly newIdempotencyKey: boolean;
  /** What this variant is planted to demonstrate. */
  readonly fires: string;
}

const NO_OP: MutationResult = {
  committed: true, changed: false, transaction_id: null, artifact_id: "a1",
  revision: null, content_hash: "h1", etag: "e1", commit_sequence: null,
  projection: "current", history_export: "current",
};

const LAGGING: MutationResult = {
  committed: true, changed: true, transaction_id: "t1", artifact_id: "a1",
  revision: 2, content_hash: "h2", etag: "e2", commit_sequence: 9,
  projection: "pending", history_export: "pending",
};

const REFUSED: CommitRefusal = { committed: false, code: STALE_ETAG_CODE, message: "x" };

const UNKNOWN: MutationIndeterminate = {
  committed: "unknown", code: "COMMIT_STATUS_UNKNOWN", transaction_id: "t2",
  idempotency_key: "k2", message: "x",
};

/** The original request behind {@link REFUSED}: formed against `e1`, under key `k1`. */
const REFUSED_ORIGIN: OriginalOperation = { expected_etag: "e1", idempotency_key: "k1" };

const withDurable = (plan: ReconciliationPlan, patch: Partial<DurableWrite>): ReconciliationPlan =>
  ({ ...plan, durable: { ...(plan.durable as DurableWrite), ...patch } });

const withFollowUp = (plan: ReconciliationPlan, followUp: readonly FollowUpStep[]): ReconciliationPlan =>
  ({ ...plan, followUp });

/**
 * The real plans, and one planted defect per flag put through the same {@link audit}.
 *
 * EVERY VARIANT IS THE REAL PLAN WITH ONE FIELD MOVED. None is a hand-built imitation, so a
 * change to {@link planFor} changes what these rows are testing rather than leaving them
 * agreeing with a version of the code that no longer exists.
 *
 * The first four rows are the plans as built; they are here so the table shows the flags are
 * false when the work was done correctly and not merely false always. The rest each have the
 * defect their name gives:
 *
 *   · `no_op_defaults_the_commit_sequence` is the one this module was written against — `0`
 *     instead of null, because a number reads better in a ledger column. The audit notices
 *     because it compares the carried value against what the kernel reported, not against the
 *     no-op branch's own idea of which fields it left alone.
 *   · `lagging_commit_alters_the_revision` carries `3` where the reply said `2`. Nothing is
 *     null anywhere in that row, which is what separates this audit from one that only asks
 *     whether a null became a value.
 */
export function reconcileDetectorProbe(): readonly ReconcileProbeRow[] {
  const noOp = planFor(NO_OP, {});
  const lagging = planFor(LAGGING, {});
  const refused = planFor(REFUSED, REFUSED_ORIGIN);
  const unknown = planFor(UNKNOWN, {});

  const row = (
    variant: string,
    outcome: CommitOutcome,
    original: OriginalOperation,
    plan: ReconciliationPlan,
    fires: string,
  ): ReconcileProbeRow => {
    const r = audit(outcome, original, plan);
    return {
      variant,
      state: r.state,
      invented: r.invented,
      inventedFields: r.inventedFields,
      replay: r.replay,
      substitutedEtag: r.substitutedEtag,
      newIdempotencyKey: r.newIdempotencyKey,
      fires,
    };
  };

  return [
    row("the canonical no-op", NO_OP, {}, noOp,
      "nothing — a durable no-op, with its nulls left as nulls"),
    row("a commit whose projection lags", LAGGING, {}, lagging,
      "nothing — catch-up work on an applied write, not a fourth result"),
    row("a definite refusal", REFUSED, REFUSED_ORIGIN, refused,
      "nothing — failed, and no request proposed"),
    row("an unknown commit", UNKNOWN, {}, unknown,
      "nothing — reconciling against t2 under the key it was already sent with"),

    row("no_op_defaults_the_commit_sequence", NO_OP, {},
      withDurable(noOp, { commit_sequence: 0 }),
      "invented: commit_sequence — a null the kernel reported, filled in with a plausible 0"),
    row("no_op_mints_a_transaction_id", NO_OP, {},
      withDurable(noOp, { transaction_id: "txn-a1" }),
      "invented: transaction_id — a reference that names no transaction"),
    row("lagging_commit_alters_the_revision", LAGGING, {},
      withDurable(lagging, { revision: 3 }),
      "invented: revision — a copied value changed, with no null involved anywhere"),
    row("unknown_step_mints_a_transaction_id", UNKNOWN, {},
      withFollowUp(unknown, [step("resolve_commit_status", "t9", "k2")]),
      "invented: transaction_id — reconciling against a transaction that was never started"),

    row("control_record_repaired_by_re_running_it", LAGGING, { control_record: "failed" },
      withFollowUp(lagging, [step("dispatch_mutation", "t1", null)]),
      "replay — the effect repeated to repair bookkeeping about the effect"),
    row("durable_write_resent_with_its_own_etag", LAGGING, { expected_etag: "e2" },
      { ...lagging, nextRequest: { expected_etag: "e2", idempotency_key: null } },
      "replay — a duplicate of a durable write that trips nothing else: same etag, no new key"),

    row("stale_etag_resent_with_the_newest_etag", REFUSED, REFUSED_ORIGIN,
      { ...refused, nextRequest: { expected_etag: "e2", idempotency_key: "k1" } },
      "substitutedEtag — the same edit, re-sent against a version nobody reasoned about"),

    row("unknown_redispatched_under_a_new_key", UNKNOWN, {},
      withFollowUp(unknown, [step("dispatch_mutation", "t2", "k2-retry")]),
      "newIdempotencyKey — a key the store has never seen, so it performs the write again"),
  ];
}
