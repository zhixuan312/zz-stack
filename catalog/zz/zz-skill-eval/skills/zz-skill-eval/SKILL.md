---
name: zz-skill-eval
version: 0.4
description: The front door to skill evaluation. Five stages — locate, profile, define, judge, report — over one initiative, one skill, or a window of work. Produces evidence about how well a skill works; never changes anything.
when_to_use: "Somebody asks how a skill is performing, whether a change to one helped, or what the last round of delivery says about the platform. Also after any initiative closes, to fold it into the corpus. Platform capability — a delivery agent never runs this."
---

# zz-skill-eval

**This measures. It does not improve.** The report's Recommendation says what to change; the
change is a repository edit and a release, made by whoever owns the skill. There is no stage
here that makes it and no skill that runs it — the catalog is read-only wherever the platform
runs, which is what keeps every agent's copy of a skill identical to what the gate checked.

Keeping the two apart is also the point. Fold improvement into the measuring flow and the
measurement bends toward the intervention somebody already wanted.

Load `zz-backbone` first, as with every flow on this platform.

## The one hard rule

**You are not the judge.** Scoring is done by `eval_skill_judge`, which takes a skill name and
a version and nothing else: it assembles the ruler and the subjects itself and runs a model
pinned by the deployment. You orchestrate, you narrate, you write the documents, and your own
reading of a document belongs in `findings.md` as an observation, never in the table as a
score. A judge that varies with the conversation makes every number incomparable with every
other number, which costs more than having no numbers.

Where a person's judgement IS wanted — calibration against the model — the platform team
records it with that person named in `judge_model`, and it is never averaged with the model's.

## The four stages

| stage | writes | what it settles |
|---|---|---|
| `zz-skill-locate` | — | which skill this is about, and which version |
| `zz-skill-profile` | — | what was measured, and what the work was like |
| `zz-skill-define` | `rulers.md` **(gate)** | is the definition of good right for this version |
| `zz-skill-judge` | — | the judgements, into `zz.eval_score` |
| `zz-skill-report` | `findings.md` **(gate)** | what recurs, what is new, what this does not say |

**Two documents, five stages, and that is deliberate.** A stage writes a document when
somebody has to agree to something; the rest leave their output where it can be queried. What
locate and profile settle travels in the header of the documents that do get written, and the
scores live in a table that can be joined and compared across rounds, which a markdown file
cannot be.

## Scope — what you are being asked about

An evaluation names one of three scopes, and says which in `rulers.md`:

- **an initiative** — everything one closed initiative exercised
- **a skill and a version** — one skill across every initiative that used that version
- **a window** — a period, optionally one team

**There is no command that runs the whole evaluation.** Each stage owns its program, shipped
beside it as a `script` asset, and the flow is what puts them in order:

    zz-skill-locate    no tool — an interview, and its answer is a judgement
    zz-skill-profile   eval_skill_profile(skill, version?)
    zz-skill-define    eval_skill_ruler(skill), then eval_skill_affirm(skill, version)
    zz-skill-judge     eval_skill_judge(skill, version), then again with control: true
    zz-skill-report    eval_skill_scores(skill)

One implementation each, on the platform's own MCP surface. They were briefly scripts shipped
beside the stages, which an agent cannot run — it has MCP tools and no shell — so a stage
naming one named a program nobody in the flow could execute.

A single `eval-run` existed briefly and was removed. It re-implemented what four stage
scripts already did, and within a day it was the STALE copy — reporting "no definition of
good" for versions whose rubric existed but was not yet linked, a distinction `ruler.mjs`
draws correctly. One copy, or they drift; and the flow is the thing that sequences them.

## Where the run lives

An evaluation is an initiative in the **zz-platform** team store, named for what it measured:

    /artifacts/teams/zz-platform/<date>-eval-<scope>/

It reuses the gates, the document chain, `_versions/` snapshots and the ledger, because an
evaluation deserves the same provenance as the work it evaluates — and because a second
mechanism for any of that would be a second mechanism to keep correct.

## Ending

Close it like any initiative, and the platform's handover applies: `zz-knowledge` mints what
generalises. An evaluation that recurs across rounds IS knowledge — "ops-intent bleeds goals
into constraints" was observed in two unrelated initiatives before it was worth writing down.
