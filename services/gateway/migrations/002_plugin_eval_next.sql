-- Extends the platform schema for zz-plugin-eval's protocol-driven evaluation, replay and
-- improvement-search architecture (spec v8, initiative 2026-09-24-plugin-eval-next-version).
-- Adds: the subject, protocol, evaluator, dimension/measure and qualification tables (IDENTIFY,
-- DEFINE, QUALIFY); observation snapshots and failure-mode candidates (OBSERVE, DISCOVER); replay
-- case sets, cases, events, runs and verifier tokens (REPLAY); evidence snapshots, eval runs and
-- measurement-time assessments (EVALUATE); improvement runs, candidates and their evaluations
-- (IMPROVE); release attempts (PROMOTE/VERIFY); the shared mutation ledger (FR-59); and the
-- console's mirror of <initiative>/_facts.json (FR-58).
--
-- Pre-existing tables are only extended: zz.plugin gains ownership columns, zz.assessment (001)
-- an evaluator-backed identity alongside its platform-checkpoint one, and zz.eval_finding (001)
-- ownership, evidence and an eval_run-bound lifetime. Every existing zz.rubric*, zz.eval,
-- zz.eval_score, zz.eval_finding and zz.assessment row stays selectable unchanged.
--
-- Table order below is dependency order (a foreign key only ever points at a table already
-- created above it), not the order spec v8's "Data model" section lists them in. The one cycle —
-- zz.replay_case_set's proof-split holder is a zz.candidate, which descends from a case set
-- through eval_run — is closed by a separate foreign key once zz.candidate exists.

-- Ownership for release authority (FR-2, FR-47). Written by plugin_register (catalog rows) and
-- the catalog seeding path; read by release_prepare to resolve required approvers and by the
-- dashboard's ownership mode. origin stays platform | third_party and is no longer the sole
-- authority check.
alter table zz.plugin
    add column owner_team text null,
    add column evolvable boolean not null default false,
    add column release_owners jsonb not null default '[]'::jsonb;

-- One immutable subject identity per (plugin, declared version, content digest) — FR-1. Written
-- once by IDENTIFY (plugin_register / plugin_profile) when a new digest is seen; read by every
-- later stage that binds evidence, a run, a replay case or a release to an exact subject.
create table zz.eval_subject_version (
    id uuid primary key default gen_random_uuid(),
    plugin_id uuid not null references zz.plugin(id),
    declared_version text not null,
    content_digest text not null,
    component_manifest jsonb not null,
    source_locator jsonb not null,
    release_identity jsonb not null,
    captured_at timestamp with time zone not null,
    unique (plugin_id, declared_version, content_digest)
);

-- One row per plugin per protocol lineage (FR-4). Written by protocol_record the first time a
-- protocol is created for a plugin; read to resolve protocol_action = reuse | create | revise —
-- the durable measurement object a new version belongs to.
create table zz.eval_protocol (
    id uuid primary key default gen_random_uuid(),
    plugin_id uuid not null references zz.plugin(id),
    protocol_key text not null,
    unique (plugin_id, protocol_key)
);

-- The frozen protocol content itself (FR-6). Written by protocol_record/protocol_affirm; read by
-- every EVALUATE, IMPROVE and PROMOTE/VERIFY call that needs the exact measures, suites, replay
-- and scoring policy a run was judged against.
create table zz.eval_protocol_version (
    id uuid primary key default gen_random_uuid(),
    protocol_id uuid not null references zz.eval_protocol(id),
    version int not null,
    subject_compatibility jsonb not null,
    purpose text not null,
    observable_surfaces jsonb not null,
    failure_taxonomy jsonb not null,
    suites jsonb not null,
    replay_policy jsonb not null,
    qualification_policy jsonb not null,
    scoring_policy jsonb not null,
    improvement_policy jsonb not null,
    content_digest text not null,
    approved_document_path text null,
    created_at timestamp with time zone not null,
    unique (protocol_id, version)
);

