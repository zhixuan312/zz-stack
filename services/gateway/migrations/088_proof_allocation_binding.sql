-- Candidate/proof review fixes (FR-28, FR-40, FR-59): three facts the proof and validation
-- ledgers could not hold.
--
-- case_set_id on zz.replay_verifier_token: a verifier_token used to name only its candidate, so
-- whoever held it could replay or read ANY proof-split run with it — another candidate's, another
-- case set's. candidate_prove now binds the token to the one case set its allocation opened, and
-- replay_start/replay_read (replay-verifier.ts) refuse a token whose binding does not match the
-- run it is used on. Nullable: a token minted before this migration carries no binding and is
-- refused outright by that same check, which is the correct answer for an unbound credential.
--
-- released_subject_version_id: release_verify mints into the same table, and its "candidate"
-- side runs as the RELEASED subject (a subject_version_id), not as candidate_id. Null for a
-- candidate_prove token.
alter table zz.replay_verifier_token
    add column case_set_id uuid null references zz.replay_case_set(id),
    add column released_subject_version_id uuid null references zz.eval_subject_version(id);

-- proof_spent_*: FR-28's "a spent allocation refuses a second opening" was enforced per
-- candidate, so a fresh improvement_run over the SAME eval_run could open the same sealed proof
-- cases again with a new candidate. The spend is now recorded on the case set itself, claimed by
-- candidate_prove's opening transaction with a compare-and-set; a second opening needs new
-- evidence (a new case set), never a new candidate.
alter table zz.replay_case_set
    add column proof_spent_at timestamp with time zone null,
    add column proof_spent_by_candidate_id uuid null references zz.candidate(id);

-- One stored validation verdict per candidate (candidate_validate reads "the" validation row
-- back on every later call). Two concurrent calls used to be able to insert two, because the
-- validating lock was dropped mid-call; the database now refuses the second. Any duplicates that
-- race already left are removed first, keeping the newest — the row every reader already took
-- ("order by created_at desc limit 1"), so no verdict anyone has read changes. Nothing references
-- zz.candidate_evaluation by foreign key.
delete from zz.candidate_evaluation ce
 where ce.split = 'validation'
   and exists (
     select 1 from zz.candidate_evaluation newer
      where newer.candidate_id = ce.candidate_id and newer.split = 'validation'
        and (newer.created_at, newer.id) > (ce.created_at, ce.id)
   );

create unique index candidate_evaluation_one_validation
    on zz.candidate_evaluation (candidate_id) where split = 'validation';
