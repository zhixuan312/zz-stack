---
name: "flow"
description: "Run the SDLC Agent flow for your team."
when_to_use: "The person typed /sdlc:flow. This is a command, not an auto-matched skill."
version: "0.81.0"
disable-model-invocation: true
---

# sdlc-flow

The entry point. Starting an initiative, resuming one, or deciding what happens next all begin
here. (Which door you came through — a command, a menu entry, a direct load — depends on the
runtime; this file is the same either way.)

This file decides **which** stage. `sdlc-method` says **how** any stage is executed — who runs
it, what a worker is handed, how to judge what comes back. **Load `sdlc-method` before running
anything.**

## First, ask the platform where the initiative stands

`initiative_status(<initiative>)` before anything else, and say what it returned before acting
on it. The stage a person asks for and the stage the initiative is ready for are different
questions, and the document store is the one that knows the answer.

If there is no initiative yet, create it. That is the first act of the flow, not a stage.

## The sequence

```
explore → spec → audit → plan → audit → execute → review → close (an act, not a stage)
          └ agreed       └ approved               └ approved, and it
            before its     before its               closes the flow
            audit          audit
```

Not a ratchet. An audit that finds the spec rests on an unsettled decision sends you back into
`sdlc-spec`, and that is the method working. And plan → audit → execute is a loop, one phase
per turn: the spec's `## Phase outline` names the phases, `sdlc-plan` writes one, it is audited
and approved, `sdlc-execute` builds it and appends `### As built`, and the next phase is planned
from that — until the outline's last phase is built, and review runs. A phase that disproves a
spec core statement goes back to `sdlc-spec` (see `sdlc-method`).

| # | Stage | Produces | Runs in |
|---|---|---|---|
| 1 | `sdlc-explore` | `explore.md` | **main agent** — fans out, waits, synthesises |
| 2 | `sdlc-spec` | `spec.md` | **main agent** → the person agrees |
| 3 | `sdlc-spec-audit` | a SOURCE supporting `spec.md` | subagent per round, sequential, rounds routed by evidence |
| 4 | `sdlc-plan` | `plan.md` | **main agent** → the person approves |
| 5 | `sdlc-plan-audit` | a SOURCE supporting `plan.md` | subagent per round, sequential, rounds routed by evidence |
| 6 | `sdlc-execute` | the change itself, and the phase's `### As built` in `plan.md` | subagent per plan item |
| 7 | `sdlc-review` | `review.md` — and it closes the initiative — plus a SOURCE per sweep round | **main agent** for the evidence; subagent per round, sequential, rounds routed by evidence |

Four documents, and the audits produce none of them. An audit report is a SOURCE: it is the
material that makes the next version of somebody else's document necessary, and the platform
refuses that revision until the source is cited — so a round is on the record, findable from
the document it changed, without being a document of its own that says the same thing twice.
`review.md` is gated, because shipping is a
decision a person owns; it is also this flow's **closing** document, so nothing closes until it
is written and approved.

### 1 · Explore fans out, waits, then synthesises

The person arrives with an unstructured brain dump. Explore turns it into what is *true*.

**You run explore. The workers run underneath you.** Read the dump, decide what has to be
established, then dispatch many subagents **in parallel** — one question each:

| Fan-out | Each worker |
|---|---|
| `sdlc-recall` × N | Searches the ZZ knowledge base for what earlier work already settled |
| `sdlc-investigate` × N | Digs one specific question in this system until it has an answer |
| `sdlc-research` × N | Establishes what is true outside it — prior art, a standard, another team's contract |

Then **wait for all of them to return**, and do the synthesis yourself. Many answers are not a
picture; making them one is judgement, and it is the part of this stage that is yours. Write
the result to `explore.md`.

A single worker told to "investigate the codebase" returns a survey. Ten told to answer one
question each return ten answers. If a prompt you are writing says "and also", that is two
workers.

### 2 · Spec is brainstorm and spec, and it is yours

One skill, because it is one conversation: the options are opened and closed with the person
in the room, and the agreement is written the moment they settle. A handoff between those
halves loses exactly what was agreed.

**The person agrees before anything proceeds.** Auditing a document nobody agreed to audits
your own guess. The spec also carries the `## Phase outline` the plan will grow from and the
`## Core statements` the design rests on, each tested by a spike run while writing it — the
approval is refused without them.

### 3 & 5 · Two audits, each sequential, each routed by evidence

`sdlc-spec-audit` runs on the spec before anyone plans from it. `sdlc-plan-audit` runs on the
plan before anyone builds from it. They are separate skills because a spec and a plan fail in
different ways — one checks components, traceability and the deliverable contract; the other
checks task contracts, check paths, dependency order and the full-suite gate. A single generic
auditor finds the generic half of both and misses what actually breaks.

