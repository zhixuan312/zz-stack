---
name: zz-skill-profile
version: 0.3
description: Establish what is being measured and what the work was like, from telemetry only — no judgement, no scores. Writes no document: the numbers belong beside the verdict they support, in findings.md.
when_to_use: "Stage 2 of zz-skill-eval, after zz-skill-locate has settled which skill. Never skipped: a score with no profile is a number nobody can compare to another number."
---

# zz-skill-profile

Statistics come before rubrics, and rubrics before documents. That order is not a
preference — it is the only order that resolves the chicken and egg. You cannot say what
good looks like for a skill until you have seen what it does; you see what it does here.

## This stage writes no document

The statistics are `profile.mjs`'s output; the READING of them belongs in `findings.md`,
beside the verdict they support. A `profile.md` existed here and held both — which made its
interpretation and findings' "what the numbers say" the same content twice, in two files that
would disagree the moment either was edited.

**The rule, stated once for both evaluation flows:** a document exists only where it carries a
judgement, a decision, or an interpretation that is not already in the data. Statistics are
data. Keep the script's output with the run; write the meaning down once, later.

What to establish here, and carry forward:

### What was measured

The scope, in one line — an initiative, a skill and version, or a window — and the exact
boundaries: which slugs, which versions, which dates. A reader six months from now must be
able to reproduce the selection.

For each skill in scope, name the **version** and how that was established:
`doc.produced_by_run_id -> run.skill_version_id` where a run link exists, the eval's own
record where one does not, and the `released_at` era window as the last resort. Say which
of the three each attribution came from. An attribution by era is a guess with a good reason,
and it must not read like a fact.

### The work it was measured on

This is the section that makes the scores mean something. Per initiative in scope, from data
that already exists:

- acceptance criteria in the agreement document
- blocks used, and whether any work crossed between them
- gates re-entered — an approval followed by a further patch to the same document
- turns, and the split between agent-working and waiting-on-stakeholder

**Report the profile; do not band it.** "Complex" and "simple" are conclusions that need
more initiatives than this platform has run. A score reads as *4.8 on a 22-criterion,
two-block requirement*, and the bands come later, from a corpus of profiles.

## Note what the numbers mean — for findings.md, not for a document here

The script produces the statistics. **You write the reading of them**, in prose, beneath each
section. That is the part a program cannot do and the reason this is a stage rather than a
cron job.

The line to hold is between DESCRIBING and JUDGING:

    describe   "951 calls against 14 loads — it is opened once and then carries most of
                the work of an initiative."
    describe   "109 refusals, 84 of them one opaque 422 from a single block."
    describe   "Not opened in any of the 5 runs that used its block."

    judge      "ops-build is the weakest skill on the platform."
    judge      "This refusal rate is unacceptable."
    judge      "The block skills are not earning their place."

The first three tell a reader what they are looking at. The last three settle, before the
ruler is agreed, the question the next two stages exist to answer — and once written down
they are what everybody reads instead of the evidence.

**Where a number cannot be interpreted, say so.** A statistic with no reading is honest; an
invented reading is not. "5 runs, and no way to tell from here whether that is a lot" is a
better sentence than a confident one.

## Hard rules

- **No judgement in this document.** Not "ops-build struggled" — `ops-build: 278 calls, 57
  refusals, 51 of them 422`. The next stage decides what good is; this one would prejudice it.
- **Never estimate a number you cannot query.** A refusal rate inferred from reading
  documents is the one figure in the record nobody can check.
- An empty window is an alert, not a finding. A platform with users does not have a silent
  week — check the scope before believing it.
