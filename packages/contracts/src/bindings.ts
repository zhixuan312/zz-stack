/**
 * Which reasoning, assessor and runtime profile a run works under, held in one place and changed
 * in one place. What a profile ref resolves to, and the key work qualifies against it under, is
 * `profiles.ts`.
 *
 * The central default is snapshotted at enrolment: `startRun` copies the current value in,
 * `resolveFor` reads the run's own copy, and no code path lets a run observe the central default
 * again. Half a run's evidence produced under one model and half under another is undetectable
 * afterwards, because the records look alike.
 *
 * `rebind` moves an in-flight run, and the order is part of it: suspend, then reconcile, then
 * revoke the grants that depended on the old binding, retire the calibration and answers no
 * longer reachable, and list the checkpoints to ask again.
 *
 * Both evidence stores are append-only: a threshold out of force and an answer no longer
 * reusable are marked, not removed, and history is never rewritten.
 *
 * A calibrated threshold is a fact about the measurement's full identity, all of which is in the
 * qualification key: an entry stays in force exactly when its key is still reachable under the
 * new binding, so retirement needs no policy of its own.
 *
 * DELIBERATE: `BindingGrant` is not the kernel's grant. `control-grant.ts` owns authorisation;
 * what is recorded here is which standing permissions were qualified against which bound
 * profile. This file imports nothing from it.
 */
import {
  declareProfile, declaredRole, profileByDigest, qualificationKey,
  resolveProfile, stableDigest, unsupportedProfile,
  type BoundRole, type QualificationSlice, type ResolvedProfile,
} from "./profiles.js";

// What a binding is

/** The central record: one immutable profile reference per role. `null` is a slot nobody has
 *  bound — never a baseline profile invented so the record looks complete. */
export interface RoleBindings {
  readonly reasoning_profile_ref: string | null;
  readonly semantic_assessment_profile_ref: string | null;
  readonly runtime_profile_ref: string | null;
}

const BOUND_ROLES: readonly BoundRole[] =
  Object.freeze(["reasoning", "semantic_assessment", "runtime"]);

const REF_FIELD: Readonly<Record<BoundRole, keyof RoleBindings>> = Object.freeze({
  reasoning: "reasoning_profile_ref",
  semantic_assessment: "semantic_assessment_profile_ref",
  runtime: "runtime_profile_ref",
});

/** A binding resolved to profiles, with its digest and the central version it came from. */
export interface ResolvedBinding extends RoleBindings {
  readonly binding_digest: string;
  readonly default_version: number;
  readonly profiles: Readonly<Record<BoundRole, ResolvedProfile | null>>;
}

/** What every piece of qualified evidence carries: the role, the slice it was taken on, the key
 *  it is filed under, and the profile that produced it, which is what makes provenance checkable
 *  after the key has been recomputed. None of the three shapes below is published — the two
 *  functions producing them are module-private. */
interface Qualified {
  readonly role: BoundRole; readonly slice: QualificationSlice;
  readonly qualification_key: string; readonly minted_under_profile_digest: string;
}

/** A measured threshold. `in_force` goes false when the key stops being reachable. */
interface CalibrationEntry extends Qualified { readonly threshold: number; readonly in_force: boolean }

/** One invocation that happened, and the answer it produced. `reusable` goes false when the key
 *  stops being reachable; the record is never removed. */
interface InvocationRecord extends Qualified {
  readonly checkpoint_id: string; readonly question_digest: string;
  readonly model_identity: string; readonly reusable: boolean;
  readonly options: Readonly<Record<string, string | number | boolean>> | null;
}

/** A standing permission of a run, and the bound roles it was qualified against. */
interface BindingGrant {
  readonly grant_id: string; readonly capability: string; readonly active: boolean;
  readonly depends_on: readonly BoundRole[];
  readonly qualified_under: Readonly<Record<string, string>>;
}

/** The ledger is internal to this module and neither name below is published. `report` derives
 *  `suspendedFirst` and `historyPreserved` from the entries a rebind appended, which is the form
 *  the order of events is offered in. */
type BindingEventKind =
  | "enrolled" | "run_suspended" | "reconciled" | "grants_revoked" | "qualification_retired"
  | "rebound" | "resumed_pending_reevaluation" | "paused_for_migration";

/** One append-only entry. `seq` is module-wide and monotonic, so ordering between entries is a
 *  fact rather than an artefact of how an array happened to be built. */
interface BindingEvent {
  readonly seq: number; readonly kind: BindingEventKind;
  readonly detail: string; readonly binding_digest: string | null;
}

