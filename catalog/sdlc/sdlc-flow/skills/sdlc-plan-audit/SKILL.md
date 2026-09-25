---
name: sdlc-plan-audit
version: 2.6
description: Audit plan.md — the eleven prose failure modes plus the plan's own contract: AC traceability, task contracts, checks that compile, the format the executor depends on, dependency order and ownership, the walking skeleton, the full-suite gate. Read-only. Dispatched, one round at a time; how many is routed by evidence.
when_to_use: "plan.md is written and someone is about to execute it. Runs after sdlc-plan and before sdlc-execute. Dispatched by the main agent, one round at a time."
---

# sdlc-plan-audit

<!-- Design note: read-only here is a DISCIPLINE, not an enforced tool denial. The round
     loop belongs to the caller, not to this file. And auditing is split by document — a
     spec and a plan fail in different ways, so one generic auditor would find the generic
     half of both and miss what actually breaks. -->

You are auditing a **plan** — the document a worker will follow task by task, literally, without
asking questions. Everything below matters because of that: the executor cannot disambiguate, and
it will not stop to check.

**Load `sdlc-audit-criteria` first, then come back here.** It carries the eleven prose
failure modes, the evidence shapes a finding must take, and the JSON a round returns —
everything an audit does whatever document it was given. This file carries the one thing
that is different: what a plan owes, below.

Do not restate those criteria here. They were written twice once already, and two
auditors applying different standards is worse than either standard.

**You present nothing to the person.** A dispatched round hands its JSON envelope back to
the main agent, and that agent decides what anybody is shown — so do not paste a document,
or `document_present` output, into what you return. Presenting a document in full belongs
to the gate the main agent is asking somebody to sign, and this round is not that.

**Your round is recorded as a SOURCE supporting `plan.md`** — `source_add(..., supports:
"plan.md", stage: "sdlc-plan-audit")`. It is the only thing standing between an unread plan and `sdlc-execute`
dispatching its tasks one by one, it is what tells anyone later that somebody who did not write
the plan read it, and it is what the platform requires the next version of the plan to cite. It
is not a document of the flow: an audit report is the material that makes a revision necessary.
`sdlc-audit-criteria` carries how to write it and the exact call.

## Twelve: the plan's own contract

The eleven failure modes in `sdlc-audit-criteria` are about prose. These are about what makes a plan executable, and a
plan fails here far more often than it fails as prose.

1. **Every spec AC is traced.** The traceability table maps every business AC in the spec to at
   least one task. An untraced AC is scope that will not get built, and it is the highest-value
   finding this audit can produce.
2. **Every task carries its contract.** The five bullets, in this order and with these labels:
   Inputs / Request · Outputs / Response · Data mapping · Errors · Behavior / invariants. A task
   with a technical AC and no contract is a wish.
3. **Every task has a technical AC traced to a business AC** (`← AC-N.N`), written as a testable
   sentence rather than a goal.
