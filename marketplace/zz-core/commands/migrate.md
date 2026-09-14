---
name: "migrate"
description: "Bring one mma repository's history onto this platform: its journal becomes knowledge nodes, and its specs, plans, explorations, audits and the rest become the sources of one archive initiative that every migrated node cites as evidence. Resumable, and safe to run twice."
when_to_use: "The person typed /zz-core:migrate."
disable-model-invocation: true
---

# zz-migrate

**Rehearse, show the person, then import.** The script decides everything; what this skill
adds is making sure the person sees the plan before several hundred permanent records are
written on their behalf.

```bash
cd <the mma repository>
node "${CLAUDE_PLUGIN_ROOT}/skills/zz-migrate/migrate.mjs" --dry-run
```

Show them the counts it prints. **Then, and only with their word, run it for real** — the
same command without `--dry-run`. On a large corpus it takes a few minutes; it prints as it
goes.

`--limit <n>` imports the first n of each kind. Offer it to somebody who wants to see the
result before committing the rest: it is the same code path, and the run after it picks up
where it stopped.

## What becomes what

| In `.mma/` | Becomes | Why that and not something else |
|---|---|---|
| `journal/nodes/*.md` | knowledge nodes | mma's six node types **are** this platform's six. It is a rename, not a translation. |
| `specs/` `plans/` `explorations/` `audits/` `backlogs/` `verifications/` `notes/` `retros/` `decks/` `deployment/` | **sources** on one archive initiative | An initiative's documents are gated. A historical plan has no approvals because nobody approved it under rules that did not exist yet — importing it as a document would mean signing those gates on behalf of people who signed nothing. `add_source` is ungated and immutable and is exactly for material from elsewhere. |
| `worktrees/` `flow-state/` | nothing | Operational state, true only while the daemon that wrote it was running. |

Every migrated node cites the archive initiative as its **evidence**, which is what makes the
import possible at all: this platform refuses a knowledge node with no evidence, and an mma
node cites no initiative because mma had none. The claim the import makes is true and
checkable — this lesson came from that body of work, and the work is right there in the same
initiative.

## Tell them these two things afterwards

1. **The archive initiative stays open.** There is no archived state here: closing runs
   through a flow's closing document, every flow gates that document, and signing a gate to
   tidy a listing is the one thing gates exist to prevent. So the archive appears in
   `initiative_status()` beside real work. It is named `<date>-mma-archive-<repo>`, which is
   what tells a reader it is not something to resume.
2. **Everything it brought over carries the tag `mma-import`**, and each node also carries
   `mma-<repo>-<id>` — its original journal id. That is how a migrated lesson is told apart
   from one somebody wrote here, and how the mma id in a node's "Related" line is found.

## If it stops partway

Run it again. Every send is recorded in `.mma/.zz-migrated.json` the moment it succeeds, so a
second run sends only what is missing — it will not mint a second copy. Several hundred
requests over a network is long enough that stopping halfway is a certainty rather than a
risk, which is why the ledger exists.

Failures are listed at the end with the platform's own refusal text. Those sentences say what
is wrong; pass them on rather than paraphrasing.