-- The stable identity of one semantic question family used by plugin-eval (FR-13). Written once
-- when an evaluator is first defined; read by eval_evaluator_version to anchor its versions.
create table zz.eval_evaluator (
    id uuid primary key default gen_random_uuid(),
    stable_key text unique not null,
    kind text not null
);

-- One frozen question/answer-schema/polarity/model-policy per evaluator version (FR-13, FR-15).
-- Written by evaluator definition inside DEFINE/QUALIFY; read by eval_measure,
-- semantic.ts's recordEvaluatorAssessment() and zz.assessment.evaluator_version_id.
create table zz.eval_evaluator_version (
    id uuid primary key default gen_random_uuid(),
    evaluator_id uuid not null references zz.eval_evaluator(id),
    version int not null,
    question text not null,
    answer_schema jsonb not null,
    polarity jsonb not null,
    model_policy jsonb not null,
    content_digest text not null,
    unique (evaluator_id, version)
);

-- One canonical scoring dimension inside a protocol version (FR-19, FR-20). Written when the
-- protocol version is recorded; read by scoring code aggregating eval_run.dimension_scores.
create table zz.eval_dimension (
    id uuid primary key default gen_random_uuid(),
    protocol_version_id uuid not null references zz.eval_protocol_version(id),
    key text not null,
    name text not null,
    canonical_kind text not null check (canonical_kind in
        ('effectiveness', 'reliability', 'constraint_adherence', 'recovery_robustness', 'efficiency', 'generalization')),
    weight numeric not null,
    required boolean not null,
    applicable boolean not null default true,
    not_applicable_reason text null,
    check ((applicable and not_applicable_reason is null) or (not applicable and not_applicable_reason is not null))
);

-- One normalized, weighted measure inside a dimension (FR-20). Written with the protocol version;
-- read by scoring code and by recordEvaluatorAssessment() to find the evaluator a measure defers
-- to.
create table zz.eval_measure (
    id uuid primary key default gen_random_uuid(),
    dimension_id uuid not null references zz.eval_dimension(id),
    key text not null,
    evaluator_type text not null check (evaluator_type in
        ('deterministic', 'outcome', 'bounded_semantic', 'generative_critic', 'human')),
    weight numeric not null,
    suite text not null check (suite in ('capability', 'regression', 'production')),
    required boolean not null,
    definition jsonb not null,
    evaluator_version_id uuid null references zz.eval_evaluator_version(id),
    -- A bounded_semantic/generative_critic measure must name the evaluator version it defers to.
    -- The reverse — a deterministic/outcome measure carrying one anyway — is legal when the
    -- protocol explicitly declares a model-backed implementation, so only the strict half is a
    -- CHECK; the rest is protocol-record's job.
    check (evaluator_type not in ('bounded_semantic', 'generative_critic') or evaluator_version_id is not null)
);

-- One qualification-state record per (evaluator version, protocol version) pairing (FR-16).
-- Written by evaluator_qualify; read by score-establishment code (FR-22) and by
-- replay_case_set_build, which requires replay.source_kind at least operationally_qualified.
create table zz.eval_evaluator_qualification (
    id uuid primary key default gen_random_uuid(),
    evaluator_version_id uuid not null references zz.eval_evaluator_version(id),
    protocol_version_id uuid not null references zz.eval_protocol_version(id),
    subject_scope jsonb not null,
    state text not null check (state in
        ('unqualified', 'mechanically_qualified', 'operationally_qualified', 'human_calibrated')),
    evidence jsonb not null,
    qualified_at timestamp with time zone not null
);

