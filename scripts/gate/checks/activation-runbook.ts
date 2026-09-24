import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { root } from "../read.ts";
import { check } from "../run.ts";

const NEEDED = ["operator", "runbook", "app_version", "store_version", "database_version",
                "restore_evidence", "parity_evidence", "switch_authorization"];

/**
 * The two states a precondition may be in, and why this check reads `state` rather than truthiness
 * or a literal.
 *
 * `preconditions.operator` is an object — `{state, name, assigned_by, requires, evidence, reading,
 * would_unblock}` — so a clause comparing it against a string can never fire. The runbook also
 * refuses the word "unassigned", which reads as a settled administrative status when what is true
 * is that the decision has not been made.
 *
 * `if (!rb.preconditions?.[k])` is satisfied by `{}` for all eight, so a runbook that named every
 * precondition and said nothing about any of them passes. The clauses below ask what the check's
 * own title asks: is this complete, is it abortable, and can it authorize itself. A blocked
 * precondition has to say what would unblock it; a met one has to cite evidence; and an operator
 * named by nobody, or a grant with no time on it, is the self-authorizing shape by another route.
 *
 * All eight are blocked today and every one carries `requires` and `would_unblock`. What this
 * refuses is a precondition quietly marked met to let a switch proceed.
 */
const STATE = new Set(["blocked", "met"]);

check("the activation runbook is complete, abortable and not self-authorizing", () => {
  const p = join(root, "deploy/activation-runbook.json");
  if (!existsSync(p)) return "deploy/activation-runbook.json is missing — activation has no written procedure";
  const rb = JSON.parse(readFileSync(p, "utf8"));
  for (const k of NEEDED) {
    const pc = rb.preconditions?.[k];
    if (!pc || typeof pc !== "object") return `the runbook carries no ${k} precondition`;
    if (!STATE.has(pc.state)) {
      return `precondition ${k} carries state ${JSON.stringify(pc.state)}, which is neither ` +
             `"blocked" nor "met" — a state nothing derives from is a precondition nobody can read`;
    }
    if (pc.state === "blocked" && !(pc.requires && pc.would_unblock)) {
      return `precondition ${k} is blocked and does not say what would unblock it`;
    }
    if (pc.state === "met" && !pc.evidence) {
      return `precondition ${k} reads as met and cites no evidence — the one shape that lets an ` +
             `activation mark its own gate`;
    }
  }
  if (rb.preconditions.operator.name && !rb.preconditions.operator.assigned_by) {
    return "the runbook names an operator nobody assigned — accountability cannot be self-conferred";
  }
  if (rb.preconditions.switch_authorization.granted_by && !rb.preconditions.switch_authorization.granted_at) {
    return "the switch authorization names a grantor and no time, so nothing can tell a fresh " +
           "grant from one made before the thing it authorized had changed";
  }
  for (const [i, s] of (rb.steps ?? []).entries()) {
    if (!s.verification) return `step ${i + 1} has no verification`;
    if (!s.abort) return `step ${i + 1} has no abort point`;
  }
  if (rb.waivePreconditions) return "the runbook permits waiving a precondition to proceed";
  if (rb.executed) return "the runbook records itself as executed; this plan writes and rehearses it, it does not run it";
  if (rb.suspension?.guaranteesWorkerStopped) return "suspension claims to guarantee a worker stopped, which it cannot";
  if (rb.rollback?.weakensCurrentSecurity) return "rollback would weaken current identity or storage safeguards";
});
