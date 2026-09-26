---
name: sdlc-review
version: 1.10
description: Verify what was built before it ships — first the evidence that every accepted criterion holds, established by running, then a bounded defect sweep in rounds the platform routes to a stop. The sweep is dispatched, one round at a time, because a reviewer who did not write the code is the point; the evidence table and the verdict are the main agent's.
when_to_use: "sdlc-execute has finished and the change is about to be shipped, merged or handed over. This is the pre-release gate. The main agent compiles the acceptance evidence and dispatches each sweep round."
---

# sdlc-review

<!-- Design note: review had no platform routing, so rounds, scope and stopping were the main
     agent's judgement; one initiative ran six rounds, each wider than the last, and the defects
     that mattered were found by running the flow end to end, not by reading. The outcome this
     stage owes is evidence that the solution meets what was accepted. The sweep is secondary,
     bounded, and routed by the platform from each round's ledger. -->

Review answers one question first: **does what was built meet what was accepted?** That is
answered by running things and quoting what they printed. Only then does it ask the second: **what
would make this unsafe to ship?** — a bounded sweep by a reader who did not write the code.

Two parts, each with a terminal state:

| Part | Who | Record | Ends when |
|---|---|---|---|
| A. Acceptance evidence | the main agent | the `## Acceptance evidence` table in `review.md` | every declared criterion has a row the approval accepts |
| B. Defect sweep | a dispatched reviewer, one round at a time | one SOURCE per round, supporting `review.md` | `initiative_status` stops routing rounds |

## A. Acceptance evidence — the main axis

`review.md` verifies `spec.md` and `plan.md`: the flow manifest says so, and `document_approve`
holds the approval to it. **One row per acceptance criterion those two declare** — every
`**AC-N.N**` in the spec, and every `### Task I-N` in the plan, whose technical acceptance
criterion is the task's only id. A criterion with no row, or a row naming a criterion nobody
declared, is refused by name.

```markdown
## Acceptance evidence

| AC | Status | Evidence | Note |
|---|---|---|---|
| AC-1.1 | established | check:initiative-open — `initiative_open: ok` | |
| I-4 | established | run:npm run gate -- --quiet — `gate: 412 passed, 0 failed` | |
| AC-3.2 | blocked | probe:catalog-sync — `ECONNREFUSED 10.0.0.4:5432` | host down since 09-24 |
| AC-5.1 | deferred | | the stakeholder moved it to the next release |
```

- **Status** is one of `established`, `not_established`, `blocked`, `deferred`.
- **Evidence** opens with a kind-prefixed locator — `check:<name>`, `run:<id or command>`,
  `probe:<name>`, `test:<path>` — and, for an established row, quotes the **decisive line of
  output** in backticks. Not "the check passed": the line it printed. An established or blocked
  row without a locator, or an established one without a quote, is refused.
- **Deferred** needs the stakeholder's word on the record: `source_add(initiative, title,
  content, supports: ["review.md"])` with no `stage`, naming the criterion's id.

**Establish by running, not by reading.** The plan's checks, the full-suite gate, a probe, a walk
of the flow end to end — run them and quote them. A criterion nothing can run is
`not_established` and says why in its note; that is an honest row, and a reading dressed as
evidence is not.

The platform asks `evidence_relation` of every established row when `review.md` is written or
patched — the criterion as the claim, your evidence as the passage — and caches the answer per
row. At approval:

- a reading of `no` (the evidence does not support the criterion) refuses that row;
- `unclear` refuses it once: sharpen the evidence by quoting the decisive output;
- `unclear` again, on different evidence, goes to the stakeholder — their source naming the row
  accepts it;
- `unavailable` blocks nothing, and the approval says the row rests on the rules alone.

Write `review.md` yourself: `document_read` it first if it exists, then
`document_write(path: "<initiative>/review.md", content)` with the body — `## Acceptance evidence`,
`## Backlog`, `## Verdict`. Then `document_present` it in a separate call, and ask for the approval.

