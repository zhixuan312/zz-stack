---
name: zz-plugin-evaluate
version: 0.6
description: Stage 5 of zz-plugin-eval (EVALUATE). Bind an approved protocol version to a subject's own observation snapshot, route every measure the protocol names to the real evidence it judges, and reduce the result to one deterministic overall score with its status, coverage and guardrails. No recommendation — that is EXPLAIN.
when_to_use: "The fifth stage of zz-plugin-eval, once a protocol version is affirmed (or was already reusable). Produces no document — its output is durable score data EXPLAIN reads. No shell required."
---

# zz-plugin-evaluate

```
evaluation_start(subject_version_id, protocol_version_id, observation_snapshot_id, idempotency_key)
evaluation_assess(eval_run_id, subject_refs[], idempotency_key)
evaluation_score(eval_run_id, idempotency_key, initiative)
```

In a new conversation, `subject_version_id` and `observation_snapshot_id` are
`initiative_status`'s `records["zz-plugin-observe"]` — the snapshot OBSERVE recorded, never a
fresh `plugin_profile` — and `protocol_version_id` is `protocol_read(subject_version_id)`'s. Pass
`initiative` to `evaluation_score`: it records `eval_run_id` as this stage's record, which is how
EXPLAIN finds the run.

Three calls, in this order, once each per evaluation. `evaluation_start` atomically binds a
protocol version and an observation snapshot into one immutable `zz.eval_evidence_snapshot`, and
opens one `zz.eval_run` at `run_status: 'pending'` against it. RETURNS `{ eval_run_id,
evidence_snapshot_id, run_status }`. REFUSES an observation snapshot belonging to a DIFFERENT
subject than `subject_version_id` names — never silently scoring one plugin's evidence against
another's identity — and a protocol version `protocol_affirm` has not bound to an approved
`protocol.md` (named, with its version): go back to DEFINE/QUALIFY and finish the approval.

This score is also the baseline a released improvement is judged against: PROMOTE/VERIFY
evaluates the released subject's own real runs under the same protocol version, the same way,
and compares the two numbers.

## `subject_refs` — what the measures actually read

`evaluation_assess` resolves every entry in `subject_refs` to real content, and each ref has a
kind:

| ref | kind |
|---|---|
| `<initiative>/<doc>.md`, read off your own team's artifact store | document |
| `_knowledge/nodes/<node>.md` | knowledge |
| `bug:<id>`, from its bug report | bug |
| a bare `run_id` — from OBSERVE's `traces.run_refs` | run |

**REFUSES BY NAME any ref that resolves to nothing** — a model is never silently handed a
templated sentence naming the ref instead of the thing it names. A ref is never a tool name: the
protocol's own `observableSurfaces` names the tools whose output matters, so pick the documents,
runs and reports those tools produced — the ones worth judging, not an arbitrary sample. **Give
refs of every kind the protocol's measures judge**: a measure is asked only about refs of its
own kind (`definition.subjectKind`, else the "Read this run / document / bug report / record"
its evaluator's question opens with), so a protocol with a run measure and no run ref leaves
that measure excluded, by name.

`deterministic`/`outcome` measures read a named fact off the run's own bound observation
snapshot, ONCE per run — never the resolved text, never once per ref. `bounded_semantic`/
`generative_critic` measures ask the measure's own evaluator about each ref of their kind,
recording an `assessment_id` you can trace back to the underlying `zz.assessment` row — **but
only when that evaluator is qualified against this protocol version.** An unqualified one is not
asked at all: one row records the exclusion by name, and no model call is spent on an answer
that could not count. `human` measures are recorded as excluded — nothing here ingests one yet.

RETURNS `{ eval_run_id, assessment_count, measures_assessed, model_calls, excluded }` —
`excluded` names every measure that was not scored and why. Call it again with more
`subject_refs` to widen coverage before scoring — every call adds assessments, it never resets
what is already there, and never re-reads a fact already read for this run.

## `evaluation_score` — the one number, deterministically

Reduces every stored assessment, calls the pure `scoreRun` once for the run's own numbers and
once per subject_ref for a percentile bootstrap interval. RETURNS `{ overall_score, score_status,
score_coverage, coverage_floor, score_interval, dimension_scores, guardrail_status, coverage,
readings }` and stores the score on `zz.eval_run`, moving `run_status` to `'completed'`.
`readings` is every stored answer, per measure, per ref, with its `assessment_id` — what EXPLAIN
cites a finding by.

A dimension scores from whichever of its measures were scored, re-weighted among them, and
reports its own `coverage` — the scored share of its declared measure weight. One excluded
measure never empties its dimension, and `overall_score` is null only when nothing scored at all.
`score_coverage` is the same share over the whole protocol.

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
- Both must be true, and every required measure scored, for `score_status: established`.
- Short of that, `provisional` needs `score_coverage` at or above `coverage_floor`; under it the
  number is still reported, as `not_established` — a reading of a much smaller protocol.

`guardrail_status` never disappears inside the average: a critical guardrail's own numeric value
is still visible for diagnosis, and a released improvement whose own evaluation fails one is
rolled back (PROMOTE/VERIFY).

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

**Required evidence:** `evaluation_start`'s `eval_run_id`. `evaluation_assess`'s own
`assessment_count`/`measures_assessed`, for every `subject_ref` actually judged. `evaluation_score`'s
full response, read and carried forward verbatim — never a number re-derived by hand from the
dimension detail.

**Allowed unknowns:** whether this run's evidence is enough to establish a score — `score_status`
answers that from the protocol's own thresholds, not from your own read of how it feels.

**Action and exit paths:** the action is `evaluation_start`, then `evaluation_assess` against
every subject_ref worth judging, then `evaluation_score`. The exit is EXPLAIN
(`zz-plugin-explain`), always, whatever `score_status` came back.

**Degraded behaviour:** a run whose only affordable evidence is thin still scores — `provisional`
or `not_established`, honestly labelled, with `coverage` naming exactly what was short. Never
invent a subject_ref or a measure result to push a number toward `established`.