**One round at a time, each reading what the last one produced** — parallel audit rounds
re-find the same things. A round is a source naming its stage —
`source_add(..., supports: ["spec.md"], stage: "sdlc-spec-audit")` — and material without the
stage is not a round, however it is titled.

**How many rounds is the platform's answer, not a count you keep.** `initiative_status` — and
the `Next move:` line every document call ends with — computes it from the record:

| The record | Next move |
|---|---|
| no round yet | round 1 is owed |
| the document was revised after the last round read it | the next round checks the revision |
| the last round read the current version | the audit is settled; move on |
| the last round reopens something the person agreed (the platform asks `changes_commitment` the moment the round lands) | the stakeholder decides |
| three rounds are spent and the latest revision was never audited | the stakeholder decides |

Three is a resource limit, never a pass: a spent budget does not mean the document is fine, so
the person decides whether it proceeds unaudited or goes back to the stage that wrote it. Their
decision is recorded as material supporting the document — `source_add` with no stage — and
that is what lets the flow move on. If the audits keep finding the same thing, take the document
back to its stage and say what they kept finding.

### 4 · Plan is yours, and then it is approved

Order, risk and scope are the person's judgement. Dispatch it and you get a plausible ordering
nobody chose.

**Ask for approval on `plan.md` before the plan audit runs**, the same way the spec is agreed
before its audit — an audit's findings are the input to the plan's next version, and a version the person has
not agreed to yet is not a thing to audit. Nothing in the platform refuses it — `source_add`
is ungated and immutable and may be called at any time, from any harness, including while
the work is in flight — so this ordering is yours to keep, not a guardrail that keeps it
for you. How they answer is entirely theirs —
a yes, a yes with a change, or a standing "you do not need to ask me about these". Delegating
it to you is an ordinary answer, not a loophole.

The gate is not a hurdle in front of them; it is a line YOU owe the document. Whatever they
decide, you write it down — under their name, in the same turn — because the platform's
record of who approved what is what an audit later reads, and they should never have to think
about that.

### 6 · Execute

One phase per run, one subagent per plan item. You keep the sequence, report what changed, and
append the phase's `### As built` before the next phase is planned.

### 7 · Review: acceptance evidence first, then a bounded sweep

First, `review.md`'s acceptance evidence: one row per criterion the spec and the plan declare,
established by running and quoting what ran — that is yours. Then the defect sweep, one
dispatched round at a time, by a reviewer who did not build it; each round is a source whose
ledger `initiative_status` reads to answer `fix`, `run_experiment`, `decide` or settled. You never
choose how many rounds, and a later round never reads wider than the fix it checks.

### After review · the close is an act, not a stage

`sdlc-review` is the flow's last STAGE. There is no stage after it — you were present for
the whole initiative, and closing it is yours to do directly, the way `zz-platform` describes
every close: one `initiative_close()` call. Say the one thing you know —
`initiative_close(initiative, "finished")` when it is done, which records YOU as the acceptor
because closing it is saying so; `accepted_by: "<their name>"` when somebody else is the one who
said it; `no_signoff_reason: "<one line>"` when nobody accepted it at all; or
`initiative_close(initiative, "abandoned")` when the work stopped short, at whatever stage it
stopped — the outcome goes on the furthest document it reached. The platform derives
`outcome`, writes it into `review.md`, which this flow declares as its closing document, and
appends the team's ledger row. An initiative you do not close this way stays open forever
and never reaches the ledger.

**`review.md` must exist and be approved first.** It is the closing document AND it carries a
gate, so the platform refuses the close until `document_approve("<initiative>/review.md")` is
recorded, so an initiative cannot close on an agreement written before any code existed. Ask
for the approval the way stage 4 asks for the
plan's, and write it down in the same turn.

**The close is the end.** `initiative_status` reads `closed` from the moment the outcome is
recorded, whatever that outcome is, and nothing further is owed — closing part-way through is a
normal way for work to end, not a lesser one.

One step MAY follow, and it belongs to the platform rather than to this flow: `zz-handover`
writes `handover.md`, cold and afterwards, minting whatever generalises. Worth doing when the
cycle taught something; not owed, and not a condition of being closed. The close satisfies that
document's prerequisite, so it can be written even by an initiative that stopped before
`review.md`.

## The journal is the platform's, not a file

`sdlc-recall` does not read or write anything local. It uses the ZZ knowledge base through
zz-core, which arrives with the required `zz-core` plugin:

| | Tool | |
|---|---|---|
| `sdlc-recall` | `knowledge_search(query, type, initiative, flow, limit)` | Team-scoped, returns results with provenance — status, approvals, outcome, path |

