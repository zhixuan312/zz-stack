/**
 * The generic control-loop host: what a reviewed module is, the five operations a host serves,
 * and a second flow's controller that drives all five.
 *
 * WHY THE ENGINE IS HERE AND NOT IN THE SERVICE. `@zz/contracts` is the leaf of this
 * repository's dependency graph — every service depends on it and it depends on nothing but
 * zod — so a host built in `services/zz-core` cannot be driven from here, and a fixture that
 * drove a second copy of the engine would demonstrate nothing about the one that ships. The
 * engine is therefore the contract: the types and the behaviour they imply, in one place both
 * the service and the fixture reach. `services/zz-core/src/host/` owns what genuinely belongs
 * to the service — which modules the release packages, the allowlist and digest that decide
 * whether one may be registered at all, and the evaluation job that walks a run's steps.
 *
 * WHAT THIS MODULE DOES NOT KNOW, stated because it is the whole point: it has no idea what
 * any particular flow's steps mean. It knows a step has a method somebody reads, evidence
 * kinds it accepts, completion rules over that evidence, and actions it grants once those
 * rules are met. Whether a step is a draft, an audit, a purchase or a sign-off is content the
 * module carries, never a branch in here — and the only way to be sure of that is to drive
 * the same engine with a flow whose steps mean something else entirely, which is what
 * {@link runSecondFlowFixture} does.
 *
 * MATERIAL AND JUDGEMENT are the one distinction the engine draws, and it is deliberately not
 * a vocabulary: an evidence kind either carries new facts about the subject or rates what is
 * already recorded. That is enough to describe the SHAPE of a long, linear, approval-gated
 * document pipeline without naming a single one of its stages — which is what
 * {@link procedureSignature} computes and {@link reusesGatedDocumentPipeline} judges.
 */
import { createHash } from "node:crypto";

/**
 * One kind of evidence a step accepts.
 *
 * `carries` is the only classification the engine makes, and it is structural rather than
 * lexical: `material` adds facts about the run's subject, `judgement` rates material already
 * recorded. A flow that moves one material artifact through every step and closes each with a
 * judgement has a recognisable shape; a flow that records three different material kinds and
 * no judgement at all does not. Neither fact requires knowing what any of them are called.
 */
export interface EvidenceKind {
  readonly name: string;
  readonly carries: "material" | "judgement";
}

/**
 * One condition a step must satisfy before it grants anything.
 *
 * `atLeast` counts entries of `kind` recorded against the step. `about`, when set, names the
 * kind an entry must POINT AT to be counted — so "one award decision, about a quote that was
 * actually recorded" is expressible without the engine knowing what an award or a quote is.
 */
export interface CompletionRule {
  readonly kind: string;
  readonly atLeast: number;
  readonly about?: string;
}

/** One step of a procedure: the method somebody reads, what it accepts, what completes it,
 *  and what completing it makes claimable. `after` names the steps that must have completed
 *  first — a list, so a procedure that fans out is expressible and a procedure that does not
 *  is visibly linear. It names the IMMEDIATE predecessors and binds the whole chain behind
 *  them: a step has not completed while anything it follows is outstanding, however far back,
 *  so a procedure states each link once and gets the order it wrote down. */
export interface ProcedureStep {
  readonly id: string;
  readonly method: string;
  readonly after: readonly string[];
  readonly accepts: readonly EvidenceKind[];
  readonly completion: readonly CompletionRule[];
  readonly grants: readonly string[];
}

/**
 * Who may start a run of this module.
 *
 * A PROFILE RULE THE HOST CHECKS, never a behaviour the host hardcodes. `requires` lists the
 * attributes a caller's profile must carry; the engine compares two lists of opaque strings
 * and refuses the difference. Which attributes exist, and who has them, is the deployment's
 * business — this is the mechanism, and there is no second one for any particular flow.
 */
export interface EnrolmentRule {
  readonly requires: readonly string[];
}

/** A reviewed module: a procedure a host may run, as data. Reviewed because nothing reaches a
 *  host except through registration, and registration is where an allowlist and a digest
 *  decide whether this body is one the release actually vouches for. */
export interface ReviewedModule {
  readonly id: string;
  readonly enrolment: EnrolmentRule;
  readonly steps: readonly ProcedureStep[];
}

