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

/** How many compiled patterns are kept. A plan names tens of paths, and the same few against every
 *  other; the bound only stops a long-lived process from holding a pathological plan's patterns
 *  forever, and overflowing it costs a recompile and nothing else. */
const PATTERN_CACHE = 5_000;

/** Everything `overlaps` needs of one owned path, worked out once: whether it carries a wildcard, its
 *  path without the trailing slashes, that path and its own separator (what a literal path owns
 *  beneath it), its compiled pattern, and the sample a pattern is tested against. */
type Owned = { id: number; glob: boolean; path: string; under: string; pattern: RegExp; sample: string };

/** Descriptors by the path they were built from, oldest first once the bound is reached.
 *
 *  DELIBERATE: memoized. `overlaps` is asked of every PAIR of a plan's owned paths, so a plan of N
 *  tasks does N² × paths² comparisons — the 183-task plan on this platform took 1.7 s of one
 *  `initiative_status` in `ownsPattern` alone, and every one of those patterns had already been
 *  compiled. A `RegExp` carries no state here (`test` with no `g` flag keeps no `lastIndex`), so
 *  sharing one is safe, and the descriptors are read and never written. */
const owned = new Map<string, Owned>();

/** The number a descriptor is known by, in the pair cache above. Never reused, so a remembered pair
 *  cannot be read as another pair's answer. */
let nextOwned = 1;

function ownedOf(p: string): Owned {
  const known = owned.get(p);
  if (known) return known;
  const path = p.replace(/\/+$/, "");
  const glob = p.includes("*") || p.includes("?");
  const body = path.split(/(\*\*|\*|\?)/).map((part) =>
    part === "**" ? ".*" : part === "*" ? "[^/]*" : part === "?" ? "[^/]"
      : part.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("");
  const descriptor: Owned = {
    id: nextOwned++,
    glob, path, under: `${path}/`, pattern: new RegExp(`^${body}(?:/.*)?$`),
    sample: p.replace(/\*\*|\*|\?/g, "x").replace(/\/+$/, "/x"),
  };
  if (owned.size >= PATTERN_CACHE) owned.delete(owned.keys().next().value!);
  owned.set(p, descriptor);
  return descriptor;
}

/** How many pair answers are kept. One big plan of this deployment asks about ~150,000 pairs; the
 *  bound is what a long-lived process may hold, and overflowing it costs a re-test of the pair. */
const MET_CACHE = 200_000;

/** Pair answers by both descriptors' own numbers, `low * 10^7 + high`, oldest first once the bound is
 *  reached. Ten to the seventh keeps the sum inside a double's exact integers for any descriptor
 *  number a process this size reaches; past that the pair is tested and not remembered. */
const met = new Map<number, boolean>();

/**
 * Whether two owned paths can name the same file. Each side's wildcards are filled with one
 * concrete segment and tested against the other's pattern, which is exact for a literal path
 * against anything and for nested globs. Two sibling globs that meet only in the middle
 * (`a*.ts` against `*b.ts`) are not seen: declare such ownership as a literal path or a directory.
 *
 * DELIBERATE: two literal paths are compared as strings. What their patterns say is `p === w` or
 * `p` beneath `w`, and a plan that names a directory rather than a glob asks this thousands of times
 * about paths whose answer is one of two string tests. Both sides are described once, by the caller,
 * because a plan of N tasks calls this N² × paths² times.
 *
 * DELIBERATE: the answer is memoized by the pair. Almost every `**Owns:**` line a plan writes is a
 * glob — 682 of 684 across this deployment — so the pair is two regular expressions and not two
 * strings, and the same handful of globs is compared over and over: a plan's tasks reuse a directory
 * (`services/gateway/src/console/**`) far more often than they name a new path. The pairing of two
 * paths cannot change while both are the same strings, which is what the descriptor cache already
 * guarantees, so a remembered answer is the answer.
 */
function overlapsOwned(x: Owned, y: Owned): boolean {
  if (!x.glob && !y.glob) return y.path === x.path || y.path.startsWith(x.under) || x.path.startsWith(y.under);
  const key = x.id < y.id ? x.id * 10_000_000 + y.id : y.id * 10_000_000 + x.id;
  const known = met.get(key);
  if (known !== undefined) return known;
  const answer = x.pattern.test(y.sample) || y.pattern.test(x.sample);
  if (x.id < 1_000_000 && y.id < 1_000_000) {
    if (met.size >= MET_CACHE) for (const old of met.keys()) { met.delete(old); if (met.size < MET_CACHE / 2) break; }
    met.set(key, answer);
  }
  return answer;
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
  // Every path described once, before any pair is compared; the loop below is then string tests.
  const owns = tasks.map((task) => (task.owns ?? []).map(ownedOf));
  const spots = hotspots.map(ownedOf);
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
    for (const [at, path] of task.owns.entries()) {
      const spot = spots.findIndex((candidate) => overlapsOwned(owns[index]![at]!, candidate));
      const hotspot = spot < 0 ? undefined : hotspots[spot];
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
    const mine = owns[index]!;
    for (let before = 0; before < index; before++) {
      const earlier = tasks[before]!;
      if (earlier.owns === null) continue;
      if (reached.get(task.id)?.has(earlier.id) || reached.get(earlier.id)?.has(task.id)) continue;
      const theirs = owns[before]!;
      const pair: [string, string][] = [];
      for (const [i, a] of task.owns.entries()) {
        for (const [j, b] of earlier.owns.entries()) if (overlapsOwned(mine[i]!, theirs[j]!)) pair.push([b, a]);
      }
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
