import { deriveOutcome, closeInitiative } from "@zz/contracts";
import { check } from "../run.ts";

check("a close says only what is known", () => {
  if (deriveOutcome({ disposition: "finished", accepted_by: "A" }) !== "accepted") return "finished with an acceptor is not accepted";
  if (deriveOutcome({ disposition: "finished", no_signoff_reason: "r" }) !== "delivered") return "finished with no sign-off is not delivered";
  if (deriveOutcome({ disposition: "abandoned" }) !== "abandoned") return "abandoned is not abandoned";
  if (closeInitiative({ disposition: "finished" }).acceptedByHand) return "outcome was written by hand rather than derived";

  const ab = closeInitiative({ disposition: "abandoned", reachedStage: "spec" });
  if (ab.stages.some((s) => s.state === "established" && !s.evidence.length)) {
    return "an abandoned close recorded a prior stage as established with no evidence";
  }
  const second = closeInitiative({ disposition: "finished", already: true });
  if (second.ok) return "an initiative closed twice";
  const ungated = closeInitiative({ disposition: "finished", gatesRecorded: false });
  if (ungated.ok) return "an initiative closed with a declared gate left unrecorded";
});