-- The pre-protocol immutable evidence snapshot OBSERVE creates (FR-8). Written once per OBSERVE
-- call; read by DISCOVER (failure-mode mining) and by EVALUATE when it binds one into an
-- eval_evidence_snapshot.
create table zz.eval_observation_snapshot (
    id uuid primary key default gen_random_uuid(),
    subject_version_id uuid not null references zz.eval_subject_version(id),
    production_window jsonb not null,
    coverage jsonb not null,
    usable_run_count int not null,
    total_run_count int not null,
    runtime_identity jsonb not null,
    environment_digest text not null,
    evidence_digest text not null,
    created_at timestamp with time zone not null,
    -- The full map of facts OBSERVE computed for this subject/window (observe-facts.ts's
    -- OBSERVATION_FACT_KEYS), which evaluate-measures.ts's deterministicAnswer reads by dotted
    -- path — not just their digest, so a deterministic/outcome measure can read any of them.
    facts jsonb null
);

comment on column zz.eval_observation_snapshot.facts is
  'Every ObservedFact computeObservation wrote for this snapshot (observe-facts.ts''s OBSERVATION_FACT_KEYS), keyed by fact name. Null when the snapshot carries no computed facts, and every deterministic/outcome measure against it then answers excluded with a named reason. A deterministic/outcome measure reads one entry by dotted definition.factPath.';

-- Durable failure-mode candidates DISCOVER writes against an observation snapshot, before any
-- protocol exists (FR-11). Written by failure_discover; read by DEFINE/QUALIFY when it accepts a
-- candidate into a protocol version's failure_taxonomy, preserving discovery lineage.
create table zz.eval_failure_mode_candidate (
    id uuid primary key default gen_random_uuid(),
    observation_snapshot_id uuid not null references zz.eval_observation_snapshot(id),
    stable_key text null,
    description text not null,
    prevalence jsonb not null,
    owner_kind text not null check (owner_kind in
        ('plugin', 'dependency', 'platform', 'environment', 'user_input', 'unknown')),
    confidence numeric null,
    evidence_refs jsonb not null,
    status text not null check (status in ('candidate', 'accepted', 'rejected', 'merged')),
    merged_into_id uuid null references zz.eval_failure_mode_candidate(id),
    created_at timestamp with time zone not null
);

-- One immutable, versioned derivation of replay cases from closed initiatives (FR-24, FR-60).
-- Written only by replay_case_set_build; read by replay_case, eval_evidence_snapshot and every
-- replay_run whose case draws from it.
create table zz.replay_case_set (
    id uuid primary key default gen_random_uuid(),
    plugin_id uuid not null references zz.plugin(id),
    version int not null,
    source_snapshot_digest text not null,
    split_seed text not null,
    created_at timestamp with time zone not null,
    -- Who holds this case set's proof split (FR-28): a spent allocation refuses a second opening
    -- even from a fresh improvement_run over the same eval_run. candidate_prove's opening
    -- transaction claims it with a compare-and-set, and the resolving transaction keeps it
    -- (spent: proof_passed, proof_failed, or not_established after runs executed on the proof
    -- cases) or clears both columns (released: not_established with no run executed, or with only
    -- an unavailable leakage answer missing). A held split needs new evidence (a new case set) for
    -- any other candidate. The foreign key to zz.candidate is added once that table exists.
    proof_spent_at timestamp with time zone null,
    proof_spent_by_candidate_id uuid null,
    unique (plugin_id, version)
);

-- One immutable case inside a case-set version (FR-24, FR-27, FR-60). Written only by
-- replay_case_set_build; read by replay_run and by the evolve/validation/proof pools it is split
-- into.
create table zz.replay_case (
    id uuid primary key default gen_random_uuid(),
    case_set_id uuid not null references zz.replay_case_set(id),
    source_initiative text null,
    case_digest text not null,
    split text null check (split in ('evolve', 'validation', 'proof')),
    status text not null check (status in ('replayable', 'not_replayable')),
    not_replayable_reason text null,
    user_oracle_coverage int not null,
    decisions_only_in_documents boolean not null,
    unique (case_set_id, case_digest),
    check (split is not null or status = 'not_replayable')
);

