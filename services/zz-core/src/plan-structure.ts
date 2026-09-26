/**
 * The structural report of an initiative's current plan, as `initiative_status` returns it.
 *
 * `validatePlan` already computes, from the text alone, whether a plan can be executed from and
 * which tasks may run in parallel. Before this, only the gate called it, so the orchestrator
 * running the plan derived its waves by hand. This reads the plan the flow declares, runs the
 * same validator over the bytes on disk, and returns ids rather than bodies so the answer stays
 * small enough to sit in every status call.
 *
 * A plan grows one `## Phase N` at a time, so a plan with phases answers the waves of its current
 * phase — the first with tasks and no `### As built` — and never re-offers a built phase's tasks.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { validatePlan, type FlowDoc } from "@zz/contracts";

export interface PlanStructure {
  document: string;
  ok: boolean;
  violations: Array<{ kind: string; task: string | null; line: number; message: string }>;
  /** The phase being built next, or null — no phases, or every written phase is built. */
  current_phase: number | null;
  /** Task ids grouped into waves that may run in parallel, in order: the current phase's when the
   *  plan has phases, the whole plan's when it has none. Empty when not ok or nothing is left. */
  waves: string[][];
  hotspots: string[];
}

/** The report for the document the flow declares with `role: "plan"`, or undefined when the
 *  flow declares none or it has not been written yet. */
export function planStructure(dir: string, docs: readonly FlowDoc[]): PlanStructure | undefined {
  const plan = docs.find((d) => d.role === "plan");
  if (!plan) return undefined;
  const file = join(dir, plan.name);
  if (!existsSync(file) || !statSync(file).isFile()) return undefined;
  const report = validatePlan(readFileSync(file, "utf8"));
  return {
    document: plan.name,
    ok: report.ok,
    violations: report.violations.map((v) => ({ kind: v.kind, task: v.taskId, line: v.line, message: v.detail })),
    current_phase: report.currentPhase,
    waves: (report.phases.length
      ? report.phases.find((p) => p.phase === report.currentPhase)?.waves ?? []
      : report.waves).map((w) => [...w]),
    hotspots: [...report.hotspots],
  };
}

/** One sentence for `next_move.why` when an approved plan does not validate. Reported, never
 *  enforced: nothing new is refused, but whoever executes it is told before they start. */
export function planStructureNote(plan: PlanStructure | undefined, status: string | null): string {
  if (!plan || plan.ok || status !== "approved") return "";
  const kinds = [...new Set(plan.violations.map((v) => v.kind))].join(", ");
  return ` NOTE: the approved ${plan.document} fails structural validation ` +
    `(${plan.violations.length} violation${plan.violations.length === 1 ? "" : "s"}: ${kinds}), ` +
    "so no parallel waves can be derived from it — see `plan.violations`; revise it with " +
    "document_revise before executing in parallel.";
}
