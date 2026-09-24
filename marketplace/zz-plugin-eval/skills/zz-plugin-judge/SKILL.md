---
name: zz-plugin-judge
version: 0.5
description: Stage 4 of plugin evaluation. Score the plugin's usage artifacts against the ruler already in force with a pinned model outside this conversation. Writes scores; decides nothing.
when_to_use: "The fourth stage of zz-plugin-eval, once a ruler is already recorded against this version. round_judge itself refuses when none is — that refusal is the gate working."
---

# zz-plugin-judge

```
round_judge(plugin, version, rubric_id, initiative, take: 1-4)  score, ONE per call
round_judge(..., eval_id, take: 1-4)                   again, until `remaining` is 0
round_judge(..., control: true)                        and once blind — see below
```

**THIS STAGE MARKS AGAINST A LEGACY RULER (`zz.rubric`), NOT A PROTOCOL.** `round_judge` and
`round_scores` were left unchanged when Task I-10 moved the define stage onto
`protocol_read`/`protocol_record`/`protocol_affirm` — every ruler any version already declares
(`rubric_id`, read straight off the version) stays exactly as scorable as it was. There is no
tool that records a new one any more; `rubric_id` is either already set or it is not.

**PASS THE INITIATIVE ON THE FIRST CALL.** `initiative` is the evaluation initiative you are
working inside — the one whose `findings.md` you will write. It is recorded on the round, which
is what lets a score be read back to the report that explains it, and a report back to the rows
behind it. Nothing infers it: joining a score to its report by plugin name and a date is right
until two rounds of one plugin land close together, and that class of guess is what journal 0116
was minted for. Continuation calls carry `eval_id` and do not repeat it; the control inherits it
from the round it controls.

**`round_judge` MARKS ONE SUBJECT PER CALL.** It returns an `eval_id` and a `remaining`
count; call it again with that `eval_id` until `remaining` is 0. `take` (1–4) says how many
to mark in one call. A single call is not a round — it is one subject scored.

**You are not the judge, and this stage is where that matters most.**

## Why the judge is not you

`round_judge` takes identifiers and nothing else. It assembles the ruler and the subjects
itself and runs a model the deployment pins. The caller cannot supply the artifact, cannot
supply the ruler, and cannot supply the model.

A judge that varies with the conversation makes every number incomparable with every other
number — including with the same plugin's own score last month, which is the comparison the
whole thing exists to support. The cost of that is higher than the cost of having no numbers.

So: you call it, you read what it returns, and your own opinion of an artifact goes in
`findings.md` as an observation. Never in the table as a score.

## What gets scored

**Usage artifacts only** — the documents this plugin's runs produced, and the traces of those
runs. Never a skill's own text. What a skill *says* is what the gate already checks at release;
what it *did* is the only thing an evaluation adds.

## The blind control

Every round also scores an artifact that does not belong under this ruler, and **it is a
separate call you make deliberately**: `round_judge(..., control: true)`. Nothing runs it for
you. Run the round plainly and run it once with `control: true` — one without the other is not
a measurement, and the report will ask you to lead with a control that was never produced.

If the control scores
as well as the real pairing, the judge was rewarding confident prose rather than reading, and
**the round is void** — say so in the report and do not average the scores in anyway.

The control is unchanged from how this platform has always run it. Do not redefine it: a
different control starts a series that cannot be compared with the previous one, and the point
of a series is comparison.

## If round_judge refuses

- **No ruler declares this version.** `zz.plugin_version.rubric_id` was never set for it. There
  is no way to set one going forward (Task I-10) — score a plugin that never had a ruler through
  the protocol lifecycle instead (`protocol_read`/`protocol_record`/`protocol_affirm`), which is
  what defines "good" for a version from here on.
- **The sheet moved under an affirmed ruler.** A quantitative dimension's `reads` no longer
  resolves against `plugin_profile`'s current sheet — a figure stopped being computed, or a door
  that used to write documents no longer does. `round_judge` names exactly which figure moved.

## Pitfalls

❌ **Scoring your own reading into the table.**

❌ **Re-running the judge until the numbers look better.** Every run is stored; a series with
the bad rounds quietly dropped is not a series.

❌ **Ignoring a control that scored high.** It is the only signal that says whether any of the
other numbers mean anything.

❌ **Judging a plugin whose profile said both evidence blocks were empty.** There is nothing to
read. Stop at profile and say so.
