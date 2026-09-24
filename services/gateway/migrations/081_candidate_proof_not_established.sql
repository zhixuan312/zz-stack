-- Fix dispatch on initiative 2026-09-24-plugin-eval-next-version, closing three defects left by
-- Task I-21 (sealed proof): a not_established proof result (candidate_prove's own
-- insufficient_proof_cases/proof_unresolved reasons, and now abandon) was stored as
-- candidate.status = proof_failed, because 077's own check constraint gave it no third value —
-- candidate-prove.ts's own module note named this gap explicitly. That status is also what
-- REJECTED_CANDIDATE_STATUSES (proposer-bundle.ts) reads to bar a hypothesis from ever being
-- proposed again, so an unestablished proof (an evidence gap, not a rejected idea) was barred
-- exactly as a genuinely rejected one is — FR-38's own regularization applied to the wrong thing.
-- Additive: adds a value to an existing check constraint, drops nothing historical.

alter table zz.candidate
    drop constraint candidate_status_check,
    add constraint candidate_status_check check (status in
        ('recorded', 'rejected_precheck', 'validating', 'valid', 'invalid', 'selected',
         'proving', 'proof_passed', 'proof_failed', 'proof_not_established', 'stale', 'released'));