-- One chronologically ordered, visibility-tagged event inside a replay case (FR-25, FR-26,
-- FR-60). Written only by replay_case_set_build. Read by the candidate actor session (`actor`
-- rows only), the simulated-person session (`actor` and `user_oracle`), and evaluators/verifiers
-- (all rows) — never by a session outside the visibility it was granted.
create table zz.replay_event (
    id uuid primary key default gen_random_uuid(),
    case_id uuid not null references zz.replay_case(id),
    seq int not null,
    actor text not null,
    visibility text not null check (visibility in ('actor', 'user_oracle', 'evaluation_oracle')),
    kind text not null,
    payload jsonb not null,
    payload_digest text not null,
    unique (case_id, seq)
);

-- The protocol-bound evaluation snapshot EVALUATE creates by binding exactly one observation
-- snapshot to one protocol version and, where used, one replay case-set version (FR-8). Written
-- by evaluation_start; read by eval_run, which references it as the evidence it was scored
-- against.
create table zz.eval_evidence_snapshot (
    id uuid primary key default gen_random_uuid(),
    observation_snapshot_id uuid not null references zz.eval_observation_snapshot(id),
    subject_version_id uuid not null references zz.eval_subject_version(id),
    protocol_version_id uuid not null references zz.eval_protocol_version(id),
    case_set_version_id uuid null references zz.replay_case_set(id),
    coverage jsonb not null,
    content_digest text not null,
    created_at timestamp with time zone not null,
    unique nulls not distinct (observation_snapshot_id, protocol_version_id, case_set_version_id)
);

