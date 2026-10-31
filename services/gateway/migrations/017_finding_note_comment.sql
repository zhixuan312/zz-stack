-- 017_finding_note_comment.sql — zz.eval_finding.decision_note says what a rollback writes there.
--
-- A rollback reopens each finding its release applied: decision goes back to deferred, decided_by and
-- decided_at are cleared, and decision_note records which release was undone
-- (services/zz-core/src/eval/release-record.ts). The column's comment still said the note "is empty
-- while deferred", which a reader of a reopened finding would find false. Only the comment moves; no
-- row does, so scripts/rehearse/expect.ts carries no entry for this file.

COMMENT ON COLUMN zz.eval_finding.decision_note IS 'class=state_machine; authority=this; question=why was it applied or rejected — for the 21 applied rows this prose is the only record of which release carried the fix — and, on a finding a rollback reopened, which release it undid, since the rollback clears decided_by and decided_at; empty while a finding has never been decided?';
