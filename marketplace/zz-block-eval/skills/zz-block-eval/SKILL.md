---
name: zz-block-eval
version: 0.1
description: The front door to block evaluation. Four stages — surface, conform, defects, handover — over one building block's MCP tools. Judges the block, never the skills written about it.
when_to_use: "A block has been used enough to have a record, a block team asks how they are doing, or a defect keeps recurring and nobody has written it up. Platform capability — a delivery agent never runs this."
---

# zz-block-eval

Load `zz-backbone` first, as with every flow on this platform.

## What this is NOT

**It does not evaluate any skill.** Not the block team's own skills, not ours about their
block. Those are `block_usage` skills and they are measured in `zz-skill-eval`, against their own
rubrics, for reach and quality. `zz.skill.kind` is what keeps the two apart, so nothing is
assessed twice and nothing falls between.

This flow is about **the MCP surface itself**: the tools, their schemas, their refusals, and
whether the thing behaves the way its documentation says.

## Why it is separate from zz-skill-eval

Same event log, different question, and — the part that decides it — **a different owner and
a different fix**.

| finding | fix |
|---|---|
| an email block will not validate inside an advanced flow | a defect report to the block team |
| every app-variable write is stringified in transit | a defect report; we work around it meanwhile |
| a filter argument is accepted and ignored | a defect report |
| a skill sends the wrong path shape | we edit our text and bump a version |

The first three are somebody else's to fix and ours to report well. The last is ours and
nobody else's. Put them in one list and neither audience can act on it.

## The four stages

| stage | writes | what it settles |
|---|---|---|
| `zz-block-locate` | — | which block, which INSTANCE, and that it is not a stand-in |
| `zz-block-measure` | — | what it offers, what moved, tool-by-tool usage, conformance |
| `zz-block-report` | `findings.md` **(gate)** | the numbers, the defects, what we ask for |

**Two stages write nothing**, and that is the rule this flow follows: a document exists only
where it carries a judgement, a decision, or an interpretation not already in the data.
Measurement is data — the tools return it, and the report is where it means something.

One gate, and it is `defects.md` — because that document leaves this platform. Anything we
assert about somebody else's system, in writing, to their team, is worth a person's
signature before it goes.

## Where the run lives

    /artifacts/teams/zz-platform/<date>-blockeval-<block>/

One block per run. A note addressed to two teams is a note neither reads.
