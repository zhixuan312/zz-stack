/**
 * The dependency snapshot a decision is fenced against, and the verdict that says whether it
 * still holds.
 *
 * THE WITHDRAWN ASSUMPTION THIS FILE EXISTS TO KILL: that a record-local digest is enough. A
 * target's own bytes, its content hash and its etag can all stand still while the thing the
 * decision actually rested on moves underneath it — the source set it was derived from, the
 * manifest that governed it, the qualification that made its assessor admissible, the
 * permission epoch that made the caller entitled to it. A digest over the record cannot see
 * any of that, because none of it is in the record. Pinning the record is pinning the wrong
 * object.
 *
 * SO THE SNAPSHOT IS OVER AN EXPLICIT, CLOSED SET, and the record-local digest is carried as a
 * WITNESS rather than as a fence: {@link DependencySnapshot.recordLocalDigest} is reported and
 * never compared, so nothing downstream can mistake "the bytes are the same" for "the decision
 * still holds".
 *
 * THE TRAP THE AUDIT HERE IS SHAPED AROUND. If validity were decided by re-reading the keys
 * the snapshot happened to write, then a snapshot that silently dropped a dependency would
 * produce a validity check that could not notice the drop — a detector sharing its mechanism's
 * blind spot passes exactly when the mechanism is broken. Two things follow, and both are
 * load-bearing:
 *
 *   · {@link revalidate} iterates {@link DEPENDENCY_KINDS} — the closed set — and NOT the
 *     snapshot's own entries. A kind with no entry is a coverage gap, and a coverage gap is a
 *     dependency that cannot be fenced, which pauses.
 *   · {@link auditCoverage} compares that closed set against the verbatim contract prose in
 *     {@link CONTRACT_INPUTS}, which is not derived from the set and cannot be edited by
 *     editing it. Dropping a kind leaves an unclaimed clause; inventing one leaves a phrase
 *     the contract never wrote. Its findings ride on the snapshot and PAUSE the verdict, so
 *     the audit changes outcomes rather than decorating a report.
 *
 * OPACITY. The verdict a host evaluates is {@link VersionPredicate}[]: a dependency name and a
 * token, compared for string equality and nothing else. Nothing here asks the host to know
 * what a manifest is, what a qualification means, or which stage of any flow it is serving.
 */

// ---------------------------------------------------------------------------------------
// The contract's own words, and the closed set derived from them

/**
 * The Inputs clause of this boundary's contract, verbatim. It is the audit's independent
 * side: {@link DEPENDENCY_KINDS} is checked against THIS, so a dependency dropped from the set
 * shows up as a clause nothing claims. Edit this only to match a re-agreed contract.
 */
const CONTRACT_INPUTS =
  "a dependency snapshot covering artifact heads and etags, evidence-set membership, " +
  "retrieval recipe, scope, analyzer and index-progress evidence where the decision relied " +
  "on search coverage, accepted commitments, flow manifest, profile, controller, renderer, " +
  "interpretation, qualification and the current permission epoch";

/** One dependency in the closed set: the opaque name a host sees, the field a world supplies
 *  it under, and the words the contract names it with — the last only so the audit can find
 *  it in {@link CONTRACT_INPUTS}. */
interface DependencyKind {
  readonly name: string;
  readonly field: string;
  readonly phrase: string;
}

/**
 * EVERY DEPENDENCY, ENUMERATED ONCE. A snapshot writes an entry for each of these, always —
 * a dependency a world says nothing about is recorded `absent`, never omitted, because an
 * omission is indistinguishable from a dependency nobody thought of.
 */
