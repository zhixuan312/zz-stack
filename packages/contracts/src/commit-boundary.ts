/**
 * The commit boundary: the protocol a predicate check and the effect it authorises must share,
 * described as steps and read back rather than asserted.
 *
 * DELIBERATE: the protocol is data — an ordered list of steps, each naming the store it fences
 * or touches — and every field of {@link CommitBoundary} is computed by walking it, never
 * declared. A boundary that stops being serialized stops reporting that it is.
 *
 * The three failures the walk detects:
 *
 *   · The check and the publish sit in different transactions, so another writer can commit
 *     between them and the publish lands on a world the predicate was never evaluated
 *     against. No fence interval contains both indices, and `serialized` is false.
 *   · The permission store is a separate store and the document fence says nothing about it.
 *     A grant checked against one epoch publishes while a revocation moves it, with the
 *     document lock honestly held throughout. `covers` is computed per store: a store is
 *     covered only when a fence on that store spans both the check and the publish.
 *   · A model call, or a backoff between attempts, happens with a lock held, so the lock's
 *     duration becomes the model's latency and a retry loop holds it as long as it keeps
 *     failing. `holdsLockAcrossModelCall` is true whenever any fence is open across either.
 *
 * The order the contract asks for — snapshot first, assess outside the locks, then recheck
 * and commit inside the boundary — is two more computed flags.
 */

// ---------------------------------------------------------------------------------------
// The protocol, as data

/**
 * One step.
 *
 * `snapshot` pins the dependency world (see `dependency-snapshot.ts`). `model_call` is any
 * assessment that leaves the process; `backoff` is the wait between attempts at one. `acquire`
 * and `release` open and close a fence on the named store — a lock, a serializable
 * transaction, a compare-and-set token: this module cares only that it spans, not what it is.
 * `read_fenced` reads a store's version under an open fence, which is what makes a publish
 * conditional on it. `predicate_check` re-resolves the snapshot; `publish_effect` writes.
 */
type StepKind =
  | "snapshot"
  | "model_call"
  | "backoff"
  | "acquire"
  | "release"
  | "read_fenced"
  | "predicate_check"
  | "publish_effect";

/** A step and the store it acts on, or null for the steps that act on no store. */
interface ProtocolStep {
  readonly kind: StepKind;
  readonly store: string | null;
}

/** An operation's described commit protocol. */
interface CommitProtocol {
  readonly operation: string;
  readonly steps: readonly ProtocolStep[];
}

/** What walking a protocol found. Every field is derived; none is declared. */
export interface CommitBoundary {
  readonly operation: string;
  /** A protocol exists for this operation. An undescribed operation is not a safe one. */
  readonly described: boolean;
  /** The store the effect lands in is fenced across both the governing predicate check and the
   *  publication. A fence on some other store spanning both is not serialization of this
   *  effect: two writers can still publish to an unfenced target concurrently. */
  readonly serialized: boolean;
  /** The stores whose own fence spans both of those steps — and only those. */
  readonly covers: readonly string[];
  /** A fence was open across a `model_call` or a `backoff`. Both count: a retry wait holds a
   *  lock exactly as a request does, and for longer. */
  readonly holdsLockAcrossModelCall: boolean;
  /** The dependency world was pinned before the first assessment. */
  readonly snapshotPrecedesAssessment: boolean;
  /** The governing predicate check comes after the last assessment, so the thing committed on
   *  is the world as of the commit rather than as of the snapshot. */
  readonly recheckAfterLastAssessment: boolean;
}

// ---------------------------------------------------------------------------------------
// Walking one

/** A closed or still-open fence on one store: the step index it opened at, and the index it
 *  closed at (the step count, when it never closed). */
interface Fence {
  readonly store: string;
  readonly from: number;
  readonly to: number;
}

const fencesOf = (steps: readonly ProtocolStep[]): readonly Fence[] => {
  const open = new Map<string, number>();
  const closed: Fence[] = [];
  steps.forEach((step, i) => {
    if (step.store === null) return;
    if (step.kind === "acquire" && !open.has(step.store)) open.set(step.store, i);
    if (step.kind === "release" && open.has(step.store)) {
      closed.push({ store: step.store, from: open.get(step.store) as number, to: i });
      open.delete(step.store);
    }
  });
  // DELIBERATE: a fence never released still spans everything after it. That defect is a
  // leak, not a gap in coverage, and this module does not catch leaks.
  for (const [store, from] of open) closed.push({ store, from, to: steps.length });
  return closed;
};

