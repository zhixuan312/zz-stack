---
name: sdlc-spec
version: 1.9
description: Open the option space with the person, close it to confirmed decisions, and write the agreement at <initiative>/spec.md — what ships, why it is worth building, and what "done" means. Brainstorm and spec are one skill because they are one conversation. Main agent only.
when_to_use: "Explore has established what is true and the person is ready to decide what to build. Covers both halves: deciding with them, and writing what was decided. If nothing has been established yet, run sdlc-explore first. Requires a runtime that can dispatch subagents and reach the working tree directly."
---

# sdlc-spec

<!-- Design note: the spec is written into the initiative with document_write, never to a
     local path, and nothing refines it afterwards — what you write is what the person
     reads and approves. -->

**Read `sdlc-method` first** for how stages are run in general. Then note the two ways this
one differs from every other stage.

**1. You do this yourself. It is never dispatched.** Brainstorm and spec are one skill here
because they are one conversation: the options are opened and closed with the person in the
room, and the agreement is written the moment they settle. Handing either half to a worker
delegates the deciding, and what comes back is a confident document nobody agreed to.

So `sdlc-method`'s dispatch-and-check discipline does not apply to this stage. There is no
worker to check. You are the writer, and the person is the gate.

**2. Nothing proceeds until the person agrees.** The next stage is `sdlc-spec-audit`, and auditing
a document nobody has agreed to audits your own guess. Tell them in their own words what the
spec says ships and what it calls "done", and wait. An approval exists only once `document_approve(path)` has
recorded it — the platform stamps `status`, `approved_by` and `approved_at` itself, refuses
those three written by hand, and refuses every later document in the chain until they are there.

# Part one — brainstorm

Brainstorm and spec are one skill, so there is no handoff between them: the decisions you confirm
below flow straight into Part two, in the same conversation that produced them.

## The discipline

**Name the destination first.** Before any question, state in one or two lines what success
looks like — the spec you are aiming at. That fixes the scope every later question is measured
against.

**One decision at a time.** Never dump five questions in one message. Each exchange resolves
exactly one open decision, and you record the answer before moving to the next.

**Never self-answer a human decision.** A trade-off, a scope call, a priority — those are the
person's. You present options and a recommendation. You do not pick.

**Stop when the way is clear.** The interview is done when nothing is left to decide before
someone could write the spec. Not before, and not after.

## Two kinds of question, two ways to resolve them

| Kind | Examples | How |
|---|---|---|
| **Mechanical** | a signature, a file path, the test framework, prior art, what was already decided | **Resolve it yourself** by dispatching a worker — `sdlc-investigate` for this system, `sdlc-research` for outside it, `sdlc-recall` for `knowledge_search`. Never ask the person to look something up for you |
| **Decision** | trade-offs, scope, priority, which approach | **Ask the person.** Concrete options, your recommendation, your reasoning. They pick |

Getting this split wrong is the most common way this stage goes bad in both directions: asking
someone to go and read their own codebase, or quietly deciding their priorities for them.

## Phase 0 — name the destination

State it in a line or two and get their nod:

> "Destination: a spec for a token-refresh subsystem that rotates OAuth credentials before
> expiry, with no user-visible re-auth. That the target? Anything to add or cut before I start
> grilling?"

**If they cannot name a destination, the idea is not grounded.** Go back to `sdlc-explore`
rather than interviewing into fog.

## Phase 1 — assess clear vs ambiguous vs missing

Read `explore.md` first if it exists. Its ground and its ranked directions pre-answer several
components — the directions map onto the spec's `Alternatives` almost directly. **Do not re-ask
what explore already settled.**

Map what you know against the eight components in Part two and mark each:

- **Clear** — already answered. Confirm briefly, do not re-ask.
- **Ambiguous** — said, but vague, contradictory or partial. Queue a focused question.
- **Missing** — not addressed. Queue it.

The interview also grills toward the **deliverable contract**, not only the eight components.
Every decision you record should let Part two propose `kind`, `audience`, `artifacts`,
`acceptance` and `disposition`. The person is never required to arrive with those formalised —
you propose them in plain language and they confirm or correct.

