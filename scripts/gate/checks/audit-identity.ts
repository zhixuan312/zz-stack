import { importLegacyAudits, recordFinding, applyAssessment, transitionsFor, CHECK_STATES } from "@zz/contracts";
import { check } from "../run.ts";

const IDS = ["execution_id", "attempt_id", "reviewer_identity", "target", "report_ref", "completion"];

check("audit identity survives import and no assessment erases a finding", () => {
  for (const s of ["declared", "present", "invoked", "passed", "failed", "unrun", "unknown"]) {
    if (!CHECK_STATES.includes(s)) return `check state ${s} is not distinct`;
  }
  const rows = importLegacyAudits();
  if (rows.length !== 6) return `${rows.length} legacy audit rows imported, not 6`;
  if (rows.filter((r) => r.target === "spec.md").length !== 3) return "the legacy import does not count three spec audits";
  if (rows.filter((r) => r.target === "plan.md").length !== 3) return "the legacy import does not count three plan audits";
  for (const r of rows) {
    for (const k of IDS) if (!(k in r)) return `legacy row ${r.report_ref} carries no ${k}`;
    if (r.reviewer_identity !== "unavailable") return `legacy row ${r.report_ref} claims a reviewer identity none of the reports record`;
    if (r.snapshot_sha256 && r.hash_origin !== "computed_at_import") {
      return `legacy row ${r.report_ref} presents a newly computed hash as a historic signature`;
    }
  }
  const f = recordFinding({ id: "f1", disposition: "open" });
  const after = applyAssessment(f, { value: "false", question_id: "repeats_finding" });
  if (after.disposition === "resolved") return "an assessment closed an unresolved finding by itself";
  if (after.deleted) return "an assessment deleted a finding";
  if (applyAssessment(f, { value: "true" }).substitutesForTest) return "an assessment was substituted for a required test";

  // A transition is recorded or it is not a fact — chronology is not causality.
  const t = transitionsFor({ linked_sources: ["s1"], approvals: [{ at: "2026-09-20" }, { at: "2026-09-21" }] });
  if (t.observed.length) {
    return "a stage transition was derived from linked sources and approval chronology alone; "
         + "those show that a version changed and cited an input, not which stage the work returned from";
  }
  if (!t.inferred.length) return "the inferred rework relation was discarded rather than recorded as inferred";
  if (t.inferred.some((x) => x.kind === "observed")) return "an inferred relation is represented as an observed transition";
  const rec = transitionsFor({ events: [{ kind: "stage_transition", from: "plan", to: "spec", run: "r1" }] });
  if (rec.observed.length !== 1) return "a genuinely recorded transition was not reported as observed";
});
