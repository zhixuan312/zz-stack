/**
 * A driveable stand-in for a door: which operations a role may call, what calling one does,
 * and the one issuance entry point that is not among them.
 *
 * `@zz/contracts` sits below `services/` and cannot import from it, so {@link registeredTools}
 * and {@link callTool} are a registry of this file's own making. A name missing from this list
 * is evidence about this list, not about what the real doors register.
 * COUPLED: that question is answered by reading their source for `registerTool(` and by
 * `services/zz-core/src/host/grant-issuance.ts`, which refuses a registration list carrying
 * the issuance name at composition time.
 *
 * What it does prove: that the issuance engine is reachable from a trusted host context and
 * produces a real grant; that the public claim handler refuses a fabricated id, an altered
 * record and a stale world; that a lease does not redeem as a mutation; and that a control
 * decision holding progression leaves recording evidence, recording an approval and redeeming
 * an authorised repair all still possible.
 *
 * COUPLED: `scripts/gate/checks/issuer-unreachable.ts` drives the issuing side and
 * `scripts/gate/checks/grant-claim-refusals.ts` the redeeming side, through
 * {@link grantFixtureWorld}. Each refusal case is produced against a control that redeems, so
 * a handler refusing everything cannot satisfy them.
 *
 * The roles are cumulative and genuinely different: an admin sees an operation a member does
 * not, and a superadmin one an admin does not. Neither extra operation is issuance, and no
 * role maps to trust — the only thing producing a {@link TrustedHostContext} is
 * {@link issueForTest}, and no tool handler below calls it.
 *
 * DELIBERATE: one module-scope world, against this package's usual rule. The three exports are
 * separate top-level functions with no handle passed between them, so a grant issued by one
 * has to be redeemable by another. {@link resetGrantFixture} gives a caller a clean world, and
 * a check that moves the epoch or the clock calls it at both ends.
 */
import {
  canonicalTarget,
  claimAgainstGrant,
  createGrantStore,
  issueControlGrant,
  INTERNAL_GRANT_ISSUANCE,
  type ControlDecision,
  type ControlGrant,
  type GrantIssuance,
  type ProbeableGrantStore,
  type ResourceIdentity,
  type TrustedHostContext,
} from "./control-grant.js";

/** The three roles, least to most. Order is the privilege order, and `atLeast` below reads it
 *  as such rather than hardcoding comparisons. */
const ROLES = ["member", "admin", "superadmin"] as const;
export type FixtureRole = (typeof ROLES)[number];

const atLeast = (held: string, needed: FixtureRole): boolean =>
  ROLES.indexOf(held as FixtureRole) >= ROLES.indexOf(needed);

// ---------------------------------------------------------------------------------------
// The seeded world

/** The digest of the one component this release approves as an issuer. A fixed string rather
 *  than a hash: what is demonstrated is that the allowlist is consulted. `moduleDigest` in
 *  `host.ts` owns how a body is hashed. */
const APPROVED_ISSUER_DIGEST = "0".repeat(64);

/** A component that ships in the same release and was never approved. */
const UNAPPROVED_ISSUER_DIGEST = "f".repeat(64);

const WORK: ResourceIdentity = { kind: "record", existing: "w1" };
const NOT_YET_CREATED: ResourceIdentity = { kind: "record", reserved: "res.one" };

/**
 * The stored decisions. `d1` is the authorised repair the declared check issues against: a
 * mutation on an existing record, two uses, resting on one dependency. `d2` is the same target
 * under a lease, so "a lease is not a mutation grant" is a demonstrable refusal. `d3`
 * authorises something that does not exist yet, reserved through the canonical identity scheme
 * rather than named by the path it will be written to.
 */
const DECISIONS: readonly ControlDecision[] = [
  {
    id: "d1",
    profile: ["operator", "on-call"],
    effect: { operation: "repair", resource: WORK, holds: "mutation" },
    dependencies: [{ id: "dep.alpha", revision: 3 }, { id: "dep.beta", revision: 1 }],
    useLimit: 2,
  },
  {
    id: "d2",
    profile: ["operator"],
    effect: { operation: "hold", resource: WORK, holds: "lease" },
    dependencies: [{ id: "dep.alpha", revision: 3 }],
    useLimit: 1,
  },
  {
    id: "d3",
    profile: ["operator"],
    effect: { operation: "publish", resource: NOT_YET_CREATED, holds: "mutation" },
    dependencies: [],
    useLimit: 1,
  },
];

/** Which work items have their progression held by a control decision. Exactly one operation
 *  below consults it. */
