/**
 * The control grant: what a stored controller decision authorises, issued by a trusted host
 * and redeemed at a public handler that re-derives every claim the record makes.
 *
 * WHY THE ENGINE IS HERE AND NOT IN THE SERVICE, for the same reason `host.ts` gives: a
 * fixture has to drive the engine the service drives, and `@zz/contracts` is the only layer
 * both can reach. `services/zz-core/src/host/` owns the part that is genuinely the service's
 * — which issuer components this release approves, and the guard that keeps the issuance
 * operation out of every door's registration list.
 *
 * UNREGISTERED IS NECESSARY AND NOT SUFFICIENT, and this file is written around that. A name
 * absent from a registry is hidden, not protected: a door added next year, a wildcard
 * dispatcher, an admin console that enumerates handlers by reflection, and the name is back.
 * So the protection is structural in three separate places, any one of which refuses alone:
 *
 *   · ISSUANCE TAKES A TRUSTED HOST CONTEXT, whose `trusted` field is the literal `true`. A
 *     typed caller cannot construct a context that is anything else, and an untyped one is
 *     refused by name below rather than having the field coerced — the same argument
 *     `registry.ts` makes for `body?: never`.
 *
 *   · ISSUANCE TAKES NOTHING ELSE. A decision id, and no profile, no artifact body, no
 *     targets. Everything the grant carries is derived from the stored decision, so there is
 *     no field a caller could fill in to widen what it gets.
 *
 *   · REDEMPTION RE-DERIVES EVERYTHING. The public handler does not trust the record it is
 *     handed an id for. It looks the record up server-side, re-hashes the decision's effect,
 *     re-resolves the dependency snapshot against the store's current revisions, and re-checks
 *     the issuing digest against the allowlist. A record whose effect digest was edited after
 *     issuance is refused there, not merely unissuable.
 *
 * GRANTS ARE PROTECTED SERVER RECORDS, NEVER BEARER PERMISSIONS. Nothing here returns a
 * signed blob a worker could carry. A grant is a row; a caller holds an id; the id is
 * meaningless without the row, and the row is re-checked at every redemption.
 *
 * A LEASE IS NOT A MUTATION GRANT. The distinction is in the effect the decision recorded, so
 * it cannot be talked around at the call site: a lease effect produces a grant whose
 * redemption for a mutation is refused, and no combination of arguments converts one into the
 * other.
 *
 * APPROVAL IS BY DIGEST, NOT BY NAME, which is why the record carries the issuing digest and
 * no component id. An id is a label; the digest is what somebody actually reviewed, and
 * looking the approval back up by it means a component renamed after issuance still redeems
 * and a component whose body changed does not.
 *
 * SNAKE_CASE ON {@link ControlGrant} AND {@link GrantClaim} ALONE. Every other type here is
 * camelCase like the rest of this package; those two are the shapes a handler reads
 * field-by-field out of a store and off a tool argument, and they are spelled the way the
 * tool arguments beside them are.
 */
import { createHash } from "node:crypto";

/** The internal issuance operation's one spelling, exported so the service's registration
 *  guard and this file's public dispatch cannot disagree about which name is internal. It is
 *  a constant and never a registration: nothing in this repository writes it beside a
 *  `registerTool(` call, and the guard in `services/zz-core/src/host/` exists to keep that
 *  true as doors are added. */
export const INTERNAL_GRANT_ISSUANCE = "issue_control_grant";

/** How long a grant stays redeemable when the decision does not say. Both this and the use
 *  count come from the decision rather than from the caller, because a caller that could ask
 *  for a longer life or another use is a caller that decides its own authority. */
const DEFAULT_TTL_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------------------
// Identities

/** A canonical id: lowercase, bounded, and deliberately incapable of spelling a path. The
 *  charset excludes the separators, the drive colon and the home tilde; `..` is refused
 *  separately below because `a..b` matches this and is still a traversal. */
