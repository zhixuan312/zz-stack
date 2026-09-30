---
name: "admin"
description: "Running the platform itself: who exists, which teams they are in, and the tokens and enrolment links that let anyone in at all. Everything here acts on OTHER people — which is what makes it the one package that is not about the person in front of you."
when_to_use: "Only when a person opens it by name: `/zz-access:admin` in Claude Code, `$zz-access:admin` in Codex."
disable-model-invocation: true
---

# zz-admin

Everything in this skill acts on **somebody else**. That is the whole difference from
`zz-access`, which only ever touches the person in front of you: a token here is issued
*for* a principal, and a team is created *for* people who are not in the room.

**There is no flow grant and no install registry.** The platform keeps no record of what
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

`person_list`, `team_list`, `pat_list` and `client_list` answer who exists, who is in what,
which tokens are live, and which applications can reach the platform. **An access review is
those four**,
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
| an application that can reach the platform | `client_list` `client_revoke` |
| a team | `team_create` `team_archive` `team_list` |
| who is in a team | `member_add` `member_remove` |
| a person's or a team's generated setup | `client_setup` (pass `email`) |
| a team's knowledge index, when it disagrees with the rows | `knowledge_reindex` |
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

## Cutting off an application

An MCP client — a connector, an editor, anything that speaks to this platform's doors — gets in
by registering itself at `/oauth/register`, and **every registration is open to anyone**. So a
client row is evidence that a registration happened, not that anybody vouched for it, and the
question you will actually be asked is "what is this, and why does it have access".

`client_list` answers it: the id, the name it registered with, the redirect URIs it may be sent
to, and when it registered. Revoked clients are listed too — the row is kept on purpose, because
it is the provenance of the tokens that client obtained, and an access review asks when access
was cut off as well as whether it was.

`client_revoke` takes the id and does two acts as one, in a transaction:

- the client is marked revoked — never deleted, for the reason above;
- **every live token it obtained is revoked with it.** They are found by the client that minted
  them, so a token is revoked because of who asked for it, not because of its label.

A grant the client is still holding is refused as well: a code is exchanged only against a live
client, so a code issued before the revocation no longer works after it. Revoking ends what the
client already has, not only what it would register next.

**A client already revoked is reported as such**, with the time, rather than as a fresh
revocation — the same rule as everywhere else here: say what actually happened. And the refusal
for an id no client has is not a revocation either; `client_list` names the ones that exist.

Reconnecting is a fresh registration, and the new client gets a new id: there is nothing to
un-revoke. For a token whose client is fine, `pat_revoke` is the tool — revoking a client is for
the application itself being wrong.

## Rebuilding a knowledge index

`knowledge_reindex` re-derives a team's search index — each row's derived search columns — from
the database rows, which are the source of truth. You will almost never need it: every tool that
writes a document indexes it in the same call, and zz-core re-derives every team at boot. Reach
for it when:

- the database was **restored from a backup**.
- a release **changed what an index row means** (see `force` below).
- a search returns a row it should not, or misses one it should find.

| you pass | it does |
|---|---|
| nothing | re-derives **every team** the platform holds — this is what a restore needs |
| `team: "<slug>"` | re-derives that one team |
| `force: true` | re-derives every row even where the stored analyzer generation says nothing changed |

A team slug that names no team is **refused, and the refusal names the slug you gave it** —
an unknown team is a typo, and re-deriving nothing would look identical to re-deriving a team
that had nothing to do. `team_list` shows the slugs.

`force` is the one to reach for after a release that changed what an index row MEANS. The skip
is correct about the current derivation and blind to a previous one: rows written by older
logic look "already stored" to it forever, so an ordinary rebuild reports "nothing had changed"
and repairs nothing. It costs a full re-derivation of every document, so do not reach for it
first.

It answers within a second or so on a settled store — a row already at the current analyzer
generation is skipped — and it is safe to run twice.

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
