---
name: zz-block-measure
version: 0.1
description: Stage 2 of block evaluation. Run the three measurements — the surface and what moved, tool-by-tool usage, and conformance against the contract in force. Writes no document; the scripts are the record.
when_to_use: "The subject is settled at locate. Everything the report asserts has to come from here, so nothing is asserted that these three did not measure."
---

# zz-block-measure

**This stage writes no document.** It runs three programs and keeps their output. A document
here would restate what the scripts already produced, and a restatement is a second copy that
goes stale and cannot be queried.

The rule this flow follows: **a document exists only where it carries a judgement, a decision
or an interpretation that is not already in the data.** Measurement is data. The judgement
comes at `zz-block-report`, which is gated because it leaves the platform.

## The three, in order

    eval_block_surface(block: "<name>")    what it offers, what it costs, WHAT MOVED
    eval_block_usage(block: "<name>")      tool by tool, by usage load, whose fault each is
    zz-tool conformance --block <name>     R1-R14 — the one an operator still runs

Keep the output. It is the evidence every later claim rests on, and a defect that cannot be
traced to one of these three has no business in the handover note.

## What each is for

**`eval_block_surface` — and "what moved" is the point.** A skill's "did it change" is a hash of its
body. A block has no body we control, so the equivalent is its tool surface: a renamed or
removed tool breaks every skill and plan that named it, silently — no error until the next
call, and then a refusal that reads like a payload bug. Most blocks publish no version
number, so nothing else catches it.

It also reports the observed schema cost, from real calls rather than from reading a schema.
Every tool's schema sits in the prompt of every conversation that can reach this block,
including the turns that never call it.

**`eval_block_usage` — the unit is the tool, not the block.** A block with a couple of hundred tools cannot be
usefully judged as one thing; a team can fix a tool and nobody can fix a block. It reports
per tool: calls, refusals, the classes and how far each spread, and the episodes where the
same call was repeated with nothing changed between tries — which is what a refusal that did
not say what was wrong looks like from outside.

It also names **whose defect each refusal is**, and that is the difference between a report a
team acts on and one they argue with:

    401/403   authorization — almost always OURS: a key, a scope, a role
    422/400   the payload we sent — ours until a correct payload also fails
    5xx       theirs
    validation errors   the arguments we sent, refused by the MCP wrapper

suppose one tool fails on every call you have a record of. Read naively that is a completely
broken tool. It may be a 403 — one credential without the scope — and telling the block team
otherwise would be wrong and would cost their afternoon.

**`zz-tool conformance` — the contract is the ruler, not the subject.** It measures R1-R14
from the tool surface and says which it cannot settle. Whether a requirement is a good
requirement is not this flow's question: a requirement ONE block fails is a fact about the
block, and only a requirement EVERY block fails is evidence about the requirement. One block
cannot tell those apart.

## Facts, not grades — and for someone else's block that is not a limitation

Nothing here says whether a 17% refusal rate is good or bad, and that is the correct output
rather than a gap waiting for a baseline. **These are not our tools.** The team that owns
them reads their own numbers against their own roadmap and constraints, neither of which is
in our event log, and they will see what is wrong faster than we can tell them.

What we owe them is an accurate account of what happened when we used their surface and what
it cost us. A number with no scale, stated as a number, is honest; the same number stated as
"poor" is a judgement from outside that they will rightly reject — and being wrong once costs
the credibility that makes the next report worth reading.

Our own block is the exception, and the reason is ownership: we can act, so naming what to
improve is the point rather than an overreach.
