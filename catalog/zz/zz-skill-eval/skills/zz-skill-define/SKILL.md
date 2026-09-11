---
name: zz-skill-define
version: 0.5
description: Settle which definition of good judges which skill version, and get that agreed before anything is scored. The flow's first gate. Writes rulers.md.
when_to_use: "The profile is done. Nothing may be judged until this gate is approved — a score taken with an unconfirmed ruler cannot be compared with anything."
---

# zz-skill-define

**The gate of this flow, and the only one.** What it protects is comparability: a number is
meaningless without the scale it was taken on, and a scale that changed silently makes two
rounds disagree for a reason nobody can see.

## First, mechanically: did the skill actually change?

**Run the script. It answers this without interpretation.**

    eval_skill_ruler(skill: "<name>")

A version bump is not evidence that anything moved. `content_hash` covers the whole file, so
it changes every time `version:` is bumped — the one edit guaranteed to accompany a version
and to say nothing about the skill. A gate built on that fires on every re-date and every
reflow, and **a gate that always fires is one people learn to click through.**

`body_hash` (migration 030) is sha256 of the text below the frontmatter. Same body, different
frontmatter, same hash.

## The four outcomes, and only these

The script exits 0 when there is nothing to decide and 1 when there is.

| what it found | what happens |
|---|---|
| the version declares a ruler, and its body is identical to the version before | **carry straight on.** The bump was frontmatter; there is no decision to put to anybody |
| the version declares a ruler, and nothing suggests it moved | **carry straight on.** Reuse it; the round stays comparable |
| the version declares no ruler, or its body changed | **a decision** — re-affirm or derive, then approve |
| the skill has no rubric at any version | **write one** — nothing can say whether it works, whether a change helped, or what better looks like |

**Do not stop the stakeholder when the script says carry on.** The gate exists to protect
comparability, not to collect signatures.

**When it cannot tell, it asks.** Versions released before `body_hash` have none, and their
bodies are not on disk to re-derive — so the comparison is impossible and the script treats
that as changed. A ruler re-affirmed unnecessarily costs one approval; a ruler carried past a
real change costs every number taken with it.

## When there IS a decision: the three questions

Take the newest rubric, **dimension by dimension**, and ask of each:

1. Does it still measure something this version does?
2. Does this version do something **new** that no dimension looks at?
3. Is a dimension now measuring the wrong thing?

A version often moves from 1.0 to 1.1 because somebody gave the skill a capability it did not
have. That is exactly when a rubric silently stops covering the skill: every dimension still
scores, nothing errors, and the new capability is simply never looked at.

**Re-affirm** when the answers are no, no, no. **Derive a new one** when a capability arrived
that nothing measures — and a changed dimension set is a NEW ruler, cut as a new rubric
version, whose scores are never averaged with the old one's.

## Where a definition of good comes from when there is none

A skill with no rubric cannot be improved, because nothing says what better would be. Ten
were written on 2026-09-04 for skills that had none, and they are the template:

- **document skills** — `eval-judge --derive` reads the corpus that skill produced and
  proposes dimensions from it. A rubric derived from real output beats one imagined.
- **non-document skills** — written by hand, and each dimension **names its evidence**: an
  event-log join, a refusal class, the state a block was left in. `ops-build`'s five are the
  worked example.
- **vendored skills** — score whether the copy earns its place beside the block's own live
  tools, never the prose, which is not ours to change.

**Both anchors, always.** A dimension with only a five is a wish: a judge given "excellent
means X" and nothing for the bottom invents the scale, and two rounds then disagree for
reasons nobody can read.

## Recording the decision

A decision that is not recorded is not a decision. `zz.skill_version.rubric_id` is what says
this version is judged by this ruler, and until 2026-09-04 the only thing that set it was
eval-store, as a side effect of storing a judged run — so re-affirming a ruler BEFORE judging,
which is this gate's entire purpose, had nowhere to land. You had to judge first to record the
ruler you were meant to agree on first.

    eval_skill_affirm(skill: "<name>", version: "<v>")

**Affirming is a separate act from loading, deliberately.** Loading puts a definition of good
in the table; affirming says a particular VERSION is judged by it. Doing the second implicitly
on every load would silently re-point older versions at a rubric nobody agreed applied to
them, and every score already taken under the old one would quietly change what it claimed to
measure.

Run it AFTER the stakeholder approves `rulers.md`, never before. The tool records their
decision; it does not make it, and it does not check that they made it — that is this stage's
rule and it stays with the person running the stage.

**If the ruler itself must change**, the rubric lives in the catalog at
`<skill>/evals/rubric.json` and is loaded by the platform team. Say so in `rulers.md` and stop:
a new definition of good is a change to the shelf, not something a run edits underneath itself.

## The headings, exactly

    ## Skills in scope
    ## The ruler for each version
    ## What changed

**These are the manifest's, and `approve` refuses a document that does not carry them.** Two
rounds in a row wrote the same content under headings of their own invention, were refused at
the gate, and spent a turn patching it back. The refusal names what is missing, which is the
guard working — but a heading you can be told in advance is not worth learning from a refusal.

Write the content under these headings the first time. What goes in each is below.

## Write `rulers.md`, then stop

- **Skills in scope** — each with its version and its rubric version.
- **The ruler for each version** — reused, re-affirmed, or newly derived. Say which.
- **What changed** — any rubric whose dimensions moved, and what that costs: a changed
  dimension set is a NEW ruler, cut as a new rubric version, and scores taken with the old
  one are never averaged with the new.

Then stop and put it to the stakeholder: `show_document("<initiative>/rulers.md")`, and
present what it returns before you ask. Approving this document is agreeing to the scale, and
a scale nobody was shown is not one they agreed to.
