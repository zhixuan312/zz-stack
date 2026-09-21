import { setDefaultBinding, startRun, rebind, resolveFor } from "@zz/contracts";
import { check } from "../run.ts";

check("a default binding change reaches new runs only, and a rebind cannot inherit calibration", () => {
  setDefaultBinding({ semantic_assessment_profile_ref: "p-jev-1" });
  const existing = startRun("r1");
  setDefaultBinding({ semantic_assessment_profile_ref: "p-other-1" });
  if (resolveFor(existing).semantic_assessment_profile_ref !== "p-jev-1") {
    return "an in-flight run silently followed a changed global default";
  }
  if (resolveFor(startRun("r2")).semantic_assessment_profile_ref !== "p-other-1") {
    return "a new run did not pick up the new central default";
  }
  const rb = rebind(existing, { to: "p-other-1", authority: "a1" });
  if (!rb.suspendedFirst) return "a rebind did not suspend and reconcile before switching";
  if (!rb.revokedGrants.length) return "a rebind left grants that depended on the old binding valid";
  if (rb.inheritedCalibration) return "the new profile inherited the old profile's calibration by name";
  if (rb.reusedCachedAnswers) return "the rebind reused answers cached under the old binding";
  if (!rb.historyPreserved) return "the rebind rewrote the run's history";
});
