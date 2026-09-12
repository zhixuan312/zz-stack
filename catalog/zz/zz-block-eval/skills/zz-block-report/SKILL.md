---
name: zz-block-report
version: 1.1
description: Stage 3 of block evaluation, and the only document it writes. The numbers, then the defects, then what we ask for — one report, gated, and it is what the block team receives. Writes findings.md.
when_to_use: "The three measurements are done. This is the whole output of a block evaluation."
---

# zz-block-report

**One document, and it is the one the block team reads.** There were two — a `defects.md` we
gated and a `handover.md` written for them — and the second was the first re-ordered for a
different audience. Two copies of one thing, which drift the moment either is edited, and
neither reader is served better than by one report written plainly enough for both.

Gated, because it leaves the platform. Anything asserted here about somebody else's system is
asserted in their inbox with our name on it.

**Gated, because this document goes to another team.** Anything asserted here about somebody
else's system is asserted in their inbox, with our name on it. A wrong defect report costs
their afternoon and our credibility, and both are hard to get back.

## What we found

**The section a reader meets first, and the whole answer in it.** One line per defect, in
words a stranger understands, with what we need from the block's team beside it. Everything
below this section is the evidence for it.

## The first ten lines, written out

**An engineer on the other team opens this and has thirty seconds.** Give them the whole
answer in that time, then the evidence for as long as they want it.

    # <block> — what we found, <date>

    We evaluated <block> on <instance> against <contract version>. We found <n> defects.
    Each one is re-tested against the running system today, with the read-back.

    | # | What breaks | What we need from you |
    |---|---|---|
    | D1 | <one line, no jargon> | <confirm / fix / tell us X> |

    Nothing here is about production. <One line on residue we left, or "We left nothing behind.">

**The asks come before the evidence.** They are the only part that needs a decision, and a
report that hides them under four sections of measurement gets read as a complaint.

**A defect line is one sentence a stranger understands.** "`list_members` ignores the roles
filter and returns everybody" — not "the roles query parameter exhibits non-conformant
filtering behaviour on the App Admin surface".

**Say what we broke, in their system, near the top.** Any fixture we created and could not
delete is theirs to clean up. It goes where they will see it, not in a closing paragraph.

## How to write it: Simplified Technical English

**Another team reads this, and they did not run the evaluation.** They have no context for
our vocabulary and no reason to decode a sentence twice. These are ASD-STE100's writing rules,
which exist for exactly that reader.

- **One idea per sentence.** A claim, its evidence and its caveat are three sentences.
- **Twenty words is the limit.** A longer sentence is two that have not been separated.
- **Six sentences is the limit for a paragraph.**
- **Active voice, present tense.** "The filter returns every row", not "every row was found
  to be returned".
- **Keep the articles**, and never stack more than three nouns.
- **One word, one meaning, throughout the document.**
- **Say what happened, then what it means.** The read-back first, the conclusion second — and
  both in short sentences.

Keep the technical terms. STE's approved word list was written for aircraft maintenance and
has no word for `422`, `app variable` or `advanced flow`. Define a term once, the first time
it appears, and then use it unchanged.

**The test.** An engineer on the other team reads the first ten lines. They must be able to
say what we found and what we are asking them for. If they cannot, rewrite the opening rather
than adding to it.

## What was evaluated

The header of this document, and it is where the target lives now — there is no `target.md`
in this flow.

For skill evaluation there is one, because settling which of the skills on the shelf somebody
meant is a narrowing DIALOGUE, and that dialogue is the reproducibility record. Here the
target is three facts with a two-way choice: which block, which instance, which contract
version. Same test applied, different answer, because the content is different.

State them:

- **block and origin** — `team` or `platform`. A stand-in was refused at locate.
- **the instance** — `the <name> app on that block's staging instance`, not "casebox". Two rounds against
  different instances, compared, measure the environments rather than the block.
- **the contract version in force**, with its date. A conformance result that does not name
  its contract cannot be compared with next quarter's.
