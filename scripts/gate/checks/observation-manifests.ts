import { captureManifest, CHECK_STATES } from "@zz/contracts";
import { check } from "../run.ts";

check("observation manifests include ignored outputs and keep check states distinct", () => {
  const m = captureManifest({ roots: ["."], includeIgnored: true });
  if (!m.includesIgnored) return "the manifest consulted git's ignore rules, so generated outputs are invisible in the record";
  if (!m.baseline || !m.final) return "the capture produced only one manifest; a change set needs a baseline and a final";
  if (m.completeness === undefined) return "the manifest reports no completeness, so an incomplete capture reads as a complete one";

  for (const s of ["declared", "present", "invoked", "passed", "failed", "unrun", "unknown"]) {
    if (!CHECK_STATES.includes(s)) return `check state ${s} is not representable, so it collapses into another`;
  }
  const undet = captureManifest({ roots: ["."], checkResult: undefined }).checks[0];
  if (undet && undet.state !== "unknown") return `an undeterminable check was recorded as ${undet.state}, not unknown`;
  const unreadable = captureManifest({ roots: ["/does/not/exist"] });
  if (unreadable.completeness !== "incomplete") return "an unreadable root did not make the capture incomplete";
  if (!unreadable.reasons?.length) return "an unreadable root was recorded without a reason";
});
