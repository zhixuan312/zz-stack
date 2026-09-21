---
name: sdlc-explore
version: 1.8
description: Ground a raw idea before anyone designs it — capture the brain dump, fan out parallel workers across this system, the outside world and the ZZ knowledge base, wait for all of them, then synthesise one explore.md (Background · Current state · Rough direction). Main agent, with the fan-out dispatched.
when_to_use: "Someone arrives with a raw idea, problem, feature request or brain dump and it needs grounding before it is designed. The question is exploratory — several directions to weigh, not one fact to look up. If it is one convergent question, that is a single sdlc-investigate, not this. Requires a runtime that can dispatch subagents and reach the working tree directly."
---

# sdlc-explore

<!-- Design note: the fan-out workers are the runtime's own subagents, so their answers
     come back directly and there is nothing to poll. The prior-learning leg reads the ZZ
     knowledge base, which is shared across the team and across initiatives, and the
     artifact is written into the initiative rather than to a local path. -->

**Read `sdlc-method` first.** Then note the shape of this stage, which is unusual:

**You run this. The workers run underneath you.** The fan-out is dispatched — many subagents in
parallel, one question each. The synthesis is not. Many answers are not a picture, and turning
them into one is the judgement this stage exists for.

Exploration is **divergent**: survey, enumerate, compare. If you want one answer with citations,
that is a single `sdlc-investigate` and you should not be here.

## Phase 1 — capture the brain dump

Let them describe the idea. Do not interrupt, and do not start solving. Capture everything —
this is the raw material for both the fan-out and the exploration's `## Background`.

## Phase 2 — size the fan-out, then ask once

**Size it to what the brain dump actually contains.** The count under each type is driven by the
number of distinct questions, never a fixed one-per-type.

| Worker | Range | One task per |
|---|---|---|
| `sdlc-investigate` | 1–8 | distinct area, subsystem or source collection the idea touches. The bulk of the fan-out; most ideas land at 2–5 |
| `sdlc-research` | 0–3 | distinct external question. Zero is fine when the work is purely internal |
| `sdlc-recall` | 1–3 | distinct prior-decision topic. **Always run at least one** |

So the shape tracks the idea's size: a typical feature is about **5-1-1**, a large cross-cutting
one **8-2-2**, a minor one **2-0-1** — roughly 3 to 12 parallel workers.

**Name each task by the specific question it answers.** That specificity is what makes parallel
workers produce sharp, non-overlapping findings. "Investigate the auth module" is a survey;
"how does the auth module decide a token has expired" is an answer.

Then present it as **one glance** and ask once:

> "Planning the fan-out: **5 investigations** (auth module · token store · session layer · API
> surface · migration path), **1 research** (OAuth refresh prior art), **1 recall** (what we
> decided about token expiry). Anything you'd add before I dispatch?"

**Keep this gate terse on purpose.** It is not a per-task editor. They may append tasks or just
say go. Do not walk them through the list, and do not ask which types to run — explore runs all
three unless one is genuinely inapplicable.

## Phase 3 — dispatch every worker, in one message

All of them at once, in parallel. Not one call per type — **one call per question.**

Each worker gets: the stage skill to follow (`sdlc-investigate`, `sdlc-research` or
`sdlc-recall`), its one question, and the initiative name. See `sdlc-method` for what a worker
is handed and on what tier.

**`sdlc-recall` is never dropped to save a call.** A superseded prior decision is the single
most valuable thing you can learn before design, and you cannot know the knowledge base is empty
on a topic without asking. An empty answer is `(no prior learning)`, which is information.

**`sdlc-investigate` may be skipped only if the work is unambiguously greenfield** — no existing
material to touch at all. When in doubt, run it.

**Wait for every worker to return before synthesising.** The picture changes with the last
answer.

## Phase 4 — synthesise, then write `explore.md`

The synthesis is yours. **Do not dump the raw worker reports back to the person** — the
synthesis IS the output, and the reports are what you reasoned over.

Write it into the initiative with `document_write` as `explore.md`. Never a local path.

