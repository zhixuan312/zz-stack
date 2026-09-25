---
name: zz-plugin-evaluate
version: 0.3
description: Stage 5 of zz-plugin-eval (EVALUATE). Bind an approved protocol version to a subject's own observation snapshot, run every measure the protocol names against real evidence, and reduce the result to one deterministic overall score with its status, coverage and guardrails. No recommendation — that is EXPLAIN.
when_to_use: "The fifth stage of zz-plugin-eval, once a protocol version is affirmed (or was already reusable). Produces no document — its output is durable score data EXPLAIN reads. No shell required."
---

# zz-plugin-evaluate

```
replay_case_set_build(subject_version_id, protocol_version_id, source_scope: {initiatives: [...]} | {flow, closed_between: [from, to]}, idempotency_key)
evaluation_start(subject_version_id, protocol_version_id, observation_snapshot_id, case_set_version_id?, idempotency_key)
evaluation_assess(eval_run_id, subject_refs[], idempotency_key)
evaluation_score(eval_run_id, idempotency_key)
```

Four calls, in this order, once each per evaluation. `evaluation_start` atomically binds a
protocol version and an observation snapshot (and a `case_set_version_id`) into one immutable
`zz.eval_evidence_snapshot`, and opens one `zz.eval_run` at `run_status: 'pending'` against it.
RETURNS `{ eval_run_id, evidence_snapshot_id, run_status }`. REFUSES an observation snapshot
belonging to a DIFFERENT subject than `subject_version_id` names — never silently scoring one
plugin's evidence against another's identity — and, like `replay_case_set_build`, a protocol
version `protocol_affirm` has not bound to an approved `protocol.md` (named, with its version):
go back to DEFINE/QUALIFY and finish the approval.

## The case set — built before `evaluation_start`, bound by it

`case_set_version_id` is the `case_set_id` `replay_case_set_build` returned. The binding happens
here and nowhere else: IMPROVE validates and proves every candidate against the case set THIS
eval_run bound, and `candidate_validate` refuses a run that bound none. So build it first
whenever the plugin has closed initiatives to replay, even though nothing in this stage replays
anything — an eval_run started without one can score, but can never carry a search.

`replay_case_set_build` derives FR-60's chronological cases from real closed initiatives —
classifying each source person_statement/`agent_record`, building actor/`user_oracle`/
evaluation_oracle timelines, splitting every replayable case `evolve`/`validation`/`proof` by
`sha256(seed, case_digest)`. RETURNS `{ case_set_id, version, counts: {evolve, validation, proof,
not_replayable}, minimums_met, source_kind_qualification }`. FR-57's bootstrap minimums are 5
evolve, 10 validation, 10 proof — below a minimum, search may still run, but `candidate_prove`
will record `not_established, reason: insufficient_proof_cases` and the candidate is not
release-eligible. Unchanged source material reuses the existing case set rather than minting a
redundant one. Omit `case_set_version_id` only when there is no closed initiative to build from,
and say so: no candidate for this run's findings can then be validated or proved, and IMPROVE
sends a run that needs a search back here for a new one.

## `subject_refs` — what the measures actually read

`evaluation_assess` resolves every entry in `subject_refs` to real content — an
`<initiative>/<doc>.md` path is read off your own team's artifact store, a bare `run_id` is
rendered from its own event rows — then runs every measure of every dimension in the run's
protocol against that resolved text. **REFUSES BY NAME any ref that resolves to neither a real
document nor a real run** — a model is never silently handed a templated sentence naming the ref
instead of the thing it names. A ref is a document path or a run id, never a tool name: the
protocol's own `observableSurfaces` names the tools whose output matters, so pick the documents
and runs those tools produced — the ones worth judging, not an arbitrary sample.

`deterministic`/`outcome` measures read a named fact off the run's own bound observation
snapshot, never the resolved text — the same fact OBSERVE computed. `bounded_semantic`/
`generative_critic` measures ask the measure's own qualified evaluator about the resolved text,
recording an `assessment_id` you can trace back to the underlying `zz.assessment` row.
`human` measures are recorded as excluded — nothing here ingests one yet.