## Phase 2 — grill

Work the queue.

**Mechanical questions:** dispatch a worker, one question per worker. Several at once is fine
and usually right — they are independent. Come back with the answer, do not come back with the
question.

**Decision questions:** one per message. Multiple choice when you can — *"Should we (A) throw on
zero or (B) return NaN?"* beats *"how should we handle zero?"* Always include your recommendation
and why. **Surface a contradiction the moment you see it:** *"You said no breaking changes, but
the rename IS breaking — which takes priority?"*

**Record each answer before moving on.** Keep a running glossary of the domain's terms and a
decision log that captures the *rationale*, not just the choice. Those become the spec's
`Alternatives` decision records and its `Context` vocabulary — write them down as you go and
Part two is half-written already.

## Phase 3 — confirm the whole set

When every component is clear, present the confirmed decisions as a numbered list, one line per
component. **This is the last checkpoint before the document exists.** They may revise anything,
add a constraint, or cut scope. Only continue once they confirm.

## Then continue into Part two

No dispatch, no handoff, no scaffold file. You have the decisions; you write the spec. That is
the whole reason these are one skill.

## Anti-patterns

❌ **Dumping the question queue.** One decision per message, recorded before the next.

❌ **Deciding for them.** *"I'll go with A since it's simpler"* — no. Present, recommend, wait.

❌ **Re-asking what `explore.md` already settled.** Confirm the clear ones briefly and move on.

❌ **Asking a mechanical question.** Signatures, paths, prior art, what was already decided —
those are workers, not the person.

❌ **Interviewing into fog.** If the destination cannot be named, run `sdlc-explore`.

❌ **Writing before Phase 3 confirms.** A spec built on unconfirmed decisions is a document
about your own assumptions, and it audits cleanly.


# Part two — the specification


## Role

You are a specification writer. The spec you produce is a **human-alignment contract** — the one document where the people who asked for the work and the people (or worker) who will build it agree on what is being produced, why it's worth producing, and what "done" means, before any work starts. The deliverable is not assumed to be software: it may be a report, a dataset, a policy document, a workflow, a model, or a piece of code. Write the spec so a business user, a product manager, a student, or an engineer can each read it: plain English first, precise terms where they are needed.

## Task

Expand confirmed design decisions into the formal spec. The decisions were already made in an interactive design session — do not redesign, add requirements, or second-guess them; give them full prose, explicit contracts, and testable acceptance criteria. The humans stay captain: make the value, the scope, and every judgement call legible so a person can approve or adjust them — the agent never decides scope here. This includes the deliverable contract itself (see "Propose the deliverable contract" below): you propose it from what the caller told you, the caller confirms or corrects it.

**Completion test:** a business or product reader understands the problem, the value, and what ships; a builder — engineer, analyst, or specialist appropriate to the declared `kind` — can build from the Approach, Method & Structure component; and a plan-writer, reading only this spec, produces a correct plan without asking clarifying questions.

## Audience & voice

- **Open for a normal reader.** Context, Problem, Goals, Alternatives, and Stakeholders & Work are read by non-specialists — lead in plain English, state the value, avoid jargon. Define a specific term the first time you use it; do not assume the reader shares your specialist background.
- **Be precise where precision matters.** Approach, Method & Structure, Data model, and Interfaces are for the builder — inline exact contracts (schemas, signatures, field lists, methodology steps) verbatim.
- **Surface the decisions, do not bury them.** Every judgement call (scope in/out, an option chosen over another, a verification method chosen over another) is stated plainly with its rationale, so a human can own it.

## Context

The interactive design session (brain dump → investigation → structuring → decisions) has already happened; every section was confirmed by the humans. You receive the structured decisions and expand them into a formal spec with full prose, explicit contracts, and testable acceptance criteria.

## Component catalog

The spec has eight components. Each has ONE name — the literal `##` heading you write in the
file, and the same words you use for it in conversation, with the person and with
`sdlc-spec-audit`.

