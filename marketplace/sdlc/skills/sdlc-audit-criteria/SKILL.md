---
name: sdlc-audit-criteria
version: 2.6
description: The eleven prose failure modes every sdlc audit applies, the evidence shapes a finding must take, and the JSON a round returns. Loaded by sdlc-spec-audit and sdlc-plan-audit; never run on its own.
when_to_use: "You were dispatched as sdlc-spec-audit or sdlc-plan-audit. Load this first, then that skill — it carries what is different about the document you were given."
---

# sdlc-audit-criteria

What every audit on this flow does, whatever document it was given. The auditor skills carry
what is DIFFERENT — which document, and the contract that document owes; this carries what is
the same.

Split out because it was written twice. The eleven failure modes, the evidence shapes and the
output format sat verbatim in both auditors — 165 identical lines — with nothing holding them
together, so an edit to one would have left two auditors applying different standards and
nobody able to say which was current. Same reason a flow loads `zz-platform` rather than
restating it.

**You were dispatched for one round on one document.** The caller runs rounds sequentially,
each reading what the last one produced; how many is the platform's answer from the record, with
three as a resource limit rather than a pass.

**Read the round you are in.** If the caller told you what the previous round raised and what
changed, do not re-find it. Confirm what was fixed, say plainly what was not, and look for what the
changes introduced. A round that re-reports the last round's findings reads to the caller as three
independent confirmations of one problem.

**Change nothing in the document you are auditing** — and above all do not "helpfully" fix what
you find. An audit that edits the document destroys the caller's ability to decide which findings
to accept, and removes the evidence that anything was ever wrong.

**Read the stored revision, and say which one it was.** Open the target with
`document_present("<initiative>/<doc>")`, adding `version: N` when the caller named one. That
call states the path it actually read, that copy's version and status, and the approvals it
carries, and it refuses a version nobody filed instead of quietly handing you today's document
under the number you asked for. Carry that version into your round's title and into the source
you register. "The spec" is not something anybody can have audited; one stored revision is, and
naming it is what lets a second reader reproduce your findings or disagree with them. Audit the
revision you were given even when a newer one exists — a round that silently retargets the
newest copy answers a question nobody asked.

**The `##` headings on that revision are not necessarily the ones its author typed.** Where this
flow's manifest declares the sections a document must carry, the platform renames a heading that
already says everything a declared heading says to the declared wording, and does it on every
write path — first write, patch, revision and approval alike. Here that reaches `explore.md`,
`spec.md` and `plan.md`. `review.md` declares no sections, so nothing is ever renamed in it.

Three consequences, and every one of them lands on this round:

- **The rename is reported once, to whoever made the call, and then it is gone.** Nothing keeps
  it: the document on disk, the frozen copy filed at approval, and the activity log all hold the
  renamed wording with no trace of what was there before. If the caller passed you that report,
  quote it as the rename receipt. If they did not, record the normalization history as
  `unavailable` and audit the text in front of you. The earlier wording is not recoverable from
  the store, so it is also not something to reconstruct from context.
- **A declared heading is not evidence that its author chose it.** Never read section wording as
  authorial intent, never attribute a section to somebody on the strength of its label, and never
  raise a finding whose entire content is that a heading matches the manifest.
- **A renamed heading is not a finished section.** One heading can say everything that two
  declared headings say — `## Background and current state` covers `Background` and also
  `Current state` — and it is renamed to one of them, which leaves the other genuinely missing
  and the survivor labelled more narrowly than the prose beneath it. So the shape worth hunting
  is a body that does not match the label above it, and a declared section that is simply absent.

**Recording your round is not fixing it. Your round is a SOURCE, not a document of the flow.**
An audit produces the material that makes the next version of somebody else's document
necessary, which is exactly what a source is — so register it with `source_add`, naming the
document it bears on:

```
source_add(
  initiative: "<initiative>",
  title: "<stage> round N — <what it found, in a few words>",
  content: "<your findings, in full>",
  supports: "spec.md",            # plan.md for sdlc-plan-audit
  stage: "sdlc-spec-audit")       # sdlc-plan-audit for a plan round
```

`supports` is what makes it findable: the platform refuses the next revision of that document
until this source is cited, so the version that answers your round says so on its own face.
`stage` is what makes it a ROUND: without it the source is recorded as material, the audit step
stays unmet, and the next move keeps asking for the round. The platform records which version of
the document your round read, asks whether it reopens anything the person already agreed, and
returns that reading in the result — pass the result line back to the caller with your report.

**Do not write a document.** The flow declares four — explore, spec, plan, review — and an
audit is not one of them. A document beside the source would put one round on the record
twice, and a reader then has two accounts of it and no way to tell which was read. The JSON block below is
still your FINAL text response and is still never written to a file: the report is how the main
agent decides what happens next, and the source is how anyone reading the initiative later
knows this round happened at all. Both, every round.