/** Who is starting a run, and what it is about. The profile is the caller's attributes, which
 *  the module's enrolment rule is checked against. */
export interface RunCaller {
  readonly subject: string;
  readonly profile: readonly string[];
}

/**
 * One piece of evidence recorded against a step.
 *
 * `id` is this entry's own handle, so a later entry can be `about` it — that back-reference is
 * what a completion rule's `about` follows. `about` otherwise names the run's subject, and the
 * engine does not check which of the two it is: an entry pointing at nothing recorded simply
 * does not satisfy a rule that demands one.
 */
export interface EvidenceEntry {
  readonly id: string;
  readonly stepId: string;
  readonly kind: string;
  readonly about: string;
  readonly note: string;
}

/** What a caller hands to `evidence_record`; the step is supplied alongside it and attached
 *  here, so an entry cannot claim to belong to a step it was not recorded against. */
export type EvidenceDraft = Omit<EvidenceEntry, "stepId">;

/** Whether a step's controls are met, and which are not. `unmet` is sentences rather than
 *  codes because the only reader is somebody deciding what to record next. */
export interface ControlVerdict {
  readonly satisfied: boolean;
  readonly unmet: readonly string[];
}

/** The answer to `action_claim`: whether the action is granted, and, when it is not, the one
 *  sentence saying why. A refusal is a result rather than a throw — being told what is still
 *  missing is the normal path through a control loop, not a fault. */
export interface ActionGrant {
  readonly action: string;
  readonly granted: boolean;
  readonly refusal: string | null;
}

/**
 * The generic host: registration, the five operations, and the record of what was invoked.
 *
 * `trace` exists so that a caller can prove the host was actually driven rather than assert
 * it. The fixture below returns this array, not a list of its own — a fixture that appended
 * five strings to a list of its own would pass any check that reads it and demonstrate
 * nothing.
 */
export interface Host {
  readonly trace: readonly string[];
  register(module: ReviewedModule): void;
  registered(): readonly string[];
  runStart(moduleId: string, caller: RunCaller): string;
  methodRead(runId: string, stepId: string): string;
  evidenceRecord(runId: string, stepId: string, draft: EvidenceDraft): EvidenceEntry;
  controlEvaluate(runId: string, stepId: string): ControlVerdict;
  actionClaim(runId: string, stepId: string, action: string): ActionGrant;
}

// The five operation names, spelled once. They are what `trace` records and what any door
// that ever fronts this host would be named after, so a second spelling anywhere is a second
// answer to "which operation ran".
const RUN_START = "run_start";
const METHOD_READ = "method_read";
const EVIDENCE_RECORD = "evidence_record";
const CONTROL_EVALUATE = "control_evaluate";
const ACTION_CLAIM = "action_claim";

interface HostRun {
  readonly id: string;
  readonly module: ReviewedModule;
  readonly subject: string;
  readonly evidence: EvidenceEntry[];
}

/** Whether one completion rule is met by a run's evidence. Entries are counted against the
 *  step they were recorded on; `about` follows the back-reference into the whole run, because
 *  the thing an entry points at was usually recorded at an earlier step. */
function met(rule: CompletionRule, evidence: readonly EvidenceEntry[], stepId: string): boolean {
  const here = evidence.filter((e) => e.stepId === stepId && e.kind === rule.kind);
  const counted = rule.about === undefined
    ? here
    : here.filter((e) => evidence.some((p) => p.kind === rule.about && p.id === e.about));
  return counted.length >= rule.atLeast;
}

/** The one sentence a rule that is not met produces. */
function unmetSentence(rule: CompletionRule, stepId: string): string {
  const about = rule.about === undefined ? "" : ` about a recorded ${rule.about}`;
  return `${stepId} needs ${rule.atLeast} ${rule.kind}${about}`;
}

