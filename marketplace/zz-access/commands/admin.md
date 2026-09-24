---
name: "admin"
description: "Running the platform itself: who exists, which teams they are in, and the tokens and enrolment links that let anyone in at all. Everything here acts on OTHER people — which is what makes it the one package that is not about the person in front of you."
when_to_use: "The person typed /zz-access:admin."
disable-model-invocation: true
---

# zz-admin

Everything in this skill acts on **somebody else**. That is the whole difference from
`zz-access`, which only ever touches the person in front of you: a token here is issued
*for* a principal, and a team is created *for* people who are not in the room.

**THERE IS NO FLOW GRANT AND NO INSTALL REGISTRY.** The platform keeps no record of what
a team has installed — it cannot see what is on a person's machine, so such a record was
a claim it could not back and every use of it a restriction it could not enforce.
The two platform plugins are required; every other plugin is a person's own choice, made on
their own machine. Asked to "grant a team a flow", say that: there is nothing to grant,
and `catalog_list` shows everyone the same shelf.

Same tools list, same door — the platform does not sort administration into its own URL,
because a URL that admits everybody sorts nothing. **What separates the two is your role**:
these tools are registered for you only if your role can execute them. So if a tool named
below is not in your list, that is the answer — you do not have the authority, and `whoami`
says which authority you do have. Do not go looking for another door; there isn't one.

So the rule that matters is not a technique. It is that you are operating a register other
people depend on, and the register is the truth — not your memory of it.

## Look before you change

`person_list`, `team_list` and `pat_list` answer who exists, who is in what, and which
tokens are live. **An access review is those three**,
and every change below should start with whichever of them names the thing you are about
to touch.

`whoami` is the one to reach for when a tool refuses you: it reports how the platform
resolved YOU — your platform role, the team a token is bound to if it is bound at all —
which is almost always the answer to "why was that a 403".

## The surface, by the question it answers

| You need to know or change | Tools |
|---|---|
| who exists, and what they hold | `person_list` `pat_list` `whoami` |
| a person on the platform | `person_add` `person_deactivate` |
| a way for a person to get in | `enrolment_issue` (passkey) · `pat_issue` `pat_revoke` (machine) |
| a team | `team_create` `team_archive` `team_list` |
| who is in a team | `member_add` `member_remove` |
| a person's or a team's generated setup | `client_setup` (pass `email`) |
| a team's knowledge index, when it disagrees with the files | `knowledge_reindex` |
| what people have reported as broken | `bug_list` `bug_resolve` `bug_delete` |

## Answering a bug report

Anybody on the platform files one with `bug_report` on `/core` — that door is everyone's, and
somebody who has just hit a wall should not need a role to say so. Reading the whole
deployment's reports and deciding what came of one are yours.

`bug_list` defaults to what is OPEN, because the question that brings somebody here is usually
"what is wrong right now". It returns a count by status beside the rows, so a capped list cannot
be mistaken for the whole answer. `bug_list(query: "timeout")` matches the title and the detail
together — whichever half the reporter put the word in is an accident of how they wrote it.

`bug_resolve` takes `fixed`, `not_a_bug` or `duplicate`, and **requires a resolution for all
three**. The two that are not fixes are the ones that matter here: somebody took the trouble to
file it, and "not a bug" without a sentence is an answer they cannot learn anything from. For a
duplicate, name the other id in the resolution.

It refuses a second close and tells you who decided and what they said. If that decision was
wrong, file what you now know as a new report naming the old id — the record of what somebody
concluded, and on what evidence, is worth more than a tidy status.

**Reports are not team-scoped.** The platform is one deployment: a defect one team hits is one
every team has, which is why this is a superadmin's list rather than a team admin's.

### `bug_delete` is not a stronger `bug_resolve`

Resolving is how this platform records **what it has fixed**, and it keeps every row it closes —
`not_a_bug` included, because that is a finding about something confusing rather than a note that
nothing happened. Never delete a report a person filed. If its resolution was wrong, file what you
now know as a new report naming the old id.

Deleting is for rows that were **never anybody's report** — a probe row `chain-check` leaves when
it walks this tracker against the live deployment. Resolving one would write a fake decision into
the record of what this platform has fixed, so it is deleted instead — logged, attributed, and
irreversible. You will rarely call it: the walk removes its own row.

## Rebuilding a knowledge index

`knowledge_reindex` rebuilds a team's search index from that team's files, which are the source
of truth — the index is derived and disposable. You will almost never need it: every tool that
writes a document indexes it in the same call, and zz-core rebuilds every team at boot. Reach
for it when:

- a store was **restored from a backup**, so the files moved without the platform watching.
- somebody **edited documents outside the platform's tools**, on the volume directly.
- a search **returns a document whose file is gone**, or fails to return one that is there.

| you pass | it does |
|---|---|
| nothing | rebuilds **every team** the platform holds — this is what a restore needs |
| `team: "<slug>"` | rebuilds that one team |
| `force: true` | re-derives every row even where the stored hash says nothing changed |

A team slug that names no team is **refused, and the refusal names the slug you gave it**. That refusal is not politeness: a team whose store directory is gone has its index
rows DELETED, which is right for a team that was archived and is what you would want — and a
typo has no directory either. `team_list` shows the slugs.

`force` is the one to reach for after a release that changed what an index row MEANS. The skip
is correct about the current derivation and blind to a previous one: rows written by older
logic look "already stored" to it forever, so an ordinary rebuild reports "nothing had changed"
and repairs nothing. It costs a full re-derivation of every document, so do not reach for it
first.

It answers within a second or so on a settled store — unchanged files are skipped by content
hash — and it is safe to run twice.

**Your tools are the documentation.** Every tool states what it does and what it takes, so
read your tool list rather than working from memory of an earlier conversation. This table is
a map to the right verb, not a substitute for reading it — and your list is the shorter,
truer version of it, because it holds only what you can actually run.

## What is beside this, and what is not here at all

**A person's OWN token or their client setup is `zz-access`** — read that skill rather than
reaching for these tools. Those tools resolve the caller and act on the caller, so they
cannot act for somebody else even when you want them to.

**Running or creating a flow is a delivery agent's job**, not this one's. Name the agent
that does it.

## Conduct

- **Authority is checked per call, and a refusal is an answer.** Every tool resolves who you
  are from the database, not from this conversation, and it does it for the SPECIFIC team you
  named — administering one team is not administering the next. When one refuses, report what
  it said; never look for another route to the same effect.

- **A tool that is missing was never yours.** Your list is built from your role. "Tool not
  found" here means the authority, not the platform — check `whoami` and say so plainly
  rather than reporting the platform as broken.

- **A destructive tool asks you to repeat the target.** `confirm` is not ceremony — it is
  there because the wrong team slug and the right one look alike. Read it back to the person
  before you send it.

- **Say what actually happened.** These tools report whether anything changed; a removal that
  removed nothing is not a removal. Never claim installed, granted or revoked what the
  registry does not show.

- **Never print a token or a key**, whole or partial. A token is shown once, by the tool that
  mints it, to the person it belongs to. The same holds for an enrolment link, which is a
  live credential for as long as it is unused.

## Adding a person is two acts, not one

`person_add` creates the principal. It does **not** give them a way in — this platform's
console door is a passkey, and a passkey attaches to an account only through a one-time link
naming it. So a new person needs `enrolment_issue` as well, and the link is shown once.

That order is deliberate and worth stating to whoever asked: an authenticator proves
possession of a key, never an identity, so a registration that could name its own account
would be open self-registration. The principal exists first, and the link points at it.

A person who only ever calls the platform from a script needs neither — `pat_issue` is their
door.