/** The handle `startRun` returns. It carries no binding of its own: `resolveFor` reads the
 *  store, so pinning is a property of the record rather than of a copy the caller holds. */
export interface EnrolledRun { readonly run_id: string; readonly enrolment_key: string }

export interface RebindRequest { readonly to: string; readonly authority: string; readonly role?: BoundRole }

export interface RebindResult {
  readonly run_id: string;
  readonly outcome: "rebound" | "paused_for_migration" | "refused";
  readonly role: BoundRole;
  readonly suspendedFirst: boolean;
  readonly revokedGrants: readonly string[];
  readonly retainedGrants: readonly string[];
  readonly inheritedCalibration: boolean;
  readonly reusedCachedAnswers: boolean;
  readonly historyPreserved: boolean;
  readonly calibrationRetired: number;
  readonly answersRetired: number;
  readonly checkpointsToReevaluate: readonly string[];
  readonly from: RoleBindings;
  readonly to: ResolvedBinding | null;
  readonly reason: string | null;
}

/** A rebind's decided facts; the five left out are the ones {@link report} computes. */
type RebindFacts = Omit<
  RebindResult,
  "run_id" | "suspendedFirst" | "inheritedCalibration" | "reusedCachedAnswers" | "historyPreserved"
>;

// The runs

interface RunState {
  readonly run_id: string; binding: ResolvedBinding; suspended: boolean; grants: BindingGrant[];
  calibration: CalibrationEntry[]; invocations: InvocationRecord[]; history: BindingEvent[];
}

const runs = new Map<string, RunState>();
const UNBOUND: RoleBindings = Object.freeze({
  reasoning_profile_ref: null,
  semantic_assessment_profile_ref: null,
  runtime_profile_ref: null,
});
let currentDefault: RoleBindings = UNBOUND;
let defaultVersion = 0;
let seq = 0;
let minted = 0;

// The central default

/** Change the central default. A patch, because changing one role is one change. It reaches runs
 *  enrolled after it and no others. */
export function setDefaultBinding(patch: Partial<RoleBindings>): RoleBindings {
  currentDefault = { ...currentDefault, ...patch };
  defaultVersion += 1;
  return currentDefault;
}

function resolveBinding(refs: RoleBindings, version: number): ResolvedBinding {
  const profiles = {} as Record<BoundRole, ResolvedProfile | null>;
  for (const role of BOUND_ROLES) {
    const ref = refs[REF_FIELD[role]];
    profiles[role] = ref === null ? null : resolveProfile(ref, role);
  }
  const digests = BOUND_ROLES.map((r) => profiles[r]?.profile_digest ?? null);
  return { ...refs, default_version: version, profiles, binding_digest: stableDigest({ refs, digests }) };
}

function append(state: RunState, kind: BindingEventKind, detail: string): void {
  seq += 1;
  state.history.push({ seq, kind, detail, binding_digest: state.binding.binding_digest });
}

// Enrolment

/** Enrol a run. The central default is copied here, once, and the run is granted the right to
 *  invoke each profile it bound — each grant names the role it depends on and the digest it was
 *  qualified against, which is what makes it revocable. The handle is keyed by a fresh enrolment
 *  key rather than by `run_id`, so two enrolments under one id are two records. */
export function startRun(runId: string): EnrolledRun {
  const binding = resolveBinding(currentDefault, defaultVersion);
  minted += 1;
  const enrolment_key = `enrol-${minted}`;
  const grants: BindingGrant[] = BOUND_ROLES.flatMap((role) => {
    const p = binding.profiles[role];
    return p === null ? [] : [{
      grant_id: `${enrolment_key}-${role}`, capability: `invoke:${role}`, depends_on: [role],
      qualified_under: { [role]: p.profile_digest }, active: true,
    }];
  });
  const state: RunState = {
    run_id: runId, binding, suspended: false,
    grants, calibration: [], invocations: [], history: [],
  };
  runs.set(enrolment_key, state);
  append(state, "enrolled", `pinned to central default version ${binding.default_version}`);
  return { run_id: runId, enrolment_key };
}

function mustFind(run: EnrolledRun): RunState {
  const state = runs.get(run.enrolment_key);
  if (!state) throw new Error(`no enrolled run for ${run.enrolment_key}`);
  return state;
}

/** The run's own binding. Never the central default — a run that could read the default could
 *  drift with it, which is the one thing this module exists to prevent. */
export const resolveFor = (run: EnrolledRun): ResolvedBinding => mustFind(run).binding;

function boundProfile(state: RunState, role: BoundRole): ResolvedProfile {
  const profile = state.binding.profiles[role];
  if (!profile) throw new Error(`the ${role} role is not bound on this run`);
  return profile;
}