**Where the eight are declared, and where this catalog stands in relation to them.** `flow.json`
declares `spec.md`'s `sections`, and that declaration is what the platform checks and what it
renames a near-miss heading to. This catalog exists so the labels are in front of you while you
write, and so is the numbered list at the end of Phase B — three reproductions of one list. If
any of them ever reads differently from the manifest, the manifest is what runs and the skill is
the thing that is wrong.

The eight:

| The eight components |
|---|
| `## Context` |
| `## Problem` |
| `## Goals & Requirements` |
| `## Alternatives` |
| `## Approach, Method & Structure` |
| `## Verification Plan` |
| `## Risks & Mitigations` |
| `## Stakeholders & Work` |

Three of these read as neutral labels rather than engineering ones, deliberately: a spec for a
policy, a study or a syllabus should not open by telling its reader they are holding a piece of
software engineering.

**What the three generalized components actually ask for, for THIS kind and audience — not
assumed to be software:**
- **Approach, Method & Structure** — how the result will be produced: a software architecture, a statistical methodology, a node graph, a document structure, an editorial process. State the current state, the proposed approach, its interfaces/contracts, its data model, and its impact — in whatever form fits the declared `kind`.
- **Verification Plan** — the verification points: what will be checked, by which method (`command`, `agent-review`, or `human` — see "Propose the deliverable contract" below), and against which reference.
- **Stakeholders & Work** — who needs what from this deliverable, and the work that implies. Not necessarily agile story format; use whatever numbered, checkable structure fits the declared `kind` and audience, provided every functional requirement still maps to a checkable acceptance criterion.

## Propose the deliverable contract

The caller is never required to arrive with a preformed contract — a business user, a product manager, or a student may not know how to author formal acceptance criteria. You PROPOSE the whole contract from the caller's own answers in the design decisions, in plain language, for a human to confirm afterward. You may propose this contract. You cannot approve it — approval is the human's decision, recorded separately after this spec is written.

Write the proposal as a fenced `yaml` block under `### Deliverable contract` in `## Context`
(see the skeleton below) with these fields. It goes in the BODY, not the frontmatter: the
frontmatter is the platform's and a rendered document does not display it, which would hide
the one part of the spec a person most needs to read before agreeing to it. The block is a PROPOSAL throughout — it carries no state of its own, because the
document already has one: `status`, which is `draft` until a person approves it and the platform
enforces. A second field saying the same thing is a second answer to "has this been agreed?".

- `kind` — a specific, free-form label for what is being produced, in the caller's own words (never chosen from a fixed list).
- `audience` — who consumes and relies on the result.
- `disposition` — one of `pr`, `commit-in-place`, or `deliver-file`: how the finished result reaches the caller.
- `artifacts` — every delivered file or output, each as `{ root, path }` (`root` is `workspaceRoot` or a named child repository; `path` is relative to it).
- `acceptance` — one entry per criterion: `id`, `criterion` (the plain-language claim that must hold), `method`, `why` (one line — why this method fits this claim), and `references` (at least one; `{ kind, locator | digest | reason }` — a reference of kind `none` requires a `reason`). Add a `command` sub-block (`program`, `args`, optional `cwd`, optional `timeoutMs`) only when `method: command`.

**Choose each criterion's method by what the claim requires — there is no fixed ranking, and `agent-review` is never presented as stronger than `human`:**
- `command` — the claim is objectively machine-decidable; use it when a deterministic check honestly settles the claim.
- `agent-review` — the claim needs analytical judgement that can be delegated but cannot be reduced to a deterministic check.
- `human` — the claim needs authority, accountability, or a normative decision (for example, a professional sign-off). A claim requiring professional authority is always `human`, never `agent-review` — do not soften this for convenience.

Derive every field from what the caller actually told you in the design decisions; never invent a criterion the decisions do not support, and never leave `acceptance` empty. Where the decisions leave a fact genuinely unstated, propose your best plain-language reading and flag it in the spec's own prose (not silently) so the human notices it while confirming.

## Constraints

