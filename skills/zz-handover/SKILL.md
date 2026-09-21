---
name: zz-handover
version: 2.8
description: The handover every flow ends with. Read one closed initiative — its documents, its telemetry, its refusals — decide what generalises beyond the team that hit it and what matters only to this team, mint the first kind immediately, and propose the second in one gated handover document.
when_to_use: "An initiative has closed — its closing document carries an `outcome` and the platform has appended its row to `_ledger.md`. Runs at the end of EVERY flow, whatever the flow was. Not a delivery stage: the stakeholder never sees this run."
---

# zz-handover

Delivery produces documents and telemetry. This turns one finished cycle into knowledge the
next team can query — and it is the last step of every flow on this platform, the way
`zz-platform` is the first.

**It writes one document, `handover.md`, and it is the whole handover — not a first draft
of one.** The earlier design wrote `<initiative>/learnings.md` and left a second skill to
promote the general findings into the knowledge base. The promotion step never ran once, in
any initiative, ever — a file nothing reads is not a handover. This design does not repeat
that shape with a different filename: `handover.md` is not a record of nodes minted
elsewhere, it is where the nodes come from. A fact about the platform is minted the moment
this skill decides it — no document stands between the judgement and the node. A fact about
this team is not minted at all until this document says so and a person agrees, because the
team's own shelf should not be written to before the team has seen what is going onto it. One
skill, one document, one gate — the platform reads that document's approval, not a count of
anything, as the signal this cycle is actually done.

## Inputs — read all of them before writing anything

- Every document the flow declared, in order, and their `_versions/` snapshots: what
  changed between an approval and the next one is where the disagreements are.
- `activity.jsonl` — every call, timestamped, with its arguments.
- `knowledge_reconcile(<initiative>)` — **the claims this initiative's stages RECORDED, and
  only those.** The right-hand side is gone and the tool says so in as many words: nothing
  joins a claim to telemetry until something records which plugin a claim is about. Read it
  for what was predicted; do not report an actual-versus-predicted comparison, and do not
  reconstruct one from the activity log.
- The `_ledger.md` row: the close, its outcome, and its date — written by the platform, not
  by the agent, which is why it is the one to measure against.
- `knowledge_search` for what is ALREADY known, on both shelves — and OPEN the ones that
  matter, on the shelf each says it is on — the path is the result's `initiative` and `path`
  joined, and a journal node's `initiative` is the literal `_knowledge`, so
  `document_read("_knowledge/nodes/0136-….md", scope: "platform")` opens a platform node and
  `document_read("<initiative>/<path>")` opens one of your team's own. A 600-character snippet is
  enough to judge whether a node is relevant and never enough to know what it says. A node that restates an
  existing one is noise; a node that CONTRADICTS one is the most valuable thing you can
  write, and it goes through `knowledge_supersede` rather than being added beside it —
  `knowledge_supersede` finds a node on either shelf but refuses a pair that spans both, so
  resolve the shelf a superseded node lives on before you call it.
- **Whether `<initiative>/handover.md` already exists, and its status.** That single check
  decides which of the two passes below you are running — see "Which pass you are in"
  before you do anything else.

## Compute before you interpret

From the telemetry, mechanically. These are statistics, not judgements, and they are what
the evaluation track later reads as this initiative's profile.

- **End-to-end time** — first activity to close, split into agent-working time and
  waiting-on-stakeholder time. The second is where most wall-clock lives; report both.
- **Stage timings** — first load of each stage skill to the next; opening document to first
  approval; approval to first platform write; rounds and their spacing.
- **Question load** — interview batches, questions asked, and how many the stakeholder
  answered with "your recommendation". Every recommendation-answered question is a candidate
  default that should not have been asked.
- **Effort shape** — writes and patches per document; tool calls and their refusals.
- **Rework signal** — patches to a document after its approval timestamp; acceptance rounds
  beyond one.
- **Post-acceptance noise** — anything that happened in this initiative's folder or on its
  platform objects AFTER the close. This is the quality number that matters most and the one
  nobody tracks.

## Then decide what generalises — and to which shelf

This is the judgement the skill exists for, asked of every candidate in two parts:

> **Is this worth another team reading, or is it true only of this one requirement?**
> If it is worth reading elsewhere: **is it a fact about a registry entry — a plugin, a
> flow, a provider, an interface, the platform — or is it a fact about how THIS team
> works, its stakeholder, its systems, its history?**

