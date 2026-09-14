---
name: zz-backbone
version: 3.26
description: "The platform spine every flow's skills stand on: file tools, gates, documents, when a block is checked and how it is chosen, credentials, sources. Flow-agnostic — load once at the start of ANY flow on the ZZ platform, before the flow's own entry skill. Owned by the platform team; flows never duplicate these rules."
when_to_use: "A flow's entry skill tells you to load this first. Also load it whenever you operate on the ZZ platform's artifact store or blocks outside a flow."
---

# zz-backbone

These rules hold for every flow on this platform — sdlc, sm, and every flow
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

## A block is checked when something needs it, never before

**There is no pre-flight.** A flow does not know which blocks it needs until it has
worked out what it is building, so a check at the start asks a person to connect
things the work may never touch. With three blocks that is merely wrong. With a
hundred it is a wall in front of the door.

Two different needs arise, usually at different moments, and only the second one
involves connecting anything:

- **To CHOOSE a block you need to know what it is for.** That is a capability
  question, not a connection one, and the answer is a capability sheet: what each
  block is for, what it fits, and what it does not. The sheet belongs to the flow
  that selects blocks, and this page deliberately names none: there is no
  flow-agnostic sheet to name. What is flow-agnostic is the rule. Narrow to
  one or two candidates, then read those blocks' own documentation to confirm —
  `block_skills()` with no argument lists every block this platform routes and how
  many skills each ships; with a block id it names that block's skills and what each
  one is for. That is the reading, and it is why you never have to guess a name.
  Never read every block's tool surface to decide: a verb list tells you a call
  exists, not where the work belongs, and a hundred blocks is ten thousand tools.
- **To USE a block you need to reach it, and you find that out by USING it.** Call
  the tool the work needs. If it answers, you are connected and there was never a
  question.

  **A block you are not connected to has NO tools in your list at all. [convention]**
  Not one stub tool, not an error tool — nothing. The door answers the front end with
  a sign-in challenge rather than a session, so the block simply is not there.

  So when a tool you expected is missing, that is the signal, and the answer is one
  sentence to the person: **open the MCP settings in this front end, find that block,
  and press Connect.** It runs the block's own sign-in, they choose what to allow, and
  the block's toolset appears on their next message. Nothing is stored by the platform
  and there is no key for anyone to paste — never ask for one, and never ask them to
  reconnect their ZZ access, which is a different credential and is not the problem.

  This replaced a stub tool called `credential_required` that a disconnected block used
  to offer. Do not look for it; it is gone. It existed because a block that vanished
  silently left an agent with nothing to say — but the cost was that the front end
  showed such a block as CONNECTED, since it had answered, so people saw a healthy dot
  on a block that refused every call. The panel now tells them the truth directly,
  which is a better place for it than a tool description.

**Confirm reachability when your flow WRITES DOWN that it will use a block.
[convention]** The moment the decision is recorded, not at the first call. By the
first call you have planned work around it, and discovering there that the person
cannot connect wastes the plan. Every flow has such a moment because every flow
records its decisions; what the document is called is the flow's business, not this
skill's. Nothing checks the timing: no write is refused because a block it names was
never reached, and the platform has no way to know which of your calls was the
confirming one. Getting this wrong costs a plan, not a refusal.

**Check only what you chose.** A person who needs one block signs in to one block.
Asking for the others is asking for authority nobody needs, which is the opposite of
what delegated access is for.

## Files are tools, and files are real

- The store is on the PLATFORM, not on any machine you can reach. The
  artifact tools are the only way in: `list_files`, `read_file`,
  `write_file`, `patch_file`. Paths are relative to your team's store, e.g.
  `2026-08-19-sample-intake/spec.md`. This skill is loaded in the browser and in
  Claude Code, Codex and Hermes alike — where you do have a shell, it reaches
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
  `show_document(path)` and put what it returns in front of the person as
  Markdown (the chat renders GFM and Mermaid) — `File: <path>`, a horizontal
  rule, then the document. Never only a path. **What the platform holds is the
  fetch, not the showing.** Every `show_document` call appends a `shown` entry
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
  closed with four of its six approvals carrying no `show_document` since the
  content had last moved — an eleven-task plan among them, approved twice,
  fetched never, one of those approvals four seconds after the revision that
  produced it. Nothing disagreed, because nothing was looking. `approve` now
  says so in its own result when it happens, so the gap reaches the caller in
  the same turn instead of surviving to the retrospective. **It still does not
  refuse, and it must not start to** — a refusal there would land on the one
  call whose job is to record a decision a person already made.

