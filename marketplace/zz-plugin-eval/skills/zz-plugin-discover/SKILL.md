---
name: zz-plugin-discover
version: 0.2
description: Stage 3 of zz-plugin-eval (DISCOVER). Mine one OBSERVE snapshot's own real refusals and stage returns for candidate failure modes, before any protocol exists — so DEFINE/QUALIFY freezes questions worth asking, not questions invented from nothing.
when_to_use: "The third stage of zz-plugin-eval, after OBSERVE has written an observation_snapshot_id. Always run before DEFINE/QUALIFY on a subject whose protocol is being created or revised — reuse skips it. No shell required."
---

# zz-plugin-discover

One call, over one snapshot:

```
failure_discover(observation_snapshot_id, idempotency_key, initiative)
```

`observation_snapshot_id` is `initiative_status`'s `records["zz-plugin-observe"]` in a new
conversation. Pass `initiative`: it records that DISCOVER ran, which is what moves
`initiative_status`'s `next_move` on to DEFINE/QUALIFY. Run it once per snapshot — a second call
under a new key mints a second, duplicate candidate set.

**Why this runs before a protocol exists, not after.** A protocol's `failureTaxonomy` is
supposed to name the ways this plugin actually goes wrong. Writing it from imagination, then
scoring against it, produces a ruler that measures nothing this plugin has ever really done.
DISCOVER settles the taxonomy's raw material first, from evidence, so DEFINE/QUALIFY has
something real to accept, merge or leave uncited.

## What it does, mechanically

Groups refusals — by failing tool and normalised text — and stage-return patterns
deterministically (code, no model). Classifies each group's ownership through the registered
`discover.owner_kind` evaluator, a bounded choice over `plugin | dependency | platform |
environment | user_input | unknown`. Only for a refusal group with **no recorded text at all**
does it propose a description with one generative-critic call, and that call's own provenance is
recorded alongside the candidate it produced.

RETURNS `candidates: [{ id, stable_key, description, prevalence: {numerator, denominator},
owner_kind, confidence, evidence_refs }]` — every one persisted as a
`zz.eval_failure_mode_candidate` row, `status: 'candidate'`, before any protocol exists. A
mutator: writes through the FR-59 idempotency ledger, so a retried call with the same
`idempotency_key` replays the exact same candidate set rather than re-asking any model.

**Never drops a candidate for a model outage.** A group the classifier cannot reach is stored
with `owner_kind: unknown` and the outage reason folded into its own `evidence_refs` — DISCOVER
reports what it found even when the model that would explain it is unavailable.

## Read prevalence before you read the description

`prevalence: {numerator, denominator}` says how much of this plugin's own evidence this pattern
actually accounts for — a candidate seen once in 500 events and a candidate seen 60 times in 80
are not the same finding, whatever their prose reads like. Say the fraction out loud alongside
each candidate you carry forward.

## What happens to a candidate next

Nothing here decides. A candidate sits at `status: 'candidate'` until DEFINE/QUALIFY's own
`protocol_record` folds one in — naming it in a `failureTaxonomy` entry's `candidateId` accepts
it, `mergedCandidateIds` folds others into the same entry — which is a decision the NEXT stage
makes, not this one. `protocol_read`'s own `new_recurring_failure` trigger is exactly "a
candidate still sits at `status: candidate`" for this plugin, so leaving one uncited is itself a
choice with a consequence: the next `protocol_read` opens a revision over it.

## Pitfalls

❌ **Running DISCOVER on a snapshot you have not read.** OBSERVE's own coverage figures say how
much evidence this mining actually had to work with — carry that context forward, or a thin
candidate set reads as a clean bill of health it is not.

❌ **Treating a low-prevalence candidate as equivalent to a high one.** The count is in the
response; say it.

❌ **Deciding a candidate is real or spurious here.** That judgement belongs to DEFINE/QUALIFY,
against the plugin's own protocol — this stage classifies ownership and groups evidence, and
stops there.

❌ **Skipping DISCOVER because OBSERVE's window was thin.** A thin window still has whatever
refusals or stage returns it has; run this before deciding there is nothing to mine.

## Skill contract

**Outcome:** every distinct refusal/stage-return pattern this snapshot's evidence actually
contains, grouped, ownership-classified and prevalence-counted, as `zz.eval_failure_mode_candidate`
rows DEFINE/QUALIFY can accept, merge or leave uncited.

**Required evidence:** `failure_discover`'s own response — `candidates`, each with its
`prevalence` and `owner_kind`. A candidate you narrate without its own prevalence fraction is a
description with no evidence behind it in the reader's eyes.

**Allowed unknowns:** whether a candidate belongs in the protocol's own `failureTaxonomy` — that
is DEFINE/QUALIFY's call, made against the plugin's own purpose, not this stage's.

**Action and exit paths:** the action is call `failure_discover` once per observation snapshot
and read `candidates` back with their prevalence. The exit is DEFINE/QUALIFY
(`zz-plugin-define-qualify`), always — this stage never decides on its own whether a protocol
needs creating or revising; `protocol_read` there is what asks.

**Degraded behaviour:** a snapshot with zero refusals and zero notable stage-return patterns
still returns a (possibly empty) `candidates` list — a plugin running cleanly in this window is
a real, reportable outcome, not a discovery failure.