const CANONICAL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * What a grant points at.
 *
 * A RESOURCE THAT DOES NOT EXIST YET IS RESERVED THROUGH THIS SAME SCHEME. The tempting
 * shortcut is to authorise a not-yet-created resource by the path it is going to be written
 * to, which hands the caller the one field it can vary — and a path is an alias, resolved by
 * whatever filesystem or router reads it, not an identity the store can check. So a
 * reservation is an id like any other, minted under a kind, and the authorisation names it.
 */
export type ResourceIdentity =
  | { readonly kind: string; readonly existing: string }
  | { readonly kind: string; readonly reserved: string };

/** Whether this identity names something already in the store or a reservation for something
 *  that is not created yet. */
const isReservation = (r: ResourceIdentity): boolean => "reserved" in r;

const identityId = (r: ResourceIdentity): string => ("existing" in r ? r.existing : r.reserved);

/**
 * One target string: a canonical resource identity and the operation it is authorised for.
 *
 * Throws rather than returning a refusal — targets are derived at issuance, inside a trusted
 * call, and a malformed one there is a defect in the stored decision rather than a caller's
 * mistake. {@link issueControlGrant} turns it back into a refusal at the boundary.
 */
export function canonicalTarget(resource: ResourceIdentity, operation: string): string {
  const id = identityId(resource);
  for (const [label, value] of [["kind", resource.kind], ["id", id], ["operation", operation]]) {
    if (!CANONICAL_ID.test(value)) {
      throw new Error(
        `ERROR: ${value || "(empty)"} is not a canonical ${label} — a target is built from ` +
        "canonical identities, and an identity that can spell a path is an alias somebody " +
        "else resolves rather than a name this store can check",
      );
    }
    if (value.includes("..")) {
      throw new Error(
        `ERROR: ${value} traverses — a ${label} carrying '..' is a path alias, and a grant ` +
        "never authorises one",
      );
    }
  }
  const slot = isReservation(resource) ? "reserved" : "existing";
  return `${resource.kind}/${slot}/${id}#${operation}`;
}

// ---------------------------------------------------------------------------------------
// What a decision records

/** What a decision authorises. `holds` is the whole lease/mutation distinction, carried as
 *  data on the decision so that no call site can decide it. */
export interface ControlEffect {
  readonly operation: string;
  readonly resource: ResourceIdentity;
  readonly holds: "lease" | "mutation";
}

/** One dependency the decision rests on, pinned to the revision it rested on. */
export interface DependencyPin {
  readonly id: string;
  readonly revision: number;
}

/** A controller decision, as stored. The grant is derived entirely from one of these, which
 *  is why issuance needs nothing from its caller but which one. */
export interface ControlDecision {
  readonly id: string;
  readonly profile: readonly string[];
  readonly effect: ControlEffect;
  readonly dependencies: readonly DependencyPin[];
  readonly useLimit: number;
  readonly ttlMs?: number;
}

/** One issuer this release approves: which component, and the digest of the body approved
 *  under that name. The same two-field shape `registry.ts` uses, and for the same reason —
 *  packaging a component is not approval of it. */
export interface ApprovedIssuer {
  readonly componentId: string;
  readonly digest: string;
}

// ---------------------------------------------------------------------------------------
// The grant record

/** How much of a grant is left. */
export interface GrantUse {
  readonly limit: number;
  readonly spent: number;
}

/**
 * A control grant, as the store holds it.
 *
 * EVERY FIELD IS DERIVED, NONE SUPPLIED. The issuing digest comes from the host context that
 * was checked against the allowlist, the decision id from the lookup that succeeded, and the
 * three digests from the decision's own contents. There is no field here a caller named.
 */
