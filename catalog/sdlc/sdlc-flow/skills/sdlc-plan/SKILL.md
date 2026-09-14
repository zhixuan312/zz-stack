---
name: sdlc-plan
version: 1.5
description: Turn an approved spec into a contract-first, human-executable plan at <initiative>/plan.md — build phases, tasks with contracts and technical acceptance criteria traced to the spec's business ACs, and a full-suite gate. Main agent only; never dispatched.
when_to_use: "The spec is written, agreed and audited, and the work needs an order to be built in. Produces plan.md, which is a gate: nothing executes until a person approves it. Local runtimes only (Claude Code, Codex)."
---

# sdlc-plan

<!-- Design note: the main agent writes this, never a dispatched worker, because order,
     risk and scope are the person's judgement. So there is no report to check and no JSON
     envelope — you check your own work, then hand it over for approval. The document is
     written into the initiative. -->

**Read `sdlc-method` first.** Then note that this stage, like `sdlc-spec`, is **yours** and is
never dispatched. Order, risk and scope are the person's judgement, and a dispatched plan is a
plausible ordering nobody chose.

**Write it with the platform's `document_write` into the initiative, as `plan.md`.** Never a local
path. `document_write` writes the FIRST version only — once the plan is approved the platform refuses
it on this document, and the plan changes through `document_revise`. See *Coming back from the
audit, or from execution* at the end of this skill.

## Role

You are a plan writer producing a **contract-first, human-executable** implementation plan from a
specification. The plan is an engineering contract: it translates the spec's *business* acceptance
criteria into *technical* acceptance criteria, organized into **build phases** that a competent
engineer — human or agent — could execute, in order, to the finished solution.

## Audience & purpose

The plan's readers are **engineers** (developers, QA, tech leads). It is the BA translation from
business intent to an engineering build — not line-by-line code, but the *solution shape and the order
it is built in*, so humans can understand, review, and keep control of the judgemental decisions. The
agent that ultimately executes it needs far less than this; the richness is for the humans.

**Completion test (the real bar):** a competent engineer, reading only this plan, could execute every
phase and task in order and arrive at the working, spec-satisfying solution — without the plan's
author present. If a human could not follow it to the end, it is not done.

## What the plan must express

The spec defines WHAT to build and WHY (business acceptance criteria). You define HOW it is built — as
**phases** (build stages), each holding **tasks**, each task carrying an **output declaration**, its
**dependencies**, a **contract**, a **technical acceptance criterion**, and — when the task's contract
admits a deterministic check — **plan-authored checks**. A task never contains implementation code or
the final deliverable's own content; only a declared check's test code is code you write. A capable
executor implements freely against the contract; `sdlc-execute` writes every declared check to its
path from this plan BEFORE dispatching the task that must pass it, so a declared check is the
contract's teeth. Not every task can be checked
deterministically — a narrative report section or a design decision has no pass/fail command — so a
check is OPTIONAL: a task with no check still needs a precise, unambiguous contract, because the
reviewer and the executor have nothing else to go on. If a contract is ambiguous or a check is wrong,
the executor reports failure rather than guessing — so make both precise.

### Phases — the build story

Group the implementation into **sequential phases that tell the build story**. Each phase leaves a
working increment a human could verify, and each carries one line: **what works at the end of it.**
For example, a new endpoint:

- **Phase 1 — Scaffold:** the endpoint accepts a request and returns a stub response end-to-end.
- **Phase 2 — Source mapping:** each response section is populated from its source system — one task
  per source (section 1 ← System A, section 2 ← System B).
- **Phase 3 — Aggregate & respond:** the sections are combined into the real, spec-shaped output.

Phases are for human comprehension: they show how the solution comes together, stage by stage. A human
executing the plan would build Phase 1, see it work, then Phase 2, and so on. Write phases as
`## Phase N — <name>: <what works at the end>` headings; tasks live under them.

### Divide and conquer — human-executable granularity

Size the decomposition so a human could execute it:
- A phase holds a **sensible handful of tasks** (roughly 2–6), each a unit one competent person could
  complete in one sitting.
- **Not** one large goal exploded into a hundred trivial tasks. **Not** a whole deliverable crammed
  into two mega-tasks. Find the natural divide-and-conquer an experienced practitioner in the
  declared `kind` would recognise.
- Each task is one coherent, independently verifiable piece of its phase — one section, one mapping,
  one component, one reconciliation — within a single work area.
- Order tasks and phases by dependency: if B needs what A creates, A comes first.
- End each phase at a point a person can actually review: a phase boundary the reader cannot inspect
  is a boundary that buys nothing.

