---
name: zz-access
version: 2.2
description: "Getting a person connected and keeping them connected: their platform access token, and the setup for whichever client they work in (Claude Code, Codex, Hermes). Everything here is about the person in front of you; administering other people is the zz-admin skill, on the same door."
when_to_use: "Someone asks how to connect a tool to the platform, wants a token, lost a token, suspects one leaked, or asks what access they have."
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

Administering OTHER people — principals, teams, flow installs — is the
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

`client_setup(client)` prints the install for `claude-code`, `codex` or
`hermes`: a few commands that fetch a small package built for that person —
their MCP endpoints, one router skill, and (on Claude Code) one command per
flow they have. It carries only the servers their installed flows declare.

Pair it with `pat_issue`: the token is exported once as
`ZZ_TOKEN` and the install writes it to `~/.zz/token`, mode 600. On Claude
Code the plugin reads it at connect time, so **the token never enters a file
they might commit**. Say that plainly — it is the reason we stopped handing
out a config with the token typed into it.

Three things to be clear about when they ask:

- **Whether a fix reaches them by itself depends on the flow, and the setup
  they printed says which.** A flow their team also runs in the browser
  travels as pointers — stages, gates and document shapes fetched from the
  platform while it runs — so a fix here is live on their next message. A
  flow their team runs ONLY in a terminal ships its skills as files, and a
  fix reaches them when they update that plugin and not before; nothing
  warns them, because the old files go on working. `client_setup` names
  which of their flows are which and prints the update command for the ones
  that need it. Read it back to them rather than promising either one.
- **`CLAUDE.md`, `AGENTS.md` and `SOUL.md` are not touched.** Those change
  how their engine behaves for every task they ever do. Outside the flow
  they keep exactly the assistant they had.
- **Re-running the install is how a NEW flow arrives.** Updating a plugin is
  how a CHANGED one does, for the file-borne flows above.

## What their team could run

`catalog_list()` is the shelf: every flow this platform ships, what each one is
for, where it runs, and which ones this team already has. Show it when somebody
asks "what else could we use?" — or when they describe a kind of work and there
is a flow for it.

**Browsing is theirs; installing is not.** Anyone may look; the act of installing
belongs to a team admin, because it changes what a whole team runs. `flow_install`
is in your list only if you administer a team — and even then it is per team, so
holding it says nothing about the team they are asking about. Answer the question,
name the flow, and say who can turn it on.

The shelf marks a flow's `install` as `automatic` when every team already has it.
Do not offer to install one of those: they already have it, and installing it a
second time is the one thing the registry refuses.

## What you are not

You do not run delivery flows. If they want work done, send them to the agent
that runs their flow.

Adding a teammate IS on this door — it is `zz-admin`, and
whether you can do it is whether those tools are in your list. If they are,
read that skill before acting; if they are not, say that it needs an
administrator and name what to ask for. Do not attempt it either way without
reading the skill: those tools act on people who are not in the room.

