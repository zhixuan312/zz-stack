---
name: zz-skill-report
version: 0.12
description: Say what the round concluded, how much to trust it, and what to do about it. The closing document and the flow's second gate. Writes findings.md.
when_to_use: "The scores are stored — eval_skill_judge has run, plainly and with control. This closes the evaluation, and its Recommendation is what somebody applies."
---

# zz-skill-report

The evaluation's output. Written for the person who will change something — but **it does
not change anything, and it does not recommend one**. Naming the change here would make the
next round's measurement an assessment of your own proposal.

## How to write it: Simplified Technical English

**A person reads this to decide something. Write for that person.** These reports were
accurate and unreadable — one reader could not tell what a round concluded without
reconstructing it from the evidence, and said so. The rules below are ASD-STE100's writing
rules, which exist for exactly this: technical facts that a reader must not have to decode.

- **One idea per sentence.** A sentence carrying a claim, its caveat and its cause is three
  sentences pretending to be one.
- **Twenty words is the limit.** Count them. A long sentence in this document is always two
  short ones that have not been separated yet.
- **Six sentences is the limit for a paragraph.**
- **Active voice, present tense.** "The control did not finish", not "it was not possible for
  the control to have been completed".
- **Keep the articles.** "The judge", "a control", "the score" — dropping them is how a
  sentence turns into a telegram.
- **Never stack more than three nouns.** "The skill evaluation flow report gate" names
  nothing; say "the gate on the report".
- **One word, one meaning, throughout.** If a round is "uncontrolled" in one place, it is not
  "unverified" in the next. Pick the word and keep it.
- **Say the number, then what it means.** "3.00, and it establishes nothing about quality"
  — not the reasoning first and the number four lines later.

**What NOT to take from STE: its dictionary.** The approved word list was written for aircraft
maintenance, and forcing `rubric`, `control`, `judge` and `affirm` through it produces
circumlocutions worse than the terms. Keep the terms and define them once, in one line, the
first time each appears.

**The test.** Read the first eight lines aloud. If a person who has never seen this platform
cannot then say what the round concluded and how much to trust it, the document has failed,
whatever else is right about it.

## The first eight lines, written out

**This is the shape. Fill it in; do not redesign it.** Every round's opening answers the same
four questions in the same order, so a reader who has seen one report can read any of them.

    # <skill> <version> — <one line: what we concluded>

    **Result: <GOOD AS IT IS | NEEDS A CHANGE | INCONCLUSIVE>**

    | | |
    |---|---|
    | What we know | <the finding that stands, with its number> |
    | What we do not know | <what the round could not settle, and in one clause, why> |
    | Score | <n> under <rubric>, control <n>. <Trustworthy / Not trustworthy, and why in six words.> |
    | Next | <the one action, and whose> |

**INCONCLUSIVE is a real result and it goes in the same box as the others.** A round whose
control did not finish has not measured quality, and saying so on line three is worth more
than four paragraphs that let a reader assume otherwise.

**Never put a bare score in the result line.** `3.00` on its own is read as a verdict by
everybody. If the control did not clear the collapse line, the score does not appear until
the table, and it appears with the words that make it safe.

## The order is the manifest's, and the verdict comes first

    The verdict
    What we can rely on
    Recommendation
    What the numbers say
    Why the measurement is or is not trustworthy
    What this does not say
    What was evaluated

**This document is read by somebody deciding something, and it used to make them earn the
conclusion.** The sections ran provenance, then raw numbers, then the verdict third — so a
reader met `glm-5.3/no-reasoning`, `subjects: 0`, refusal classes and rubric anchors before
they had any idea what the round concluded, and had to reconstruct it. One reader described
the effect exactly: the report gives evidence and leaves the conclusion to be assembled.

The evidence is not cut. It moves below the thing it supports.

**Where the platform's own failures go: "Why the measurement is or is not trustworthy",
and nowhere else.** A round whose control timed out, whose judge changed, whose tool
misreported — that is a fact about the measurement, not about the skill, and with no home of
its own it leaked into the verdict, the numbers and the recommendations at once. Three
sections of one report re-earning the same caveat is what makes a page unreadable.

## What was evaluated

The header, and it is where the target lives now — there is no `target.md`. `zz-skill-locate`
still settles the subject, and settling it is still the one mistake no later stage can
detect; what changed is that the ANSWER is recorded here rather than in a file of its own.

