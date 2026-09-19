---
name: zz-plugin-define
version: 1.3
description: Stage 3 of plugin evaluation, and the one gate that matters most. Derive what good means for THIS plugin from its own profile, write it into rulers.md, and get a person to agree it before anything is scored.
when_to_use: "The third stage of zz-plugin-eval, after profile. Produces rulers.md, which is gated — judging does not start until somebody approves it."
---

# zz-plugin-define

```
ruler_read(plugin, version)   the profile and the unscored artifacts
```

Then you write `rulers.md`, and **a person approves it before anything is scored.**

## Every plugin gets its own ruler

Not a shared rubric with a plugin name at the top. `sdlc` is a delivery method whose worth is
whether a stranger could execute what it produced; `zz-access` is a credential surface whose
worth is whether it refuses correctly. One scale over both would measure neither.

Which is also why **there is no comparing plugins here**. Two scores from two rulers are two
things measured with two instruments.

## Two kinds of dimension, and the second one is where the boundary lives

**Qualitative** — you NAME EVERY LEVEL, low end first, between two and ten of them:

```
document depth      qualitative
  levels:
    1  a list of headings, or prose restating the request
    2  a plan with steps, but a stranger would have to ask what each one means
    3  executable by somebody who already knows this system
    4  executable by a stranger, with one or two things left implicit
    5  a stranger could execute it to the finished thing, author absent
```

**Two ends and a number is not a scale.** The old form wrote only `5 =` and `1 =` and left the
three rungs between them to whoever was marking — so two rounds marked the same artifact
differently for no recorded reason, and neither could say why. `ruler_record` refuses a
qualitative dimension with no levels for exactly that reason.

It is also what lets the TYPED judge mark it. That service is asked against described levels and
returns a continuous position between them with the distribution behind it; it cannot be asked
against two ends and a number. A ruler that names its levels is marked by it; one that does not
stays with the reading judge, and the two are different scales.

**A level you cannot describe is one nobody should be asked to award.** If you find yourself
writing "3 = somewhere in between", you have four levels, not five. Say four.

**Quantitative** — a tool computes the fact, and **you** say where the line is:

```
tool fit            quantitative
  threshold: never_called ≤ 4 of 31
  why: six tools this plugin's own skills tell an agent to call, and no run ever
       called them, is a surface wider than the method. Four leaves room for the
       admin-side tools a delivery run legitimately never reaches.
```

The tool said `never_called: 6`. Only a person can say whether six is too many. That split is
the whole design: **facts from the tool, the line from you.**

**`why` is not decoration.** A threshold with no stated reason is a number somebody can move
later to make a result come out differently, and nobody would be able to tell. `ruler_affirm`
refuses a quantitative dimension whose threshold is empty; nothing but this document refuses one
whose reason is empty, so refuse it yourself.

## THE JUDGE IS HANDED THE ARTIFACT'S TEXT, AND NOTHING ELSE

Before you write a qualitative dimension, name the artifact the judge will read — a document's
markdown, a run's transcript, both ends of an initiative — and then ask: **is the answer IN
that text?**

If the answer lives in a row, a count, a status or a timestamp, **the dimension is quantitative**
and a qualitative one will measure something other than its own name.

This was paid for. A ruler carried "a version change was caused by evidence" as a qualitative
dimension and it scored 3.14. The report proposed one change — make `zz.doc.evidence` carry the
document's cause — and said it expected the mark to rise. The change shipped and worked: 0
documents to 64, verified by query. **The mark went DOWN, to 2.85.** The judge reads markdown
and never sees a column, so no change to the record could have moved it. Rewritten as a
threshold over the same figure, the question became answerable and returned a real finding.

Removing it also raised **both** remaining qualitative dimensions and widened the judge-on-trial
gap, with no change to the plugin. A dimension the judge cannot answer does not merely fail to
measure — its noise spreads into the ones beside it.

## STATE THE ARITHMETIC, DO NOT MAKE THE JUDGE DO IT

A threshold is read by a judgement service that answers a probability. Give it a comparison it
can make directly.

❌ `at most one third of the tools this plugin's skills name appear in never_called, counted
over every call recorded on its own door, across all versions`
✅ `the count of never_called is at most a third of tools_named_count`

Both describe the same line. The first came back at **80% with confidence 0.60** — the service
reporting that it was not sure, because clearing it means working a fraction of a count out of
a sentence. The two sharp lines in the same round answered **3%** and **96%**. **A vague
threshold reports its own vagueness**, which is useful, and is not what you want the round to
spend its certainty on.

Name the two fields the comparison is between, and let the sheet supply both numbers. Do not
write either figure into the threshold itself — a ruler carrying today's count is a ruler that
is wrong after the next release.

## NAME THE FIGURE, AND THE PLATFORM WILL CHECK IT EXISTS

