/**
 * The deterministic structural report a plan must carry before a controlled Execute admits it.
 *
 * A plan document is a graph wearing markdown: `### Task I-N:` headings are its nodes, the
 * `**Dependencies:**` line under each is its edges, and the `**Output:**` line is what that node
 * promises to leave behind. Two tasks called `I-7` means an executor cannot say which one it
 * ran; a dependency ring means there is no order in which the work can start.
 *
 * It settles shape and nothing else. There is no `quality` field, no `confidence` and no score:
 * a passing report says the document parses as a plan, and nothing about the plan. Judging that
 * is an independent semantic audit.
 *
 * Every report carries the digest of the bytes it read and the target it was computed against,
 * so admission can refuse a report that describes a version nobody is executing.
 *
 * `admitToExecute` requires both a report and an approval and accepts neither alone: an approval
 * is a verdict on content, a report a verdict on shape, and a missing report is not a silent
 * pass.
 *
 * `### Task I-N:`, `Output` and `Dependencies` are this flow's conventions, not the document
 * kernel's — the kernel stores and gates documents of any shape.
 */
import { createHash } from "node:crypto";

// Deliberately narrow. Every pattern below matches something a writer can see in their own
// text: a structural refusal a human cannot reproduce by looking at the line gets routed around
// rather than fixed.

/** A line trying to be a task heading: `### Task` followed by something numeric. Matching on
 *  intent rather than the strict form reports a typo as a malformed heading instead of letting
 *  it vanish — `### Task I-1 X`, missing its colon, would otherwise not be a task at all.
 *
 *  The number is what keeps it off prose: `### Task` alone would take `### Task breakdown` and
 *  report a valid plan as malformed. */
const TASK_HEADING_INTENT = /^###\s+Task\s+I?-?\d/;

/** The full form: `### Task I-17: Deterministic plan-shape validator (← AC-8.2)`. An id, a
 *  non-empty title, and the AC reference the title ends with. */
const TASK_HEADING = /^###\s+Task\s+(I-\d+)\s*:\s*(\S.*?)\s*$/;

/**
 * The AC reference, required: `(← AC-8.2)`, or a comma list, `(← AC-7.5, AC-7.1)`.
 *
 * Whether a task traces to the right criterion is not asked here; whether the link was written
 * down at all is a fact about the heading.
 *
 * No order and no count is assumed — a rule about the order of a reference list would be a rule
 * about tidiness. The ASCII arrow `<-` is accepted alongside `←`. */
const AC_REFERENCE = /\((?:←|<-)\s*(AC-\d+\.\d+(?:\s*,\s*AC-\d+\.\d+)*)\s*\)$/;

/** Where a task's block ends: the next heading at `#`, `##` or `###`. A `####` sub-heading stays
 *  inside the task, because plans really do sub-divide a task and its `**Output:**` line may sit
 *  under one of those sub-headings. */
const BLOCK_BOUNDARY = /^#{1,3}\s/;

/** What may sit in front of either line: indentation, a list marker, a quote marker. Refusing
 *  `- **Output:** a` would be a false refusal of a valid plan, which this file must never
 *  produce. Reading a line the writer did not intend as the Output is the cheaper error: it lets
 *  a malformed task pass, which the reader auditing the plan still catches. */
const LINE_PREFIX = "^[\\s>]*(?:[-*+]\\s+)?";

/** `**Output:** a` — and the near-misses a writer produces: `**Outputs:**`, `**Output**:`. All of
 *  them are unambiguously the output line, so all of them are read as one. */
const OUTPUT_LINE = new RegExp(`${LINE_PREFIX}\\*\\*Outputs?\\s*:?\\s*\\*\\*\\s*:?\\s*(.*)$`, "i");

/** `**Dependencies:** none` · `**Dependencies:** Task I-1` · `**Dependencies:** Tasks I-6, I-10,
 *  I-11, I-38` — the three forms the real plan uses. The tail is read as free text and the ids
 *  are picked out of it below. */
const DEPENDENCIES_LINE =
  new RegExp(`${LINE_PREFIX}\\*\\*Dependenc(?:y|ies)\\s*:?\\s*\\*\\*\\s*:?\\s*(.*)$`, "i");

/** A task id anywhere in a dependency tail. Written as a scan rather than a strict grammar for
 *  the tail, because a grammar tight enough to reject noise rejects a real line with it the
 *  first time somebody writes a parenthetical after an id. */
