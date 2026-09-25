-- Task I-24 (FR-50, AC-50.1): release_verify's own rollback path marks the candidate whose
-- release was rolled back, and 077's own candidate_status_check gave it no value to land on —
-- 'released' would then read as "still the live release" for a candidate the platform has
-- already restored the prior version over. Additive: adds a value to an existing check
-- constraint, drops nothing historical, mirrors migration 081's own precedent for the same
-- reason (candidate.status needing a value 077 did not anticipate).

alter table zz.candidate
    drop constraint candidate_status_check,
    add constraint candidate_status_check check (status in
        ('recorded', 'rejected_precheck', 'validating', 'valid', 'invalid', 'selected',
         'proving', 'proof_passed', 'proof_failed', 'proof_not_established', 'stale', 'released',
         'rolled_back'));

comment on column zz.candidate.status is
  'rolled_back (migration 084): release_record set the same candidate''s own release_attempt to '
  'rolled_back after packages/tools/src/release/rollback.ts restored the prior released version — '
  'set alongside it, in the same recordRelease transaction, never on its own.';