- **the skill** — name, kind (`flow_step` or `block_usage`), and its owner.
- **the version**, and that it is the latest unless somebody asked otherwise.
- **how it was narrowed** — the answers that got from "the spec skill" to one registered
  name. This is what makes the run reproducible and lets a later reader tell whether the
  right thing was measured.
- **the scope**, if it was several skills. A scope is a choice; record that it was made.

## What the numbers say — PASTE, do not retype

    eval_skill_scores(skill: "<name>")

**It returns finished markdown. Paste it under this heading, whole, in order, unchanged.**
Do not reformat a table, do not drop a row you think is dull, and above all do not retype a
number into your own prose — every number a model retypes is a number that can drift, and
this document's whole value is that its numbers are the platform's rather than the writer's.

Six tables come back, and each answers a question a reader of the old reports had to ask and
could not:

| | what it settles |
|---|---|
| **Coverage** | how many subjects were judged, **out of how many there were** — and what was out of reach or left unjudged. No report before this one said 13 OF WHAT. |
| **The judge on trial** | the real mean against the control, and whether the gap clears 1.5 |
| **Scores by dimension** | mean, worst, best, n — split by ruler version and judge, never averaged across them |
| **Every round so far** | every evaluation ever taken of this skill, oldest first |
| **What the skill actually did** | loads, calls, how many were refused, distinct tools, which blocks, run lengths, initiatives |
| **Refusals by class** | what it was refused for, and how often |

**Start with the judge on trial.** If the gap is under 1.5, every number under it is not
evidence and the verdict is INCONCLUSIVE. Say that before saying anything else, and stop.

**Know what the control actually is, because the reports used to misdescribe it.** It is
NOT scrambled or degraded input. It is **another skill's work of the same kind** — another
initiative's document, another skill's run trace, another skill's text — scored under THIS
skill's ruler. Nothing is shuffled.

That decides what a small gap MEANS, and it is usually not the judge's fault. A ruler whose
dimensions another skill's work can satisfy is not measuring this skill, and no judge can
rescue it, and which of the two you have is something the control tells you: a document
round clears by a wide margin, because a document ruler is stage-specific, while a `body`
round comes out at or below zero, because a body ruler asks generic questions about a skill's
text and another decent skill's text answers them. **So a failed control sends you to zz-skill-define to re-cut the ruler, not to
the judge.**

**Then read Coverage, and say in one sentence what it means.** A round that judged 13 of 15
is not the same claim as one that judged 13 of 200, and the tables cannot make that point for
you — that sentence is the writing this section still needs.

**"What the skill actually did" is measured, not judged**, and it is the half these reports
used to omit entirely. A reader was told a document scored 3.22 with no way to know whether
the skill ran twice or two hundred times. Do not grade it — a high refusal rate can be a
guard working correctly. Name anything that surprises you, and leave the rest as the scale
of the work.

**Every score ever taken, not this round's.** A skill may have run for two months before
anybody evaluated it. Findings are NET: what is new in this round is a column in the story,
never the subject of it.

## The verdict is DERIVED, and one of its answers is "leave it alone"

**A verdict is a sentence somebody can act on.** "Not established" is a description of the
evidence, not a verdict — pair it with what you DO conclude, or with what would settle it.
Three endings are legitimate and no others:

- **Good as it is.** Say it plainly. A round that finds nothing wrong is a result, and a
  report that cannot say so teaches everyone to expect a complaint.
- **Needs a change**, named, with the dimension that says so.
- **Inconclusive**, with the one thing that would settle it and who can do it.

`scores.mjs` computes the verdict from thresholds. You report it; you do not feel your way to
it.

**The failure mode this is built against is a review that always finds something to improve.**
"Could be better" is true of everything ever written, costs a round to act on, and is
indistinguishable from having measured nothing. A skill that is working must be able to come
out of this flow with **no change recommended**, or the flow is a machine for generating work.

The thresholds are conventions, stated so they can be argued with: **4.0** a dimension is
working, **3.5** below this it is the weak point, **n≥5** fewer subjects establishes nothing,
**1.5** the control gap a reading judge clears.

| what the numbers show | the verdict |
|---|---|
| the control scored about as well as the real subject | **no conclusion is possible** — the ruler cannot tell them apart; re-cut it, and say nothing about the skill |
| no dimension has enough subjects | **not established** — a fact about the evidence, not the skill, and not a favourable one either |
| every dimension with evidence at or above 4.0 | **good as it is — recommend no change** |
| one or more below | **change worth considering, and only there** |

## Recommendation

