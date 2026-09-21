/**
 * PLAN SHAPE, AND NOTHING ELSE — the deterministic structural report a plan must carry before
 * a controlled Execute will admit it.
 *
 * WHAT THIS SETTLES. A plan document is a graph wearing markdown: `### Task I-N:` headings are
 * its nodes, the `**Dependencies:**` line under each is its edges, and the `**Output:**` line is
 * what that node promises to leave behind. Those are facts about the text, checkable by reading
 * it, and every reader has to agree on them or the plan cannot be executed at all — two tasks
 * called `I-7` means an executor cannot say which one it just ran, and a dependency ring means
 * there is no order in which the work can start.
 *
 * WHAT THIS DOES NOT SETTLE, and the reason the file says so twice. It cannot tell you whether a
 * plan is good, complete, feasible, well-sequenced, or worth executing. There is no `quality`
 * field here, no `confidence`, no score, and no room for one: a plan can pass every check below
 * and still be the wrong plan, built on a test that proves nothing, aimed at a solution that
 * cannot work. Judging THAT is an independent semantic audit by a reader who understands the
 * domain, and it stays independent precisely because this file cannot be mistaken for it. A
 * passing report says the document parses as a plan. It says nothing about the plan.
 *
 * WHY IT IS BOUND TO A TARGET. A structural report is a statement about one version of one
 * document. Left unbound it becomes a statement about "the plan", which is a moving object — the
 * report keeps passing while the text it described is edited out from under it, and the thing
 * admitted to execution is not the thing that was checked. So every report carries the digest of
 * the bytes it read and the target it was computed against, and admission can refuse a report
 * that describes a version nobody is executing.
 *
 * WHY APPROVAL IS NOT A SUBSTITUTE, which is the whole reason this task exists. A human approval
 * is a verdict on CONTENT: somebody read the plan and agreed with what it proposes. A structural
 * report is a verdict on SHAPE. Neither implies the other, and the failure mode being closed
 * here is the plausible one — a person approves a plan they believe in, and the duplicate task id
 * they never noticed rides in on their signature. `admitToExecute` therefore requires both and
 * accepts neither alone, and a missing report is not a silent pass.
 *
 * THESE ARE SDLC SEMANTICS AND THEY STAY OUT OF THE DOCUMENT KERNEL. `### Task I-N:`, `Output`,
 * `Dependencies` are this flow's conventions, not the platform's idea of what a document is. The
 * generic kernel stores and gates documents of any shape; the knowledge that a plan has tasks
 * with edges between them lives here, beside the flow that invented it.
 */
import { createHash } from "node:crypto";

// ── the shape a plan is read against ───────────────────────────────────────────────────────
//
// Deliberately narrow. Every pattern below matches something a writer can see in their own text,
// because a structural refusal a human cannot reproduce by looking at the line is a refusal they
// will route around rather than fix.

/** A line that is TRYING to be a task heading: `### Task` followed by something numeric. Matching
 *  on intent rather than on the strict form is what lets a typo be reported as a malformed heading
 *  instead of vanishing — `### Task I-1 X`, missing its colon, would otherwise simply not be a
 *  task, and the plan would pass with a node silently absent from the graph.
 *
 *  THE NUMBER IS WHAT KEEPS IT OFF PROSE. `### Task\b` alone would take `### Task breakdown` and
 *  `### Task ordering` — ordinary section headings a long plan really does carry — and report a
 *  valid plan as malformed, which is the one outcome this validator must never produce. */
const TASK_HEADING_INTENT = /^###\s+Task\s+I?-?\d/;

/** The full form: `### Task I-17: Deterministic plan-shape validator (← AC-8.2)`. An id, a
 *  non-empty title, and the AC reference the title ends with. */
const TASK_HEADING = /^###\s+Task\s+(I-\d+)\s*:\s*(\S.*?)\s*$/;

/**
 * THE AC REFERENCE, which is required — `(← AC-8.2)`, or a comma list, `(← AC-7.5, AC-7.1)`.
 *
 * IT IS THE ONE PIECE OF TRACEABILITY THAT IS SHAPE. Whether a task traces to the RIGHT criterion
 * is a reading of both documents and is not answered here; whether the link was written down at
 * all is a fact about the heading, and a task with no link is a task nobody can tie back to
 * anything the plan was approved for. Measured against the plan this was built for: all 39 task
 * headings carry one, so requiring it refuses no plan anybody has written.
 *
 * NO ORDER AND NO COUNT IS ASSUMED. The real headings carry one, two and three references, and
 * `(← AC-7.2, AC-7.1)` descending is as valid as ascending — a rule about the order of a list of
 * references would be a rule about tidiness, and that is not a property of an executable plan.
 *
 * THE ASCII ARROW IS ACCEPTED TOO. The house form is `←` and every real heading uses it, but
 * refusing `<-` would be refusing a plan over which character a keyboard produced, which is
 * typography and not shape. */
const AC_REFERENCE = /\((?:←|<-)\s*(AC-\d+\.\d+(?:\s*,\s*AC-\d+\.\d+)*)\s*\)$/;

/** Where a task's block ends: the next heading at `#`, `##` or `###`. A `####` sub-heading stays
 *  INSIDE the task, because plans really do sub-divide a task and its `**Output:**` line may sit
 *  under one of those sub-headings. */