/**
 * Read a protocol back.
 *
 * DELIBERATE: takes a protocol rather than an operation name, so a probe can walk a broken one
 * and show each field come back the bad way. {@link boundaryOf} is this function applied to
 * the described protocols; inlining the computation there would make every field
 * unfalsifiable.
 */
function describeBoundary(protocol: CommitProtocol): CommitBoundary {
  const steps = protocol.steps;
  const publishIdx = steps.findIndex((s) => s.kind === "publish_effect");
  // The governing check is the last one before the publish. An earlier check that a model call
  // or a release came after is not what the effect was authorised by.
  let checkIdx = -1;
  for (let i = 0; i < (publishIdx === -1 ? steps.length : publishIdx); i += 1) {
    if (steps[i]?.kind === "predicate_check") checkIdx = i;
  }

  const fences = fencesOf(steps);
  const publishStore = publishIdx === -1 ? null : steps[publishIdx]?.store ?? null;
  const spans = (f: Fence, at: number): boolean => at >= f.from && at <= f.to;
  const covers =
    publishIdx === -1 || checkIdx === -1
      ? []
      : [...new Set(
          fences
            .filter((f) => spans(f, checkIdx) && spans(f, publishIdx))
            // A fence buys coverage of its store only if that store's version was read under
            // it. An open lock nobody read anything through fences a store the decision never
            // observed.
            .filter((f) => f.store === publishStore ||
              steps.some((s, i) => s.kind === "read_fenced" && s.store === f.store &&
                spans(f, i) && i <= checkIdx))
            .map((f) => f.store),
        )];

  const assessments = steps
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.kind === "model_call" || s.kind === "backoff");
  const holdsLockAcrossModelCall = assessments.some(({ i }) =>
    fences.some((f) => i > f.from && i < f.to));

  const snapshotIdx = steps.findIndex((s) => s.kind === "snapshot");
  const firstAssessment = assessments.length ? (assessments[0] as { i: number }).i : -1;
  const lastAssessment = assessments.length
    ? (assessments[assessments.length - 1] as { i: number }).i
    : -1;

  return {
    operation: protocol.operation,
    described: steps.length > 0,
    // DELIBERATE: not `covers.length > 0`. A fence on some other store spanning the check and
    // the publish covers that store honestly and leaves the target open, so the boundary
    // would report serialized while two writers race the effect.
    serialized: publishStore !== null && covers.includes(publishStore),
    covers,
    holdsLockAcrossModelCall,
    snapshotPrecedesAssessment:
      snapshotIdx !== -1 && (firstAssessment === -1 || snapshotIdx < firstAssessment),
    recheckAfterLastAssessment: checkIdx !== -1 && checkIdx > lastAssessment,
  };
}

// ---------------------------------------------------------------------------------------
// The described protocols

const DOCUMENT_STORE = "document_store";
const PERMISSION_STORE = "permission_store";

/**
 * The one operation described here: the commit that publishes an effect against a checked
 * predicate. An entry nobody commits through would be a protocol nothing keeps honest.
 *
 * In order: pin the world; assess, and wait between attempts, with nothing held; then take
 * both fences, read the permission epoch under its own fence, recheck, publish, and release in
 * reverse. The permission read is what makes `covers` include the separate store — without it
 * only the document lock is left.
 */
const PROTOCOLS: readonly CommitProtocol[] = [
  {
    operation: "action_complete",
    steps: [
      { kind: "snapshot", store: null },
      { kind: "model_call", store: null },
      { kind: "backoff", store: null },
      { kind: "model_call", store: null },
      { kind: "acquire", store: DOCUMENT_STORE },
      { kind: "acquire", store: PERMISSION_STORE },
      { kind: "read_fenced", store: PERMISSION_STORE },
      { kind: "read_fenced", store: DOCUMENT_STORE },
      { kind: "predicate_check", store: null },
      { kind: "publish_effect", store: DOCUMENT_STORE },
      { kind: "release", store: PERMISSION_STORE },
      { kind: "release", store: DOCUMENT_STORE },
    ],
  },
];

/**
 * The boundary an operation commits through.
 *
 * DELIBERATE: an operation with no described protocol comes back `described: false` and
 * `serialized: false`, not as a clean boundary with an empty step list. Nothing is known about
 * it, and the report of nothing known is not a pass.
 */
export function boundaryOf(operation: string): CommitBoundary {
  const protocol = PROTOCOLS.find((p) => p.operation === operation);
  return describeBoundary(protocol ?? { operation, steps: [] });
}

// ---------------------------------------------------------------------------------------
// Showing each field can come back the bad way