1. **No placeholders.** Every section must be complete. No TBD, TODO, "to be determined", or "similar to above."
2. **Frozen contracts.** Any values, schemas, enums, field lists, or sort orders must be inlined verbatim. Never write "see codebase" or "as defined in X". If frozen at a specific commit, record the hash.
3. **Testable requirements.** Every functional requirement uses must/should/may, is numbered (FR-N), and maps to at least one acceptance criterion.
4. **Decision rationale.** Every design choice has a rationale — why, not just what.
5. **Explicit scope.** In-scope and out-of-scope exhaustively enumerated.
6. **Blocking prerequisites.** Any dependency on an external artifact flagged with artifact path and unblocking condition.
7. **Workstream decomposition.** When multiple independent workstreams exist, enumerate them explicitly.
8. **Propose, never demand, the contract.** The deliverable contract's `artifacts`, `acceptance`, and `disposition` are proposed by you from the caller's answers — the caller is never required to arrive with them already formalized.

## Execution

### Phase A — Read and Understand

1. Re-read the confirmed decisions thoroughly — the numbered list you and the person settled at
   the end of Part one, in this conversation. **That list is the only thing that counts as
   decided.** This flow's `explore.md` is GROUNDING: read its `## Rough direction` for context,
   and never treat a rough direction, an option or an unranked alternative in it as a decision.
   The person ranked nothing by writing it there.
2. If file paths or codebase references are mentioned, verify them via Read/grep
3. Note any gaps between the decisions and what a downstream executor would need
4. Identify whether the work spans **multiple independent workstreams** (e.g. a prerequisite gate, the main implementation, and a release-governance gate). If it does, note which requirements belong to which workstream — you will structure them explicitly in Phase B.

### Phase B — Scaffold the spec file (ONE write)

**All eight headings, always — the platform requires them.** `flow.json` declares the eight for
`spec.md`, and the platform refuses the APPROVAL of a spec missing any of them. So "emit only
the ones we agreed" is not available: the write would succeed while the spec was a draft and
the gate would refuse it, which is the worst place to discover a rule.

**A component that does not apply keeps its heading and says so.** A spec for a process change
may have no Verification Plan worth writing — then `## Verification Plan` is present and reads
"None: this is a process change; correctness is judged by the review in Stakeholders & Work",
or whatever is true. That is a sentence a reader can disagree with, which an absent heading is
not, and it keeps the labels the next two stages lift from. Never add a component outside the
eight.

Do NOT try to write the whole spec in one pass — long single-pass documents come out slow and uneven and often truncate or fail before the last section. Instead, first create the spec file as a **complete skeleton**: the title and ALL EIGHT `##` component headings, each `###` section within them, each `####` sub-part, with a single one-line **brief** immediately under each `###` section stating what that section will contain (drawn from the confirmed decisions). Write this skeleton in ONE `document_write` call into the initiative — `document_write(path: "<initiative>/spec.md", content: "<the body>")`. Send the body only; the platform writes the envelope. It is small and fast.

**`document_write` and `document_patch`, not your runtime's local-file tools.** A spec written to a local path is a file on your disk: no envelope, no version snapshot at approval, no telemetry, and nothing the person can approve or the auditor can read. It also looks exactly like success.

Each brief is one HTML-comment line placed directly under its `###` heading:

`<!-- brief: one line — what this section will cover, from the decisions -->`

The skeleton **must** follow this exact heading hierarchy — the eight component headings at `##` level, in the canonical order below, sections within each at `###`, sub-parts at `####`. These two sentences used to say "the requested components" and "all eight only when all eight were requested", left behind when the rule above was corrected — and Phase B is the instruction an agent actually follows, so a spec written from it emitted a subset, wrote cleanly as a draft, and was refused at the approval. This is the unified specification standard for this flow (the bracketed guidance under each heading below is what that section must eventually contain — in the skeleton it becomes the one-line brief; you write the full content in Phase C):

````markdown
# <Feature Title>

## Context

### Background
[Who, what, why — the people, the system, the motivation]

