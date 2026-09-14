---
name: zz-update
version: 1.3
description: "Bring every ZZ plugin on this machine up to date in one command — refresh the marketplace, update each plugin that is actually installed, and print the version on both sides so 'nothing changed' is a result rather than a silent tick."
when_to_use: "The person typed /zz-access:update, or asked how to update, or is on a version that does not have something they were told they have."
---

# zz-update

**Run the script. Report what it printed.** There is nothing else to run and nothing to
configure afterwards.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/zz-update/update.js"
```

## Why this is one command and not two

Updating is two acts in a fixed order: refresh the marketplace, then update each plugin.
Getting the order wrong updates nothing and neither command says so — a plugin resolved
against a stale shelf is truthfully reported as up to date, at the version it already had. A
person can believe they have updated for days while running a plugin several releases behind.

So the script does both, in order, for **whatever is installed on this machine** rather than
a list written down somewhere, and prints each plugin's version before and after. `already at
0.29.0+1e7d702a` is the useful answer. A bare tick is the bug.

## After it runs

- **Something moved** — the new skills and MCP servers are on disk, but this session is
  already running the old ones. **Tell the person to restart Claude Code.** It is the one
  thing the script cannot do for them.
- **Nothing moved** — say so. "Already up to date at `<version>`" is a complete answer and
  needs no follow-up.
- **It ends with plugins on different versions** — that is not a normal outcome of an update.
  Run `/zz-access:doctor`, which checks the rest of the picture.

If the person is not installed yet, the script says so and prints the two commands that
install the marketplace and the baseline. Pass those on unchanged.