export interface ControlGrant {
  readonly id: string;
  readonly issuer_component_digest: string;
  readonly decision_id: string;
  readonly profile_digest: string;
  readonly effect_digest: string;
  readonly dependency_snapshot_ref: string;
  readonly targets: readonly string[];
  readonly permission_epoch: number;
  readonly expires_at: number;
  readonly use: GrantUse;
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The digest of what a decision authorises. Over the effect and nothing else, so that a
 *  record whose effect was edited after issuance no longer hashes to what it carries. */
const effectDigest = (e: ControlEffect): string =>
  sha(`${canonicalTarget(e.resource, e.operation)}:${e.holds}`);

/** The digest of the profile the decision was taken under. Sorted, so the same attributes in
 *  another order are the same profile. */
const profileDigest = (profile: readonly string[]): string =>
  sha([...profile].sort().join("\n"));

/** The reference a dependency snapshot is filed under: its pins, sorted, hashed. */
const dependencySnapshotRef = (pins: readonly DependencyPin[]): string =>
  sha([...pins].map((p) => `${p.id}@${p.revision}`).sort().join("\n"));

// ---------------------------------------------------------------------------------------
// The store

/** What the store is seeded with. Every field is server-side state; none of it is reachable
 *  from a tool argument. */
export interface GrantWorldSeed {
  readonly decisions: readonly ControlDecision[];
  readonly issuers: readonly ApprovedIssuer[];
  /** Each dependency's current revision, which is what a snapshot is re-resolved against. */
  readonly dependencies: ReadonlyMap<string, number>;
  /** Each target's current revision, keyed by the canonical target string, which is what a
   *  claim's `expected_revision` is compared to. */
  readonly revisions: ReadonlyMap<string, number>;
  readonly permissionEpoch: number;
}

/**
 * The protected record store.
 *
 * `grant` RETURNS A COPY, and that is not decoration. A handler handed the live row could
 * edit it, and the point of re-deriving digests at redemption is that the row is evidence
 * rather than authority. A copy also makes the tamper case testable without reaching into
 * private state through a back door the production path does not have.
 *
 * NO MODULE-SCOPE STATE, for the reason `createHost` gives: every instance is independent, so
 * a service composing one at boot and a fixture composing one in a test cannot interfere and
 * neither depends on the order the other ran in. The grant counter lives here for that reason.
 */
export interface GrantStore {
  decision(id: string): ControlDecision | undefined;
  /** The approval for a digest, or undefined. Keyed by digest rather than by component id
   *  because the digest is what was reviewed; see the header. */
  approvalOf(digest: string): ApprovedIssuer | undefined;
  snapshot(ref: string): readonly DependencyPin[] | undefined;
  dependencyRevision(id: string): number | undefined;
  revisionOf(target: string): number | undefined;
  permissionEpoch(): number;
  grant(id: string): ControlGrant | undefined;
  /** Issuance only. Files a freshly derived record under an id this store mints. */
  file(grant: Omit<ControlGrant, "id">): ControlGrant;
  /** Redemption only. Records one use against a filed grant. */
  spend(id: string): void;
}

/**
 * A store that can also be pushed around, which is what a test needs and a real one must not
 * owe anybody.
 *
 * SEPARATE FROM {@link GrantStore} because `tamper` on an interface named "the protected
 * record store" would oblige every future implementation to provide a way of rewriting a
 * protected record. The engine takes the narrow one; only {@link createGrantStore} returns
 * this. What the three hooks buy is the only evidence that matters here: the public handler's
 * re-derivation can be shown to refuse a record that no longer describes its decision, and no
 * amount of issuance-side checking demonstrates that.
 */
export interface ProbeableGrantStore extends GrantStore {
  /** Rewrite a filed record, as somebody with store access would. */
  tamper(id: string, patch: Partial<ControlGrant>): void;
  /** Move the permission epoch on, or one dependency's or target's revision. */
  advance(what: "epoch" | "dependency" | "target", id?: string): void;
  /** Withdraw an approval after the fact, to show a grant issued under it stops redeeming. */
  withdrawApproval(digest: string): void;
}

export function createGrantStore(seed: GrantWorldSeed): ProbeableGrantStore {
  const decisions = new Map(seed.decisions.map((d) => [d.id, d]));
  const approvals = new Map(seed.issuers.map((i) => [i.digest, i]));
  const dependencies = new Map(seed.dependencies);
  const revisions = new Map(seed.revisions);
  const snapshots = new Map<string, readonly DependencyPin[]>();
  const grants = new Map<string, ControlGrant>();
  let epoch = seed.permissionEpoch;
  let minted = 0;

  // The snapshot bodies are filed at construction from the decisions that pin them, so the
  // handler re-resolving a reference finds a body it did not have to be handed.
  for (const d of decisions.values()) {
    snapshots.set(dependencySnapshotRef(d.dependencies), d.dependencies);
  }

  return {
    decision: (id) => decisions.get(id),
    approvalOf: (digest) => approvals.get(digest),
    snapshot: (ref) => snapshots.get(ref),
    dependencyRevision: (id) => dependencies.get(id),
    revisionOf: (target) => revisions.get(target),
    permissionEpoch: () => epoch,
    grant: (id) => {
      const g = grants.get(id);
      return g && { ...g, use: { ...g.use }, targets: [...g.targets] };
    },
    file(draft) {
      minted += 1;
      const grant: ControlGrant = { ...draft, id: `grant/${draft.decision_id}/${minted}` };
      grants.set(grant.id, grant);
      return grant;
    },
    spend(id) {
      const g = grants.get(id);
      if (g) grants.set(id, { ...g, use: { ...g.use, spent: g.use.spent + 1 } });
    },
    tamper(id, patch) {
      const g = grants.get(id);
      if (g) grants.set(id, { ...g, ...patch });
    },
    advance(what, id) {
      if (what === "epoch") epoch += 1;
      else if (what === "dependency" && id) {
        dependencies.set(id, (dependencies.get(id) ?? 0) + 1);
      } else if (what === "target" && id) {
        revisions.set(id, (revisions.get(id) ?? 0) + 1);
      }
    },
    withdrawApproval(digest) {
      approvals.delete(digest);
    },
  };
}

// ---------------------------------------------------------------------------------------
// Issuance — trusted callers only, and nothing else supplied

/**
 * A trusted host context.
 *
 * `trusted` IS THE LITERAL `true`, so there is no value of this type that says otherwise and
 * a typed caller cannot express an untrusted issuance at all. The runtime check below is for
 * the untyped one, and it refuses by name rather than coercing — "ignored" and "accepted"
 * being indistinguishable to whoever sent it.
 */
export interface TrustedHostContext {
  readonly trusted: true;
  readonly componentDigest: string;
  readonly now: number;
}

/** What issuance accepts: which stored decision, and deliberately nothing else. `profile` and
 *  `artifact` are declared `never` so a typed caller cannot supply either; both are refused by
 *  name at runtime for the caller that is not typed. */
export interface GrantIssuanceRequest {
  readonly decisionId: string;
  readonly profile?: never;
  readonly artifact?: never;
}

/** Issuance's answer. A refusal is a result rather than a throw: the trusted caller is a
 *  composition root deciding what to do next, not a process that should fall over. */
export type GrantIssuance =
  | { readonly ok: true; readonly grant: ControlGrant; readonly reason?: undefined }
  | { readonly ok: false; readonly reason: string; readonly grant?: undefined };

const refuse = (reason: string): GrantIssuance => ({ ok: false, reason });

/**
 * Issue a grant for one stored decision, or refuse.
 *
 * THE ONLY WAY A GRANT COMES INTO EXISTENCE. There is no second constructor, no exported
 * record literal and no path that files one without passing every check below.
 */
export function issueControlGrant(
  store: GrantStore,
  ctx: TrustedHostContext,
  request: GrantIssuanceRequest,
): GrantIssuance {
  if ((ctx as { trusted?: unknown } | null | undefined)?.trusted !== true) {
    return refuse(
      "issuance is reachable only from a trusted host context — a context that does not " +
      "carry one is refused by name rather than treated as absent, because a caller that " +
      "can omit the field is a caller that can grant itself authority",
    );
  }
  if ("profile" in request) {
    return refuse(
      "a profile may not be supplied by the caller — the grant's profile digest is taken " +
      "from the stored decision, and a supplied one would be authority the decision never gave",
    );
  }
  if ("artifact" in request) {
    return refuse(
      "an artifact body may not be supplied by the caller — a grant authorises a canonical " +
      "target, never a body that arrived with the request",
    );
  }
  const approval = store.approvalOf(ctx.componentDigest);
  if (!approval) {
    return refuse(
      `no component approved at digest ${ctx.componentDigest.slice(0, 12)} — shipping a ` +
      "component is not approval of it, and a body nobody reviewed issues nothing",
    );
  }
  const decision = store.decision(request.decisionId);
  if (!decision) {
    return refuse(
      `no stored decision ${request.decisionId} — a grant is derived from a decision somebody ` +
      "recorded, so an id nothing was recorded under cannot produce one",
    );
  }
  const stale = decision.dependencies.filter((p) => store.dependencyRevision(p.id) !== p.revision);
  if (stale.length) {
    return refuse(
      `${stale.map((p) => p.id).join(", ")} is not at the revision the decision rested on — a ` +
      "grant is not issued over a dependency that moved since it was decided",
    );
  }
  let targets: readonly string[];
  try {
    targets = [canonicalTarget(decision.effect.resource, decision.effect.operation)];
  } catch (e) {
    return refuse(e instanceof Error ? e.message : String(e));
  }
  return {
    ok: true,
    grant: store.file({
      issuer_component_digest: approval.digest,
      decision_id: decision.id,
      profile_digest: profileDigest(decision.profile),
      effect_digest: effectDigest(decision.effect),
      dependency_snapshot_ref: dependencySnapshotRef(decision.dependencies),
      targets,
      permission_epoch: store.permissionEpoch(),
      expires_at: ctx.now + (decision.ttlMs ?? DEFAULT_TTL_MS),
      use: { limit: decision.useLimit, spent: 0 },
    }),
  };
}

// ---------------------------------------------------------------------------------------
// Redemption — the public handler, which trusts the record for nothing

/** What a caller hands the public claim handler: an id and the revision it believes the
 *  target sits at. Never the grant's contents — those are looked up. */
export interface GrantClaim {
  readonly grant_id: string;
  readonly expected_revision: number;
  /** What is being claimed. Absent means the grant's own single target, which is the ordinary
   *  case; supplied, it is checked against the targets rather than trusted. */
  readonly operation?: string;
}

export type ClaimOutcome =
  | { readonly ok: true; readonly target: string; readonly reason?: undefined }
  | { readonly ok: false; readonly reason: string; readonly target?: undefined };

const deny = (reason: string): ClaimOutcome => ({ ok: false, reason });

/**
 * Redeem a grant, or refuse — re-deriving every claim the stored record makes.
 *
 * THE ORDER IS DELIBERATE. Existence first, so a fabricated id never reaches a check that
 * could be made to say whether some other id exists. Then the decision it cites, then the
 * approval it was issued under, then the record's own digests against that decision, then the
 * world the decision rested on, and only then the ordinary freshness of the grant itself.
 * Each of the first four is a forgery of a different kind, and each refuses on its own.
 *
 * `now` IS A PARAMETER. The store has no clock, and a handler that reached for one would be a
 * handler whose expiry rule could not be tested without waiting.
 */
export function claimAgainstGrant(
  store: GrantStore,
  claim: GrantClaim,
  now: number,
): ClaimOutcome {
  const grant = store.grant(claim.grant_id);
  if (!grant) {
    return deny(
      `no grant ${claim.grant_id} is on file — a grant is a protected server record and an ` +
      "id that names none is a fabrication, whatever contents came with it",
    );
  }
  const decision = store.decision(grant.decision_id);
  if (!decision) {
    return deny(`${grant.id} cites decision ${grant.decision_id}, which is not on file`);
  }
  if (!store.approvalOf(grant.issuer_component_digest)) {
    return deny(
      `${grant.id} was issued at digest ${grant.issuer_component_digest.slice(0, 12)}, which ` +
      "this release does not approve — an approval withdrawn after issuance withdraws what " +
      "was issued under it",
    );
  }
  let decided: string;
  try {
    decided = effectDigest(decision.effect);
  } catch (e) {
    return deny(`${grant.id} cites a decision whose effect no longer hashes: ` +
                (e instanceof Error ? e.message : String(e)));
  }
  if (grant.effect_digest !== decided) {
    return deny(
      `${grant.id} no longer describes decision ${decision.id} — the record carries effect ` +
      `digest ${grant.effect_digest.slice(0, 12)} and the decision hashes to ` +
      `${decided.slice(0, 12)}, so one of the two was altered after ` +
      "issuance; the record is evidence, never authority",
    );
  }
  if (grant.profile_digest !== profileDigest(decision.profile)) {
    return deny(`${grant.id} carries a profile digest the stored decision does not produce`);
  }
  // THE TARGETS ARE RE-DERIVED, NOT READ. They are not covered by the effect digest — the
  // digest is over the decision's effect, and the targets are a rendering of it — so a record
  // whose `targets` array gained a second entry would otherwise hash correctly and authorise
  // a resource the decision never named. Deriving them here from the decision means the field
  // on the record is a convenience for readers and never the thing consulted.
  let derived: string;
  try {
    derived = canonicalTarget(decision.effect.resource, decision.effect.operation);
  } catch (e) {
    // A STORED DECISION THAT NO LONGER RENDERS IS A REFUSAL, NOT A CRASH. This is a public
    // handler: a throw here is an unhandled fault on a request somebody sent, and the caller
    // learns nothing it can act on. Unreachable for a decision that was well formed when the
    // grant was issued, and reachable the moment anything can edit one.
    return deny(`${grant.id} cites a decision that no longer renders a target: ` +
                (e instanceof Error ? e.message : String(e)));
  }
  if (grant.targets.length !== 1 || grant.targets[0] !== derived) {
    return deny(
      `${grant.id} lists ${grant.targets.join(", ") || "no target"} and decision ` +
      `${decision.id} authorises ${derived} — a target list that does not re-derive from the ` +
      "decision is a widening somebody wrote onto the record",
    );
  }
  const pins = store.snapshot(grant.dependency_snapshot_ref);
  if (!pins || dependencySnapshotRef(pins) !== grant.dependency_snapshot_ref) {
    return deny(
      `${grant.id} cites a dependency snapshot that does not resolve — a reference to a body ` +
      "nothing holds authorises nothing",
    );
  }
  const moved = pins.filter((p) => store.dependencyRevision(p.id) !== p.revision);
  if (moved.length) {
    return deny(
      `${moved.map((p) => p.id).join(", ")} moved since ${grant.id} was issued — the grant ` +
      "was decided over a world that no longer holds",
    );
  }
  if (grant.permission_epoch !== store.permissionEpoch()) {
    return deny(
      `${grant.id} was issued under permission epoch ${grant.permission_epoch} and the ` +
      `current epoch is ${store.permissionEpoch()} — permissions changed under it`,
    );
  }
  if (decision.effect.holds === "lease") {
    return deny(
      `${grant.id} holds a lease on ${grant.targets[0]}, and a lease is not a mutation ` +
      "grant — holding a resource and being authorised to change it are separate decisions",
    );
  }
  if (grantExpired(grant, now)) {
    return deny(`${grant.id} expired at ${grant.expires_at}`);
  }
  if (grant.use.spent >= grant.use.limit) {
    return deny(
      `${grant.id} is spent — ${grant.use.limit} use(s) issued, ${grant.use.spent} taken`);
  }
  if (claim.operation !== undefined && !derived.endsWith(`#${claim.operation}`)) {
    return deny(`${grant.id} does not authorise ${claim.operation}; it authorises ${derived}`);
  }
  const current = store.revisionOf(derived);
  if (current === undefined) {
    return deny(`${derived} has no revision on file, so ${claim.expected_revision} cannot be met`);
  }
  if (current !== claim.expected_revision) {
    return deny(
      `${derived} is at revision ${current} and the claim expects ${claim.expected_revision} ` +
      "— the resource moved since the caller read it",
    );
  }
  store.spend(grant.id);
  return { ok: true, target: derived };
}

/** Whether a grant's life has run out at `now`. Named rather than inlined so the comparison
 *  reads as the rule it is; `<=` because a grant whose last instant is now has had it. */
const grantExpired = (grant: ControlGrant, now: number): boolean => grant.expires_at <= now;
