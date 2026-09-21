import { recallResultFrom } from "@zz/contracts";
import { check } from "../run.ts";

check("recall separates an inconclusive search from a scoped no-match", () => {
  const unknownProgress = recallResultFrom({ items: [], receipt: { status: "ok", completeness: "unknown", language_qualified: null } });
  if (unknownProgress.result !== "retrieval_inconclusive") {
    return `a search with unknown completeness returned ${unknownProgress.result}; it cannot claim a scoped no-match`;
  }
  const serviceError = recallResultFrom({ items: [], receipt: { status: "unavailable" } });
  if (serviceError.result === "no_relevant_match_in_searched_scope") {
    return "a service error was reported as a complete empty result";
  }
  const clean = recallResultFrom({ items: [], receipt: { status: "ok", completeness: "complete_for_declared_search", language_qualified: true } });
  if (clean.result !== "no_relevant_match_in_searched_scope") return "a complete clean empty was not reported as a scoped no-match";
  const lead = recallResultFrom({ items: [{ match_kind: "broadened_lead" }], receipt: { status: "ok", completeness: "complete_for_declared_search", language_qualified: true } });
  const f = lead.findings[0];
  if (f && f.claim_kind === "observed_result") return "a broadened lead was promoted to an observed result without an original read";
});
