---
name: zz-block-locate
version: 0.2
description: Stage 1 of block evaluation. Settle which block, which instance of it, and which contract version is in force — and whether the block is a real team's or a stand-in. Writes nothing; its answer becomes the report's header.
when_to_use: "The first stage of zz-block-eval, always. A block evaluation with no instance named is about nothing in particular."
---

# zz-block-locate

Skill evaluation's locate stage resolves **ambiguity** — which of forty-seven skills somebody
meant. This one resolves **identity and reality**, and they are different problems.

## Act for the platform, not for a delivery team — switch first

    switch_team("zz-platform")

**Do this before anything else.** An evaluation is the platform's own work and belongs in the
platform's store. Without the switch you act for whichever team you last worked in, and the
first real run of this flow wrote its report into `team-one` — a delivery team's store,
mixed in with their initiatives, invisible to anybody looking for evaluations.

Nothing warned about it and nothing could: every write succeeded, because writing into a team
you are a member of is exactly what the platform is for.

## Which block — and only a real one

From the block registry. `origin` decides whether this evaluation may run at all:

    team        a block another team owns and operates.                 EVALUATE
    platform    ourselves. We are an MCP surface like any other, and ours is
                the one whose defects we can actually fix.            EVALUATE
    stand_in    a mock we wrote — RuleMill, bookit.                    REFUSE

**A stand-in is not a block.** It is a fixture we wrote to exercise a flow, so evaluating one
measures our own test data and produces a handover note addressed to a team that does not
exist. If somebody asks for one, say that, and ask which real block they meant.

## Which instance

**The question skill evaluation never has to ask.** A block is not one thing: the same block's
staging instance and its production instance are different systems, with different data,
different apps, and genuinely different behaviour. `app zhixuan on stg.casebox.example.com` is the subject; "casebox" is
not.

Record the instance, the environment, and how you reached it. An evaluation whose instance
is unstated cannot be reproduced and cannot be compared with the next one — and two rounds
against different instances differenced against each other measure the environments.

## The contract version is always the latest

Not a question, and not a choice. Measure against the standard in force — the version and
date at the top of the contract today. Evaluating against an older one measures compliance
with requirements nobody is held to any more, which tells the block team nothing they can act
on.

Record which version that was, because a result that does not name its contract cannot be
compared with next quarter's. The exception is deliberate and rare: showing that a block
which passed under v1.2 fails under v1.3, which is a question about the CONTRACT and someone
has to ask it out loud.

## Which block version

If the block publishes one, record it and the date you read it. If it does not — which is
common and is not a defect — say so, and note that "what moved since last time" then has to
come from the surface diff rather than from a version number.

## Carry the answer forward — this stage writes no document

There was a `target.md`. For a block the target is three facts with a two-way choice, not a
narrowing dialogue, so it is the "What was evaluated" header of `findings.md` — recorded once,
where it is read.

Carry forward: the block and its origin, the instance and environment, the contract version
in force with its date, and the block version if it publishes one.
