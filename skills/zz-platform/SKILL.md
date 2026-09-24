---
name: zz-platform
version: 3.59
description: "The platform spine every flow's skills stand on: file tools, gates, documents, when a plugin is reached and how it is chosen, sources. Flow-agnostic — load once at the start of ANY flow on the ZZ platform, before the flow's own entry skill. Owned by the platform team; flows never duplicate these rules."
when_to_use: "A flow's entry skill tells you to load this first. Also load it whenever you operate on the ZZ platform's artifact store outside a flow."
---

# zz-platform

These rules hold for every flow on this platform — sdlc-flow, zz-plugin-eval, and every flow
written after them. A flow's skills add its method on top and do not restate
what is here; two copies of one rule drift, and then nobody knows which is
current. A flow may depart from a rule here only by saying so in its own skill,
in as many words, with the reason — silence is not an override.

**Some of these the platform enforces and some it only asks for, and the
difference is marked.** A rule tagged **[convention]** is one nothing here can
check: no tool refuses you for breaking it and no record catches it afterwards.
It is written down because it is what good work looks like — and it is tagged
because a rule stated as an absolute that nothing enforces teaches you to
distrust the ones that are real.

## The two objects, and every transition either has

Everything on this page is about one of two records: an **initiative** and a **document**.
This is the whole state machine. The prose below it is what the platform REFUSES and why —
read the table to know what you can do, read the prose to know what will stop you.

**An initiative.**

| From | The act | To | Refused when |
|---|---|---|---|
| nothing | `initiative_open(slug)`, or `initiative_open(slug, flow)` | open | you typed a date into the slug — the platform prepends its own |
| open | `document_write`, `document_approve`, `source_add` | open | see the document table |
| open | `initiative_close(initiative, disposition)` | closed, with an `outcome` | a declared document is missing or its gate was never recorded |
| closed | — | nothing reopens it | a closed initiative is a finished record, and a record's value is that it is not edited afterwards |

`outcome` is exactly `delivered`, `accepted` or `abandoned`, and `initiative_close` derives it
from your disposition: `finished` is `accepted`, because closing it is saying so, unless you send
`no_signoff_reason` and it is `delivered`. You never write it.

`flow` is decided at open and only at open. Pass it and the platform tells you what comes next;
leave it out and it answers `next_move: null` with `next_move_absent` saying why — a freeform
initiative, which is a supported shape and not a degraded one. There is no way to adopt a flow
afterwards, deliberately: the gates it declares would land on documents already written.

**A document.**

| From | The act | To | Who writes the envelope |
|---|---|---|---|
| nothing | `document_write` | `status: draft` — ONLY where the flow gates the document | the platform |
| draft | `document_patch`, `document_write` | draft | the platform |
| draft | `document_approve(path)` | `status: approved`, plus `approved_by` and `approved_at` | the platform, from your session |
| approved | `document_patch`, `document_write` | **refused**, pointing you at `document_revise` | — |
| approved | `document_revise` | draft again, a new `version`, the cause recorded | the platform |
| any | `document_present(path)` | unchanged — a `shown` entry is appended to the activity log | the platform |
| approved | `source_add(..., supports: <path>)` | approved, and flagged for refinement | the platform |

`status` is exactly `draft` or `approved` — **and it exists only where the flow's manifest
declares a GATE on that document.** A status records a gate verdict: it says a person was
asked and answered. An ungated document is finished by being written, there is nobody to ask,
so it carries no `status` at all and `document_approve` refuses it by name. Reading a fresh
`explore.md` and finding no status means the platform did its job, not that the write failed.

**You write neither it nor any other envelope field by hand; every one of them is refused.**
The body is yours, the envelope is the platform's.

**What comes next is computed, never guessed.** `initiative_status(initiative)` answers a
`next_move` carrying four things: an action, the document it is about, who it is waiting on,
and why. These are the situations it distinguishes:

| The situation | Waiting on |
|---|---|
| the next document the flow declares is not there, or is there and still draft | you |
| a gated document is written and nobody has recorded a verdict on it | the stakeholder |
| an audit round is owed: none yet, or the document was revised after the last round read it | you |
| an audit round reopened an agreement, or the round budget is spent on an unaudited revision | the stakeholder |
| the declared documents are done and the platform's handover is not | you, then the person |
| the chain's last document is ready and the initiative can be closed | you |
| an outcome is recorded — it is over | nobody |
| nothing declared a chain: freeform, `next_move: null`, and `next_move_absent` says so | nobody |

**You are told it without asking, too.** `document_write`, `document_approve`, `document_revise`
and `source_add` end their result with a `Next move:` line computed the same way, so the step
after an approval — the audit round it owes, or the close — reaches you in the answer to the
call that made it due.

**The verb itself comes back in the answer — read it there, not from a list here.** A skill
carrying its own copy of the platform's vocabulary is a copy that goes stale silently, which is
the one failure this page is least allowed to have.

Ask it rather than reasoning about the folder. A model working out the state from what it
remembers writing is how a wrong fact reaches a document that outlives the conversation.


