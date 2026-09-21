import { interpret, QUESTION_FAMILIES } from "@zz/contracts";
import { check } from "../run.ts";

check("the assessment port never invents a probability or an answer", () => {
  for (const f of ["evidence_relation", "requirement_coverage", "needs_fact", "needs_verification",
                   "needs_analysis", "missing_user_input", "changes_commitment", "repeats_finding", "actionability"]) {
    if (!QUESTION_FAMILIES.includes(f)) return `the shared question family ${f} is not registered`;
  }
  const q = { question_id: "evidence_relation", answer_spec: { kind: "category",
              options: [{ key: "supports", meaning: "" }, { key: "contradicts", meaning: "" }] } } as const;

  const alien = interpret(q, { category: "invented_key" });
  if (alien.status !== "invalid_response") return "a category key the question never declared was accepted";
  if (alien.value !== null) return "an invalid response carried a non-null value";

  const labelOnly = interpret(q, { category: "supports" });
  if (labelOnly.signals.length !== 0) {
    return `a label-only answer produced ${labelOnly.signals.length} signal(s); absent probabilities must be an empty array, not zero or 0.5`;
  }
  const texty = interpret(q, { category: "supports", confidence: "0.91" });
  if (texty.signals.some((s) => s.origin === "native_distribution")) {
    return "a confidence number generated as text was recorded as a native distribution";
  }
  const timeout = interpret(q, undefined, { failure: "timeout" });
  if (timeout.status !== "unavailable") return `a timeout was recorded as ${timeout.status}`;
  if (timeout.value !== null) return "a timeout carried a value, making it look like semantic uncertainty";
});
