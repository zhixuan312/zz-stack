---
name: zz-skill-locate
version: 0.3
description: Settle exactly which skill is being evaluated, and pin the version. Writes no document — what it settles goes in the header of every document this flow does write.
when_to_use: "The first stage of zz-skill-eval, always. Nothing can be profiled, ruled or judged until it is settled which skill this is about."
---

# zz-skill-locate

**Nothing here is measured until it is named.** Somebody says "evaluate the spec skill" and
there is no such thing until you know whether they mean a flow's stage or a block's usage
skill, which flow or which block, and which of the several skills in it.

Get that wrong and every number afterwards is about the wrong skill, and nothing downstream
will notice — a rubric will be found, statistics will be counted, documents will be judged.
The output is confidently, silently about something else.

## Act for the platform, not for a delivery team — switch first

    switch_team("zz-platform")

**Do this before anything else.** An evaluation is the platform's own work and belongs in the
platform's store. Without the switch you act for whichever team you last worked in, and the
first real run of this flow wrote its report into `product-1` — a delivery team's store,
mixed in with their initiatives, invisible to anybody looking for evaluations.

Nothing warned about it and nothing could: every write succeeded, because writing into a team
you are a member of is exactly what the platform is for.

## If they already named it, confirm it and move on

If the trigger carried a skill name that resolves to exactly one registered skill, say which
one you resolved it to and go. Do not run the interview to be thorough. Ambiguity is the only
reason this stage asks anything.

## Otherwise: the kind decides the next question

Every skill on this platform is one of exactly two things. `zz.skill.kind` is the field, and
`list_skills` shows both.

    flow_step     belongs to a FLOW. It is a stage of delivery — one of the steps that
                  produces a document or carries out a part of the work.
                  Its owner is a flow: ops-flow, sdlc-flow, casebox-assist, this flow.

    block_usage   belongs to a BLOCK. It is about operating an MCP surface — either the
                  block team's own skill, vendored to us, or one of ours written about
                  their block. The platform is a block too, so our own spine is one of these.
                  Its owner is a block: casebox, n8n, bookit, platform.

**Ask which kind first.** Not "which skill" — the list of every skill on the platform is
long enough that a person scanning it picks the wrong one. Two options is a question anybody
can answer.

### They say a flow skill

1. **Which flow?** Offer the flows that actually exist, from the catalog. Say what each is
   for in a few words — a person knows "the delivery flow" and not `ops-flow`.
2. **Which skill in it?** List that flow's stages in the order they run, and its entry skill
   separately, because the entry is the front door and is rarely what somebody means when
   they say a step is not working.

### They say a block skill

1. **Which block?** From the block registry. Say which are real teams and which are
   stand-ins, because evaluating a mock's skill measures our fixtures and not the world.
2. **Which skill of it?** List them with their `source:` — a skill vendored FROM the block
   team reads differently from one WE wrote about their block, and the difference decides
   what a finding can even ask for. We can edit ours; theirs we can only report on.

## Keep narrowing until exactly one skill is named

If an answer still leaves two candidates, ask again. **Do not pick the likelier one.** A
wrong target here is the most expensive mistake this flow can make, because it is the one
mistake no later stage can detect.

If the honest answer is "several" — a whole flow's stages, or every skill of one block —
that is a legitimate scope. Name every one of them in `target.md`. It is a scope, not an
ambiguity, and the difference is that somebody chose it.

## The version is always the latest

Unless the person explicitly asks for an older one, evaluate **the current version of each
skill** — the version registered in `zz.skill_version` with the most recent `released_at`.

Evaluating an old version answers a question nobody asked: it measures text that is no
longer served, so nothing you find can be acted on. The exception is deliberate and rare —
comparing a version against its successor to see whether a change helped, which is a
question somebody has to ask out loud.

## Carry the answer forward — this stage writes no document

There was a `target.md`. It held four facts and the dialogue that produced them, and it is
now the "What was evaluated" header of `findings.md`, which every reader of the verdict opens
anyway.

**A document exists only where it carries a judgement, a decision, or an interpretation that
is not already in the data.** The target is a decision — so it is recorded — but a decision
recorded in the report that depends on it is recorded once, where it is read, rather than in
a file somebody has to know to open.

Carry forward, and state at the top of `findings.md`:

- each skill by name, its kind, its owner
- the version, and that it is the latest unless somebody asked otherwise
- the answers that narrowed it, so the run is reproducible
- the scope, if it is several skills — a scope is a choice, and recording it is what
  distinguishes it from an ambiguity nobody resolved

Then go to `zz-skill-profile`. No gate: naming the subject is a fact, not a decision to
approve. The gate comes at the ruler.
