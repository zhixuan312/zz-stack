-- Fix dispatch on initiative 2026-09-24-plugin-eval-next-version, Task I-22 (a defect left by
-- Task I-21): candidate_prove's own cancelProofRuns (candidate-prove.ts) matched a candidate's
-- baseline-side proof runs by base_subject_version_id alone, because zz.replay_run carried
-- nothing narrower for them (a candidate-side run already had candidate_id to match on). Two
-- candidates proving the SAME base subject against the SAME case set at the same time therefore
-- cancelled each other's still-registered baseline-side runs on abandon. Additive only.

-- Which proof allocation (a zz.replay_verifier_token row) authorised this replay_run, set by
-- replay_start from the verifier_token presented when context = 'verifier' — the same row
-- candidate_prove minted when it opened this allocation. Null for an ordinary search-context
-- run, which belongs to no allocation. Scopes cancelProofRuns to exactly the one allocation it
-- opened, on both the candidate side and the baseline side, instead of matching every run that
-- happens to share a base_subject_version_id or case set with it.
alter table zz.replay_run
    add column verifier_allocation_id uuid null references zz.replay_verifier_token(id);

comment on column zz.replay_run.verifier_allocation_id is
  'Set by replay_start when context = verifier, from the verifier_token presented. Null for a search-context run. candidate_prove''s cancelProofRuns filters on this column so two concurrent proof allocations against the same base subject never cancel each other''s runs.';
