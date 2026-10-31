/**
 * The generic control-loop host zz-core runs (`createHost`, @zz/contracts) driven by a second flow
 * whose steps mean something else entirely, and the kernel swept for SDLC vocabulary.
 *
 * The second flow and the detector that judges it are this check's own: nothing in a service runs
 * them, so they live beside the one caller they have.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHost, type ActionGrant, type ControlVerdict, type ProcedureStep, type ReviewedModule } from "@zz/contracts";
import { firstOf, root, sourceFiles, withoutComments } from "../read.ts";
import { check } from "../run.ts";

const STAGES = /"(explore|spec|spec-audit|plan|plan-audit|execute|review)"|sdlc-flow/;

/**
 * A procedure's shape, in properties the engine can observe.
 *
 * This compares a flow to another flow without comparing their vocabulary: how many steps
 * there are, whether they move one material kind or several, whether every step is closed by a
 * judgement, whether they run in a single line, and whether judgement-only steps sit behind
 * the material steps they judge.
 */
interface ProcedureSignature {
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
interface SecondFlowRun {
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
function runSecondFlowFixture(): SecondFlowRun {
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

check("the generic host serves a second flow and the kernel never branches on an SDLC stage", () => {
  const kernel = sourceFiles(["packages/contracts/src", "services/zz-core/src/host"], [".ts"]);
  if (kernel.length < 3) return "the kernel sweep reached almost nothing; this check is not looking where it claims";
  const leaks = kernel.filter((f) => STAGES.test(withoutComments(readFileSync(join(root, f), "utf8"))));
  if (leaks.length) return `generic kernel modules branch on SDLC vocabulary: ${firstOf(leaks, 5)}`;

  const r = runSecondFlowFixture();
  for (const op of ["run_start", "method_read", "evidence_record", "control_evaluate", "action_claim"]) {
    if (!r.invoked.includes(op)) return `the second-flow fixture never invoked ${op}, so it does not demonstrate the host is generic`;
  }
  if (r.reusedSdlcSemantics) return "the second-flow fixture reused SDLC stage semantics, so it proves nothing about genericity";
});