- **when the three measurements were taken.**

## What the numbers say — PASTE, do not retype

    eval_block_usage(block: "<name>")

**It returns finished markdown. Paste it under this heading, whole, in order, unchanged.**
Do not reformat a table, do not drop a row you think is dull, and above all do not retype a
number into your own prose. This is the part the block team reads most closely, because it is
about their surface rather than our opinion of it — and a number we retyped is a number they
are entitled to doubt.

Three tables come back:

| | what it settles |
|---|---|
| **Coverage** | how many tools were exercised, how many calls, over what window — and that this is what was CALLED, never what the block publishes |
| **Tool by tool** | calls, refusals, the rate, and how many unrelated initiatives met each, heaviest first |
| **Refusal classes** | each class, its count, and how far it spread |

**Coverage first, and say in one sentence what it means.** Exercising 12 of a block's several
hundred tools is a different claim from exercising 12 of 14, and the table cannot make that point for
you. `eval_block_surface` says what the block publishes; the gap is surface this round did
not touch, and that is a fact about our round, not a defect in theirs.

Then, from the other two measurements:

- **the surface, and what moved** — tools recorded, observed schema cost, and any tool
  removed or renamed since the last round. Put a rename at the top whatever else is in the
  report: it breaks every caller silently, with no error until the next call.
- **conformance** — R1-R14 at the version in force, and which of them a tool surface cannot
  settle.

**Report, do not grade.** One real block is no baseline, so nothing here says whether a 17%
refusal rate is good or bad — only what happened, at what rate, and where it recurred. A
number with no scale, stated as a number, is honest; the same number stated as "poor" is an
invention their team will rightly reject.

## Where defects come from

Three sources, and the knowledge base is the richest:

1. **Knowledge nodes** tagged `block:<name>` — every defect any initiative journalled, with
   the evidence it was journalled with. **`eval_block_defects(block: "<name>")` is how you
   read them**, and it is not the same as a `search_knowledge` query you write yourself: it
   collects BOTH tag conventions (`block:casebox` and a bare `casebox`), drops superseded nodes, and
   carries the block version each was checked against. Hand-rolling the search misses the
   half of the corpus tagged the other way and re-reports claims a later node already
   corrected — a snapshot of what is true now is the thing a block team can act on, and a
   triage history is not.
2. **Refusal classes** from `zz.event`, grouped, with counts. A class that recurs across
   unrelated initiatives is a defect; one that appeared once in one run may be a payload bug
   of ours.
3. **Conformance gaps** from the previous stage.

## Defects

One row per defect. Every defect needs all four:

| | |
|---|---|
| **what it does** | one sentence, in their vocabulary, not ours |
| **what its documentation says** | quoted, or "nothing" |
| **the read-back that proves it** | the call, the arguments, what came back |
| **the workaround** | what we do meanwhile, so they can judge urgency |

### Evidence

**A read-back, not an error message.** A write call that returns an error may have succeeded;
this platform has recorded that happening. The proof of a defect is the state of the system
after the call, not what the call said.

## Re-test before you report

**This is the rule this stage exists for.** Every defect is re-run against the live block
before it goes in the document.

Several knowledge nodes, across several initiatives, once recorded a tool as broken — "not
transient across six payload shapes". Every later run read those nodes and took the fallback
instead of retrying, so a misdiagnosis compounded for a week. One call with a corrected
payload disproved it. What was actually there was narrow: one field shape the tool would not
accept inside one kind of flow.

"The tool is broken" was a dead end. The narrow version is a bug report a block team can fix.
**A defect nobody has re-tested this round does not go in this document** — it goes in "what
we are not claiming", with its age.

## What we are not claiming

- Anything we could not reproduce this round.
- Anything that might be our payload rather than their API — say so, and say what would
  settle it.
- Any behaviour observed only on staging, where staging is known to differ.

## What we changed on our side