/**
 * Refuse a procedure whose `after` graph closes on itself.
 *
 * AT REGISTRATION, WHICH HAPPENS ONCE, rather than inside the evaluation that runs on every
 * claim. A registration is the platform accepting a body whose digest somebody reviewed; that
 * is where a defect in the body belongs, and refusing there makes the recursive predecessor
 * check terminating by construction instead of guarded per call — a guard that would otherwise
 * have to answer "this procedure cannot be evaluated" to a caller who cannot act on it.
 *
 * AN UNKNOWN PREDECESSOR IS NOT THIS FUNCTION'S BUSINESS. A step naming an `after` the module
 * does not declare is already refused by name, with the id in the message, the first time
 * anything asks about that step. Folding it in here would give one fault two answers.
 */
function refuseCycle(module: ReviewedModule): void {
  const steps = new Map(module.steps.map((s) => [s.id, s]));
  const open = new Set<string>();
  const done = new Set<string>();
  const walk = (id: string, path: readonly string[]): void => {
    if (done.has(id)) return;
    if (open.has(id)) {
      const cycle = [...path.slice(path.indexOf(id)), id].join(" -> ");
      throw new Error(`${module.id} declares a cycle in the steps that must come first: ` +
                      `${cycle} — no step in it can ever be entered`);
    }
    open.add(id);
    for (const before of steps.get(id)?.after ?? []) walk(before, [...path, id]);
    open.delete(id);
    done.add(id);
  };
  for (const step of module.steps) walk(step.id, []);
}

/**
 * A host with nothing registered.
 *
 * Every instance is independent — no module-scope registry, no process-wide state — so a
 * service composing one at boot and a fixture composing one in a test cannot interfere, and
 * neither depends on the order the other ran in.
 */
export function createHost(): Host {
  const modules = new Map<string, ReviewedModule>();
  const runs = new Map<string, HostRun>();
  const trace: string[] = [];
  let sequence = 0;

  const runOf = (runId: string): HostRun => {
    const run = runs.get(runId);
    if (!run) throw new Error(`no run ${runId} is open on this host`);
    return run;
  };
  const stepOf = (run: HostRun, stepId: string): ProcedureStep => {
    const step = run.module.steps.find((s) => s.id === stepId);
    if (!step) throw new Error(`${run.module.id} has no step ${stepId}`);
    return step;
  };
  // Shared by `control_evaluate` and `action_claim`, and untraced, so that claiming an action
  // records one operation rather than two — a claim is not an evaluation the caller asked for.
  //
  // A PREDECESSOR IS SATISFIED, NOT MERELY COUNTED, and the difference is the whole chain.
  // This asked whether the step before had met its own completion rules, which says nothing
  // about the steps before THAT — so the check was one level deep and a seven-step procedure
  // was six steps of decoration. Two consequences, both observed on the first real module
  // registered against this engine: a step whose completion rules are empty is vacuously met,
  // so it was a permanent hole every later step was measured through; and an action could be
  // claimed at step five with steps one and two visibly unsatisfied. `after` means the steps
  // that must have completed first, and a step has not completed while anything behind it is
  // outstanding — so the answer for a predecessor is the same answer this function gives,
  // which is why it asks itself for it.
  //
  // `settled` MEMOISES ONE TOP-LEVEL ANSWER. A procedure that fans out and rejoins reaches the
  // same ancestor down several paths, and re-deriving it each time is exponential in the depth
  // of the fan. It is scoped to the call, never to the host: evidence arrives between calls,
  // and a verdict cached across them would be an answer about a run that has since moved on.
  //
  // TERMINATION IS ESTABLISHED AT REGISTRATION, not here. `refuseCycle` turns a body whose
  // `after` graph closes on itself away at the door, so this recursion is safe by construction
  // rather than defended on every claim.
  const evaluate = (run: HostRun, step: ProcedureStep,
                    settled: Map<string, ControlVerdict> = new Map()): ControlVerdict => {
    const unmet: string[] = [];
    for (const before of step.after) {
      const earlier = stepOf(run, before);
      let verdict = settled.get(before);
      if (verdict === undefined) {
        verdict = evaluate(run, earlier, settled);
        settled.set(before, verdict);
      }
      // WHY THE PREDECESSOR IS NOT DONE COMES WITH IT. "the step before has not completed" is
      // true and useless when that step is itself waiting on something three links back: the
      // reader is told to go and look, having asked the one question that would have told
      // them. Carrying the earlier verdict's own sentences up makes the answer a trail that
      // ends at the thing somebody has to record. Deduplicated because a procedure that fans
      // out and rejoins reaches one ancestor down two paths, and a reason stated twice reads
      // as two reasons.
      if (!verdict.satisfied) {
        unmet.push(`${before} has not completed, and ${step.id} follows it`, ...verdict.unmet);
      }
    }
    for (const rule of step.completion) {
      if (!met(rule, run.evidence, step.id)) unmet.push(unmetSentence(rule, step.id));
    }
    const distinct = [...new Set(unmet)];
    return { satisfied: distinct.length === 0, unmet: distinct };
  };

  return {
    trace,
    register(module) {
      if (modules.has(module.id)) throw new Error(`${module.id} is already registered`);
      refuseCycle(module);
      modules.set(module.id, module);
    },
    registered() {
      return [...modules.keys()];
    },
    runStart(moduleId, caller) {
      trace.push(RUN_START);
      const module = modules.get(moduleId);
      if (!module) throw new Error(`no module ${moduleId} is registered on this host`);
      const missing = module.enrolment.requires.filter((a) => !caller.profile.includes(a));
      if (missing.length) {
        throw new Error(`the caller's profile carries none of ${missing.join(", ")}, ` +
                        `which ${moduleId} requires`);
      }
      sequence += 1;
      const id = `${moduleId}/${sequence}`;
      runs.set(id, { id, module, subject: caller.subject, evidence: [] });
      return id;
    },
    methodRead(runId, stepId) {
      trace.push(METHOD_READ);
      return stepOf(runOf(runId), stepId).method;
    },
    evidenceRecord(runId, stepId, draft) {
      trace.push(EVIDENCE_RECORD);
      const run = runOf(runId);
      const step = stepOf(run, stepId);
      if (!step.accepts.some((k) => k.name === draft.kind)) {
        throw new Error(`${stepId} does not accept ${draft.kind}`);
      }
      const entry: EvidenceEntry = { ...draft, stepId };
      run.evidence.push(entry);
      return entry;
    },
    controlEvaluate(runId, stepId) {
      trace.push(CONTROL_EVALUATE);
      const run = runOf(runId);
      return evaluate(run, stepOf(run, stepId));
    },
    actionClaim(runId, stepId, action) {
      trace.push(ACTION_CLAIM);
      const run = runOf(runId);
      const step = stepOf(run, stepId);
      if (!step.grants.includes(action)) {
        return { action, granted: false, refusal: `${stepId} does not grant ${action}` };
      }
      const verdict = evaluate(run, step);
      return verdict.satisfied
        ? { action, granted: true, refusal: null }
        : { action, granted: false, refusal: verdict.unmet.join("; ") };
    },
  };
}