-- One EVALUATE run: a subject version scored against a protocol version's evidence snapshot
-- (FR-21, FR-22, FR-23). Written by evaluation_start/evaluation_score; read by the dashboard,
-- findings.md generation, improvement_run and every eval_assessment it parents.
create table zz.eval_run (
    id uuid primary key default gen_random_uuid(),
    subject_version_id uuid not null references zz.eval_subject_version(id),
    protocol_version_id uuid not null references zz.eval_protocol_version(id),
    evidence_snapshot_id uuid not null references zz.eval_evidence_snapshot(id),
    run_status text not null check (run_status in
        ('pending', 'running', 'completed', 'failed', 'cancelled')),
    score_status text null check (score_status in ('established', 'provisional', 'not_established')),
    overall_score numeric null,
    score_interval jsonb null,
    dimension_scores jsonb null,
    guardrail_status text null check (guardrail_status in ('pass', 'fail', 'not_established')),
    coverage jsonb not null,
    created_at timestamp with time zone not null,
    -- The protocol's improvement.criticalGuardrails, evaluated — the only guardrail mechanism.
    -- Mirrors zz.replay_run.guardrails, kept beside the scalar guardrail_status for diagnosis
    -- (FR-23's "numeric score for diagnosis": which guardrail, what value, against what threshold).
    guardrails jsonb null
);

comment on column zz.eval_run.guardrails is
  'evaluateGuardrails() output for this run''s protocol.improvement.criticalGuardrails: [{key, threshold, value, status}]. guardrail_status is the reduced pass/fail/not_established this column explains.';

-- One IMPROVE search launched from an eval_run's findings (FR-34, FR-38, FR-42). Written by
-- improvement_start; read by candidate, the liveness-bound checks (FR-57) and the dashboard's
-- Evolution section.
create table zz.improvement_run (
    id uuid primary key default gen_random_uuid(),
    eval_run_id uuid not null references zz.eval_run(id),
    finding_ids jsonb not null,
    search_policy jsonb not null,
    status text not null check (status in
        ('open', 'searching', 'selected', 'proofing', 'proof_failed', 'ready_for_approval', 'released', 'closed', 'cancelled')),
    created_at timestamp with time zone not null
);

-- One proposed patch set inside an improvement run (FR-36, FR-37). Written by candidate_record
-- before execution; read by candidate_evaluation, replay_run, release_attempt and the search
-- policy comparing generations against their exact baseline.
--
-- status: proof_not_established is an unestablished proof (candidate_prove's
-- insufficient_proof_cases/proof_unresolved reasons, or abandon) — an evidence gap, kept apart
-- from proof_failed because REJECTED_CANDIDATE_STATUSES (proposer-bundle.ts) bars a proof_failed
-- hypothesis from ever being proposed again. rolled_back is release_verify's rollback path: a
-- 'released' candidate the platform has since restored the prior version over.
create table zz.candidate (
    id uuid primary key default gen_random_uuid(),
    improvement_run_id uuid not null references zz.improvement_run(id),
    base_subject_version_id uuid not null references zz.eval_subject_version(id),
    generation int not null,
    parent_ids jsonb not null,
    hypothesis text not null,
    expected_effect jsonb not null,
    patchset jsonb not null,
    patch_digest text not null,
    complexity_delta int not null,
    touched_components jsonb not null,
    touched_owners jsonb not null,
    proposer_identity jsonb not null,
    status text not null check (status in
        ('recorded', 'rejected_precheck', 'validating', 'valid', 'invalid', 'selected',
         'proving', 'proof_passed', 'proof_failed', 'proof_not_established', 'stale', 'released',
         'rolled_back')),
    created_at timestamp with time zone not null,
    -- The lease on 'validating': candidate_validate holds that status for the length of a build
    -- and gate, without a transaction, so a process killed mid-build (SIGKILL, redeploy) never
    -- runs the call's finally. candidate_validate and candidate_search return a hold older than
    -- the build and gate timeouts plus a margin to where it can be validated again.
    validating_since timestamp with time zone null
);

comment on column zz.candidate.status is
  'rolled_back: release_record set the same candidate''s own release_attempt to '
  'rolled_back after packages/tools/src/release/rollback.ts restored the prior released version — '
  'set alongside it, in the same recordRelease transaction, never on its own.';

alter table zz.replay_case_set
    add constraint replay_case_set_proof_spent_by_candidate_id_fkey
        foreign key (proof_spent_by_candidate_id) references zz.candidate(id);

-- One proof allocation's credential (FR-28): a `context: "verifier"` call to replay_start or
-- replay_read must present a verifier_token, minted by candidate_prove (or by release_verify,
-- whose "candidate" side runs as the RELEASED subject). Hashed the same way zz.pat is (sha256,
-- never the plaintext at rest): the plaintext is shown once by the tool that mints it. The
-- token is bound to the one case set its allocation opened, and replay-verifier.ts refuses a
-- token whose binding does not match the run it is used on — an unbound token is refused
-- outright.
create table zz.replay_verifier_token (
    id uuid primary key default gen_random_uuid(),
    token_hash text not null unique,
    candidate_id uuid not null references zz.candidate(id),
    expires_at timestamp with time zone not null,
    revoked_at timestamp with time zone null,
    created_at timestamp with time zone not null default now(),
    case_set_id uuid null references zz.replay_case_set(id),
    -- Set by release_verify, whose candidate side runs as a subject version rather than as
    -- candidate_id. Null for a candidate_prove token.
    released_subject_version_id uuid null references zz.eval_subject_version(id)
);

-- One isolated candidate or subject execution against one replay case (FR-31, FR-33). Written by
-- replay_start/replay_close; read by candidate_evaluation, eval_assessment (through
-- replay_run_id) and release proof evidence.
create table zz.replay_run (
    id uuid primary key default gen_random_uuid(),
    case_id uuid not null references zz.replay_case(id),
    subject_version_id uuid null references zz.eval_subject_version(id),
    candidate_id uuid null references zz.candidate(id),
    protocol_version_id uuid not null references zz.eval_protocol_version(id),
    environment_digest text not null,
    sandbox_ref text not null,
    status text not null check (status in
        ('registered', 'running', 'completed', 'failed', 'not_replayable', 'cancelled')),
    score jsonb null,
    guardrails jsonb null,
    model_usage jsonb null,
    cost numeric null,
    duration_ms bigint null,
    created_at timestamp with time zone not null,
    -- Who started the run (replay_start's own expiry sweep closes only ITS OWN caller's expired
    -- runs, AC-29.1), the reserved team it was provisioned into and the PAT issued for it
    -- (packages/contracts/src/replay-team.ts's provisionReplayTeam/teardownReplayTeam — replay_close
    -- tears down exactly that team), and when that PAT expires (the value provisionReplayTeam was
    -- given, so "this run has expired" is a plain comparison against now()). Written once by
    -- replay_start.
    principal text not null,
    team_slug text not null,
    pat_id uuid not null references zz.pat(id),
    expires_at timestamp with time zone not null,
    -- What the session produced, bounded and redacted as launch.ts settles it:
    -- `{ transcript, artifacts: [{ path, sha256, bytes, head }] }` — the final assistant text and a
    -- capped list of the files it wrote, with the run's own token redacted out of both. Written
    -- once, from replay_close's own `result`; read by replay_score to build the text a
    -- model-backed measure is asked to judge. Null until replay_close carries a `result.produced`,
    -- which replay_score refuses naming rather than scoring an empty subject.
    produced jsonb null,
    verifier_allocation_id uuid null references zz.replay_verifier_token(id)
);

comment on column zz.replay_run.verifier_allocation_id is
  'Set by replay_start when context = verifier, from the verifier_token presented. Null for a search-context run. candidate_prove''s cancelProofRuns filters on this column so two concurrent proof allocations against the same base subject never cancel each other''s runs.';

-- One scored comparison of a candidate against validation, proof or post-release cases (FR-40,
-- FR-43). Written by candidate_validate/candidate_prove; read by the selection policy (FR-42) and
-- release_prepare's eligibility check.
create table zz.candidate_evaluation (
    id uuid primary key default gen_random_uuid(),
    candidate_id uuid not null references zz.candidate(id),
    split text not null check (split in ('validation', 'proof', 'post_release')),
    aggregate_score jsonb not null,
    dimension_scores jsonb not null,
    guardrails jsonb not null,
    statistics jsonb not null,
    resource_usage jsonb not null,
    created_at timestamp with time zone not null
);

-- One stored validation verdict per candidate: candidate_validate reads "the" validation row back
-- on every later call, so a second concurrent call's insert is refused here rather than leaving
-- two verdicts to choose between.
create unique index candidate_evaluation_one_validation
    on zz.candidate_evaluation (candidate_id) where split = 'validation';

-- One promotion of a candidate onto its exact base subject version (FR-46 to FR-50). Written by
-- release_prepare/release_apply/release_verify; read by the dashboard's release history and by
-- release_prepare's stale_baseline check re-reading the currently released subject before a later
-- attempt.
create table zz.release_attempt (
    id uuid primary key default gen_random_uuid(),
    candidate_id uuid not null references zz.candidate(id),
    base_subject_version_id uuid not null references zz.eval_subject_version(id),
    approved_patch_digest text not null,
    required_owners jsonb not null,
    approval_refs jsonb not null,
    status text not null check (status in
        ('prepared', 'applying', 'released', 'refused', 'failed', 'rolled_back')),
    released_subject_version_id uuid null references zz.eval_subject_version(id),
    release_ref text null,
    verification jsonb null,
    rolled_back boolean not null default false,
    created_at timestamp with time zone not null,
    -- Why a refused or failed attempt ended that way. A replayed release_apply/release_record call
    -- reconstructs its answer by reading this row back (zz.eval_idempotency stores only
    -- result_table/result_id), so the row itself has to carry it — one column for both the
    -- refusal reason and the failure tail, so a reader never has two to reconcile.
    reason text null,
    -- A partial unique index cannot join through zz.candidate, so the plugin is recorded on the
    -- row itself for release_attempt_applying_plugin_idx below.
    plugin_id uuid not null references zz.plugin(id),
    applied_by text null,
    applying_at timestamp with time zone null
);

-- At most one live release per candidate (FR-49): a second attempt while one is already applying
-- or released collides here rather than racing the real system.
create unique index release_attempt_live_candidate_idx on zz.release_attempt (candidate_id)
    where status in ('applying', 'released');

-- At most one applying attempt per plugin (FR-49): two DIFFERENT candidates built on the same base
-- could otherwise both sit in 'applying', each passing the compare-and-swap against a released
-- subject the other was about to move. A database fact, not a property of the advisory lock alone.
create unique index release_attempt_applying_plugin_idx on zz.release_attempt (plugin_id)
    where status = 'applying';

comment on column zz.release_attempt.reason is
  'Why this attempt is refused or failed: releaseDecision''s own reason on a refusal, or the failing command''s output tail (release_record) on a failure. Null for prepared/applying/released.';
comment on column zz.release_attempt.plugin_id is
  'The plugin this attempt releases — the base subject''s own plugin, written by release_prepare. Keys release_attempt_applying_plugin_idx: at most one applying attempt per plugin.';
comment on column zz.release_attempt.applied_by is
  'The principal whose release_apply moved this attempt to applying. release_record and release_verify accept that principal or a member of a required owner team, nobody else.';
comment on column zz.release_attempt.applying_at is
  'When release_apply moved this attempt to applying. An attempt still applying long after the CLI''s own gate and release timeouts is stale: release_apply names it for reconciliation.';

-- Extends the existing semantic-assessment ledger (001) so a row identifies its question either
-- as a platform checkpoint (`family`) or as a protocol-defined evaluator (`evaluator_version_id`)
-- — FR-13, FR-18. Written by semantic.ts's assessFamily() (unchanged) and its new sibling
-- recordEvaluatorAssessment(), sharing one insert builder; read by zz.eval_assessment through
-- assessment_id and by the existing platform-checkpoint callers, unaffected.
alter table zz.assessment
    alter column family drop not null,
    alter column reading drop not null,
    add column evaluator_version_id uuid null references zz.eval_evaluator_version(id),
    add column distribution jsonb null,
    add column answer_kind text not null default 'noul' check (answer_kind in ('noul', 'choice', 'score'));

alter table zz.assessment
    add constraint assessment_family_xor_evaluator_check
        check ((family is not null) <> (evaluator_version_id is not null)),
    add constraint assessment_family_implies_noul_check
        check (family is null or (reading is not null and answer_kind = 'noul')),
    add constraint assessment_choice_score_distribution_check
        check (answer_kind not in ('choice', 'score') or distribution is not null
               or (reading = 'unavailable' and reason is not null));

comment on column zz.assessment.evaluator_version_id is
  'Set instead of family for a plugin-eval question. Exactly one of the two is non-null.';
comment on column zz.assessment.distribution is
  'The full answer distribution for a choice/score evaluator question. probability keeps carrying the noul probability.';
comment on column zz.assessment.answer_kind is
  'noul | choice | score — which typed-service primitive answered this question. Defaults to noul, so every row written before this migration reads as noul unchanged.';

-- One measurement-time judgment: which measure was asked, from which context (an eval_run or a
-- replay_run, never both), and what the typed-service model-call row (assessment_id) said
-- (FR-18). Written by evaluation_assess/candidate_evaluation's assessment step; read by scoring
-- code, findings.md and the improvement search's evidence trail.
create table zz.eval_assessment (
    id uuid primary key default gen_random_uuid(),
    eval_run_id uuid null references zz.eval_run(id),
    replay_run_id uuid null references zz.replay_run(id),
    measure_id uuid not null references zz.eval_measure(id),
    evaluator_version_id uuid null references zz.eval_evaluator_version(id),
    -- Required when zz.eval_measure.evaluator_type is bounded_semantic or generative_critic
    -- (FR-18). Not a CHECK: a CHECK cannot look up another table's row, so this is enforced by
    -- the evaluation_assess/candidate_evaluation write path instead.
    assessment_id bigint null references zz.assessment(id),
    qualification_id uuid null references zz.eval_evaluator_qualification(id),
    subject_ref text not null,
    evidence_ref text not null,
    answer jsonb not null,
    policy_version text not null,
    resulting_action text null,
    created_at timestamp with time zone not null,
    check ((eval_run_id is null) <> (replay_run_id is null))
);

-- Extends the existing zz.eval_finding (001) with plugin-eval's ownership and evidence fields
-- (FR-12, FR-18) and gives an EVALUATE-produced finding its own lifetime. owner_kind/owner_ref/
-- measure_id/evidence_refs/eval_run_id/kind are written by finding_record; expected_effect is
-- written by finding_record when the finding seeds a candidate. Read by candidate generation —
-- only a plugin-owned finding may seed one (FR-34) — and by findings.md.
--
-- The same dual-lifecycle shape zz.assessment takes above (family XOR evaluator_version_id): a
-- finding belongs to exactly one lifetime, the legacy round (eval_id, with its generic/specific
-- scope) or the eval_run (eval_run_id, with a strength/defect/unknown kind), never both. Every
-- existing row (eval_id set, kind null) satisfies every check unchanged, and round_scores' join on
-- eval_id simply never matches an eval_run-bound row.
alter table zz.eval_finding
    alter column eval_id drop not null,
    alter column scope drop not null,
    add column owner_kind text null check (owner_kind in
        ('plugin', 'dependency', 'platform', 'environment', 'user_input', 'unknown')),
    add column owner_ref text null,
    add column measure_id uuid null references zz.eval_measure(id),
    add column evidence_refs jsonb not null default '[]'::jsonb,
    add column expected_effect jsonb null,
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

-- FR-59's single mutation ledger, shared by every mutating evaluation MCP tool. Written before
-- any external work by each mutator (plugin_register, plugin_profile, finding_decide,
-- replay_close, protocol_record, protocol_affirm, evaluator_qualify, failure_discover,
-- evaluation_start, evaluation_assess, evaluation_score, finding_record, replay_case_set_build,
-- replay_start, improvement_start, candidate_record, candidate_validate, candidate_search,
-- candidate_prove, release_prepare, release_apply, release_verify); read by the same call on
-- retry to return the original result or refuse idempotency_conflict.
create table zz.eval_idempotency (
    principal text not null,
    tool text not null,
    idempotency_key text not null,
    request_digest text not null,
    result_table text not null,
    result_id uuid not null,
    created_at timestamp with time zone not null,
    primary key (principal, tool, idempotency_key)
);

-- Mirrors <initiative>/_facts.json (services/zz-core/src/initiative-record.ts, factsFor/
-- writeFacts) into the platform database (FR-58) so the console — which reads zz.doc alone, never
-- the filesystem the eval service writes to — can compute the same documentApplies
-- (packages/contracts/src/flow-when.ts) answer the store's own readers do. The file stays
-- authoritative; this is a read-side mirror, written alongside it by writeBranchFacts
-- (services/zz-core/src/eval/protocol.ts) the moment a fact is newly set. Append-only there and
-- here: a fact once recorded is never given a different value, which is why
-- `unique (team, initiative, fact)` is enforced rather than merely intended — an insert for an
-- unchanged (team, initiative, fact) does nothing (on conflict do nothing).
create table zz.initiative_fact (
    id bigint generated always as identity primary key,
    team text not null,
    initiative text not null,
    fact text not null,
    value text not null,
    set_at timestamp with time zone not null default now(),
    unique (team, initiative, fact)
);

create index initiative_fact_lookup_idx on zz.initiative_fact (team, initiative);

comment on table zz.initiative_fact is
  'Mirror of <initiative>/_facts.json for the console. The file is authoritative; a row here is never updated once written for a given (team, initiative, fact).';