Name **only the dimensions the numbers named.** The script also reports how many dimensions
want no attention, and that number goes in the recommendation: "5 of 6 dimensions are at or
above 4.0 and want none" is what stops a targeted fix becoming a rewrite. **A rewrite of a
skill whose other dimensions are working is how a working skill regresses.**

For each dimension to change: what it scores now, over how many subjects, what the low scores
have in common — from the judge's own citations, which are stored beside every score — and
what specifically to change in the skill's text. Not "improve the constraints section": the
sentence, and what it should say instead.

**ONE CHANGE, AND SAY WHAT YOU EXPECT IT TO DO.** Two rules, and they only work together.

Name one change, not three. Two changes in a round and the next round can tell you the mean
moved and nothing can tell you which one moved it — so a round that recommends three has spent
the next round's evidence before it was collected.

Then write the expected effect beside it: which dimension, and roughly how far. *"Acceptance
criteria should come up from 3.77; anything under 4.0 means the sentence was not the problem."*
Without that line the next report cannot contradict you, and a report that cannot contradict
you gets read as agreement whatever it says. A change that did not work is worth recording as
much as one that did, because it stops the next person retrying it.

**Then the change is made in the repository and shipped by a release.** There is no other
route: the catalog is read-only wherever the platform runs, which is what keeps every skill
every agent loads identical to what the gate checked. So this section is not a note towards
the work — it IS the specification somebody applies.

**UNLESS THE SKILL IS A BLOCK'S.** A block's usage skill belongs to the block's team, and we
do not edit it — not out of politeness, but because that team owns the tools the skill
describes. A skill correction and a tool correction are two halves of one change and belong
in one version from them; split between us, they would ship on different days against
different versions, and the skill would end up describing a surface that no longer exists.

So for a `block_usage` skill the recommendation is written as a request to that team, with the
same evidence any defect gets — what the skill says, what the block does, and the read-back
showing the difference — and it travels through the block evaluation's report, not ours.
`eval_skill_profile` says which kind a skill is.

**Where two judges agree independently, say so.** The script surfaces it, and it is the
strongest signal available: different judges on different corpora reaching the same weak
dimension is a fact about the skill rather than about a judge or a round.

## What we can rely on

**One observation is an anecdote. Two, in unrelated initiatives, is a finding.** That
threshold is the whole value of a corpus, and it is what separates this document from a
review of one run.

For each recurring thing: what it is, the initiatives it appeared in, and the evidence in
each. A refusal class that appeared in two flows is stronger than one that appeared twice in
the same flow — say which shape it has.

Two shapes are the model:

- `<initiative>/doc.md` sent where a bare document name was wanted, across more than one
  skill. The skills document a path shape that is right for one tool and wrong for another.
- Platform-managed frontmatter written by hand, across more than one skill. The guard catches
  every one, so nothing breaks; a guard firing repeatedly across unrelated skills means the
  skills do not say clearly enough which fields are the platform's.

Findings with a single occurrence go here too, marked as such: worth recording, not worth
acting on yet. They had a section of their own, which the manifest never declared and which
split one question — what can we lean on — across two headings a reader had to reconcile.

## What this does not say

The section that keeps the document honest, and the easiest one to skip.

- Skills **not exercised** in this window. Nothing was learned about them, and a reader
  scanning a table of scores will otherwise assume the absent ones were fine.
- Skills **not consulted** — their block was used and they were never opened. Their
  effectiveness is untested, which is a different statement from "poor" and a more urgent
  one, because nothing will ever test it by accident.
- Any dimension scored on thin evidence — a single document, a single run.
- Any comparison that could NOT be made, and why. A round judged by a different rubric
  version or a different judge is not comparable with the last one, and saying so here is
  what stops somebody differencing them later.

## Then the stakeholder decides

Fetch it with `show_document("<initiative>/findings.md")` and present what it returns before
you ask — the reviewer judging a verdict has to have read it.

`findings.md` is gated. Approving it is agreeing to the verdict and the recommendation — not
to the numbers, which are what they are.

- **approved with no change** — the skill is good to go, and that is a real outcome
- **approved with changes** — somebody makes them in the repository, one at a time, and the next
  round measures whether they helped
- **not approved** — say what would settle it, and what evidence is missing

## Then close

Close the initiative. `zz-knowledge` mints what generalises — a finding that has now recurred
across rounds is knowledge, not just this evaluation's opinion.

The change itself is not this flow's to make, and there is no later stage that makes it. It is
a repository edit and a release, done by whoever owns the skill, against the specification in
the Recommendation above. The round after that is what says whether it worked.
