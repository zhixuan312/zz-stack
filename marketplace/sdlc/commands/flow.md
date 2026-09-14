---
name: "flow"
description: "Run the sdlc-flow flow for your team."
when_to_use: "The person typed /sdlc:flow. This is a command, not an auto-matched skill."
version: "0.2.0"
disable-model-invocation: true
---

# sdlc-flow

The entry point. Starting an initiative, resuming one, or deciding what happens next all begin
here. (You reached this as `/sdlc:flow` in Claude Code, or as the `sdlc-flow` skill in
Codex. Same text; the door differs.)

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
          └ agreed by the person before audit runs
```

Not a ratchet. An audit that finds the spec rests on an unsettled decision sends you back into
`sdlc-spec`, and that is the method working.

| # | Stage | Produces | Runs in |
|---|---|---|---|
| 1 | `sdlc-explore` | `explore.md` | **main agent** — fans out, waits, synthesises |
| 2 | `sdlc-spec` | `spec.md` | **main agent** → the person agrees |
| 3 | `sdlc-spec-audit` | findings on `spec.md` | subagent per round, sequential, max 3 |
| 4 | `sdlc-plan` | `plan.md` | **main agent** → the person approves |
| 5 | `sdlc-plan-audit` | findings on `plan.md` | subagent per round, sequential, max 3 |
| 6 | `sdlc-execute` | the change | subagent per plan item |
| 7 | `sdlc-review` | code review | subagents |

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
your own guess.

### 3 & 5 · Two audits, each sequential, each stopping at three

`sdlc-spec-audit` runs on the spec before anyone plans from it. `sdlc-plan-audit` runs on the
plan before anyone builds from it. They are separate skills because a spec and a plan fail in
different ways — one checks components, traceability and the deliverable contract; the other
checks task contracts, check paths, dependency order and the full-suite gate. A single generic
auditor finds the generic half of both and misses what actually breaks.

**One round at a time, each reading what the last one produced** — parallel audit rounds
re-find the same things. **Three rounds maximum per document.** A fourth means the document
has a problem no audit will fix: take it back to the stage that wrote it and say what the
audits kept finding.

### 4 · Plan is yours, and then it is approved

Order, risk and scope are the person's judgement. Dispatch it and you get a plausible ordering
nobody chose.

**Ask for approval on `plan.md` before executing.** How they answer is entirely theirs —
a yes, a yes with a change, or a standing "you do not need to ask me about these". Delegating
it to you is an ordinary answer, not a loophole.

The gate is not a hurdle in front of them; it is a line YOU owe the document. Whatever they
decide, you write it down — under their name, in the same turn — because the platform's
record of who approved what is what an audit later reads, and they should never have to think
about that.

### 6 · Execute

One subagent per plan item. You keep the sequence and report what changed.

### 7 · Review is dispatched

A code review of what was built, by workers who did not build it. That is the whole reason it
is not yours.

### After review · the close is an act, not a stage

`sdlc-review` is the flow's last STAGE. There is no stage after it — you were present for
the whole initiative, and closing it is yours to do directly, the way `zz-backbone` describes
every close: one `initiative_close()` call, never a block's own close. Say the one thing you know —
`initiative_close(initiative, "finished", accepted_by: "<their name>")` when somebody accepted it,
`initiative_close(initiative, "finished", no_signoff_reason: "<one line>")` when nobody signed off, or
`initiative_close(initiative, "abandoned")` when the work stopped short — and the platform derives
`outcome`, writes it into `spec.md`, which this flow declares as its closing document, and
appends the team's ledger row. An initiative you do not close this way stays open forever
and never reaches the ledger.

One step does follow, and it is the platform's rather than this flow's: `initiative_status`
returns `action: handover` until `handover.md` exists and is approved, and `zz-knowledge` is
what writes it, cold and afterwards. So the close ends DELIVERY, not the cycle — report the
initiative closed and say the handover is what remains.

## The journal is the platform's, not a file

`sdlc-recall` does not read or write anything local. It uses the ZZ knowledge base through
zz-core, which arrives with the required `zz` plugin:

| | Tool | |
|---|---|---|
| `sdlc-recall` | `knowledge_search(query, type, initiative, flow, limit)` | Team-scoped, returns results with provenance — status, approvals, outcome, path |

Writing to that journal is not a stage of this flow at all. Once you close, `zz-knowledge`
reads the closed initiative — cold, after delivery is over — and mints what generalises with
`knowledge_add(title, type, body, evidence, tags, scope)`. `scope` decides the shelf:
`platform` for a fact that holds for anyone touching a registry entry, `team` for one that is
only true of this team.

Two consequences worth stating, because both are easy to get wrong:

**What one person learns, the team recalls.** A journal on a laptop is a journal one person
has. This is the whole reason recall is not local — the next initiative that starts with
`sdlc-explore` searches what every earlier one recorded, including work that was not yours.

**A node with no evidence is refused, and that is correct.** `knowledge_add` will not mint an
entry that cannot point at the initiative it came from — without it the entry is an opinion.

Neither `sdlc-recall` nor `zz-knowledge` is this flow's to reimplement. Storage, indexing and
retrieval are the platform's job and it is already done; rebuilding any of it produces a
second store nobody searches.

## The tools

No order, no gate, no initiative required. They install with the flow and are reached the same
way the door is — **a command in Claude Code, a skill in Codex** — because a person invokes
them on purpose rather than arriving at them through a sequence.

| Tool | Claude Code | Use it to |
|---|---|---|
| `sdlc-deck` | `/sdlc:deck` | Turn something already written into a slide deck that makes an argument |
| `sdlc-tldr` | `/sdlc:tldr` | Compress a long document or thread to what someone actually needs |
| `sdlc-breakout` | `/sdlc:breakout` | Widen a thin option space before deciding — `sdlc-spec` leans on this |

Installing this plugin gives a Claude Code user **four commands**: `/sdlc:flow` and these
three.

Reach for one whenever it helps, inside a stage or outside the flow entirely.

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
