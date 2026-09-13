# blocks/

One directory per building block, and everything we build **on top of** that block lives in it:
the usage skill that says how to use it well, and the tests that check we still can.

> **`casebox`, `bookit` and `RuleMill` are invented names**, here and everywhere else in this
> repository. The platform was developed against systems belonging to other people; those
> systems are not named, and the measurements taken from them are not published. Two of the
> three stand for this project's own stand-ins and one for a system another team runs — which
> of them is which is not said, and the capability sheet beside this file is written so that
> the judge it feeds does not need to know.

**There is no such directory today, and that is the mechanism working rather than an omission.**
casebox, bookit and RuleMill each had one; all three moved to their own repository, and everything
written about them went in the same move — which is exactly what the paragraph below says should
happen. `services/gateway/src/blocks.ts` ships an empty registry: a deployment's blocks come
entirely from `PLATFORMS`, so the first block somebody integrates gets the first directory here.

What remains is `_standard/`, which is not about any block: it is the contract we ask a block's
authors to meet, and it is true whether or not one is connected.

## Why they are here and not in `skills/`

`skills/` holds the platform's own skills — the spine and the handover a flow loads,
and the commands a person types — which are true wherever the platform runs and belong to us. A usage skill is a different kind of thing: it is written
**about somebody else's server**, from evidence we gathered by calling it, and it is only true
against the version we checked. Mixed into one directory those two look identical and age
completely differently.

Keeping them apart also makes a deletion honest. When a block is disconnected, everything we
wrote about it goes in one move — the usage skill, its traps, its tests — instead of leaving
advice about a server nobody can reach.

## What goes in one

    blocks/<block>/
      skills/<block>-usage/SKILL.md    how to use it well, with `block:` and `verified_against:`
      tests/                           the tasks that check our usage still holds

`verified_against` is the block version the claims were last checked on. When the block moves
past it, everything here is back in question — and the answer is not always "update it": a trap
the block has FIXED should be **deleted**, because a warning about something that no longer
happens costs a reader attention for nothing and turns a usage skill into folklore.
`npm run step-score` prints the queue.

## Where the tests differ from a flow's

A flow's tests live inside the flow (`catalog/<owner>/<flow>/tests/`) and ask whether the METHOD
works. These ask whether our USE OF ONE BLOCK works — which tools we reach for, with which
arguments, and whether what we believe about it is still true. The two fail for different
reasons and are owned by different people.

## CAPABILITIES.md

What each block can actually do, in prose, so that "is this the right technology" has something to
be decided against. Deliberately honest about limits and about the gap — nothing here does
documents-and-signatures, payments, identity verification, GIS or realtime telemetry — because a
sheet listing only strengths turns every judgement into "yes, that could work", which is how a
selection comes to name three blocks for a brief that needed one.

## The baseline that makes a usage skill measurable

Some blocks have a usage skill and some do not, and that is not a gap to rush.

What a block's task set scores with NO usage skill is the number its first usage skill has to
beat. Write the skill first and that baseline is gone permanently — every later score becomes a
number with nothing to be compared against, which is how a skill comes to be believed rather than
measured. Run the tasks bare, record what the block's own tool descriptions were worth, and only
then write anything.