/** File a measured threshold under the key the measurement was taken at. Not published: the only
 *  caller is {@link rebindDetectorProbe}. */
function recordCalibration(
  run: EnrolledRun, role: BoundRole, slice: QualificationSlice, threshold: number,
): CalibrationEntry {
  const state = mustFind(run);
  const profile = boundProfile(state, role);
  const entry: CalibrationEntry = {
    role, slice, threshold, in_force: true,
    qualification_key: qualificationKey(profile, slice),
    minted_under_profile_digest: profile.profile_digest,
  };
  state.calibration.push(entry);
  return entry;
}

/** Record one invocation — which model answered, under which options, for which checkpoint —
 *  filing its answer under the same key, so a later cache hit is a hit on the model that
 *  answered. Not published. */
function recordInvocation(
  run: EnrolledRun, role: BoundRole, slice: QualificationSlice,
  checkpointId: string, questionDigest: string,
): InvocationRecord {
  const state = mustFind(run);
  const profile = boundProfile(state, role);
  const record: InvocationRecord = {
    role, slice, checkpoint_id: checkpointId, question_digest: questionDigest,
    model_identity: profile.model_identity, options: profile.options, reusable: true,
    qualification_key: qualificationKey(profile, slice),
    minted_under_profile_digest: profile.profile_digest,
  };
  state.invocations.push(record);
  return record;
}

// Rebinding an in-flight run

/** The deliberate faults {@link rebindDetectorProbe} injects. Not exported and not reachable
 *  from {@link rebind}. */
interface Faults {
  readonly rebadge: boolean; readonly looseKey: boolean; readonly reuseCache: boolean;
  readonly switchBeforeSuspend: boolean; readonly rewriteHistory: boolean;
}

const NO_FAULTS: Faults = {
  rebadge: false, looseKey: false, reuseCache: false, switchBeforeSuspend: false, rewriteHistory: false,
};

/** The loose key the `looseKey` fault qualifies under: everything except who answered. */
const looseKey = (profile: ResolvedProfile, slice: QualificationSlice): string =>
  stableDigest({ renderer: profile.renderer, interpretation: profile.interpretation_profile_ref, ...slice });

/**
 * Move an in-flight run onto a different profile: suspend, reconcile, revoke, retire, install.
 *
 * The order is the contract — suspension is appended before anything is examined. An unsupported
 * combination pauses for explicit migration rather than half-applying. A grant is revoked only
 * if a role it was qualified against changed. `to` is the target, never the current central
 * default, which may have moved since the run enrolled.
 */
export function rebind(run: EnrolledRun, request: RebindRequest): RebindResult {
  return performRebind(run, request, NO_FAULTS);
}

