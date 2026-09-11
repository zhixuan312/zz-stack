# docs/

Things written to be read by someone who does not work on this every day.

## architecture.html

The platform explained end to end, for an audience that needs to understand what we are building
and why — not what is finished. One page, eight tabs, opened in a browser.

    open docs/architecture.html

Every capability on it answers the same three questions and no others:

    What it is              one sentence, plain
    How we see it           the lens — what we look at to know it is working
    What better looks like  the direction of travel

**Deliberately not a status report.** A deck that reports progress is wrong the week after it is
shown and invites a conversation about percentages rather than about design. One that describes
the lens stays true, and the third line carries the improvement story without turning into an
inventory of what is missing.

The visual language — palette, the mono kickers, the hairline rules — is inherited from
`catalog/sdlc/sdlc-flow/skills/sdlc-deck/deck-chassis.html` so the two read as one family. The
diagrams follow a fixed discipline rather than a taste: every coordinate and gap divisible by
four, one accent colour per drawing reserved for the one or two things a reader should notice
first, 1px hairlines, no shadows, and nothing drawn that a paragraph would have explained better.

Self-contained apart from three webfonts, each with a real fallback stack, so it still reads on a
machine that blocks font hosts.

## architecture-for-government.html

The same platform, framed for a director who runs delivery in government. Six tabs instead of
eight, in the order that audience asks: what the platform is made of and who owns each layer,
what the Operations flow is, how we know it is getting more reliable, and how the two
ends bind to what government already runs — corporate directory for sign-in, one AI gateway instead of a
connection per system.

    open docs/architecture-for-government.html

It inherits `architecture.html`'s stylesheet unchanged so the two read as one set. Two things
it adds, both because this document has a job the other one refuses:

**A layer diagram where colour is ownership** — orange is ours, green is government's, grey is
deliberately somebody else's. A technical director's first question is what you built versus
what you consume, and a paragraph answers that worse than a drawing does.

**A status pill, with three states and no more.** This is framed as a proof of concept, so the
only distinction that earns its place is between what can be shown running now (`Working
today`), what is designed and not yet built (`Next`), and what is not ours to decide
(`To confirm`). The finer §6/§6b reading — deployed versus exercised by a real round — is
carried in STATE.md, where the audience knows what it means; putting it here made a reader ask
what "built but not used" meant instead of reading the architecture.

## repository-architecture.md

What lives where, and why the boundaries are where they are. Read by the gate and by
`services/gateway/src/console/catalog.ts`, so it is a description with consumers rather than
a note.

## findings/

Defects the evaluation work found **in the instrument doing the measuring** — the largest
group, and every one of them was reporting success at the time. Kept because a measurement
apparatus that is wrong in the flattering direction deserves more suspicion than the thing it
measures, and because the habit that catches them generalises past this platform: when a number
looks good, try to make the instrument produce it from nonsense.

## release/

`building-block-contract.md` — what a block must publish to be reachable through this gateway.
`0.2.0-verification.md` — what was actually checked at that release, kept as the shape of a
verification rather than as current fact; the gate names both when their stamp goes stale.

---

**Two things this directory no longer holds, and why:**

`architecture-for-government.md` was the earlier markdown draft of the HTML beside it, kept
"only until the HTML settles" — and the HTML has been the one to send for some time. Two copies
of one document is one copy nobody updates.

`oauth-uat-walkthrough.md` walked the OAuth delegation flow in a browser on UAT, through
LibreChat, against the bookit and n8n mocks. There is no UAT (one deployment since
2026-09-10), no LibreChat, and no block registered here at all — every prerequisite it opens
with is gone, and it could not be rewritten for the current platform because you cannot walk a
delegation flow with nothing to delegate to. The mechanism it described is live and configured
through `<BLOCK>_OAUTH_CLIENT_ID`; `deploy/README.md` is where that is written down now.