## A plugin is reached when something needs it, never before

**There is no pre-flight.** A flow does not know which capability it needs until it has worked
out what it is building, so a check at the start asks about things the work may never touch.

Two different needs arise, usually at different moments:

- **To CHOOSE a capability you need to know what it is for.** That is a question about purpose,
  and the answer is a skill, not a tool list. `skill_list()` with no argument is the whole
  shelf — every skill this platform routes among, each with when to use it; with an owner id
  it narrows to one plugin. Narrow to one or two candidates, then read those skills to confirm.

  Never read every plugin's tool surface to decide: a verb list tells you a call exists, not
  where the work belongs, and a hundred plugins is ten thousand tools.

- **To USE a capability you need its tools on your surface, and you find that out by USING
  it.** Call the tool the work needs. If it answers, it was installed and there was never a
  question.

  **A plugin you do not have installed has NO tools in your list at all. [convention]** Not one
  stub tool, not an error tool — nothing. So when a tool you expected is missing, that is the
  signal, and it is a fact about what is installed rather than about what exists.

  The answer is one sentence to the person: **that capability is a plugin, and it is not
  installed.** Installing is their own choice, made in their client —
  `claude plugin install <plugin>@zz-stack`; `client_setup` on /manage prints it. Never ask
  anyone to paste a credential to you; a credential in a transcript is a leaked credential.

**A plugin is skills plus the MCP servers those skills call.** They arrive together and are
reached together, because a skill telling you to call a tool you do not have is not a
capability. Some plugins are flows — they carry an ordered, gated sequence of documents. Most
are not: they are supporting capability, reached when a skill says to reach for them. A flow
is not a different KIND of thing; it is a plugin that declared documents.

**Confirm reachability when your flow WRITES DOWN that it will use a plugin. [convention]**
The moment the decision is recorded, not at the first call. By the first call you have planned
work around it, and discovering there that it is not installed wastes the plan. Nothing checks
the timing; getting this wrong costs a plan, not a refusal.

## Files are tools, and files are real

- The store is on the PLATFORM, not on any machine you can reach. The
  artifact tools are the only way in: `document_list`, `document_read`,
  `document_write`, `document_patch`. Paths are relative to your team's store, e.g.
  `2026-08-19-sample-intake/spec.md`. This skill is loaded in Claude Code, which is the one client this platform
  packages — where you do have a shell, it reaches
  your own disk and never the team's store, so the rule is the same one.
- The store is shared with your whole team — you will see teammates'
  initiatives. **The platform scopes you to the team and no further.** It
  records no creator and no conversation: nothing in the store says who
  started an initiative or in which session, so nothing can refuse you for
  editing one that is not yours, and nothing will tell a later reader that you
  did. The team boundary is the enforced part; inside it, leave an initiative
  you did not start alone unless the user asks, because you cannot tell from
  the store whether somebody is mid-flow in it and neither can the platform.
- **A document exists only after its write succeeded. [convention]** Never
  print a `File: <path>` line unless the write for that exact path succeeded
  in this same turn. If a write fails, say so instead of pretending. The
  platform sees the write and its result and never sees your reply, so a
  `File:` line standing over a failed write is invisible here and costs the
  person a document they believe they have.
- Dates come from the system — never guessed, never asked.
- When you create or update a document deliverable, fetch it back with
  `document_present(path)` and put what it returns in front of the person as
  Markdown (the chat renders GFM and Mermaid) — `File: <path>`, a horizontal
  rule, then the document. Never only a path. **What the platform holds is the
  fetch, not the showing.** Every `document_present` call appends a `shown` entry
  naming the path, the version and who asked, so "was this document fetched,
  and at which version, before its gate was approved" is answerable from the
  initiative's own activity log. Whether your reply then carried the content
  is not something the platform can see — a tool result is your input, not a
  display — and no approval is refused on a document nobody fetched. The
  record makes the gap visible; it does not close it.

  **A STANDING DELEGATION WAIVES THEIR REVIEW, NOT THE FETCH.** "Approve
  without checking with me" is the person declining to read it — theirs to
  say, and it keeps standing. It is not a statement about the record, and the
  fetch is the record: it is what lets anyone afterwards ask which bytes the
  verdict was given on. Delegation is in fact the case where the fetch matters
  MOST, because nobody else is looking. So fetch it, then approve.

  This is where it went wrong before it was written down. One initiative
  closed with four of its six approvals carrying no `document_present` since the
  content had last moved — an eleven-task plan among them, approved twice,
  fetched never, one of those approvals four seconds after the revision that
  produced it. Nothing disagreed, because nothing was looking. `document_approve` now
  says so in its own result when it happens, so the gap reaches the caller in
  the same turn instead of surviving to the retrospective. **It still does not
  refuse, and it must not start to** — a refusal there would land on the one
  call whose job is to record a decision a person already made.

## Gates and the envelope

