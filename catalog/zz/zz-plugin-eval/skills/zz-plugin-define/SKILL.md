---
name: zz-plugin-define
version: 2.3
description: Stage 3 of plugin evaluation, and the one gate that matters most. Derive what good means for THIS plugin from its own profile, write it into protocol.md, and get a person to agree it before anything is scored.
when_to_use: "The third stage of zz-plugin-eval, after profile. Produces protocol.md, which is gated — protocol_affirm refuses to bind it until somebody approves it."
---

# zz-plugin-define

```
protocol_read(subject_version_id)                       create, reuse or revise?
```

Then, unless `protocol_read` said `reuse`, you write `protocol.md` and call
`protocol_record(subject_version_id, protocol_body, idempotency_key)` — and **a person approves
`protocol.md` before `protocol_affirm` will bind it to anything.**

`protocol_read` decides nothing for you: `create` means this plugin has no protocol yet;
`reuse` means the newest version is still compatible and there is nothing to write; `revise`
names which trigger fired (`purpose_changed, new_recurring_failure, evaluator_drift,
new_evidence_surface`) and expects a new version, never an edit to the old one.

## Every plugin gets its own protocol

Not a shared rubric with a plugin name at the top. `sdlc` is a delivery method whose worth is
whether a stranger could execute what it produced; `zz-access` is a credential surface whose
worth is whether it refuses correctly. One scale over both would measure neither.

Which is also why **there is no comparing plugins here**. Two scores from two protocols are two
things measured with two instruments.

## The shape `protocol_record` validates

`protocol_body` is an `EvaluationProtocol` (`packages/contracts/src/eval-protocol.ts`) — a
larger object than the old ruler was, and `protocol_record` returns the zod issues verbatim on
anything that does not match it. At the top: `protocolKey` (a stable name for this lineage —
reuse the plugin's own name unless you have a reason not to), `version` (this protocol's next
number — `protocol_record` refuses anything else; there is no edit), `pluginPurpose` (what
`protocol_read`'s `purpose_changed` trigger compares against the catalog manifest's own
`purpose`), `observableSurfaces` (the tool names `new_evidence_surface` checks this plugin's
skills against), `failureTaxonomy` (see below), `dimensions`, and four policy blocks —
`suites`, `replay`, `qualification`, `scoring`, `improvement` — whose content this skill does
not prescribe. Read `EvaluationProtocol`'s own comments before guessing a shape for those; write
down whatever a later measurement stage will actually need to compute or ask.

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
  bounded question. These are the direct descendants of the old ruler's *qualitative*
  dimension, and they carry the same discipline this skill has always taught (below): the
  question has to be answerable from the text alone, and its `evaluator` field is **required** —
  `{ stable_key, kind, question, answer_schema, polarity, model_policy }`, the same shape
  `evaluators.ts`'s `registerEvaluator` takes. `protocol_record` refuses a `bounded_semantic`/
  `generative_critic` measure that carries none.
- **`deterministic` / `outcome`** — a tool computes a fact and the measure's `definition` says
  what counts as passing. These are the descendants of the old ruler's *quantitative*
  dimension. `definition`'s exact shape is not fixed by the contract — it is yours to write, and
  it is not checked against a facts sheet the way the old `reads` field was. Write it as
  precisely as you would have written a threshold: name the figure, name the line, name why.
- **`human`** — nothing here reads it automatically; it exists for a mark this platform does not
  yet compute any other way.

## THE JUDGE IS HANDED THE ARTIFACT'S TEXT, AND NOTHING ELSE

Before you write a `bounded_semantic`/`generative_critic` measure, name the artifact it will
read — a document's markdown, a run's transcript, both ends of an initiative — and then ask:
**is the answer IN that text?**

If the answer lives in a row, a count, a status or a timestamp, **the measure is
`deterministic`/`outcome`**, not semantic — a semantic measure asked a question the text cannot
answer measures something other than its own name, and its noise spreads into every other
measure in the same dimension.

## STATE THE ARITHMETIC, DO NOT MAKE THE JUDGE DO IT

Whatever asks a typed judgement service a bounded question — a `bounded_semantic` measure's
`evaluator.question`, or a `scoring`/`qualification` policy that does — give it a comparison it
can make directly.

❌ `at most one third of the tools this plugin's skills name appear in never_called, counted
over every call recorded on its own door, across all versions`
✅ `the count of never_called is at most a third of tools_named_count`

Both describe the same line. The vague form comes back with a low confidence — the service
reporting that it is not sure, because clearing it means working a fraction of a count out of a
sentence. **A vague threshold reports its own vagueness**, which is useful, and is not what you
want a round to spend its certainty on. Name the two fields the comparison is between, and let
the tool that computes the figure supply both numbers — never write either one into the measure
itself, or the protocol is wrong the moment the next release changes it.

## IF THE PROPERTY IS ONLY TRUE AFTER THE ROUND, ENFORCE IT — DO NOT MEASURE IT

Some lines cannot be measures no matter what figure you add, and the tell is the timing.

zz-plugin-eval's own history carries the worked example: *"every non-control round recorded
against this plugin version has a control round naming it"* — a fair line, drawn deliberately
against the flow's own central claim. It could never be met, because the control is recorded
**after** the real round, so at the instant a threshold on it would be applied, the fact it
needs does not exist yet. Computing a figure would not have helped.

The answer was not a better threshold. It was `round_score` refusing a round no control names.
**A rule enforced at the door needs no measure at all — it is true by construction, and the
protocol is shorter.** Before writing a measure, ask whether the thing you want is a
measurement or a rule. If a round could violate it and still finish, it is a measurement. If it
should be impossible, it belongs in the tool.

## The line is written before any artifact is scored

