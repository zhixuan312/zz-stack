/**
 * Who writes what in a plan, and so which tasks may run at the same time.
 *
 * A task's `**Owns:**` line names the paths it writes. Two tasks may share a wave only when
 * neither can write a file the other writes; where their paths overlap, one must depend on the
 * other, so the plan decided their order rather than leaving it to whichever worker finishes
 * last. Paths under `## Integration hotspots` belong to the integration step after each wave.
 *
 * A plan is written one phase at a time, so waves are also computed per `## Phase N` block: the
 * phase being built next runs its own tasks, with every earlier phase's tasks already done.
 *
 * Read by `validatePlan`, which owns the parsing; this file sees only what was parsed.
 */
import type { PlanViolation } from "./plan-validation.js";

/** What ownership needs of a parsed task. `owns` is null when the task has no Owns line. */
export interface OwnedTask {
  readonly id: string;
  readonly line: number;
  readonly owns: readonly string[] | null;
}

/** A path owns everything beneath it; `*` stays within a segment, `**` crosses them. */
function ownsPattern(path: string): RegExp {
  const body = path.replace(/\/+$/, "").split(/(\*\*|\*|\?)/).map((part) =>
    part === "**" ? ".*" : part === "*" ? "[^/]*" : part === "?" ? "[^/]"
      : part.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("");
  return new RegExp(`^${body}(?:/.*)?$`);
}

/**
 * Whether two owned paths can name the same file. Each side's wildcards are filled with one
 * concrete segment and tested against the other's pattern, which is exact for a literal path
 * against anything and for nested globs. Two sibling globs that meet only in the middle
 * (`a*.ts` against `*b.ts`) are not seen: declare such ownership as a literal path or a directory.
 */
function overlaps(a: string, b: string): boolean {
  const sample = (p: string) => p.replace(/\*\*|\*|\?/g, "x").replace(/\/+$/, "/x");
  return ownsPattern(a).test(sample(b)) || ownsPattern(b).test(sample(a));
}

/** Every task each task reaches through its dependencies, directly or not. */
function ancestors(ids: readonly string[], edges: ReadonlyMap<string, readonly string[]>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const reach = (id: string): Set<string> => {
    const known = out.get(id);
    if (known) return known;
    const set = new Set<string>();
    out.set(id, set);
    for (const dependency of edges.get(id) ?? []) {
      set.add(dependency);
      for (const further of reach(dependency)) set.add(further);
    }
    return set;
  };
  for (const id of ids) reach(id);
  return out;
}

/** The ownership violations of an acyclic plan whose tasks declare Owns at all. */
export function ownershipViolations(
  tasks: readonly OwnedTask[],
  edges: ReadonlyMap<string, readonly string[]>,
  hotspots: readonly string[],
): PlanViolation[] {
  if (tasks.every((task) => task.owns === null)) return [];
  const violations: PlanViolation[] = [];
  const reached = ancestors(tasks.map((task) => task.id), edges);
  for (const [index, task] of tasks.entries()) {
    if (task.owns === null) {
      violations.push({
        kind: "missing_owns",
        taskId: task.id,
        line: task.line,
        detail: `task ${task.id} declares no "**Owns:**" while other tasks do; say what it writes, or \`none\``,
      });
      continue;
    }
    for (const path of task.owns) {
      const hotspot = hotspots.find((spot) => overlaps(path, spot));
      if (hotspot !== undefined) {
        violations.push({
          kind: "owns_hotspot",
          taskId: task.id,
          line: task.line,
          detail: `task ${task.id} owns \`${path}\`, which covers the integration hotspot \`${hotspot}\`; ` +
            "a hotspot is edited by the integration step after each wave, and a task reports its lines instead",
        });
      }
    }
    for (const earlier of tasks.slice(0, index)) {
      if (earlier.owns === null) continue;
      if (reached.get(task.id)?.has(earlier.id) || reached.get(earlier.id)?.has(task.id)) continue;
      const pair = task.owns.flatMap((a) => earlier.owns!.filter((b) => overlaps(a, b)).map((b) => [b, a]));
      if (pair.length === 0) continue;
      violations.push({
        kind: "owns_overlap",
        taskId: task.id,
        line: task.line,
        detail: `tasks ${earlier.id} and ${task.id} both own \`${pair[0][0]}\` / \`${pair[0][1]}\` and ` +
          "neither depends on the other; make one depend on the other, or split the path",
      });
    }
  }
  return violations;
}

/** Kahn's algorithm in layers: every task whose dependencies are done runs in the same wave. */
export function executableWaves(
  tasks: readonly OwnedTask[],
  edges: ReadonlyMap<string, readonly string[]>,
  order: readonly string[],
): string[][] {
  if (tasks.every((task) => task.owns === null)) return order.map((id) => [id]);
  const done = new Set<string>();
  const waves: string[][] = [];
  let remaining = [...order];
  while (remaining.length > 0) {
    const wave = remaining.filter((id) => (edges.get(id) ?? []).every((d) => done.has(d)));
    for (const id of wave) done.add(id);
    remaining = remaining.filter((id) => !done.has(id));
    waves.push(wave);
  }
  return waves;
}

/** `## Phase 2 — Candidates: built in isolation`. The number is the phase's name. */
const PHASE_HEADING = /^##\s+Phase\s+(\d+)\b/i;

/** What `sdlc-execute` appends under a phase once it is built: what was actually done. */
const AS_BUILT_HEADING = /^###\s+As[ -]built\b/i;

/** One `## Phase N` block: its tasks in document order, whether it was built, and its waves —
 *  tasks of earlier phases count as done. `waves` is empty when there is no executable order. */
export interface PlanPhase {
  readonly phase: number;
  readonly line: number;
  readonly taskIds: readonly string[];
  readonly built: boolean;
  readonly waves: readonly (readonly string[])[];
}

/** Every phase block, running to the next `## ` heading, with the tasks under it. A phase with no
 *  tasks is one the spec outlines and nobody has planned yet; it is listed, never refused. */
export function planPhases(
  lines: readonly string[],
  tasks: readonly OwnedTask[],
  edges: ReadonlyMap<string, readonly string[]>,
  order: readonly string[] | null,
): PlanPhase[] {
  const blocks: Array<{ phase: number; line: number; end: number; built: boolean }> = [];
  for (const [i, line] of lines.entries()) {
    const open = blocks.at(-1);
    if (/^##\s/.test(line) && open && open.end === -1) open.end = i;
    const heading = PHASE_HEADING.exec(line);
    if (heading) blocks.push({ phase: Number(heading[1]), line: i + 1, end: -1, built: false });
    else if (AS_BUILT_HEADING.test(line) && open && open.end === -1) open.built = true;
  }
  return blocks.map((b) => {
    const end = b.end === -1 ? lines.length : b.end;
    const mine = tasks.filter((t) => t.line > b.line && t.line <= end);
    const ids = new Set(mine.map((t) => t.id));
    const within = new Map(mine.map((t) => [t.id, (edges.get(t.id) ?? []).filter((d) => ids.has(d))]));
    return { phase: b.phase, line: b.line, built: b.built, taskIds: mine.map((t) => t.id),
             waves: order ? executableWaves(mine, within, order.filter((id) => ids.has(id))) : [] };
  });
}