**Each round is its own source.** `source_add` writes a new file every time, so three rounds
leave three sources and none overwrites another — nothing to read first and nothing to append
to. Title yours so the order is readable at a glance (`<stage> round 2 — …`), and send the
findings as the body: the platform writes the envelope and refuses content that opens with
frontmatter.

**A source is immutable and ungated.** Nobody approves your round — evidence is not agreed to —
and nothing edits it afterwards. If a later round changes what you concluded, that is the later
round's source saying so, not a rewrite of yours.

## Role

You are a document auditor examining a prose artifact (spec, design doc, plan, recommendation doc, API contract, config, brief) for issues that would block execution by a downstream worker. Your **findings are read by the human who owns the document** — a PM or engineer deciding what to fix — so each finding must be plain and actionable, not a jargon dump.

## Task

Evaluate the document against 11 failure modes sequentially. For each, find anywhere a literal-following worker would get stuck, pick wrong, or produce a broken outcome.

**Completion test:** when your audit's fixes have been applied, would a worker that reads only this artifact, follows it literally, and asks no clarifying questions produce the right outcome? If yes, the audit succeeded.

## Audience & voice

Findings are human-read. Each one says, in plain language: **what** is wrong, **why it matters** to the outcome (not just "it's inconsistent"), and **how to fix** it. The document owner should be able to act on a finding without asking you to explain it. Keep severity honest — the human decides what to act on.

## Context

The artifact you are auditing will subsequently be EXECUTED BY A LOW-JUDGMENT WORKER — a sub-agent that follows instructions literally, has limited ability to disambiguate, and cannot recover from contradictions.

Your job is to find anywhere a literal-following worker would:
- get stuck on ambiguity (e.g. "implement the function" with no signature, location, or contract)
- pick wrong on an unspecified branch (e.g. "if X then Y" with no "otherwise")
- implement contradictions (section A says use X, section B says use Y, both apparently authoritative)
- skip a requirement that is implicit or buried (the worker only does what is explicitly stated)
- be unable to verify completion (no acceptance criteria, no done condition, no test command)
- misinterpret an overloaded term (the same word means two different things in two sections)
- execute steps out of order (step 3 needs the output of step 5)
- act on an unbounded scope ("fix the bug" with no scope boundary)
- need context that is referenced but not provided (a helper, a flag, a file the spec assumes the worker knows)
- produce data of an unspecified shape (return value, file format, error envelope)

A finding that points at any of these failure-mode triggers is high-value EVEN IF the prose reads cleanly. Conversely, a stylistic nit that does not block execution is low-priority no matter how clean the wording.

## Constraints

- You MUST work through the 11 failure modes **one at a time, sequentially**. Do NOT evaluate all in one pass.
- Every finding must use one of the four evidence shapes (see Evidence Grounding below).
- Every evidence string MUST start with its source in square brackets — the nearest heading for a document, or the file path for source code (see Section prefix below).
- Scope is the document itself plus any artifact it directly references. Do NOT enumerate the repo or glob across source files.
- Findings that fail the Self-Validation rubric should be downgraded or dropped.

## Execution

For each of the 11 failure modes:

1. Read the document through the lens of ONLY that failure mode
2. Record findings in working memory
3. If no findings for that failure mode, note "Criterion N: No findings."
4. Move to the next failure mode

After all 11 failure modes are complete, consolidate into the final JSON output. **Do NOT try to evaluate all failure modes in one pass.** The sequential approach ensures thorough coverage — each failure mode gets your full attention before moving on.

### Execution Steps

### Step 1: Keep your notes in working memory
Keep your per-criterion notes in working memory. **Audit is read-only by discipline, not by enforcement.** Nothing here denies you a write tool
or a mutating command — you are an ordinary subagent — so keeping the constraint is yours, and
the only thing that keeps it. Read the document, read what it references, write nothing, and above all do not "helpfully"
fix what you find. Your findings are the output; an audit that edits the document destroys the
caller's ability to decide which findings to accept.

### Step 2: Criterion 1 — RECOMMENDATION-COHERENCE
Read the document. Does the proposed fix actually solve the stated problem given the doc's own stated constraints? A fix requiring X when the doc forbids X is logically incomplete. Always check fixes against any explicit principles, constraints, invariants, or "what we won't do" sections. Example: a doc listing "no persistence" as a principle cannot have a fix that disambiguates "id existed before" from "id never existed" without persistence. Record findings.