Say what we did to work around each defect. Two reasons, and the second matters more:

1. it tells them how urgent it is — a defect we route around cleanly is less urgent than one
   that stops us;
2. **it tells them what will break when they fix it.** A workaround built on a defect fails
   when the defect goes, and they should be able to say "we are fixing that in March" and
   have us know what to undo.

## Facts, then justification, then — only sometimes — a recommendation

The order is fixed and the last step is conditional.

**Facts first, and they carry themselves.** Calls, refusals, rates, spread, what moved, how
many versions the handshake reported. A number is a fact; "16% is high" is a judgement about
somebody else's system made from outside their roadmap.

**Then justification and explanation** — what the facts mean for the work we did. "`create_rule`
refused 44 of 66 calls, 35 of them 422; a corrected payload succeeded, so the shape was ours
and the message did not say which field" is explanation. It tells their team what we found
without telling them what to do about it.

**Then a recommendation — and the line is not who owns the block. It is what we can see.**

    THE INTERFACE BETWEEN US        recommend it plainly. We bear the consequence,
                                    it is visible from outside, and it is what the
                                    contract is for.

    THEIR DESIGN, PRIORITIES,       do not. Their roadmap, their constraints and
    ROADMAP, INTERNALS              their reasons are not in our event log, and a
                                    recommendation from outside all three is as
                                    likely to point the wrong way as the right one.

**The worked example.** Suppose a block reports its version as an ISO timestamp, and several
distinct ones are recorded across a week — it changes on restart. That is not a comment on
anybody's release process; it is the interface failing to do the job the contract gives it.
A version exists so a reader can tell whether the thing in front of them has changed, and a
value that moves on restart cannot. So the recommendation is direct and belongs in the report:

> **Publish a real version number — `5.3`, `0.1.0`, anything that changes when the software
> changes and not when it restarts.** A defect recorded against such a block cannot be tied to a
> version, so nothing we know about the block can be retired when a fix ships. We re-test
> everything, every round.

What we do NOT say is how they should cut releases, when, or how often. The requirement is
that the number means something; how they produce it is theirs.

**Where the split by ownership still holds** is what happens after the findings:

| origin | after the report |
|---|---|
| `team` — somebody else's | **it ends at findings and interface recommendations.** A later step may follow up on fixes; this one hands over and stops. |
| `platform` — ours | **we say what we are going to change**, in the tools themselves, because we can act. "No change" is a legitimate finding. |

## What we ask for

Specific and few. A confirmation, a timeline, a documentation correction — or an
acknowledgement that the behaviour is intended and we should design around it permanently,
which is a perfectly good answer and one we can act on.

**A defect in the block's USAGE SKILL is an ask, exactly like a defect in a tool.** We do not
fix it ourselves, and the reason is not politeness — it is that the same team owns both. A
usage skill describes the tools, so a skill correction and a tool correction are two halves of
one change, and they belong in one version from them. If we edited the skill while they fixed
the tool, the two would ship on different days against different versions and the skill would
describe a surface that no longer exists — which is exactly what a usage skill is supposed to
prevent.

So write it up the same way as any other defect: what the skill says, what the block actually
does, and the read-back that shows the difference. Then it is theirs to carry, together with
the tool work it belongs to. The block contract already puts it there — a platform rule goes
to their docs, tool or usage skill — and this is that rule applied to what an evaluation
finds.

If the honest answer is that we are reporting for the record and need nothing, say so.

**And if there are no defects at all, say that too and send nothing.** A block that is
conformant and quiet is a real outcome, and a review that always finds something is a
handover note their team learns to ignore.

## Then the stakeholder decides, and the initiative closes

Fetch the written report with `show_document("<initiative>/findings.md")` and put what it
returns in front of them before you ask. Approving this is agreeing to send it. Then close — `zz-knowledge` mints what generalises; a
defect confirmed by its own team is a stronger node than one we inferred, so supersede the
inferred one rather than leaving both.