Every quantitative dimension carries `reads` — the dotted path(s) into the facts sheet its line
is drawn over, like `record.revised_with_evidence_pct` or `refusals.total`. `ruler_record`
resolves each one against **this plugin's own sheet** and refuses the ruler if any is missing,
listing every figure the sheet does carry.

**This is a gate and not paperwork, because a line that cannot reach its figure does not come
back unanswered — it comes back FAILED.** The threshold pass is instructed to answer NOT MET
when the facts lack the figure a line needs, so an unanswerable line scores 1, and
`zz.eval_score` holds 1 for that and 1 for a line the plugin really missed. Nothing afterwards
can tell them apart.

It costs twice, in opposite directions: the score is **deflated**, because the void line counts
against the quantitative half, and the headroom is **inflated**, because the same line counts as
a named change. zz-plugin-eval 0.56.0 was scored 7.06 where the same marks otherwise give 9.06
— a whole band — and its closed report made the void line its headline finding. It was false.

**The same figure is not on every plugin's sheet.** `record` is null for a plugin whose door
writes no documents, so `record.revised` is a legitimate line on zz-core and unanswerable on
sdlc. Resolve against the sheet in front of you, not the one you remember.

## IF THE PROPERTY IS ONLY TRUE AFTER THE ROUND, ENFORCE IT — DO NOT MEASURE IT

Some lines cannot be thresholds no matter what figure you add, and the tell is the timing.

zz-plugin-eval's ruler carried *"every non-control round recorded against this plugin version
has a control round naming it"* — a fair line, drawn deliberately against the flow's own central
claim. It could never be met. The threshold pass runs on the **real round**, and the control is
recorded **after** it. At the instant the line is applied, this round's control does not exist,
so the line is false by construction whatever the truth is. Computing the figure would not have
helped.

The answer was not a better threshold. It was `round_recommend` refusing a round no control
names. **A rule enforced at the door needs no line, no figure and no judge — it is true by
construction, and the ruler is shorter.** Before writing a threshold, ask whether the thing you
want is a measurement or a rule. If a round could violate it and still finish, it is a
measurement. If it should be impossible, it belongs in the tool.

## The threshold is written before any artifact is scored

That ordering is the only guard against a ruler written to flatter the number it will produce.
Write the line, get it agreed, then judge. Never look at the scores and then decide where the
line should have been.

## Recovery is the worked example — use it

`returns: 3` is the fact. Whether three returns is a flow that re-grounds well or one that
thrashes is not in the data, and the same count means both.

The initiative that designed this flow returned three times: each time an audit found a real
defect and the spec went back and got better. That is the method working. A different plugin
returning three times because it could not settle on an approach is the method failing. **Same
number.** So the dimension has to say which it means:

```
recovery            quantitative
  threshold: returns ≥ 1 AND every return followed an audit finding
  why: a flow that never goes back is either perfect or not looking. What we want
       is evidence it CAN re-ground, not an absence of evidence that it cannot.
```

Note that the threshold there is a floor, not a ceiling — which is exactly the kind of judgement
no tool could have made.

## Say which evidence each dimension reads

The two blocks answer different questions and a dimension has to name which one it is scored
from. A `recovery` dimension read from one plugin's traces and the same name read from another's are not
the same measurement, and a reader six months later cannot tell them apart unless you say.

## Recording it, then writing it

The ruler has to exist in two places and they are not the same act.

```
ruler_record(plugin, version, rubric_version, subject, dimensions)
```

puts it in the registry, where the judge reads it. It refuses a quantitative dimension with no
`threshold`, with no `threshold_reason`, or whose `reads` name a figure that is not on this
plugin's sheet; and a qualitative one missing its levels. All for the same reason: a dimension
a marker cannot place is one that gets placed by mood, a line with no stated reason is a number
somebody can move later to make a result come out differently, and a line that cannot reach its
figure is scored as a failure the plugin never earned.

`ruler_affirm` checks the figures again, because the sheet can move while the document is with
the stakeholder.

**Record before the person reads it, approve after.** Recording is not approving — nothing is
scored until `ruler_affirm` says a person agreed.

## Writing it

`document_write` into the initiative as `rulers.md`, with the three sections the manifest declares,
spelled exactly:

- `## The plugin under evaluation` — name and version and digest, from locate.
- `## What good means here` — the dimensions, with anchors or thresholds.
- `## The evidence each dimension reads` — which computed figure or which artifact, per dimension.

Then `document_present` it and put what comes back in front of the person. They are approving this
document, not your account of it. Record their agreement with `document_approve` the moment it arrives,
under their name, in the same turn — `zz-platform` carries that rule and it holds here.

## Pitfalls

❌ **A quantitative threshold with no reason.** It is a number nobody can defend later.

❌ **Deciding the line after seeing the scores.** That is the failure this gate exists for.

❌ **Reusing another plugin's ruler because it looks similar.**

❌ **A dimension that does not say which evidence block it reads.**

❌ **Proceeding to judge on a draft.** `ruler_affirm` will refuse, and it is right to.