The first question decides whether a node gets written at all. The second decides which
shelf: the first kind is `scope: "platform"` — it holds for everybody who touches that
registry entry, whichever team they are on. The second is `scope: "team"` — it is real and
worth keeping, but it describes this team's own circumstances, not the platform's.

**Promote to `platform`:**
- A plugin behaved in a way its documentation does not describe — with the read-back that
  proves it, and what to do instead.
- A refusal class that recurred, and the payload shape or ordering that resolved it.
- A platform rule that was learned the hard way rather than read.
- A prior platform node that is now WRONG. Supersede it. A finding recorded on first contact
  and never re-tested is how a misdiagnosis becomes a fact nobody questions.

**Propose to `team`:**
- A conduct pattern that changed the outcome for THIS team — a check that caught something,
  a shortcut that cost something, a way this stakeholder likes to be asked.
- Something true about this team's own systems, history or working style that the next
  initiative on this team benefits from knowing and a later one, on a different team,
  would not.
- A prior team node that is now WRONG. Supersede it, same as above, on the team shelf.

**Leave behind entirely:** anything true only of this one requirement, and anything you
could not evidence. Not every candidate is one shelf or the other — most of what happened
in an initiative is neither, and saying nothing about it is the correct call.

## Which pass you are in

`handover.md`'s existence and status tell you which half of this skill to run. Do not run
both halves in one call, and do not re-derive a judgement the document has already recorded.

**Pass 1 — `handover.md` does not exist yet.** Do the full read, the computation, and the
judgement above. For every `platform`-scoped candidate, mint it now with
`knowledge_add(scope: "platform", ...)` — nothing waits on a document for a fact that holds
for everybody. For every `team`-scoped candidate, do **not** mint it. Write it into
`handover.md`'s "Proposed for the team" section instead — title and what it will say — and
stop there. This pass ends with the document written and unapproved; it does not wait around
for the approval, because that is a human's turn, not this skill's.

**Pass 2 — `handover.md` exists and is `approved`, and its proposed team nodes are not yet
minted.** For each line under "Proposed for the team", call
`knowledge_add(scope: "team", ...)` using exactly the title and content that line already
promised. The approval was of that text, not of whatever you might decide to write today —
do not re-run the judgement, add candidates that were not in the document, or change what a
line says because more time has passed. Once every line is minted, this pass is done; there
is nothing further to write.

**The one exception: a line that has become FALSE is minted as what is true, and says so.**
Not a changed judgement — a changed fact. A proposed node may assert something checkable
about the world ("review.md does not state X", "the old volume is still mounted"), and
between the approval and this pass somebody may have acted on the handover and made it
untrue. That is the handover WORKING. Transcribing the sentence anyway would put a false
statement into the store, and a knowledge base is worth exactly what its worst entry is
worth — a node nobody can trust is more expensive than no node.

So: **check each factual assertion before you mint it, rather than assuming the world stood
still.** Where one has moved, keep the node's subject and substance as approved, correct only
the falsified fact, and record the change in the node itself — including that the handover is
what caused it, which is usually the more useful lesson than the fact. Then say plainly, in
your report, which line you altered and why, so a person can put it back if they disagree.
This is the narrowest possible door: it opens for a fact you verified is now wrong, and never
for a judgement you would make differently today.

Observed the first time this pass ran for real, on 2026-09-21: a proposed node said
`review.md` did not state a discrepancy, the initiative's owner read the draft handover and
revised `review.md` to state it, and minting the approved sentence unchanged would have
shelved a falsehood produced by the document doing its job.

**Anything else — `handover.md` exists but is still `draft` or awaiting the stakeholder.**
There is nothing for this skill to do. It is a human gate; do not re-run the judgement to
"check", and do not mint team nodes early because the wait is long. `initiative_status` reports
the initiative as `closed` throughout — the close is terminal and this document is not owed, so
an unapproved handover holds nothing open.

## Writing the nodes

`knowledge_add(title, type, body, evidence, tags, scope)` — it numbers the node, requires
the evidence, and writes the index and the append-only log, on whichever shelf `scope`
names. Never write a node by hand, on either shelf; the store refuses it, and it would carry
none of those things.

- **`scope` has no default and every call must send it.** `"platform"` lands under
  the platform TEAM's own store — `zz-platform` is a team slug here, not the skill of
  that name — readable and citable by every team; `"team"` lands under your own
  team's store. Get this from the judgement above — do not guess it from habit.
- **A `platform`-scoped node needs a registry-entry tag** — `plugin:`, `flow:`, `provider:`,
  `interface:` or `platform:` — because platform knowledge is by definition about one of
  them. The store refuses a platform-scoped node without one.