## B. Defect sweep — secondary, bounded

**You did not write this code. That is the entire reason you are the one reviewing it** — a
reviewer re-reading its own reasoning finds it sound. This part is dispatched: one reviewer per
round, sequential, each handed the round number, the scope and the earlier rounds' ledgers.

**Read-only, by discipline. Recording is not fixing.** Change nothing in the material you
review; do not edit, do not fix. A review that fixes what it finds removes the maintainer's
ability to judge the fix and hides the defect rate that tells them whether the change is safe.

### Scope

**Round 1 sweeps the whole change since the plan's base.** Establish the change-set first —
nothing hands you a diff: on a git target run `git diff <base>..HEAD` and `git log`. **Every later
round's scope is ONLY the fix diff and its blast radius** — what the fix touched and what calls
it. A defect you find outside the declared scope is still recorded, with
`"introduced_by_scope": false`, and goes to `review.md`'s `## Backlog`; it never opens another
round unless it is S1 and you reproduced it.

### Impact, a fixed rubric

| Impact | Means |
|---|---|
| S1 | security, data loss, or an authority bypass |
| S2 | a capability on the main path is broken |
| S3 | a wrong result on an edge path |
| S4 | text, docs, naming |

S1 and S2 route the next round; S3 and S4 never do — they are fixed in a batch and the gate
verifies them, without another reading round.

### Evidence, per finding

- `reproduced` — you ran something and it failed; `reproducer` names the check or command.
- `cited` — the defect is visible in quoted material at the locator.
- `inferred` — the failure is reasoned from what you read and nothing showed it. An inferred S1 or
  S2 does not block: the next move is to write the reproducer first, and it blocks only once
  reproduced. **A verification gap is closed by running, not by another reading round.**

### Failure-Mode Taxonomy (10 Categories)

The lenses a sweep reads the change through. Every finding still takes an impact from the rubric
above; the category says where to look, not how much it matters.

1. **Verification gap** — the change alters behaviour and nothing exercises it; name the sibling check you expected.
2. **Cross-reference ripple** — a changed shape, name or format is used somewhere not updated; cite both ends.
3. **Pre-existing versus regression** — a defect the change did not introduce is `introduced_by_scope: false`.
4. **Missing edge case** — empty, missing, timed-out, erroring, zero or negative input on a new path.
5. **Ordering or concurrency** — shared state, a removed lock, a gap between a check and its action.
6. **Resource or cleanup gap** — a handle, lock, transaction or temporary file with no guaranteed release.
7. **Undeclared compatibility break** — a public shape changed and the upgrade notes are silent.
8. **Safety regression** — access control, untrusted input reaching a sink, data exposure.
9. **Efficiency regression** — unbounded work, blocking on a slow step, cheap work made repeated.
10. **Implicit contract** — the change relies on something its contract does not state.

Also read the change against `plan.md`: a task the plan declared and the change does not
implement, or a change that quietly does what no task asked for, is a finding.

### Recording the round

Record the round as a SOURCE — never in `review.md`, which is the main agent's:

```
source_add(initiative: "<initiative>", title: "Review round <n>", content: "<summary, then the ledger>", supports: ["review.md"], stage: "sdlc-review")
```

`content` carries one fenced `json` ledger, and the platform refuses a malformed one by name
before anything is written:

```json
{"round": 2, "scope": {"base": "d9ad12a", "head": "7599bec"},
 "findings": [{"id": "R2-C1", "locator": "launch.ts:162-164", "claim": "a candidate runs code outside the sandbox through core.fsmonitor", "impact": "S1", "evidence": "reproduced", "reproducer": "check:replay-git-fsmonitor", "introduced_by_scope": true}],
 "resolved": [{"id": "R1-C1", "by": "25b4d17", "how": "fixed"}]}
```

- `round` is the next number; ids are round-prefixed (`R2-C1`) so nothing else names them.
- `resolved` lists earlier ids this round verified, with the fixing commit (`fixed`) or the check
  that failed to reproduce an inferred one (`not_reproduced`). An earlier id not listed stays open.
