-- Task I-23 (FR-49, AC-49.1): release_apply's own refusal reason, and release_record's failure
-- tail, have nowhere to live without this column. Migration 077's zz.release_attempt records
-- STATUS (prepared/applying/released/refused/failed/rolled_back) but never WHY a refused or
-- failed attempt ended that way — and a replayed release_apply/release_record call (the FR-59
-- idempotency ledger in zz.eval_idempotency stores only result_table/result_id, never the tool's
-- own response body) has to reconstruct its answer by reading the row back, so the row itself has
-- to carry it. One column for both: releaseDecision's own refusal reason
-- (no_release_owners/not_eligible/approval_required/digest_mismatch/stale_baseline) and, later,
-- the gate/release command's own output tail on a stubbed or real release failure — both answer
-- the same question, "why did this attempt end this way," so a second column for the same purpose
-- would only invite the two to disagree about which one a reader checks. Additive only.
alter table zz.release_attempt add column reason text null;

comment on column zz.release_attempt.reason is
  'Why this attempt is refused or failed: releaseDecision''s own reason on a refusal, or the failing command''s output tail (release_record) on a failure. Null for prepared/applying/released.';
