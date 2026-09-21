/**
 * THE RUNTIME ADAPTER PORT: what this platform needs from anything that can carry out a piece
 * of work on its behalf, written so that no part of it is shaped around the runtime that
 * happened to be integrated first.
 *
 * WHY A PORT AT ALL, when one runtime works today. Not because a second one is planned — that
 * would be speculation, and this repository does not build for it. Because the platform had
 * already begun to encode one runtime's accidents as if they were facts about running work:
 * that a unit of work has a transcript file, that the file's last line means the work ended,
 * that a stop signal sent is a worker stopped. None of those is true of running work in
 * general and two of them are not reliably true of that runtime either. A port is how the
 * platform says which of those it actually depends on, and the second adapter in this folder
 * is how it finds out whether the answer was honest — a claim of portability that no second
 * implementation has ever been run against is a claim, not a property.
 *
 * THE HONESTY RULES ARE THE SUBSTANCE, and where a rule can be made unrepresentable rather
 * than merely documented, it is:
 *
 *   · {@link DispatchAck.completed} is typed `never`. Dispatching work returns an identifier
 *     for work that has started, and there is no value an adapter could put in that field.
 *     A runtime that answers a submission with a result is answering about something else.
 *   · {@link CancelOutcome} is a union in which only the confirmed arm carries
 *     `treatedAsStopped`. A request that was sent is a request that was sent; the arm that
 *     says a worker stopped has to name the record the claim rests on.
 *   · {@link CancellationLimits.lease_expiry_proves_stop} is typed `false`. A lease is a
 *     bound on how long somebody may hold a claim, and it expires whether or not the holder
 *     is still working. No adapter may declare otherwise.
 *   · {@link Observation} pairs its completeness with its receipt: only the confirmed arm has
 *     one, so "the feed went quiet" cannot be reported in the shape of "the work finished",
 *     and {@link Observation.elapsed_at_least_ms} is named for the floor it is.
 *   · An unsupported capability is DECLARED, through {@link DeclaredUnsupported}, whose
 *     `simulated` field is typed `false`. An adapter says what it cannot do; it does not
 *     quietly answer as though it could.
 *
 * WHAT THE PORT DELIBERATELY DOES NOT KNOW: how a runtime names its operations, where it
 * keeps its record of them, what a unit of activity is called, or how time is written down.
 * Every one of those differs between the two adapters shipped beside this file, and none of
 * them appears in the vocabulary below.
 */
import { createHash } from "node:crypto";

import type { UsageTotal } from "./usage.js";

/** The six operations an adapter serves. Ordered as a caller meets them, and closed: an
 *  adapter with a seventh has invented private protocol the platform cannot drive. */
export const RUNTIME_OPERATIONS = [
  "capabilities", "load_method", "dispatch", "observe", "cancel", "resume",
] as const;

/**
 * The capabilities an adapter may declare, and the whole reason the list is closed: a
 * capability an adapter never mentions is not supported. Silence is not a yes, and
 * {@link admitToRuntime} reports it separately from an explicit refusal, because "we have
 * never said" and "we cannot" are different answers and only one of them is informative.
 */
export const RUNTIME_CAPABILITIES = [
  /** `cancel` can reach `confirmed_stopped` — the runtime reports that a worker stopped. */
  "confirm_stop",
  /** `cancel` can at least deliver a request the runtime acknowledges receiving. */
  "request_stop",
  /** Stopped or interrupted work can be continued rather than started again from nothing. */
  "resume_after_stop",
  /** `observe` reports activity while work is still running, not only after it ends. */
  "live_observation",
  /** The runtime issues its own end-of-work record, distinct from its activity feed. */
  "completion_receipt",
  /** The runtime reports what the work consumed. */
  "usage_accounting",
  /** Consumption arrives as parent AND child records, which is where double counting lives. */
  "subagent_usage_records",
] as const;
export type RuntimeCapability = (typeof RUNTIME_CAPABILITIES)[number];

/** What a bound asset is FOR, in the platform's vocabulary rather than the runtime's. A
 *  runtime that calls it a skill, a prompt, a policy or a job payload still binds one of
 *  these three, and the platform's own material never has to learn the runtime's word. */
export const ASSET_ROLES = ["method_text", "reference_material", "permitted_actions"] as const;
export type AssetRole = (typeof ASSET_ROLES)[number];

/** The three answers `cancel` may give, weakest to strongest. The order is the strength
 *  order and {@link cancelStrength} reads it as such rather than hardcoding comparisons. */
export const CANCEL_STATES = ["unsupported", "requested", "confirmed_stopped"] as const;
export type CancelState = (typeof CANCEL_STATES)[number];

