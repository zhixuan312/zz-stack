import { validatePlan, admitToExecute } from "@zz/contracts";
import { check } from "../run.ts";

const good = "## Phase 1 — A: works\n### Task I-1: X (← AC-1.1)\n**Output:** a\n**Dependencies:** none\n";

check("the plan validator blocks malformed plans from controlled execution but not from being written", () => {
  if (!validatePlan(good).ok) return "a well-formed plan failed structural validation";

  const dupe = good + "### Task I-1: Y (← AC-1.2)\n**Output:** b\n**Dependencies:** none\n";
  if (validatePlan(dupe).ok) return "a plan with duplicate task ids passed";

  const cycle = good + "### Task I-2: Y (← AC-1.2)\n**Output:** b\n**Dependencies:** Task I-3\n"
                     + "### Task I-3: Z (← AC-1.3)\n**Output:** c\n**Dependencies:** Task I-2\n";
  if (validatePlan(cycle).ok) return "a plan with a dependency cycle passed";

  const noOutput = "## Phase 1 — A: works\n### Task I-1: X (← AC-1.1)\n**Dependencies:** none\n";
  if (validatePlan(noOutput).ok) return "a task with no Output passed";

  const approved = { humanApproved: true, structuralReport: validatePlan(dupe) };
  if (admitToExecute(approved).admitted) {
    return "a malformed plan was admitted to controlled execution because a human had approved it — "
         + "approval is a verdict on content, not a structural report";
  }
  if (admitToExecute({ humanApproved: true, structuralReport: undefined }).admitted) {
    return "a plan with no structural report at all was admitted";
  }
});