That ordering is the only guard against a protocol written to flatter the number it will
produce. Write the measure, get the document agreed, then judge. Never look at the scores and
then decide where the line should have been.

## Recovery is the worked example — use it

`returns: 3` is the fact. Whether three returns is a flow that re-grounds well or one that
thrashes is not in the data, and the same count means both — the initiative that designed this
flow returned three times, each time because an audit found a real defect and the spec went
back and got better; a different plugin returning three times because it could not settle on an
approach is the method failing. **Same number.** So a `recovery_robustness` measure has to say
which it means: `returns ≥ 1 AND every return followed an audit finding`, not `returns ≥ 1`
alone — a floor, not a ceiling, which is exactly the kind of judgement no tool could have made.

## Folding DISCOVER's candidates in

`failure_discover` writes `zz.eval_failure_mode_candidate` rows, `status = 'candidate'`, before
any protocol exists. `protocol_record` is the only thing that ever moves one on, through
`failureTaxonomy`: an entry that is an object (not a bare string) may carry `candidateId` — the
one candidate this entry was written from, moved to `accepted` — and `mergedCandidateIds`, other
candidates folded into the same entry, moved to `merged` and pointed at the accepted one. A
`candidateId`/`mergedCandidateIds` naming a candidate from a DIFFERENT plugin's evidence is
refused. `protocol_read`'s `new_recurring_failure` trigger is exactly "a candidate still sits at
`status = 'candidate'`" — so folding one in, or explicitly leaving it uncited, is what clears
that trigger for the next `protocol_read`.

## Recording it, then writing it

The protocol has to exist in two places and they are not the same act.

```
protocol_record(subject_version_id, protocol_body, idempotency_key)
```

writes a new, immutable `zz.eval_protocol_version` and RETURNS `{ protocol_version_id,
content_digest }`. It never edits a version in place — a body naming any version but this
protocol's next one is refused.

**Record before the person reads it, approve after.** Recording is not approving — nothing is
scored until `protocol_affirm` binds a person's approval of `protocol.md` to this exact version.

## Writing it

`document_write` into the initiative as `protocol.md`, with the three sections the manifest
declares, spelled exactly:

- `## The plugin under evaluation` — name and version and digest, from locate.
- `## What good means here` — the dimensions and measures, in prose a person can actually agree
  or disagree with.
- `## The evidence each dimension reads` — which computed figure or which artifact, per measure.

**Quote `content_digest` — the exact string `protocol_record` returned — somewhere in the
document's body.** `protocol_affirm` refuses to bind an approval that does not carry it: a
document approved for a version protocol.md was revised past it is not approved for the version
you are trying to affirm, and the digest is the one fact that ties the two together.

Then `document_present` it and put what comes back in front of the person. They are approving
this document, not your account of it. Record their agreement with `document_approve` the
moment it arrives, under their name, in the same turn — `zz-platform` carries that rule and it
holds here. Then call:

```
protocol_affirm(protocol_version_id, initiative, idempotency_key)
```

`initiative` is required because a bare `protocol_version_id` names no path on its own —
`protocol.md` lives at `<initiative>/protocol.md` in your team's store, and this is the
initiative you wrote it into.

## Qualifying the evaluators, before anything is scored

Every `bounded_semantic`/`generative_critic` measure's `evaluator` is only as good as its own
qualification. Once `protocol_affirm` has bound the approval, qualify each one:

```
evaluator_qualify(protocol_version_id, evaluator_version_id, idempotency_key)
```

`evaluator_version_id` is the one `registerEvaluator` (inside `protocol_record`) minted for that
measure's own `evaluator.stable_key` — read it back off `zz.eval_evaluator_version` if you did
not keep it from recording. RETURNS `{ qualification_id, state, evidence }` — `state` is one of
`unqualified`, `mechanically_qualified`, `operationally_qualified` or `human_calibrated`. A new
evaluator version always starts `unqualified`; `unqualified` with `evidence.reason ===
"no_anchors"` means this measure's own `definition.qualification` names no `{ positive, zero }`
vocabulary yet, or the plugin has no OBSERVE snapshot to derive an anchor from — not a call
failure, and not this tool's fault to fix.

`replay_case_set_build` (a later stage) requires `qualification.boundedSemanticMinimum` to be
met before it will admit a measure's evaluator into a case set — qualify every `bounded_semantic`/
`generative_critic` evaluator this protocol version names before handing it off, not only the
ones you expect to be asked about.

Once a case set exists, `replay_start(case_set_id, subject_version_id, candidate_id, split,
case_id, repeats, idempotency_key)` provisions one isolated run against one of its cases —
`case_id` steers the draw to one exact case, omit it to take the default lowest-id one — reading
this protocol version's own `replay.dependencies` back as `dependency_modes`.
`replay_read(replay_run_id)` reads a run back, `replay_score(replay_run_id, idempotency_key)`
scores a finished one, and `replay_close(replay_run_id, status, result, idempotency_key)` tears
it down. None of that is this stage's job; it is named here only so a `replayMode` you write into
`dependencies` above is understood against the tool that reads it.

## Pitfalls

❌ **A measure with no stated reason for its line.** It is a number nobody can defend later.

❌ **Deciding the line after seeing the scores.** That is the failure this gate exists for.

❌ **Reusing another plugin's protocol because it looks similar.**

❌ **A measure that does not say which evidence it reads.**

❌ **Calling `protocol_affirm` before `document_approve`, or before quoting `content_digest` in
the body.** It will refuse, and it is right to.

❌ **Recording a body whose `dimensions` weights do not sum to 1 over the applicable ones, or
whose `measures` weights do not sum to 1 within a dimension.** `EvaluationProtocol`'s own schema
refuses it — the zod issue names which.
