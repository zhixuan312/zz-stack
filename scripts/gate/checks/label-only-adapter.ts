import { labelAdapter, evaluateBranch, resolveEndpoint } from "@zz/contracts";
import { check } from "../run.ts";

check("a label-only adapter cannot manufacture a probability or drift to the cloud", () => {
  if (labelAdapter.capabilities.native_distributions) return "a label-only adapter declares native distributions";
  const a = labelAdapter.parse({ model: "qwen:7b", label: "supports", confidence: "0.93" });
  if (a.signals.some((s) => s.origin === "native_distribution")) return "an emitted float was recorded as a native distribution";
  if (a.signals.some((s) => s.origin === "empirical_calibration")) return "an unqualified number was recorded as calibrated";

  const branch = evaluateBranch({ requires: "native_probability", assessment: a });
  if (branch.decided) return "a probability-requiring branch consumed a self-reported number";
  if (!["unsupported", "independent_review"].includes(branch.outcome)) {
    return `a probability-requiring branch resolved to ${branch.outcome} instead of unsupported or independent review`;
  }
  const ep = resolveEndpoint({ profile: "local-only", primaryUnavailable: true });
  if (ep.kind === "cloud") return "a local-only profile fell back to a cloud endpoint";
  if (!ep.declared) return "the endpoint's locality was inferred rather than declared in the profile";

  const drifted = labelAdapter.parse({ model: "qwen:7b", label: "supports" }, { boundDigest: "sha256:aaa", observedDigest: "sha256:bbb" });
  if (drifted.status === "answered") return "the serving deployment changed mid-profile and the answer was still accepted";

  // And a reply that names no model at all under a pinned profile: unverifiable is not verified,
  // which `label-adapter.ts` states as "bound present, none observed → the same refusal". The
  // guard in assessment.ts required an observed value, so this fell through it and was answered.
  const silent = labelAdapter.parse({ label: "supports" }, { boundDigest: "sha256:aaa" });
  if (silent.status === "answered") {
    return "a reply naming no model was accepted under a profile that pinned the deployment";
  }
  if (silent.identity_assurance === "deployment_verified") {
    return "a reply nothing observed was recorded as deployment_verified";
  }
});