## Gates and the envelope

- **Decide whether they agreed. Do not match their words against a list.**
  "ok", "go ahead", "approve first", "I think that's right — start" are
  agreement when they answer a clear ask, and so is a standing "you do not
  need to check with me on these", which keeps holding until they say
  otherwise. This rule used to name three accepted phrases and refuse the
  rest, which is a way to fail the person who said it the fourth way and
  make them repeat a decision they had already made. Judge it the way a
  colleague would. Ask again ONLY when you genuinely cannot tell WHAT they
  agreed to — never as a ritual, and never to collect a better-worded
  version of a yes you already have.
- **A gate is not passed until it is recorded**: the moment they agree, call
  zz-core's `approve(path)` in that same turn, before moving on.

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
- **Today's date is `today` from `get_my_info`. Nothing else is today's date.**
  Not the newest row in the store, not a number inside a run tag, not the date
  on the last document somebody wrote. You have no clock, so read it — one call,
  before you name an initiative or write a date anywhere. An agent that reasoned
  "latest stored activity is 27-08 and the tag says 2808, so today is 28-08"
  called that "the date from the system"; the same reasoning wrote 26-08 on the
  28th and named a folder that nothing can rename afterwards. The platform
  overwrites `updated_at` for you, but it cannot fix a directory name you chose
  before the first document existed.
- Every document carries the envelope: `flow`, `type`, `status`, approvals
  when gated, and on close `outcome` with `accepted_by` naming who accepted.
  The platform's telemetry, index and audits read only these.
- **A close is an ACT: zz-core's `close(initiative, disposition)`** — never a
  block's own close. You say the one thing you
  know — the work is `finished` or `abandoned` — and the platform derives the rest.
  `finished` with somebody named in `accepted_by` is `accepted`; `finished` with
  nobody named is `delivered` and owes `no_signoff_reason`, one line on why nobody
  signed off; `abandoned` is `abandoned`. You never write `outcome` or `closed_by`,
  and writing either by hand is refused.
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
- **An initiative closes ONCE, and a close is not editable afterwards.** A second
  `close` is refused, and so is revising the document that records one — the ledger row
  was appended at that close and is what the team's counts read, so changing the document
  now would leave the two disagreeing. If a close was wrong, that is a fact about the
  record worth writing down: `knowledge_add` it against the initiative, `scope: "team"`
  unless the mistake is itself a fact about a registry entry, in which case
  `scope: "platform"`. A correction somebody can find beats an overwrite nobody can.
- **After the close comes the handover, and it belongs to the platform.**
  Every flow ends the same way, whatever its manifest says: once the outcome
  is recorded, load `zz-knowledge` with `skill_view` and run it now — it
  writes `handover.md`, the one document the handover is. `initiative_status`
  keeps returning `action: "handover"` until a team member approves it; only
  then does the initiative report `action: "closed"`. It is not the flow
  author's call to make, which is why the platform runs this the same way
  after every flow. A node says which shelf it is for: `scope: "team"` for a
  lesson about how this team works, `scope: "platform"` for a fact about a
  registry entry — a
  block, a flow, a provider, an interface — that holds for everybody.
  Platform-scoped nodes are minted the moment `zz-knowledge` decides them;
  team-scoped ones wait for that approval. Knowledge is written because it
  is worth writing, not to fill a quota — zero nodes on either shelf is a
  correct, approvable outcome when nothing here generalised. What made this
  run expensive — the question that cost a round, how this stakeholder
  decides, the block that behaved unlike its documentation — is worth more
  to the next initiative than the deliverable is, and it disappears when the
  conversation does.
- **Closing needs every gate the flow declares, not just the last one.** A
  document you wrote that carries a gate must be approved before the initiative
  can close — whatever order it came in, whether or not anything else depended on
  it. A gate left open is not a gate passed.
- **`flow:` is the one that must be right.** It says which manifest's gates
  govern this initiative. Write it on the FIRST document — the platform stamps
  it onto later ones, but it can only stamp a flow it has been told, and a first
  document without it is refused. Every team has more than one flow to choose
  from: the platform flows ship to everyone alongside whatever the team installed,
  so nothing but this line can say which one applies.
- **Every date this platform writes is `YYYY-MM-DD`** — in frontmatter and in the
  initiative's folder name, which are the same date and must not disagree. The
  index normalises either form, which is exactly why both drifted into the store
  until one initiative had `2026-08-29` inside a folder called `29-08-2026-…`.
  ISO also sorts chronologically, so a directory listing is a timeline.

