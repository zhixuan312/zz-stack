---
name: building-a-block
version: 1.1
description: How a team turns their platform into a building block this delivery agent can discover, select, assemble and verify. Shapes the tools, the usage skills, the user guide and the staging affordances the standard requires.
when_to_use: "A team is making their platform available as a building block, or fixing a conformance failure, or writing the usage skills that ship beside it. Read this before writing any of it — the standard it enforces is in references/contract.md."
---

# Building a block

The standard is `references/contract.md` — **STANDARD v1.3**, requirements R1–R14. That file
is the contract; this skill is how you satisfy it.

Read the contract for what is REQUIRED. Read this for how to get there, and for the mistakes
other teams have already made, which the contract cannot tell you because a contract states
obligations rather than experience.

## The one thing that decides everything else

> The delivery agent must be able to discover, select, assemble and verify **any** block the
> same way.

Every requirement follows from that. Your platform is not special to the agent — it is the
tenth thing in a list, reached through the same door, described in the same shape. A block
that needs to be understood before it can be used has failed before R1.

## Your tools

- **Name them for what a person does**, not for your internal model. `create_record` is
  usable; `post_entity_v2` needs a translator.
- **Refuse with a sentence that teaches the rule.** `ERROR: status is written by the
  platform, not by hand` tells the caller what to do instead. `400 Bad Request` starts a
  guessing game, and the guesses land on your API.
- **An error must mean the thing did not happen.** This is the requirement most often broken
  in practice, and the most expensive. A write that returns an error and succeeds anyway
  teaches every caller to distrust every response, and they will start reading state back
  after every call — which is your load, doubled, forever.
- **Validate what you document.** A filter argument you accept and ignore is worse than one
  you reject: the caller gets a plausible wrong answer and builds on it.
- **Count the cost of your surface.** Every tool's schema is in the prompt of every
  conversation that can reach your block. A block advertising a couple of hundred tools spends that budget on
  every turn, including the turns that never call you.

## Your usage skills

Ship skills for the things your API cannot make obvious — how to write a query, a script, a
template, the order operations must happen in.

**Ask the honest question about each one first:**

> Does this say anything a live tool of mine does not already return?

If your platform has a `how_to_write_script` tool that returns the live, app-specific
grammar, then a static skill file repeating that grammar is a worse copy of it — it cannot
be app-specific and it cannot stay current. Ship the tool; skip the skill. Two of the four
skills vendored from one block on this platform were exactly that, and the agent correctly
went to the tools every time.

**What a usage skill SHOULD carry:** the defects and their workarounds, the ordering
constraints, the limits you found the hard way. Things no schema can express.

**What it must NOT carry: conduct.** Do not put your assistant's system prompt in a skill.
One vendored skill on this platform says "max 1-2 tool calls before stating information is
unavailable" and "ask the user to confirm before proceeding" — written for a chatbot, and
actively harmful inside a delivery flow that has already been approved to proceed. Give
operating facts about your block. Leave when-to-stop and when-to-ask to the flow.

## Your user guide

R-numbered requirements aside: someone has to be able to check, in your own screens, that
what the agent built is real. Name the screen, the filter, the column. "Check the case" is
not a verification step; "Cases → filter by type → the Status column" is.

## Staging

Give a real staging instance with a reset path. The agent will create test data and needs to
remove it. A block with no staging gets exercised in production or not at all, and teams pick
the second.

## Before you say you are done

    zz-tool conformance --gateway https://api.<host> --block <name>

It measures R1–R14 from your tool surface and **tells you which it cannot settle** — R1, R7,
R12, R13 and R14 need a write, a sequence or a delivered event, so a clean report is not a
complete one. Ask for those to be exercised in a real initiative.

**A conformance result names the contract version it was taken against.** If yours says v1.3
and the current standard is later, re-read what moved before assuming you still pass.