Writing to that journal is not a stage of this flow at all. Once you close, `zz-handover`
reads the closed initiative — cold, after delivery is over — and mints what generalises with
`knowledge_add`. Five of its arguments are required and have no default: `title`, `type`, `body`,
`evidence` and `scope`. It takes others besides; the tool's own description is where they are
listed, and this line does not keep a second copy of a signature that belongs to another door.
`scope` decides the shelf: `platform` for a fact that holds for anyone touching a registry entry,
`team` for one that is only true of this team.

Two consequences worth stating, because both are easy to get wrong:

**What one person learns, the team recalls.** A journal on a laptop is a journal one person
has. This is the whole reason recall is not local — the next initiative that starts with
`sdlc-explore` searches what every earlier one recorded, including work that was not yours.

**A node with no evidence is refused, and that is correct.** `knowledge_add` will not mint an
entry that cannot point at the initiative it came from — without it the entry is an opinion.

Neither `sdlc-recall` nor `zz-handover` is this flow's to reimplement. Storage, indexing and
retrieval are the platform's job and it is already done; rebuilding any of it produces a
second store nobody searches.

## The tools

Three standalone tools ship in `zz-core`, not here: `/zz-core:deck`, `/zz-core:tldr` and
`/zz-core:breakout`. None is about software delivery — turning a document
into a deck, compressing one, and running a bounded expert dialogue are operations on the
platform's own nouns, useful with no flow installed at all — so they belong to the baseline
everybody already has rather than to this flow.

Reach for one whenever it helps, inside a stage or outside the flow entirely. Installing this
plugin adds **one command**, `/sdlc:flow`, wherever the runtime exposes commands; the other
three arrive with the baseline.

## Pitfalls

**Starting at a stage instead of here.** The status check is what catches an initiative someone
else already moved.

**Explore dispatching one subagent.** The fan-out is the stage. One worker asked to establish
everything returns a survey of nothing.

**Synthesising before every worker has returned.** The picture changes with the last answer.

**Dispatching spec or plan.** Those are where a person decides. Audit, review, execute and
explore's fan-out are the four that leave you.

**Treating the close as a stage to dispatch, or skipping it because no stage names it
anymore.** It is an act you perform directly once review is done — you were the only party
who saw the whole thing, and an initiative nobody closes never reaches the ledger.

**Reaching for a generic audit skill.** There is no such thing here: pick `sdlc-spec-audit` or
`sdlc-plan-audit` by which document is on the table.

**Auditing before the person agreed, or executing before they approved.** Both audit your own
guess rather than theirs.

**Running audit rounds in parallel.** They re-find the same things. Each round reads what the
last one produced.

**Routing to a stage that is not installed.** Say so plainly and do the work in the
conversation. Never improvise a document into the initiative store as though a stage produced
it — it is indistinguishable from one that a stage did produce, until someone builds on it.

## Skill contract

**Outcome:** an initiative that moved through explore, spec, audit, plan, audit, execute and
review in the order its recorded state actually permitted, and that ends closed with an outcome
on the record — or a plainly reported reason it stopped where it did. This skill writes no
document of its own; routing is its whole product.

**Required evidence:** the `initiative_status` return, said out loud before anything is routed on
it; which of the four documents exist; and, at each gate, the approval recorded on the document
rather than a recollection of the conversation. An agreement that only happened in a chat turn is
not evidence that the next stage may run.

**Allowed unknowns:** what any stage will conclude; how many audit rounds a document will need;
whether the work ends `finished` or `abandoned`. None of these has to be settled to route the next
step, and guessing at them is how a stage gets skipped.

**Work roles:** the person decides at the three gates — agreement on `spec.md`, approval of
`plan.md`, approval of `review.md` — and nothing substitutes for them there. Choosing the stage
and reporting where the work stands are this agent's own. The platform asks one bounded question
itself and routes on the answer; you ask none, and it never picks the stage.

**Checkpoints:**

| Where | Question ID | Asked about |
|---|---|---|
| After an audit round lands — asked by the platform itself in `source_add`, reading returned in its result | `changes_commitment` | whether the round reopens something the person already agreed — `yes` on a round that read the current version makes the next move `decide`, waiting on the stakeholder, until they record a decision or the document is revised |

**Action and exit paths:** the action is entering the next stage, or re-entering an earlier one
when an audit sends a document back — the sequence is not a ratchet, and a return is the method
working. Two exits: `initiative_close` with `finished` or `abandoned` once `review.md` exists and
is approved, and a report naming where the work stopped and why when it cannot close. `zz-handover`
may follow the close; it belongs to the platform, not to this flow.

**Degraded behaviour:** a stage that is not installed is named plainly and its work is done in the
conversation — never improvised into the initiative store as though a stage produced it, because
that is indistinguishable from the real thing until somebody builds on it. An initiative opened
with no flow is a legitimate choice, and `next_move: null` is the honest answer rather than an
invented stage. Closing part-way through is a normal way for work to end, not a lesser one.
