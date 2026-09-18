---
name: zz-plugin-report
version: 1.0
description: Stage 5 of plugin evaluation. Take the recommendation from the typed judge, read the scores back, and write findings.md — five sections, gated, and it closes the initiative.
when_to_use: "The last stage of zz-plugin-eval, after judge. Produces findings.md; approving it is what closes the evaluation and what admits the proposed cases into the suite."
---

# zz-plugin-report

```
round_scores(eval_id)       every score, the control's, the thresholds, the findings
finding_record(eval_id, …)  what recurred, and what change you expect it to move
round_recommend(eval_id)    the verdict — ONE WORD, and it is not yours to choose
```

Then `findings.md`, with the five sections the manifest declares — written with
`document_write`, put in front of the person with `document_present`, and approved by them with
`document_approve`. The fetch is not a formality: it is what puts the bytes on the record as
seen before the gate, and approving a document nobody fetched leaves the approval standing on
text the record cannot show anyone read.

## Which model decides what, because this is the whole design

**The typed judge fixes the numbers. You write what they mean. In that order.**

| | typed judge | you |
|---|---|---|
| the mark against named levels | ✓ | |
| whether a threshold is met | ✓ | |
| the recommendation enum | ✓ | |
| confidence and the distribution behind it | ✓ | |
| the one-sentence outcome | | ✓ |
| what is good, what is bad, what to do | | ✓ |
| why a mark landed where it did | | ✓ |

The ordering is the safeguard. A typed answer cannot be off-vocabulary or unparseable. A written
explanation cannot invent a score to suit its argument, because the score was settled before any
prose existed. Lose the order and you have neither guarantee.

**So `round_recommend` is not advisory and you do not overrule it.** If the word it returns
surprises you, that is the finding — write the paragraph explaining what the evidence shows and
let the word stand. An agent that reaches a different verdict in prose has reintroduced exactly
the failure the enum exists to remove. The one thing you may do is say, in section 1, that you
find it surprising and why.

**When the service has no key it reports the judgement as absent, with the reason.** Write the
report without a recommendation and say so in section 1. Do not substitute a word of your own.

## The five sections

**`## 1 · Outcome`** — short. Four things and nothing else:

- **Recommendation** — the enum from `round_recommend`, verbatim: `keep`, `keep-and-change`,
  `re-run`, `not-evaluable`, `retire`.
- **Confidence** — the number it returned, and the runner-up option if the distribution is not
  concentrated. A 0.42 spread across two options is a different message from a 0.95.
- **Key numbers** — the same table every time, so two reports can be read side by side: each
  dimension's mean, the judge-on-trial gap, every threshold met-or-not, the case delta.
- **One paragraph** — why those numbers support that word. Written from them, not beside them.

Anything that is not one of those four belongs in a later section.

**`## 2 · What is good`** — each claim carrying the figure it rests on.

**`## 3 · What is bad`** — defects IN THE PLUGIN, each carrying its figure.

**`## 4 · What to do to improve it`** — the actions. A table reads best: what to change, the
finding id it was recorded as, and what you expect it to move. Every generic finding should
appear here; if one cannot, it was not a generic finding.

**`## 5 · What this does not establish`** — two things that used to be separate sections and
belong together, because both answer "do not read more into this than it says":

- what could NOT be measured, and why — thin evidence, a void control, a dimension with no
  subject to read
- what the numbers do not mean even though they exist — a ceiling score over n=3, a delta that
  measures reachability rather than whether anybody is better off

## `not-evaluable` is a verdict about the MEASUREMENT

It is in the enum because "we could not measure this" is a real and useful answer, and reporting
it as a low score defames the plugin. The first report written on this platform made exactly
that mistake: zz-core's trace window held one event, its round was void, and the report called
the plugin weak. The plugin was not weak. The measurement was absent.

**Section 3 and section 5 are never merged for this reason.** *Bad* means the evidence shows a
defect. *Not established* means there is no evidence. A reader who cannot tell them apart cannot
act on either.

## Lead with whether the numbers can be trusted

**The control comes first, before any score.** If the real-vs-control gap is under 1.5 the ruler
failed to tell the right artifact from the wrong one, the round is void, and every mean below it
is noise. That belongs in section 1 beside the recommendation, never in a caveat at the bottom —
and `round_recommend` will usually answer `re-run` when it happens, which is the correct word.

Then the coverage. A verdict drawn from 198 of 510 events is a verdict about 198 events, and the
sentence says so.

## Findings: generic means you can name the change

`finding_record` refuses a generic finding that proposes no change, and the refusal is right.
Generic means *this is the plugin's habit and worth changing the plugin over* — so say what
change and what you expect it to move. If you cannot, it is an observation about one round:
scope it `specific`, or leave it in the prose where a reader can weigh it without the platform
treating it as a claim about the plugin.

An observation that something is GOOD is never a generic finding. It has no proposed change by
construction. It belongs in section 2.

## ONE CHANGE, AND SAY WHAT YOU EXPECT IT TO DO

**A generic finding proposes ONE change and what you expect it to move.** Two changes in a round
make the next round unable to attribute either — the number moves and nothing says which change
moved it. And a recommendation with no stated expectation cannot be contradicted, which means it
can never be wrong, which means it was never a measurement.

**Say where the change happens.** The catalog is read-only wherever the platform runs: nothing
in this flow edits a plugin, and `finding_record` lands everything `deferred` for that reason. A
change is **a repository edit and a release by whoever owns the plugin**. A recommendation that
does not say so dead-ends in a document nobody can act from.

## After the close comes the handover

`findings.md` is this flow's closing document, so approving it lets `initiative_close()` record
the outcome — one call, naming who accepted it. That ends the EVALUATION, not the cycle.

`initiative_status` then answers `action: "handover"` until `handover.md` exists and is
approved. `zz-handover` writes it, cold and afterwards: it reads the closed initiative, mints
what generalises onto the platform shelf, and proposes to the team shelf what only this team
needs. Report the evaluation closed and say the handover is what remains.

## Pitfalls

❌ **Writing a verdict in prose that differs from the enum.** The enum is the verdict.

❌ **Quoting a void round's means.** If the control failed, those numbers are not results. Say
the round is void and report no mean.

❌ **Padding section 4.** Zero actions is a correct outcome for a plugin that is working.

❌ **Merging sections 3 and 5.** See above — it is the mistake that produced the first wrong
report on this platform.

❌ **Comparing two plugins.** Every ruler is its own plugin's. Two scores taken under two rulers
are two things measured with two instruments, and a ranking of them means nothing.

❌ **Comparing across a change of judge.** The judge is recorded per round. Marks from the
reading judge and marks from the typed judge are two scales; put them in two tables or say which
is which.
