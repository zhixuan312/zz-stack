---
name: zz-plugin-define-qualify
version: 0.8
description: Stage 4 of zz-plugin-eval (DEFINE/QUALIFY), and the one gate that matters most. Derive what good means for THIS plugin from its own profile and DISCOVER's candidates, write it into protocol.md, get a person to agree it, then qualify every model-backed evaluator it names before anything is scored.
when_to_use: "The fourth stage of zz-plugin-eval, after DISCOVER. Conditional: protocol_read decides create/revise/reuse, and this stage only writes when it says create or revise. Produces protocol.md, gated — protocol_affirm refuses to bind it until somebody approves it. No shell required."
---

# zz-plugin-define-qualify

```
protocol_read(subject_version_id, initiative?)                create, reuse or revise?
```

`subject_version_id` is `initiative_status`'s `records["zz-plugin-identify"]` in a new
conversation. `protocol_read` also returns `open_candidates` — every DISCOVER candidate of this
plugin still at `status: candidate`, with its `id`, `description`, `prevalence` and `owner_kind` —
which is where the ids you fold into `failureTaxonomy` below come from.

`protocol_read` decides nothing for you: `create` means this plugin has no protocol yet;
`reuse` means the newest version is affirmed and still compatible and there is nothing to write;
`revise` names which trigger fired (`purpose_changed, new_recurring_failure, evaluator_drift,
new_evidence_surface`) and expects a new version, never an edit to the old one. Pass
`initiative` to record protocol_action as this initiative's durable branch fact (FR-58) — this
is what tells `initiative_status`, and every later close, whether `protocol.md` applies on this
branch. **On `reuse`, stop here** — protocol.md is `not_applicable` for this run and DEFINE has
nothing to write; go straight to EVALUATE.

**`awaiting_affirmation: { version, content_digest }` in the response** means the newest version
was recorded but no approved `protocol.md` was ever bound to it — a stage that stopped between
`protocol_record` and `protocol_affirm`. It is never `reuse`: nothing qualifies or scores against
it. With `triggers: ["none"]`, **do not record again** — write (or finish) `protocol.md` quoting
that `content_digest`, get it approved, and `protocol_affirm` the returned `protocol_version_id`
(below). With a trigger, record the next version as for any `revise`.

## Every plugin gets its own protocol

Not a shared rubric with a plugin name at the top. `sdlc` is a delivery method whose worth is
whether a stranger could execute what it produced; `zz-access` is a credential surface whose
worth is whether it refuses correctly. One scale over both would measure neither. Which is also
why **there is no comparing plugins here**. Two scores from two protocols are two things
measured with two instruments.

## The shape `protocol_record` validates