const TASK_ID_TOKEN = /\bI-\d+\b/g;

/** How a dependency tail says there are none. Normalised first, so `None.` and `none` agree. */
const NO_DEPENDENCIES = new Set(["none", "n/a", "na", "nothing"]);

// What a report says

/**
 * The structural failures, named. A closed vocabulary so a caller can branch on one, and so no
 * kind can mean "this plan looks weak". Every kind below is a fact about the document's text.
 */
export type PlanViolationKind =
  /** The document declares no tasks at all. Not a plan anything can execute. */
  | "no_tasks"
  /** A code fence was opened and never closed, so the rest of the document read as an example
   *  and any task below it was never declared. */
  | "unterminated_code_fence"
  /** A line announces a task but does not carry `I-N:` and a title. */
  | "malformed_task_heading"
  /** A task heading ends with no readable `(← AC-x.y)`: nothing ties the task to what the plan
   *  was approved for. Whether it is the right criterion is not asked. */
  | "missing_ac_reference"
  /** Two headings declare the same task id; an executor cannot say which one it ran. */
  | "duplicate_task_id"
  /** No `**Output:**` line in the task's block: the task promises nothing checkable. */
  | "missing_output"
  /** An `**Output:**` line with nothing after it. */
  | "empty_output"
  /** No `**Dependencies:**` line: the task's place in the order is undeclared, not `none`. */
  | "missing_dependencies"
  /** A `**Dependencies:**` line that is neither `none` nor any readable task id. */
  | "unreadable_dependencies"
  /** A task that depends on itself. */
  | "self_dependency"
  /** A dependency naming a task id that no heading in this document declares. */
  | "unknown_dependency"
  /** A ring of dependencies: no task in it can start first. */
  | "dependency_cycle";

/** One violation, attributed. `taskId` is null only where the violation belongs to the document
 *  rather than to a task (`no_tasks`, a heading too malformed to yield an id). `line` is 1-based
 *  so it can be read straight off an editor's gutter. */
export interface PlanViolation {
  readonly kind: PlanViolationKind;
  readonly taskId: string | null;
  readonly line: number;
  readonly detail: string;
}

/**
 * The report. Bound to a target, derived only from the text, and carrying no verdict but `ok`.
 *
 * `order` is an executable ordering over the edges the document declares — every task's declared
 * dependencies come before it. It is not the right order: the edges are the ones the author
 * wrote. Empty when a cycle makes any such ordering impossible.
 */
export interface PlanStructuralReport {
  readonly ok: boolean;
  /** The version or digest the report is bound to; defaults to `sha256:<digest>`. */
  readonly target: string;
  /** SHA-256 of the exact bytes read, so staleness is detectable without the original text. */
  readonly digest: string;
  /** Every task id declared, in document order, first occurrence only. */
  readonly taskIds: readonly string[];
  readonly violations: readonly PlanViolation[];
  readonly order: readonly string[];
}

// Reading the document

interface ParsedTask {
  readonly id: string;
  readonly line: number;
  /** Dependency ids as written, in document order, self-references and unknowns included —
   *  those are reported as violations, not quietly dropped before anyone sees them. */
  readonly declared: readonly string[];
}

function normaliseTail(tail: string): string {
  return tail.trim().toLowerCase().replace(/[.;,]+$/, "");
}

/**
 * A fenced block is an example, not a task, so a plan documenting its own format is not refused
 * by the rule that reads it: a specimen `### Task I-1:` inside a fence would otherwise come back
 * as `duplicate_task_id` against a document with no such defect.
 *
 * Blanked, not dropped, so every line number in the report is still the line somebody opens.
 */