- **Decide whether they agreed. Do not match their words against a list.**
  "ok", "go ahead", "approve first", "I think that's right — start" are
  agreement when they answer a clear ask, and so is a standing "you do not
  need to check with me on these", which keeps holding until they say
  otherwise. A list of accepted phrases fails the person who said it another
  way and makes them repeat a decision they had already made. Judge it the way a
  colleague would. Ask again ONLY when you genuinely cannot tell WHAT they
  agreed to — never as a ritual, and never to collect a better-worded
  version of a yes you already have.
- **A gate is not passed until it is recorded**: the moment they agree, call
  zz-core's `document_approve(path)` in that same turn, before moving on.

  **The document is the one THIS conversation is working on.** If you wrote it and
  asked for a verdict, their answer is about that document — approve it. Do not
  list other initiatives to ask which they meant: the store holds everybody's work
  and most of it is not theirs to approve, so an enumeration turns a one-word
  answer into a puzzle about other people's drafts. Ask only when this
  conversation genuinely has two gates open at once, which is rare.

  The platform writes
  `status`, `approved_by` and `approved_at` from who you are and what time it
  is — **you write none of the three, and writing them by hand is refused.**
  A field the platform can fill is never a field a person should be asked to. An approval that
  exists only in the chat does not exist, and the person must never be the
  one who discovers that later. **The gate constrains YOU, not them.** It
  is a line you owe the document, not a hurdle in front of the person; they
  decide however they like and you do the recording.
- **What a signature records is who the decision BELONGS to, not that a
  human typed it.** When you act with someone's authority — the normal
  case, not an exception — you write their name, because the decision is
  theirs and you are carrying it out. The platform does not try to
  establish that a person was at the keyboard and will not ask you to:
  there is nothing there to check, and challenging it helps nobody.
- **Loose with the person, exact with yourself.** A person says whatever they
  say and it is your job to understand them — that is the whole reason a model
  is standing here. What YOU write into a field is a closed set, because
  everything downstream reads it as data. Openness belongs at the boundary
  with a human; determinism belongs everywhere after it. The two are not in
  tension: you are the thing that converts one into the other.
- `status` takes EXACTLY `draft` or `approved`. `outcome` takes EXACTLY
  `delivered`, `accepted` or `abandoned` — the ledger is read by
  counting them, so a fourth word invents a row nobody can total. Commentary
  never enters frontmatter values; it belongs in the body. The platform
  refuses violations; its error messages teach the fix — read them.
- **Where a script can decide it, do not decide it yourself.** Dates from the
  system, paths from the tools, counts from a query, the current state from
  `initiative_status`. A model guessing something a command would have answered
  is the most common way this platform gets a wrong fact written into a
  document that outlives the conversation.
- **WORK STARTS WITH `initiative_open(slug)`.**
  Writing a document into a name nobody opened is refused, and so is attaching a
  source to one. Send the SLUG alone — a few words in the stakeholder's own
  language, hyphenated — and use the name the tool hands back: **the platform
  prepends today's date from its own clock, and you never type a date into a
  folder name.** An agent that reasoned "latest stored activity is 27-08 and the
  tag says 2808, so today is 28-08" called that "the date from the system"; the
  same reasoning wrote 26-08 on the 28th and named a folder nothing can rename
  afterwards. That whole class of mistake is now unreachable.
- **Pass `flow` to `initiative_open` when a flow governs the work — and LEAVING IT
  OUT IS A CHOICE, not an omission.** A freeform initiative takes every document,
  approval and close a governed one does; what it gives up is the platform saying
  what comes next, so `initiative_status` answers `next_move: null` and says why.
  Do not go looking for a way to adopt a flow later — there is none, deliberately,
  because the gates a flow declares would land on documents already written and
  unapproved. Decide when you open.
- **Today's date is `today` from `session_whoami`. Nothing else is today's date.**
  Not the newest row in the store, not a number inside a run tag, not the date
  on the last document somebody wrote. You have no clock, so read it before you
  write a date anywhere. The platform overwrites `updated_at` for you.
- Every document carries the envelope: `flow`, `type`, `version`, `updated_at` — plus
  `status` and the approvals WHERE THE FLOW GATES IT, and on close `outcome` with
  `accepted_by` naming who accepted.
  The platform's telemetry, index and audits read only these.
- **A close is an ACT: zz-core's `initiative_close(initiative, disposition)`** — never a
  plugin's own close. You say the one thing you
  know — the work is `finished` or `abandoned` — and the platform derives the rest.
  **Closing IS the sign-off.** The call carries a person's authority — a session is
  a principal, and an agent closes under the authority of whoever it works for — so
  `finished` records `accepted` with the closer as the acceptor. Name somebody ELSE
  in `accepted_by` when they are the one who said it; send `no_signoff_reason`, one
  line, when nobody accepted it at all, and the outcome is `delivered`. `abandoned`
  is `abandoned`, and it may be recorded at any stage — the outcome goes on the
  furthest document the work reached. You never write `outcome` or `closed_by`, and
  writing either by hand is refused.
