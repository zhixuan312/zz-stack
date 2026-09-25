-- 002_remove_replay.sql — the replay mechanism is gone.
--
-- An improvement to a plugin is built and gated locally, released once its owners approve, and
-- judged on real use after release (release_verify): rolled back if it measures worse. Replaying
-- past initiatives to prove a candidate before release cost more tokens than it was worth, so
-- the case sets, replay runs, verifier tokens, the search's generations and the sealed proof all
-- go, with the tables and columns that held them. No production database ever held replay data.

-- Every assessment now belongs to an eval_run: a replay run was the only other owner.
ALTER TABLE zz.eval_assessment DROP CONSTRAINT eval_assessment_check;
ALTER TABLE zz.eval_assessment DROP COLUMN replay_run_id;
ALTER TABLE zz.eval_assessment ALTER COLUMN eval_run_id SET NOT NULL;

-- An evidence snapshot binds an observation to a protocol version, and nothing else.
ALTER TABLE zz.eval_evidence_snapshot DROP CONSTRAINT eval_evidence_snapshot_observation_snapshot_id_protocol_ver_key;
ALTER TABLE zz.eval_evidence_snapshot DROP COLUMN case_set_version_id;
ALTER TABLE zz.eval_evidence_snapshot
    ADD CONSTRAINT eval_evidence_snapshot_observation_protocol_key UNIQUE (observation_snapshot_id, protocol_version_id);

ALTER TABLE zz.eval_protocol_version DROP COLUMN replay_policy;

DROP TABLE zz.replay_run;
DROP TABLE zz.replay_verifier_token;
DROP TABLE zz.replay_event;
DROP TABLE zz.replay_case;
DROP TABLE zz.replay_case_set;
DROP TABLE zz.candidate_evaluation;

-- An improvement run is a set of findings and the candidates recorded against them; with no
-- search there is no policy snapshot and no search state to hold.
ALTER TABLE zz.improvement_run DROP COLUMN search_policy;
ALTER TABLE zz.improvement_run DROP COLUMN status;

-- A candidate is recorded, built and gated locally, then released or not. No generations, no
-- lineage, no validation hold.
ALTER TABLE zz.candidate DROP COLUMN generation;
ALTER TABLE zz.candidate DROP COLUMN parent_ids;
ALTER TABLE zz.candidate DROP COLUMN validating_since;
ALTER TABLE zz.candidate DROP CONSTRAINT candidate_status_check;
ALTER TABLE zz.candidate
    ADD CONSTRAINT candidate_status_check CHECK ((status = ANY (ARRAY['recorded'::text, 'awaiting_build'::text, 'valid'::text, 'invalid'::text, 'released'::text, 'rolled_back'::text])));

COMMENT ON COLUMN zz.candidate.build_result IS 'What npm run candidate-build recorded through candidate_build_record: {ok, stage, log_tail, commands, patch_digest}. Kept once candidate_validate consumes it, so improvement.md and the console can say how the released patch was built and gated.';

COMMENT ON COLUMN zz.release_attempt.verification IS 'release_verify''s decision, once it has one: {verdict (established | rolled_back | not_established), reason, evidence: {post_release_runs, released_eval_run_id, released_overall, base_eval_run_id, base_overall, delta, regression_band, guardrail_status}, rollback_plan}. Null until the released subject has enough real runs and an evaluation to judge.';
