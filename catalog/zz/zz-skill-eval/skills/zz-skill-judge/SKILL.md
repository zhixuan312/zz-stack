---
name: zz-skill-judge
version: 0.5
description: Run the judgements — the version's documents where it wrote any, its run traces where it did not — and record every one with its judge named. Writes no document; scores go to the table.
when_to_use: "rulers.md is approved. This is where scoring happens, and the only place it happens."
---

# zz-skill-judge

**Do not enter this stage until `rulers.md` is approved.** In the flow the sequencing takes
care of it; run standalone — which every script here is built to allow — nothing stops you.

`eval_skill_judge` refuses when a version declares no ruler and points at
`eval_skill_affirm`. **That refusal is the gate showing through, not an inconvenience to
route around.** Affirming a ruler to get past it, without the stakeholder having approved
`rulers.md`, produces scores under a scale nobody agreed to — and they are indistinguishable
afterwards from scores that were.

**You do not score anything yourself.** You run the tools and write down what they returned.
Your own reading of a document belongs in `findings.md` as an observation, never in this
document as a number.

## Two evaluations, and the second is not optional

    eval_skill_judge(skill: "<name>", version: "<v>")
    eval_skill_judge(skill: "<name>", version: "<v>", eval_id: "<returned>")   # until remaining is 0
    eval_skill_judge(skill: "<name>", version: "<v>", control: true)
    eval_skill_judge(skill: "<name>", version: "<v>", control: true, eval_id: "<returned>")

**It judges one subject per call and tells you what is left.** One document takes the judge
about thirty seconds and something between this tool and you closes a request at two minutes,
so a call that tried to score a whole corpus returned nothing at all — not a partial answer, a
dropped connection with the work abandoned mid-flight. Pass the `eval_id` it returns and the
next call continues the same evaluation; keep going until `remaining` is 0, then do it again
for the control. Progress is in the table while it runs, so a turn that dies loses one subject
rather than the round.

The **control** scores a DIFFERENT skill's work under this skill's ruler. A judge that is
reading collapses on it; one rewarding busy-looking output barely moves. A quality score with
no control behind it is the too-good number this whole apparatus exists to stop — one without
the other is not a measurement.

**A skill with no documents is not skipped.** Five of the platform's skills write a gated
document; the rest are judged from what they actually left behind, against the same ruler.
The tool picks the subject kind itself: the version's documents where it produced any, its
run traces where it did not. It never mixes them, because two subject kinds under one mean is
a number about nothing.

**YOU ARE NOT THE JUDGE, and the tool is built so you cannot be.** It takes a skill name and
a version — nothing else. The ruler, the subjects and their text are assembled from the
database and the artifact store; the model is pinned by the deployment and named on every
row. You cannot hand it an artifact, a rubric or a model. This used to be a terminal command
carrying a paragraph saying it must never become a tool, and the thing that paragraph
protected was never the invocation channel: it was that a judge varying with the conversation
makes every number incomparable with every other. Taking the inputs out of the conversation
protects it more tightly than a shell prompt did.

**The run trace IS the document.** A skill like sm-build leaves a changed system and a trail
of tool calls, and that trail is an artifact a judge reads exactly as it reads a spec. One RUN
is one subject (`zz.eval_subject.run_id`), its ordered events are the text, and the rubric is
the ruler — the same shape as `eval-judge`, with a different artifact.

**Every score cites events.** `eval-judge` demands a verbatim quote from the document and
calls a score without one wrong; the parallel here is the call, the refusal, the ordering. A
dimension scored with nothing citable in the trace is an impression, and an impression that
lands in `zz.eval_score` is indistinguishable afterwards from a measurement. The script
reports how many scores arrived uncited rather than hiding them.

What the trace makes visible, and no document could:

- a read-back after a write is verification; a write with no read after it is its absence
- the same failing call repeated identically is not learning within the run
- the order things were attempted in, which is most of what a build skill does well or badly

## A person's judgement, when there is one

Calibration against the model is recorded by the platform team, not from inside a run:
`zz.eval.judge_model` carries the person's own name, so their marks sit in the same table and
are never mistaken for the model's. There is no tool for it in this flow — say in `findings.md`
that a human read is wanted and which documents, and the platform team records it.

**Never average two judges.** A model's baseline over thirty documents and a person's read
of two are not the same measurement, and the difference between them is the instrument, not
the work. `eval_skill_scores` returns them grouped by judge for exactly that reason, and
`findings.md` reports them side by side and says so in words.

## This stage writes NO document

Scores go into `zz.eval_score`, and that is the whole output. There was a `scores.md` here
and it was a second copy of a table — stale the moment anything else was judged, and
duplicating rows the database already held. `zz-skill-report`'s script reads the scores back
out, cumulatively, whenever anybody wants them.

The only narrative artifact this flow writes is `findings.md`, which says what the numbers
MEAN. Numbers themselves belong in a table that can be queried, joined, and compared across
rounds — which a markdown file cannot be.

## What must be true before this stage is done

- every document of this version judged, with its rubric version and judge recorded
- every non-document dimension scored against the evidence its rubric names
- **a control run**, or an explicit note that none was — a quality score with no control
  behind it is the too-good number this whole apparatus exists to stop
