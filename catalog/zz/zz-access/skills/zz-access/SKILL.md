---
name: zz-access
version: 2.2
description: "Getting a person connected and keeping them connected: their platform access token, their own API keys for the building blocks, and the setup for whichever client they work in (Claude Code, Codex, Hermes). Everything here is about the person in front of you; administering other people is the zz-admin skill, on the same door."
when_to_use: "Someone asks how to connect a tool to the platform, wants a token, is blocked by a missing platform key, lost a token, suspects one leaked, or asks what access they have."
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

Administering OTHER people — principals, teams, flow installs, block grants — is the
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

## Their keys for the building blocks

Each block platform is called with the person's **own** key, never a shared
service key. `platform_list` shows which ones the platform can hold a key
for; `credential_set` stores one; `credential_list` confirms what is
stored (masked); `credential_delete` removes it.

**Never print a stored key back**, not even partially, not even when asked.
If a key looks wrong, delete and re-store it rather than reading it out.

### There is no shared team key

A key belongs to one person. There is no team-wide key and no tool to store one, and that
is deliberate rather than missing.

A shared key spent the team's quota under everyone's name, so the block could not attribute
the call: the block's audit log recorded the platform rather than the person for
anyone who had never signed in. It also made "am I connected?" unanswerable — somebody with
no credential of their own looked connected because a colleague's key was carrying them.

**So when somebody is blocked on a block they cannot reach, there is one answer and it is a
better one: they sign in to that block as themselves.** Offer `block_connect`, which returns
a link they open. It takes one click, the block ends up holding a token that names them, and
no secret passes through anybody's hands. Storing their own key stays available for a block
that cannot offer sign-in.

**Never tell somebody to wait for an admin to store a key for the team.** Nobody can, and
saying so leaves them waiting for something that is not coming.

## Which team they are acting as

Almost nothing on this platform takes a team argument: the store is per team, a block key can
be per team, and the tools simply act. So a person in more than one team is always acting as
exactly ONE of them, and they should be able to see which.

- `team_mine` lists their teams and marks the active one.
- `team_switch(team)` changes it, and only to a team they are actually in.

**Say which team is active before they start work**, whenever they belong to more than one.
Their documents land in that team's store and their block calls can spend that team's shared
key — a person writing into the wrong team's store notices days later, if at all.

A **team-bound token** overrides this: it acts inside the team it is bound to and cannot
wander, which is what makes it safe for automation. If somebody's active team seems to be
ignored, check whether they are using one.

## For operators: acting on somebody else's behalf

`credential_admin_set(user_email, platform, api_key)` stores a key for another person, and
`credential_admin_delete(user_email, platform)` removes it. Superadmin only — if they are not
in your list, this section is not yours and you should say so rather than improvise. Both are
recorded against the operator who ran them.

The onboarding batch is the reason the first exists; **the second is the reason to reach for
this section at all** — when somebody leaves, deactivating them stops them authenticating
and does NOT touch the key the platform goes on injecting on their behalf. Remove the key
too, and say plainly that you have.

## Their client setup

`client_setup(client)` prints the install for `claude-code`, `codex` or
`hermes`: a few commands that fetch a small package built for that person —
their MCP endpoints, one router skill, and (on Claude Code) one command per
flow they have. It carries only the blocks their installed flows declare.

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

Adding a teammate or granting a block IS on this door — it is `zz-admin`, and
whether you can do it is whether those tools are in your list. If they are,
read that skill before acting; if they are not, say that it needs an
administrator and name what to ask for. Do not attempt it either way without
reading the skill: those tools act on people who are not in the room.

## Connecting a block as yourself, instead of storing a key

Some building blocks let a person sign in directly. When one does, `block_connect` with that
block's name returns a link: they open it, sign in to that block, choose which permissions to
grant, and come back. After that their calls to that block are made **as them** — the block's own
audit log names them, their own limits apply, and there is no key to create, paste or keep.

Offer this first for a block that supports it. A stored key remains for the blocks that do not,
and for unattended work, which has no person to delegate from — `credential_set`, and that is
the only one. Spell it exactly: this skill named a shorter form for a while that has never
existed, which is how an agent comes to hunt for a tool the platform does not have and then
reports that the platform cannot do it.

If `block_connect` answers that the block publishes no authorization server, that is the honest
answer rather than a fault: that block needs a stored key.

**`block_disconnect(block)` is the other half, and it is the only thing that really revokes.**
It deletes that person's own delegated access, so the platform can no longer act as them at
the block.

Reach for it when somebody says they want to revoke a block, or before they reconnect as a
different account. **Disconnecting the server in their own MCP client does NOT do this** — that
clears the client's copy of the platform token and cannot touch the delegated one, so on its
own it leaves the block's grant exactly as live as it was. Say so if they assumed otherwise; a
person who believes they have revoked something and has not is worse off than one who knows
they haven't.

They do not need it in order to RECONNECT. Connecting the block again from their client's MCP
settings re-runs the block's own sign-in every time, so a fresh consent replaces whatever was
stored.
`block_disconnect` is for stopping, not for starting again.
