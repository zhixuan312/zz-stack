import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { root } from "../read.ts";
import { check } from "../run.ts";

const NEEDED = ["operator", "runbook", "app_version", "store_version", "database_version",
                "restore_evidence", "parity_evidence", "switch_authorization"];

check("the activation runbook is complete, abortable and not self-authorizing", () => {
  const p = join(root, "deploy/activation-runbook.json");
  if (!existsSync(p)) return "deploy/activation-runbook.json is missing — activation has no written procedure";
  const rb = JSON.parse(readFileSync(p, "utf8"));
  for (const k of NEEDED) {
    if (!rb.preconditions?.[k]) return `the runbook names no ${k}`;
  }
  if (rb.preconditions.operator === "unassigned") return "the runbook names no accountable operator, so nobody can be asked about the switch";
  for (const [i, s] of (rb.steps ?? []).entries()) {
    if (!s.verification) return `step ${i + 1} has no verification`;
    if (!s.abort) return `step ${i + 1} has no abort point`;
  }
  if (rb.waivePreconditions) return "the runbook permits waiving a precondition to proceed";
  if (rb.executed) return "the runbook records itself as executed; this plan writes and rehearses it, it does not run it";
  if (rb.suspension?.guaranteesWorkerStopped) return "suspension claims to guarantee a worker stopped, which it cannot";
  if (rb.rollback?.weakensCurrentSecurity) return "rollback would weaken current identity or storage safeguards";
});