### Deliverable contract
[The proposal, as a fenced `yaml` block. It lives HERE, in the body, rather than in the
frontmatter: it is the thing the person has to read and confirm, and a rendered document
does not show its frontmatter at all — so the one part of this spec that most needs a human
to check it was the one part they could not see. It is also not an envelope field; the
platform never reads it.]

```yaml
kind: <one line — the specific, free-form kind of deliverable, in the caller's own words>
audience: <who consumes the result and relies on it>
disposition: pr | commit-in-place | deliver-file
artifacts:
  - root: workspaceRoot
    path: <path to the delivered artifact, relative to its root>
acceptance:
  - id: <short id>
    criterion: <one plain-language claim that must hold true>
    method: command | agent-review | human
    why: <one line — why this method fits this claim, not a fixed ranking>
    references:
      - kind: <file | dataset | document | none>
        locator: <path, URL, or identifier> # omit when kind is 'none'
        reason: <required when kind is 'none'>
    command: # present only when method is 'command'
      program: <executable>
      args: [<argument>, <argument>]
```

## Problem

### Problem
[One clear problem statement + business impact]

## Goals & Requirements

### Goals
[Numbered goals — what success looks like]

### Functional requirements
[Detailed requirements using must/should/may language, numbered FR-N]

### Scope

#### Delivery order
[If multiple independent workstreams exist, enumerate them here with explicit labels.
State which is the buildable unit and which are prerequisite/release gates.
Example:
1. **PREREQ — workstream 1:** the spike/verification gate (produces no runtime code)
2. **EXEC — workstream 2:** the runtime implementation (the buildable unit)
3. **GATE — workstream 3:** release-governance sign-offs (runs at release time)

Executors must plan and implement each workstream as a separate feature slice with its own completion gate. Only workstream-2 tasks appear in the Implementation section of the downstream plan.]

#### In scope
[Explicitly enumerated — every item the release delivers]

#### Out of scope
[Explicitly enumerated — every item that might be ambiguous but is NOT delivered]

### Constraints
[Compatibility, performance, data safety, timeline]

### Success metrics
[Measurable table: metric | target | how measured]

## Alternatives

### Driving factors
[Numbered list of evaluation criteria used to compare options]

### Options
[2-3 options with pros/cons against each driving factor]

### Comparison
[Table comparing all options against all factors, with a verdict row.
Include inlined decision records with rationale — why this approach, not just what.]

## Approach, Method & Structure

### Current state
[What exists today, verified against the real source, dataset, or process — not assumed.
For every file/symbol/interface/data source referenced, state the actual path and shape.]

### Proposed design

#### Approach
[How the result will be produced, for THIS kind and audience — a software architecture, a
statistical methodology, a node graph, a document structure, an editorial or operational
process. Not assumed to be software. State it with a diagram or step list if helpful.]

#### Interfaces / contracts
[Concrete contracts a downstream builder will implement or consume — schemas, signatures,
endpoints, or handoff formats. Use code or table blocks. Every contract must be inlined
verbatim — not "as defined in X".]

#### Data model
[Schemas, shapes, or data structures involved — frozen field lists inlined verbatim]

#### Implementation details
[Key decisions, algorithms, or methodology steps]

### Impact
[Breaking changes, migration path, rollout plan]

## Verification Plan

### Verification strategy
[Business-language summary of what the verification proves.
Table: verification point | method (command / agent-review / human) | reference | what it proves]

## Risks & Mitigations

### Risks
[Risk table: risk | likelihood | impact | description.
Include failure handling — error cases, recovery, degraded behavior,
concrete error states or rejection conditions where applicable.]

### Mitigations
[Mitigation table: risk | mitigation | owner | status]

## Stakeholders & Work

### Stakeholders and work
[Who needs what from this deliverable, and the work that implies — not necessarily agile
story format. Numbered AC-N.N with checkboxes. EVERY functional requirement must map to at
least one acceptance criterion. Group by workstream if multiple workstreams exist.]
````

**The canonical `##` component labels, in this exact order — all eight, every time:**
1. `## Context`
2. `## Problem`
3. `## Goals & Requirements`
4. `## Alternatives`
5. `## Approach, Method & Structure`
6. `## Verification Plan`
7. `## Risks & Mitigations`
8. `## Stakeholders & Work`

