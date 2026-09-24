---
name: "eval"
description: "Run the ZZ Plugin Evaluation flow for your team."
when_to_use: "The person typed /zz-plugin-eval:eval. This is a command, not an auto-matched skill."
version: "0.75.0"
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

**A PERSON OPENS THIS FLOW. NOTHING OPENS IT FOR THEM.** This skill is a flow's `entry`, so the shelf renders it as the command
`/zz-plugin-eval:eval` carrying `disable-model-invocation: true` — a model cannot invoke it at
all, whatever its `when_to_use` says. The five stage skills beside it each say "never on its
own", which is right: a stage that fires out of order is worse than one that does not fire.

The consequence: asked the questions this flow exists to answer in ordinary words, with the
plugin installed, nothing in it engages. That is not a defect — it is what "a person invokes
this on purpose" costs.

Load `zz-platform` first, as with every flow on this platform.

## One kind of evidence

| | where it comes from | needs | answers |
|---|---|---|---|
| **traces** | the event log, via `plugin_profile` | five usable runs | what did it actually do in real use? |

**A thin trace block is a real constraint, not a fact to report and route around.** A
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

**Two gates**: `protocol.md` after define, `findings.md` after report. Nothing is scored before a
person has agreed what good means, and nothing is closed before a person has read what was
found.

## Not yet a stage: `failure_discover`

`/eval/mcp` also carries `failure_discover(observation_snapshot_id)` — DISCOVER, mining one
`plugin_profile` snapshot's own real refusals and stage returns for candidate failure modes,
before any protocol exists. It is not one of the five stages above and this flow does not call
it. A candidate it writes is a proposal, `status = 'candidate'`, until `zz-plugin-define`'s
`protocol_record` folds one in — naming it in a `failureTaxonomy` entry's `candidateId` accepts
it, `mergedCandidateIds` folds others into the same entry — which is a decision `zz-plugin-define`
makes, not this stage. Named here so `failure_discover` reads as this door's own tool rather
than an undocumented one, not as an instruction for THIS skill to call it.

## Not yet a stage: `evaluation_start` / `evaluation_assess` / `evaluation_score`

`/eval/mcp` also carries EVALUATE's own protocol-driven run — `evaluation_start(subject_version_id,
protocol_version_id, observation_snapshot_id, idempotency_key)` binds one `zz.eval_protocol_version`
to one plugin's own observation snapshot into an immutable `zz.eval_run`; `evaluation_assess(eval_run_id,
subject_refs, idempotency_key)` runs every measure the protocol's dimensions name against the
`subject_ref`s given it; `evaluation_score(eval_run_id, idempotency_key)` reduces what was
assessed into one deterministic score, its status, its guardrails and a bootstrap interval —
`scoreRun` itself calls no model. This is not one of the five stages above and this flow does not
call it yet: it replaces `round_judge`/`round_scores`/`round_score` for a plugin whose protocol is
a `zz.eval_protocol_version` (from `protocol_record`) rather than a legacy ruler, and Task I-28
wires it into this flow's own stages. Named here so the three tools read as this door's own
rather than undocumented ones. `finding_record(eval_run_id, finding, idempotency_key)` records
what an `eval_run` concluded the same way — a strength, a defect or an unknown, each naming
`owner_kind` — and `finding_decide` closes it, same as for a legacy round's finding.

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

❌ **Stopping because the trace block is thin.** A thin trace block is `not measured`, and that
is the honest answer — report it and move on, rather than treating it as a reason to stop.

❌ **Scoring before `protocol.md` is approved.** `protocol_affirm` refuses without an approved
document quoting the exact version's `content_digest`, and the refusal is the gate working.

❌ **Reading a number without its window.** `plugin_profile` returns the resolved `window` it
computed every fact over, and `stage_paths` carries each step's own timestamps — a three-week-old
figure presented as today's is worse than none.

❌ **Comparing two plugins.** Every ruler is that plugin's own, so two scores are two things
measured with two rulers. There is no leaderboard here and there is not meant to be.