function performRebind(run: EnrolledRun, request: RebindRequest, faults: Faults): RebindResult {
  const state = mustFind(run);
  const pre = [...state.history];
  const role: BoundRole = request.role ?? declaredRole(request.to) ?? "semantic_assessment";
  const from: RoleBindings = { ...state.binding };
  const nothing = { role, revokedGrants: [], retainedGrants: activeIds(state), from, to: null,
    calibrationRetired: 0, answersRetired: 0, checkpointsToReevaluate: [] };

  // An unauthorised call changes nothing, not even the suspension: otherwise anyone who could
  // name a run could stop it.
  if (!request.authority.trim()) {
    return report(state, pre, { ...nothing, outcome: "refused", reason: "a rebind needs a named authority" });
  }

  if (!faults.switchBeforeSuspend) {
    state.suspended = true;
    append(state, "run_suspended", `suspended to rebind ${role} by authority ${request.authority}`);
  }
  // Editing an entry that was already written, which is the shape of the defect
  // `historyPreserved` exists to catch: the ledger still looks complete afterwards.
  if (faults.rewriteHistory) state.history[0] = { ...state.history[0], detail: "enrolled under the new binding" };

  const proposed: RoleBindings = { ...from, [REF_FIELD[role]]: request.to };
  const next = resolveBinding(proposed, state.binding.default_version);
  const unsupported = unsupportedReason(next, role, request.to);
  append(state, "reconciled", unsupported ?? "the proposed combination is supported");
  if (unsupported) {
    append(state, "paused_for_migration", unsupported);
    return report(state, pre, { ...nothing, outcome: "paused_for_migration", reason: unsupported });
  }
  if (faults.switchBeforeSuspend) {
    state.binding = next;
    state.suspended = true;
    append(state, "run_suspended", "suspended after the binding was already switched");
  }

  const changed = BOUND_ROLES.filter(
    (r) => from[REF_FIELD[r]] !== next[REF_FIELD[r]]
      || state.binding.profiles[r]?.profile_digest !== next.profiles[r]?.profile_digest,
  );
  const revokedGrants: string[] = [];
  state.grants = state.grants.map((g) => {
    if (!g.active || !g.depends_on.some((r) => changed.includes(r))) return g;
    revokedGrants.push(g.grant_id);
    return { ...g, active: false };
  });
  append(state, "grants_revoked", `${revokedGrants.length} grant(s) depended on a changed role`);

  // Retirement is the key, not a policy: an entry stays in force exactly when it is still
  // reachable under the new binding. Both sides go through the same key function, so `looseKey`
  // simulates a system that always qualified loosely.
  const keyOf = faults.looseKey ? looseKey : qualificationKey;
  const keyUnder = (e: Qualified): string | null => {
    const p = next.profiles[e.role];
    return p === null ? null : keyOf(p, e.slice);
  };
  const stillReachable = (e: Qualified): boolean => {
    const minter = profileByDigest(e.minted_under_profile_digest);
    const now = keyUnder(e);
    return now !== null && minter !== undefined && now === keyOf(minter, e.slice);
  };
  const rebadged = <T extends Qualified>(e: T): T => ({ ...e, qualification_key: keyUnder(e) ?? e.qualification_key });

  let calibrationRetired = 0;
  state.calibration = state.calibration.map((e) => {
    if (faults.rebadge) return rebadged(e);
    if (!e.in_force || stillReachable(e)) return e;
    calibrationRetired += 1;
    return { ...e, in_force: false };
  });
  let answersRetired = 0;
  const checkpoints = new Set<string>();
  state.invocations = state.invocations.map((a) => {
    if (faults.rebadge) return rebadged(a);
    if (faults.reuseCache || !a.reusable || stillReachable(a)) return a;
    answersRetired += 1;
    checkpoints.add(a.checkpoint_id);
    return { ...a, reusable: false };
  });
  append(state, "qualification_retired",
    `${calibrationRetired} threshold(s) and ${answersRetired} answer(s) are no longer reachable`);

  state.binding = next;
  append(state, "rebound", `${role} now resolves to ${request.to} under authority ${request.authority}`);
  state.suspended = false;
  append(state, "resumed_pending_reevaluation", `${checkpoints.size} checkpoint(s) must be asked again`);

  return report(state, pre, {
    role, outcome: "rebound", from, to: next, reason: null,
    revokedGrants, retainedGrants: activeIds(state),
    calibrationRetired, answersRetired, checkpointsToReevaluate: [...checkpoints],
  });
}

const activeIds = (state: RunState): string[] =>
  state.grants.filter((g) => g.active).map((g) => g.grant_id);

function unsupportedReason(next: ResolvedBinding, role: BoundRole, target: string): string | null {
  if (next.profiles[role] === null) return `${role} resolved to nothing`;
  const alongside = BOUND_ROLES.filter((r) => r !== role)
    .map((r) => next[REF_FIELD[r]]).filter((ref): ref is string => ref !== null);
  return unsupportedProfile(target, role, alongside);
}

/**
 * The four detectors, each computed from what the rebind left behind. `inheritedCalibration` and
 * `reusedCachedAnswers` ask one question of two stores: is anything still in force whose
 * provenance is not the profile now bound for its role? Provenance rather than a second key
 * comparison, because a mechanism that audits itself passes whenever it is broken.
 * `suspendedFirst` reads the order of what this rebind appended; `historyPreserved` compares the
 * prefix captured before it ran.
 */
function report(state: RunState, pre: readonly BindingEvent[], facts: RebindFacts): RebindResult {
  const appended = state.history.slice(pre.length);
  const at = (kind: BindingEventKind): number => appended.findIndex((e) => e.kind === kind);
  const [suspendedAt, reconciledAt, reboundAt] = [at("run_suspended"), at("reconciled"), at("rebound")];
  const to = facts.to;
  const inherited = (entries: readonly Qualified[]): boolean =>
    to !== null && entries.some((e) => {
      const p = to.profiles[e.role];
      return p !== null && p.profile_digest !== e.minted_under_profile_digest;
    });

  return {
    ...facts,
    run_id: state.run_id,
    suspendedFirst: facts.outcome !== "refused" && suspendedAt === 0
      && reconciledAt > suspendedAt && (reboundAt === -1 || reboundAt > reconciledAt),
    inheritedCalibration: inherited(state.calibration.filter((e) => e.in_force)),
    reusedCachedAnswers: inherited(state.invocations.filter((a) => a.reusable)),
    historyPreserved: state.history.length >= pre.length && pre.every((e, i) => state.history[i] === e),
  };
}