Then fetch it back with `document_present("<initiative>/explore.md")` and put what it returns
in front of the person before they pick a direction to carry into `sdlc-spec`. A write that
succeeded is not a direction anybody read.

Keep the top level at `##`: downstream stages read these sections by their `##` heading, and a
deeper top level makes them see nothing.

`Background`, `Current state` and `Rough direction` are what `flow.json` declares for
`explore.md`; the template below reproduces them so you have them while writing, and the manifest
is what actually runs. `explore.md` carries no gate, which means those three are required on
every write rather than only at an approval — there is no draft state in which a missing one goes
through.

**Write a heading that says more than a declared one and the platform renames it.** `## Background
of the pricing work` becomes `## Background`, and the reply to your `document_write` tells you it
did. Two things follow. Keep that line: it is said once, to you, and the stored document keeps
only the new wording, so an auditor later has no way to find out unless you pass it on. And read
the rest of the reply, because one heading can cover two declared sections — `## Background and
current state` is renamed to `## Background`, and `## Current state` is then genuinely missing
from a document that looked complete when you typed it.

```markdown
# No frontmatter. document_write takes the BODY; the platform writes the envelope.
#   document_write(path: "<initiative>/explore.md", content: "<the body>")
# document_write takes no `flow`. The flow was declared to initiative_open, which is also
# what created this initiative, and the platform stamps it onto every document from there.

# Exploration: <title>

## Background
The brain dump distilled — who, what, why, and the problem framing. Your words, not their
verbatim ones.

## Current state
What exists today, synthesised.

### Findings — Internal
From `sdlc-investigate`. Each: a claim plus a `file:LINE` citation from its evidence.

### Findings — External
From `sdlc-research`. Each: a claim plus a source name or URL.

### Findings — Prior learnings
From `sdlc-recall`, out of the ZZ knowledge base. Each: a claim plus the node it came from. If a
node is **superseded**, say so inline — `node 0012 [superseded by 0013] — …` — so the "we already
moved past this" signal survives. `(no prior learning)` when the leg returned nothing.

## Rough direction
3–5 ranked candidate directions, shaped like the spec's `Alternatives` so the next stage can
lift them almost verbatim.

**This document is read by business, product and engineering.** Write each direction so a
non-engineer can weigh it: plain English, value first.

Each direction proposes a **resolution shape** — the kind of action it takes. There are six:
**build** · **change** · **configure** · **document/analysis** · **process/decision** ·
**no-change**.

If the brain dump names a target deliverable, every direction may resolve to it. Otherwise, and
where the data supports more than one, the set MUST span **at least two distinct shapes**. Three
ways to build the same thing are not divergent, and a problem may resolve just as validly
through "change the process" or "no change is needed" as through building something.

Each direction carries:

- **Title** and a one-paragraph summary in plain language
- **Resolution shape** — one of the six
- **What it buys us** — the value or outcome, and roughly what it costs
- **Key trade-off** — what you give up for the upside
- **Backing citations** — at least one internal, external or prior-learning cite, or the
  matching sentinel: `(no internal anchor — fully greenfield)`, `(no external source found)`,
  `(no prior learning)`
- **Divergence axis** — one line on what makes this different from the others. No two directions
  may share an axis
- If a superseded prior decision maps onto a direction, keep it but mark it
  `⚠ already explored — see node NNNN` and weight it down

### Recommended next step
One paragraph naming which direction to pursue first and why. If a prior learning rules one in
or out, cite it here.
```

Then tell them where it landed and what it says. The next stage is `sdlc-spec`.

## Nothing reviews this but you

`sdlc-explore` has no audit behind it — the first audit runs on the spec, which is downstream of
this. The synthesis, the divergence, and every citation are yours alone to get right. That is a
reason to be strict with yourself here, not a reason to be quick.

## Pitfalls

❌ **Dumping the raw worker reports.** The synthesis is the output.

❌ **Turning the Phase 2 gate into a per-task editor.** Counts, purpose, ask once, dispatch.