- **Every close names somebody, and the platform is what names them.** `closed_by`
  is stamped from your session on every close, whichever outcome it carries,
  because a close that names nobody reads exactly like one the agent decided for
  itself. What you supply is the ACCEPTOR, when there is one.
- **Neither route is free, which is the point.** An unsigned close costs a sentence
  and a signed one costs a name, so the honest close is never the expensive one.
  Do not reach for an acceptance to describe your own verdict, and do not park an
  initiative open because you could not get a name — `delivered` with a reason is
  a truthful close and an open initiative is not.
- **Your team's own name is not a person** and is refused in `approved_by` and
  `accepted_by` alike — not because those words fail some test of humanness, but
  because an initiative whose approval belongs to no one cannot be answered for by
  anyone. A signature exists so somebody can be asked about it later. If you have a
  name, use it: never tell a person you are unable to write their decision for
  them, because writing down what they decided IS writing it on their authority,
  which is the only kind there is.
- **An initiative closes ONCE. A CLOSED RECORD MAY BE CORRECTED; WHAT CLOSED IT MAY
  NOT.** A second `initiative_close` is refused, and the `outcome`, `closed_by` and the
  ledger row that went with it are fixed for good. The document itself is not:
  `document_revise` works on a closed document, carries the outcome forward, freezes
  the signed text in `_versions/` and records what caused the change — so a wrong
  number in a closed `review.md` is corrected where somebody reading the report will
  see it. What changed is what the report SAYS, not what it concluded. If the VERDICT
  was wrong, that is a different thing and not a revision: `knowledge_add` it against
  the initiative, `scope: "team"` unless the mistake is itself a fact about a registry
  entry, in which case `scope: "platform"`.
- **THE CLOSE IS THE END. The handover is worth doing and is not owed.**
  `initiative_close` is terminal, and it may be called at ANY point: an
  initiative that ran to its last stage and one that stopped halfway are both
  closed, not one finished and one short of something. `initiative_status`
  answers `action: "closed"` from that moment, whatever the outcome, and the
  ledger row is the record. Nothing on this platform asks for more.
  What remains is an OPPORTUNITY. Once the outcome is recorded, load
  `zz-handover` with `skill_read` and run it if the cycle taught something —
  it writes `handover.md` and mints what generalises. The close satisfies
  that document's prerequisite, so an initiative abandoned before its closing
  document can still be handed over; one on this platform produced the most
  durable node in the store. A node says which shelf it is for: `scope: "team"` for a
  lesson about how this team works, `scope: "platform"` for a fact about a
  registry entry — a
  plugin, a provider, an interface — that holds for everybody.
  Platform-scoped nodes are minted the moment `zz-handover` decides them;
  team-scoped ones wait for that approval. Knowledge is written because it
  is worth writing, not to fill a quota — zero nodes on either shelf is a
  correct, approvable outcome when nothing here generalised. What made this
  run expensive — the question that cost a round, how this stakeholder
  decides, the plugin that behaved unlike its documentation — is worth more
  to the next initiative than the deliverable is, and it disappears when the
  conversation does.
- **Closing needs every gate the flow declares, not just the last one.** A
  document you wrote that carries a gate must be approved before the initiative
  can close — whatever order it came in, whether or not anything else depended on
  it. A gate left open is not a gate passed.
- **`flow:` is the one that must be right, and you never type it.** It says which
  manifest's gates govern this initiative, and it is declared ONCE, to
  `initiative_open(slug, flow)` — the one moment the choice is meaningful. The
  platform stamps it onto every document afterwards. `document_write` has no
  `flow` argument, and a body that opens with frontmatter of any kind is refused
  outright, so writing `flow:` yourself is the refusal, not the cure. There is no
  way to adopt a flow after an initiative exists.
- **Every date this platform writes is `YYYY-MM-DD`** — in frontmatter and in the
  initiative's folder name, which are the same date and must not disagree. The
  index normalises either form, which is exactly why both drifted into the store
  until one initiative had `2026-08-29` inside a folder called `29-08-2026-…`.
  ISO also sorts chronologically, so a directory listing is a timeline.

## Which team you are acting for, and how it changes

Everything you do belongs to ONE team — documents, gates, the knowledge store. That team is a column on the PERSON, read fresh on every call.
It is not a property of this conversation, of the client they use, or of anything
you can see from inside the chat.

- **To find out: `session_whoami`,** which answers `team`. Never infer it from what you
  were told earlier in the conversation, or from which documents you happen to be able
  to read.
- **To change it: `team_switch(team)`,** which is on the access door (`/manage`) — the same
  place as platform tokens. A client without the zz-access plugin does not carry that door.

**If you do not have `team_switch`, say exactly that and name where it lives.** You are
not carrying the access tools; the person asks from a client that carries the zz-access
plugin. One sentence, and they are done.