/** How much an observation actually establishes. */
export const OBSERVED_COMPLETENESS = [
  /** The runtime says the work is still going. */
  "running",
  /** The runtime issued an end-of-work record and this observation carries it. */
  "receipt_confirmed",
  /** Activity stopped. That is the entire finding: not finished, not failed, not a duration. */
  "last_activity_only",
  /** The adapter could not look. Distinct from "looked and saw nothing". */
  "observation_unavailable",
] as const;
export type ObservedCompleteness = (typeof OBSERVED_COMPLETENESS)[number];

/** Where a receipt's authority comes from. `caller_asserted` is not a weaker runtime
 *  confirmation; it is not a runtime confirmation at all, and a cost or completion decision
 *  that treats the two alike is deciding on hearsay. */
export const RECEIPT_ASSURANCE = ["runtime_confirmed", "caller_asserted"] as const;
export type ReceiptAssurance = (typeof RECEIPT_ASSURANCE)[number];

/** The records a stop may rest on. A signal the adapter sent is not among them: every member
 *  is something the RUNTIME produced. */
export const STOP_EVIDENCE = ["runtime_exit_record", "runtime_stop_acknowledgement"] as const;
export type StopEvidence = (typeof STOP_EVIDENCE)[number];

// ---------------------------------------------------------------------------------------
// Capability identity

/**
 * The structural facts about an adapter's event feed — the part of "a different event format"
 * that is checkable rather than asserted. Two adapters that differ only in the `id` string
 * have not demonstrated anything, so the fields below are what a caller would actually have
 * to write different code for: what identifies an event, how its time is written, whether the
 * feed is appended to or replaced wholesale, what orders it, and whether it can lose entries.
 */
export interface EventFormatIdentity {
  /** The adapter's own name for its feed shape. The single source for
   *  {@link RuntimeAdapter.eventFormat}, which is the same string read without a call. */
  readonly id: string;
  readonly identity_of_an_event: "opaque_id" | "ordinal";
  readonly time_encoding: "iso_8601" | "epoch_millis";
  readonly delivery: "append_only" | "replaced_snapshot";
  readonly ordering: "arrival_order" | "by_ordinal";
  /** True when the runtime may drop entries — so a gap in the feed is not evidence that
   *  nothing happened. */
  readonly may_drop_events: boolean;
}

/**
 * A capability this adapter does not have, said out loud.
 *
 * `simulated` is typed `false` so that the one thing the port refuses cannot be written down:
 * an adapter may not declare a capability missing and then behave as though it were present.
 * Either the runtime does it, or the caller is told it does not and decides what to do about
 * that — which is what {@link admitToRuntime} is for.
 */
export interface DeclaredUnsupported {
  readonly capability: RuntimeCapability;
  readonly because: string;
  readonly simulated: false;
}

/**
 * What a cancellation can and cannot achieve against this runtime, declared up front rather
 * than discovered by a caller who assumed.
 *
 * `settles_within_ms` is `null` when the runtime gives no bound, and `null` means unknown —
 * never zero, never "immediately". `lease_expiry_proves_stop` is typed `false` because it is
 * false: a lease bounds how long somebody may hold a claim, and a worker that outlives its
 * lease is a worker that is still running with a claim nobody can renew.
 */
export interface CancellationLimits {
  readonly strongest: CancelState;
  readonly settles_within_ms: number | null;
  readonly lease_expiry_proves_stop: false;
}

/**
 * The adapter's versioned capability identity, in two halves that fail differently.
 *
 * `protocol` is the revision of THIS PORT the adapter implements, and it is a name and a
 * monotonic integer rather than a dotted triple on purpose: it is not a release of anything
 * and must not be readable as one. Every adapter carries the same value, from
 * {@link PORT_PROTOCOL}, so there is one place a port revision is ever written down.
 *
 * `declaration_digest` is DERIVED from everything else on this record — the event format, the
 * supported and refused capabilities, the cancellation limits. Not written, because a number an
 * author types is a number that stops being true the moment somebody edits the thing it names,
 * and nothing fails: the declaration moves and the identity stands still, which is the same
 * shape as a serverInfo version no release ever produced. A derived identity moves exactly when
 * the declared behaviour moves, which is the entire job a version was supposed to do here, and
 * {@link runConformance} recomputes it rather than trusting it.
 */
export interface RuntimeCapabilities {
  readonly adapter: string;
  readonly protocol: string;
  readonly declaration_digest: string;
  readonly event_format: EventFormatIdentity;
  readonly supported: readonly RuntimeCapability[];
  readonly unsupported: readonly DeclaredUnsupported[];
  readonly cancellation: CancellationLimits;
}

/** The revision of this port. A name and a monotonic integer: it moves when the six operations
 *  or their contracts change, and it is written here and nowhere else. */
export const PORT_PROTOCOL = "runtime-port/1";

/** What an adapter declares about itself, without the identity that is derived FROM it. */
export type CapabilityDeclaration =
  Omit<RuntimeCapabilities, "protocol" | "declaration_digest">;