const HELD = new Set(["w1"]);

export interface FixtureWorld {
  readonly store: ProbeableGrantStore;
  readonly filed: string[];
  readonly evidence: { work: string; ref: string }[];
  readonly approvals: { work: string; by: string }[];
  readonly advanced: string[];
  now: number;
}

let world: FixtureWorld | null = null;

function seed(): FixtureWorld {
  const revisions = new Map<string, number>();
  for (const d of DECISIONS) {
    revisions.set(canonicalTarget(d.effect.resource, d.effect.operation), 4);
  }
  return {
    store: createGrantStore({
      decisions: DECISIONS,
      issuers: [{ componentId: "control-issuer", digest: APPROVED_ISSUER_DIGEST }],
      dependencies: new Map([["dep.alpha", 3], ["dep.beta", 1]]),
      revisions,
      permissionEpoch: 7,
    }),
    filed: [],
    evidence: [],
    approvals: [],
    advanced: [],
    now: 1_000_000,
  };
}

const current = (): FixtureWorld => (world ??= seed());

/** Discard the world so the next call builds a fresh one. */
export function resetGrantFixture(): void {
  world = null;
}

/** The world itself, for a caller that needs to move the clock, move a revision, withdraw an
 *  approval or rewrite a filed record — each a thing somebody with server access can do and
 *  the public handler has to survive. */
export function grantFixtureWorld(): FixtureWorld {
  return current();
}

// ---------------------------------------------------------------------------------------
// Issuance — the one trusted entry point, and not a tool

/** What {@link issueForTest} takes. `trustedHost` stands in for being called from the
 *  composition root rather than from a request; no argument here widens what the grant
 *  covers. */
export interface IssueForTestRequest {
  readonly trustedHost: boolean;
  readonly decisionId: string;
  /** An unapproved issuing component, to show the allowlist is consulted rather than assumed. */
  readonly unapprovedIssuer?: boolean;
}

/**
 * Issue a grant the way the composition root would, or refuse.
 *
 * This is the only place a trusted context is constructed in this fixture, and it is reached
 * by importing a function — never by naming an operation, never through {@link callTool}, and
 * never by holding a role. `trustedHost: false` builds the context an untyped caller would
 * send and is refused by the engine.
 */
export function issueForTest(request: IssueForTestRequest): GrantIssuance {
  const w = current();
  const ctx = {
    trusted: request.trustedHost,
    componentDigest: request.unapprovedIssuer
      ? UNAPPROVED_ISSUER_DIGEST
      : APPROVED_ISSUER_DIGEST,
    now: w.now,
  } as unknown as TrustedHostContext;
  const issued = issueControlGrant(w.store, ctx, { decisionId: request.decisionId });
  if (issued.ok) w.filed.push(issued.grant.id);
  return issued;
}

// ---------------------------------------------------------------------------------------
// The registry, and the dispatch that has no entry for issuance

/** One registered operation as a registry lists it. */
export interface RegisteredTool {
  readonly name: string;
  readonly minRole: FixtureRole;
  readonly summary: string;
}

export interface ToolOutcome {
  readonly ok: boolean;
  readonly reason?: string;
  readonly value?: unknown;
}

const ok = (value?: unknown): ToolOutcome => ({ ok: true, value });
const no = (reason: string): ToolOutcome => ({ ok: false, reason });

/** One registered operation: what a registry lists about it, and the body that runs. The two
 *  are one record, so an operation cannot be callable and unlisted. */
interface Registration {
  readonly minRole: FixtureRole;
  readonly summary: string;
  readonly run: (w: FixtureWorld, args: Record<string, unknown>) => ToolOutcome;
}

const str = (args: Record<string, unknown>, key: string): string =>
  typeof args[key] === "string" ? (args[key] as string) : "";

/**
 * Whether progression is held for this work item.
 *
 * DELIBERATE: `run_advance` asks; `evidence_record`, `approval_record` and `action_claim` do
 * not. A hold that also stopped anybody recording what they found, approving the fix or
 * redeeming a repair they were authorised for would suppress the evidence against itself.
 */
const progressionHeld = (work: string): boolean => HELD.has(work);

