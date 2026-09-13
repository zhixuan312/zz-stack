---
name: zz-plugin-report
version: 0.1
description: Stage 5 of plugin evaluation. Read the scores back, say what the pattern is, propose the cases the next round should lock in, and write findings.md — which is gated and closes the initiative.
when_to_use: "The last stage of zz-plugin-eval, after judge. Produces findings.md; approving it is what closes the evaluation and what admits the proposed cases into the suite."
---

# zz-plugin-report

```
plugin_scores(eval_id)     every score, the control's, and the findings
```

Then `findings.md`, with the six sections the manifest declares.

## The six sections, and what each is for

The manifest declares them and this stage writes all six.

**The verdict** — one paragraph, at the top, that a person can act on. Whether the plugin does
the job it claims, on which evidence, and how far you would trust it. If the control failed,
the verdict is "this round is void" and nothing below it is a number.

**What the evidence says** — the findings, each naming which block it rests on.

**Where the evidence is thin** · **Proposed cases** · **Recommendation** · **What this does not
say** — below.

## Lead with whether the numbers can be trusted

**The control comes first, before any score.** If the control scored close to the real pairing,
the round is void and every number below it is noise — a reader must learn that before they read
anything they might act on, not in a caveat at the bottom.

Then the coverage. A verdict drawn from 198 of 510 events is a verdict about 198 events, and the
sentence has to say so.

## Say what the evidence says, and which evidence

The two blocks answer different questions and a finding has to name which one it rests on:

- a **case** finding is causal — the plugin made the difference, because the arm without it did
  not.
- a **trace** finding is real but not causal — this is what happened, with this plugin
  installed, in work somebody actually did.

A finding that mixes them without saying so is a claim nobody can check.

## Record the findings, not just write them

```
plugin_finding_record(eval_id, findings)
```

`findings.md` is what a person reads. These rows are what the NEXT round reads — a finding that
exists only in prose cannot be asked "did this recur?" six weeks later, and that question is
the whole reason to keep a series.

Each is **generic** (it recurs across unrelated work, so it is the plugin's habit and worth
changing the plugin over) or **specific** (one piece of work's own problem). The tool refuses a
generic finding with no proposed change, and the refusal is the same argument as the
Recommendation section below: a claim about the plugin that names no change leaves the next
round nothing to test against.

For somebody else's plugin, findings carry no proposed change at all. We assess and stop.

Recording is not deciding. A finding lands `deferred`; applying or rejecting it is a separate
act by whoever owns the plugin.

## Where the evidence is thin

Its own section, and it is not an apology. "Four usable runs, so nothing here rests on trace
evidence" is a complete and useful finding — it tells a reader what the next round needs.
**A plugin nobody has used is a correct outcome**, and the honest report of it is more valuable
than a number computed from two runs.

## Proposed cases — the section that makes the next round better

This is where the loop closes, and it is the most valuable thing this stage produces.

A trace finding says *what happened once*. A case says *whether it still happens*. So every
finding that could recur becomes a proposed case here, with its provenance:

```markdown
### recovers-from-a-bad-spec  (new)
  from: this round's `returns` — spec-audit sent the spec back three times
  locks: that a flow can return to an earlier stage and re-ground
  expected Δ: high — a bare agent would edit forward rather than go back

  <the case.yaml, whole>
```

**Approving `findings.md` is what admits these into the suite.** Same reasoning as the ruler:
a case defines what good means, and a system that writes its own cases and then grades itself
against them is a candidate setting its own exam.

Prefer graders that cost nothing — `tool_order`, `tool_used`, `regex`, `file_exists` — over
`llm`, which is a paid model call per run. And a case that both arms pass tests nothing about
the plugin: say the delta you expect and why, so a later reader can tell a regression from a
badly written case.

## Recommendation — ONE CHANGE, AND SAY WHAT YOU EXPECT IT TO DO

Say what to change and why. **Do not change it.**

**One change, with its expected effect stated.** Not a list of five improvements — one, named,
with the number you expect it to move and roughly how far. "Drop /manage from sdlc's servers;
never_called should fall from 6 to 3" is a recommendation the next round can contradict.
"Tighten the plan stage" is not, and a recommendation nothing can contradict is one nobody can
learn from — it reads as vindicated whatever happens next, which is the opposite of evidence.

Five changes at once have the same problem in a different shape: if the next round moves, you
cannot say which one moved it. The catalog is read-only wherever the platform
runs, and that is what keeps every agent's copy of a skill identical to what the gate checked.
The change is a repository edit and a release by whoever owns the plugin.

For somebody else's plugin there is no recommendation at all — we assess and stop.

## What this does not say

An explicit section, because the honest limits are part of the finding. Cases score prompts
somebody imagined; traces see only what has been run. Neither sees the path nobody has taken.

## Closing

Write it with `write_file`, then fetch it back with `show_document` and put what THAT returns in
front of the person. They are approving the document, not your account of it — and a write that
succeeded is not a document anybody read.

`findings.md` is gated and closing. Once a person approves it, close the initiative directly —
one `close()` call, as `zz-backbone` describes — and say plainly whether the evaluation reached
a verdict or stopped for want of evidence. Both are complete outcomes; only one of them is a
score.

**The close ends the evaluation, not the cycle.** `initiative_status` returns
`action: handover` afterwards, and `zz-knowledge` is what writes it — cold, after the work is
over. Report the initiative closed and say the handover is what remains.

## Pitfalls

❌ **Burying the control at the bottom.** It decides whether the rest is readable.

❌ **A verdict without its coverage.**

❌ **Mixing a case finding and a trace finding in one sentence.**

❌ **Proposing a case with no expected delta.** Nobody can tell later whether it broke or was
always useless.

❌ **Making the change.** This flow measures.

❌ **Padding "Proposed cases" to look productive.** Zero is a correct answer when nothing this
round could recur.
