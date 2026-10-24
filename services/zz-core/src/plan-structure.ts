/**
 * The structural report of an initiative's current plan, as `initiative_status` returns it.
 *
 * `validatePlan` already computes, from the text alone, whether a plan can be executed from and
 * which tasks may run in parallel. Before this, only the gate called it, so the orchestrator
 * running the plan derived its waves by hand. This reads the plan the flow declares, runs the
 * same validator over its TEXT, and returns ids rather than bodies so the answer stays small
 * enough to sit in every status call.
 *
 * COUPLED: the text is a parameter, not a path. A document's bytes are a `doc_revision` row now,
 * so the caller holds them and there is no file to open; taking the body also means this function
 * reads nothing and can be driven straight from a fixture.
 *
 * A plan grows one `## Phase N` at a time, so a plan with phases answers the waves of its current
 * phase — the first with tasks and no `### As built` — and never re-offers a built phase's tasks.
 */
import { createHash } from "node:crypto";

import { validatePlan, type FlowDoc } from "@zz/contracts";

export interface PlanStructure {
  document: string;
  ok: boolean;
  violations: Array<{ kind: string; task: string | null; line: number; message: string }>;
  /** The phase being built next, or null — no phases, or every written phase is built. */
  current_phase: number | null;
  /** The first phase declared with no tasks and no `### As built` — still to plan — or null. */
  unplanned_phase: number | null;
  /** Task ids grouped into waves that may run in parallel, in order: the current phase's when the
   *  plan has phases, the whole plan's when it has none. Empty when not ok or nothing is left. */
  waves: string[][];
  hotspots: string[];
}

/** How many plans' reports are kept. A team runs a handful of plans at a time and every console
 *  page re-asks for the same ones; the bound only stops a long-lived process from holding every
 *  plan it has ever read. Overflowing it costs one validation and nothing else. */
const REPORT_CACHE = 32;

/** Reports by a digest of the plan's own text, oldest first once the bound is reached.
 *
 *  DELIBERATE: memoized, because `validatePlan` is pure over its text and runs an O(tasks²)
 *  ownership sweep: a hundred-task plan took 1.7 s of one `initiative_status`, on every call, for
 *  an answer that cannot have changed while the text has not. The key is a digest and not the body,
 *  so the cache holds a few hundred bytes per plan rather than its bytes. Every caller reads the
 *  report and none writes to it, which is what makes one shared object safe. */
const reports = new Map<string, PlanStructure>();

/** A digest of the text: enough to tell two plans apart, and never read as one. Native, because the
 *  plans it keys are hundreds of kilobytes and a per-character loop over one cost more than the
 *  validation it was there to save. The length is in the key so two plans that differ only in a
 *  collision are still two keys. */
function digest(text: string): string {
  return `${text.length.toString(36)}:${createHash("sha1").update(text).digest("base64url")}`;
}

/** The report for the document the flow declares with `role: "plan"`, or undefined when the
 *  flow declares none or it has not been written yet.
 *
 *  `body` is that document's own current revision, or null when the initiative holds no such
 *  document — the two are the same answer as `undefined` here, which is what a missing file gave
 *  before. */
export function planStructure(docs: readonly FlowDoc[], body: string | null): PlanStructure | undefined {
  const plan = docs.find((d) => d.role === "plan");
  if (!plan || body === null) return undefined;
  const key = digest(body);
  const known = reports.get(key);
  if (known && known.document === plan.name) return known;
  const report = validatePlan(body);
  const structure: PlanStructure = {
    document: plan.name,
    ok: report.ok,
    violations: report.violations.map((v) => ({ kind: v.kind, task: v.taskId, line: v.line, message: v.detail })),
    current_phase: report.currentPhase,
    unplanned_phase: report.unplannedPhase,
    waves: (report.phases.length
      ? report.phases.find((p) => p.phase === report.currentPhase)?.waves ?? []
      : report.waves).map((w) => [...w]),
    hotspots: [...report.hotspots],
  };
  if (reports.size >= REPORT_CACHE) reports.delete(reports.keys().next().value!);
  reports.set(key, structure);
  return structure;
}

/** One sentence for `next_move.why` when an approved plan does not validate. Reported, never
 *  enforced: nothing new is refused, but whoever executes it is told before they start. */
export function planStructureNote(plan: PlanStructure | undefined, status: string | null): string {
  if (!plan || plan.ok || status !== "approved") return "";
  const kinds = [...new Set(plan.violations.map((v) => v.kind))].join(", ");
  return `NOTE: the approved ${plan.document} fails structural validation ` +
    `(${plan.violations.length} violation${plan.violations.length === 1 ? "" : "s"}: ${kinds}), ` +
    "so no parallel waves can be derived from it — see `plan.violations`; correct it with " +
    "document_edit before executing in parallel.";
}
