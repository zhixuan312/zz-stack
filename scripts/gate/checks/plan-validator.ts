import { validatePlan, admitToExecute } from "@zz/contracts";
import { check } from "../run.ts";

const good = "## Phase 1 — A: works\n### Task I-1: X (← AC-1.1)\n**Output:** a\n**Dependencies:** none\n";

check("the plan validator blocks malformed plans from controlled execution but not from being written", () => {
  if (!validatePlan(good).ok) return "a well-formed plan failed structural validation";

  const dupe = good + "### Task I-1: Y (← AC-1.2)\n**Output:** b\n**Dependencies:** none\n";
  if (validatePlan(dupe).ok) return "a plan with duplicate task ids passed";

  const cycle = good + "### Task I-2: Y (← AC-1.2)\n**Output:** b\n**Dependencies:** Task I-3\n"
                     + "### Task I-3: Z (← AC-1.3)\n**Output:** c\n**Dependencies:** Task I-2\n";
  if (validatePlan(cycle).ok) return "a plan with a dependency cycle passed";

  const noOutput = "## Phase 1 — A: works\n### Task I-1: X (← AC-1.1)\n**Dependencies:** none\n";
  if (validatePlan(noOutput).ok) return "a task with no Output passed";

  const approved = { humanApproved: true, structuralReport: validatePlan(dupe) };
  if (admitToExecute(approved).admitted) {
    return "a malformed plan was admitted to controlled execution because a human had approved it — "
         + "approval is a verdict on content, not a structural report";
  }
  if (admitToExecute({ humanApproved: true, structuralReport: undefined }).admitted) {
    return "a plan with no structural report at all was admitted";
  }
});

const task = (n: number, deps: string, owns?: string) =>
  `### Task I-${n}: T${n} (← AC-1.${n})\n**Output:** o${n}\n**Dependencies:** ${deps}\n` +
  (owns === undefined ? "" : `**Owns:** ${owns}\n`);
const plan = (...tasks: string[]) => "## Phase 0 — Skeleton: runs end to end\n" + tasks.join("") +
  "## Integration hotspots\n- `CHANGELOG.md`\n- `scripts/gate.ts`\n";
const kinds = (text: string) => validatePlan(text).violations.map((v) => v.kind);

check("the plan validator groups tasks into waves by dependency and disjoint Owns", () => {
  const owned = plan(
    task(1, "none", "`packages/a/**`"),
    task(2, "none", "`packages/b/src/x.ts`, `packages/b/src/y.ts`"),
    task(3, "Task I-1", "`packages/a/src/extra.ts`"),
    task(4, "Tasks I-2, I-3", "none"),
  );
  const report = validatePlan(owned);
  if (!report.ok) return `a plan with disjoint Owns failed: ${kinds(owned).join(", ")}`;
  const waves = JSON.stringify(report.waves);
  if (waves !== JSON.stringify([["I-1", "I-2"], ["I-3"], ["I-4"]])) return `unexpected waves ${waves}`;
  if (report.hotspots.join() !== "CHANGELOG.md,scripts/gate.ts") return `hotspots read as ${report.hotspots.join()}`;

  const overlap = plan(task(1, "none", "`packages/a/**`"), task(2, "none", "`packages/a/src/x.ts`"));
  if (!kinds(overlap).includes("owns_overlap")) return "two independent tasks owning one path passed";

  const hotspot = plan(task(1, "none", "`CHANGELOG.md`"));
  if (!kinds(hotspot).includes("owns_hotspot")) return "a task owning an integration hotspot passed";
  const wide = plan(task(1, "none", "`scripts/**`"));
  if (!kinds(wide).includes("owns_hotspot")) return "a glob covering an integration hotspot passed";

  const partial = plan(task(1, "none", "`a.ts`"), task(2, "none"));
  if (!kinds(partial).includes("missing_owns")) return "a task with no Owns passed beside tasks that declare them";

  const siblings = plan(task(1, "none", "`src/*.ts`"), task(2, "none", "`src/*.md`"));
  if (!validatePlan(siblings).ok) return "sibling globs that cannot name one file were read as overlapping";
});

check("a plan that declares no Owns runs one task per wave", () => {
  const report = validatePlan(plan(task(1, "none"), task(2, "none"), task(3, "none (after I-1 lands)")));
  if (!report.ok) return `a plan with no Owns failed: ${report.violations.map((v) => v.kind).join(", ")}`;
  if (JSON.stringify(report.waves) !== JSON.stringify([["I-1"], ["I-2"], ["I-3"]])) {
    return `a plan with no Owns ran in waves ${JSON.stringify(report.waves)}`;
  }
});

check("a plan written one phase at a time validates on the phases written, and yields the current phase's waves", () => {
  const phase1 = "## Phase 1 — Skeleton: runs end to end\n" +
    task(1, "none", "`packages/a/**`") + task(2, "none", "`packages/b/x.ts`") + task(3, "Task I-1", "`packages/a/y.ts`");
  const pending = "## Phase 2 — Candidates: built in isolation\n";
  const tail = "## Integration hotspots\n- `CHANGELOG.md`\n## Full-suite gate\n`npm run gate`\n";
  const report = validatePlan(phase1 + pending + tail);
  if (!report.ok) return `a plan with Phase 2 not yet written failed: ${kinds(phase1 + pending + tail).join(", ")}`;
  const [one, two] = report.phases;
  if (report.phases.length !== 2 || one?.phase !== 1 || two?.phase !== 2) return `phases read as ${JSON.stringify(report.phases)}`;
  if (JSON.stringify(one.waves) !== JSON.stringify([["I-1", "I-2"], ["I-3"]])) return `Phase 1's waves read as ${JSON.stringify(one.waves)}`;
  if (two.taskIds.length || two.waves.length) return "the unwritten Phase 2 carried tasks";
  if (report.currentPhase !== 1) return `the current phase read as ${report.currentPhase}, not 1`;

  // Phase 1 built, Phase 2 planned: Phase 2 is current, and its waves treat Phase 1 as done.
  const built = phase1 + "### As built\nI-1..I-3 landed; I-2 wrote one extra fixture.\n" +
    "## Phase 2 — Candidates: built in isolation\n" +
    task(4, "Task I-3", "`packages/c/**`") + task(5, "Tasks I-1, I-4", "`packages/d.ts`") + tail;
  const next = validatePlan(built);
  if (!next.ok) return `a plan with Phase 1 built and Phase 2 planned failed: ${kinds(built).join(", ")}`;
  if (next.currentPhase !== 2 || !next.phases[0]?.built) return `after Phase 1 was built the current phase read as ${next.currentPhase}`;
  if (JSON.stringify(next.phases[1]?.waves) !== JSON.stringify([["I-4"], ["I-5"]])) {
    return `Phase 2's waves read as ${JSON.stringify(next.phases[1]?.waves)}`;
  }
  // A task written in the phase being planned is held to every rule a whole plan is.
  if (validatePlan(phase1 + "## Phase 2 — C\n### Task I-4: T4 (← AC-1.4)\n**Output:** o\n" + tail).ok) {
    return "a Phase 2 task with no Dependencies passed because its phase was the latest";
  }
});
