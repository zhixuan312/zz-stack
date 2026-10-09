---
name: zz-router
description: "Use FIRST when the request is delivery work for your team on the ZZ platform — a new capability, a change to a service someone operates, or continuing work already under way. Picks the right installed flow (sdlc-flow, zz-plugin-eval) and loads it. Not for ordinary coding, debugging or questions about this repository."
version: "0.94.1"
---
# zz-router

You are on the ZZ platform. Work here follows an installed flow: declared
stages, documents and approval gates, with the record kept by the platform
rather than by this conversation.

## Before anything else

If the person refers to work that already exists — by name, or with
"continue", "where were we" — call `initiative_status(<initiative>)` first,
or `initiative_status()` with no argument to list what is open. It computes
the next move from the flow's manifest and the documents' own envelope.
Never resume from your memory of a conversation.

## Pick the flow

### sdlc-flow (v0.94.1)

**When:** Someone brings software delivery work — a brain dump to ground, an agreement to write, a plan to build from, a change to make — or you need to know which stage an initiative is at. This is the entry point: start here rather than at a stage. Requires a runtime that can dispatch subagents and reach...

**Then:** call the `zz-core` tool **skill_read**, passing `zz-platform` as its
`name` argument; then call it again passing `sdlc-flow`. Both are MCP tools
on the zz-core server, not this client's own skills. Follow those skills
exactly — they are the method; this file is only the door.

### zz-plugin-eval (v0.94.1)

**When:** A person typed /zz-plugin-eval:eval. When someone asks whether a plugin is any good, wants one graded or scored, or asks you to CONFIRM a reading they have already formed — 'that flow is going in circles, mark it down', 'three runs is too thin to conclude anything, right?' — answering from your o...

**Then:** do not load it. A person opens this flow themselves: tell them to open
`/zz-plugin-eval:eval` in Claude Code, `$zz-plugin-eval:eval` in Codex.

## What holds regardless

- Documents are created with `document_write` and changed with `document_edit`
  in your team's store — never in this repository. You send the BODY;
  the platform writes the frontmatter, and one you type never becomes it.
- A gate passes only once `document_approve` has recorded it, on the snapshot your own
  `document_present` put in front of the person — pass back the `review_context` and
  `expected_revision` that present named. A "yes" in the conversation is not an approval,
  and you cannot write one by hand — the platform stamps who approved and when.
- An approved document's body changes through `document_edit` with its cause, never by writing over it.
- A file you already have is never typed out as an argument: `upload_start` stages it, and the
  write takes the `upload` it answers. `zz-platform` has the routes and the formats.
- Tokens belong to the **ZZ Access** agent. Never ask anyone to paste one here.

Outside a flow you are yourself. This skill is not a personality.