### The Contract Task shape

Each task MUST follow this exact structure. Tasks are numbered `### Task I-N:` — a literal roman
`I`, a hyphen, then N as an ARABIC digit: `I-1`, `I-2`, … The numbering runs straight through
regardless of phase, so `sdlc-execute` can name a single task unambiguously when it dispatches a
worker for it. Write the number itself in roman (`I-IV`) and every reference to that task becomes
ambiguous. No task names an implementation file and no
task carries final deliverable content — `**Output:**` names WHAT the task produces (a path, an
artifact name, or a plain description), never HOW:

```markdown
### Task I-N: <Contract name> (← AC-X.X, AC-Y.Y)

**Output:** <what this task produces — a path, an artifact name, or a plain description>
**Dependencies:** <what this task depends on — other task ids, approved inputs, or "none">

**Technical acceptance criteria** (← AC-X.X): <one human-readable, testable statement of what "done"
means for this task — the engineering translation of the cited business AC. e.g. "Given a request with
a valid id, the endpoint returns 200 with section-1 populated from System A.">

**Contract:**
- Inputs / Request: <shape, types, source of each field>
- Outputs / Response: <shape, types>
- Data mapping: <field-by-field: response.X <- source.Y via <transform>>
- Errors: <condition -> error contract>
- Behavior / invariants: <ordering, idempotency, side effects>

**Checks (plan-authored — the executable form of the technical AC).** OPTIONAL — include this section
ONLY when the technical AC admits a deterministic pass/fail check (a test runner, a linter, a schema
validator, a CLI diff). For EACH declared check, exactly one `Check:` (a NEW dedicated destination
path) paired with exactly one fenced source block and one `Run:` command:
- Check: `<new dedicated check file path>`
  \`\`\`<lang>
  <complete check code that asserts the technical AC — you write this>
  \`\`\`
- Run: `<check command>`  Expected: PASS once implemented

**Plan boundary:** final deliverable content is not in this plan.
```

The five Contract bullets appear in exactly this order and label text. The only code you write is a
declared check's source. When a task's technical AC has no deterministic check (a narrative report
section, a design decision, a configuration a human must eyeball) OMIT the whole Checks section — do
not force a fake check just to have one; the contract and technical AC still carry the full weight of
what "done" means for that task.

### How each technical AC gets verified — choose the method the claim requires

A declared check is not the only way a criterion is verified; it is one of three, and it covers only
the claims a machine can settle. **Acceptance is broader than testing.** For every technical AC you
write, decide which method proves it and say so in the AC's own wording:

| The claim… | Method | In the plan |
|---|---|---|
| a machine can settle it (a runner, a linter, a schema validator, a diff) | `command` | declare a **Check** — this is the only method that produces one |
| needs analysis that can be delegated and evidenced (does the section follow from the data? is this consistent with the source?) | `agent-review` | no Check; state what the reviewer must compare against |
| needs authority or accountability (a professional sign-off, a decision only a named person may make) | `human` | no Check; name WHO must decide, and what they are deciding |

**The contract's acceptance set does NOT replace your task checks.** When the request carries an
approved deliverable contract, its `acceptance` entries are criteria about the FINISHED DELIVERABLE,
with their own methods chosen at the spec stage. Your task-level technical ACs are a different
level: they say what each step must achieve on the way there. A contract criterion verified by
`agent-review` or `human` says nothing about whether an individual task admits a deterministic
check — decide each task on its own merits. Treating the contract's methods as the plan's methods
silently removes every check from the plan, which is a real failure this project has observed.

Two rules that decide the hard cases:

- **Choose by what the claim requires, not by what is convenient.** There is no ranking, and
  `agent-review` is never a substitute for `human`. A claim that needs professional authority is
  `human` even when a model could produce a plausible opinion — a plausible opinion is not
  accountability.
- **A missing Check is a statement, not an omission.** When a task declares none, its technical AC
  must say plainly how the claim IS established instead. A task whose AC is unverifiable by any of
  the three methods is not ready to be planned; say what is missing rather than writing it anyway.

This is a planning obligation, and nothing enforces it: the platform records what you declare and
never refuses a criterion for its choice of method. Getting it wrong therefore surfaces at review,
or later at delivery, rather than when the plan is written.

### Format — required heading & file conventions

Two stages read this file by its shape, so the shape is a contract rather than a style: **`sdlc-execute`**
names a single task by its id when it dispatches a worker for it, and **`sdlc-plan-audit`** checks
these conventions explicitly and reports a break as a finding. Use them EXACTLY:
- **Phase headings are level-2** — `## Phase N — <name>: <what works at the end>`. Not `#`, not `###`.
  Tasks are grouped by the `##` heading above them; a `#` phase heading breaks that grouping.
