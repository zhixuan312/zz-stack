---
name: sdlc-method
version: 1.8
description: How every SDLC skill runs — which stages a subagent executes and which the main agent must keep, what to hand a worker, and how to judge what it returns. Read this before running any sdlc-* skill.
when_to_use: "Before executing any sdlc-* stage or tool, and whenever you are deciding whether to dispatch a piece of work or do it yourself. The stage skills describe their own output; this describes how all of them are run."
---

# sdlc-method

The behaviour every `sdlc-*` skill shares. A stage skill tells you what its document must
contain; this tells you who writes it, on what tier, and what you do with it when it comes
back. Read this once at the start of a stage, not once per skill.

## The default is: you do it. Four things are dispatched.

Most of this method is judgement a person is party to, and judgement is not delegable. So the
main agent runs the flow, and dispatches in exactly four places.

| Dispatched | Shape | Why it is not yours |
|---|---|---|
| `sdlc-explore`'s fan-out | many workers, in parallel | breadth — one question per worker |
| `sdlc-spec-audit` / `sdlc-plan-audit` | one worker per round, **sequential**, at most three | a reader who did not write the document |
| `sdlc-execute` | one worker per plan item | mechanical, and bounded by the plan |
| `sdlc-review` | workers over what was built | a reviewer who did not write the code |

Everything else — `sdlc-explore` itself, `sdlc-spec`, `sdlc-plan`, and closing the initiative
once `sdlc-review` is done — is yours.

There is no generic audit skill. Which auditor you dispatch is decided by which document is on
the table: `sdlc-spec-audit` for `spec.md`, `sdlc-plan-audit` for `plan.md`.

**Dispatch to a tier below your own.** Not the tier you are running on — that works and costs
several times more for the same output.

Which tier that is, is your runtime's answer, not this skill's. Ask what your runtime offers
and pick the cheapest one that can hold the work; if it names only one tier, say so rather
than silently spending the difference. As an illustration only, at the time of writing a
A Claude Code session would reach for something like `sonnet`, and another harness for something
like `terra` — treat those as the shape of the answer, not the answer. A tier named in a
document goes stale faster than anything else in it, and a stale name fails by silently
falling back to your own tier, which is the exact cost this rule exists to avoid.

## Why the four are the four

**Breadth, not depth.** `sdlc-explore` dispatches many workers because a worker given one
question returns an answer and a worker given a subject returns a survey. Then it **waits for
all of them** and does the synthesis itself — the synthesis is where the answers become a
picture, and that is judgement.

**Independence.** The two auditors and `sdlc-review` are dispatched because the value is a reader
who did not write the thing. Running them yourself re-reads your own reasoning and finds it
sound.

**Volume.** `sdlc-execute` is one worker per plan item because the plan already made the
decisions; what remains is the change itself.

## Why the rest are yours

**`sdlc-spec`** is brainstorm and spec in one conversation: the options are opened and closed
with the person in the room, and the agreement is written the moment they settle. Dispatching
it delegates the deciding, and returns a confident document nobody agreed to.

**`sdlc-plan`** is the same, one stage later. Order, risk and scope are the person's judgement.
A dispatched plan is a plausible ordering nobody chose.

**`sdlc-explore`** owns the fan-out and the synthesis around it.

**Closing the initiative** is an act, not a stage — one `initiative_close()` call, the way `zz-platform`
describes it, once `sdlc-review` is done. You are the only party who was present for the
whole initiative, so there is nobody else to dispatch it to. `zz-handover` runs afterward
and is what turns the closed initiative into what the next one recalls; that is the
platform's step, not this flow's.

## Three gates, and they are recorded either way

The person agrees to **`spec.md`** before its audit runs, approves **`plan.md`** before its
audit runs, and approves **`review.md`** before the initiative closes. Auditing a document
nobody agreed to audits your own guess; building from an unapproved plan builds your own
guess; and closing on an unapproved review says the work shipped on nobody's word.

**Both audits come after their document's gate.** Each registers a SOURCE against the document
it read — `spec.md` for the spec audit, `plan.md` for the plan audit — and both targets are
gated, so the round is a reader's check on something somebody already stood behind. Ask for the approval first; the audit is the reader's check on a
document somebody already stood behind, not a way to decide whether to stand behind it.

The third is the one that changed, and it changed because the flow was closing on the wrong
document. `spec.md` used to carry `closing`, so the platform offered the close as soon as the
plan was approved — before any code was written. `review.md` carries it now, which is why the
close waits for a review that exists and is signed.

**A person may delegate the decision — "auto-approve, I do not need to see it" — and that is
theirs to say.** Delegation is an ordinary answer, and it keeps standing until they say
otherwise; do not treat it as a special case to be re-confirmed each time.

The gate constrains YOU, not them. Whatever they decide, it becomes a recorded state
transition on the document, under their name, written by you in the same turn — because the
platform's record of who approved what is the thing an audit later reads. An approval that
only happened in a conversation did not happen, and the person is not the one who should
discover that later.

## What a worker is handed

Three things, in this order. A worker missing any of them writes something plausible and
wrong.

1. **Its instructions**: follow the stage's skill, and **load it with `skill_read("<stage>")`
   as its first act, before anything else.** Do not paste the skill's text into the prompt —
   it is hundreds of lines, and a pasted copy goes stale the next time the package updates.
   The subagent inherits your tools and can load the skill itself.
2. **The payload**: the confirmed inputs verbatim — decisions, the approved spec, the plan
   item. Verbatim, not summarised. A summary is a second act of judgement the caller did
   not intend to make.