const DEPENDENCY_KINDS = [
  { name: "artifact_head", field: "head", phrase: "artifact heads" },
  { name: "artifact_etag", field: "etag", phrase: "etags" },
  { name: "evidence_set", field: "sources", phrase: "evidence-set membership" },
  { name: "retrieval_recipe", field: "retrieval_recipe", phrase: "retrieval recipe" },
  { name: "scope", field: "scope", phrase: "scope" },
  { name: "analyzer", field: "analyzer", phrase: "analyzer" },
  { name: "index_progress", field: "index_progress", phrase: "index-progress evidence" },
  { name: "commitments", field: "commitments", phrase: "accepted commitments" },
  { name: "flow_manifest", field: "manifest", phrase: "flow manifest" },
  { name: "profile", field: "profile", phrase: "profile" },
  { name: "controller", field: "controller", phrase: "controller" },
  { name: "renderer", field: "renderer", phrase: "renderer" },
  { name: "interpretation", field: "interpretation", phrase: "interpretation" },
  { name: "qualification", field: "qualification", phrase: "qualification" },
  { name: "permission_epoch", field: "permission_epoch", phrase: "the current permission epoch" },
] as const satisfies readonly DependencyKind[];

/** The field names a world may carry, derived from the set above so the two cannot drift. */
type DependencyField = (typeof DEPENDENCY_KINDS)[number]["field"];

// ---------------------------------------------------------------------------------------
// What a world supplies

/**
 * One dependency's value as the world reports it.
 *
 * `uncertain` is the contract's "uncertain relevance invalidates the broader affected
 * objective rather than being omitted" — the value is pinned like any other AND marked as
 * widening, so when it moves the verdict says the whole objective is affected rather than one
 * narrow claim. `unfenceable` is the other representable outcome: the world knows the
 * dependency is live and cannot produce a token for it, which pauses rather than passing.
 */
export type DependencyValue =
  | string
  | number
  | readonly string[]
  | { readonly uncertain: string | number | readonly string[] }
  | { readonly unfenceable: string };

/**
 * What a decision rested on, as the caller can describe it.
 *
 * EVERY FIELD IS OPTIONAL AND THAT IS NOT LAXITY. A decision genuinely rests on a subset; the
 * closed set is what makes the subset legible, because the fields left out are recorded as
 * `absent` by name rather than vanishing. `content_hash` is deliberately NOT one of the
 * dependency fields — it is the record-local digest, kept as a witness and never fenced on.
 */
export type DependencyWorld =
  & { readonly [K in DependencyField]?: DependencyValue }
  & { readonly content_hash?: string };

// ---------------------------------------------------------------------------------------
// The snapshot

/** Whether a dependency was pinned, recorded as not relied on, or could not be fenced. */
export type PinState = "pinned" | "absent" | "unfenceable";

/** One dependency's entry. There is one of these per {@link DEPENDENCY_KINDS} member in every
 *  snapshot, whatever the world said. */
export interface DependencyPinEntry {
  readonly dependency: string;
  readonly state: PinState;
  /** The opaque token, or null when the state is not `pinned`. */
  readonly token: string | null;
  /** Relevance was uncertain, so a move invalidates the broader objective. */
  readonly widens: boolean;
  /** Why this one cannot be fenced, when it cannot. */
  readonly note: string | null;
}

/** An opaque equality predicate: the host compares `token` to the token it re-derives and
 *  needs to know nothing else about either side. */
export interface VersionPredicate {
  readonly dependency: string;
  readonly token: string;
}

/**
 * One way the closed set and the contract prose disagree.
 *
 * `clause_ambiguous` is the audit checking its own granularity, and it is here because the
 * first version of this file did not have it and was SILENT on a planted fault. The contract
 * writes "qualification and the current permission epoch" as one comma-separated clause, so
 * splitting on commas alone left one clause claimed by two dependencies — and dropping either
 * of them left the clause still claimed, by the other. A clause no finer than the set it is
 * meant to police cannot police it. Clauses are now split on "and" as well, and a clause two
 * dependencies still share is reported rather than trusted.
 */
export interface CoverageFinding {
  readonly issue: "phrase_absent" | "clause_unclaimed" | "clause_ambiguous";
  readonly subject: string;
  readonly detail: string;
}

