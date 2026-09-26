/**
 * The generic control-loop host: what a reviewed module is, the five operations a host serves,
 * and a second flow's controller that drives all five.
 *
 * The engine lives here, not in the service: `@zz/contracts` is the leaf of this repository's
 * dependency graph, so a host built in `services/zz-core` could not be driven from here.
 * `services/zz-core/src/host/` owns the service's half — which modules the release packages,
 * the allowlist and digest that gate registration, and the job that walks a run's steps.
 *
 * This module knows nothing about what any flow's steps mean. A step has a method somebody
 * reads, evidence kinds it accepts, completion rules over that evidence, and actions it grants
 * once those rules are met; whether it is a draft, an audit, a purchase or a sign-off is
 * content the module carries, never a branch here. {@link runSecondFlowFixture} drives the same
 * engine with a flow whose steps mean something else entirely.
 *
 * Material and judgement are the one distinction the engine draws: an evidence kind either
 * carries new facts about the subject or rates what is already recorded. That is enough for
 * {@link procedureSignature} to describe the shape of a long, linear, approval-gated document
 * pipeline without naming a stage, and for {@link reusesGatedDocumentPipeline} to judge it.
 */
import { createHash } from "node:crypto";

/**
 * One kind of evidence a step accepts.
 *
 * `carries` is the only classification the engine makes, and it is structural rather than
 * lexical: `material` adds facts about the run's subject, `judgement` rates material already
 * recorded.
 */
export interface EvidenceKind {
  readonly name: string;
  readonly carries: "material" | "judgement";
}

/**
 * One condition a step must satisfy before it grants anything.
 *
 * `atLeast` counts entries of `kind` recorded against the step. `about`, when set, names the
 * kind an entry must point at to be counted — so "one award decision, about a quote that was
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
 *  is visibly linear. It names the immediate predecessors and binds the whole chain behind
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
 * `requires` lists the attributes a caller's profile must carry; the engine compares two lists
 * of opaque strings and refuses the difference. Which attributes exist, and who has them, is
 * the deployment's business.
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
  /** The id of an earlier entry this one withdraws, if any: every entry carrying that id
   *  recorded before this one, and none recorded after it.
   *
   *  The log stays append-only: the earlier fact really happened, so deleting the entry would
   *  falsify the history, but counting it would answer a question about the run's current
   *  state with a fact that has been withdrawn.
   *
   *  Generic by construction: an id, not a kind and not a document. The kernel does not know
   *  what a revision is; it knows that a later entry said an earlier one no longer stands. */
  readonly supersedes?: string;
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
 * `trace` lets a caller prove the host was actually driven rather than assert it. The fixture
 * below returns this array, not a list of its own.
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

// The five operation names, spelled once. They are what `trace` records, so a second spelling
// anywhere is a second answer to "which operation ran".
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
  // What a later entry withdrew is not counted, on either side of the back-reference: an
  // approval standing on a withdrawn document entry would be a reference into history rather
  // than into the run's current state. One set, applied twice.
  //
  // Withdrawal is positional. An entry withdraws the entries carrying that id that were
  // recorded BEFORE it, never one recorded after: ids repeat — a document approved, revised and
  // approved again records the same approval id twice — and the second approval answers the
  // revision rather than being withdrawn by it. The set holds entries, not ids, for that reason.
  const withdrawn = new Set<EvidenceEntry>();
  evidence.forEach((e, at) => {
    if (e.supersedes === undefined || e.supersedes === "") return;
    for (const earlier of evidence.slice(0, at)) {
      if (earlier.id === e.supersedes) withdrawn.add(earlier);
    }
  });
  const here = evidence.filter(
    (e) => e.stepId === stepId && e.kind === rule.kind && !withdrawn.has(e));
  const counted = rule.about === undefined
    ? here
    : here.filter((e) => evidence.some(
        (p) => p.kind === rule.about && p.id === e.about && !withdrawn.has(p)));
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
 * DELIBERATE: this runs at registration, which happens once, rather than inside the evaluation
 * that runs on every claim. Refusing here makes the recursive predecessor check terminating by
 * construction instead of guarded per call.
 *
 * An unknown predecessor is not this function's business: a step naming an `after` the module
 * does not declare is already refused by name, with the id in the message, the first time
 * anything asks about that step.
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
 * service composing one at boot and a fixture composing one in a test cannot interfere.
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
  // records one operation rather than two.
  //
  // A predecessor is satisfied, not merely counted. `after` names the immediate predecessors,
  // and a step has not completed while anything behind it is outstanding, however far back — so
  // the answer for a predecessor is the same answer this function gives, which is why it asks
  // itself for it. Asking only whether the step before met its own completion rules is one
  // level deep, and a step whose completion rules are empty is vacuously met: a permanent hole
  // every later step would be measured through.
  //
  // `settled` memoises one top-level answer: a procedure that fans out and rejoins reaches the
  // same ancestor down several paths, and re-deriving it each time is exponential in the depth
  // of the fan. It is scoped to the call, never to the host — evidence arrives between calls,
  // and a verdict cached across them would describe a run that has since moved on.
  //
  // COUPLED: termination is established at registration by `refuseCycle`, so this recursion is
  // safe by construction rather than defended on every claim.
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
      // Why the predecessor is not done comes with it: "the step before has not completed" is
      // useless when that step is itself waiting on something three links back. Carrying the
      // earlier verdict's own sentences up makes the answer a trail ending at the thing
      // somebody has to record. Deduplicated, because a procedure that fans out and rejoins
      // reaches one ancestor down two paths and a reason stated twice reads as two reasons.
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
 * COUPLED: `services/zz-core/src/reviewed-modules.ts` records a digest beside each body and
 * `services/zz-core/src/host/registry.ts` recomputes one at registration — both numbers come
 * from this function. Canonical means object keys in sorted order, so a body that is
 * reformatted, or whose fields are written in another order, hashes the same; a body whose
 * content changed does not.
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
 * This compares a flow to another flow without comparing their vocabulary: how many steps
 * there are, whether they move one material kind or several, whether every step is closed by a
 * judgement, whether they run in a single line, and whether judgement-only steps sit behind
 * the material steps they judge.
 */