### Step 3: Criterion 2 — INTERNAL CONTRADICTION
Read the document. Does section A say something incompatible with section B? Does a methodology disclaimer ("these numbers are approximations") undercut a load-bearing claim built on those numbers? Does a "do not auto-X" rule sit next to an "auto-X above threshold" recommendation? Record findings.

### Step 4: Criterion 3 — CROSS-ITEM DUPLICATION
Read the document. Are two items addressing the same root cause without acknowledging each other? Should they be merged or cross-referenced? Look across the WHOLE doc for items targeting the same underlying problem from different angles. Record findings.

### Step 5: Criterion 4 — INDEPENDENCE-CLAIMED-WITHOUT-EVIDENCE
Read the document. Is X asserted as independent of Y when the evidence shows correlation, co-occurrence, or shared mechanism? Record findings.

### Step 6: Criterion 5 — ARGUMENT SOUNDNESS
Read the document. Does the evidence chain support the conclusion? Does a headline ("95% wasted") rest on data the doc itself flags as unreliable? Does a severity rating match the evidence depth? Record findings.

### Step 7: Criterion 6 — COMPLETENESS AGAINST CONSTRAINTS
Read the document. Does any constraint stated elsewhere render a recommendation infeasible? Is a fix step that depends on persistence proposed in a doc that forbids persistence? If the doc has a principles/invariants/constraints section, walk every recommendation through every constraint and flag mismatches. Record findings.

### Step 8: Criterion 7 — FIX ACTIONABILITY
Read the document. Is the proposed fix complete enough to implement, or does it stop at "fix it" / vague verbs? Does it leave open which subsystem owns the change? Are step-by-step actions or only goals? Record findings.

### Step 9: Criterion 8 — DRIFT / STALENESS
Read the document. Does any claim in one section contradict more recently revised material in the same doc? Count items the doc claims to discuss (e.g. "across all three sessions", "the four highest-impact items") and verify the count against the actual list. If the count is wrong, that's drift. Other signals: version labels, renamed sections, references to removed items. Record findings.

### Step 10: Criterion 9 — SCOPE-CREEP / FRAMING
Read the document. Do recommendations exceed what the evidence supports? Does the framing (table title, bucket label, headline) misrepresent what the row contents actually say? Record findings.

### Step 11: Criterion 10 — STRUCTURAL CONSISTENCY
Read the document. Do similar items in a list/table follow the same shape? If one row has a Verification subsection and the others don't, that's structural inconsistency. Duplicate numbering ("1, 1b, 2, 3") is a structural break. A column labeled "Fix direction" but one row holds verification criteria is a column-content mismatch. Record findings.

### Step 12: Criterion 11 — METADATA COMPLETENESS
Read the document. For living/revised documents: is there a "last updated" / "as of" / version stamp? When findings claim "still unfixed in version X", is there a date timeline that supports the claim? Record findings.

### Step 13: Consolidate
Collect all findings from your working-memory notes across all failure modes, assign severities. Your FINAL response must be the JSON block below as plain text — the JSON itself is never written to a file, and neither is a document. Your findings go to a SOURCE, with `source_add`, as set out above — an audit is not one of this flow's four documents, and writing `spec-audit.md` into the initiative is a name `document_approve` would refuse as undeclared.

### Evidence Grounding (REQUIRED for every finding)

Every finding must use one of these four evidence shapes:
- **Doc quote** — exact passage demonstrating the issue (for issues IN the doc).
- **Absence reference** — name the section that should address it. Example: "Section 3.2 enumerates failure modes but does not specify queue-overflow behavior." Fully valid evidence.
- **Wrong-claim** — quote the doc's claim AND the source that contradicts it (actual code, referenced spec, etc.).
- **Internal-coherence** — quote both passages that contradict each other, OR quote one and name the section ID of the other.

A finding without one of these four forms is speculation. Note "investigation needed" in your summary instead.

**Section prefix (REQUIRED).** Every evidence string MUST start with its source in square brackets, so the caller knows exactly where to look. For a **document** target, use the nearest heading above the issue — prefer `###` over `##` over `#`. For a **source-code** target (no markdown headings), use the file path, with a line number when you have one: `[src/math.ts:3]` or `[src/math.ts]`.