/** A dependency snapshot: one entry per dependency, the opaque predicates a host evaluates,
 *  the record-local digest as a witness, and whatever the coverage audit found. */
export interface DependencySnapshot {
  readonly pins: readonly DependencyPinEntry[];
  readonly predicates: readonly VersionPredicate[];
  /** Reported, never compared. See this file's header. */
  readonly recordLocalDigest: string | null;
  readonly coverage: readonly CoverageFinding[];
}

const isUnfenceable = (v: DependencyValue): v is { readonly unfenceable: string } =>
  typeof v === "object" && v !== null && !Array.isArray(v) && "unfenceable" in v;

const isUncertain = (v: DependencyValue): v is { readonly uncertain: string | number | readonly string[] } =>
  typeof v === "object" && v !== null && !Array.isArray(v) && "uncertain" in v;

/**
 * The opaque token for a value. Sets are sorted, so the same membership in another order is
 * the same token and a member added or removed is a different one; a number is tagged
 * separately from the string that spells it, so an epoch of 2 and a revision string "2" can
 * never collide into a false "unchanged".
 */
const tokenOf = (value: string | number | readonly string[]): string => {
  if (Array.isArray(value)) return `set:${[...value].map(String).sort().join("\u001f")}`;
  if (typeof value === "number") return `epoch:${value}`;
  return `ver:${String(value)}`;
};

/**
 * Whether the closed set and the contract prose still describe the same dependencies.
 *
 * TAKES ITS INPUTS RATHER THAN READING THE CONSTANTS, so a probe can hand it a mutilated set
 * and show the finding fire. An audit that can only ever be run on the one arrangement it
 * passes for is a constant with a function's name.
 */
function auditCoverage(
  kinds: readonly DependencyKind[],
  sentence: string,
): readonly CoverageFinding[] {
  const findings: CoverageFinding[] = [];
  const body = sentence.includes("covering ")
    ? sentence.slice(sentence.indexOf("covering ") + "covering ".length)
    : sentence;
  for (const kind of kinds) {
    if (!body.includes(kind.phrase)) {
      findings.push({
        issue: "phrase_absent",
        subject: kind.name,
        detail: `the set names a dependency the contract does not: no clause says "${kind.phrase}"`,
      });
    }
  }
  const clauses = body
    .split(",")
    .flatMap((c) => c.split(" and "))
    .map((c) => c.trim())
    .filter(Boolean);
  for (const clause of clauses) {
    const claimants = kinds.filter((k) => clause.includes(k.phrase));
    if (claimants.length === 0) {
      findings.push({
        issue: "clause_unclaimed",
        subject: clause,
        detail: "the contract names this dependency and no member of the closed set covers it, " +
          "so a snapshot would silently omit it",
      });
    } else if (claimants.length > 1) {
      findings.push({
        issue: "clause_ambiguous",
        subject: clause,
        detail: `${claimants.map((k) => k.name).join(" and ")} both claim this clause, so ` +
          "dropping either one would leave it claimed and this audit would not see the loss",
      });
    }
  }
  return findings;
}

/**
 * Pin a world.
 *
 * Runs before any assessment and holds no lock — it is a read of what the decision rested on,
 * and the whole protocol in `commit-boundary.ts` depends on this half being cheap enough to
 * do outside the fence.
 */