`protocol_body` is an `EvaluationProtocol` (`packages/contracts/src/eval-protocol.ts`) — read
its own comments before guessing a shape, and let `protocol_record`'s own zod issues, returned
verbatim on anything that does not match, tell you what is missing rather than guessing twice.
At the top: `protocolKey` (a stable name for this lineage — reuse the plugin's own name unless
you have a reason not to), `version` (this protocol's next number — `protocol_record` refuses
anything else; there is no edit), `pluginPurpose` (what `protocol_read`'s `purpose_changed`
trigger compares against the catalog manifest's own `purpose`), `observableSurfaces` (the tool
names `new_evidence_surface` checks this plugin's skills against), `failureTaxonomy` (below),
`dimensions`, and four policy blocks — `suites`, `qualification`, `scoring`, `improvement` —
whose content this skill does not prescribe, except one: `improvement.release` is
`{ minPostReleaseRuns, regressionBand }`, how a released improvement is judged on real use —
how many real runs of the released version before it is evaluated, and how far below the base
score its overall may land before it is rolled back. `protocol_record` refuses a body without
it; `release_prepare` and `release_verify` read nothing else.

## Dimensions and measures, and where the boundary lives

A **dimension** names one canonical kind of thing being measured — `effectiveness`,
`reliability`, `constraint_adherence`, `recovery_robustness`, `efficiency` or `generalization`
— carries a `weight` (every *applicable* dimension's weights sum to 1), and is either
`applicable` or not (a `notApplicableReason` is required exactly when it is not: `sdlc` has no
`efficiency` claim to make the way a latency-sensitive tool does, and saying so is not the same
as skipping the field).

Inside a dimension, one or more **measures** actually produce a mark. Each carries its own
`weight` (summing to 1 within the dimension), a `suite` (`capability` / `regression` /
`production` — which pass this measure runs in), whether it is `required`, and an
`evaluatorType`:

- **`bounded_semantic` / `generative_critic`** — a model reads an artifact's text and answers a
  bounded question. The question has to be answerable from the text alone, and its `evaluator`
  field is **required** — `{ stable_key, kind, question, answer_schema, polarity, model_policy }`.
  `protocol_record` refuses a `bounded_semantic`/`generative_critic` measure that carries none.
  **`definition.qualification.anchors` is required too** — the known-answer texts QUALIFY asks
  this measure's own question about; `protocol_record` refuses the body without them. See
  *Writing anchors* below. `definition.subjectKind` (`run`, `document`, `knowledge`, `bug`) names
  the artifact it reads, and `definition.appliesWhen: "refused"` asks a run measure only of runs
  that refused a call — any question about how a refusal read or was recovered from needs it,
  or every run without a refusal answers it vacuously. The judge reads at most 24,000 characters
  of an artifact: a question about a whole long document has to be answerable from its opening
  part, and say so.
- **`deterministic` / `outcome`** — a tool computes a fact and the measure reads it off OBSERVE's
  own snapshot, by a dotted `definition.factPath`: the fact's own name (`tool_refusal_rate`,
  `latency_p50_ms`, `outcome_delivered_rate`, ...) — every name `plugin_profile` computes is listed
  in `services/zz-core/src/eval/observe-facts.ts`'s own `OBSERVATION_FACT_KEYS`, and
  `protocol_record` refuses a `factPath` naming anything else, by listing the real ones back to
  you. Declare `definition.normalize`, one of three rules, to turn that fact's raw value into the
  `[0,1]` the measure needs:
  - `"rate"` (the default, so a fact that is already a rate — `usable_run_coverage`,
    `tool_coverage`, `tool_refusal_rate` — needs no `normalize` at all) reads the fact's own value
    directly.
  - `"inverted_rate"` reads `1 - value` — for a rate where LOWER is better, such as
    `tool_refusal_rate` or `dependency_failure_rate`: a plugin that refuses nothing should score
    `1`, not `0`.
  - `"threshold"` compares a measured quantity (`latency_p50_ms`, `tokens_per_model_call_avg`)
    against a declared `max` and/or `min`, and reduces the comparison to `1`/`0` — use this for
    anything that is not itself a `[0,1]` rate; `"rate"`/`"inverted_rate"` refuse (excluded, never
    a guessed value) when the fact's raw value falls outside `[0,1]`.

  A missing fact (a zero-denominator window, a snapshot recorded before its own window had any
  traffic) makes the measure excluded with a named reason — never a bare `0`, and never a
  silently-passing `1`.
- **`human`** — nothing here reads it automatically; it exists for a mark this platform does not
  yet compute any other way.

## Critical guardrails live on the protocol, not on a measure

`improvement.criticalGuardrails` — `[{ key, threshold }]` — is the ONE guardrail mechanism.
Name a measure's own `key` (**measure keys are unique across the whole protocol** —
`protocol_record` refuses a body that repeats one in any two dimensions, and a guardrail key that
names no measure) and the threshold its normalised `[0,1]` value
must meet or exceed. `evaluation_score` reads this same list — nothing on a measure's own
`definition` marks it as a guardrail — and `release_verify` rolls a release back when the
released subject's own evaluation fails one. An unmeasured guardrail reads `not_established`,
which is missing evidence, never a failure.

## THE JUDGE IS HANDED THE ARTIFACT'S TEXT, AND NOTHING ELSE

Before you write a `bounded_semantic`/`generative_critic` measure, name the artifact it will
read — a document's markdown, a run's evidence — and ask: **is
the answer IN that text?** If it lives in a row, a count, a status or a timestamp, **the measure
is `deterministic`/`outcome`**, not semantic — a semantic measure asked a question the text
cannot answer measures something other than its own name, and its noise spreads into every other
measure in the same dimension.

## STATE THE ARITHMETIC, DO NOT MAKE THE JUDGE DO IT

Whatever asks a typed judgement service a bounded question — a `bounded_semantic` measure's
`evaluator.question`, or a `scoring`/`qualification` policy that does — give it a comparison it
can make directly.

❌ `at most one third of the tools this plugin's skills name appear in never_called, counted
over every call recorded on its own door, across all versions`
✅ `the count of never_called is at most a third of tools_named_count`