4. **Checks are real, or honestly absent — and they compile.** A declared check's `Check:` path is
   a NEW dedicated file — never the task's own `**Output:**` — and sits under a checks or tests
   directory. Every `Run:` command is whitespace-delimited argv with **no shell metacharacters** and
   names a runner the project actually has. A task with no deterministic check must say in its AC
   how the claim is established instead: a missing Checks section is a statement, and a *silently*
   missing one is a finding.

   **Reading a check is not auditing it.** `sdlc-execute` freezes these bytes and no worker may
   change them, so a check that does not compile fails its task however correct the work. Copy
   each declared check's source to a scratch location OUTSIDE the checkout and run the cheapest
   thing that proves it is well-formed: the project's typecheck or syntax check against it
   (`tsc --noEmit`, `node --check`, `python -m py_compile`, the linter's parse). A check whose
   imports name something the plan says a task will create is expected to fail on that import
   and nothing else — say so. Any other compile error is a finding, quoted with the command and
   the first error line. Where nothing can compile it here, report the check unverified rather
   than passing it.
5. **The format the executor depends on.** Phase headings are level-2
   `## Phase N — <name>: <what works at the end>`. Task headings are level-3 `### Task I-N:` with N
   as an arabic digit, numbered straight through regardless of phase. `**Output:**`,
   `**Dependencies:**` and `**Owns:**` are one line each, immediately after the heading. `sdlc-execute` names a task
   by that id when it dispatches, so an ambiguous or duplicated id makes a task undispatchable.
6. **Dependency order holds, and ownership is decided.** No task depends on the output of a later
   one. Phases end where a person could actually inspect the increment — a boundary nobody can
   review buys nothing. Every task declares `**Owns:**`, or none does; two tasks whose Owns overlap
   depend on one another, directly or through others; no task owns a path listed under
   `## Integration hotspots`; and a task that plainly writes something outside its Owns (a
   registration, a changelog line) is a finding, because at execute it collides with a
   parallel worker or with the integration step. Write out the waves you derived — the tasks
   whose dependencies are done, taken together — so the owner sees what will run in parallel.
7. **The full-suite gate exists**, as a section headed exactly `## Full-suite gate`, naming the
   project's real build, typecheck, test and lint entry points — or, for a deliverable with no
   suite, one line saying so and naming what stands in for it. Per-task checks prove each task did
   its own job; they cannot prove it left the rest working, and every-check-green with the suite red
   is the actual failure mode of a plan executed task by task.
8. **No implementation code and no deliverable content leaked** into the plan. The only code is a
   declared check's source.
9. **Zero `<!-- enrich` markers remain.**
10. **Paths are real.** Every path named was verified against the tree at HEAD, not guessed. Verify
    the specific paths the plan names — do not enumerate the repository.
11. **Granularity is human-sensible.** Roughly 2–6 tasks per phase, each a unit one person could
    finish in a sitting. A hundred trivial tasks and two mega-tasks are both findings.
12. **A walking skeleton runs from Phase 0.** Phase 0 builds one command that runs the whole
    deliverable end to end with stubs, and every later phase ends by running it. A plan whose
    first end-to-end run is in its last phase is a finding: that is where every integration
    defect will surface at once.
13. **No volatile facts.** A migration number, a line count, exact SQL, a line number or a
    mechanism the executor could choose, written as an instruction, is a finding unless the spec
    fixes it — the tree will have moved by the time the task runs.
14. **Every `command` AC names its evidence kind** — `check:`, `run:`, `probe:` or `test:` — the
    kinds `sdlc-review`'s `## Acceptance evidence` table accepts.

Add `plan-contract` to `criteriaCovered` when you have walked these.

## What a plan audit is not

**Do not audit the spec.** It was agreed and already audited by `sdlc-spec-audit`; if the plan
faithfully implements a spec you disagree with, that is not a plan finding.

The exception is a genuine contradiction between the two — "Task I-4 builds X, but the spec puts X
explicitly out of scope" — which is among the most valuable findings available here, because
nothing else in the flow is positioned to see it.

## Skill contract

**Outcome:** one round's findings on `plan.md` — the eleven prose failure modes plus the fourteen
points of the plan's own contract — registered with `source_add` as a SOURCE supporting that
document, and handed back to the caller as one JSON block. This round writes no document of the
flow and changes nothing in the plan.

**Required evidence:** every finding in one of the four evidence shapes, each opening with its
source in square brackets. For a path claim, the tree at HEAD — verify the specific paths the plan
names rather than enumerating the repository. For a runner claim, that the project actually has
the entry point the `Run:` command names. And the plan version `document_present` stated when you
opened it, quoted in the source you register — `sdlc-execute` dispatches from one revision of this
document, so a round that does not say which one it read cannot be matched to what was built.

**Allowed unknowns:** whether the spec was right. It was agreed and already audited, and a plan
that faithfully implements a spec you disagree with is not a plan finding. How a task will be
implemented: the contract, not the implementation, is what you are reading. The one exception to
the first is a genuine contradiction between the two documents — "Task I-4 builds X, but the spec
puts X explicitly out of scope" — which is among the most valuable findings available here,
because nothing else in the flow is positioned to see it.

**Work roles:** dispatched, because the value is a reader who did not write the plan. The person
who owns the plan decides what to fix, and you present nothing to them. The consumer everything
here is calibrated against is a low-judgement worker that follows the plan literally and will not
stop to check. Where the caller said what the last round raised, confirm each fix and look
instead for what the changes introduced. The platform asks two bounded questions of your round
when it is recorded, and routes on them; you ask none, and severity stays yours to calibrate.

**Checkpoints:**

| Where | Question ID | Asked about |
|---|---|---|
| When `source_add` records your round — asked by the platform | `changes_commitment` | whether the round reopens something the document records as agreed — `yes` makes the next move `decide`, waiting on the stakeholder, instead of another round |
| The same, from round 2 on | `repeats_finding` | whether the round mostly repeats the rounds before it — the next move says so; it does not change the move |

**Action and exit paths:** the action is the eleven failure modes one at a time, then the plan's
fourteen, then consolidation. Two exits, both taken every round: `source_add` carrying the prose
findings and naming `plan.md`, and the JSON block as your final text. The round loop, and the
decision to send the plan back to `sdlc-plan`, belong to the caller. The exit that does not exist
is repairing the plan yourself.

**Degraded behaviour:** a task with no deterministic check is not automatically a finding — a
missing Checks section is a statement, and only a silently missing one is a defect, so read the
technical AC for how the claim is established instead. A check path or runner you cannot resolve
is reported as unverified rather than asserted broken. Read-only here is a discipline and not an
enforced denial.