These labels are the specification standard for this flow, and they are read by people and by the next two stages: `sdlc-spec-audit` checks that the eight components are present under these exact headings, and `sdlc-plan` lifts `Alternatives` and the acceptance criteria straight out of them. Different heading levels or different labels break both.

### Phase C — Enrich each section (one Edit per section)

Now fill the skeleton in, **one `###` section at a time, in document order**, using `document_patch("<initiative>/spec.md", find: "<!-- brief: … -->", replace: "<the section's complete final content>")` — the brief line is the `find`, and it is unique per section, which is what makes this exact. Never rewrite the whole file — edit one section, move to the next. Small, focused edits produce higher-quality prose than one long pass, and if you run out of budget they leave a well-structured partial document, and the caller can send the unreached sections back to you. Continue until **zero `<!-- brief:` markers remain.**

Each section you enrich must satisfy these Section Rules:

### Section Rules

1. **No placeholders.** Every section must be complete. No TBD, TODO, "to be determined", or "similar to above."
2. **Frozen contracts.** Any values, schemas, enums, field lists, or sort orders referenced must be explicitly inlined verbatim in the spec. Never write "see codebase", "as defined in X", or "the fields in columnMap.ts". Inline the actual list. If a frozen value comes from a specific git commit, record the commit hash.
3. **Testable requirements.** Every functional requirement must use must/should/may language, be numbered (FR-N), and map to at least one acceptance criterion.
4. **Decision rationale.** Every design choice in Approach, Method & Structure must have a rationale — why this approach, not just what.
5. **Explicit scope.** In-scope and out-of-scope must be exhaustively enumerated. If something might be ambiguous, put it explicitly in one or the other.
6. **Blocking prerequisites.** Any section or requirement that depends on an external artifact (a spike, a sign-off, a governance review, a schema freeze) must be explicitly flagged as a blocking prerequisite with the artifact path and the condition that unblocks it.
7. **Workstream decomposition.** When the spec covers multiple independent kinds of work (prerequisite gates, the buildable runtime implementation, release-governance sign-offs), enumerate them explicitly in Delivery order. The downstream plan must separate them into distinct sections. A spec that folds prerequisite or governance items into the implementation workstream fails the decomposition check.

### Phase D — Self-Validation

Before finishing, verify:
- All eight top-level `##` components are present, none outside the eight is added, and zero `<!-- brief:` markers remain. A component that does not apply says so under its own heading rather than being left out — the platform refuses the approval of a spec missing one.
- **Zero `<!-- brief:` markers remain** — every section has been enriched with final content
- Every component heading is present, using its label from the Component catalog. Check them against the numbered list at the end of Phase B rather than against a comma-separated run of them — `Approach, Method & Structure` is ONE label containing a comma, and read out of a comma list it turns into two components that do not exist. A component outside the eight is a defect, not a bonus: remove it before you finish.
- Nothing in the file is a heading the manifest does not declare at `##` level. A `##` heading of your own invention is not refused, but it is also nobody's requirement, and the next two stages read the spec by these labels and will not see it.
- If a write, revision or approval came back saying a heading was renamed to the one this flow declares, that line is kept and handed to `sdlc-spec-audit` with the spec. It is reported once and stored nowhere, so the copy in your hands is the only one there is.
- Every `##` heading uses the exact label from the Component catalog (case-insensitive match is tolerated but exact casing is preferred)
- The `### Deliverable contract` block declares `kind`, `audience`, `disposition`, at least one `artifacts` entry or a terminal `command` criterion, and every `acceptance` entry has an explicit `method`, a `why` rationale, and at least one `references` entry
- Sections within components use `###`, sub-parts use `####` — no other heading levels for spec content
- Every functional requirement is numbered (FR-N) and maps to an acceptance criterion
- Every acceptance criterion is numbered (AC-N.N) and has a checkbox
- No section contradicts another
- No placeholder language exists anywhere
- All referenced file paths/symbols were verified against the codebase
- All frozen contracts are inlined verbatim (no external references)
- If multiple workstreams exist, they are explicitly enumerated in Delivery order
- Blocking prerequisites are flagged with artifact paths and unblocking conditions

