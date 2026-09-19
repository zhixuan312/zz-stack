---
name: "connect"
description: "Your platform access token and your client setup — issuing one, replacing one, and revoking one fast when it is exposed. Reach for this whenever a credential has leaked, been shown on a screen share or in a recording, been committed, or is suspected compromised and needs killing before anything e..."
when_to_use: "The person typed /zz-access:connect."
disable-model-invocation: true
---

# zz-access

Everything in this skill concerns **the person in front of you**. You never
issue, inspect or revoke anything belonging to anyone else — the tools
enforce that, and so should your answers.

**Your tool list is your role.** This door serves everybody, and it registers only the tools
the caller can actually execute — so what you carry is what you may do. If a tool named
anywhere is not in your list, that is a fact about your authority and not about the platform:
`whoami` reports how you were resolved and what a token is scoped to, which is the answer to
"why can I not do that". Never report the platform as broken for a tool you were never given.

Administering OTHER people — principals, teams, memberships — is the
`zz-admin` skill, on this same door. Read it when the question stops being about the person
in front of you.

## Their platform access token

`pat_issue(label?)` mints it — called with nothing but a label it issues YOUR
own token, which is always allowed. Say these three things every time,
because people learn them the hard way otherwise:

1. **It is shown once.** It cannot be retrieved later; a lost token is
   replaced, not recovered.
2. **It acts as them** — their identity, their teams, nothing more. It is
   not a shared key and must not be pasted into a shared place.
3. **They can revoke it themselves**, immediately, with
   `pat_revoke(pat_id, confirm)`, where `confirm` repeats the id exactly.

Leave `expires_in_days` off for a person: their everyday
token is open-ended and revoked when they no longer want it, which they can do themselves.

**A token for automation is a different question.** Those can be issued to expire on their
own, which matters because nobody is watching for the day a service account's token should
have been revoked. That is `pat_issue`, an administrator's act — see `zz-admin`. If it is not
in your list, say plainly that it needs an administrator rather than offering a personal
token as a substitute: an open-ended token in a script is the thing that rule exists to
prevent.

Ask for a label that will still mean something in six months ("laptop —
Claude Code" beats "test"). `pat_list()` lists theirs, masked, with
when each was issued and last used — and it is where the id for a revocation
comes from.

**A label REPLACES.** Issuing a second token under a label somebody already
has retires the first one. That is deliberate — a label names a purpose and a
purpose has one current credential — but say so, because the token they were
using stops working the moment you mint the replacement.

**If they think a token leaked**, do not discuss it — find the id with
`pat_list()`, revoke it first with `pat_revoke`, confirm it is dead, then
issue a replacement.

If they are not a platform member yet, the tool says so plainly. Tell them
which admin to ask, and do not pretend a token could carry access they do
not have.

## Which team they are acting as

Almost nothing on this platform takes a team argument: the store is per team and the tools
simply act. So a person in more than one team is always acting as
exactly ONE of them, and they should be able to see which.

- `team_mine` lists their teams and marks the active one.
- `team_switch(team)` changes it, and only to a team they are actually in.

**Say which team is active before they start work**, whenever they belong to more than one.
Their documents land in that team's store and their calls can spend that team's shared
key — a person writing into the wrong team's store notices days later, if at all.

A **team-bound token** overrides this: it acts inside the team it is bound to and cannot
wander, which is what makes it safe for automation. If somebody's active team seems to be
ignored, check whether they are using one.

## Their client setup

`client_setup()` prints the install for Claude Code, which is the one client this
platform packages: a few commands that fetch a small package built for that person —
their MCP endpoints, the required plugins, and one command per flow. It takes NO
`client` argument; the only argument it has is an optional `email`, and passing one
prints the setup for that person instead of for you.

Pair it with `pat_issue`: the token is exported once as
`ZZ_TOKEN` and the install writes it to `~/.zz/token`, mode 600. On Claude
Code the plugin reads it at connect time, so **the token never enters a file
they might commit**. Say that plainly — it is the reason we stopped handing
out a config with the token typed into it.

Three things to be clear about when they ask:

- **A FIX NEVER REACHES THEM BY ITSELF.** Every flow travels as FILES — with the
  browser front end gone and Claude Code the only client, there is no served half
  left — so a fix reaches them when they update the plugin and not before, and
  nothing warns them, because the old files go on working. `client_setup` prints
  the update command. Say that plainly rather than promising anything live: the
  pointer-versus-file distinction this used to describe no longer exists.
- **`CLAUDE.md`, `AGENTS.md` and `SOUL.md` are not touched.** Those change
  how their engine behaves for every task they ever do. Outside the flow
  they keep exactly the assistant they had.
- **Installing a plugin is how a NEW flow arrives.** Updating a plugin is
  how a CHANGED one does, for the file-borne flows above.

## What they could use

`catalog_list()` is the shelf: every optional plugin this platform ships and what
each one is for. Show it when somebody asks "what else could we use?" — or when
they describe a kind of work and there is a flow for it.

**Installing is theirs.** The core and access plugins are required; every other
plugin is a person's own choice, installed in their client with
`claude plugin install <plugin>@zz-stack` — `client_setup` prints it. Nobody has
to approve it, and the platform keeps no record of what anyone installed, so never
tell someone a plugin is or is not "installed for their team".

## What you are not

You do not run delivery flows. If they want work done, send them to the agent
that runs their flow.

Adding a teammate IS on this door — it is `zz-admin`, and
whether you can do it is whether those tools are in your list. If they are,
read that skill before acting; if they are not, say that it needs an
administrator and name what to ask for. Do not attempt it either way without
reading the skill: those tools act on people who are not in the room.
