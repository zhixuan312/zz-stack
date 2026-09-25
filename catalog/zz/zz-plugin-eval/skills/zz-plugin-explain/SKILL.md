---
name: zz-plugin-explain
version: 0.1
description: Stage 6 of zz-plugin-eval (EXPLAIN). Record what EVALUATE's own score and assessments actually found — strengths, defects, unknowns, each with an owner — and let findings.md regenerate itself from the current record. Ungated measurement output, never an approval gate.
when_to_use: "The sixth stage of zz-plugin-eval, once evaluation_score has completed. Produces findings.md — ungated, and every branch of this flow reaches it before anything else happens. No shell required."
---

# zz-plugin-explain

```
finding_record(eval_run_id, finding, idempotency_key, initiative?)
finding_decide(decisions: [{ finding_id, decision: applied | rejected, note }], idempotency_key)
```

**`findings.md` writes itself, and this stage does not paste it through `document_present`
the way `protocol.md` is.** Pass `initiative` on `finding_record` and the document at
`<initiative>/findings.md` regenerates FRESH from the run's current score and every finding
recorded against it — Score, Dimensions, Guardrails, Evaluator trust, Strengths, Defects,
Unknowns, Ownership, in that order, every time. It is ungated: nothing here asks a person to
approve it, so there is nothing for `document_present` to put in front of anyone. You do not
author this document's prose the way
`protocol.md` is authored; you record findings, and the platform renders them. Omit `initiative`
to record without touching the document — useful mid-run, before every finding is in.

## What a finding is

`kind` is `strength` (what is working), `defect` (what is wrong) or `unknown` (evidence does not
say which). `owner_kind` is **REQUIRED**, one of `plugin | dependency | platform | environment |
user_input | unknown` — this is the ownership classification DISCOVER already applied to the
patterns it mined, carried forward here per finding. `finding_record` RETURNS the finding as
stored, **DEFERRED** — recording is not deciding; applying or rejecting it is a separate act by
whoever owns it.

**A finding on somebody else's plugin/dependency/platform/environment/user_input carries no
`expected_effect` — assess it and stop.** Only a `plugin`-owned finding is IMPROVE's raw
material; report the rest honestly and move on. Cite `measure_id` (the `zz.eval_measure` this
finding is evidence for) and `evidence_refs` wherever the finding traces back to something
`evaluation_assess` actually read.

## ONE CHANGE, AND SAY WHAT YOU EXPECT IT TO DO

**A `plugin`-owned finding's `expected_effect` names ONE change and what you expect it to move.**
Two changes bundled into one finding make the next round unable to attribute either — the number
moves and nothing says which change moved it. And an `expected_effect` that names no measurable
direction cannot be contradicted, which means it can never be wrong, which means it was never a
measurement.

**Say where the change happens.** The catalog is read-only wherever this platform runs: nothing
in EVALUATE or EXPLAIN edits a plugin. A `plugin`-owned finding is a candidate for IMPROVE's own
search — a repository edit, proposed as a patch, proved before promotion, and released by
whoever owns it. `expected_effect` is the hypothesis IMPROVE's proposer reads; write it as
precisely as you would want a candidate's own `hypothesis` field to read.

## A FINDING STAYS OPEN UNTIL SOMEBODY CLOSES IT

A `deferred` finding stays open — it is what IMPROVE reads as `finding_ids` when it opens a
search, and what a reader later needs to know is still unresolved. Once somebody has acted (or
decided not to):

```
finding_decide(decisions: [{ finding_id, decision: applied | rejected, note }], idempotency_key)
```

**REFUSES `deferred` as a decision** — deferring is where a finding starts, so choosing it here
would be a decision that changes nothing while looking like one that did. A note is REQUIRED for
both real decisions: `applied` says what changed and where (a version, a file, a release);
`rejected` says why this is not worth doing. Deciding is the plugin owner's judgement — ask when
you are not the owner, never decide unilaterally on their behalf.

## Ownership decides what happens next, not you

This stage records; it does not route. A `plugin`-owned, still-`deferred` finding is what
`improvement_start` (the next stage) reads. A finding owned by anything else is reported here and
nowhere else acts on it automatically — say so plainly in the finding's own text rather than
implying a fix is coming.

## Pitfalls

❌ **Recording a finding with no `owner_kind`.** `finding_record` refuses it; ownership is not
optional.

❌ **Bundling two changes into one `plugin` finding's `expected_effect`.** The next round cannot
attribute either.

❌ **Calling `finding_decide` with `deferred`.** It is refused — that is where a finding starts.

❌ **Deciding a finding you do not own.** Ask the owner; recording the decision on their behalf is
not this stage's call to make.

❌ **Skipping `initiative` on `finding_record`.** `findings.md` never updates, and the next reader
opens a stale document.

## After findings.md, always IMPROVE

`findings.md` is ungated measurement output — nothing here approves it, and nothing blocks on it
being approved. Every branch of this flow reaches IMPROVE next: a subject with no plugin-owned,
actionable finding calls `improvement_start(skip: true)` there and the initiative closes on
`findings.md` itself; one with findings opens a real search or an owner-facing proposal. This
stage never decides which — it only makes sure every real finding this run produced is on the
record before IMPROVE reads it.

## Skill contract

**Outcome:** every strength, defect and unknown `evaluation_score` actually supports, recorded
with an owner classification, and `findings.md` regenerated to match — the ungated measurement
output every branch of this flow shares.

**Required evidence:** `finding_record`'s own stored response for each finding — never a claim
about what was found that is not backed by a recorded row. `finding_decide`'s response for any
finding closed in this pass, with its note.

**Allowed unknowns:** whether a `plugin`-owned finding will actually start a search — that is
IMPROVE's call, against `improvement_start`'s own eligibility rule (FR-34), not this stage's.

**Action and exit paths:** the action is record every finding the score supports, with ownership
and (for `plugin`-owned ones) one named `expected_effect`, regenerating `findings.md` as you go.
The exit is IMPROVE (`zz-plugin-improve`), always — whatever findings this run produced, or did
not.

**Degraded behaviour:** an `eval_run` with no defect and no unknown still gets a `findings.md` —
Score and Dimensions filled in, Strengths carrying whatever is real, Defects and Unknowns saying
plainly that none were found. A clean run is a real, reportable outcome, not an empty document.
