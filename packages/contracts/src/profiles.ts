/**
 * THE PROFILE REGISTER: what an immutable profile reference resolves to, and the key anything
 * measured against it is filed under. One subject, separate from `bindings.ts` on purpose — that
 * module is about which profile a run is BOUND to and what changing it costs; this one is about
 * what a ref IS and how work qualifies against it. Nothing here knows a run exists.
 *
 * AN IMMUTABLE REF MEANS WHAT IT SAYS. {@link declareProfile} refuses to redefine a ref that is
 * already declared differently: a reference that can be redefined in place is a mutable one with
 * a reassuring name, and every key minted before the redefinition would silently describe
 * something else.
 *
 * THE PROVISIONAL PROFILE, AND WHY IT IS SAFE. A ref nobody declared still has to qualify. Its
 * identity is taken to be the ref itself, marked `unverified`, and its adapter, renderer, options
 * and interpretation mapping are null rather than invented. An immutable ref names one pinned
 * profile, so two refs are never the same profile — which makes the ref a LOWER bound on
 * identity: it may SPLIT one model across two keys, never MERGE two models into one. Splitting
 * costs a re-qualification; merging silently lends one model's thresholds to another. Declaring
 * the profile later changes the key again, in the same safe direction.
 *
 * HANDLES, NEVER VALUES. `endpoint_ref` and `credential_ref` are host-held handles: stored,
 * digested, dereferenced never. A scheme, an authority, a path or whitespace is refused. The
 * limit of that, plainly: a grammar cannot tell a short opaque handle from a short secret. What
 * makes the guarantee is that nothing here resolves one — no fetch, no client, and no field
 * through which a caller-supplied address could reach a transport.
 */
import { createHash } from "node:crypto";
import type { IdentityAssurance } from "./assessment.js";

/** The three roles a binding selects a profile for. */
export type BoundRole = "reasoning" | "semantic_assessment" | "runtime";

/** What a caller may say about the profile behind a ref. Everything here enters the qualification
 *  key, so declaring one after runs qualified provisionally forces re-qualification. */
export interface ProfileDeclaration {
  readonly profile_ref: string;
  readonly role: BoundRole;
  readonly model_identity: string;
  readonly adapter: string;
  readonly renderer: string;
  readonly interpretation_profile_ref: string;
  readonly options?: Readonly<Record<string, string | number | boolean>>;
  readonly identity_assurance?: IdentityAssurance;
  readonly endpoint_ref?: string;
  readonly credential_ref?: string;
  readonly incompatible_with?: readonly string[];
}

/** A profile as this register sees it — declared or provisional. A null field is undeclared, not
 *  absent-and-therefore-default. */
export interface ResolvedProfile {
  readonly profile_ref: string;
  readonly role: BoundRole;
  readonly model_identity: string;
  readonly identity_assurance: IdentityAssurance;
  readonly adapter: string | null;
  readonly renderer: string | null;
  readonly interpretation_profile_ref: string | null;
  readonly options: Readonly<Record<string, string | number | boolean>> | null;
  readonly endpoint_ref: string | null;
  readonly credential_ref: string | null;
  readonly declared: boolean;
  readonly revoked: boolean;
  readonly profile_digest: string;
}

/** The task, language and risk slice a threshold or an answer was qualified on. */
export interface QualificationSlice { readonly task: string; readonly language: string; readonly risk: string }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export const stableDigest = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex").slice(0, 32);

/** THE KEY A THRESHOLD OR AN ANSWER IS FILED UNDER. Model identity, adapter, renderer, options
 *  and interpretation mapping come from the profile; task, language and risk from the slice.
 *  Every one is something the measurement depended on, so every one is in the key — and the
 *  identity being in it is why a new model cannot find the old model's numbers. It is a digest,
 *  not a name: two profiles differing in any declared field differ in it. */
export function qualificationKey(profile: ResolvedProfile, slice: QualificationSlice): string {
  return stableDigest({
    model_identity: profile.model_identity, adapter: profile.adapter, renderer: profile.renderer,
    options: profile.options, interpretation: profile.interpretation_profile_ref,
    task: slice.task, language: slice.language, risk: slice.risk,
  });
}