- **Task headings are level-3, roman-numbered** — `### Task I-N: <title> (← AC-X.X)`. The `I-N`
  (roman-`I` + `-N`) is what `sdlc-execute` names when it dispatches a worker for one task.
- **`**Output:**` and `**Dependencies:**` are each one line**, immediately after the heading:
  ```markdown
  **Output:** `out/quarterly-report.pdf`
  **Dependencies:** approved figures (Task I-2)
  ```
  Keep any declared check's `Check:` path a NEW dedicated destination — never the path named in
  `**Output:**`, which is the deliverable itself, not a check artifact.

### Close the plan with a full-suite gate

End the plan with a section headed exactly `## Full-suite gate`, listing the commands or checks that
must pass at EVERY task boundary — the project's own build, typecheck, test and lint entry points as
they actually exist in the target (do not invent commands; read the manifest or the existing docs and
name the real ones).

Per-task checks prove the task did its own job. They cannot prove the task left the rest of the
project working, and that is the failure a plan executed task-by-task actually produces: each check
green, the suite red. State the gate once, at the end, so an executor knows what must hold after
every task rather than only after the last one.

When the target genuinely has no suite to run — a document, a workflow configuration, a deliverable
with no build — say so in that section in one line and name what stands in for it (a re-read, a
schema validation, a human review). The section is never omitted; a plan that cannot state its gate
has not decided how anyone will know it still works.

## Constraints

1. **No implementation code and no final deliverable content in the plan.** A task's closing line is
   exactly `**Plan boundary:** final deliverable content is not in this plan.`
2. **Business AC → technical AC, traced.** Every task cites the spec business AC(s) it delivers
   (`← AC-N.N`) and states its own technical acceptance criterion. Every spec AC maps to at least one
   task.
3. **Every path is exact**, verified against ground truth at HEAD. No guessed paths.
4. **Every `Run:` command** uses the project's real check runner and is a whitespace-delimited argv
   with **no shell metacharacters** (`| & ; < > $ \` ( )` or quotes).
5. **Each declared check's `Check:` path is a NEW dedicated file** — never the task's own `**Output:**`
   path — and it sits under one of `tests`, `test`, `spec`, `specs`, `checks`, `__tests__`, `src/test`,
   relative to the checkout `sdlc-execute` is working in — which is not necessarily the repository root, and in a multi-repo workspace the two differ, so say which one a path is relative to. For a non-code deliverable use `checks/`; a directory named `tests` is the
   wrong word for a check that reconciles figures against a source ledger. A task with no deterministic check declares no Checks section at all; that is not an error.
6. **Human-executable phases and granularity** as above.
7. **Conditional tasks** depending on an external prerequisite are marked BLOCKED with the unblocking
   condition.

### Deliverable-specific technique

This guidance is deliverable-neutral by default. Where a team needs technique specific to what
they build, it lives in their own skills — a flow's stage skills, or the team's skills-only
package under `catalog/<team>/` — and you load it with `skill_read` alongside this one. Nothing
merges it into this file for you.

## How to write it

Work in this order (guidance for producing a good document, not a rigid ritual):

1. **Ground truth.** Read the spec, then examine the ACTUAL source material the declared `kind`
   depends on — whatever that is: existing documents, data sources, configurations, standards, prior
   deliverables, or a codebase. Verify that every path, figure, symbol, or source the spec references
   really exists and says what the spec claims. Record discrepancies as reconciliation notes in the
   plan header — a contract that names a source which does not exist, or misreads one that does,
   makes the executor fail. Assume no test suite, no build step and no repository unless you have
   confirmed the deliverable actually has them.

   **State the production method.** Before writing tasks, name in prose the ordered method this
   specific deliverable will be produced by, and then let the phases follow it. A finance report might
   reconcile source figures, then compute, then write commentary, keeping facts, calculations,
   assumptions and interpretation separated. A policy memorandum might establish the evidence base,
   then the options, then the recommendation. Name the method you chose and why it fits this
   deliverable — a plan whose phases follow no stated method is a list, not a method.