/**
 * A module's digest: sha-256 over its canonical form.
 *
 * DECLARED HERE, BESIDE THE TYPE, because the release writes a digest into an allowlist and a
 * host recomputes one at registration, and those two numbers have to be produced by the same
 * function or the comparison is theatre. Canonical means object keys in sorted order — a body
 * that is reformatted, or whose fields are written in another order, hashes the same; a body
 * whose CONTENT changed does not.
 */
export function moduleDigest(module: ReviewedModule): string {
  return createHash("sha256").update(canonical(module)).digest("hex");
}

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

/**
 * A procedure's shape, in properties the engine can observe.
 *
 * This is how a flow is compared to another flow without comparing their vocabulary. A ban on
 * words proves nothing — the same seven stages under seven new names would pass it — so what
 * is measured here is what the steps DO: how many there are, whether they move one material
 * kind or several, whether every step is closed by a judgement, whether they run in a single
 * line, and whether judgement-only steps sit behind the material steps they judge.
 */
export interface ProcedureSignature {
  readonly stepCount: number;
  readonly oneMaterialKindThroughout: boolean;
  readonly everyStepClosedByJudgement: boolean;
  readonly strictlyLinear: boolean;
  readonly judgementStepsFollowMaterial: boolean;
}

export function procedureSignature(module: ReviewedModule): ProcedureSignature {
  const steps = module.steps;
  const materialKinds = new Set(steps.flatMap((s) =>
    s.accepts.filter((k) => k.carries === "material").map((k) => k.name)));
  const judgementKinds = new Set(steps.flatMap((s) =>
    s.accepts.filter((k) => k.carries === "judgement").map((k) => k.name)));
  const judgementOnly = steps.map((s) =>
    s.accepts.length > 0 && s.accepts.every((k) => k.carries === "judgement"));
  const predecessors = steps.flatMap((s) => s.after);
  return {
    stepCount: steps.length,
    oneMaterialKindThroughout: materialKinds.size === 1,
    everyStepClosedByJudgement:
      steps.length > 0 && steps.every((s) => s.completion.some((r) => judgementKinds.has(r.kind))),
    strictlyLinear:
      steps.every((s, i) => s.after.length === (i === 0 ? 0 : 1))
      && new Set(predecessors).size === Math.max(steps.length - 1, 0),
    // NOT A STRICT ALTERNATION, and the difference matters. "Judgement-only steps at odd
    // positions" describes one arrangement of authored and audited work; a pipeline that
    // audits its second artifact but not its first does not have it, and would slip the
    // detector entirely. What every such pipeline DOES have is judgement-only steps that sit
    // behind material ones — at least two of them, each immediately after a step that
    // actually produced something, never two in a row judging each other.
    judgementStepsFollowMaterial:
      judgementOnly.filter(Boolean).length >= 2
      && judgementOnly.every((j, i) => !j || (i > 0 && !judgementOnly[i - 1])),
  };
}