- **Evidence is not optional.** Name the initiative and the specific call, refusal or
  read-back. A node whose claim cannot be re-checked cannot be retired when the world moves,
  so it routes work around itself forever.
- **Say how old it is.** A plugin defect is re-checkable; a platform rule usually is not.
  State which kind it is, so the next reader knows whether to test it or trust it.
- **Tag it with what it is about** — `plugin:<name>`, `flow:sdlc-flow`, `provider:forgejo`,
  `interface:claude-code`, `platform:guardrail`. The kinds are checked. This is what turns
  "what have we learned about that plugin" into a query rather than a search.

## Writing `handover.md`

Three sections, at `##`, with exactly these headings. **The platform checks them at the
APPROVAL, not at the write**: `handover.md` is gated, and a gated document is allowed to be
half-written while it is a draft, so `document_write` accepts a two-section handover and
`document_approve` is what refuses it — in front of the person you asked to sign it. Write
all three the first time:

- **`## What this initiative taught`** — prose, not a list of nodes. What the read-back of
  the initiative's documents, telemetry and refusals actually showed, in enough detail that
  someone who was not in the room understands what happened and why it mattered. This is
  where the reasoning lives; the two sections below are its outcome.
- **`## Recorded for the platform`** — one line per platform-scoped node you already minted
  in this run: its id, its title, and the registry entry it is about. These nodes exist by
  the time this document is written — this section reports them, it does not propose them.
- **`## Proposed for the team`** — one line per team-scoped candidate, with its title and
  what it will say. These do NOT exist yet — they are minted only in Pass 2, after this
  document is approved. Do not call `knowledge_add(scope: "team", ...)` while writing this
  section.

**Zero is a correct, approvable outcome in either of the last two sections — never pad
one to avoid saying so.** An initiative can teach the team nothing that generalises, and a
section implying it should always have something in it produces filler that then reads as
evidence next time somebody searches for it. Where a count is zero, write one line saying so
and why: "Nothing recorded for the platform — every finding here was specific to this
requirement" is a complete, sufficient sentence. A person approving that line is approving
the judgement that there was nothing worth the platform's or the team's shelf, which is
exactly the judgement this skill exists to make honestly, not to talk itself out of.

**Declare how many team nodes you proposed, in the write's own `fields`:**

```
document_write(path: "<initiative>/handover.md", content: "<the body>",
           fields: {proposed_team_nodes: "2"})
```

That number is not decoration and it is not a duplicate of the section above it. `## Proposed
for the team` is prose, and the platform cannot count prose — so this field is the thing
`initiative_status` reads to decide whether Pass 2 actually kept the promise Pass 1 made.
Zero is correct when you proposed none, and must still be written: `fields:
{proposed_team_nodes: "0"}`.

**This was missing until 2026-09-09, and the consequence is worth stating.** The platform has
always read the field, and no skill ever said to write it — so it was absent on every handover
ever written, `Number(undefined ?? "0")` made it zero, and the check that an approved handover
kept what it promised was satisfied by zero every single time. An initiative closed as
complete with two team nodes promised in its own prose and none on the shelf, and nothing
anywhere disagreed. A promise recorded whose keeping goes unverified is the exact shape this
document's own machinery exists to prevent.

Write the document with `document_write` once, with all three sections filled in as above. It is
gated like every other document this platform hands to a person: a team member reads it and
calls `document_approve("<initiative>/handover.md")` when they agree with what it says, including
where it says nothing was worth recording. Nothing about that review is this skill's to
perform — Pass 1 ends when the document is written, and Pass 2 does not begin until the
approval has already happened.

## Hard rules

- Runs AFTER close, never during delivery. The stakeholder never sees this run.
- Every `knowledge_add` call carries a `scope` — there is no default, and none should be
  inferred silently from context you have not stated in the reasoning above.
- Platform-scoped nodes are minted immediately, in the same run that decided them. Team-
  scoped nodes are never minted before `handover.md` naming them is approved — the team's
  own shelf is not written to before the team has seen what is going onto it.
- Writes nothing in the initiative folder except `handover.md`. No `learnings.md`, no
  second file, no note written anywhere else.
- Never invents a statistic. Report the shape you can see; an estimated refusal rate is the
  one number in the record nobody can check.
- A finding you cannot evidence is not a finding. Say what you could not establish.
- A section with nothing in it is not a failure to fill in. Say so in one line and let a
  person approve that judgement — a skill that implies a quota produces filler.
