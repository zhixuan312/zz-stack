---
name: "tldr"
description: "Compress a long document, thread, or transcript down to what the reader actually needs to act on — the decisions, the open questions, and what changed, not a proportional summary of everything."
when_to_use: "The person typed /zz-core:tldr."
disable-model-invocation: true
---

# /zz-core:tldr

A command that makes a long or difficult source understandable in about three minutes —
`/zz-core:tldr` on Claude Code, a matched skill on Codex. It runs entirely in your own context:
no platform tool is called and nothing is dispatched.

It arrives with the `zz-core` plugin, which every account carries, as `/zz-core:tldr` on Claude
Code and as a matched skill on Codex. No flow has to be installed for it to be there.

**The result always has two reading layers.** The TLDR comes first and gives the source's shape at
a glance. The supporting detail follows, and carries the context, qualifications, key points,
omitted topics, and coverage that the TLDR cannot hold. The name asks for brevity. The reader needs
brevity **and** the context they were missing. Deliver both layers, every time.

The reader invokes this command when a source is too long to read, too hard to follow, or both. The
reader never states which. Work out the cause yourself.

## 1. Select the source

**Load `zz-authoring` first, then come back here.** It carries how the source is chosen
from what the reader typed, and the writing rules this result is held to. Both were copied
into this file and into zz-deck, and had already drifted apart.

Say what you read in the Coverage line.

## 2. Select a mode

| Mode | When | Effect |
|---|---|---|
| Compress mode | long but understandable | the result is much shorter than the source |
| Explain mode | short but difficult | the result may be longer than the source |
| Compress and explain mode | long and difficult | much shorter, and adds definitions |

Name the selected mode in the Coverage line, using these exact mode names.

## 3. Budget

| Part | Limit |
|---|---|
| TLDR | 80 English words maximum |
| Whole result | 350 to 450 English words for a source that needs it, 500 maximum |

**The whole-result limit includes the TLDR and every other visible section.** All visible words
count, including words inside tables. Use a table only when a table makes a comparison easier.

Every number above is a ceiling. None of them is a target — the table named one and this line
denied it, which is an invitation to pad up to 350. A short source gives a short result.

**Scaling.** The default time budget is three minutes. When the reader gives another budget,
compute `factor = requested minutes / 3`, then multiply the whole-result target and maximum by that
factor. **Hold the TLDR at 80 words.** Raise the TLDR to 100 words only when the requested budget is
ten minutes or more. A TLDR that grows with the body stops being readable at a glance.

An English word count does not measure Chinese or other non-English length. For non-English output,
keep the three-minute goal and judge length by reading time, not by the word numbers above.

## 4. Rank the key points

**Rank by decision impact. Preserve traceability, not source order.** Priority order, with source
order only as a tie-breaker:

1. Required decisions and actions
2. Risks, costs, blockers, and deadlines
3. Main conclusions and recommendations
4. Supporting reasons and evidence
5. Examples, history, and background

**A condition stays with its claim.** Never rank a claim and its condition as two key points.

**A decision and the risk that motivates it are one key point, not two.** Lead with the decision,
then give the risk the decision prevents. Ranking them separately either puts the reason several
points away from the action, or forces the risk above the decision it exists to explain.

```
Split — wrong:
  1. Risk: uncommitted work is swept into the release commit.
  ...
  4. Decision: cut the branch before committing.

Merged — right:
  1. Decision: cut the branch before committing. Committing first puts your
     in-progress work on the source branch, where a later `git add -A`
     sweeps it into the release commit.
```

A dense source states a rule, justifies it, gives an example, then restates it in a closing section.
Those four passages are one key point. State the key point once.

**Give each key point a source reference.** Use the source heading when one exists. Otherwise use a
file path and line range, a page, a paragraph number, a message section, or a short topic label.
**Never invent a heading and present it as a source heading** — many sources have no headings at
all, including a pasted paragraph, a chat transcript, and a previous assistant message.

## 5. Write the result

```
TLDR
  80 words maximum. What the source says, and the practical implication the source
  supports. Never add an implication the source does not support.

Required context
  Only the terms and background that block understanding. Omit when nothing blocks.

Key points
  Numbered. Ranked by decision impact. Prefix a point with Decision:, Risk:, Cost:,
  or Unknown: when one applies. Each point carries its source reference, and keeps
  its material qualification.

Omitted topics
  Numbered. Material topics by name; related lower-level detail grouped.
  Omit when the whole source is represented.

Coverage
  Full or partial access · mode · any access limitation · approximate sizes.
```

Decisions, risks, and costs are the highest-ranked key points, so they sit at the top of Key
points. Do not give them a separate section — a separate section would display the
highest-priority items after the lower-priority ones.

Number the key points and the omitted topics, so the reader can say "expand key point 3".

Repetition between the TLDR and the body is expected. The TLDR is a separate reading layer.

Coverage examples:

```
Coverage: Full source read · Explain mode · 180 source words → 240 result words.
Coverage: Full source read · Compress and explain mode · about 7,200 source words → 480 result words.
Coverage: Partial source read · Compress and explain mode · read the page body but not the
          linked appendices · about 4,200 read words → 430 result words.
```

## 6. Fidelity

**Compress the explanation. Never compress the qualification.** An ordinary summary keeps the
claims and drops the conditions, so the reader finishes more confident and less correct.

> Do not omit a material qualification attached to an included claim, when the omission would
> change the claim's meaning, confidence, risk, or required action.

You may drop a whole low-priority key point, provided you name the topic. You may not keep a claim
while deleting the qualification that makes the claim accurate.

```
Not acceptable:  The migration can finish in two days.
Acceptable:      The migration can finish in two days, but only after the source data
                 passes validation.
```

At TLDR length, when a qualification does not fit, say the qualification exists: "this works, but
only under conditions — see key point 4."

**Never omit a material topic silently.** Name each omitted top-level topic that could change a
decision, an interpretation, a risk, or a required action. Group other omitted topics by source
section or topic family. When even that list cannot fit the budget, say the result is selective,
state the selection rule, and name the largest omitted areas.

**Separate source content from your own explanation.**

- Use the source's own explanation when the source has one.
- Label a definition you added, and which the source does not contain, as background.
- When you infer a missing premise, write "The source appears to assume…". Never present an
  inferred premise as a source claim.
- When a specialised term could carry several meanings, say the source does not define it. Never
  select one meaning silently.

Do not add certainty the source does not carry. When a passage is ambiguous, say the passage is
ambiguous and give the readings. When the source states a decision with no reason, say the reason is
absent; never invent one.

**Exact text.** When exact wording is material, copy the minimum necessary text exactly. Always copy
an included command, path, identifier, configuration value, schema field, API name, or quotation
exactly. You may summarise legal text; label the summary as a summary, and never put a paraphrase
inside quotation marks.

## 7. Output language

Select the output language in this order. The first that applies wins.

1. An output language the reader named explicitly.
2. The language of the reader's instruction that accompanies the command.
3. The language of the source.

```
/zz-core:tldr 用英文写      → English. The reader named English explicitly.
/zz-core:tldr please explain this → English. The accompanying instruction is English.
/zz-core:tldr report.md     → the source's language. The reader gave no language instruction.
```

This command does not translate between languages by default.

## 8. Output destination

Reply in the chat. Write the result to a file only when the reader explicitly asks for a file, and
never overwrite the source.