export interface ProcedureSignature {
  readonly stepCount: number;
  readonly oneMaterialKindThroughout: boolean;
  readonly everyStepClosedByJudgement: boolean;
  readonly strictlyLinear: boolean;
  readonly judgementStepsFollowMaterial: boolean;
}

function procedureSignature(module: ReviewedModule): ProcedureSignature {
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
    // DELIBERATE: not a strict alternation. A pipeline that audits its second artifact but not
    // its first would slip that detector. What every such pipeline has is at least two
    // judgement-only steps sitting behind material ones, never two in a row judging each other.
    judgementStepsFollowMaterial:
      judgementOnly.filter(Boolean).length >= 2
      && judgementOnly.every((j, i) => !j || (i > 0 && !judgementOnly[i - 1])),
  };
}

/**
 * Whether a module is the platform's own authored-and-audited document pipeline wearing
 * another set of names.
 *
 * DELIBERATE: five steps is the floor. Below it a judgement following a material step is a
 * coincidence — any short procedure that ends by checking its own output satisfies it. At five
 * or more, one material kind carried the whole way, every step closed by a judgement, a single
 * line of steps and judgement-only steps behind the material ones is that pipeline whatever
 * its steps are called.
 */
function reusesGatedDocumentPipeline(module: ReviewedModule): boolean {
  const shape = procedureSignature(module);
  return shape.stepCount >= 5
    && shape.oneMaterialKindThroughout
    && shape.everyStepClosedByJudgement
    && shape.strictlyLinear
    && shape.judgementStepsFollowMaterial;
}

// The second flow, and the negative control that proves the detector fires
//
// A two-step procurement award: two steps rather than seven, three material kinds rather than
// one, no judgement kind at all, and a completion rule that counts evidence and follows a
// back-reference rather than waiting for an approval. Everything the engine does for it, it
// does from the module's data.

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

// The negative control: seven linear steps, one material kind carried throughout, every step
// closed by a sign-off, and judgement-only steps behind the material ones — the shape of the
// platform's own pipeline, with steps named after nothing at all. It shows
// `reusedSdlcSemantics` is computed rather than always false, and the fixture reports both
// answers.
//
// DELIBERATE: `JUDGED` is irregular, not a neat alternation. The platform's own pipeline
// authors its first two steps back to back and judges only some of what follows, so a tidy
// control would be one the detector passes and the thing it stands in for does not: the third,
// fifth and seventh steps judge, the rest produce.

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
 * Synchronous all the way down, because the engine is: there is nothing to wait for in a
 * registry, a list of evidence and a count.
 *
 * DELIBERATE: the claim in the middle is refused. `shortlist` is claimed after one quote and
 * refused — the step's own completion rule says two — then claimed again once the second quote
 * and the budget line are in.
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
