---
name: zz-plugin-report
version: 1.4
description: Stage 5 of plugin evaluation. Take the recommendation from the typed judge, read the scores back, and write findings.md — five sections, gated, and it closes the initiative.
when_to_use: "The last stage of zz-plugin-eval, after judge. Produces findings.md; approving it is what closes the evaluation."
---

# zz-plugin-report

```
round_scores(eval_id)       every score, the control's, the thresholds, the findings
finding_record(eval_id, …)  what recurred, and what change you expect it to move
round_score(eval_id)    the verdict — ONE WORD, and it is not yours to choose
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

**So `round_score` is not advisory and you do not overrule it.** If the word it returns
surprises you, that is the finding — write the paragraph explaining what the evidence shows and
let the word stand. An agent that reaches a different verdict in prose has reintroduced exactly
the failure the enum exists to remove. The one thing you may do is say, in section 1, that you
find it surprising and why.

**When the service has no key it reports EVIDENCE STRENGTH as absent, with the reason.** Both
axes are still good — they are computed from figures no model touched. Carry them, and say in
section 1 that evidence strength was not taken and why.

## The five sections

**`## 1 · Outcome`** — short. Four things and nothing else:

- **Effectiveness** — the score out of 10 from `round_score`, and the band it falls in,
  verbatim: `working well`, `working`, `working poorly`, `not working`, `not measurable`.
- **Room to improve** — the headroom state, verbatim: `no change needed`, `change identified`,
  `unexplained gap`, `not measured` — with the points short and the count of named changes.
- **Key numbers** — the same table every time, so two reports can be read side by side: each
  dimension's mean, the judge-on-trial gap, and every threshold met-or-not.
- **One paragraph** — why those numbers read that way. Written from them, not beside them.

**THERE IS NO RECOMMENDATION AND YOU MUST NOT INVENT ONE** — no `keep`, `keep-and-change` or
`retire`. Somebody installs a plugin for a reason and they keep it: telling them to retire it is
advice nobody takes, and telling them to keep it is information nobody needed. Your job is to report what was found, not what to do about it.

**THE TWO AXES ARE INDEPENDENT and section 1 must not blend them.** A plugin can score 9 and
still have a change identified; one at 5 with nothing identified is a worse position than a 5
with three changes waiting, because nobody knows why it is short. Never write the headroom into
the score's sentence — "working, with a defect worth fixing" asserts a defect the score cannot
establish.

Anything that is not one of those four belongs in a later section.

**`## 2 · What is good`** — each claim carrying the figure it rests on.

**`## 3 · What is bad`** — defects IN THE PLUGIN, each carrying its figure.

**`## 4 · What to do to improve it`** — the actions. A table reads best: what to change, the
finding id it was recorded as, and what you expect it to move. Every generic finding should
appear here; if one cannot, it was not a generic finding.

**`## 5 · What this does not establish`** — two things that belong together, because both
answer "do not read more into this than it says":

- what could NOT be measured, and why — thin evidence, a void control, a dimension with no
  subject to read
- what the numbers do not mean even though they exist — a ceiling score over n=3

## `not measurable` is a statement about the MEASUREMENT, never about the plugin

It is in the vocabulary because "we could not measure this" is a real and useful answer, and
reporting it as a low score defames the plugin. `not measurable` is the BAND; `not measured` is
the headroom state that goes with it. Neither is a rung on the scale — a plugin nobody could
measure and a plugin that does not work are different findings. The first report written on this platform made exactly
that mistake: zz-core's trace window held one event, its round was void, and the report called
the plugin weak. The plugin was not weak. The measurement was absent.

**Section 3 and section 5 are never merged for this reason.** *Bad* means the evidence shows a
defect. *Not established* means there is no evidence. A reader who cannot tell them apart cannot
act on either.

## Lead with whether the numbers can be trusted

**The control comes first, before any score.** If the real-vs-control gap is under 1.5 the ruler
failed to tell the right artifact from the wrong one, the round is void, and every mean below it
is noise. That belongs at the top of section 1, never in a caveat at the bottom — and `round_score`
returns no score at all when it happens, so the band reads `not measurable` and the headroom
state reads `not measured`. Say that the round establishes nothing and say what to re-run.

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

## A FINDING STAYS OPEN UNTIL SOMEBODY CLOSES IT, AND OPEN MEANS IT COUNTS

`round_score` reads **every finding still `deferred` on this plugin**, not just this round's,
and headroom counts them. So the second round of any plugin inherits whatever the first one
named and nobody acted on.

That is correct and it has a cost: a finding that was quietly done, or quietly abandoned, keeps
inflating the headroom of every later round. When this rule was written, in September 2026, every
finding ever recorded was still `deferred` — the ledger had three values and only ever held
one, because no tool could close a row.

```
finding_decide(decisions: [{ finding_id, decision: applied | rejected, note }])
```

`round_score` returns `open_changes`, each with its `finding_id` and the round that named
it. **Before you write section 4, read that list.** For each carried-over finding, one of three
things is true:

- **it was done** — `applied`, and the note says what changed and where: a version, a file, a
  release. The next round can check it.
- **it will not be done** — `rejected`, and the note says why. A change nobody intends to make
  is not headroom.
- **it is still waiting** — leave it. It belongs in section 4 beside this round's own.

A note is required for both real decisions, and `deferred` is refused as a decision: it is where
a finding starts, so choosing it would be a decision that changed nothing while looking like one
that did. Deciding is not this flow's call to make alone — `applied` and `rejected` are the
plugin owner's judgement, so ask when you are not the owner.

## After the close comes the handover

`findings.md` is this flow's closing document, so approving it lets `initiative_close()` record
the outcome — one call, naming who accepted it. That ends the EVALUATION, not the cycle.

`initiative_status` answers `action: "closed"` from that moment — the close is terminal and
nothing further is owed. `zz-handover` writes it, cold and afterwards: it reads the closed initiative, mints
what generalises onto the platform shelf, and proposes to the team shelf what only this team
needs. Report the evaluation closed; the handover is worth writing if the cycle taught
something, and is not owed.

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
