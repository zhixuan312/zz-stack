-- Fix dispatch on initiative 2026-09-24-plugin-eval-next-version, task I-29's own follow-on: two
-- seams found after the bootstrap reference protocol landed.
--
-- Seam 1: OBSERVE (Task I-7, observe.ts) computes about eighteen facts per subject/window but the
-- snapshot row it wrote stored only their digest, never the facts themselves — so a deterministic/
-- outcome measure could read only the two facts a caller happened to also pass as raw columns
-- (usable_run_count/total_run_count, coverage.surface). `facts` carries the full computed map
-- (evaluate-measures.ts's own `deterministicAnswer` reads it by dotted path); nullable because
-- this column did not exist before this migration and there is no backfill for a snapshot already
-- written — an old row reads `facts is null` and every deterministic/outcome measure against it
-- answers excluded with a named reason, never a guessed value.
alter table zz.eval_observation_snapshot
    add column facts jsonb null;

comment on column zz.eval_observation_snapshot.facts is
  'Every ObservedFact computeObservation wrote for this snapshot (observe-facts.ts''s OBSERVATION_FACT_KEYS), keyed by fact name. Null on a snapshot recorded before this column existed. A deterministic/outcome measure reads one entry by dotted definition.factPath.';

-- Seam 2: evaluation_score/replay_score used to read a bare per-measure definition.guardrail
-- boolean (an implicit 0.5 threshold) instead of the protocol's own improvement.criticalGuardrails
-- — the ONLY guardrail mechanism now that the per-measure flag is removed. `guardrails` mirrors
-- zz.replay_run.guardrails: the rich [{key, threshold, value, status}] evaluateGuardrails() wrote,
-- kept beside the existing scalar guardrail_status for diagnosis (FR-23's "numeric score for
-- diagnosis" — which guardrail, what value, against what threshold).
alter table zz.eval_run
    add column guardrails jsonb null;

comment on column zz.eval_run.guardrails is
  'evaluateGuardrails() output for this run''s protocol.improvement.criticalGuardrails: [{key, threshold, value, status}]. guardrail_status is the reduced pass/fail/not_established this column explains.';