## Which team you are acting for, and how it changes

Everything you do belongs to ONE team — documents, gates, the knowledge store, which
blocks you may reach. That team is a column on the PERSON, read fresh on every call.
It is not a property of this conversation, of the agent they opened, or of anything
you can see from inside the chat.

- **To find out: `get_my_info`,** which answers `team`. Never infer it from the agent's
  name, from what you were told earlier in the conversation, or from which documents
  you happen to be able to read.
- **To change it: `switch_team(team)`,** which is on the ACCESS door — the same place as
  `connect_block` and a person's own keys. Not every agent carries that door.

**If you do not have `switch_team`, say exactly that and name where it lives.** You are
not carrying the access tools; the person opens the agent that does — ZZ Access — and
asks there. One sentence, and they are done.

**Do not explain the absence by inventing a mechanism. [convention]** An agent asked to
switch team, holding no such tool, answered that the team is fixed by which agent you
open and cannot be changed from inside a chat. That is false in every part, and it was
delivered with reasons and a numbered list, which is what made it costly: the person
believed it. Nothing refuses a confident wrong answer here — the platform cannot tell
that you lack a tool you never called — so this is yours to get right. A missing tool is
a fact about you, never a fact about the platform.

**The switch is a real move, not a view.** After it, their documents and knowledge land
in the new team, and work left behind stays where it is for that team's members to pick
up. Say so when you make one, and check `get_my_info` afterwards rather than assuming
it took.

## The initiative is the unit of work, not the chat

Work does not belong to a conversation. The same initiative is picked up in
a different chat, by a different person, on a different harness — Claude Code,
Codex, Hermes — and it must continue from exactly where it
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

- `search_knowledge`, `read_file`, `list_files`, `list_sources` are open to
  everyone, always, from any harness.
- **A search spans BOTH shelves, so read a result back on the shelf it came
  from.** Every result says which, and the path to open is always the result's
  `initiative` and `path` joined — including for a journal node, whose
  `initiative` is the literal `_knowledge`:

  ```
  shelf: "team"      read_file("<initiative>/<path>")
  shelf: "platform"  read_file("<initiative>/<path>", scope: "platform")
  ```

  So a node that comes back as `initiative: "_knowledge"`, `path:
  "nodes/0136-….md"`, `shelf: "platform"` is opened with
  `read_file("_knowledge/nodes/0136-….md", scope: "platform")`. The snippet in a result is
  600 characters of a node that is usually much longer, so reading the whole
  thing is the normal move rather than an unusual one — and a node that says
  a block refuses a particular payload shape is worth nothing in summary.

  Until 2026-09-09 the result did not say, and the read had no `scope`, so
  every platform node came back from `read_file` as "does not exist". An agent
  searched, found the two nodes describing the exact refusal it was about to
  hit, could not open either, hit it, and asked a non-technical person to
  build the thing by hand. **Knowledge you can see and cannot open is worse
  than knowledge you do not have**, because the store looks like it is
  working.
- **`add_source` is how information reaches work in flight.** Minutes, an
  email, a decision taken in a corridor — attach it to the initiative and
  name in `supports` every document it bears on (one or several). It is
  ungated and immutable; anyone on the team may add one at any time from
  any harness.
- **The platform is a tenant too.** `zz-platform` is its team, with the same
  store and the same `_knowledge/` yours has. What lives there is not about
  anybody's delivery — it is what we have learned about a **registry entry**:
  a block, a flow, a provider, an interface. Your team's lessons stay yours;
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
on every harness — Claude Code, Codex, Hermes — because the
knowledge is the same knowledge.

**Half of that the platform enforces and half of it is yours.** Once a gated
document is approved, `write_file` and `patch_file` are refused on it outright
and `revise_document` is the only way through, so on an approved document the
version bump cannot be skipped. The rest is not checked: a draft or an ungated
document is overwritten freely, and a revision with no source attached is
accepted — see *Capture is the goal, not a toll* below for why that is
deliberate. Nothing stops you changing a document because of something someone
said and recording no cause. Attaching it is what makes the record explain
itself.

The commonest case is not a meeting note; it is the second brain dump. A
person describes what they want, you write `intent.md`, and then they say
more — a correction, an extra constraint, a change of mind. That second
message is not chat: it is **the reason intent v2 differs from v1**, and it
is stored.