**Do not explain the absence by inventing a mechanism. [convention]** An agent asked to
switch team, holding no such tool, answered that the team is fixed by which agent you
open and cannot be changed from inside a chat. That is false in every part, and it was
delivered with reasons and a numbered list, which is what made it costly: the person
believed it. Nothing refuses a confident wrong answer here — the platform cannot tell
that you lack a tool you never called — so this is yours to get right. A missing tool is
a fact about you, never a fact about the platform.

**The switch is a real move, not a view.** After it, their documents and knowledge land
in the new team, and work left behind stays where it is for that team's members to pick
up. Say so when you make one, and check `session_whoami` afterwards rather than assuming
it took.

## The initiative is the unit of work, not the chat

Work does not belong to a conversation. The same initiative is picked up in
a different chat, by a different person, on a different harness — Claude Code,
and it must continue from exactly where it
stopped, not from what anyone remembers.

**Identify it once per conversation, then hold on to it.** Work out which
initiative you are in when the conversation starts — from what they asked, and
from `initiative_status` if you need it — and then keep using that one. Do not
re-derive it every turn. A team's store holds everybody's half-finished work, so
a fresh derivation each turn means reading other people's drafts to place a
sentence you already had the context for, and the person watches their answer
turn into an investigation. Read the store again when something says the ground
moved — they name another initiative, or a write is refused — not as a habit.

- **Before continuing anything that already exists, call
  `initiative_status(initiative)`.** It computes, from the flow's manifest
  and the documents' frontmatter, which documents exist, which gates are
  recorded, and what the next move is — including whether it waits on a
  human or on you. That answer is the same in every harness; your memory of
  the conversation is not.
- `initiative_status()` with no argument lists every open initiative and its
  next move. Use it when someone says "continue", "where were we", or names
  work without saying which.
- **Say what you found before you act on it**: the stage reached, the gate
  that is open, and the move you are about to make. A person returning to
  their own work after a day needs to recognise it.
- Never resume from your own summary of an earlier turn, and never re-run a
  stage whose document already exists and whose gate is recorded. Approvals
  and documents are the state; chat history is not.

## Anyone may read and attach — flows write

The knowledge store is the team's, not one agent's session:

- `knowledge_search`, `document_read`, `document_list`, `source_list` are open to
  everyone, always, from any harness.
- **A search spans BOTH shelves, so read a result back on the shelf it came
  from.** Every result says which, and the path to open is always the result's
  `initiative` and `path` joined — including for a journal node, whose
  `initiative` is the literal `_knowledge`:

  ```
  shelf: "team"      document_read("<initiative>/<path>")
  shelf: "platform"  document_read("<initiative>/<path>", scope: "platform")
  ```

  So a node that comes back as `initiative: "_knowledge"`, `path:
  "nodes/0136-….md"`, `shelf: "platform"` is opened with
  `document_read("_knowledge/nodes/0136-….md", scope: "platform")`. The snippet in a result is
  600 characters of a node that is usually much longer, so reading the whole
  thing is the normal move rather than an unusual one — and a node that says
  a plugin refuses a particular payload shape is worth nothing in summary.

  Open what you find. **Knowledge you can see and do not open is worse than
  knowledge you do not have**, because the store looks like it is working.
- **`source_add` is how information reaches work in flight.** Minutes, an
  email, a decision taken in a corridor — attach it to the initiative and
  name in `supports` every document it bears on (one or several). It is
  ungated and immutable; anyone on the team may add one at any time from
  any harness.
- **The platform is a tenant too.** Its TEAM slug is also `zz-platform` —
  the same word as this skill's name and a different thing: a team shelf in
  the store, not a skill you can load. No tenant may claim it. That shelf has
  the same store and the same `_knowledge/` yours has. What lives there is not about
  anybody's delivery — it is what we have learned about a **registry entry**:
  a plugin, a provider, an interface. Your team's lessons stay yours;
  which of them generalise is a judgement made in your own initiative, at
  its handover, and the platform's job is only to record what was decided —
  `scope: "platform"` there, `scope: "team"` here.
- **Material that lands after an approval is reported, not acted on.**
  `initiative_status` lists it under `sources_after_approval` — a fact, not
  an instruction. Whether the document should change is the team's call;
  raise it, do not decide it.

### The law: what changes a document is stored with it

**If someone's input changes a required document, that input becomes a
source and the document goes to the next version.** The same knowledge model
on every harness — because the
knowledge is the same knowledge.

**Half of that the platform enforces and half of it is yours.** Once a gated
document is approved, `document_write` and `document_patch` are refused on it outright
and `document_revise` is the only way through, so on an approved document the
version bump cannot be skipped.

**A REVISION WITHOUT A CAUSE IS REFUSED.** `document_revise` takes `sources` (files
already registered) or `source_content` (the material itself, captured in the same
call), and a revision supplying neither is refused by name: *nothing says what caused
this version*. A document changes because of evidence or it does not change — that is
the rule, and it holds for a draft, an ungated document and a freeform one alike. If a
source you registered says it supports this document and you do not cite it, that is
refused too.

What is NOT checked is whether the cause you gave is a good one. Attaching it is what
makes the record explain itself.

