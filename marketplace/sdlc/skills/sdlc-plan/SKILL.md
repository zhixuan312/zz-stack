---
name: sdlc-plan
version: 1.14
description: Turn an approved spec into a contract-first, human-executable plan at <initiative>/plan.md — build phases, tasks with contracts and technical acceptance criteria traced to the spec's business ACs, and a full-suite gate. Main agent only; never dispatched.
when_to_use: "The spec is written, agreed and audited, and the work needs an order to be built in. Produces plan.md, which is a gate: nothing executes until a person approves it. Requires a runtime that can dispatch subagents and reach the working tree directly."
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

**Exactly, because this is the one section of `plan.md` the platform itself requires.**
`flow.json` declares `Full-suite gate` and nothing else for this document. Everything else the
plan carries is required by something weaker, and the two are worth keeping apart:

- **The phase and task format is checked, by `sdlc-plan-audit`.** Level-2 phase headings,
  `### Task I-N:` with its arabic digit, and the one-line `**Output:**` / `**Dependencies:**`
  under each are point 5 of that audit's contract, and a break comes back as a finding.
- **`Goal`, `Architecture`, `Tech Stack`, `Ground truth at HEAD` and `File Structure` are this
  skill's convention and nothing checks them.** Not the platform, which does not declare them,
  and not the audit, whose eleven points do not mention them. Write them because a reader needs
  them, and never tell anyone they are enforced — a plan asserting an enforcement nobody wrote is
  the same defect the audit exists to find, one document earlier.

Being declared has a second consequence worth knowing before you write. `plan.md` is gated, so the
section is checked when the plan is offered as approved rather than while it is a draft — but the
platform normalizes headings on every write regardless. A `##` heading of yours that says
everything `Full-suite gate` says is renamed to it, and the reply to that call is the only place
you are ever told. Keep that line and hand it to `sdlc-plan-audit` along with the version it
should read; nothing in the stored plan records that a heading was ever worded differently.

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
   not one of the other ten. Uniqueness is what does the work, which is why each marker carries
   its own task id.
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

The next thing that runs is `sdlc-plan-audit` on this document, dispatched, one round at a time, as many as the record says are owed.
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
  sources: ["sources/<the audit round you are answering>.md"])
```

**THE AUDIT ROUND IS ALREADY A SOURCE.** `sdlc-plan-audit` registered it with `source_add`,
supporting `plan.md` — so cite that file rather than pasting its findings back, which would put
one round on the record twice. The platform refuses this revision until you do: a source that
supports `plan.md` and is newer than the version you are replacing is, by its own declaration,
what this revision answers. `document_list` on the initiative shows the sources.

`source_content` is still right for a cause that exists nowhere else — an execution report, or
something a person said:

```
document_revise(
  path: "<initiative>/plan.md",
  content: "<the full revised plan>",
  source_content: "<the execution report or the person's own words, verbatim>",
  source_title: "<what sent it back>")
```

The platform bumps the version, returns the document to draft, clears the stale approval and
keeps the approved copy in `_versions/`. Mark every task `unchanged`, `changed` or `new`, and
add the tasks that undo anything an earlier round built that no longer belongs. Do not write a
second plan; execution needs one document.

Then show it again with `document_present("<initiative>/plan.md")`, say what changed and why, and
get the approval recorded afresh — the gate is on the version they read, not on the one they
read last time.

## Skill contract

**Outcome:** `plan.md` in the initiative — phases each stating what works at the end, `### Task
I-N` headings numbered straight through with a one-line `**Output:**` and `**Dependencies:**`, a
five-bullet contract and a technical acceptance criterion traced `← AC-N.N`, plan-authored checks
wherever the claim is machine-decidable, a `## Full-suite gate` section and a spec-coverage
traceability table — presented to the person and carrying their recorded approval.

**Required evidence:** the approved spec. Ground truth at HEAD: every path, figure, symbol or
source the spec references, confirmed to exist and to say what the spec claims, with each
discrepancy written into the plan header as a reconciliation note. And whether the target actually
has a build, typecheck, test or lint entry point — read from its manifest, never assumed.

**Allowed unknowns:** how a task will be implemented. A capable executor implements freely against
the contract, so the plan carries no implementation code and no deliverable content; the only code
you write is a declared check's source. What is never unknown is the order: if B needs what A
creates, A comes first, and a dependency you have not resolved is a task you have not yet written.

**Work roles:** this stage is never dispatched. Order, risk and scope are the person's judgement,
and a dispatched plan is a plausible ordering nobody chose; the person approves the document
before anything is built from it. Each technical AC names which role proves it — a deterministic
command, a delegated analytical review, or a named human whose authority the claim requires. The
`semantic-assessment` role answers the bounded questions below by question ID from the fixed set
below. Each ID is a registered family: ask it with `assess(family, subject, context)` on the core
door, which records the answer and the model behind it, and is never a substitute for the human method: a plausible
opinion is not accountability.

**Checkpoints:**

| Where | Question ID | Asked about |
|---|---|---|
| Step 4, per business AC in the spec | `requirement_coverage` | whether it reaches at least one task, and whether that task's technical AC is the engineering translation of it rather than a restatement |
| Per technical AC, choosing how it is proved | `needs_verification` | whether the claim is machine-decidable, needs delegated analysis, or needs authority — decided by what the claim requires, never by what is convenient |
| On a return from audit or from execution | `changes_commitment` | whether the finding changes what was approved, so the revision cites the source that caused it and marks every task `unchanged`, `changed` or `new` |

**Action and exit paths:** the action is ground truth, state the production method in prose,
scaffold in one write with a uniquely-id'd marker per task, fill one task at a time until no
marker remains, close with the gate and the traceability table, present, ask. The forward exit is
`sdlc-plan-audit`, once the approval is recorded. The return exit is `document_revise` citing the
source that sent it back — `document_write` and `document_patch` are refused on an approved plan,
because writing over one leaves the approver's name standing on bytes they never read. Writing a
second plan is not an exit at all: execution needs one document.

**Degraded behaviour:** the target genuinely has no suite, so the `## Full-suite gate` section
still exists and says so in one line, naming what stands in for it — the section is never omitted,
because a plan that cannot state its gate has not decided how anyone will know it still works. A
source the spec names that does not exist becomes a reconciliation note, not a contract written
around the gap. A task whose acceptance criterion no method can establish is not ready to be
planned: say what is missing rather than writing it anyway.