/**
 * Whether a module is the platform's own authored-and-audited document pipeline wearing
 * another set of names.
 *
 * THE FIVE-STEP FLOOR IS NOT DECORATION. A judgement following a material step is a
 * coincidence across two or three steps — any short procedure that ends by checking its own
 * output satisfies it — so below five steps the shape has not actually repeated and claiming
 * a pipeline would be reading a pattern into noise. At five or more, one material kind
 * carried the whole way, every step closed by a judgement, a single line of steps and
 * judgement-only steps behind the material ones is that pipeline whatever its steps are
 * called.
 */
export function reusesGatedDocumentPipeline(module: ReviewedModule): boolean {
  const shape = procedureSignature(module);
  return shape.stepCount >= 5
    && shape.oneMaterialKindThroughout
    && shape.everyStepClosedByJudgement
    && shape.strictlyLinear
    && shape.judgementStepsFollowMaterial;
}

// ── the second flow, and the negative control that proves the detector fires ────────────────
//
// A two-step procurement award. It is not the platform's own flow with the nouns changed: it
// has two steps rather than seven, three material kinds rather than one, no judgement kind at
// all, and a completion rule that COUNTS evidence and follows a back-reference rather than
// waiting for somebody to approve a document. Everything the engine does for it, it does from
// the module's data.

const procurementAward = (): ReviewedModule => ({
  id: "procurement-award",
  enrolment: { requires: ["spend-authority"] },
  steps: [
    {
      id: "sourcing",
      method: "Get a priced quote from at least two suppliers for the thing being bought, and " +
              "record the budget line the money comes out of. Quotes are recorded as they " +
              "arrive; the step completes when two of them and one budget line are in.",
      after: [],
      accepts: [
        { name: "supplier-quote", carries: "material" },
        { name: "budget-line", carries: "material" },
      ],
      completion: [
        { kind: "supplier-quote", atLeast: 2 },
        { kind: "budget-line", atLeast: 1 },
      ],
      grants: ["shortlist"],
    },
    {
      id: "award",
      method: "Name the quote the order goes to. The decision must point at a quote that was " +
              "actually recorded during sourcing — an award naming a supplier nobody quoted " +
              "is the failure this step exists to catch.",
      after: ["sourcing"],
      accepts: [{ name: "award-decision", carries: "material" }],
      completion: [{ kind: "award-decision", atLeast: 1, about: "supplier-quote" }],
      grants: ["purchase-order"],
    },
  ],
});

