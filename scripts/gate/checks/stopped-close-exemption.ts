/**
 * STOPPED WORK IS PRECISELY WORK WHOSE GATES WERE NOT PASSED.
 *
 * `closeInitiative` refused any close whose declared gates were unrecorded, for every
 * disposition. Applied to abandoned work that rule has no honest outcome: the normal shape of a
 * stopped initiative is a document written and never approved, so the caller is left forging an
 * approval nobody gave or leaving the initiative open forever — and the ledger's one hard
 * requirement is that nothing stays open forever. `closeCheck` in the service had already
 * learned this and said so in capitals; the kernel had not.
 *
 * THE SCOPING IS NARROW ON PURPOSE. Only the refusal turns on the disposition. `gatePosture`
 * still RECORDS `unrecorded` on an abandoned close, because what the caller said about the gates
 * is true whichever way the work ended and a later reader deserves it. Collapsing the
 * observation into the refusal would lose a fact to enforce a rule.
 *
 * WHY THIS IS ITS OWN FILE RATHER THAN A LINE IN `close-truthfulness.ts`. That check is frozen
 * plan text — declared verbatim in an approved plan and frozen before it was planted. Adding an
 * assertion to it would be editing an agreed check after the fact to match the code, which is the
 * thing this initiative refused to do everywhere else. A new rule gets a new file.
 *
 * AND IT IS THE ONLY THING HOLDING THE RULE. The service's own `gatesRecorded` computation was
 * deleted as a duplicate of `closeCheck`, so no runtime path reaches the scoped condition today.
 * Without this check a later edit to `close.ts` silently reverts a rule that real closed records
 * paid for, and nothing would notice.
 */
import { closeInitiative } from "@zz/contracts";
import { check } from "../run.ts";

check("a stopped close is not refused over gates nobody passed, and a finished one still is", () => {
  const stopped = closeInitiative({ disposition: "abandoned", gatesRecorded: false });
  if (!stopped.ok) {
    return "an abandoned close was refused over an unrecorded gate — stopped work is precisely "
         + "work whose gates were not passed, so this leaves no way to record that it stopped "
         + "except forging an approval or leaving the initiative open forever";
  }
  if (stopped.gatePosture !== "unrecorded") {
    return `an abandoned close reports gatePosture ${JSON.stringify(stopped.gatePosture)} rather `
         + "than what it was told — the refusal is scoped to a finished close, the observation is "
         + "not, and a record that drops what it was told about the gates says less than it knew";
  }

  // THE OTHER HALF, without which this check passes on a kernel that refuses nothing at all.
  // An exemption is only an exemption if the rule still holds where it was not exempted.
  const finished = closeInitiative({ disposition: "finished", gatesRecorded: false });
  if (finished.ok) {
    return "a finished close was permitted with a declared gate left unrecorded — the exemption "
         + "is for stopped work, and it has swallowed the rule it was carved out of";
  }
});