/** One probe row: a protocol variant and the three fields the contract turns on. */
export interface BoundaryProbeRow {
  readonly variant: string;
  readonly serialized: boolean;
  readonly covers: readonly string[];
  readonly holdsLockAcrossModelCall: boolean;
  /** What this variant is planted to demonstrate. */
  readonly fires: string;
}

const described = (): CommitProtocol => PROTOCOLS[0] as CommitProtocol;

const withSteps = (label: string, steps: readonly ProtocolStep[]): CommitProtocol =>
  ({ operation: label, steps });

/**
 * Four variants through {@link describeBoundary}: the real protocol, and one planted defect
 * per field.
 *
 * Three booleans that are always true are indistinguishable from three constants. Each row
 * below is a protocol that genuinely has the defect its name gives, walked by the same
 * function the real one is walked by.
 *
 * DELIBERATE: the model-call and backoff rows slice the real protocol by index, so reordering
 * it changes what they test. The lock they move an assessment inside is the real one, not an
 * imitation that could drift from it.
 *
 * `split_transaction` moves two fields: splitting the transaction drops `serialized` and
 * empties `covers`, because coverage is defined through the same spanning fence serialization
 * is. The other rows move one field each.
 */
export function boundaryDetectorProbe(): readonly BoundaryProbeRow[] {
  const real = described();
  const steps = real.steps;

  // The check commits, then the publish opens a second transaction. Another writer fits in the
  // gap and the predicate was never evaluated against the world the publish lands on.
  const split = withSteps("split_transaction", [
    ...steps.slice(0, 9),
    { kind: "release", store: PERMISSION_STORE },
    { kind: "release", store: DOCUMENT_STORE },
    { kind: "acquire", store: DOCUMENT_STORE },
    { kind: "publish_effect", store: DOCUMENT_STORE },
    { kind: "release", store: DOCUMENT_STORE },
  ]);

  // The permission epoch is read before the document lock is taken and nothing fences it.
  const permissionUnfenced = withSteps("permission_read_outside_the_fence", [
    { kind: "snapshot", store: null },
    { kind: "model_call", store: null },
    { kind: "acquire", store: DOCUMENT_STORE },
    { kind: "read_fenced", store: DOCUMENT_STORE },
    { kind: "predicate_check", store: null },
    { kind: "publish_effect", store: DOCUMENT_STORE },
    { kind: "release", store: DOCUMENT_STORE },
  ]);

  // The target of the publish is never fenced; a fence on the other store spans the check and
  // the publish, so `covers` is non-empty and two writers can still race the document. This is
  // why `serialized` is read off the publish store rather than off `covers.length`.
  const publishUnfenced = withSteps("publish_store_unfenced", [
    { kind: "snapshot", store: null },
    { kind: "model_call", store: null },
    { kind: "acquire", store: PERMISSION_STORE },
    { kind: "read_fenced", store: PERMISSION_STORE },
    { kind: "predicate_check", store: null },
    { kind: "publish_effect", store: DOCUMENT_STORE },
    { kind: "release", store: PERMISSION_STORE },
  ]);

  // The assessment moved inside the fence.
  const assessInside = withSteps("model_call_inside_the_fence", [
    { kind: "snapshot", store: null },
    ...steps.slice(4, 6),
    { kind: "model_call", store: null },
    ...steps.slice(6),
  ]);

  // Same lock, held across a retry wait instead of a request. Counted the same.
  const backoffInside = withSteps("backoff_inside_the_fence", [
    { kind: "snapshot", store: null },
    ...steps.slice(4, 6),
    { kind: "backoff", store: null },
    ...steps.slice(6),
  ]);

  const row = (variant: string, protocol: CommitProtocol, fires: string): BoundaryProbeRow => {
    const b = describeBoundary(protocol);
    return {
      variant,
      serialized: b.serialized,
      covers: b.covers,
      holdsLockAcrossModelCall: b.holdsLockAcrossModelCall,
      fires,
    };
  };

  return [
    row("the described protocol", real, "nothing — this is the arrangement that commits"),
    row("split_transaction", split, "serialized false, and covers empty with it"),
    row("permission_read_outside_the_fence", permissionUnfenced,
      "covers loses the separate permission store while the document lock is still held"),
    row("publish_store_unfenced", publishUnfenced,
      "serialized false although a fence spans the check and the publish — on the wrong store"),
    row("model_call_inside_the_fence", assessInside, "holdsLockAcrossModelCall true"),
    row("backoff_inside_the_fence", backoffInside,
      "holdsLockAcrossModelCall true, from a wait rather than a call"),
  ];
}