- To change what an earlier finding says — an inferred one you have now reproduced — restate it
  under the same id. A defect you believe is an earlier one whose fix did not hold is the earlier
  id restated, never a new id: a new id the platform reads as a repeat does not block.

Your FINAL text response must be exactly one JSON block — the same ledger — so the main agent can
act on it. You present nothing to the person, and you do not paste a document into what you
return.

### What routes the next round

`initiative_status` reads the ledgers and answers. You never decide how many rounds:

| The rounds so far | `next_move.action` | Who |
|---|---|---|
| none | round 1 is owed — dispatch it over the whole change | the main agent |
| an open S1/S2 that is reproduced or cited | `fix` — fix, then a round over the fix diff only | the main agent |
| only inferred S1/S2 open | `run_experiment` — write the reproducer, then a round over it | the main agent |
| three rounds since the stakeholder last decided, and the latest raised no fewer new shown blockers than the one before | `decide` | the stakeholder |
| nothing blocks | settled — `review.md` is next | the main agent |

The stakeholder's decision is a source supporting `review.md` with no stage. Any such source
renews the three-round budget; one naming a finding's id also accepts that finding as residual.

`document_approve` refuses `review.md` while no round is recorded: the sweep runs at least once.
Only the stakeholder can waive it — a source supporting `review.md` with no stage that says so on
one line ("The review sweep is waived: <why>") — and the approval then names that source.

## Skill contract

**Outcome:** `review.md` carrying one acceptance-evidence row per criterion `spec.md` and
`plan.md` declare, a `## Backlog` naming every open out-of-scope finding, and a verdict, approved;
and the sweep's rounds recorded as sources until `initiative_status` stops routing them. `review.md`
is this flow's closing document; nothing here closes the initiative. Once it closes,
`initiative_status` reports `action: handover` until `handover.md` exists and is approved — say so
when you hand back.

**Required evidence:** per acceptance row, a kind-prefixed locator and the quoted decisive
output. Per round, the change-set established first, then per finding a precise locator, a claim
naming the concrete failure, an impact from the rubric, and evidence of one of three kinds — a
reproducer wherever it says reproduced.

**Allowed unknowns:** whether the maintainer ships. A criterion nothing can run, stated as
`not_established` with the reason. Behaviour of material the change neither touched nor
references: out of scope, and speculation about it is not a finding.

**Work roles:** the main agent compiles the acceptance evidence by running, writes `review.md`,
fixes what a round finds and dispatches the next. The reviewer did not write the code, which is
the entire reason the sweep leaves the main agent; it changes nothing and records its round. The
stakeholder decides at the budget, accepts residuals and defers criteria. The platform asks two
bounded questions itself and routes on the answers; you ask none, and impact stays yours to set.

**Checkpoints:**

| Where | Question ID | Asked about |
|---|---|---|
| Each established acceptance row, when `review.md` is written | `evidence_relation` | whether the quoted output supports the criterion — read at approval: `no` refuses, `unclear` asks for sharper evidence, twice goes to the stakeholder |
| Each new S1/S2 finding, when its round is recorded | `repeats_finding` | whether it repeats an earlier round's finding — `yes` means it does not block, and it does not count as a new blocker when the budget checks whether the review is converging |

**Action and exit paths:** part A — run, quote, write the table, present, ask. Part B — sweep the
declared scope, record the round with `source_add`, return the ledger. The exits are the ones
`initiative_status` names: `fix`, `run_experiment`, `decide`, or settled. The exit that does not
exist is another reading round to close a verification gap, or a round widened past its scope.

**Degraded behaviour:** no change-set available and the target is not a git checkout, so say so
and mark a finding `introduced_by_scope: false` unless the material itself shows the change made
it. The typed service unavailable: every reading is `unavailable`, the approval rests on the
deterministic rules alone and says so. A criterion no method can establish is a
`not_established` row with its reason, never an established one with a paraphrase.