export function snapshot(world: DependencyWorld): DependencySnapshot {
  const pins: DependencyPinEntry[] = [];
  const predicates: VersionPredicate[] = [];
  for (const kind of DEPENDENCY_KINDS) {
    const raw = (world as Record<string, DependencyValue | undefined>)[kind.field];
    if (raw === undefined) {
      pins.push({
        dependency: kind.name,
        state: "absent",
        token: null,
        widens: false,
        note: "the world reported nothing under this dependency, so the decision did not rest on it",
      });
      continue;
    }
    if (isUnfenceable(raw)) {
      pins.push({
        dependency: kind.name,
        state: "unfenceable",
        token: null,
        // Not widened: an unfenceable dependency pauses the work outright, and pause is not a
        // narrower or broader invalidation for `widens` to qualify.
        widens: false,
        note: raw.unfenceable,
      });
      continue;
    }
    const widens = isUncertain(raw);
    const token = tokenOf(isUncertain(raw) ? raw.uncertain : raw);
    pins.push({ dependency: kind.name, state: "pinned", token, widens, note: null });
    predicates.push({ dependency: kind.name, token });
  }
  return {
    pins,
    predicates,
    recordLocalDigest: world.content_hash ?? null,
    coverage: auditCoverage(DEPENDENCY_KINDS, CONTRACT_INPUTS),
  };
}

// ---------------------------------------------------------------------------------------
// The verdict

/**
 * `invalidated` — something the decision rested on demonstrably moved.
 * `paused` — something cannot be fenced at all, so current-live consistency cannot be claimed
 *   either way. The contract's word for this case is pause, and pausing is not passing.
 * `valid` — every dependency in the closed set is accounted for and every token still matches.
 *
 * INVALIDATED OUTRANKS PAUSED when both apply: a known move is the more actionable answer, and
 * both are equally not-valid, so nothing is softened by preferring it.
 */
export type ValidityState = "valid" | "invalidated" | "paused";

/** What {@link revalidate} concluded, in terms a host can act on without interpreting any of
 *  the dependency names. Not published, because its only producer is not: a verdict type a
 *  consumer can name and has no way to obtain is a surface that describes nothing. */
interface ValidityVerdict {
  readonly state: ValidityState;
  /** Dependency names whose token no longer matches. */
  readonly moved: readonly string[];
  /** Dependency names that could not be fenced, including any the snapshot failed to cover. */
  readonly unfenceable: readonly string[];
  /** A dependency of uncertain relevance moved, so the broader objective is what is affected. */
  readonly widened: boolean;
  readonly detail: string;
}

/**
 * Re-resolve a snapshot against the world as it is now.
 *
 * ITERATES THE CLOSED SET, NOT THE SNAPSHOT. That is the one design decision in this file
 * worth defending: reading the snapshot's own entries would make a snapshot with a hole
 * indistinguishable from a snapshot of a world with fewer dependencies, and the hole is
 * precisely what a validity check has to be able to see.
 *
 * NOT PUBLISHED. {@link stillValid} is the whole of what this module offers a caller, and it is
 * the form the one consumer asks in. Publishing the verdict as well would put a second, richer
 * answer on the door that nothing reads — and a reader would have to guess which of the two the
 * host is supposed to act on. The coverage probe below reaches it as a sibling, not as a door.
 */
function revalidate(snap: DependencySnapshot, world: DependencyWorld): ValidityVerdict {
  const moved: string[] = [];
  const unfenceable: string[] = [];
  let widened = false;

  for (const finding of snap.coverage) {
    unfenceable.push(finding.subject);
  }

  for (const kind of DEPENDENCY_KINDS) {
    const entry = snap.pins.find((p) => p.dependency === kind.name);
    if (entry === undefined) {
      unfenceable.push(kind.name);
      continue;
    }
    const raw = (world as Record<string, DependencyValue | undefined>)[kind.field];
    if (entry.state === "unfenceable") {
      unfenceable.push(kind.name);
      continue;
    }
    if (entry.state === "absent") {
      // A dependency the decision was not recorded as resting on, now carrying a value, is the
      // uncertain-relevance case: nothing here can prove it was irrelevant, so it invalidates
      // the broader objective rather than being waved through.
      if (raw !== undefined) {
        moved.push(kind.name);
        widened = true;
      }
      continue;
    }
    if (raw === undefined) {
      moved.push(kind.name);
      widened = widened || entry.widens;
      continue;
    }
    if (isUnfenceable(raw)) {
      unfenceable.push(kind.name);
      continue;
    }
    const now = tokenOf(isUncertain(raw) ? raw.uncertain : raw);
    if (now !== entry.token) {
      moved.push(kind.name);
      widened = widened || entry.widens || isUncertain(raw);
    }
  }

  if (moved.length) {
    return {
      state: "invalidated",
      moved,
      unfenceable,
      widened,
      detail: `${moved.join(", ")} moved since the snapshot; the target's own bytes say nothing ` +
        "about that, which is why the record-local digest is a witness and not the fence",
    };
  }
  if (unfenceable.length) {
    return {
      state: "paused",
      moved,
      unfenceable,
      widened,
      detail: `${unfenceable.join(", ")} cannot be fenced, so the work pauses rather than ` +
        "claiming it is consistent with what is live now",
    };
  }
  return { state: "valid", moved, unfenceable, widened, detail: "every pinned dependency still matches" };
}

