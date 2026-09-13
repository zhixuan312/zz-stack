---
name: zz-plugin-locate
version: 0.1
description: Stage 1 of plugin evaluation. Settle which plugin is being evaluated, at which released version, containing which skill versions, and what its skills tell an agent to call. Writes nothing.
when_to_use: "The first stage of zz-plugin-eval, once an initiative exists. Never on its own — every later stage takes the plugin and version this settles."
---

# zz-plugin-locate

One call, one question: **what exactly is being evaluated?**

```
plugin_locate(plugin: "sdlc")
```

It returns the plugin's latest released version, that version's own content digest, the skill
versions it shipped with, the MCP servers it declares, and the tools its skills name.

## Why a version and not just a name

"sdlc scores 4.1" is not a measurement. Skills change weekly; a score belongs to the content
that produced it, and a plugin's content is fixed at exactly one moment — release. That is when
`flow.json`'s declared version and the digest of what it ships are written down together, and
the gate refuses a release where the two disagree.

So every later stage takes both, and an evaluation cannot drift onto a different version of its
own subject halfway through.

**The digest is the plugin's own, not the shelf's.** `claude plugin list` shows something like
`0.31.0+1e7d702a`, and every plugin on the shelf carries the same suffix, because that digest is
computed over the whole shelf and includes the deployment's own address. It answers "what did
this person receive". It cannot answer "what is sdlc".

## What to do with what comes back

**Say it out loud before continuing.** The plugin, the version, the digest, how many skills, how
many servers. Somebody reading the initiative later needs to know what was on the table without
re-running anything.

**Refuse a version nobody released.** If the tool says no version is recorded, the plugin either
does not exist under that name or has not been released since versions began being recorded.
Neither is something to work around: an evaluation of an unreleased plugin is an evaluation of
whatever happens to be on disk right now, which is not a thing that can be compared to anything.

**`tools_named` is not the whole surface, and that is on purpose.** It is what this plugin's own
skills tell an agent to call. A plugin does not claim every tool on a shared door, so a tool
merely present and unused says nothing about it — whereas a tool the plugin *tells* an agent to
call and nobody ever did is a finding. That comparison happens in the next stage.

## Pitfalls

❌ **Carrying the plugin name forward without the version.** Every later tool takes both.

❌ **Evaluating whatever is in the catalog right now.** The catalog is the next release; the
version is what somebody installed.

❌ **Reading `tools_named` as the plugin's surface.** It is its claim, not its reach.
