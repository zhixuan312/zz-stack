---
name: zz-plugin-define
version: 0.1
description: Stage 3 of plugin evaluation, and the one gate that matters most. Derive what good means for THIS plugin from its own profile, write it into rulers.md, and get a person to agree it before anything is scored.
when_to_use: "The third stage of zz-plugin-eval, after profile. Produces rulers.md, which is gated — judging does not start until somebody approves it."
---

# zz-plugin-define

```
plugin_ruler(plugin, version)   the profile, the cases, and the unscored artifacts
```

Then you write `rulers.md`, and **a person approves it before anything is scored.**

## Every plugin gets its own ruler

Not a shared rubric with a plugin name at the top. `sdlc` is a delivery method whose worth is
whether a stranger could execute what it produced; `zz-access` is a credential surface whose
worth is whether it refuses correctly. One scale over both would measure neither.

Which is also why **there is no comparing plugins here**. Two scores from two rulers are two
things measured with two instruments.

## Two kinds of dimension, and the second one is where the boundary lives

**Qualitative** — a reader scores 1–5 against two ends you write out:

```
document depth      qualitative
  5 = a plan a stranger could execute to the finished thing
  1 = a list of headings
```

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
later to make a result come out differently, and nobody would be able to tell. `plugin_affirm`
refuses a quantitative dimension whose threshold is empty; nothing but this document refuses one
whose reason is empty, so refuse it yourself.

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
from. A `recovery` dimension read from cases and a `recovery` dimension read from traces are not
the same measurement, and a reader six months later cannot tell them apart unless you say.

## Writing it

`write_file` into the initiative as `rulers.md`, with the three sections the manifest declares,
spelled exactly:

- `## The plugin under evaluation` — name and version and digest, from locate.
- `## What good means here` — the dimensions, with anchors or thresholds.
- `## The evidence each dimension reads` — cases, traces, or both, per dimension.

Then `show_document` it and put what comes back in front of the person. They are approving this
document, not your account of it. Record their agreement with `approve` the moment it arrives,
under their name, in the same turn — `zz-backbone` carries that rule and it holds here.

## Pitfalls

❌ **A quantitative threshold with no reason.** It is a number nobody can defend later.

❌ **Deciding the line after seeing the scores.** That is the failure this gate exists for.

❌ **Reusing another plugin's ruler because it looks similar.**

❌ **A dimension that does not say which evidence block it reads.**

❌ **Proceeding to judge on a draft.** `plugin_affirm` will refuse, and it is right to.