/** The boolean form, for a host that only needs the predicate. Every non-`valid` state is
 *  false — a paused grant is not a redeemable one. */
export function stillValid(snap: DependencySnapshot, world: DependencyWorld): boolean {
  return revalidate(snap, world).state === "valid";
}

// ---------------------------------------------------------------------------------------
// Showing the audit can fail

/** One probe row: an arrangement, what the audit said about it, and what the verdict became. */
export interface CoverageProbeRow {
  readonly arrangement: string;
  readonly findings: readonly string[];
  readonly verdict: ValidityState;
}

/**
 * Four arrangements through {@link auditCoverage} and {@link revalidate}, to show the audit
 * distinguishes them.
 *
 * WITHOUT THE FAILING ROWS THIS FILE COULD NOT TELL A DETECTOR FROM A CONSTANT. Row 1 is the
 * real set and must come back clean; rows 2 and 3 are the two ways the set can stop describing
 * the contract; row 4 carries a coverage finding through to a paused verdict, which is what
 * makes the audit load-bearing rather than a report nobody reads.
 */
export function snapshotCoverageProbe(): readonly CoverageProbeRow[] {
  const world: DependencyWorld = { etag: "e1", sources: ["s1"] };
  const clean = snapshot(world);
  const dropped = DEPENDENCY_KINDS.filter((k) => k.name !== "qualification");
  const invented: readonly DependencyKind[] = [
    ...DEPENDENCY_KINDS,
    { name: "weather", field: "weather", phrase: "yesterday's weather" },
  ];
  const holed: DependencySnapshot = {
    ...clean,
    pins: clean.pins.filter((p) => p.dependency !== "permission_epoch"),
  };
  const say = (f: readonly CoverageFinding[]): readonly string[] =>
    f.map((x) => `${x.issue}:${x.subject}`);
  // Carrying the mutilated set's findings on an otherwise clean snapshot is how rows 2 and 3
  // show what the audit COSTS: the verdict pauses, rather than the findings being printed
  // somewhere while the grant redeems anyway.
  const carrying = (f: readonly CoverageFinding[]): ValidityState =>
    revalidate({ ...clean, coverage: f }, world).state;
  const droppedFindings = auditCoverage(dropped, CONTRACT_INPUTS);
  const inventedFindings = auditCoverage(invented, CONTRACT_INPUTS);
  return [
    {
      arrangement: "the declared closed set against the contract clause",
      findings: say(clean.coverage),
      verdict: revalidate(clean, world).state,
    },
    {
      arrangement: "one dependency dropped from the closed set",
      findings: say(droppedFindings),
      verdict: carrying(droppedFindings),
    },
    {
      arrangement: "a dependency the contract never names, added to the set",
      findings: say(inventedFindings),
      verdict: carrying(inventedFindings),
    },
    {
      arrangement: "a snapshot missing an entry the closed set requires",
      findings: [`uncovered:${DEPENDENCY_KINDS.length - holed.pins.length}`],
      verdict: revalidate(holed, world).state,
    },
  ];
}