const declarations = new Map<string, ProfileDeclaration>();
const minted = new Map<string, ResolvedProfile>();
const revoked = new Set<string>();

/** A host handle, in the only shape this register accepts: dotted or dashed lowercase segments,
 *  optionally namespaced with a colon. A scheme, an authority, a path or whitespace is refused
 *  outright — those are the shapes an address takes, and no address belongs in this record. */
const HANDLE = /^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*(?::[a-z0-9][a-z0-9-]*)*$/;

function assertHandle(kind: string, value: string): void {
  if (/[/\s@]/.test(value) || !HANDLE.test(value)) {
    throw new Error(`${kind} must be a host-held handle, not an address or a value`);
  }
}

/** Register what is behind a ref. See the header for why redefining one throws. */
export function declareProfile(declaration: ProfileDeclaration): ResolvedProfile {
  const existing = declarations.get(declaration.profile_ref);
  if (existing && stableDigest(existing) !== stableDigest(declaration)) {
    throw new Error(`profile ref ${declaration.profile_ref} is already declared differently`);
  }
  if (declaration.endpoint_ref) assertHandle("endpoint_ref", declaration.endpoint_ref);
  if (declaration.credential_ref) assertHandle("credential_ref", declaration.credential_ref);
  declarations.set(declaration.profile_ref, declaration);
  return resolveProfile(declaration.profile_ref, declaration.role);
}

/** Resolve a ref for a slot. An undeclared ref resolves provisionally; the header says why the
 *  ref-as-identity is the safe direction rather than a convenient one. */
export function resolveProfile(ref: string, slot: BoundRole): ResolvedProfile {
  const d = declarations.get(ref);
  const base = {
    profile_ref: ref,
    role: d ? d.role : slot,
    model_identity: d ? d.model_identity : ref,
    identity_assurance: (d?.identity_assurance ?? "unverified") as IdentityAssurance,
    adapter: d ? d.adapter : null,
    renderer: d ? d.renderer : null,
    interpretation_profile_ref: d ? d.interpretation_profile_ref : null,
    options: d?.options ?? null,
    endpoint_ref: d?.endpoint_ref ?? null,
    credential_ref: d?.credential_ref ?? null,
    declared: d !== undefined, revoked: revoked.has(ref),
  };
  const profile = { ...base, profile_digest: stableDigest(base) };
  minted.set(profile.profile_digest, profile);
  return profile;
}

/** The profile a digest was minted from. This is what lets a consumer re-derive the key a piece
 *  of evidence was filed under WITHOUT trusting the key stored beside it — which is the whole
 *  reason provenance is checkable after the fact. */
export const profileByDigest = (profileDigest: string): ResolvedProfile | undefined =>
  minted.get(profileDigest);

/** Which slot a ref was declared for, or `undefined` if nobody declared it. A caller that holds
 *  only a ref uses this to learn which role it is being asked to fill. */
export const declaredRole = (ref: string): BoundRole | undefined => declarations.get(ref)?.role;

/** Withdraw a ref. Only the register records it; what that stops is decided by whoever holds the
 *  runs, because stopping work is not a property of a profile. */
export function markProfileRevoked(ref: string): void {
  revoked.add(ref);
}

/** Is a declared ref usable in this slot, and alongside these other refs? `null` is yes. The
 *  register answers only about the profile; a binding decides what to do with the answer. */
export function unsupportedProfile(ref: string, slot: BoundRole, alongside: readonly string[]): string | null {
  if (revoked.has(ref)) return `profile ${ref} is revoked and needs an explicit migration`;
  const d = declarations.get(ref);
  if (d && d.role !== slot) return `profile ${ref} is declared for ${d.role} and cannot fill the ${slot} slot`;
  for (const other of alongside) {
    if (d?.incompatible_with?.includes(other)
      || declarations.get(other)?.incompatible_with?.includes(ref)) {
      return `${ref} is not supported alongside ${other}`;
    }
  }
  return null;
}
