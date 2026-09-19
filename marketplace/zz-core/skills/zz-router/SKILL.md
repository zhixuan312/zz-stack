---
name: zz-router
description: "Use FIRST when the request is delivery work for your team on the ZZ platform — a new capability, a change to a service someone operates, or continuing work already under way. Picks the right installed flow (sdlc-flow, zz-plugin-eval) and loads it. Not for ordinary coding, debugging or questions about this repository."
version: "0.52.8"
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

### sdlc-flow (v0.52.8)

**When:** Someone brings software delivery work — a brain dump to ground, an agreement to write, a plan to build from, a change to make — or you need to know which stage an initiative is at. This is the entry point: start here rather than at a stage. Local runtimes only (Claude Code).

**Then:** call the `zz-core` tool **skill_read**, passing `zz-platform` as its
`name` argument; then call it again passing `sdlc-flow`. Both are MCP tools
on the zz-core server, not this client's own skills. Follow those skills
exactly — they are the method; this file is only the door.

### zz-plugin-eval (v0.52.8)

**When:** Someone asks whether a plugin is any good, whether installing it beats not installing it, whether a flow recovers when a stage goes wrong, or whether a tool its skills name is ever actually called — and whenever a plugin is up for keeping, changing or retiring. This is the entry point: start here...

**Then:** call the `zz-core` tool **skill_read**, passing `zz-platform` as its
`name` argument; then call it again passing `zz-plugin-eval`. Both are MCP tools
on the zz-core server, not this client's own skills. Follow those skills
exactly — they are the method; this file is only the door.

## What holds regardless

- Documents are written through `document_write` / `document_patch` / `document_revise`
  into your team's store — never into this repository. You send the BODY;
  the platform writes the frontmatter, and content that opens with one is refused.
- A gate passes only once `document_approve(path)` has recorded it. A "yes" in the
  conversation is not an approval, and you cannot write one by hand — the
  platform stamps who approved and when, and refuses the fields if you try.
- An approved document changes through `document_revise`, never by writing over it.
- Keys for the building blocks and tokens belong to the **ZZ Access** agent.
  Never ask anyone to paste a key here.

Outside a flow you are yourself. This skill is not a personality.