One call does all of it:

```
revise_document(
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

- Never overwrite an approved document with `write_file`.
- Quote them, do not paraphrase: the source is their words, the document is
  your writing. **[convention]** The platform stores whatever you send as
  `source_content` and never saw what the person actually said, so it cannot
  tell a quotation from a summary of one. A paraphrase filed as a source is a
  record that looks like evidence and is not.
- **Capture is the goal, not a toll.** A person may edit their own document
  and owes nobody a reason, and a revision with nothing attached is still
  accepted — that guarantee is not going anywhere. But it no longer "simply
  records no cause", and that sentence was wrong from the day `self_edit`
  shipped. **Silence now means two things and the record cannot tell them
  apart**: there was no external cause, or there was one and nobody captured
  it. Only the second is a gap anybody can close, and it is the one worth
  counting.
  So say which it was. `revise_document(..., source_content: "<their words>")`
  when something someone said caused the change; `revise_document(...,
  self_edit: "<what you edited>")` when nothing did — a short declaration of
  WHAT you changed, never a justification for changing it, because you still
  owe nobody that. Supplying both is refused: they are contradictory claims.
  Supplying neither is allowed and always will be, and the response will tell
  you plainly that the record now cannot distinguish your case from the other
  one.
- `list_sources(initiative)` shows what evidence exists and what each piece
  supports. Read it before judging any document.
- **Feedback is material too.** A reviewer's objection, an auditor's note, a
  stakeholder's "this is wrong" — all of it arrives the same way and by the
  same call. There is no separate kind of record for an opinion: it is a
  source, it names in `supports` the document it bears on, and the document
  goes to the next version because of it.
- A document changes only through the flow that owns it, and only in the
  order the manifest declares. That is what makes the record trustworthy.

## Process layer vs building blocks

- **THE PLATFORM'S TOOLS ARE THESE TWENTY-NINE, AND NOTHING ELSE IS ONE.** They
  are served by `zz-core`. Whenever this skill or a flow's skill names a tool
  without saying where it lives, it means the one on this list:

  | | |
  |---|---|
  | documents | `write_file` `read_file` `show_document` `patch_file` `list_files` `revise_document` |
  | gates | `approve` `close` |
  | sources | `add_source` `list_sources` |
  | knowledge | `search_knowledge` `reindex_knowledge` `knowledge_add` `knowledge_supersede` |
  | skills | `list_skills` `skill_view` `block_skills` |
  | status | `initiative_status` `reconcile` `get_my_info` |
  | utility | `encode_base64` |
  | plugin evaluation | `plugin_locate` `plugin_profile` `plugin_cases_record` `plugin_conform` `plugin_ruler` `plugin_ruler_record` `plugin_affirm` `plugin_judge` `plugin_scores` `plugin_finding_record` |

The evaluation tools belong to the evaluation flow. They exist because an agent here has MCP
tools and no shell: a stage that says "run this program" is a stage the agent cannot perform.
Most only read; the four that write — `plugin_cases_record`, `plugin_ruler_record`,
`plugin_affirm` and `plugin_finding_record` — record a fact or a decision and never a score.

**The judge is not the agent.** `plugin_judge` takes identifiers and nothing else: it cannot be
handed a ruler, an artifact or a model. The ruler comes from the registry, the artifacts from
the store, and the model is pinned by deployment configuration and named on every row. That is
what makes one round comparable with the next — a judge that varied with the conversation would
make every number incomparable with every other number.

  A tool NOT on that list belongs to a building block, whatever it is called. The
  test is which server it comes from, never what the verb sounds like: zz-core's
  `approve` records a gate on a document, while bookit's `approve_slot`
  approves somebody's appointment. Same verb, different platform, and only one of
  them is a gate.
- **Every tool in this skill and in a flow's skills is ZZ-CORE'S tool of that
  name.** Read `approve(path)` as *zz-core's `approve`*, `write_file` as
  *zz-core's `write_file`*, and so on for all twenty-nine. Say it to yourself that
  way before you call it, because that is the whole question — not what the verb
  sounds like, but which server it comes from.
- **Find it by server, not by verb.** Clients qualify tool names differently and
  none of those spellings is worth learning: whatever yours does, the tool you
  want is the one whose server is `zz-core`. If two tools share a verb, the one
  from a block is never the one a skill meant.
- They are how the work is recorded. They are never a solution and never
  selected as one.
- The BUILDING BLOCKS are every other connected server. Discover them at
  runtime; profile from their tool surface, docs tools and usage skills —
  never from memory. Writes to real platforms are real: follow their
  safe-test practices, and leave no test residue.
- **A block tool's NAME is not its signature, and guessing the arguments is the
  commonest way a run wastes turns.** Measured across three evaluation rounds of
  one scenario, a call made with missing or invented arguments was the single
  most frequent refusal, present in every round: `Missing required argument`,
  `Invalid arguments`, `could not be parsed as JSON`. Some clients hand you tool
  names first and their schemas only when you ask — so a name you can see is not
  a shape you know. Before the FIRST call to any block tool, have its schema in
  front of you, from the client's own tool description or the block's
  `read_api_spec`. One read costs less than one refusal, and a refused call
  teaches the block's team nothing while costing you the turn.
- **If a block refuses twice with the same message, stop calling it and say so.**
  Vary one thing and try once more; if the message does not change, that is a
  finding about the block, not a puzzle to solve by permutation. Record what you
  sent and what came back, and carry on with what you CAN settle — a third
  identical refusal has never once been the call that worked.
- **Access is not your job.** Personal keys for the blocks, platform
  tokens and client setup all belong to the **ZZ Access** agent — one
  place, so a person always knows where to go. A person signing in to a
  block AS THEMSELVES (`connect_block`) is better than a stored key and is
  what to suggest first: the block then records them rather than the
  platform, and there is no secret for anyone to hold. If a block call fails
  for a missing key, or someone asks how to connect Claude Code, Codex or
  Hermes, name that agent and hold your position. Never ask anyone to paste a key
  to you: you cannot store it, and a key in a transcript is a leaked key.
- When a block's API wants an encoded payload (a base64 email body, for
  example), call `encode_base64`. Encoding in your head is a guess, and a
  local shell — which only some of the clients that load this skill have —
  would make the result depend on where the conversation happens to be
  running. Never ask a stakeholder to encode or decode anything for you:
  that is the platform's job, not theirs.

## What people write from the web is work

People write on documents from the web view, and what they write lands as a
source on that initiative, attached to that document. `list_sources` shows
them; `sources_after_approval` in `initiative_status` names the ones that
arrived after a gate closed.

Addressing one is not a flag you set. You read it, you revise the document
with `revise_document`, and you cite it — the next version, and the source it
names, ARE the record that it was addressed. A source you did not act on
stays visible, which is the point: nothing lets you mark it handled without
the document moving.

## Adding your team's own way of doing a step

Your team can add to any skill of the flow it runs, without forking it and without asking
anybody. Put the addition in your own store at `overlays/<skill-name>/SKILL.md` — for
example `overlays/ops-select/SKILL.md` — and it is appended whenever anyone on the team loads
that skill, under a heading saying it is yours.

- **It adds; it never replaces.** The shelf's skill arrives first and entire, yours follows.
  Where the two differ on a rule the platform sets, the platform's wins — an overlay cannot
  shadow `zz-backbone` or take over a stage, because appending is the only thing it can do.
- **Structure stays the platform's.** Which documents a flow has, which carry gates, and
  which headings they need are `flow.json`'s, not an overlay's. An overlay that talks an
  agent into writing different headings meets the section check at the write.
- **Use it for what only you know**: the vendors you may not use, the question your director
  always asks, the system that must never be touched on a Friday. That is the kind of thing
  no shelf skill can carry for you.

*(This section was zz-kb-usage's until 2026-09-04. It is a platform rule — what an overlay
may and may not do — so it belongs in the spine every flow loads, not in a skill nobody
ever loaded.)*

## Tagging what the platform learns

keeps stalling, an interface that drops something, one of the platform's own rules
that turned out to be written so people cannot satisfy it.

Tag those with what they are about: `block:<name>`, `flow:sdlc-flow`,
`provider:forgejo`, `interface:claude-code`, `platform:guardrail`. Then "what have we
learned about that block" is `search_knowledge(tags=["block:<name>"])` — **a query, not a search
through documents**, which across a quarter is the difference between asking and
not asking.

The kinds are checked. A free tag drifts the moment two people write it — `casebox`,
`CaseBox`, `casebox` — and every variant quietly drops nodes from the answer
without dropping them from the store: **the search says nothing is known while the
knowledge sits right there.**

*(Also zz-kb-usage's until 2026-09-04. The tag KINDS are a platform contract — `knowledge_add`
enforces them — so the rule lives with the spine.)*
