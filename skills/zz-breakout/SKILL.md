---
name: zz-breakout
version: 1.5
description: Spin up one named expert teammate for a bounded deep dialogue, keep that conversation out of the main thread, and close by writing the confirmed insights to the ZZ knowledge base. Widens a thin option space before a decision is made.
when_to_use: "A decision needs a perspective the main thread cannot hold — a domain expert, an adversary, a specialist lens — and the exchange will be long enough to pollute the main context. The sdlc-flow spec stage leans on this when the options are thin, and so may any other flow. Typed on purpose as /zz-core:breakout in Claude Code, or matched as a skill. Standalone — no initiative, no gate, no place in the sequence."
---

<!-- Design note: the close-out writes to the ZZ knowledge base with knowledge_add, so an
     insight from a breakout is findable by the same search every other stage uses. The
     runtime requirements are stated plainly below because one of the two supported
     runtimes cannot do the addressable-teammate part. -->

# zz-breakout

One bounded, interactive expert-persona breakout. Thin on purpose: this defines the conversation
contract, the lifecycle, and the close-out rules. It adds no service, no route, and no new way to
write knowledge.

**What it buys you** is a long exchange that does not land in the main thread. The expert holds
its own context; the main agent stays out of the content path and never becomes the record of
what was said.

## What your runtime needs

This depends on **addressable background teammates**: spawning a named agent, talking to it
directly over several turns, and stopping it.

**Claude Code has this.** Spawn with the `Agent` tool, `run_in_background: true`, addressed by
`@name`, stopped with `TaskStop`.

**A harness without it: say so rather than pretending.** Run the persona in-session as a
bounded role instead — declare the role, hold the dialogue, and apply the same close-out
contract. You lose the context isolation, which is the main thing the command is for, so keep
it short.

## Intake — do not spawn without these

- **`role`** — the expert persona to consult
- **`topic`** — the subject, reused when the insights are recorded

Optional, with defaults:

- **`model`** — default: a tier below your own. Not the tier you are running on: an expert
  answering one bounded question does not need the model orchestrating the thread.
- **tool profile** — default: **read-only**. Do not widen this unless the person explicitly asks.
  A breakout is for thinking, and an expert that can write is an expert that will.

## Spawn

Exactly one named background teammate. Its prompt must tell it:

- it is the breakout expert for this `role`, on this `topic`
- the person will talk to it directly by name
- **it keeps its own notes in its own context** and must never ask the main agent to replay the
  transcript
- when asked to close out, it distils the **whole** breakout into journal-ready insights, each
  shaped `{ learning, type }` with `type` from `decision · design · behavior · process ·
  knowledge · style`

## While it runs

The person talks to the teammate. You stay out of the content path unless the runtime needs you
to relay.

**Relay hygiene:**

- suppress contentless idle pings; surface only substantive content
- ordinary silence is not failure
- **your partial relay view is not the source of truth about what the breakout discussed** — you
  are seeing a fraction of it by design

**Never read the teammate's raw transcript back into the main context.** That undoes the whole
reason for the breakout in one move.

## Close-out

When the person says it is done:

1. **Ask the teammate to distil** the entire breakout from its own context into a list of
   insights, each with `learning` and `type`.
2. **Show that list to the person before anything is recorded.**
3. Let them edit, reorder, remove, or approve.
4. **Only then write.** For each approved insight, search the knowledge base first, then
   `knowledge_add(title, type, body, evidence, tags, scope)` with `evidence` naming the
   INITIATIVE the learning came from. `scope` has no default and the call is refused without
   it: a breakout runs mid-flow, before any close, so what it produces is almost always
   `scope: "team"` — a lesson about how this team works, not yet the platform's read-back of
   a finished cycle. Send `scope: "platform"` only for the rare insight that is itself a fact
   about a registry entry (a block, a flow, a provider, an interface) rather than about this
   team, and tag it accordingly. The platform checks the evidence name against the team's
   store and refuses one that is not there, so a breakout run outside any initiative has
   nothing to cite: name the initiative it was called to inform, or keep the insights in the
   conversation until there is one. Do not put a sentence of prose in that field to satisfy
   it — the field exists to be followed, and of the eleven nodes that existed when the check
   was added, eight could not be (a count from that day, not a tally of today: the journal
   only grows). An insight that duplicates a node already there is a merge — say so and write
   nothing.
5. Dismiss the teammate.

**Never record without confirmation.** The person heard the exchange; you did not.

## Guardrails

- **Do not reject an insight because you did not witness the exchange that produced it.** You
  were deliberately not in that conversation. This is the failure this command is most prone to.
- **Distinguish your own desync from real context corruption.** Not seeing the direct turns is
  the design, not a symptom. Only genuine corruption justifies stopping and respawning.
- **Read-only unless asked otherwise.**
- Durable insight arrives only through surfaced messages and the close-out summary.
