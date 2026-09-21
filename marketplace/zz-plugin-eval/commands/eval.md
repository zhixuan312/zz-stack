---
name: "eval"
description: "Run the ZZ Plugin Evaluation flow for your team."
when_to_use: "The person typed /zz-plugin-eval:eval. This is a command, not an auto-matched skill."
version: "0.62.4"
disable-model-invocation: true
---

# zz-plugin-eval

**A plugin is what a person installs**: a flow's skills plus the MCP servers those skills call,
arriving together and reached together. That is the unit this measures, and it is the unit the
platform ships at — which the platform could not previously evaluate, because it evaluated the
two halves separately and neither half contains the answer.

Two questions are only visible from the whole:

- **Recovery.** A stage goes wrong. Can the flow return to an earlier stage and re-ground, or
  does it plough on? That is a relation between stages, so no per-skill ruler contains it.
- **Use.** A tool is reachable, a skill names it, every gate check is green — and no agent has
  ever called it. Reachability is a property of the package and is already settled at release.
  Use is a property of the runs, and nothing reads it.

**This measures. It does not improve.** `findings.md` says what to change; making the change is
a repository edit and a release by whoever owns the plugin. Fold improvement into the measuring
flow and the measurement bends toward the intervention somebody already wanted.

**It is a platform capability, not a stage of anybody's delivery.** An agent in the middle of
shipping something does not stop and evaluate the plugin it is shipping with — that is a
separate piece of work with its own initiative.

**A PERSON OPENS THIS FLOW. NOTHING OPENS IT FOR THEM, and that is worth knowing before you
write a case about it.** This skill is a flow's `entry`, so the shelf renders it as the command
`/zz-plugin-eval:eval` carrying `disable-model-invocation: true` — a model cannot invoke it at
all, whatever its `when_to_use` says. The five stage skills beside it each say "never on its
own", which is right: a stage that fires out of order is worse than one that does not fire.

The consequence, measured on 2026-09-13 over nine runs: asked the three questions this flow
exists to answer, in ordinary words, with the plugin installed, nothing in it engaged and the
delta against a bare agent was zero on all three cases. That is a true measurement and it is
not a defect in any of them — it is what "a person invokes this on purpose" costs, stated as a
number. A case written for this plugin has to name the flow, the way a person does, or it
measures the shelf's routing rather than this flow's content.

Load `zz-platform` first, as with every flow on this platform.

## One kind of evidence, and where the second one went

| | where it comes from | needs | answers |
|---|---|---|---|
| **traces** | the event log, via `plugin_profile` | five usable runs | what did it actually do in real use? |

**There were two.** `cases` came from a `claude plugin eval` suite recorded by `case_record`,
and reported a with-plugin against no-plugin delta — a counterfactual, which is a stronger
claim than any score. It is removed, and what it actually measured is why.

No case ever declared a mock, so under the CLI's default `--mocks record` no plugin server
started and **the plugin's tools were not callable in either arm**. Every grader was a regex
over tool NAMES or a judgement about an answer's shape. A delta therefore established that the
method's TEXT had reached the agent and that it used the right words — never that the plugin
worked. The strongest result the suite ever produced came from a prompt that typed the plugin's
own command, which is a way of asking whether text helps once you have already handed it over.

**So a thin trace block is now a real constraint, not a fact to report and route around.** A
plugin nobody has used cannot be judged on its runs. That is an honest `not measured`, and the
enum carries that word for exactly this. Two things soften it: a ruler whose subject is the
**document** or the **initiative** reads artifacts rather than runs, and may have subjects when
the trace history is thin; and `plugin_conform` answers from the catalog entry alone.

## The one hard rule

**You are not the judge.** Scoring is `round_judge`, which takes a plugin, a version and a
ruler id and nothing else: it assembles the subjects and runs a model pinned by the deployment.
You orchestrate, you narrate, you write the documents. Your own reading of an artifact belongs
in `findings.md` as an observation, never in the table as a score — a judge that varies with the
conversation makes every number incomparable with every other number.

## The five stages

| # | Stage | What it settles |
|---|---|---|
| 1 | `zz-plugin-locate` | which plugin, at which released version, containing what |
| 2 | `zz-plugin-profile` | the two evidence blocks, each with its own sufficiency |
| 3 | `zz-plugin-define` | **what good means for this plugin** — gated |
| 4 | `zz-plugin-judge` | the scores, against the approved ruler |
| 5 | `zz-plugin-report` | `findings.md` — gated, and it closes the initiative |

After report, the close is an act rather than a stage — one `initiative_close()` call — and the platform
then reports `action: handover`, which `zz-handover` writes cold, afterwards. The close ends
the evaluation; the handover ends the cycle.

**Two gates**: `rulers.md` after define, `findings.md` after report. Nothing is scored before a
person has agreed what good means, and nothing is closed before a person has read what was
found.

## Facts come from tools; meaning comes from you

Every number these tools return is a count, a set, an ordering or a difference. Not one of them
is a judgement, and that is deliberate.

`returns: 3` is a fact — a stage ran, a later stage ran, then the first ran again. Whether that
is a flow re-grounding well or one thrashing is **not in the data**. The initiative that
designed this flow returned three times and every one was healthy: an audit found a real defect
and the spec went back. A tool that labelled those "unhealthy" would be answering a question it
cannot see the evidence for.

So: the tool produces the fact, the ruler you agree says where the line is, and the tool may
then apply that line. Where a threshold belongs — 10% or 30% — is yours. What the number *is*
is never yours.

## Pitfalls

❌ **Stopping because the trace block is thin.** Read the case block. Only both empty is a stop.

❌ **Scoring before `rulers.md` is approved.** `ruler_affirm` refuses, and the refusal is the
gate working.

❌ **Running the case suite because a profile looked stale.** It costs real money on the
caller's own credential — roughly $0.40 a case. Running it is a deliberate act somebody asks
for.

❌ **Reading a delta without its date.** `plugin_profile` returns `last_run` for exactly this
reason. A three-week-old delta presented as today's is worse than none.

❌ **Comparing two plugins.** Every ruler is that plugin's own, so two scores are two things
measured with two rulers. There is no leaderboard here and there is not meant to be.