Name the two fields the comparison is between, and let the tool that computes the figure supply
both numbers — never write either one into the measure itself, or the protocol is wrong the
moment the next release changes it.

## IF THE PROPERTY IS ONLY TRUE AFTER THE ROUND, ENFORCE IT — DO NOT MEASURE IT

Some lines cannot be measures no matter what figure you add, and the tell is the timing.
Before writing a measure, ask whether the thing you want is a measurement or a rule. If a round
could violate it and still finish, it is a measurement. If it should be impossible, it belongs
in the tool — the way `evaluation_start` refuses to bind an observation snapshot from a
different subject rather than a measure checking it afterward.

## The line is written before any artifact is scored

That ordering is the only guard against a protocol written to flatter the number it will
produce. Write the measure, get the document agreed, then EVALUATE. Never look at the scores and
then decide where the line should have been.

## Folding DISCOVER's candidates in

`failure_discover` (the previous stage) wrote `zz.eval_failure_mode_candidate` rows, `status:
'candidate'`. `protocol_record` is the only thing that ever moves one on, through
`failureTaxonomy`: an entry that is an object (not a bare string) may carry `candidateId` — the
one candidate this entry was written from, moved to `accepted` — and `mergedCandidateIds`, other
candidates folded into the same entry, moved to `merged` and pointed at the accepted one. A
`candidateId`/`mergedCandidateIds` naming a candidate from a DIFFERENT plugin's evidence is
refused. `protocol_read`'s `new_recurring_failure` trigger is exactly "a candidate still sits at
`status: candidate`" — so folding one in, or explicitly leaving it uncited, is what clears that
trigger for the next `protocol_read`.

## Recording it, then writing it

```
protocol_record(subject_version_id, protocol_body, idempotency_key)
```

writes a new, immutable `zz.eval_protocol_version` and RETURNS `{ protocol_version_id,
content_digest }`. It never edits a version in place — a body naming any version but this
protocol's next one is refused. **Record before the person reads it, approve after.** Recording
is not approving — until `protocol_affirm` binds a person's approval of `protocol.md` to this
exact version, `evaluator_qualify` and `evaluation_start` each refuse it by name.

`document_write` into the initiative as `protocol.md`, with the three sections the manifest
declares, spelled exactly:

- `## The plugin under evaluation` — name and version and digest, from IDENTIFY.
- `## What good means here` — the dimensions and measures, in prose a person can actually agree
  or disagree with.
- `## The evidence each dimension reads` — which computed figure or which artifact, per measure.

**Quote `content_digest` — the exact string `protocol_record` returned — somewhere in the
document's body.** `protocol_affirm` refuses to bind an approval that does not carry it. Then
`document_present` it and put what comes back in front of the person. They are approving this
document, not your account of it. Record their agreement with `document_approve` the moment it
arrives, under their name, in the same turn. Then call:

```
protocol_affirm(protocol_version_id, initiative, idempotency_key)
```

`initiative` is required because a bare `protocol_version_id` names no path on its own —
`protocol.md` lives at `<initiative>/protocol.md` in your team's store, and this is the
initiative you wrote it into.

### Writing anchors

`definition.qualification.anchors: [{ id, role, text, expected }]` — short, unambiguous examples
of the very artifact the measure judges (a spec for a document question, a `RUN <id>:` trace of
`HH:MM:SS  core:<tool>  <target>  ok|REFUSED  <refusal>` lines for a run question — the target is
the path or name the call acted on, absent for a call with none), each with the answer a
truthful evaluator gives to THIS measure's question (`yes`/`no` for a noul, a criterion key for a
choice):

- `role: "anchor"` — at least one clearly good and one clearly bad example (two different
  `expected` values). The first anchor is also asked three times for stability.
