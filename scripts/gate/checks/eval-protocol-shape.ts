import { protocol, armsOf, costOf } from "@zz/contracts";
import { check } from "../run.ts";

check("the evaluation protocol cannot activate on absent numbers or zero-cost unknowns", () => {
  const p = protocol();
  const arms = armsOf(p).map((a) => a.id).sort();
  if (arms.join(",") !== "A,B,C") return `arms are ${arms.join(",")}; A legacy, B general-model, C candidate are all required`;
  if (armsOf(p).find((a) => a.id === "A")?.isStrawman) return "arm A is a weakened strawman rather than the actual legacy method";

  const overlap = p.dev_initiative_ids.filter((i) => p.heldout_initiative_ids.includes(i));
  if (overlap.length) return `initiatives appear in both dev and held-out sets: ${overlap.join(", ")}`;

  for (const l of p.limits) {
    if (l.value === null && p.activationAllowed) return `target ${l.metric} has a null tolerance and activation is still allowed`;
  }
  if (!p.sample_adequacy_rule_ref && p.activationAllowed) return "no sample-adequacy rule exists and activation is still allowed";
  if (!p.draftingAllowed) return "drafting the procedure was blocked; only activation should be";

  const c = costOf({ usage: undefined });
  if (c.total === 0) return "unknown usage was encoded as zero cost";
  if (c.completeness !== "unknown") return "unknown usage was not reported as unknown";
});
