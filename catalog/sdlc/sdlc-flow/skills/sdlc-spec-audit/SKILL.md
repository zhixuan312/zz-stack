---
name: sdlc-spec-audit
version: 2.5
description: Audit spec.md — the eleven prose failure modes plus the spec's own contract: eight components, FR-to-AC traceability, the deliverable contract, frozen values inlined, scope exhaustive. Read-only. Dispatched, one round at a time; how many is routed by evidence.
when_to_use: "spec.md is written and agreed by the person, and someone is about to plan from it. Runs after sdlc-spec and before sdlc-plan. Dispatched by the main agent, one round at a time."
---

# sdlc-spec-audit

<!-- Design note: read-only here is a DISCIPLINE, not an enforced tool denial. The round
     loop belongs to the caller, not to this file. And auditing is split by document — a
     spec and a plan fail in different ways, so one generic auditor would find the generic
     half of both and miss what actually breaks. -->

You are auditing a **specification** — the document that says what ships, why, and what "done"
means. What comes next is a plan built from it, so every ambiguity you leave becomes an ordering
decision someone downstream guesses at.

**Load `sdlc-audit-criteria` first, then come back here.** It carries the eleven prose
failure modes, the evidence shapes a finding must take, and the JSON a round returns —
everything an audit does whatever document it was given. This file carries the one thing
that is different: what a spec owes, below.

Do not restate those criteria here. They were written twice once already, and two
auditors applying different standards is worse than either standard.

**You present nothing to the person.** A dispatched round hands its JSON envelope back to
the main agent, and that agent decides what anybody is shown — so do not paste a document,
or `document_present` output, into what you return. Presenting a document in full belongs
to the gate the main agent is asking somebody to sign, and this round is not that.

**Your round is recorded as a SOURCE supporting `spec.md`** — `source_add(..., supports:
"spec.md", stage: "sdlc-spec-audit")`. It is what a planner has to go on when building from a spec you passed, what tells
anyone later that this spec was read by somebody who did not write it, and what the platform
requires the next version of the spec to cite. It is not a document of the flow: an audit
report is the material that makes a revision necessary. `sdlc-audit-criteria` carries how to
write it and the exact call.

## Twelve: the spec's own contract

The eleven failure modes in `sdlc-audit-criteria` are about prose that any document can fail. This one is about what
makes a spec a spec, and it is where a spec most often fails without reading badly.

Walk each and record findings the same way:

1. **Component completeness.** The eight canonical components are present with their displayed
   labels — Context · Problem · Goals & Requirements · Alternatives · Approach, Method & Structure ·
   Verification Plan · Risks & Mitigations · Stakeholders & Work. A missing one is a finding
   with no exception: the platform refuses the approval of a spec missing any of them, so a
   spec you are auditing without one cannot pass its gate whatever you conclude.

   **The real failure here is a heading with nothing under it.** A component that genuinely
   does not apply says so in a sentence — "None: this is a process change" — and that is a
   claim a reader can disagree with. A component present as a heading with four lines of
   restatement under it was named, not written, and it passes every mechanical check there
   is; that is a finding, and it is the one only you can make.
2. **Requirement traceability.** Every functional requirement is numbered `FR-N`, uses
   must/should/may, and maps to at least one acceptance criterion. Every acceptance criterion is
   numbered `AC-N.N`, has a checkbox, and is testable. An FR with no AC is a requirement nobody can
   tell was met.
3. **The deliverable contract.** The `### Deliverable contract` block under `## Context`
   declares `kind`,
   `audience`, `disposition`, at least one `artifacts` entry or a terminal command criterion, and
   **every `acceptance` entry has an explicit `method`, a `why`, and at least one `references`
   entry.** A criterion whose method is `agent-review` where the claim needs authority or
   accountability is a finding: `agent-review` is never a substitute for `human`, and a plausible
   opinion is not a sign-off.
4. **Frozen contracts inlined.** Values, schemas, enums, field lists and sort orders are written out
   verbatim, not referenced as "see the codebase" or "as defined in X". A downstream worker cannot
   follow a pointer it has no context to resolve.
5. **Scope is exhaustive.** In-scope and out-of-scope both enumerated. Anything ambiguous belongs
   explicitly in one of them.
6. **Blocking prerequisites flagged.** Anything depending on an external artifact — a spike, a
   sign-off, a governance review, a schema freeze — is marked with the artifact and the condition
   that unblocks it.
7. **Workstreams separated.** Where the spec covers several independent kinds of work — prerequisite
   gates, the buildable implementation, governance sign-offs — Delivery order enumerates them. A
   spec that folds governance into the implementation workstream produces a plan that cannot
   sequence them.

Add `spec-contract` to `criteriaCovered` when you have walked these.

## What a spec audit is not

**Do not audit the decision.** Whether the team should build this, and which alternative they
picked, was settled with a person in `sdlc-spec` and is not yours to reopen. Audit whether the
document says what was decided, coherently enough to plan from.

"I would have chosen option B" is not a finding. "The Approach implements option B while
Alternatives records option A as the decision" is — and it is a critical one.

## Skill contract

**Outcome:** one round's findings on `spec.md` — the eleven prose failure modes plus the seven
points of the spec's own contract — registered as a SOURCE supporting that document with
`source_add`, and returned to the caller as one JSON block. No document of the flow, and no change
to the spec.

**Required evidence:** every finding in one of the four evidence shapes — doc quote, absence
reference, wrong-claim, internal-coherence — each opening with its source in square brackets: the
nearest heading for the document, the file path for code. A finding in none of those shapes is
speculation, and it goes in the summary as "investigation needed" rather than into `findings`.
Plus the spec version you were shown, on the round and on its source: a missing component is a
claim about one revision, and the eight are only required of this document at its approval.

**Allowed unknowns:** whether the team should build this at all, and which alternative they should
have picked — that was settled with a person in `sdlc-spec` and is not yours to reopen. Which of
your findings get acted on: the document's owner decides, and severity is your honest read rather
than your verdict. "I would have chosen option B" is not a finding; "the Approach implements
option B while Alternatives records option A as the decision" is, and it is critical.

**Work roles:** this round is dispatched because the value is a reader who did not write the
document; running it yourself re-reads your own reasoning and finds it sound. The person who owns
the spec decides what to fix, and you present nothing to them — the main agent decides what
anybody is shown. Where the caller said what the last round raised, confirm each fix rather
than re-reporting it. The platform asks two bounded questions of your round when it is recorded,
and routes on them; you ask none, and severity stays yours to calibrate.

**Checkpoints:**

| Where | Question ID | Asked about |
|---|---|---|
| When `source_add` records your round — asked by the platform | `changes_commitment` | whether the round reopens something the document records as agreed — `yes` makes the next move `decide`, waiting on the stakeholder, instead of another round |
| The same, from round 2 on | `repeats_finding` | whether the round mostly repeats the rounds before it — the next move says so; it does not change the move |

**Action and exit paths:** the action is the eleven failure modes one at a time, then the spec's
seven, then consolidation. Two exits, both taken every round: `source_add` carrying the prose
findings and naming `spec.md`, and the JSON block as your final text. The exit that does not exist
is fixing what you found — an audit that edits the document destroys the caller's ability to
decide which findings to accept and removes the evidence that anything was ever wrong.

**Degraded behaviour:** the caller did not tell you what the previous round raised, so say so and
audit the document as it stands rather than assuming this is round one. A component present as a
heading with four lines of restatement under it passes every mechanical check there is, which is
why that finding is the one only this round can make. Read-only here is a discipline and not an
enforced denial: nothing stops you writing, which is exactly why keeping it is yours.
