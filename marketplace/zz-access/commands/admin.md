---
name: "admin"
description: "Running the platform itself: who exists, which teams they are in, which flows and building blocks each team may reach, and the tokens and enrolment links that let anyone in at all. Everything here acts on OTHER people — which is what makes it the one package that is not about the person in front ..."
when_to_use: "The person typed /zz-access:admin."
disable-model-invocation: true
---

# zz-admin

Everything in this skill acts on **somebody else**. That is the whole difference from
`zz-access`, which only ever touches the person in front of you: a token here is issued
*for* a principal, a team is created *for* people who are not in the room, and a block
grant decides what a team you may not belong to can reach.

Same tools list, same door — the platform does not sort administration into its own URL,
because a URL that admits everybody sorts nothing. **What separates the two is your role**:
these tools are registered for you only if your role can execute them. So if a tool named
below is not in your list, that is the answer — you do not have the authority, and `whoami`
says which authority you do have. Do not go looking for another door; there isn't one.

So the rule that matters is not a technique. It is that you are operating a register other
people depend on, and the register is the truth — not your memory of it.

## Look before you change

`list_people`, `list_teams`, `list_installs` and `list_pats` answer who exists, who is in
what, what each team runs, and which tokens are live. **An access review is those four**,
and every change below should start with whichever of them names the thing you are about
to touch.

`whoami` is the one to reach for when a tool refuses you: it reports how the platform
resolved YOU — your platform role, the team a token is bound to if it is bound at all —
which is almost always the answer to "why was that a 403".

## The surface, by the question it answers

| You need to know or change | Tools |
|---|---|
| who exists, and what they hold | `list_people` `list_pats` `whoami` |
| a person on the platform | `add_person` `deactivate_person` |
| a way for a person to get in | `issue_enrolment` (passkey) · `issue_pat` `revoke_pat` (machine) |
| a team | `create_team` `archive_team` `list_teams` |
| who is in a team | `add_member` `remove_member` |
| what a team runs | `install_flow` `uninstall_flow` `list_installs` |
| which building blocks a team may reach | `grant_tool` `revoke_tool` |
| a person's or a team's generated setup | `my_client_setup` (pass `email`) |

**Your tools are the documentation.** Every tool states what it does and what it takes, so
read your tool list rather than working from memory of an earlier conversation. This table is
a map to the right verb, not a substitute for reading it — and your list is the shorter,
truer version of it, because it holds only what you can actually run.

## What is beside this, and what is not here at all

**A person's OWN token, their own block keys, or their client setup is `zz-access`** — read
that skill rather than reaching for these tools. Those tools resolve the caller and act on
the caller, so they cannot act for somebody else even when you want them to. The two that
can, `admin_set_credential` and `admin_delete_credential`, are described there too and are in
your list if your role carries them.

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

- **Deactivating somebody stops them authenticating; it does not touch the building-block
  keys stored under their address.** Those stay live at a third party for a person who has
  left. `admin_delete_credential(user_email, platform)` is what removes them, it is beside
  `deactivate_person` in your list, and leaving somebody's departure half-done is the reason
  it is named here rather than left to be remembered.

## Adding a person is two acts, not one

`add_person` creates the principal. It does **not** give them a way in — this platform's
console door is a passkey, and a passkey attaches to an account only through a one-time link
naming it. So a new person needs `issue_enrolment` as well, and the link is shown once.

That order is deliberate and worth stating to whoever asked: an authenticator proves
possession of a key, never an identity, so a registration that could name its own account
would be open self-registration. The principal exists first, and the link points at it.

A person who only ever calls the platform from a script needs neither — `issue_pat` is their
door.
