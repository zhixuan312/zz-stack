/**
 * The evaluation job: every step of one run, evaluated in one pass. `control_evaluate`
 * answers for one step; this is the whole procedure, so callers asking where a run stands do
 * not each assemble their own answer.
 *
 * DELIBERATE: nothing is decided here. The job reads the module's own steps in the order the
 * module declares them and asks the host about each; whether a step is met is the host's
 * answer and the module's rules, never a judgement this file makes.
 */
import type { Host, ReviewedModule } from "@zz/contracts";

/** Where one step of a run stands: whether its controls are met, what is still missing, and
 *  what completing it makes claimable. `grants` is carried through so a reader is told what
 *  the step is for without going back to the module. */
export interface StepEvaluation {
  readonly stepId: string;
  readonly satisfied: boolean;
  readonly unmet: readonly string[];
  readonly grants: readonly string[];
}

/** Evaluate every step of `runId`, in the order `module` declares them. */
export function evaluateRun(
  host: Host,
  module: ReviewedModule,
  runId: string,
): readonly StepEvaluation[] {
  return module.steps.map((step): StepEvaluation => {
    const verdict = host.controlEvaluate(runId, step.id);
    return {
      stepId: step.id,
      satisfied: verdict.satisfied,
      unmet: verdict.unmet,
      grants: step.grants,
    };
  });
}