// The negative control

export interface ProbeReport {
  readonly scenarios: Readonly<Record<string, RebindResult>>; readonly everyDetectorFires: boolean;
}

const SLICE: QualificationSlice = { task: "classify", language: "en", risk: "low" };

/**
 * Each detector is run twice: on a rebind that does the right thing, and on one made to do the
 * wrong thing, because a detector that answers `false` for everything answers `false` for a real
 * defect. The faults are carrying thresholds over under the new profile's name, qualifying on
 * everything except who answered, keeping the answer cache, and suspending after the switch.
 * `sameRef` is the grant detector's control: rebinding to the ref already bound revokes nothing.
 */
export function rebindDetectorProbe(): ProbeReport {
  const [saved, savedVersion] = [currentDefault, defaultVersion];
  const scenarios: Record<string, RebindResult> = {};
  const decl = (ref: string, role: BoundRole, identity: string): void => {
    declareProfile({
      profile_ref: ref, role, model_identity: identity, adapter: "adapter.one",
      renderer: "renderer.one", interpretation_profile_ref: "interp.one",
      endpoint_ref: "host-endpoint:probe", credential_ref: "host-credential:probe",
    });
  };
  decl("probe-assessor-a", "semantic_assessment", "model.a");
  decl("probe-assessor-b", "semantic_assessment", "model.b");
  decl("probe-reasoning", "reasoning", "model.r");
  decl("probe-runtime", "runtime", "model.t");
  if (declaredRole("probe-assessor-x") === undefined) {
    declareProfile({
      profile_ref: "probe-assessor-x", role: "semantic_assessment", model_identity: "model.x",
      adapter: "adapter.one", renderer: "renderer.one", interpretation_profile_ref: "interp.one",
      incompatible_with: ["probe-runtime"],
    });
  }

  const scenario = (name: string, target: string, faults: Faults, role?: BoundRole): void => {
    setDefaultBinding({
      reasoning_profile_ref: "probe-reasoning",
      semantic_assessment_profile_ref: "probe-assessor-a",
      runtime_profile_ref: "probe-runtime",
    });
    const run = startRun(`probe-${name}`);
    recordCalibration(run, "semantic_assessment", SLICE, 0.8);
    recordCalibration(run, "reasoning", SLICE, 0.6);
    recordInvocation(run, "semantic_assessment", SLICE, "cp-1", "q-1");
    recordInvocation(run, "reasoning", SLICE, "cp-2", "q-2");
    scenarios[name] = performRebind(run, { to: target, authority: "probe-authority", role }, faults);
  };

  scenario("clean", "probe-assessor-b", NO_FAULTS);
  scenario("sameRef", "probe-assessor-a", NO_FAULTS);
  scenario("rebadge", "probe-assessor-b", { ...NO_FAULTS, rebadge: true });
  scenario("looseKey", "probe-assessor-b", { ...NO_FAULTS, looseKey: true });
  scenario("reuseCache", "probe-assessor-b", { ...NO_FAULTS, reuseCache: true });
  scenario("switchFirst", "probe-assessor-b", { ...NO_FAULTS, switchBeforeSuspend: true });
  scenario("wrongSlot", "probe-reasoning", NO_FAULTS, "semantic_assessment");
  scenario("incompatible", "probe-assessor-x", NO_FAULTS);
  scenario("rewriteHistory", "probe-assessor-b", { ...NO_FAULTS, rewriteHistory: true });
  [currentDefault, defaultVersion] = [saved, savedVersion];

  const s = scenarios;
  const everyDetectorFires =
    s.clean.inheritedCalibration === false && s.clean.reusedCachedAnswers === false
    && s.clean.suspendedFirst && s.clean.historyPreserved && s.clean.revokedGrants.length === 1
    && s.clean.retainedGrants.length === 2 && s.clean.answersRetired === 1
    && s.clean.calibrationRetired === 1 && s.sameRef.revokedGrants.length === 0
    && s.sameRef.calibrationRetired === 0 && s.rebadge.inheritedCalibration
    && s.rebadge.reusedCachedAnswers && s.looseKey.inheritedCalibration
    && s.looseKey.reusedCachedAnswers && s.reuseCache.reusedCachedAnswers
    && s.switchFirst.suspendedFirst === false && s.wrongSlot.revokedGrants.length === 0
    && s.wrongSlot.outcome === "paused_for_migration"
    && s.incompatible.outcome === "paused_for_migration"
    && s.rewriteHistory.historyPreserved === false;
  return { scenarios, everyDetectorFires };
}