/** Key-sorted at every level, so two declarations that say the same thing digest the same
 *  however their literals happened to be typed. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The capability identity, computed from the declaration it identifies. */
export function declarationDigest(declaration: CapabilityDeclaration): string {
  return createHash("sha256").update(stableJson(declaration)).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------------------
// The five remaining operations

/** Which method to bind, and at which revision. A missing revision means "whatever is
 *  current", and the binding that comes back says which one that turned out to be. */
export interface LoadMethodRequest {
  readonly method: string;
  readonly revision?: string;
}

/**
 * One asset the runtime actually bound, with its identity.
 *
 * `digest` is the point of the whole type. `locator` is where the runtime found the asset and
 * is in the runtime's own terms — a path for one of the adapters here, a content address for
 * the other — so it can never be compared across runtimes. The digest can, which is what
 * makes "the same method ran" a checkable statement rather than a hopeful one.
 */
export interface BoundAsset {
  readonly role: AssetRole;
  readonly locator: string;
  readonly digest: string;
  readonly bytes: number;
}

/** What was bound, when, and at which revision. Exact: the assets listed are the assets the
 *  runtime will read, not the ones the caller asked for. */
export interface MethodBinding {
  readonly method: string;
  readonly revision: string;
  readonly assets: readonly BoundAsset[];
  readonly bound_at: string;
}

/** The work to start: the claim it runs under, and the contract it is answerable to. The
 *  contract is opaque here on purpose — the port carries it, it does not read it. */
export interface DispatchRequest {
  readonly claim: string;
  readonly contract: Readonly<Record<string, unknown>>;
  readonly binding?: MethodBinding;
}

/**
 * What dispatching returns: an identifier for work that has started.
 *
 * `completed` and `receipt` are typed `never` and that is the entire design. The failure this
 * prevents is not an adapter that lies; it is an adapter written against a runtime whose
 * submit call happens to return a body, and an author who fills the nearest field with it.
 * There is no nearest field. A completion is something {@link RuntimeAdapter.observe} may one
 * day report, and spawn metadata — a session identifier, a start time, a queue position — is
 * not one however much of it comes back at submission.
 */
export interface DispatchAck {
  readonly work_id: string;
  readonly accepted_at: string;
  readonly observe_after_ms: number;
  readonly completed?: never;
  readonly receipt?: never;
}

/** Which work to look at. The adapter returns everything it has observed so far; a caller
 *  that wants only what is new compares event ids it already holds. */
export interface ObserveRequest {
  readonly work_id: string;
}

/** One unit of activity, normalised. `kind` and `summary` stay in the runtime's own
 *  vocabulary — the port does not translate them and does not branch on them. */
export interface ObservedEvent {
  readonly event_id: string;
  readonly at: string;
  readonly kind: string;
  readonly summary: string;
}

/** An end-of-work record the runtime issued. `assurance` says whose word it is. */
export interface CompletionReceipt {
  readonly work_id: string;
  readonly ended_at: string;
  readonly exit: "finished" | "stopped" | "failed";
  readonly assurance: ReceiptAssurance;
}

interface ObservationBase {
  readonly work_id: string;
  /** When the ADAPTER looked. The only field on this type that comes from the platform's
   *  clock rather than the runtime's feed. */
  readonly observed_at: string;
  readonly events: readonly ObservedEvent[];
  /** The stamp on the last event, or null when there are none. The last event is the last
   *  thing seen. It is not an end time, and nothing downstream may read it as one. */
  readonly last_activity_at: string | null;
  /** First stamp to last stamp. A FLOOR, named as one: work that ran on after the feed went
   *  quiet ran longer than this, and there is no way to tell from a feed how much longer. */
  readonly elapsed_at_least_ms: number | null;
  readonly usage: UsageTotal | null;
}

/**
 * What an observation establishes, with the receipt attached to the one state that has one.
 *
 * The union is the point: there is no way to return a receipt alongside `last_activity_only`,
 * and no way to claim `receipt_confirmed` without producing the record. A caller that wants
 * to know whether work finished asks about `completeness` and gets an answer that cannot have
 * been assembled out of a quiet feed.
 */
export type Observation =
  | (ObservationBase & {
      readonly completeness: "receipt_confirmed";
      readonly receipt: CompletionReceipt;
    })
  | (ObservationBase & {
      readonly completeness: "running" | "last_activity_only" | "observation_unavailable";
      readonly receipt: null;
    });

/** Ask for work to stop. `because` is recorded, never interpreted. */
export interface CancelRequest {
  readonly work_id: string;
  readonly because?: string;
}

/**
 * What asking to stop achieved — and the arm that carries `treatedAsStopped` is the only arm
 * that may, because it is the only arm that has a runtime record behind it.
 *
 * `requested` says a request went out, and says nothing else, because at the moment a request
 * goes out there is nothing else to say. Whether the worker then stopped is a question about
 * the future, and the only honest place to answer it is a later {@link Observation}: events
 * stamped after `requested_at` are a worker still working. `settles_within_ms` is the one
 * forward-looking field, and it is a bound the RUNTIME publishes, not a prediction the adapter
 * makes — after it elapses a caller may stop watching, which is still not a confirmation.
 * `unsupported` is a runtime with no stop channel at all; returning `requested` there would be
 * an adapter reporting on a message it never sent.
 */
export type CancelOutcome =
  | {
      readonly state: "requested";
      readonly work_id: string;
      readonly requested_at: string;
      readonly settles_within_ms: number | null;
      readonly treatedAsStopped?: never;
      readonly confirmed_by?: never;
    }
  | {
      readonly state: "confirmed_stopped";
      readonly work_id: string;
      readonly stopped_at: string;
      readonly confirmed_by: StopEvidence;
      readonly treatedAsStopped: true;
    }
  | {
      readonly state: "unsupported";
      readonly work_id: string;
      readonly because: string;
      readonly treatedAsStopped?: never;
      readonly confirmed_by?: never;
    };

/** Continue work that stopped. `from_event_id` names where the continuation picks up, so a
 *  caller can tell a resumption from a fresh start that reused an identifier. */
export interface ResumeRequest {
  readonly work_id: string;
}

export type ResumeOutcome =
  | {
      readonly state: "resumed";
      readonly work_id: string;
      readonly continues: string;
      readonly from_event_id: string;
    }
  | { readonly state: "unsupported"; readonly because: string };

// ---------------------------------------------------------------------------------------
// The adapter itself

/**
 * A runtime adapter: an identity, the name of its event format, and the six operations.
 *
 * THE INDEX SIGNATURE IS LOAD-BEARING, not slack. The check this port exists to satisfy walks
 * the six operation names as a `string[]` and asks whether each is a function — which is how a
 * caller with a list of required operations would really ask, and which is an implicit-any
 * element access without it. Two costs are accepted knowingly: excess-property checking is off
 * for object literals typed as this interface, and `a[someString]` is `unknown` rather than an
 * error. Both are cheaper than a check that only compiles while the thing it checks is absent.
 *
 * `eventFormat` duplicates `capabilities().event_format.id` deliberately, because a caller
 * choosing between adapters should not have to call one to find out. Both adapters here read
 * it off the same constant, and the conformance run refuses a pair that has drifted.
 */
export interface RuntimeAdapter {
  readonly id: string;
  readonly eventFormat: string;
  capabilities(): RuntimeCapabilities;
  load_method(request: LoadMethodRequest): MethodBinding;
  dispatch(request: DispatchRequest): DispatchAck;
  observe(request: ObserveRequest): Observation;
  cancel(request: CancelRequest): CancelOutcome;
  resume(request: ResumeRequest): ResumeOutcome;
  readonly [key: string]: unknown;
}

/** Strength order for a cancellation answer, read off {@link CANCEL_STATES}. */
export function cancelStrength(state: CancelState): number {
  return CANCEL_STATES.indexOf(state);
}

// ---------------------------------------------------------------------------------------
// Admission

/** What a piece of work needs from whatever runs it. */
export interface TaskProfile {
  readonly task: string;
  readonly requires: readonly RuntimeCapability[];
}

/**
 * Whether the work may run here at all.
 *
 * `refused` is a capability the adapter declared it does not have. `undeclared` is one it has
 * never mentioned either way, and it is kept separate because the two need different answers:
 * the first is a fact about the runtime, the second is a gap in the adapter. Neither is
 * admission — an adapter that has not said it can do something has not said it can.
 */
export interface RuntimeAdmission {
  readonly task: string;
  readonly adapter: string;
  readonly admitted: boolean;
  readonly refused: readonly DeclaredUnsupported[];
  readonly undeclared: readonly RuntimeCapability[];
}

export function admitToRuntime(
  capabilities: RuntimeCapabilities,
  profile: TaskProfile,
): RuntimeAdmission {
  const supported = new Set<string>(capabilities.supported);
  const refusedBy = new Map<string, DeclaredUnsupported>(
    capabilities.unsupported.map((u) => [u.capability, u]));
  const refused: DeclaredUnsupported[] = [];
  const undeclared: RuntimeCapability[] = [];
  for (const need of profile.requires) {
    if (supported.has(need)) continue;
    const declared = refusedBy.get(need);
    if (declared) refused.push(declared);
    else undeclared.push(need);
  }
  return {
    task: profile.task,
    adapter: capabilities.adapter,
    admitted: refused.length === 0 && undeclared.length === 0,
    refused,
    undeclared,
  };
}
