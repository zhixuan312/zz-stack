-- Gives an EVALUATE-produced finding (Task I-13, FR-12, FR-18) somewhere to live. 077 extended
-- zz.eval_finding with owner_kind/owner_ref/measure_id/evidence_refs/expected_effect but kept
-- eval_id NOT NULL against zz.eval (the rubric-era round table) and named no column an
-- eval_run-bound finding could reference, and no `kind` distinguishing strength/defect/unknown
-- from a legacy finding's generic/specific `scope`. That gap is closed here, additively, the same
-- dual-lifecycle shape 077 itself used for zz.assessment (family XOR evaluator_version_id): a
-- finding belongs to exactly one lifetime, the legacy round (eval_id) or the new run
-- (eval_run_id), never both, and a new-lifetime finding always names its kind. Every existing
-- zz.eval_finding row (eval_id set, kind null) keeps satisfying every check unchanged, and
-- round_score's own join on eval_id is untouched — it simply never matches a new-lifetime row,
-- which carries no eval_id to join on.
alter table zz.eval_finding
    alter column eval_id drop not null,
    alter column scope drop not null,
    add column eval_run_id uuid null references zz.eval_run(id),
    add column kind text null check (kind in ('strength', 'defect', 'unknown')),
    add constraint eval_finding_round_xor_run_check
        check ((eval_id is not null) <> (eval_run_id is not null)),
    add constraint eval_finding_run_requires_kind_check
        check (eval_run_id is null or kind is not null);

comment on column zz.eval_finding.eval_run_id is
  'Set instead of eval_id for an EVALUATE-produced finding (finding_record). Exactly one of the two is non-null.';
comment on column zz.eval_finding.kind is
  'strength | defect | unknown — required when eval_run_id is set; null on every legacy round finding, which carries scope instead.';