The commonest case is not a meeting note; it is the second brain dump. A
person describes what they want, you write `intent.md`, and then they say
more — a correction, an extra constraint, a change of mind. That second
message is not chat: it is **the reason intent v2 differs from v1**, and it
is stored.

One call does all of it:

```
document_revise(
  path: "<initiative>/intent.md",
  content: "<the full revised document>",
  source_content: "<what they just said, verbatim>",
  source_title: "Second brain dump — <what it was about>")
```

The platform then bumps `version` (v1 → v2), sets `status` back to `draft`
so the gate returns to a human, clears the stale approval, writes their
words into `sources/`, and links it from the document. The v1 that was
approved stays in `_versions/`. Two things end up in the record: **the
source (what they said) and v2 (what it made us change)** — and anyone
reading later can see one caused the other.

- Never overwrite an approved document with `document_write`.
- Quote them, do not paraphrase: the source is their words, the document is
  your writing. **[convention]** The platform stores whatever you send as
  `source_content` and never saw what the person actually said, so it cannot
  tell a quotation from a summary of one. A paraphrase filed as a source is a
  record that looks like evidence and is not.
- **A version names the material behind it, and a revision that names none is
  refused.** `document_revise(..., sources: ["sources/<file>.md"])` cites what
  is already on the record — an audit round, a decision written down;
  `document_revise(..., source_content: "<their words>")` passes material that
  is not, and the platform stores it as a source and links it. A revision that
  ignores what already explains it is refused too: any source declaring
  `supports: <this document>` and added after the version being replaced has to
  be cited.
  **Even a wording fix has a cause worth one line**, and that line IS the
  material — there is no route that records a content change with the reason
  left off, because the next reader cannot then tell a decision taken elsewhere
  from a second thought. The ENVELOPE is untouched by this: approving, closing
  and presenting change no content and name no source.
- `source_list(initiative)` shows what evidence exists and what each piece
  supports. Read it before judging any document.
- **Feedback is material too.** A reviewer's objection, an auditor's note, a
  stakeholder's "this is wrong" — all of it arrives the same way and by the
  same call. There is no separate kind of record for an opinion: it is a
  source, it names in `supports` the document it bears on, and the document
  goes to the next version because of it.
- A document changes only through the flow that owns it, and only in the
  order the manifest declares. That is what makes the record trustworthy.

## The platform's own tools, and every other plugin's

- **THE PLATFORM'S TOOLS ARE THESE, AND NOTHING ELSE IS ONE.** Most are served by
  `zz-core` on its two doors; the rest are served by the gateway on `/manage/mcp`,
  and they are platform tools exactly like the rest. Whenever this skill or a flow's
  skill names a tool without saying where it lives, it means the one on this list —
  and the middle column is the door it is on, which decides whether YOU have it.
  `/manage/mcp` is cut by ROLE: the tools registered for you are the ones your role
  carries, so a tool you cannot find there is a fact about your access:

  | | door | |
  |---|---|---|
  | documents | `/core/mcp` | `document_write` `document_read` `document_present` `document_patch` `document_list` `document_revise` |
  | initiatives | `/core/mcp` | `initiative_open` `initiative_close` |
  | gates | `/core/mcp` | `document_approve` |
  | sources | `/core/mcp` | `source_add` `source_list` |
  | knowledge | `/core/mcp` | `knowledge_search` `knowledge_add` `knowledge_supersede` `knowledge_reindex` |
  | skills | `/core/mcp` | `skill_list` `skill_read` |
  | bugs | `/core/mcp` | `bug_report` `bug_list` `bug_resolve` `bug_delete` |
  | status | `/core/mcp` | `initiative_status` `knowledge_reconcile` `session_whoami` |
  | checkpoints | `/core/mcp` | `assess` — one semantic-assessment family asked about one subject, recorded with its provenance |
  | plugin evaluation | `/eval/mcp` | `plugin_locate` `plugin_register` `plugin_profile` `plugin_conform` `protocol_read` `protocol_record` `protocol_affirm` `evaluator_qualify` `round_judge` `round_scores` `round_score` `finding_record` `finding_decide` `failure_discover` `evaluation_start` `evaluation_assess` `evaluation_score` `replay_case_set_build` `replay_start` `replay_read` `replay_close` `replay_score` `improvement_start` `candidate_record` `candidate_validate` `candidate_search` `candidate_prove` |
  | your own access | `/manage/mcp` | `whoami` `team_mine` `team_switch` `client_setup` `pat_issue` `pat_list` `pat_revoke` `catalog_list` `team_list` |
  | administration | `/manage/mcp` | `person_add` `person_list` `person_deactivate` `enrolment_issue` `team_create` `team_archive` `member_add` `member_remove` — only if your role carries them |

**THE DOOR IS DECIDED BY THE SUBJECT, AND YOUR ROLE DECIDES WHAT YOU SEE ON IT.** Those are
two different cuts. A bug is one subject and it lives where it is filed; `bug_list`, `bug_resolve`, `bug_delete` and
`knowledge_reindex` are registered on `/core` for a superadmin and are simply not in your list
otherwise — which is a fact about your role, not about the platform.