2. **Skeleton in one write.** Send the BODY only — the platform writes the whole envelope,
   and content that opens with frontmatter is refused. Start at the title, then
   a one-line **execution note** (`> **Execution:** implemented task-by-task by \`sdlc-execute\`,
   one subagent per task; each task's declared checks gate it.`), then Goal,
   Architecture, Tech Stack, Ground truth at HEAD, File Structure — followed by the phase headings each
   with their "what works at the end" line, and every task heading with its `**Output:**` /
   `**Dependencies:**` lines and `← AC` refs, leaving each task's body as a single
   `<!-- enrich: I-N -->` slot carrying THAT TASK'S OWN id. Do not reference another
   methodology's skills; this flow executes its own plans.

   **The id in the marker is not decoration — it is what makes the next step possible.**
   `document_patch` replaces a fragment that occurs EXACTLY ONCE and refuses one that repeats, so
   a scaffold whose eleven tasks all say `<!-- enrich -->` can have its first task filled and
   not one of the other ten. This skill used to say exactly that, having copied the pattern
   from `sdlc-spec` without the property that makes it work: a brief there is one line of
   prose about its own section, unique by construction. Uniqueness was doing the work and the
   copy kept the shape and dropped it.
3. **Fill each task** one at a time (technical AC + Contract + any declared checks), in dependency
   order, with `document_patch("<initiative>/plan.md", find: "<!-- enrich: I-N -->", replace: "<the
   task's complete body>")` — the marker line is the `find`, and the task id is what makes it
   unique. Never rewrite the whole file. Continue until zero `<!-- enrich` markers remain.
4. **Close** with a whole-deliverable gate and a Spec-coverage traceability table mapping every spec
   AC to its task(s). The gate is whatever checks the FINISHED deliverable as a whole, rather than
   task by task — for a code project that is the test/build/lint suite; for a report it is the
   assembled document checked against the full acceptance set; for a configuration it is the
   end-to-end run. State the gate this deliverable actually has. Do not name a test suite, a build
   or a linter unless you confirmed in step 1 that the deliverable has them.
5. **Self-check** against the completion test: could a human execute every phase to the working
   solution? Does each task have a technical AC traced to a business AC, a contract, and (where a
   deterministic check is possible) an executable check? No implementation code or final deliverable
   content leaked? Is the granularity human-sensible?

## When you are done

You wrote this yourself, so there is no report to check and no worker to send back. Two things
happen instead.

**Check your own work against the completion test.** Could a competent engineer, reading only
this plan, execute every phase in order and arrive at the working solution without you present?
Walk the traceability table: every spec AC maps to at least one task, every task has a technical
AC, a contract, and either a declared check or a plain statement of how the claim is established
instead. Zero `<!-- enrich` markers remain.

**Then hand it to the person for approval.** Fetch it with
`document_present("<initiative>/plan.md")` and present what it returns before you ask — they are
approving this document, not your account of it. Say what the plan builds, in what order, and what
is true at the end of each phase. `plan.md` is a gate: `sdlc-execute` does not start until it is
approved, and the approval is recorded on the document. They may delegate the decision, and
that delegation stands until they change it — it is an ordinary answer, not an exception you
re-check. The recording is yours to do either way.

**How to tell that they agreed, and what to write, is `zz-platform`'s rule, not this
skill's** — judge it rather than matching phrases, record it under their name in the same
turn, and never send a decision back to somebody who already made it. It is written once,
there, because it holds for every flow.

The next thing that runs is `sdlc-plan-audit` on this document, dispatched, up to three rounds.
It reads what you wrote with the eleven prose failure modes AND the plan's own contract in hand:
every spec AC traced to a task, the five contract bullets, check paths and argv-safe run commands,
dependency order, the full-suite gate. Write the plan expecting that.

## Coming back from the audit, or from execution

`sdlc-plan-audit` returns findings, and `sdlc-execute` sends a plan back when a task's contract
turns out to be wrong against the real code. Either way the document on disk is the one the
person approved, and **`document_write` and `document_patch` are refused on it outright** — `plan.md`
carries `gate: true`, and writing over an approved document would leave the approver's name
standing on bytes they never read.

**Revise it with `document_revise`.** One call does all of it:

```
document_revise(
  path: "<initiative>/plan.md",
  content: "<the full revised plan>",
  source_content: "<the audit finding or the execution report, verbatim>",
  source_title: "<what sent it back>")
```

The platform bumps the version, returns the document to draft, clears the stale approval and
keeps the approved copy in `_versions/`. Mark every task `unchanged`, `changed` or `new`, and
add the tasks that undo anything an earlier round built that no longer belongs. Do not write a
second plan; execution needs one document.

Then show it again with `document_present("<initiative>/plan.md")`, say what changed and why, and
get the approval recorded afresh — the gate is on the version they read, not on the one they
read last time.