3. **Where it lands**: the initiative and the document name.

**Why `skill_read` and not whatever your runtime offers.** A worker that loads the skill from
its own plugin directory gets the same text and leaves no trace, and the platform attributes a
step from the last `skill_read` it was asked for. So a stage loaded locally did not happen as
far as the record is concerned. Measured on 2026-09-13: across every initiative this platform
has ever recorded, `zz.event` holds not one `sdlc-spec-audit` or `sdlc-plan-audit` row — both
audits, the two stages whose whole value is that somebody independent read the document, are
invisible. `sdlc-recall`, `sdlc-investigate` and `sdlc-research` are dispatched exactly the same
way and are all over the log, because those workers happen to call a platform tool that loads
their skill first.

What that costs is not bookkeeping. A return — the audit that sends a spec back, which this
method exists to make possible — is a stage entered after a later one has run. With the audit
missing there is no later stage, so an initiative that went spec → audit → spec reads as a
straight line, and the one thing plugin evaluation most wants to know about this flow cannot be
asked of it.

**The honest limit, so nobody reads more into the record than is there:** the platform
correlates a step with the calls that follow it per CALLER, and your subagents share your
credential. So your calls and theirs interleave in one trace, and a step is only ever the last
one anybody loaded. The instruction above makes a dispatched stage visible; it does not make the
main agent's and the worker's calls separable.

## What you do when it returns

**The report is a claim. The document is the fact. They diverge exactly when it matters.**
Read the file, not the summary.

Three checks apply to every stage; each stage's skill adds its own.

1. **It exists.** `document_read(...)`. A worker that reports success without a successful write
   has told you about a document that does not exist.
2. **Nothing survives as a placeholder.** Search for `<!--`, `TODO`, `TBD`, `brief:`. Workers
   draft from briefs and replace them as they go, so a surviving brief is a section that
   never got written — and it looks like success: heading present, format correct, body a
   note about what would go there.
3. **Every section has substance.** A section of four lines beside neighbours of a hundred
   was named, not written.

**Do not judge a document mid-run.** It is only final when the worker returns. A file read
early looks exactly like an abandoned one.

**If a check fails, dispatch again** on the same tier, naming only what is missing and
saying the rest is already written. Do not write it yourself: the point of the method is
that the expensive model is not the one producing prose.

## You are the quality gate

**Nothing re-reads a worker's output before you do.** There is no second model behind you fixing
a thin section or a wrong citation inline — you are the only thing between a worker's draft and a
document someone builds on. That is the reason the checks above are not optional.

## Where things live — all of it on the platform, none of it local

**Every document carries an envelope, and the platform writes all of it.** You send the
document's BODY — markdown starting at its first heading — and content that opens with
frontmatter is refused. `flow`, `type`, `status`, `version` and `updated_at` are stamped from
what the platform already knows; `approved_by`, `approved_at`, `outcome` and `closed_by` come
from `document_approve()` and `initiative_close()`.

What the document needs beyond those facts is a NAMED ARGUMENT to the write, not a line you
type: `stakeholder`, `tags`, `title`, and `fields` for this flow's own keys.

```
initiative_open(slug: "<a few words>", flow: "sdlc-flow")
document_write(path: "<initiative>/explore.md", content: "<the body>")
```

**THE FLOW IS DECLARED WHEN THE INITIATIVE IS OPENED, and `document_write` does not take one.**
It used to, and passing it on a later document was a way to retrofit a manifest onto work
already written — the gates that manifest declares would then land on documents nobody had
approved. `initiative_open` is the one moment the choice is meaningful, and there is no tool
for changing it afterwards.

`flow` is not decoration. The platform reads it to decide which chain of gates applies, and a
flow THE CATALOG does not have is refused by name at the open. Installing does not enter into
it: the platform keeps no record of what a team installed, so an initiative may be governed by
any flow the catalog carries. On `ERROR: no flow named 'x'` the name is wrong — no admin can
grant you one. Opening WITHOUT one is a
legitimate choice rather than a mistake: nothing is enforced on that initiative, and
`initiative_status` says so by answering `next_move: null` instead of inventing a stage.

**Documents** go in the initiative, written with `document_write` — never a local path. The
initiative store is what gives a document its envelope, its version snapshot at approval, and
its telemetry. A spec written to `./spec.md` is a file; a spec written to the initiative is a
document someone can approve. This flow produces four: `explore.md`, `spec.md`, `plan.md`,
`review.md` — and `review.md` is the one it closes on. The two audits produce SOURCES, not
documents: an audit report is what makes the next version necessary, and the platform refuses
that revision until the source is cited.

**The journal** is the ZZ knowledge base, reached through zz-core: `knowledge_search` to read,
`knowledge_add` to write. Not a local directory, and not this flow's own store. A journal on one
laptop is a journal one person has; the point of recall is that the next initiative starts from
what *every* earlier one learned.

Neither is this flow's to implement. The platform already does storage, indexing, versioning
and retrieval, and a stage that rebuilds any of it produces a second store nobody searches.

## Who approves

Not you, and not the worker. A worker proposes; a person decides. Report to them in their own
words what the document says and what it calls "done", and let them answer. An approval exists
only once `document_approve(path)` has recorded it — the platform stamps who and when from the session
itself, so the one thing you must get right is calling it in the same turn they agreed. Your
team's own name is not a person, and `on_behalf_of` exists for the rarer case where the verdict
is someone else's.