function blankFencedRuns(lines: readonly string[]): { text: string[]; openedAt: number | null } {
  const text: string[] = [];
  let fence: string | null = null;
  let openedAt: number | null = null;
  for (const [i, line] of lines.entries()) {
    const marker = /^\s*(```+|~~~+)/.exec(line);
    if (fence === null) {
      if (marker) { fence = marker[1][0]; openedAt = i + 1; text.push(""); }
      else text.push(line);
      continue;
    }
    text.push("");
    if (marker && marker[1][0] === fence) { fence = null; openedAt = null; }
  }
  return { text, openedAt };
}

/**
 * Split the document into tasks, reporting every defect visible from the text alone.
 *
 * A duplicate heading is reported and then skipped: its block is not checked for an Output or a
 * Dependencies line and its edges do not enter the graph. The first occurrence owns the id.
 */
function parseTasks(lines: readonly string[]): {
  tasks: ParsedTask[];
  violations: PlanViolation[];
} {
  const tasks: ParsedTask[] = [];
  const violations: PlanViolation[] = [];
  const claimedAt = new Map<string, number>();

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (!TASK_HEADING_INTENT.test(raw)) continue;
    const line = i + 1;

    const heading = TASK_HEADING.exec(raw);
    if (!heading) {
      const salvaged = /\bI-\d+\b/.exec(raw);
      violations.push({
        kind: "malformed_task_heading",
        taskId: salvaged ? salvaged[0] : null,
        line,
        detail: `a heading announces a task but does not read as "### Task I-N: title": ${raw.trim()}`,
      });
      continue;
    }

    const id = heading[1];
    const firstAt = claimedAt.get(id);
    if (firstAt !== undefined) {
      violations.push({
        kind: "duplicate_task_id",
        taskId: id,
        line,
        detail: `task ${id} is already declared at line ${firstAt}; a task id names one task`,
      });
      continue;
    }
    claimedAt.set(id, line);

    if (!AC_REFERENCE.test(heading[2])) {
      violations.push({
        kind: "missing_ac_reference",
        taskId: id,
        line,
        detail: `task ${id} ends with no readable "(← AC-x.y)", so nothing ties it to a criterion ` +
          `the plan was approved for: ${raw.trim()}`,
      });
    }

    // The block: every line up to the next `#`/`##`/`###` heading, or the end of the document.
    let end = i + 1;
    while (end < lines.length && !BLOCK_BOUNDARY.test(lines[end])) end += 1;
    const block = lines.slice(i + 1, end);

    violations.push(...readOutput(id, line, block));
    const dependencies = readDependencies(id, line, block);
    violations.push(...dependencies.violations);
    tasks.push({ id, line, declared: dependencies.declared });
  }

  if (tasks.length === 0 && violations.length === 0) {
    violations.push({
      kind: "no_tasks",
      taskId: null,
      line: 1,
      detail: 'no "### Task I-N:" heading anywhere in the document',
    });
  }

  return { tasks, violations };
}

function readOutput(id: string, headingLine: number, block: readonly string[]): PlanViolation[] {
  for (let i = 0; i < block.length; i += 1) {
    const match = OUTPUT_LINE.exec(block[i]);
    if (!match) continue;
    if (match[1].trim() === "") {
      return [{
        kind: "empty_output",
        taskId: id,
        line: headingLine + 1 + i,
        detail: `task ${id} has an "**Output:**" line with nothing after it`,
      }];
    }
    return [];
  }
  return [{
    kind: "missing_output",
    taskId: id,
    line: headingLine,
    detail: `task ${id} declares no "**Output:**"`,
  }];
}

function readDependencies(
  id: string,
  headingLine: number,
  block: readonly string[],
): { declared: string[]; violations: PlanViolation[] } {
  for (let i = 0; i < block.length; i += 1) {
    const match = DEPENDENCIES_LINE.exec(block[i]);
    if (!match) continue;
    const line = headingLine + 1 + i;
    const tail = match[1];
    const ids = tail.match(TASK_ID_TOKEN) ?? [];
    if (ids.length > 0) return { declared: ids, violations: [] };
    if (NO_DEPENDENCIES.has(normaliseTail(tail))) return { declared: [], violations: [] };
    return {
      declared: [],
      violations: [{
        kind: "unreadable_dependencies",
        taskId: id,
        line,
        // Not read as "none": a line nobody can parse is an undeclared position in the order,
        // and defaulting it to "no dependencies" would invent an edge-free task out of a typo.
        detail: `task ${id} has a "**Dependencies:**" line reading "${tail.trim()}", which names ` +
          "neither `none` nor any task id",
      }],
    };
  }
  return {
    declared: [],
    violations: [{
      kind: "missing_dependencies",
      taskId: id,
      line: headingLine,
      detail: `task ${id} declares no "**Dependencies:**"; an undeclared position in the order ` +
        "is not the same as `none`",
    }],
  };
}

// The graph

/**
 * Edges, with the unusable ones reported rather than followed. A self-edge is a
 * `self_dependency` and is kept out of the cycle graph, so it is named once and not again as a
 * one-node ring; an edge to an id no heading declares is an `unknown_dependency` and is dropped.
 */
function buildEdges(tasks: readonly ParsedTask[]): {
  edges: Map<string, string[]>;
  violations: PlanViolation[];
} {
  const known = new Set(tasks.map((t) => t.id));
  const edges = new Map<string, string[]>();
  const violations: PlanViolation[] = [];

  for (const task of tasks) {
    const usable: string[] = [];
    for (const dependency of task.declared) {
      if (dependency === task.id) {
        violations.push({
          kind: "self_dependency",
          taskId: task.id,
          line: task.line,
          detail: `task ${task.id} depends on itself, so it can never start`,
        });
        continue;
      }
      if (!known.has(dependency)) {
        violations.push({
          kind: "unknown_dependency",
          taskId: task.id,
          line: task.line,
          detail: `task ${task.id} depends on ${dependency}, which no heading in this document declares`,
        });
        continue;
      }
      if (!usable.includes(dependency)) usable.push(dependency);
    }
    edges.set(task.id, usable);
  }

  return { edges, violations };
}

/**
 * Every dependency ring in the graph, each reported once. One depth-first pass traverses each
 * edge exactly once, so every back edge is seen. A ring is rotated to start at its earliest
 * member in document order, which makes `I-2 -> I-3 -> I-2` and `I-3 -> I-2 -> I-3` one finding.
 */
function findCycles(
  order: readonly string[],
  edges: ReadonlyMap<string, readonly string[]>,
): string[][] {
  const position = new Map(order.map((id, index) => [id, index] as const));
  const explored = new Set<string>();
  const onPath = new Set<string>();
  const path: string[] = [];
  const recorded = new Set<string>();
  const rings: string[][] = [];

  const visit = (id: string): void => {
    if (onPath.has(id)) {
      const ring = path.slice(path.indexOf(id));
      let start = 0;
      for (let i = 1; i < ring.length; i += 1) {
        if ((position.get(ring[i]) ?? 0) < (position.get(ring[start]) ?? 0)) start = i;
      }
      const rotated = [...ring.slice(start), ...ring.slice(0, start)];
      const key = rotated.join(">");
      if (!recorded.has(key)) {
        recorded.add(key);
        rings.push(rotated);
      }
      return;
    }
    if (explored.has(id)) return;
    onPath.add(id);
    path.push(id);
    for (const next of edges.get(id) ?? []) visit(next);
    path.pop();
    onPath.delete(id);
    explored.add(id);
  };

  for (const id of order) visit(id);
  return rings;
}

/**
 * An executable ordering, or nothing. Kahn's algorithm, taking the earliest ready task in
 * document order at every step, so a plan already written in a runnable order gets that order
 * back. Returns null when a ring leaves tasks that never become ready.
 */
function executableOrder(
  ids: readonly string[],
  edges: ReadonlyMap<string, readonly string[]>,
): string[] | null {
  const remaining = [...ids];
  const done = new Set<string>();
  const ordered: string[] = [];

  while (remaining.length > 0) {
    const index = remaining.findIndex((id) =>
      (edges.get(id) ?? []).every((dependency) => done.has(dependency)));
    if (index === -1) return null;
    const [ready] = remaining.splice(index, 1);
    done.add(ready);
    ordered.push(ready);
  }

  return ordered;
}

// The two entry points

/** Violations sort by document line, then by the order they were found, so two runs over the
 *  same bytes produce the same report and a diff of two reports is a diff of two documents. */
function byLine(violations: readonly PlanViolation[]): PlanViolation[] {
  return violations
    .map((violation, index) => ({ violation, index }))
    .sort((a, b) => a.violation.line - b.violation.line || a.index - b.index)
    .map((entry) => entry.violation);
}

/**
 * Read a plan and report its shape, bound to `target`.
 *
 * Deterministic and side-effect free: the same bytes and the same target give the same report,
 * with no model in the path.
 *
 * `target` is the version or digest the plan is validated against. Omitted, the report binds to
 * the digest of the text it just read, which says only that the report describes these bytes;
 * passing the version a caller believes it is executing is what lets `admitToExecute` catch a
 * stale report.
 */
export function validatePlan(text: string, target?: string): PlanStructuralReport {
  const digest = createHash("sha256").update(text, "utf8").digest("hex");
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  const source = blankFencedRuns(lines);
  const parsed = parseTasks(source.text);
  const graph = buildEdges(parsed.tasks);
  const violations = [...parsed.violations, ...graph.violations];

  // A fence nobody closed swallows the rest of the document, so every task after it stops
  // existing. Reported as the one unclosed line rather than as ten tasks that were never
  // declared.
  if (source.openedAt !== null) {
    violations.push({
      kind: "unterminated_code_fence",
      taskId: null,
      line: source.openedAt,
      detail: "a code fence opened here and was never closed, so everything below it was read " +
        "as an example and no task in it was declared",
    });
  }

  const ids = parsed.tasks.map((task) => task.id);
  for (const ring of findCycles(ids, graph.edges)) {
    const owner = parsed.tasks.find((task) => task.id === ring[0]);
    violations.push({
      kind: "dependency_cycle",
      taskId: ring[0],
      line: owner ? owner.line : 1,
      detail: `dependency cycle: ${[...ring, ring[0]].join(" -> ")}; no task in it can start first`,
    });
  }

  const order = executableOrder(ids, graph.edges);
  return {
    ok: violations.length === 0,
    target: target ?? `sha256:${digest}`,
    digest,
    taskIds: ids,
    violations: byLine(violations),
    order: order ?? [],
  };
}

/** Why a plan was kept out of controlled execution. Closed, so a caller can branch on one. */
export type ExecuteRefusal =
  | "no_structural_report"
  | "structural_report_failed"
  | "structural_report_stale"
  | "no_human_approval";

/** What admission is asked for. Both halves are optional in the type and neither is optional in
 *  effect: an absent structural report and an absent approval are each a refusal, stated. */
export interface ExecuteAdmissionRequest {
  /** A person read the plan and agreed with what it proposes. A verdict on content. */
  readonly humanApproved?: boolean | undefined;
  /** The report `validatePlan` produced. A verdict on shape. */
  readonly structuralReport?: PlanStructuralReport | undefined;
  /** The version being executed. Given, a report bound to anything else is stale. */
  readonly currentTarget?: string | undefined;
}

export interface ExecuteAdmission {
  readonly admitted: boolean;
  readonly refusals: readonly ExecuteRefusal[];
  /** One line describing what was and was not established. Descriptive of shape and of what is
   *  on the record; never an opinion about the plan. */
  readonly reason: string;
}

/**
 * Admit a plan to controlled execution, or say exactly why not.
 *
 * Both verdicts are required and neither substitutes for the other: an approval says a person
 * read the plan and wants it built, a passing report says the document parses as a plan. A
 * duplicate task id is invisible to the first and fatal to the second.
 *
 * Nothing here blocks writing. A malformed draft can be written, revised, read and approved;
 * this gate stands at controlled Execute and nowhere earlier.
 */
export function admitToExecute(request: ExecuteAdmissionRequest): ExecuteAdmission {
  const refusals: ExecuteRefusal[] = [];
  const report = request.structuralReport;

  if (!report) {
    refusals.push("no_structural_report");
  } else {
    if (!report.ok) refusals.push("structural_report_failed");
    if (request.currentTarget !== undefined && request.currentTarget !== report.target) {
      refusals.push("structural_report_stale");
    }
  }
  if (request.humanApproved !== true) refusals.push("no_human_approval");

  if (refusals.length === 0) {
    return {
      admitted: true,
      refusals: [],
      reason: `admitted: a structural report with no violations, bound to ${report?.target}, ` +
        "and a recorded human approval",
    };
  }

  return { admitted: false, refusals, reason: `refused (${refusals.join(", ")}): ${explain(refusals, report)}` };
}

function explain(
  refusals: readonly ExecuteRefusal[],
  report: PlanStructuralReport | undefined,
): string {
  const said: string[] = [];
  if (refusals.includes("no_structural_report")) {
    said.push("no structural report was supplied, and an unchecked plan is not a checked one");
  }
  if (refusals.includes("structural_report_failed") && report) {
    const named = report.violations
      .map((violation) => `${violation.taskId ?? "document"}: ${violation.kind}`)
      .join("; ");
    said.push(`the structural report lists ${report.violations.length} violation(s) — ${named}`);
  }
  if (refusals.includes("structural_report_stale") && report) {
    said.push(`the structural report is bound to ${report.target}, which is not the version being executed`);
  }
  if (refusals.includes("no_human_approval")) {
    said.push("no human approval is on the record");
  }
  return said.join(". ");
}
