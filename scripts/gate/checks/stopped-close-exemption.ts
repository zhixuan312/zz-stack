/**
 * Stopped work is precisely work whose gates were not passed, so a close refused over an
 * unrecorded gate leaves the caller forging an approval nobody gave or leaving the initiative
 * open forever. `closeInitiative` scopes that refusal to `finished`.
 *
 * DELIBERATE: only the refusal turns on the disposition. `gatePosture` still records
 * `unrecorded` on an abandoned close, because what the caller said about the gates is true
 * whichever way the work ended.
 *
 * COUPLED: no runtime path reaches the scoped condition, so this check is the only thing
 * holding the rule against a later edit to `close.ts`.
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

  // The other half: an exemption is only an exemption if the rule still holds where it was not
  // exempted, and without this the check passes on a kernel that refuses nothing at all.
  const finished = closeInitiative({ disposition: "finished", gatesRecorded: false });
  if (finished.ok) {
    return "a finished close was permitted with a declared gate left unrecorded — the exemption "
         + "is for stopped work, and it has swallowed the rule it was carved out of";
  }
});