const REGISTRY: Readonly<Record<string, Registration>> = {
  evidence_record: {
    minRole: "member",
    summary: "record what was found against a work item",
    run(w, args) {
      const work = str(args, "work");
      const ref = str(args, "ref");
      if (!work || !ref) return no("evidence_record needs a work item and a reference");
      w.evidence.push({ work, ref });
      return ok({ recorded: w.evidence.length });
    },
  },
  approval_record: {
    minRole: "member",
    summary: "record a person's approval of a work item",
    run(w, args) {
      const work = str(args, "work");
      const by = str(args, "by");
      if (!work || !by) return no("approval_record needs a work item and an approver");
      w.approvals.push({ work, by });
      return ok({ approvals: w.approvals.length });
    },
  },
  control_evaluate: {
    minRole: "member",
    summary: "report where a work item stands and whether progression is held",
    run(_w, args) {
      const work = str(args, "work");
      if (!work) return no("control_evaluate needs a work item");
      return ok({ work, progression_held: progressionHeld(work) });
    },
  },
  run_advance: {
    minRole: "member",
    summary: "move a work item forward, which a hold refuses",
    run(w, args) {
      const work = str(args, "work");
      if (!work) return no("run_advance needs a work item");
      if (progressionHeld(work)) {
        return no(
          `progression on ${work} is held by a control decision — recording evidence, ` +
          "recording an approval and redeeming an authorised repair are all still open",
        );
      }
      w.advanced.push(work);
      return ok({ advanced: work });
    },
  },
  action_claim: {
    minRole: "member",
    summary: "redeem a grant somebody was issued, by its id",
    run(w, args) {
      const grantId = str(args, "grant_id");
      if (!grantId) return no("action_claim needs a grant id");
      const revision = args.expected_revision;
      if (typeof revision !== "number") {
        return no("action_claim needs the revision the caller believes the target sits at");
      }
      // The contents are not read off the request. Whatever else arrived with the call is
      // ignored: the handler looks the record up server-side and re-derives every claim it
      // makes, so a caller carrying a plausible-looking grant body gets as far as one carrying
      // an id alone.
      const outcome = claimAgainstGrant(
        w.store,
        {
          grant_id: grantId,
          expected_revision: revision,
          operation: typeof args.operation === "string" ? args.operation : undefined,
        },
        w.now,
      );
      return outcome.ok ? ok({ target: outcome.target }) : no(outcome.reason);
    },
  },
  grant_list: {
    minRole: "admin",
    summary: "list filed grants, masked and read-only",
    // Read-only and masked, and still not a way to reach issuance. Enumeration is the
    // privilege an admin has here; minting is not a privilege any role has.
    run(w) {
      const filed = w.filed
        .map((id) => w.store.grant(id))
        .filter((g): g is ControlGrant => g !== undefined);
      return ok(filed.map((g) => ({
        id: g.id,
        decision_id: g.decision_id,
        targets: g.targets,
        effect_digest: `${g.effect_digest.slice(0, 12)}…`,
        use: g.use,
      })));
    },
  },
  issuer_allowlist_read: {
    minRole: "superadmin",
    summary: "report how many components this release approves as issuers",
    run(w) {
      return ok({
        approved: w.store.approvalOf(APPROVED_ISSUER_DIGEST) ? 1 : 0,
        note: "reading which components may issue is not issuing",
      });
    },
  },
};

/**
 * Every operation this registry carries, at or below `role`. The listing and the dispatch are
 * one table, so an operation cannot be callable and unlisted.
 */
export function registeredTools(role: string): readonly RegisteredTool[] {
  return Object.entries(REGISTRY)
    .filter(([, r]) => atLeast(role, r.minRole))
    .map(([name, r]) => ({ name, minRole: r.minRole, summary: r.summary }));
}

/**
 * Call one operation as `role`, or be refused.
 *
 * The refusal for issuance is structural: there is no branch above this lookup testing for the
 * issuance name, and {@link REGISTRY} has no entry for it, so it is refused by the same line
 * that refuses any unregistered name. The message says which case it is; the control flow does
 * not consult the name to get there.
 *
 * A role is never trust. Nothing below maps `role` to a {@link TrustedHostContext}; the most a
 * role buys is a longer listing.
 */
export function callTool(
  role: string,
  name: string,
  args: Record<string, unknown> = {},
): ToolOutcome {
  const registration = Object.hasOwn(REGISTRY, name) ? REGISTRY[name] : undefined;
  if (!registration) {
    return no(
      `no operation ${name} is registered on this door` +
      (name === INTERNAL_GRANT_ISSUANCE
        ? " — grant issuance is internal, reached only from a trusted host context after " +
          "a stored controller decision, and carrying an admin credential does not confer it"
        : ""),
    );
  }
  if (!atLeast(role, registration.minRole)) {
    return no(
      `${name} is registered for ${registration.minRole} and above; ${role} does not carry it`);
  }
  return registration.run(current(), args);
}