const BLOCK_BOUNDARY = /^#{1,3}\s/;

/** What may sit in front of either line: indentation, a list marker, a quote marker. The real
 *  plan writes both lines flush at column zero, and a validator that refused `- **Output:** a`
 *  would be refusing a plan over a bullet — a false refusal of a valid plan, which is the one
 *  outcome this file must never produce. Reading a line a writer did not intend as the task's
 *  Output is the opposite error and the cheaper one: it lets a malformed task pass, which the
 *  reader who is auditing the plan still catches. */
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

// ── what a report says ─────────────────────────────────────────────────────────────────────

/**
 * The structural failures, named. A closed vocabulary rather than free prose so a caller can
 * branch on one — and so nobody can add a kind that means "this plan looks weak", which is the
 * judgement this file does not make. Every kind below is a fact about the document's text.
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
   *  was approved for. Whether it is the RIGHT criterion is not asked. */
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
 * `order` is AN executable ordering over the edges the document declares — a sequence in which
 * every task's declared dependencies come before it. It is not the RIGHT order, and it is not a
 * claim that following it produces working software: the edges are the ones the author wrote,
 * and whether those edges are the true ones is exactly the adequacy question this file refuses.
 * It is empty when a cycle makes any such ordering impossible.
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

// ── reading the document ───────────────────────────────────────────────────────────────────

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
 * A FENCED BLOCK IS AN EXAMPLE, NOT A TASK, and this is what keeps a plan that documents its own
 * format from being refused by the rule that reads it. A plan explaining what a task heading
 * looks like writes ```` ``` ````, a specimen `### Task I-1:` and a closing fence — and read
 * flat, that specimen is a second task claiming an id, which comes back as `duplicate_task_id`
 * against a document with no such defect. A false refusal of a valid plan is the one outcome
 * this validator must never produce.
 *
 * BLANKED, NOT DROPPED, so every line number in the report is still the line somebody opens.
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
 * A DUPLICATE HEADING IS REPORTED AND THEN SKIPPED. Its block is not checked for an Output or a
 * Dependencies line and its edges do not enter the graph: the first occurrence owns the id, and
 * piling three more violations onto a block nobody can address until the id clash is resolved
 * buries the one violation that has to be fixed first.
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
        // NOT read as "none": a line nobody can parse is an undeclared position in the order,
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

// ── the graph ──────────────────────────────────────────────────────────────────────────────

/**
 * Edges, with the unusable ones reported rather than followed. A self-edge is a `self_dependency`
 * and is kept out of the cycle graph, so it is named once and not again as a one-node ring; an
 * edge to an id no heading declares is an `unknown_dependency` and is dropped, because following
 * it would mean inventing a node the document does not have.
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
 * Every dependency ring in the graph, each reported once.
 *
 * One depth-first pass traverses each edge exactly once, so every back edge — and therefore every
 * ring — is seen. A ring is rotated to start at its earliest member in document order before it
 * is recorded, which is what makes `I-2 -> I-3 -> I-2` and `I-3 -> I-2 -> I-3` the one finding
 * they are rather than two.
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
 * An executable ordering, or nothing.
 *
 * Kahn's algorithm, taking the earliest ready task in document order at every step — the plan's
 * own sequence is the tie-break, so a plan already written in a runnable order gets that order
 * back rather than a re-shuffle that is equally valid and reads as a correction. Returns null
 * when a ring leaves tasks that never become ready: there is then no such ordering to report,
 * and a partial one would be an executable-looking answer to a question with no answer.
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

// ── the two entry points ───────────────────────────────────────────────────────────────────

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
 * every time, with no model in the path. That is the point of it — the report is evidence, and
 * evidence that could come back differently on a second run is not evidence.
 *
 * `target` is the version or digest the plan is being validated against. Omitted, the report
 * binds to the digest of the text it just read, which is always true but says only "this report
 * describes these bytes"; passing the version a caller believes it is executing is what lets
 * `admitToExecute` catch a report that has gone stale.
 */
export function validatePlan(text: string, target?: string): PlanStructuralReport {
  const digest = createHash("sha256").update(text, "utf8").digest("hex");
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  const source = blankFencedRuns(lines);
  const parsed = parseTasks(source.text);
  const graph = buildEdges(parsed.tasks);
  const violations = [...parsed.violations, ...graph.violations];

  // A FENCE NOBODY CLOSED swallows the rest of the document, and every task after it simply
  // stops existing — reported, otherwise, as tasks that were never declared and dependencies on
  // nothing. Said plainly instead, because the defect is one unclosed line and the report a
  // reader would otherwise get names ten tasks that are perfectly fine.
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
 * BOTH VERDICTS ARE REQUIRED AND NEITHER SUBSTITUTES FOR THE OTHER. An approval says a person
 * read the plan and wants it built. A passing report says the document parses as a plan. A
 * duplicate task id is invisible to the first and fatal to the second, and an approval arriving
 * over a failing report is the exact shape of accident this refuses: the person did not overrule
 * the check, they never saw what it found.
 *
 * NOTHING HERE BLOCKS WRITING. A malformed draft can be written, revised and read all day, and a
 * genuine approval can be recorded against it — this gate stands at controlled Execute and
 * nowhere earlier. Refusing the draft would refuse the only form in which a plan can be fixed.
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
