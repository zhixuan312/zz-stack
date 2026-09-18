---
name: zz-plugin-judge
version: 0.3
description: Stage 4 of plugin evaluation. Confirm the ruler was approved, then score the plugin's usage artifacts against it with a pinned model outside this conversation. Writes scores; decides nothing.
when_to_use: "The fourth stage of zz-plugin-eval, once rulers.md is approved. Never before — the affirm call refuses, and that refusal is the gate working."
---

# zz-plugin-judge

```
ruler_affirm(plugin, version)                          is there an approved ruler?
round_judge(plugin, version, rubric_id, take: 1-4)     score, ONE subject per call
round_judge(..., eval_id, take: 1-4)                   again, until `remaining` is 0
round_judge(..., control: true)                        and once blind — see below
```

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

## If affirm refuses

It refuses for exactly two reasons, and both are the design working:

- **No approved ruler.** `rulers.md` is a draft, or nobody has approved it. Go back to
  `zz-plugin-define` and get agreement. Do not score against a draft.
- **A quantitative dimension has no threshold.** Someone wrote a dimension that says a tool
  computes a number and never said what number is good enough. That is not a scoring problem to
  work around; it is an unfinished ruler.

## Pitfalls

❌ **Scoring your own reading into the table.**

❌ **Re-running the judge until the numbers look better.** Every run is stored; a series with
the bad rounds quietly dropped is not a series.

❌ **Ignoring a control that scored high.** It is the only signal that says whether any of the
other numbers mean anything.

❌ **Judging a plugin whose profile said both evidence blocks were empty.** There is nothing to
read. Stop at profile and say so.
