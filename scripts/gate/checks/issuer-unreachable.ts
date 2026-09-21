import { registeredTools, callTool, issueForTest } from "@zz/contracts";
import { check } from "../run.ts";

check("the grant issuer is unreachable by any caller and still works for the host", () => {
  for (const role of ["member", "admin", "superadmin"]) {
    const names = registeredTools(role).map((t) => t.name);
    if (names.includes("issue_control_grant")) return `issue_control_grant is registered for ${role}`;
    const direct = callTool(role, "issue_control_grant", { decision_id: "d1" });
    if (direct.ok) return `a direct ${role} call to issue_control_grant succeeded`;
  }
  const forged = callTool("admin", "action_claim", { grant_id: "fabricated", expected_revision: 1 });
  if (forged.ok) return "a fabricated grant id was accepted by action_claim";

  const real = issueForTest({ trustedHost: true, decisionId: "d1" });
  if (!real.ok) return `valid host issuance failed (${real.reason}) — the negative tests alone prove only that a name is hidden`;
  if (!real.grant.effect_digest || !real.grant.dependency_snapshot_ref) return "a valid grant carries no effect digest or dependency snapshot";

  const evidence = callTool("member", "evidence_record", { work: "w1", ref: "r1" });
  if (!evidence.ok) return "recording evidence was blocked while progression was held; contrary evidence must stay possible";
});