RETURNS `{ eval_run_id, assessment_count, measures_assessed }`. Call it again with more
`subject_refs` to widen coverage before scoring — every call adds assessments, it never resets
what is already there.

## `evaluation_score` — the one number, deterministically

Reduces every stored assessment, calls the pure `scoreRun` once for the run's own numbers and
once per subject_ref for a percentile bootstrap interval. RETURNS `{ overall_score, score_status,
score_interval, dimension_scores, guardrail_status, coverage }` and stores the same on
`zz.eval_run`, moving `run_status` to `'completed'`.

**`overall_score = 10 x sum(dimension_weight x dimension_score)`** — code computes it; no model
prose ever supplies it directly. `score_status` is one of `established | provisional |
not_established`:

- `coverage_met` comes from the protocol's own `EstablishmentPolicy.minCoverage` —
  `minUsableRuns`/`minSubjectRefs` against what this run actually holds.
- `qualification_met` comes from every REQUIRED model-backed measure's evaluator qualification
  against `QualificationPolicy.boundedSemanticMinimum` — **a bootstrap protocol
  (`scoring.establishment.bootstrap: true`) forces `qualification_met: false` regardless of what
  any individual qualification row says.** FR-57's own reference protocol for `zz-core` is
  bootstrap: it must not publish an `established` score before the first real post-close OBSERVE/
  DISCOVER run.
- Both must be true, plus every required guardrail resolved, for `score_status: established`.

`guardrail_status` never disappears inside the average: a critical guardrail's own numeric value
is still visible for diagnosis, but release eligibility downstream is false unless every required
guardrail reads `pass`.

## Say the status before you say the number

`overall_score: 6.8, score_status: provisional` and `overall_score: 6.8, score_status:
established` are different findings, whatever the paragraph around them says. Always name the
status in the same breath as the number — never let a provisional figure read as settled.

## Pitfalls

❌ **Handing `evaluation_assess` a `subject_ref` you have not read.** It refuses one that resolves
to nothing, but it will not tell you the ref you picked was the wrong one to judge.

❌ **Calling `evaluation_score` before every measure you care about has an assessment.** It scores
from whatever is stored — a measure never assessed reads `excluded` in its own dimension, which
quietly reduces that dimension's coverage.

❌ **Reporting `overall_score` without `score_status`.** A provisional number read as established
is the exact failure the status field exists to prevent.

❌ **Re-running `evaluation_score` hoping for a different number.** It is pure over what is
stored — assess more evidence first if the coverage is what you want to change.

## Skill contract

**Outcome:** one completed `eval_run`, with a deterministic `overall_score` (or an honest
`score_status` short of one), `dimension_scores`, `guardrail_status` and `coverage` — the durable
record EXPLAIN turns into `findings.md`.

**Required evidence:** `replay_case_set_build`'s `case_set_id` and `counts` (or the stated reason
there was nothing to build from). `evaluation_start`'s `eval_run_id`. `evaluation_assess`'s own
`assessment_count`/`measures_assessed`, for every `subject_ref` actually judged. `evaluation_score`'s
full response, read and carried forward verbatim — never a number re-derived by hand from the
dimension detail.

**Allowed unknowns:** whether this run's evidence is enough to establish a score — `score_status`
answers that from the protocol's own thresholds, not from your own read of how it feels.

**Action and exit paths:** the action is `replay_case_set_build`, then `evaluation_start`
binding its case set, then `evaluation_assess` against
every subject_ref worth judging, then `evaluation_score`. The exit is EXPLAIN
(`zz-plugin-explain`), always, whatever `score_status` came back.

**Degraded behaviour:** a run whose only affordable evidence is thin still scores — `provisional`
or `not_established`, honestly labelled, with `coverage` naming exactly what was short. Never
invent a subject_ref or a measure result to push a number toward `established`.