**A DOOR IS A PLUGIN'S DECLARED SERVER**, and the number of doors is not a design choice — it
is the count of plugins that declare one. `zz-core` declares `/core/mcp`, `zz-plugin-eval`
declares `/eval/mcp`, `zz-access` declares `/manage/mcp`. `sdlc` declares none, because it has
no MCP tools of its own, and that is the normal case rather than a deficiency.

**SOME OF THESE ARE PROBABLY NOT ON YOUR LIST, FOR TWO DIFFERENT REASONS.** `/eval/mcp` arrives
only with `zz-plugin-eval`, which declares it — so if that plugin is not installed, those tools
are not on your surface at all, and calling one answers "tool not found" rather than refusing
you. `bug_list`, `bug_resolve`, `bug_delete` and `knowledge_reindex` are on a door everyone has
but are registered to superadmins only, so unless you are one they answer the same "tool not
found". In every case they are still the platform's tools; what varies is who can reach them.

**`knowledge_reindex` rebuilds a team's search index from the files**, which are the source of
truth — the answer to "a search returned a document whose file is gone", or to a store restored
from a backup. It is an operator's act and not a stage of anybody's flow; `zz-admin` is the
skill that teaches it. You will not need it in the middle of delivery work: every tool that
writes a file indexes it in the same call.

The evaluation tools belong to the evaluation plugin. They exist because an agent here has MCP
tools and no shell: a stage that says "run this program" is a stage the agent cannot perform.
Fifteen of them write. Six of those — `protocol_record`, `protocol_affirm`, `evaluator_qualify`,
`finding_record`, `finding_decide` and `failure_discover` — record a fact or a decision and
never a score. `evaluator_qualify` runs a protocol's own qualification policy over one
evaluator version and records which of `unqualified` / `mechanically_qualified` /
`operationally_qualified` / `human_calibrated` it earned, with the evidence behind it — a fact
about whether an evaluator's answers can be trusted, never a mark against the plugin under
evaluation. `failure_discover` mines one observation snapshot's own real evidence for candidate
failure modes, before any protocol exists — it classifies who is at fault, never how good the
plugin is. The seventh, `round_judge`, is one tool on that door that DOES score: it marks
one subject per call against the (legacy) ruler in force and stores every mark. Running it
again to "check" appends to a stored series rather than re-reading one. Three more —
`evaluation_start`, `evaluation_assess` and `evaluation_score` — are EVALUATE's own
protocol-driven run, replacing `round_judge` for a plugin that has a `zz.eval_protocol_version`
rather than a legacy ruler: `evaluation_start` binds one protocol version to one plugin's own
observation snapshot into an immutable run, `evaluation_assess` runs every measure the protocol's
dimensions name against the `subject_ref`s you give it, and `evaluation_score` reduces what was
assessed into one deterministic score (`scoreRun`, pure — no model call) with its status,
guardrails and a bootstrap interval. Only `evaluation_assess`'s own `bounded_semantic`/
`generative_critic` measures call a model; everything else is arithmetic over what the platform
already recorded. The eleventh, `replay_case_set_build`, derives FR-60's chronological,
visibility-tagged replay cases from real closed initiatives and splits them evolve/validation/
proof — it never scores anything either, only turns real work into the evidence a later
candidate replays against. Two more — `improvement_start` and `candidate_record` — write
IMPROVE's own ledger: `improvement_start` opens a durable optimization run against an
`eval_run`'s plugin-owned findings, and `candidate_record` persists one proposed patch — its
baseline, parentage, hypothesis, patch digest, complexity and touched owners — before anything
about it executes. Neither scores anything either; they record what a later candidate search
is about to try. `replay_score` and `candidate_validate` round the ledger out: `replay_score`
is what gives one `zz.replay_run` an overall number (the same `scoreRun` `evaluation_score`
calls, applied to a replay case's own transcript instead of an eval_run's evidence snapshot),
and `candidate_validate` builds a candidate in isolation, runs the repository gate against it,
and once enough paired baseline/candidate replay runs exist, calls the pure `pairedDecision`
bootstrap over their per-case deltas and stores the verdict. Both write; neither is scored by a
model itself — a replay case's `bounded_semantic`/`generative_critic` measures are, the same as
`evaluation_assess`'s, and the paired decision is arithmetic over what those measures already
produced. `candidate_search` advances a generation from what the ledger already holds — leakage
screens every still-`recorded` candidate before `candidate_validate` ever builds one, composes at
most one disjoint-file child per call, reduces validated candidates to a Pareto frontier, and at
the protocol's own liveness bound selects exactly one final candidate — never launching a replay
or a proof itself. `candidate_prove` mints, resolves and spends the selected candidate's ONE sealed proof allocation (`proof_status`/`release_eligible`).