// THE NEGATIVE CONTROL. Seven linear steps, one material kind carried throughout, every step
// closed by a sign-off, and judgement-only steps behind the material ones — the shape of the
// platform's own pipeline, with steps named after nothing at all. It exists so that
// `reusedSdlcSemantics` can be shown to be computed: a detector that answered false for
// everything would answer false for this too, and the fixture reports both answers.
//
// THE PATTERN IS THE REAL ONE, NOT A TIDY ONE. The platform's own pipeline does not audit
// every artifact — its first two steps are authored back to back and only some of what
// follows is judged — so a control built as a neat alternation would have been a control the
// detector passes and the thing it is standing in for does not. `JUDGED` is that irregular
// pattern: the third, fifth and seventh steps judge, the rest produce.

const JUDGED = [false, false, true, false, true, false, true];

const gatedDocumentPipeline = (): ReviewedModule => ({
  id: "gated-document-pipeline",
  enrolment: { requires: [] },
  steps: JUDGED.map((judgesOnly, i): ProcedureStep => ({
    id: `step-${i + 1}`,
    method: "Carry the document one step further, then have it signed off.",
    after: i === 0 ? [] : [`step-${i}`],
    accepts: judgesOnly
      ? [{ name: "sign-off", carries: "judgement" }]
      : [{ name: "document", carries: "material" }, { name: "sign-off", carries: "judgement" }],
    completion: [{ kind: "sign-off", atLeast: 1 }],
    grants: [judgesOnly ? "hand-on" : "sign-off-request"],
  })),
});

/** What {@link runSecondFlowFixture} reports: the host's own record of what was invoked, the
 *  structural verdict on the flow it drove, and the evidence behind that verdict. */
export interface SecondFlowRun {
  readonly invoked: readonly string[];
  readonly reusedSdlcSemantics: boolean;
  readonly signature: ProcedureSignature;
  readonly detectorFiresOnAGatedDocumentPipeline: boolean;
  readonly verdicts: readonly ControlVerdict[];
  readonly grants: readonly ActionGrant[];
  readonly registered: readonly string[];
}

/**
 * Drive the generic host through all five operations as a procurement award.
 *
 * SYNCHRONOUS, ALL THE WAY DOWN, because the engine is: there is nothing to wait for in a
 * registry, a list of evidence and a count, and a caller reading `invoked` off the result has
 * no promise to unwrap.
 *
 * The claim in the middle is deliberate. `shortlist` is claimed after one quote and refused —
 * not because the action is unknown, but because the step's own completion rule says two — and
 * claimed again once the second quote and the budget line are in. That is the control loop
 * doing its job on a rule this engine has never heard of.
 */
export function runSecondFlowFixture(): SecondFlowRun {
  const host = createHost();
  const module = procurementAward();
  host.register(module);

  const runId = host.runStart(module.id, {
    subject: "two field laptops for the survey team",
    profile: ["spend-authority", "field-operations"],
  });

  host.methodRead(runId, "sourcing");
  host.evidenceRecord(runId, "sourcing", {
    id: "quote-1", kind: "supplier-quote",
    about: "two field laptops for the survey team", note: "1940 for two, ten days",
  });
  const tooEarly = host.actionClaim(runId, "sourcing", "shortlist");
  host.evidenceRecord(runId, "sourcing", {
    id: "quote-2", kind: "supplier-quote",
    about: "two field laptops for the survey team", note: "1815 for two, three weeks",
  });
  host.evidenceRecord(runId, "sourcing", {
    id: "budget-2026-q3", kind: "budget-line",
    about: "two field laptops for the survey team", note: "3000 left against field equipment",
  });
  const sourcing = host.controlEvaluate(runId, "sourcing");
  const shortlisted = host.actionClaim(runId, "sourcing", "shortlist");

  host.methodRead(runId, "award");
  host.evidenceRecord(runId, "award", {
    id: "award-1", kind: "award-decision",
    about: "quote-2", note: "cheaper, and the delay is inside the survey window",
  });
  const award = host.controlEvaluate(runId, "award");
  const ordered = host.actionClaim(runId, "award", "purchase-order");

  return {
    invoked: [...host.trace],
    reusedSdlcSemantics: reusesGatedDocumentPipeline(module),
    signature: procedureSignature(module),
    detectorFiresOnAGatedDocumentPipeline: reusesGatedDocumentPipeline(gatedDocumentPipeline()),
    verdicts: [sourcing, award],
    grants: [tooEarly, shortlisted, ordered],
    registered: host.registered(),
  };
}