❌ **Skipping `sdlc-recall` to save a call.** The one leg that tells you the project already
tried this.

❌ **Skipping `sdlc-investigate` for convenience.** "Greenfield" has to be unambiguous.

❌ **Synthesising before every worker returned.** The picture changes with the last answer.

❌ **Inventing citations.** Every one traces to a worker finding or to a sentinel.

❌ **Padding to hit a direction count.** 3–5 is the target because this stage exists to
*diverge*, and one direction usually means the space was not explored rather than that it is
narrow — so look hard for the third and fourth. But one direction with strong citations beats
five watery ones: if the data honestly supports fewer, write fewer and say in
`## Rough direction` why the others were ruled out. An unexplained short list reads as laziness;
an explained one is a finding.

❌ **Directions that only vary the build.** Vary the resolution shape too.

## Failure handling

| Scenario | What to do |
|---|---|
| `sdlc-research` failed | `(no external source found)` on every external line |
| `sdlc-investigate` failed | Treat as greenfield — `(no internal anchor — fully greenfield)` |
| `sdlc-recall` failed or found nothing | `(no prior learning)` and continue. This leg is additive, never blocking |
| Both investigate and research failed | Report both errors. **Do not write the artifact** |
| All three failed | Report every error. Do not fabricate an exploration |
| A worker returned but flagged its own concerns | Pause and surface what it said. Do not synthesise over it as if clean |

## Skill contract

**Outcome:** one `explore.md` in the initiative carrying `## Background`, `## Current state` and
`## Rough direction` — three to five ranked directions spanning at least two resolution shapes,
each with its own divergence axis and a backing citation or the matching sentinel — written by
you, then put in front of the person before they pick a direction to carry into `sdlc-spec`.

**Required evidence:** every dispatched worker's return, all of them, before any synthesis. A
`file:LINE` citation for each internal finding, a source name for each external one, the node for
each prior learning. Where a leg found nothing, the sentinel is the evidence — `(no internal
anchor — fully greenfield)`, `(no external source found)`, `(no prior learning)` — and it is
information, not a blank.

**Allowed unknowns:** which direction the person will choose; how any direction would be built;
anything the fan-out could not reach. A direction may be ranked on incomplete ground as long as
the gap is written into it. What is never unknown here is whether every worker returned: the
picture changes with the last answer.

**Work roles:** the fan-out is dispatched, one question per worker, and the synthesis is this
agent's own — many answers are not a picture, and making them one is the judgement this stage
exists for. The person is asked once, terse, to size the fan-out. The `semantic-assessment` role
answers the bounded questions below by question ID from the fixed set below. Nothing in this
platform registers those IDs yet, so an implementation adopts these spellings rather than minting
its own; it does not rank the directions.

**Checkpoints:**

| Where | Question ID | Asked about |
|---|---|---|
| Phase 2, per candidate worker | `needs_fact` / `needs_analysis` | whether the question is one convergent fact, which is one worker, or a subject, which is several — a prompt saying "and also" is two workers |
| Phase 4, per finding carried into the document | `evidence_relation` | whether the cited material actually supports the claim a direction rests on |
| Phase 4, across the returned reports | `repeats_finding` | whether two workers found the same thing, so the synthesis states it once rather than as two confirmations |

**Action and exit paths:** the action is size, ask once, dispatch in one message, wait for all,
synthesise, write, present. The forward exit is `sdlc-spec`, with a direction the person chose.
One earlier exit exists: a worker that returns but flags its own concerns pauses the stage —
surface what it said rather than synthesising over it as if clean.

**Degraded behaviour:** research failed, so every external line takes its sentinel. Investigate
failed, so treat the ground as greenfield with its sentinel. Recall failed or found nothing, so
its sentinel stands and the leg is additive, never blocking. **Both investigate and research
failed, or all three failed: do not write the artifact** — report every error instead, because an
exploration nobody could ground is not one to fabricate. An honestly short direction list, with
its reason stated, is a finding; an unexplained one reads as laziness.