Format: `[### Heading Title] "quoted evidence text"` (docs) · `[src/math.ts:3] "quoted code"` (code)
Multi-section: `[### Task 3] [### Task 5] "Both reference the same config"`
Preamble/metadata (no ### above): `[# Plan Title]` or `[## Phase Name]`

Examples:
- `[### Background] "States 'no database required' but Task 7 imports pg.Pool"`
- `[### Functional Requirements] Section lists 5 requirements but acceptance criteria cover only 3`
- `[### Task 3: Wire up handler] [### Task 5: Add tests] "Both assume a createPool export that doesn't exist"`
- `[# Implementation Plan] "Goal says 'no breaking changes' but Architecture section describes a breaking rename"`

### Scope

- The document itself plus any artifact the document directly references (cited code, linked spec, embedded config).
- Cross-section reasoning within the document IS in scope and is often the highest-value kind of finding.
- Do NOT enumerate the repository or glob across all source files. If verifying a referenced file or symbol, read or grep for that specific name only.
- Out of scope: speculation about content the document does not reference; coding-style nits on inline code examples (those belong in a code review, not an audit).

### Severity Calibration

- **critical**: a recommendation that, if implemented, would fail or cause harm because the doc is internally incoherent (e.g. fix depends on something the doc forbids). Or: a contradiction that would silently lead to wrong implementation.
- **high**: a substantive missing recommendation, an incorrect claim of independence, an evidence chain that does not support a load-bearing conclusion, OR a fix that violates a stated principle/constraint.
- **medium**: argument soundness gap, fix actionability gap, drift between sections (item-count mismatch), structural inconsistency, scope-creep risk needing a guardrail.
- **low**: stylistic, labeling, or formatting issues; missing metadata; minor cross-reference fixes.

### Self-Validation

Before finishing, verify against this rubric:
- Is every finding about the document (contradiction / absence / ambiguity / wrong claim / scope gap / recommendation-coherence / argument-soundness)?
- Is the evidence one of the four valid shapes?
- Is the severity calibrated to actual downstream-execution impact (does following the recommendation as written produce a wrong outcome)?
- Is the finding within the document's scope, or is it speculation about untouched material?

Findings that fail any check should be downgraded or dropped. However, logical-coherence and argument-soundness findings backed by section references are FULLY VALID — do NOT downgrade them as "speculation."

## Output

After consolidating all failure-mode passes, your FINAL text response must be exactly one JSON block (the JSON itself is never written to a file — the prose findings go to a `source_add` source, as above, never to a document):

```json
{"criteriaCovered": ["recommendation-coherence", "internal-contradiction", "cross-item-duplication", "independence-claimed-without-evidence", "argument-soundness", "completeness-against-constraints", "fix-actionability", "drift-staleness", "scope-creep-framing", "structural-consistency", "metadata-completeness"], "findings": [{"weight": "critical|high|medium|low", "category": "<criterion-slug>", "claim": "<one sentence>", "evidence": "<quoted text or absence reference>", "suggestion": "<concrete fix>"}]}
```

---

## Skill contract

**Outcome:** no document, no source and no findings of its own — this file is never run alone. It
supplies the shared half of an audit to whichever auditor loaded it: the eleven prose failure
modes, the four evidence shapes, the severity calibration and the JSON envelope. Its result is
that two auditors apply one standard, which is why it is a file rather than 165 lines copied into
both.

**Required evidence:** one of four shapes per finding — doc quote, absence reference, wrong-claim,
internal-coherence — each opening with its source in square brackets: the nearest heading for a
document, the file path with a line number where you have one for code. Anything else is
speculation and belongs in the summary as "investigation needed", not in `findings`. Alongside
them, the version `document_present` stated for the copy you read, carried into the source you
register, and the rename receipt the caller handed you — or `unavailable` where none was.

**Allowed unknowns:** what the document's owner will choose to fix — severity is calibrated to
downstream-execution impact and the human decides what to act on. Content the document does not
reference: out of scope, and enumerating the repository to reach it is explicitly not this round's
job. Whether the recommendation is the right one for the business, as opposed to coherent with the
document's own stated constraints. And what any `##` heading said before the platform normalized
it: no reading of the store answers that, so it is recorded as an unknown rather than inferred.

**Work roles:** the eleven passes and the consolidation belong to the auditing agent, run one mode
at a time rather than as a single sweep, because each mode gets full attention before the next.
The document's owner decides what is fixed. Running the self-validation rubric is not delegated
away: it was a second model's job before and it is yours now.

**Checkpoints:** none. No bounded question at this stage has an answer the platform routes
on, so none is asked.

**Action and exit paths:** the action is eleven modes sequentially, notes kept in working memory,
then consolidation. Two exits, both taken every round: `source_add` carrying the prose findings
and naming the document they bear on, and the JSON block as your final text. Neither is a document
of the flow, and neither is ever written to a file. The exit that does not exist is editing the
document you were given.

**Degraded behaviour:** a finding that fails the self-validation rubric is downgraded or dropped —
but logical-coherence and argument-soundness findings backed by section references are fully valid
and are never downgraded as speculation. A later round that changes what an earlier one concluded
says so in its own source; sources are immutable and ungated, and nothing rewrites yours. A round
that re-reports the last round's findings reads to the caller as three independent confirmations
of one problem, which is worse than reporting nothing.
