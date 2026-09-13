---
name: "doctor"
description: "Check that this machine can reach the ZZ platform: the token it will send, the doors that token opens, and whether the installed plugins are whole and on one version. Needs no repository and no setup — it reads the machine it runs on."
when_to_use: "The person typed /zz:doctor."
disable-model-invocation: true
---

# zz-doctor

**Run the script. Report what it printed.** Everything this skill knows is in the script, and
the script is deterministic — there is no judgement to add and nothing to check by hand.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/zz-doctor/doctor.mjs"
```

Exit 0 means nothing needs doing. Exit 1 means at least one line came back FAIL.

## What it answers, and what it does not

It answers **one** question: can this laptop, with the token it has, reach the platform
through the plugins it installed? Token present and readable only by its owner; the doors
answering rather than refusing; the plugins installed, enabled, and all on one version.

It does **not** check the deployment. Whether the running platform matches a source checkout
is a different question with a different tool, run by whoever operates the host from inside
the repository. The person typing this command does not have that repository — that is the
whole reason this exists. **Do not merge the two.**

## Reading the output

Every line is `PASS`, `WARN` or `FAIL`, then the subject, then the detail. Each FAIL names
the command that fixes it; pass that on rather than inventing your own.

- **FAIL on the token** — there is no credential, or the one there is refused. Nothing else
  can work until this does. The platform's tokens begin `zzp_`.
- **FAIL on a door** — a 401 is the token, a 404 is the plugin declaring a path this gateway
  does not serve, and no answer at all is the network or the platform being down.
- **WARN on plugin versions** — they should be one number, because one build stamps them all.
  Two numbers means one plugin did not update: `/zz:update` is the fix.

If every line passes and the person still has a problem, it is not on this machine. Say that
plainly instead of guessing — what is left is the platform itself, and it is not diagnosable
from here.
