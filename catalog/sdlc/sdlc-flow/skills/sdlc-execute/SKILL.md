---
name: sdlc-execute
version: 1.2
description: Build what the approved plan describes — one subagent per task, in plan order, each making its task's contract true and its plan-authored checks pass. Main agent orchestrates and stays accountable for the sequence; the work itself is dispatched.
when_to_use: "plan.md exists, has been audited, and the person has approved it. Implements its tasks. If there is no plan on disk, this is not the stage — the plan is what makes each task dispatchable. Local runtimes only (Claude Code)."
---

# sdlc-execute

<!-- Design note: nothing here materialises a task's checks, scores them, or commits for
     you. The caller does all three — freeze every check up front, activate only the one
     whose task is about to be dispatched, run them after each task, and let the person
     decide whether the work is committed. Three rules below are load-bearing because all
     three have cost real work: a check that could not RUN is not a check that FAILED, a
     task that fails the same way twice usually means the plan is wrong rather than the
     worker, and a future task's check sitting in the gate's own discovery path before that
     task exists is a defect the gate itself will report against the wrong task. -->

**Read `sdlc-method` first.** This stage is unusual in the same way `sdlc-explore` is: the work
is dispatched, the orchestration is not.

**You keep the sequence and the accountability.** You dispatch one subagent per task, in plan
order, and you are the one who says what changed. Two reasons this is not fully delegated: it
touches the repository, and a plan is written before anyone knows what they do not know, so
divergence from it is expected and someone has to notice.

## Before the first task

**1. The plan is approved.** `plan.md` is a gate. Check its frontmatter, not your memory of the
conversation — an approval that only happened in a conversation did not happen. If it is not
approved, stop and say so.

**2. You own the branch.** Cut and check out a task branch **before** you start. Nothing here
creates a branch or a worktree; work lands in the checkout you are in. On a non-git target,
edits happen in place with no commit, and that is fine — say so rather than inventing a repo.

**3. Freeze every check, then activate them one at a time.** For every task that declares a
`Check:` path with a fenced source block, freeze its exact bytes now — a verbatim copy kept
**outside wherever the target's own checks get discovered** (a target with a gate that scans a
`checks/` directory, a CI config, a test runner — whatever finds and runs them there), alongside
the hash you will verify it against later. Outside the checkout entirely is simplest, and safest
where you are not certain what the target discovers. You are the only thing standing between a
check and a worker that finds it inconvenient — nothing re-creates a weakened check from the
plan afterwards.

Freeze them all up front, before dispatching anything. Then, immediately before dispatching a
task, **activate only that task's own check**: write its frozen bytes, unchanged, to its
declared path. No other task's check is written yet — a check placed where checks get
discovered before its own task exists is a check discovery will surface against the wrong task,
and a check some other automated rule may demand be registered before anyone has been told to
register it.

After the task finishes, and again before you dispatch the next one, compare the active file's
bytes to its frozen copy. The worker may register the active check in the gate; it may not
alter it, and a hash mismatch is the task failing regardless of what else it reports. A check
that appears after the worker has been told what "done" means is a check the worker has already
routed around — activating on time is exactly as load-bearing as activating only the one file.

## Dispatching a task

One subagent per task, in plan order. Later tasks build on earlier ones, so **wait for each to
finish before starting the next** — and re-read what it actually changed, not what it reported.

Hand the worker:

- **The task, verbatim from the plan** — its contract, its technical acceptance criterion, its
  dependencies, its output declaration. Not a summary. The contract is the whole brief.
- **Its task id** (`I-N`), so its report can be matched to the task it was given.
- **The constraints below**, which are contractual rather than advisory.

### What the worker is told

```text
You MUST satisfy the task's Contract and make its plan-authored Acceptance checks pass.
You MAY choose, write, rename and structure implementation code as needed — implement freely
  against the contract rather than copying anything.
The plan-authored Acceptance checks are ALREADY present at their declared paths. Implement
  against them as they are; you MUST NOT create, move, edit, overwrite, delete, weaken or skip
  them. Their presence is expected — never treat it as a collision or a reason to stop.
If a contract defect blocks you — including a check that contradicts the contract or cannot pass
  despite a correct implementation — report it as failed, naming the unmet clause or the faulty
  check. Do not silently work around it, and do not weaken a check to force a pass.
Reconciliation means satisfying the contract against the actual source, not matching the plan's
  symbols to what you find.
```

### A check that could not RUN is not a check that FAILED

This one has repeatedly reported correct, complete work as broken, so it is worth stating to
every worker and holding yourself to when you read the result.

A check that dies on a denied port bind, a missing binary, a sandbox restriction or a bare
timeout did not fail — it did not run. Judge the task on its contract and on the checks that
actually executed, and **name the unverifiable ones** so someone can run them elsewhere.
Conflating "unverifiable here" with "failed" throws away finished work.

## After each task

**Run the task's own checks yourself.** The worker's report is a claim; the check is the fact.

**Then run the full-suite gate** — the commands the plan names under `## Full-suite gate`. Per-task
checks prove the task did its own job. They cannot prove it left the rest of the project working,
and **every check green with the suite red is the actual failure mode** of a plan executed task by
task. Run the gate after every task, not only after the last one.

If the gate goes red, stop. Do not start the next task on a broken tree — the next worker will
inherit the breakage and spend its turn on someone else's bug.

## When a task fails

**Re-dispatch only what failed.** A fresh worker scoped to that one task, told what the previous
attempt tried and why it did not hold. Never re-run the whole list: it redoes every task that
already succeeded, and on a sequential plan it can undo them.

**A failure may be the plan's, not the worker's.** The plan was written before anyone knew what
they did not know. If two workers fail the same task the same way, the contract is probably wrong
— say so, and take it back to `sdlc-plan` rather than trying a third time.

## When every task is done

**Report what changed, from the tree rather than from the reports.** `git diff --name-only`
against where you started, not the union of what the workers said they did.

Say plainly:

- which tasks are done, which are not, and which are unverifiable here
- what the full-suite gate says right now
- anything a worker flagged as a contract defect

**Do not declare success on a partial run.** A shortfall is not a failure — a plan diverging from
reality is expected — but it is also not "done". Name the outstanding task ids.

**Committing is the person's call.** Ask. Then `sdlc-review` runs on what was built.

## Pitfalls

❌ **Starting before the plan is approved.** The gate is on the document, not in the chat.

❌ **Dispatching all tasks at once.** They are sequential; later ones build on earlier ones.

❌ **Activating a check after dispatching its task, or activating more than the one whose turn it
is.** Freeze every check first; activate one at a time, immediately before its own task, never
before.

❌ **Reading the worker's report instead of running the check.** The report is a claim.

❌ **Skipping the full-suite gate between tasks.** This is the failure mode, not an optimisation.

❌ **Re-dispatching the whole plan after one failure.** Scope it to what failed.

❌ **Reporting a task failed because its check could not run.** See above.