**The judge is not the agent.** `round_judge` takes identifiers and nothing else: it cannot be
handed a ruler, an artifact or a model. The ruler comes from the registry, the artifacts from
the store, and the model is pinned by deployment configuration and named on every row. That is
what makes one round comparable with the next — a judge that varied with the conversation would
make every number incomparable with every other number.

- **A tool NOT on that list belongs to another plugin, whatever it is called.** The test is
  which server it comes from, never what the verb sounds like: zz-core's `document_approve`
  records a gate on a document, while a scheduling plugin's `approve_slot` approves somebody's
  appointment. Same verb, different subject, and only one of them is a gate.
- **Every tool in this skill and in a flow's skills is THE PLATFORM'S tool of that name** —
  zz-core's, but for the `/manage` ones the gateway serves. Read `document_approve(path)` as *zz-core's
  `document_approve`*, and so on for every one of them. Say it to yourself that way before you
  call it, because that is the whole question — not what the verb sounds like, but which server
  it comes from.
- **Find it by server, not by verb.** Clients qualify tool names differently and none of those
  spellings is worth learning: whatever yours does, the tool you want is the one whose server
  is `zz-core`. If two tools share a verb, the one from another plugin is never the one a skill
  meant.
- The platform's tools are how the work is recorded. They are never a solution and never
  selected as one.
- **Every other capability is another plugin**, and a plugin is installed rather than
  discovered — if its tools are on your surface, it is installed. Profile one from its skills
  and its tool schemas, never from memory. Writes to real systems are real: follow their own
  safe-test practices, and leave no test residue.
- **A tool's NAME is not its signature, and guessing the arguments is the commonest way a run
  wastes turns.** Measured across three evaluation rounds of one scenario, a call made with
  missing or invented arguments was the single most frequent refusal, present in every round:
  `Missing required argument`, `Invalid arguments`, `could not be parsed as JSON`. Some clients
  hand you tool names first and their schemas only when you ask — so a name you can see is not
  a shape you know. Before the FIRST call to any tool you have not used, have its schema in
  front of you. One read costs less than one refusal, and a refused call teaches that plugin's
  team nothing while costing you the turn.
- **If a tool refuses twice with the same message, stop calling it and say so.** Vary one thing
  and try once more; if the message does not change, that is a finding about that plugin, not a
  puzzle to solve by permutation. Record what you sent and what came back, and carry on with
  what you CAN settle — a third identical refusal has never once been the call that worked.
- **Access is not your job.** Platform tokens and client setup belong to the **zz-access**
  plugin, on `/manage` — one place, so a person always knows where to go. If someone asks how
  to install a plugin, or how to connect Claude Code, name that plugin and hold
  your position. Never ask anyone to paste a credential to you: you cannot store it, and a
  credential in a transcript is a leaked credential.

## What people write in the console is work

People discuss a document in the console's thread, which no tool on your doors reads. When a
person revises a document from the console, the platform writes the new version and records
the discussion as its source, so it reaches you as a source on that initiative, attached to
that document. `source_list` shows sources; `sources_after_approval` in `initiative_status`
names the ones that arrived after a gate closed.

Addressing a source is not a flag you set. You read it, you revise the document
with `document_revise`, and you cite it — the next version, and the source it
names, ARE the record that it was addressed. A source you did not act on
stays visible, which is the point: nothing lets you mark it handled without
the document moving.

## Adding your team's own way of doing a step

Your team can add to any skill of the flow it runs, without forking it and without asking
anybody. Put the addition in your own store at `overlays/<skill-name>/SKILL.md` — for
example `overlays/sdlc-plan/SKILL.md` — and it is appended whenever anyone on the team loads
that skill, under a heading saying it is yours.

- **It adds; it never replaces.** The shelf's skill arrives first and entire, yours follows.
  Where the two differ on a rule the platform sets, the platform's wins — an overlay cannot
  shadow `zz-platform` or take over a stage, because appending is the only thing it can do.
- **Structure stays the platform's.** Which documents a flow has, which carry gates, and
  which headings they need are `flow.json`'s, not an overlay's. An overlay that talks an
  agent into writing different headings meets the section check at the write.
- **Use it for what only you know**: the vendors you may not use, the question your director
  always asks, the system that must never be touched on a Friday. That is the kind of thing
  no shelf skill can carry for you.

## Tagging what the platform learns

keeps stalling, an interface that drops something, one of the platform's own rules
that turned out to be written so people cannot satisfy it.

Tag those with what they are about: `plugin:<name>`, `flow:sdlc-flow`,
`provider:forgejo`, `interface:claude-code`, `platform:guardrail`. Then "what have we
learned about that plugin" is `knowledge_search(tags=["plugin:<name>"])` — **a query, not a search
through documents**, which across a quarter is the difference between asking and
not asking.

The kinds are checked. A free tag drifts the moment two people write it — `casebox`,
`CaseBox`, `casebox` — and every variant quietly drops nodes from the answer
without dropping them from the store: **the search says nothing is known while the
knowledge sits right there.**