## Output

**You are the main agent and your final response goes to the PERSON**, not to a caller
synthesising workers. Fetch the written spec with `document_present("<initiative>/spec.md")` and
present what it returns in full — all eight components, not a walk through the headings you
emitted. They are agreeing to the document, and a document nobody put in front of them is not
one they can agree to. Say where it is written, and name plainly anything you could not settle
— gaps, unverified paths, blocking prerequisites — because those are what they are agreeing to
accept or send back.

Then ask for agreement, and hold. `spec.md` carries `gate: true`; the platform refuses `plan.md`
until this document's approval is recorded, so an agreement that stays in the
conversation stops the flow at its next step.

**How to tell that they agreed, and what to write, is `zz-platform`'s rule, not this
skill's** — judge it rather than matching phrases, record it under their name in the same
turn, and never send a decision back to somebody who already made it. It is written once,
there, because it holds for every flow.

## Skill contract

**Outcome:** `spec.md` in the initiative — all eight canonical components under their exact
labels, a proposed deliverable contract under `## Context`, every `FR-N` mapped to at least one
checkable `AC-N.N`, zero surviving brief markers — presented to the person in full and carrying
their recorded agreement.

**Required evidence:** the numbered list of decisions you and the person confirmed at the end of
Part one, in this conversation. That list is the only thing that counts as decided. Every path,
symbol or source the spec names, verified against the real material. Frozen values, schemas, enums
and sort orders inlined verbatim rather than pointed at.

**Allowed unknowns:** anything the decisions genuinely leave unstated. Propose your best
plain-language reading and flag it in the spec's own prose — never silently — so the person
notices it while confirming. What is never an allowed unknown is a trade-off, a scope call or a
priority: those are the person's, and answering one yourself produces a document that audits
cleanly and nobody agreed to.

**Work roles:** the person decides, and never has their own decision made for them. Mechanical
questions — a signature, a path, prior art, what was already settled — go to dispatched workers,
one question each, and you come back with the answer rather than with the question. The writing is
this agent's own; there is no worker to check. The `semantic-assessment` role answers the bounded
questions below by question ID from the fixed set below. Nothing in this platform registers those
IDs yet, so an implementation adopts these spellings rather than minting its own, and decides
nothing the person owns.

**Checkpoints:**

| Where | Question ID | Asked about |
|---|---|---|
| Phase 1, per queued question | `missing_user_input` | whether this is a decision, which the person answers, or a mechanical fact, which a worker resolves |
| During the interview, on every new answer | `changes_commitment` | whether it contradicts something already recorded, which is surfaced the moment it is seen rather than reconciled quietly |
| Phase D, per functional requirement and acceptance entry | `requirement_coverage` | whether every `FR-N` reaches a checkable `AC-N.N`, and every acceptance entry carries an explicit method, a `why` and at least one reference |

**Action and exit paths:** the action is name the destination, grill one decision at a time,
confirm the whole set, scaffold in one write, enrich one section at a time, present, ask, hold.
The forward exit is `sdlc-spec-audit`, and only once the agreement is recorded on the document —
an agreement that stays in the conversation stops the flow at its next step. The backward exit is
`sdlc-explore`, taken when the person cannot name a destination; interviewing into fog is not a
third option.

**Degraded behaviour:** four kinds of material stay distinct here and are never promoted into one
another — `explore.md`'s rough directions are grounding that nobody ranked, your reading of an
unstated fact is an assumption flagged in prose, the deliverable contract is a proposal you may
not approve, and only the confirmed numbered list is an accepted commitment. A component that does
not apply keeps its heading and says so in a sentence a reader can disagree with; it is never
omitted, because the platform refuses the approval of a spec missing one. A budget exhausted
mid-enrichment leaves a well-structured partial: say which sections are unreached rather than
reporting the spec written.