- `role: "fault"` — a good anchor with ONE defect planted, so the truthful answer flips.
- `role: "control"` — an artifact of another kind (a shell session, another project's issue)
  whose answer to the same question is still obvious.

Write a text a stranger would answer the same way. If you have to argue for its `expected`, it is
not an anchor — sharpen it or pick another. Never a sentence *about* the artifact ("Of 9 runs, 3
were usable"): the evaluator is asked the measure's question about the text itself.

## QUALIFY — every model-backed measure, before anything is scored

Once `protocol_affirm` has bound the approval, qualify each `bounded_semantic`/
`generative_critic` measure's own evaluator — `protocol_affirm` returns them as `qualify_owed`.
Pass `initiative` so the state is recorded and `initiative_status` can route to EVALUATE:

```
evaluator_qualify(protocol_version_id, measure_key, idempotency_key, initiative)
```

`measure_key` is the measure's own `key`, exactly as you wrote it into `protocol_body`. The tool
resolves the evaluator version that measure defers to from this protocol version — you never
pass one. It REFUSES a protocol version `protocol_affirm` has not bound, a key this protocol
version does not have (naming the keys it does), a key two dimensions of an older version share,
and a `deterministic`/`outcome`/`human` measure, which is never qualified. It runs the protocol's own `QualificationPolicy` over four evidence
categories, all from the measure's own `definition.qualification.anchors` — **anchors**,
**planted faults** and **controls** (each entry of that role, passed when the answer is its
`expected`) and **stability** (the first anchor asked three times) — plus **labels**, only where
the protocol's `qualification.labelMappings` names this evaluator's `stable_key`.

RETURNS `{ measure_key, evaluator_version_id, qualification_id, state, evidence: { anchors,
planted_faults, controls, stability, labels, reason, results } }` — `state` is one of
`unqualified`, `mechanically_qualified`, `operationally_qualified` or `human_calibrated`.
`reason` names every threshold that stopped the climb (`anchorPassRate 0.50 < 0.80 (1/2)`), and
`results` lists each text's `{ id, role, expected, got }` — read them before blaming the
evaluator: a text whose `got` a person would also give is a mislabelled anchor, fixed in a new
protocol version. `unqualified` with `reason: no_anchors` means the measure declares no anchors.
**Never refuses on thin evidence** — it always writes a row, honestly stating how thin.

**Qualify every `bounded_semantic`/`generative_critic` measure this protocol version names**
before handing off, not only the ones you expect to be asked about — `evaluation_score` reads
each REQUIRED model-backed measure's latest qualification against
`qualification.boundedSemanticMinimum` (default `operationally_qualified`), and one measure short
of it keeps the whole run's `qualification_met` false, so the score cannot be `established`.

## Pitfalls

❌ **A measure with no stated reason for its line.** It is a number nobody can defend later.

❌ **Deciding the line after seeing the scores.** That is the failure this gate exists for.

❌ **Reusing another plugin's protocol because it looks similar.**

❌ **Anchors that do not fit the question.** A text the measure's own question cannot be
answered about — a sentence about counts put to a question about a document — fails every
truthful evaluator, and the measure never scores.

❌ **Calling `protocol_affirm` before `document_approve`, or before quoting `content_digest` in
the body.** It will refuse, and it is right to.

❌ **Skipping QUALIFY for a measure you do not expect to matter.** Every model-backed measure this
protocol names needs qualification evidence before its answers may back a score.

❌ **Recording a body whose `dimensions` weights do not sum to 1 over the applicable ones, or
whose `measures` weights do not sum to 1 within a dimension.** `EvaluationProtocol`'s own schema
refuses it — the zod issue names which.

## Skill contract

**Outcome:** on `create`/`revise`, an approved `protocol.md` bound to an immutable
`zz.eval_protocol_version`, with every model-backed measure's evaluator carrying its own
qualification evidence — the one durable object EVALUATE scores against and PROMOTE/VERIFY's
release policy reads from. On `reuse`, nothing written; the newest version stands.

**Required evidence:** `protocol_read`'s own protocol_action and `triggers`. `protocol_record`'s
`{protocol_version_id, content_digest}`, quoted verbatim in the document. The person's recorded
`document_approve`. Every model-backed measure's own `evaluator_qualify` response, read and
carried forward — never assumed qualified because it was written into the protocol.

**Allowed unknowns:** whether a measure's evaluator reaches `operationally_qualified` on a thin
OBSERVE window — QUALIFY answers honestly whatever the evidence supports; a measure named
`unqualified` for now is not a reason to invent evidence, only a reason to say so.

**Action and exit paths:** the action is `protocol_read`, then — unless `reuse` — write and
record the protocol, get it approved, affirm it, then qualify every model-backed measure it
names. The exit is EVALUATE (`zz-plugin-evaluate`), whether this stage wrote anything or the
subject's protocol was already reusable.

**Degraded behaviour:** a `revise` trigger that fires against a plugin with almost no OBSERVE
evidence still gets a protocol — one whose measures may qualify no higher than `unqualified` for
now. Write it honestly; do not wait for more evidence before defining what good means, and do
not claim a qualification level the evidence does not support.
