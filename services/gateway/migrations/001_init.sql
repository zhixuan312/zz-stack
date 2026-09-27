-- 001_init.sql — the whole schema, as one file. The migrations it replaced are in git history.
--
-- DELIBERATE: the name is load-bearing and must not change. `services/gateway/src/db.ts` records
-- each file it applies in `zz.schema_migration` by name and skips what that table already lists.
-- Every deployment that ran the old 001 carries the row `001_init.sql`, so every one of them
-- skips this file and keeps the schema it already built; a fresh database has no such row and
-- gets the whole thing in one transaction. Renaming this file re-runs it against every live
-- deployment. There is no baseline marker, no version table beside the ledger, and no branch
-- choosing between the two — the ledger is the mechanism.
--
-- DELIBERATE: the extensions come first and are declared. pg_dump does not emit them (they
-- install into this schema but belong to the database) so they are written back here with the
-- directives the runner reads. A cluster that cannot supply one defers this file rather than
-- failing half-applied; db.ts does not record a deferred file, which is what lets it be
-- retried.
--
-- COUPLED: the files this one absorbed. A deployment that ran them carries their names in
-- `zz.schema_migration`, and `scripts/doctor/layers/data.ts` counts each name listed here as
-- covered by this file rather than as an applied migration that no longer exists. The rows
-- stay: a rollback to a release that still carries those files must find them applied.
--
-- absorbs: 002_comments.sql
-- absorbs: 003_flow_manifest.sql
-- absorbs: 004_flow_install_clients.sql
-- absorbs: 005_doc_body_and_title.sql
-- absorbs: 006_doc_content_hash.sql
-- absorbs: 007_drop_platform_credential.sql
-- absorbs: 008_drop_doc_type_status.sql
-- absorbs: 009_drop_doc_team_path.sql
-- absorbs: 010_active_team.sql
-- absorbs: 011_decision.sql
-- absorbs: 012_drop_comment.sql
-- absorbs: 013_doc_created_at.sql
-- absorbs: 014_event_columns.sql
-- absorbs: 015_doc_decision.sql
-- absorbs: 016_reference.sql
-- absorbs: 017_initiative_run.sql
-- absorbs: 018_doc_attribution.sql
-- absorbs: 019_eval.sql
-- absorbs: 020_event_attribution.sql
-- absorbs: 021_delegated_tokens.sql
-- absorbs: 022_console_session.sql
-- absorbs: 023_doc_supports.sql
-- absorbs: 024_block_origin.sql
-- absorbs: 025_version_released_at.sql
-- absorbs: 026_skill_kind_two_values.sql
-- absorbs: 027_skill_retired.sql
-- absorbs: 028_eval_score_halves.sql
-- absorbs: 029_eval_subject_runs.sql
-- absorbs: 030_skill_version_body_hash.sql
-- absorbs: 031_run_without_initiative.sql
-- absorbs: 032_rubric_subject.sql
-- absorbs: 033_eval_is_control.sql
-- absorbs: 034_block_title.sql
-- absorbs: 035_doc_blocks.sql
-- absorbs: 036_run_follows_initiative.sql
-- absorbs: 037_principal_password.sql
-- absorbs: 038_console_session_door.sql
-- absorbs: 039_discussion.sql
-- absorbs: 040_mcp_oauth.sql
-- absorbs: 041_oauth_resume.sql
-- absorbs: 042_event_team_backfill.sql
-- absorbs: 043_drop_password_door.sql
-- absorbs: 044_passkey.sql
-- absorbs: 045_drop_flow_install_clients.sql
-- absorbs: 046_delete_phantom_runs.sql
-- absorbs: 047_plugin_eval.sql
-- absorbs: 048_drop_skill_eval.sql
-- absorbs: 049_drop_initiative_closed_at.sql
-- absorbs: 050_record_and_cost.sql
-- absorbs: 051_run_bytes_nullable.sql
-- absorbs: 052_block_tool_door.sql
-- absorbs: 053_drop_pat_scope.sql
-- absorbs: 054_drop_initiative_deleted_at.sql
-- absorbs: 055_case_run_initiative.sql
-- absorbs: 056_bug.sql
-- absorbs: 057_drop_third_party_blocks.sql
-- absorbs: 058_plugin_owns_its_surface.sql
-- absorbs: 059_knowledge_is_its_own_subject.sql
-- absorbs: 060_no_install_registry.sql
-- absorbs: 061_refusal_owner.sql
-- absorbs: 062_typed_judgments.sql
-- absorbs: 063_control_names_its_round.sql
-- absorbs: 064_the_case_half_is_gone.sql
-- absorbs: 065_model_call_attempts_and_confusion.sql
-- absorbs: 066_a_line_names_its_figure_and_a_finding_gets_decided.sql
-- absorbs: 067_a_round_says_where_it_came_from_and_what_it_scored.sql
-- absorbs: 068_two_axes_and_no_verdict.sql
-- absorbs: 069_no_step_is_empty_and_a_run_is_indexed.sql
-- absorbs: 070_artifacts_revisions_events_and_scoped_search.sql
-- absorbs: 071_a_source_has_no_content_revision.sql
-- absorbs: 072_write_path_records_its_analyzer.sql
-- absorbs: 073_a_run_is_where_the_control_loop_keeps_what_it_was_told.sql
-- absorbs: 074_a_later_fact_can_withdraw_an_earlier_one.sql
-- absorbs: 075_the_flow_comment_names_a_file_that_is_gone.sql
-- absorbs: 076_semantic_assessment.sql
-- absorbs: 002_plugin_eval_next.sql
-- absorbs: 002_remove_replay.sql
-- absorbs: 002_a_finding_can_be_corrected.sql
-- absorbs: 002_initiative_anchor.sql
-- absorbs: 002_identity_access.sql
-- absorbs: 002_delivery_telemetry.sql
-- absorbs: 003_a_run_the_timer_invented.sql
-- absorbs: 002_catalog_evaluation.sql
-- absorbs: 002_improve_control.sql
-- absorbs: 002_remove_artifact_layer.sql
--
-- requires-extension: citext
-- requires-extension: pg_trgm

create extension if not exists citext with schema zz;
create extension if not exists pg_trgm with schema zz;


--
-- Name: citext; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA zz;


--
-- Name: EXTENSION citext; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION citext IS 'data type for case-insensitive character strings';


--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA zz;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: assessment; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.assessment (
    id bigint NOT NULL,
    family text,
    instruction_version integer NOT NULL,
    question_digest text NOT NULL,
    reading text,
    probability numeric,
    resolved_model text,
    identity_assurance text,
    reason text,
    about text,
    asked_at timestamp with time zone DEFAULT now() NOT NULL,
    evaluator_version_id uuid,
    distribution jsonb,
    answer_kind text DEFAULT 'noul'::text NOT NULL,
    team_id uuid NOT NULL,
    initiative_id uuid,
    model_call_id bigint,
    asked_by uuid NOT NULL,
    CONSTRAINT assessment_answer_kind_check CHECK ((answer_kind = ANY (ARRAY['noul'::text, 'choice'::text, 'score'::text]))),
    CONSTRAINT assessment_choice_score_distribution_check CHECK (((answer_kind <> ALL (ARRAY['choice'::text, 'score'::text])) OR (distribution IS NOT NULL) OR ((reading = 'unavailable'::text) AND (reason IS NOT NULL)))),
    CONSTRAINT assessment_family_implies_noul_check CHECK (((family IS NULL) OR ((reading IS NOT NULL) AND (answer_kind = 'noul'::text)))),
    CONSTRAINT assessment_family_xor_evaluator_check CHECK (((family IS NOT NULL) <> (evaluator_version_id IS NOT NULL))),
    CONSTRAINT assessment_reading_check CHECK ((reading = ANY (ARRAY['yes'::text, 'no'::text, 'unclear'::text, 'unavailable'::text]))),
    CONSTRAINT assessment_reading_reason_check CHECK (((reading = 'unavailable'::text) = (reason IS NOT NULL)))
);


--
-- Name: TABLE assessment; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.assessment IS 'Every semantic-assessment question the platform asked the typed service, with its provenance. A reading of unavailable carries its reason.';


--
-- Name: COLUMN assessment.evaluator_version_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.assessment.evaluator_version_id IS 'Set instead of family for a plugin-eval question. Exactly one of the two is non-null.';


--
-- Name: COLUMN assessment.distribution; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.assessment.distribution IS 'The full answer distribution for a choice/score evaluator question. probability keeps carrying the noul probability.';


--
-- Name: COLUMN assessment.answer_kind; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.assessment.answer_kind IS 'noul | choice | score — which typed-service primitive answered this question. Defaults to noul, so every row written before this migration reads as noul unchanged.';


--
-- Name: assessment_id_seq; Type: SEQUENCE; Schema: zz; Owner: -
--

ALTER TABLE zz.assessment ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME zz.assessment_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: bug; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.bug (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reported_at timestamp with time zone DEFAULT now() NOT NULL,
    title text NOT NULL,
    detail text NOT NULL,
    surface text,
    platform_version text,
    impact text DEFAULT 'wrong_result'::text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    resolution text,
    resolved_at timestamp with time zone,
    team_id uuid,
    initiative_id uuid,
    duplicate_of uuid,
    reported_by uuid NOT NULL,
    resolved_by uuid,
    CONSTRAINT bug_duplicate_of_check CHECK (((status = 'duplicate'::text) = (duplicate_of IS NOT NULL))),
    CONSTRAINT bug_impact_check CHECK ((impact = ANY (ARRAY['blocks_work'::text, 'wrong_result'::text, 'confusing'::text, 'cosmetic'::text]))),
    CONSTRAINT bug_initiative_id_team_id_check CHECK (((initiative_id IS NULL) OR (team_id IS NOT NULL))),
    CONSTRAINT bug_not_self_duplicate_check CHECK (((duplicate_of IS NULL) OR (duplicate_of <> id))),
    CONSTRAINT bug_status_check CHECK ((status = ANY (ARRAY['open'::text, 'fixed'::text, 'not_a_bug'::text, 'duplicate'::text])))
);


--
-- Name: TABLE bug; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.bug IS 'Bugs reported by the people using this platform. Written by bug_report on /core, read by bug_list, closed by bug_resolve. Not knowledge (a report needs no evidence) and not an event (an event has no author).';


--
-- Name: candidate; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.candidate (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    improvement_run_id uuid NOT NULL,
    base_plugin_version_id uuid NOT NULL,
    hypothesis text NOT NULL,
    expected_effect jsonb NOT NULL,
    patch_digest text NOT NULL,
    complexity_delta integer NOT NULL,
    touched_components jsonb NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    build_requested_at timestamp with time zone,
    build_requested_by text,
    build_result jsonb,
    build_recorded_at timestamp with time zone,
    patch text NOT NULL,
    proposed_by uuid NOT NULL,
    proposer_client text,
    CONSTRAINT candidate_status_check CHECK ((status = ANY (ARRAY['recorded'::text, 'awaiting_build'::text, 'valid'::text, 'invalid'::text])))
);


--
-- Name: COLUMN candidate.status; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.candidate.status IS 'recorded -> awaiting_build -> valid or invalid. The attempt states, released and rolled_back, live on release_attempt; a reader joins that row rather than reading a copy here.';


--
-- Name: COLUMN candidate.build_result; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.candidate.build_result IS 'What npm run candidate-build recorded through candidate_build_record: {ok, stage, log_tail, commands, patch_digest}. Kept once candidate_validate consumes it, so improvement.md and the console can say how the released patch was built and gated.';


--
-- Name: console_session; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.console_session (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    principal_id uuid NOT NULL,
    token_hash text NOT NULL,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    last_seen_at timestamp with time zone,
    user_agent text,
    ip text,
    team_id uuid
);


--
-- Name: control_evidence; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.control_evidence (
    seq bigint NOT NULL,
    run_id uuid NOT NULL,
    entry_id text NOT NULL,
    step_id text NOT NULL,
    kind text NOT NULL,
    about text NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    recorded_by text,
    supersedes text,
    CONSTRAINT control_evidence_kind_check CHECK ((kind = ANY (ARRAY['document'::text, 'approval'::text, 'audit'::text])))
);


--
-- Name: control_evidence_seq_seq; Type: SEQUENCE; Schema: zz; Owner: -
--

CREATE SEQUENCE zz.control_evidence_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: control_evidence_seq_seq; Type: SEQUENCE OWNED BY; Schema: zz; Owner: -
--

ALTER SEQUENCE zz.control_evidence_seq_seq OWNED BY zz.control_evidence.seq;


--
-- Name: control_run; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.control_run (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    module_digest text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    initiative_id uuid NOT NULL,
    started_by uuid
);


--
-- Name: control_waiver; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.control_waiver (
    seq bigint NOT NULL,
    run_id uuid NOT NULL,
    step_id text NOT NULL,
    kind text NOT NULL,
    ground text NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    recorded_by text,
    CONSTRAINT control_waiver_ground_check CHECK ((btrim(ground) <> ''::text)),
    CONSTRAINT control_waiver_kind_check CHECK ((kind = ANY (ARRAY['document'::text, 'approval'::text, 'audit'::text])))
);


--
-- Name: control_waiver_seq_seq; Type: SEQUENCE; Schema: zz; Owner: -
--

CREATE SEQUENCE zz.control_waiver_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: control_waiver_seq_seq; Type: SEQUENCE OWNED BY; Schema: zz; Owner: -
--

ALTER SEQUENCE zz.control_waiver_seq_seq OWNED BY zz.control_waiver.seq;


--
-- Name: doc; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.doc (
    team_slug text NOT NULL,
    initiative text NOT NULL,
    path text NOT NULL,
    flow text DEFAULT ''::text NOT NULL,
    type text DEFAULT ''::text NOT NULL,
    status text DEFAULT ''::text NOT NULL,
    outcome text,
    approved_by text,
    approved_at timestamp with time zone,
    updated_at timestamp with time zone NOT NULL,
    body_tsv tsvector,
    body text DEFAULT ''::text NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    evidence text[] DEFAULT '{}'::text[] NOT NULL,
    superseded_by text,
    content_hash text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_by text,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    initiative_id uuid,
    produced_by_run_id uuid,
    supports text,
    analyzer_version text,
    CONSTRAINT doc_outcome_closed CHECK (((outcome IS NULL) OR (outcome = ANY (ARRAY['delivered'::text, 'accepted'::text, 'abandoned'::text])))),
    CONSTRAINT doc_status_closed CHECK ((status = ANY (ARRAY[''::text, 'draft'::text, 'approved'::text, 'adopted'::text, 'superseded'::text])))
);


--
-- Name: COLUMN doc.approved_by; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.doc.approved_by IS 'The one signature field. A person, never a team slug, "the user" or "the agent" — and
   stamped by approve() / close() from the session, never typed by a model.';


--
-- Name: COLUMN doc.created_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.doc.created_at IS 'When this document first existed. Never moves. `updated_at` is the last write; this is the
   first, and it is what scopes a measurement to one initiative''s lifetime.';


--
-- Name: eval_assessment; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.eval_assessment (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    eval_run_id uuid NOT NULL,
    measure_id uuid NOT NULL,
    assessment_id bigint,
    qualification_id uuid,
    created_at timestamp with time zone NOT NULL,
    subject_kind text NOT NULL,
    run_id uuid,
    doc_id uuid,
    doc_revision integer,
    knowledge_node_id uuid,
    bug_id uuid,
    event_id bigint,
    value numeric,
    raw_value jsonb,
    numerator integer,
    denominator integer,
    excluded_reason text,
    CONSTRAINT eval_assessment_subject_kind_check CHECK ((((subject_kind = 'run_level'::text) AND (run_id IS NULL) AND (doc_id IS NULL) AND (knowledge_node_id IS NULL) AND (bug_id IS NULL) AND (event_id IS NULL)) OR ((subject_kind = 'run'::text) AND (run_id IS NOT NULL) AND (doc_id IS NULL) AND (knowledge_node_id IS NULL) AND (bug_id IS NULL) AND (event_id IS NULL)) OR ((subject_kind = 'document'::text) AND (run_id IS NULL) AND (doc_id IS NOT NULL) AND (knowledge_node_id IS NULL) AND (bug_id IS NULL) AND (event_id IS NULL)) OR ((subject_kind = 'knowledge'::text) AND (run_id IS NULL) AND (doc_id IS NULL) AND (knowledge_node_id IS NOT NULL) AND (bug_id IS NULL) AND (event_id IS NULL)) OR ((subject_kind = 'bug'::text) AND (run_id IS NULL) AND (doc_id IS NULL) AND (knowledge_node_id IS NULL) AND (bug_id IS NOT NULL) AND (event_id IS NULL)) OR ((subject_kind = 'event'::text) AND (run_id IS NULL) AND (doc_id IS NULL) AND (knowledge_node_id IS NULL) AND (bug_id IS NULL) AND (event_id IS NOT NULL)))),
    CONSTRAINT eval_assessment_value_check CHECK (((value IS NULL) = (excluded_reason IS NOT NULL)))
);


--
-- Name: eval_dimension; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.eval_dimension (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    protocol_version_id uuid NOT NULL,
    key text NOT NULL,
    canonical_kind text NOT NULL,
    weight numeric NOT NULL,
    required boolean NOT NULL,
    applicable boolean DEFAULT true NOT NULL,
    not_applicable_reason text,
    CONSTRAINT eval_dimension_canonical_kind_check CHECK ((canonical_kind = ANY (ARRAY['effectiveness'::text, 'reliability'::text, 'constraint_adherence'::text, 'recovery_robustness'::text, 'efficiency'::text, 'generalization'::text]))),
    CONSTRAINT eval_dimension_check CHECK (((applicable AND (not_applicable_reason IS NULL)) OR ((NOT applicable) AND (not_applicable_reason IS NOT NULL)))),
    CONSTRAINT eval_dimension_weight_check CHECK (((weight >= (0)::numeric) AND (weight <= (1)::numeric)))
);


--
-- Name: eval_evaluator_qualification; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.eval_evaluator_qualification (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    state text NOT NULL,
    evidence jsonb NOT NULL,
    qualified_at timestamp with time zone NOT NULL,
    measure_id uuid NOT NULL,
    qualified_by uuid NOT NULL,
    CONSTRAINT eval_evaluator_qualification_state_check CHECK ((state = ANY (ARRAY['unqualified'::text, 'mechanically_qualified'::text, 'operationally_qualified'::text, 'human_calibrated'::text])))
);


--
-- Name: eval_evaluator_version; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.eval_evaluator_version (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    version integer NOT NULL,
    question text NOT NULL,
    answer_schema jsonb NOT NULL,
    positive_answer text,
    content_digest text NOT NULL,
    stable_key text NOT NULL
);


--
-- Name: eval_failure_mode; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.eval_failure_mode (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    plugin_id uuid NOT NULL,
    stable_key text NOT NULL,
    description text NOT NULL,
    created_at timestamp with time zone NOT NULL
);


--
-- Name: eval_failure_mode_sighting; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.eval_failure_mode_sighting (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    failure_mode_id uuid NOT NULL,
    observation_snapshot_id uuid NOT NULL,
    description text NOT NULL,
    prevalence_numerator integer NOT NULL,
    prevalence_denominator integer NOT NULL,
    owner_kind text NOT NULL,
    owner_ref text,
    ownership_reason text,
    confidence numeric,
    assessment_id bigint,
    description_model_call_id bigint,
    evidence_refs jsonb NOT NULL,
    discovered_by uuid,
    discovery_key text,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT eval_failure_mode_sighting_owner_kind_check CHECK ((owner_kind = ANY (ARRAY['plugin'::text, 'dependency'::text, 'platform'::text, 'environment'::text, 'user_input'::text, 'unknown'::text]))),
    CONSTRAINT eval_failure_mode_sighting_prevalence_check CHECK ((prevalence_numerator <= prevalence_denominator))
);


--
-- Name: eval_finding; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.eval_finding (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    pattern text NOT NULL,
    decision text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    decision_note text DEFAULT ''::text NOT NULL,
    owner_kind text NOT NULL,
    owner_ref text,
    measure_id uuid,
    evidence_refs jsonb DEFAULT '[]'::jsonb NOT NULL,
    expected_effect jsonb,
    eval_run_id uuid NOT NULL,
    kind text NOT NULL,
    superseded_by uuid,
    decided_by uuid,
    CONSTRAINT eval_finding_decision_check CHECK ((decision = ANY (ARRAY['applied'::text, 'rejected'::text, 'deferred'::text]))),
    CONSTRAINT eval_finding_kind_check CHECK ((kind = ANY (ARRAY['strength'::text, 'defect'::text, 'unknown'::text]))),
    CONSTRAINT eval_finding_kind_decision_check CHECK (((kind = 'strength'::text) = (decision IS NULL))),
    CONSTRAINT eval_finding_owner_kind_check CHECK ((owner_kind = ANY (ARRAY['plugin'::text, 'dependency'::text, 'platform'::text, 'environment'::text, 'user_input'::text, 'unknown'::text]))),
    CONSTRAINT eval_finding_owner_ref_check CHECK (((owner_kind <> 'plugin'::text) OR (owner_ref IS NULL))),
    CONSTRAINT eval_finding_run_requires_kind_check CHECK (((eval_run_id IS NULL) OR (kind IS NOT NULL))),
    CONSTRAINT eval_finding_superseded_check CHECK (((superseded_by IS NULL) OR (decision = 'rejected'::text)))
);


--
-- Name: COLUMN eval_finding.decision_note; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_finding.decision_note IS 'Why it was applied or rejected. Empty while deferred -- the open state needs no reason, and the two closed ones do.';


--
-- Name: COLUMN eval_finding.eval_run_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_finding.eval_run_id IS 'The run that concluded this finding (finding_record). Every finding names one, and the legacy round column it shared this table with went with the round tables.';


--
-- Name: COLUMN eval_finding.kind; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_finding.kind IS 'strength | defect | unknown. A strength is terminal at insert — it is what is working, not open work, so its decision is null.';


--
-- Name: COLUMN eval_finding.superseded_by; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_finding.superseded_by IS 'The finding that corrected this one, when finding_record(supersedes) replaced it. Null for a current finding. A superseded finding is also decision=rejected, so it stays closed for every reader.';


--
-- Name: eval_idempotency; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.eval_idempotency (
    tool text NOT NULL,
    idempotency_key text NOT NULL,
    request_digest text NOT NULL,
    result_table text NOT NULL,
    result_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    principal_id uuid NOT NULL
);


--
-- Name: eval_measure; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.eval_measure (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    dimension_id uuid NOT NULL,
    key text NOT NULL,
    evaluator_type text NOT NULL,
    weight numeric NOT NULL,
    required boolean NOT NULL,
    definition jsonb NOT NULL,
    evaluator_version_id uuid,
    protocol_version_id uuid NOT NULL,
    fact_key text,
    subject_kind text,
    guardrail_threshold numeric,
    CONSTRAINT eval_measure_check CHECK (((evaluator_type <> ALL (ARRAY['bounded_semantic'::text, 'generative_critic'::text])) OR (evaluator_version_id IS NOT NULL))),
    CONSTRAINT eval_measure_evaluator_type_check CHECK ((evaluator_type = ANY (ARRAY['deterministic'::text, 'outcome'::text, 'bounded_semantic'::text, 'generative_critic'::text, 'human'::text]))),
    CONSTRAINT eval_measure_evaluator_version_check CHECK (((evaluator_type = ANY (ARRAY['bounded_semantic'::text, 'generative_critic'::text])) = (evaluator_version_id IS NOT NULL))),
    CONSTRAINT eval_measure_fact_key_check CHECK (((evaluator_type = ANY (ARRAY['deterministic'::text, 'outcome'::text])) = (fact_key IS NOT NULL)))
);


--
-- Name: eval_observation_snapshot; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.eval_observation_snapshot (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    usable_run_count integer NOT NULL,
    total_run_count integer NOT NULL,
    evidence_digest text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    facts jsonb,
    plugin_version_id uuid NOT NULL,
    window_from timestamp with time zone,
    window_to timestamp with time zone,
    surface_observed integer NOT NULL,
    surface_total integer NOT NULL,
    surface_source text,
    platform_version text NOT NULL,
    recorded_by uuid NOT NULL,
    CONSTRAINT eval_observation_snapshot_run_count_check CHECK ((usable_run_count <= total_run_count)),
    CONSTRAINT eval_observation_snapshot_window_check CHECK ((window_from <= window_to))
);


--
-- Name: COLUMN eval_observation_snapshot.facts; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_observation_snapshot.facts IS 'Every ObservedFact computeObservation wrote for this snapshot (observe-facts.ts''s OBSERVATION_FACT_KEYS), keyed by fact name. Null when the snapshot carries no computed facts, and every deterministic/outcome measure against it then answers excluded with a named reason. A deterministic/outcome measure reads one entry by dotted definition.factPath.';


--
-- Name: eval_protocol_failure_mode; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.eval_protocol_failure_mode (
    protocol_version_id uuid NOT NULL,
    failure_mode_id uuid NOT NULL
);


--
-- Name: eval_protocol_version; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.eval_protocol_version (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    version integer NOT NULL,
    purpose text NOT NULL,
    qualification_policy jsonb NOT NULL,
    scoring_policy jsonb NOT NULL,
    improvement_policy jsonb NOT NULL,
    content_digest text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    plugin_id uuid NOT NULL,
    protocol_key text NOT NULL,
    observable_surfaces text[] NOT NULL,
    approved_doc_id uuid,
    affirmed_by uuid,
    affirmed_at timestamp with time zone,
    recorded_by uuid NOT NULL,
    CONSTRAINT eval_protocol_version_affirmation_check CHECK ((((approved_doc_id IS NULL) = (affirmed_by IS NULL)) AND ((approved_doc_id IS NULL) = (affirmed_at IS NULL))))
);


--
-- Name: eval_run; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.eval_run (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    protocol_version_id uuid NOT NULL,
    score_status text,
    overall_score numeric,
    guardrail_status text,
    created_at timestamp with time zone NOT NULL,
    team_id uuid NOT NULL,
    initiative_id uuid,
    observation_snapshot_id uuid NOT NULL,
    score_lower numeric,
    score_upper numeric,
    measure_coverage numeric,
    establishment_blocked_by text[],
    scorer_version text,
    started_by uuid NOT NULL,
    scored_at timestamp with time zone,
    CONSTRAINT eval_run_guardrail_status_check CHECK ((guardrail_status = ANY (ARRAY['pass'::text, 'fail'::text, 'not_established'::text]))),
    CONSTRAINT eval_run_overall_score_check CHECK (((overall_score >= (0)::numeric) AND (overall_score <= (10)::numeric))),
    CONSTRAINT eval_run_score_status_check CHECK ((score_status = ANY (ARRAY['established'::text, 'provisional'::text, 'not_established'::text]))),
    CONSTRAINT eval_run_scored_check CHECK (((scored_at IS NULL) = (score_status IS NULL)))
);


--
-- Name: eval_run_dimension; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.eval_run_dimension (
    eval_run_id uuid NOT NULL,
    protocol_version_id uuid NOT NULL,
    dimension_id uuid NOT NULL,
    score numeric,
    coverage numeric,
    CONSTRAINT eval_run_dimension_coverage_check CHECK (((coverage >= (0)::numeric) AND (coverage <= (1)::numeric))),
    CONSTRAINT eval_run_dimension_score_check CHECK (((score >= (0)::numeric) AND (score <= (10)::numeric)))
);


--
-- Name: event; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.event (
    id bigint NOT NULL,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    kind text NOT NULL,
    subject text DEFAULT ''::text NOT NULL,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    ok boolean,
    refusal text,
    run_id uuid,
    team_id uuid,
    duration_ms integer,
    request_bytes integer,
    response_bytes integer,
    batched boolean DEFAULT false NOT NULL,
    plugin text,
    plugin_version text,
    tool_key text,
    refusal_owner text,
    actor_id uuid,
    initiative_id uuid,
    session text DEFAULT ''::text NOT NULL,
    skill_version_id uuid,
    CONSTRAINT event_initiative_id_team_id_check CHECK (((initiative_id IS NULL) OR (team_id IS NOT NULL))),
    CONSTRAINT event_kind_check CHECK ((kind ~ '^[a-z_]+(\.[a-z_]+)?$'::text)),
    CONSTRAINT event_refusal_owner_check CHECK (((refusal_owner IS NULL) OR ((refusal_owner = ANY (ARRAY['guardrail'::text, 'ours'::text, 'theirs'::text, 'other'::text])) AND (ok = false)))),
    CONSTRAINT event_run_id_team_id_check CHECK (((run_id IS NULL) OR (team_id IS NOT NULL))),
    CONSTRAINT event_tool_call_names_its_tool_check CHECK (((kind <> 'tool_call'::text) OR ((ok IS NOT NULL) AND (tool_key IS NOT NULL))))
);


--
-- Name: COLUMN event.ok; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.event.ok IS 'Whether the call worked, in the platform''s own terms — never a transport status. An MCP
   tool that refuses answers HTTP 200 with ERROR: in its text.';


--
-- Name: COLUMN event.plugin; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.event.plugin IS 'Which plugin owns the skill the caller had loaded, resolved through zz.plugin_version_skill from currentStep() — never from flow_install and never from the x-zz-client header. Null when no skill was loaded, or the step names none that a plugin has released.';


--
-- Name: COLUMN event.plugin_version; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.event.plugin_version IS 'The released version of `plugin` that shipped the skill version the caller was on. Null exactly when plugin is null.';


--
-- Name: COLUMN event.tool_key; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.event.tool_key IS 'The alias-resolved `<surface>:<tool>` name (Task I-2''s resolver), so a row written after this column existed already reads as one series across a rename with no further lookup.';


--
-- Name: event_id_seq; Type: SEQUENCE; Schema: zz; Owner: -
--

ALTER TABLE zz.event ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME zz.event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: improvement_run; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.improvement_run (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    eval_run_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL
);


--
-- Name: improvement_run_finding; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.improvement_run_finding (
    improvement_run_id uuid NOT NULL,
    finding_id uuid NOT NULL
);


--
-- Name: initiative; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.initiative (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    slug text NOT NULL,
    flow text,
    opened_at timestamp with time zone DEFAULT now() NOT NULL,
    opened_by uuid,
    closed_at timestamp with time zone,
    closed_by uuid,
    outcome text,
    accepted_by text,
    no_signoff_reason text,
    CONSTRAINT initiative_accepted_by_check CHECK (((outcome <> 'accepted'::text) OR (accepted_by IS NOT NULL))),
    CONSTRAINT initiative_closed_envelope_check CHECK ((((closed_at IS NULL) = (outcome IS NULL)) AND ((closed_at IS NULL) = (closed_by IS NULL)))),
    CONSTRAINT initiative_outcome_check CHECK (((outcome IS NULL) OR (outcome = ANY (ARRAY['accepted'::text, 'delivered'::text, 'abandoned'::text])))),
    CONSTRAINT initiative_signoff_check CHECK (((accepted_by IS NULL) OR (no_signoff_reason IS NULL))),
    CONSTRAINT initiative_slug_check CHECK ((slug ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9][a-z0-9-]*$'::text))
);


--
-- Name: TABLE initiative; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.initiative IS 'class=state_machine; authority=this; question=what is the lifecycle state of one piece of delivery work, from opened to its outcome?; transitions=open->accepted,open->delivered,open->abandoned';


--
-- Name: COLUMN initiative.id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.initiative.id IS 'class=state_machine; authority=this; question=what is this initiative''s own identity?';


--
-- Name: COLUMN initiative.team_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.initiative.team_id IS 'class=relation; authority=this; question=which team owns this initiative?';


--
-- Name: COLUMN initiative.slug; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.initiative.slug IS 'class=state_machine; authority=this; question=what is this initiative''s stable, human-chosen identifier within its team?';


--
-- Name: COLUMN initiative.flow; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.initiative.flow IS 'class=state_machine; authority=this; question=which flow does this initiative run, if any?';


--
-- Name: COLUMN initiative.opened_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.initiative.opened_at IS 'class=state_machine; authority=this; question=when did this initiative''s lifecycle begin?';


--
-- Name: COLUMN initiative.opened_by; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.initiative.opened_by IS 'class=state_machine; authority=this; question=which principal opened this initiative?';


--
-- Name: COLUMN initiative.closed_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.initiative.closed_at IS 'class=state_machine; authority=this; question=when did this initiative''s lifecycle end, if it has?';


--
-- Name: COLUMN initiative.closed_by; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.initiative.closed_by IS 'class=state_machine; authority=this; question=which principal closed this initiative, if it has?';


--
-- Name: COLUMN initiative.outcome; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.initiative.outcome IS 'class=state_machine; authority=this; question=what did this initiative''s lifecycle conclude, if it has closed?';


--
-- Name: COLUMN initiative.accepted_by; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.initiative.accepted_by IS 'class=state_machine; authority=this; question=who is recorded as having signed off on this initiative''s accepted outcome, if it was accepted?';


--
-- Name: COLUMN initiative.no_signoff_reason; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.initiative.no_signoff_reason IS 'class=state_machine; authority=this; question=why was this initiative''s accepted outcome accepted without a named sign-off, if so?';


--
-- Name: initiative_fact; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.initiative_fact (
    fact text NOT NULL,
    value text NOT NULL,
    set_at timestamp with time zone DEFAULT now() NOT NULL,
    initiative_id uuid NOT NULL
);


--
-- Name: TABLE initiative_fact; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.initiative_fact IS 'Mirror of <initiative>/_facts.json for the console. The file is authoritative; a row here is never updated once written for a given (team, initiative, fact).';


--
-- Name: knowledge_node; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.knowledge_node (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    lifecycle text DEFAULT 'adopted'::text NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    body text DEFAULT ''::text NOT NULL,
    body_tsv tsvector,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    content_hash text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    analyzer_version text,
    team_id uuid NOT NULL,
    node_ordinal text NOT NULL,
    slug text NOT NULL,
    superseded_by_id uuid,
    CONSTRAINT knowledge_node_kind_check CHECK ((kind = ANY (ARRAY['decision'::text, 'design'::text, 'process'::text, 'knowledge'::text, 'behavior'::text, 'style'::text]))),
    CONSTRAINT knowledge_node_lifecycle_check CHECK ((lifecycle = ANY (ARRAY['adopted'::text, 'superseded'::text]))),
    CONSTRAINT knowledge_node_lifecycle_superseded_check CHECK (((lifecycle = 'superseded'::text) = (superseded_by_id IS NOT NULL)))
);


--
-- Name: knowledge_node_evidence; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.knowledge_node_evidence (
    node_id uuid NOT NULL,
    initiative_id uuid NOT NULL
);


--
-- Name: mcp_oauth_authz; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.mcp_oauth_authz (
    client_id text NOT NULL,
    principal_id uuid NOT NULL,
    redirect_uri text NOT NULL,
    code_challenge text NOT NULL,
    resource text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    code_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone
);


--
-- Name: mcp_oauth_client; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.mcp_oauth_client (
    client_id text NOT NULL,
    redirect_uris jsonb NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone
);


--
-- Name: membership; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.membership (
    team_id uuid NOT NULL,
    principal_id uuid NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    added_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT membership_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'member'::text])))
);


--
-- Name: model_call; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.model_call (
    id bigint NOT NULL,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    purpose text NOT NULL,
    model text NOT NULL,
    input_tokens integer,
    output_tokens integer,
    cache_read_tokens integer,
    duration_ms integer,
    ok boolean NOT NULL,
    attempts integer DEFAULT 1 NOT NULL,
    error text,
    CONSTRAINT model_call_error_check CHECK (((error IS NULL) OR (NOT ok)))
);


--
-- Name: model_call_id_seq; Type: SEQUENCE; Schema: zz; Owner: -
--

ALTER TABLE zz.model_call ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME zz.model_call_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: passkey; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.passkey (
    id text NOT NULL,
    principal_id uuid NOT NULL,
    public_key bytea NOT NULL,
    counter bigint DEFAULT 0 NOT NULL,
    transports text[],
    label text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone
);


--
-- Name: passkey_challenge; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.passkey_challenge (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    challenge text NOT NULL,
    kind text NOT NULL,
    principal_id uuid,
    redirect_to text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT passkey_challenge_kind_check CHECK ((kind = ANY (ARRAY['register'::text, 'login'::text]))),
    CONSTRAINT passkey_challenge_kind_principal_check CHECK (((kind = 'register'::text) = (principal_id IS NOT NULL)))
);


--
-- Name: passkey_enrolment; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.passkey_enrolment (
    token_hash text NOT NULL,
    principal_id uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone
);


--
-- Name: pat; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.pat (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    principal_id uuid NOT NULL,
    token_hash text NOT NULL,
    label text DEFAULT ''::text NOT NULL,
    team_id uuid,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    oauth_client_id text
);


--
-- Name: plugin; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.plugin (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    origin text NOT NULL,
    owner_team_id uuid,
    CONSTRAINT plugin_origin_check CHECK ((origin = ANY (ARRAY['platform'::text, 'third_party'::text])))
);


--
-- Name: plugin_release_owner; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.plugin_release_owner (
    plugin_id uuid NOT NULL,
    team_id uuid NOT NULL
);


--
-- Name: plugin_tool; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.plugin_tool (
    plugin_version_id uuid NOT NULL,
    name text NOT NULL,
    door text NOT NULL,
    CONSTRAINT plugin_tool_door_check CHECK ((door = ANY (ARRAY['core'::text, 'eval'::text, 'manage'::text])))
);


--
-- Name: plugin_version; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.plugin_version (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    plugin_id uuid NOT NULL,
    version text NOT NULL,
    digest text NOT NULL,
    released_at timestamp with time zone DEFAULT now() NOT NULL,
    component_manifest jsonb,
    source_locator jsonb,
    tree_digest text,
    resolved_commit text
);


--
-- Name: plugin_version_skill; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.plugin_version_skill (
    plugin_version_id uuid NOT NULL,
    skill_version_id uuid NOT NULL,
    skill_id uuid NOT NULL
);


--
-- Name: principal; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.principal (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email zz.citext NOT NULL,
    display_name text DEFAULT ''::text NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    active_team_id uuid,
    CONSTRAINT principal_role_check CHECK ((role = ANY (ARRAY['superadmin'::text, 'member'::text]))),
    CONSTRAINT principal_status_check CHECK ((status = ANY (ARRAY['active'::text, 'deactivated'::text])))
);


--
-- Name: release_attempt; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.release_attempt (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    candidate_id uuid NOT NULL,
    status text NOT NULL,
    released_plugin_version_id uuid,
    release_ref text,
    verification jsonb,
    created_at timestamp with time zone NOT NULL,
    reason text,
    plugin_id uuid NOT NULL,
    applying_at timestamp with time zone,
    verdict text,
    verified_at timestamp with time zone,
    applied_by uuid,
    CONSTRAINT release_attempt_release_ref_check CHECK (((release_ref IS NULL) OR (release_ref ~ '^[0-9a-f]{40}$'::text))),
    CONSTRAINT release_attempt_released_check CHECK (((status = ANY (ARRAY['released'::text, 'rolled_back'::text])) = (released_plugin_version_id IS NOT NULL))),
    CONSTRAINT release_attempt_status_check CHECK ((status = ANY (ARRAY['prepared'::text, 'applying'::text, 'released'::text, 'refused'::text, 'failed'::text, 'rolled_back'::text]))),
    CONSTRAINT release_attempt_verdict_check CHECK ((verdict = ANY (ARRAY['established'::text, 'rolled_back'::text, 'not_established'::text])))
);


--
-- Name: COLUMN release_attempt.verification; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.release_attempt.verification IS 'The evidence the verdict rests on: {post_release_runs, released_eval_run_id, released_overall, base_eval_run_id, base_overall, delta, regression_band, guardrail_status}. Null until the released subject has enough real runs and an evaluation to judge. The verdict itself is the verdict column, and when it landed is verified_at.';


--
-- Name: COLUMN release_attempt.reason; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.release_attempt.reason IS 'Why this attempt ended as it did: releaseDecision''s own reason on a refusal, the failing command''s output tail (release_record) on a failure, the operator''s reason on a rollback, or the accepted override (--reconcile --accept-tag-without-candidate-commit) on a reconciled release. Null for prepared/applying, and for a release proved without an override.';


--
-- Name: COLUMN release_attempt.plugin_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.release_attempt.plugin_id IS 'The plugin this attempt releases — the base subject''s own plugin, written by release_prepare. Keys release_attempt_applying_plugin_idx: at most one applying attempt per plugin.';


--
-- Name: COLUMN release_attempt.applying_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.release_attempt.applying_at IS 'When release_apply moved this attempt to applying. An attempt still applying long after the CLI''s own gate and release timeouts is stale: release_apply names it for reconciliation.';


--
-- Name: COLUMN release_attempt.applied_by; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.release_attempt.applied_by IS 'The principal whose release_apply moved this attempt to applying. release_record and release_verify accept that principal or a member of a required owner team, nobody else.';


--
-- Name: release_attempt_owner; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.release_attempt_owner (
    release_attempt_id uuid NOT NULL,
    team_id uuid NOT NULL
);



--
-- Name: skill; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.skill (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    flow text,
    retired boolean DEFAULT false NOT NULL
);


--
-- Name: COLUMN skill.retired; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.skill.retired IS 'No longer in the catalog. Kept because zz.run and zz.doc attribute documents to its versions.';


--
-- Name: skill_run; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.skill_run (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    initiative_id uuid,
    skill_version_id uuid NOT NULL,
    session text DEFAULT ''::text NOT NULL,
    calls integer DEFAULT 0 NOT NULL,
    refusals integer DEFAULT 0 NOT NULL,
    bytes_total bigint,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone NOT NULL,
    team_id uuid NOT NULL,
    CONSTRAINT skill_run_ended_at_check CHECK ((ended_at >= started_at)),
    CONSTRAINT skill_run_refusals_check CHECK (((0 <= refusals) AND (refusals <= calls)))
);


--
-- Name: COLUMN skill_run.bytes_total; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.skill_run.bytes_total IS 'Sum of response_bytes over the run''s events. Null when no event in the run was measured — distinct from 0, which means measured and empty. Zeros written before migration 051 are ambiguous and were deliberately not converted.';


--
-- Name: skill_version; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.skill_version (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    skill_id uuid NOT NULL,
    version text NOT NULL,
    content_hash text DEFAULT ''::text NOT NULL,
    released_at timestamp with time zone DEFAULT now() NOT NULL,
    body_hash text DEFAULT ''::text NOT NULL
);


--
-- Name: COLUMN skill_version.body_hash; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.skill_version.body_hash IS 'sha256 of the SKILL.md below its frontmatter. Equal hashes mean the skill itself did not change.';


--
-- Name: team; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.team (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT team_slug_check CHECK ((slug ~ '^[a-z0-9][a-z0-9_-]{1,63}$'::text)),
    CONSTRAINT team_status_check CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text])))
);


--
-- Name: control_evidence seq; Type: DEFAULT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.control_evidence ALTER COLUMN seq SET DEFAULT nextval('zz.control_evidence_seq_seq'::regclass);


--
-- Name: control_waiver seq; Type: DEFAULT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.control_waiver ALTER COLUMN seq SET DEFAULT nextval('zz.control_waiver_seq_seq'::regclass);


--
-- Name: assessment assessment_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.assessment
    ADD CONSTRAINT assessment_pkey PRIMARY KEY (id);


--
-- Name: bug bug_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.bug
    ADD CONSTRAINT bug_pkey PRIMARY KEY (id);


--
-- Name: bug bug_team_id_id_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.bug
    ADD CONSTRAINT bug_team_id_id_key UNIQUE (team_id, id);


--
-- Name: candidate candidate_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.candidate
    ADD CONSTRAINT candidate_pkey PRIMARY KEY (id);


--
-- Name: console_session console_session_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.console_session
    ADD CONSTRAINT console_session_pkey PRIMARY KEY (id);


--
-- Name: console_session console_session_token_hash_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.console_session
    ADD CONSTRAINT console_session_token_hash_key UNIQUE (token_hash);


--
-- Name: control_evidence control_evidence_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.control_evidence
    ADD CONSTRAINT control_evidence_pkey PRIMARY KEY (seq);


--
-- Name: control_evidence control_evidence_run_id_entry_id_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.control_evidence
    ADD CONSTRAINT control_evidence_run_id_entry_id_key UNIQUE (run_id, entry_id);


--
-- Name: control_run control_run_initiative_id_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.control_run
    ADD CONSTRAINT control_run_initiative_id_key UNIQUE (initiative_id);


--
-- Name: control_run control_run_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.control_run
    ADD CONSTRAINT control_run_pkey PRIMARY KEY (id);


--
-- Name: control_waiver control_waiver_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.control_waiver
    ADD CONSTRAINT control_waiver_pkey PRIMARY KEY (seq);


--
-- Name: control_waiver control_waiver_run_id_step_id_kind_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.control_waiver
    ADD CONSTRAINT control_waiver_run_id_step_id_kind_key UNIQUE (run_id, step_id, kind);


--
-- Name: doc doc_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.doc
    ADD CONSTRAINT doc_pkey PRIMARY KEY (team_slug, initiative, path);


--
-- Name: eval_assessment eval_assessment_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_assessment
    ADD CONSTRAINT eval_assessment_pkey PRIMARY KEY (id);


--
-- Name: eval_assessment eval_assessment_subject_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_assessment
    ADD CONSTRAINT eval_assessment_subject_key UNIQUE NULLS NOT DISTINCT (eval_run_id, measure_id, subject_kind, run_id, doc_id, doc_revision, knowledge_node_id, bug_id, event_id);


--
-- Name: eval_dimension eval_dimension_id_protocol_version_id_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_dimension
    ADD CONSTRAINT eval_dimension_id_protocol_version_id_key UNIQUE (id, protocol_version_id);


--
-- Name: eval_dimension eval_dimension_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_dimension
    ADD CONSTRAINT eval_dimension_pkey PRIMARY KEY (id);


--
-- Name: eval_dimension eval_dimension_protocol_version_id_key_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_dimension
    ADD CONSTRAINT eval_dimension_protocol_version_id_key_key UNIQUE (protocol_version_id, key);


--
-- Name: eval_evaluator_qualification eval_evaluator_qualification_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_evaluator_qualification
    ADD CONSTRAINT eval_evaluator_qualification_pkey PRIMARY KEY (id);


--
-- Name: eval_evaluator_version eval_evaluator_version_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_evaluator_version
    ADD CONSTRAINT eval_evaluator_version_pkey PRIMARY KEY (id);


--
-- Name: eval_evaluator_version eval_evaluator_version_stable_key_content_digest_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_evaluator_version
    ADD CONSTRAINT eval_evaluator_version_stable_key_content_digest_key UNIQUE (stable_key, content_digest);


--
-- Name: eval_evaluator_version eval_evaluator_version_stable_key_version_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_evaluator_version
    ADD CONSTRAINT eval_evaluator_version_stable_key_version_key UNIQUE (stable_key, version);


--
-- Name: eval_failure_mode eval_failure_mode_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_failure_mode
    ADD CONSTRAINT eval_failure_mode_pkey PRIMARY KEY (id);


--
-- Name: eval_failure_mode eval_failure_mode_plugin_id_stable_key_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_failure_mode
    ADD CONSTRAINT eval_failure_mode_plugin_id_stable_key_key UNIQUE (plugin_id, stable_key);


--
-- Name: eval_failure_mode_sighting eval_failure_mode_sighting_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_failure_mode_sighting
    ADD CONSTRAINT eval_failure_mode_sighting_pkey PRIMARY KEY (id);


--
-- Name: eval_finding eval_finding_eval_run_id_id_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_finding
    ADD CONSTRAINT eval_finding_eval_run_id_id_key UNIQUE (eval_run_id, id);


--
-- Name: eval_finding eval_finding_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_finding
    ADD CONSTRAINT eval_finding_pkey PRIMARY KEY (id);


--
-- Name: eval_idempotency eval_idempotency_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_idempotency
    ADD CONSTRAINT eval_idempotency_pkey PRIMARY KEY (principal_id, tool, idempotency_key);


--
-- Name: eval_measure eval_measure_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_measure
    ADD CONSTRAINT eval_measure_pkey PRIMARY KEY (id);


--
-- Name: eval_measure eval_measure_protocol_version_id_key_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_measure
    ADD CONSTRAINT eval_measure_protocol_version_id_key_key UNIQUE (protocol_version_id, key);


--
-- Name: eval_observation_snapshot eval_observation_snapshot_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_observation_snapshot
    ADD CONSTRAINT eval_observation_snapshot_pkey PRIMARY KEY (id);


--
-- Name: eval_protocol_failure_mode eval_protocol_failure_mode_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_protocol_failure_mode
    ADD CONSTRAINT eval_protocol_failure_mode_pkey PRIMARY KEY (protocol_version_id, failure_mode_id);


--
-- Name: eval_protocol_version eval_protocol_version_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_protocol_version
    ADD CONSTRAINT eval_protocol_version_pkey PRIMARY KEY (id);


--
-- Name: eval_protocol_version eval_protocol_version_plugin_id_version_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_protocol_version
    ADD CONSTRAINT eval_protocol_version_plugin_id_version_key UNIQUE (plugin_id, version);


--
-- Name: eval_run_dimension eval_run_dimension_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_run_dimension
    ADD CONSTRAINT eval_run_dimension_pkey PRIMARY KEY (eval_run_id, dimension_id);


--
-- Name: eval_run eval_run_id_protocol_version_id_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_run
    ADD CONSTRAINT eval_run_id_protocol_version_id_key UNIQUE (id, protocol_version_id);


--
-- Name: eval_run eval_run_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_run
    ADD CONSTRAINT eval_run_pkey PRIMARY KEY (id);


--
-- Name: event event_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.event
    ADD CONSTRAINT event_pkey PRIMARY KEY (id);


--
-- Name: improvement_run_finding improvement_run_finding_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.improvement_run_finding
    ADD CONSTRAINT improvement_run_finding_pkey PRIMARY KEY (improvement_run_id, finding_id);


--
-- Name: improvement_run improvement_run_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.improvement_run
    ADD CONSTRAINT improvement_run_pkey PRIMARY KEY (id);


--
-- Name: initiative_fact initiative_fact_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.initiative_fact
    ADD CONSTRAINT initiative_fact_pkey PRIMARY KEY (initiative_id, fact);


--
-- Name: initiative initiative_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.initiative
    ADD CONSTRAINT initiative_pkey PRIMARY KEY (id);


--
-- Name: initiative initiative_team_id_id_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.initiative
    ADD CONSTRAINT initiative_team_id_id_key UNIQUE (team_id, id);


--
-- Name: initiative initiative_team_id_slug_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.initiative
    ADD CONSTRAINT initiative_team_id_slug_key UNIQUE (team_id, slug);


--
-- Name: knowledge_node_evidence knowledge_node_evidence_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.knowledge_node_evidence
    ADD CONSTRAINT knowledge_node_evidence_pkey PRIMARY KEY (node_id, initiative_id);


--
-- Name: knowledge_node knowledge_node_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.knowledge_node
    ADD CONSTRAINT knowledge_node_pkey PRIMARY KEY (id);


--
-- Name: knowledge_node knowledge_node_team_id_id_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.knowledge_node
    ADD CONSTRAINT knowledge_node_team_id_id_key UNIQUE (team_id, id);


--
-- Name: knowledge_node knowledge_node_team_id_node_ordinal_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.knowledge_node
    ADD CONSTRAINT knowledge_node_team_id_node_ordinal_key UNIQUE (team_id, node_ordinal);


--
-- Name: mcp_oauth_authz mcp_oauth_authz_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.mcp_oauth_authz
    ADD CONSTRAINT mcp_oauth_authz_pkey PRIMARY KEY (code_hash);


--
-- Name: mcp_oauth_client mcp_oauth_client_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.mcp_oauth_client
    ADD CONSTRAINT mcp_oauth_client_pkey PRIMARY KEY (client_id);


--
-- Name: membership membership_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.membership
    ADD CONSTRAINT membership_pkey PRIMARY KEY (team_id, principal_id);


--
-- Name: model_call model_call_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.model_call
    ADD CONSTRAINT model_call_pkey PRIMARY KEY (id);


--
-- Name: passkey_challenge passkey_challenge_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.passkey_challenge
    ADD CONSTRAINT passkey_challenge_pkey PRIMARY KEY (id);


--
-- Name: passkey_enrolment passkey_enrolment_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.passkey_enrolment
    ADD CONSTRAINT passkey_enrolment_pkey PRIMARY KEY (token_hash);


--
-- Name: passkey passkey_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.passkey
    ADD CONSTRAINT passkey_pkey PRIMARY KEY (id);


--
-- Name: pat pat_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.pat
    ADD CONSTRAINT pat_pkey PRIMARY KEY (id);


--
-- Name: pat pat_token_hash_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.pat
    ADD CONSTRAINT pat_token_hash_key UNIQUE (token_hash);


--
-- Name: plugin plugin_name_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.plugin
    ADD CONSTRAINT plugin_name_key UNIQUE (name);


--
-- Name: plugin plugin_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.plugin
    ADD CONSTRAINT plugin_pkey PRIMARY KEY (id);


--
-- Name: plugin_release_owner plugin_release_owner_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.plugin_release_owner
    ADD CONSTRAINT plugin_release_owner_pkey PRIMARY KEY (plugin_id, team_id);


--
-- Name: plugin_tool plugin_tool_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.plugin_tool
    ADD CONSTRAINT plugin_tool_pkey PRIMARY KEY (plugin_version_id, name);


--
-- Name: plugin_version plugin_version_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.plugin_version
    ADD CONSTRAINT plugin_version_pkey PRIMARY KEY (id);


--
-- Name: plugin_version plugin_version_plugin_id_version_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.plugin_version
    ADD CONSTRAINT plugin_version_plugin_id_version_key UNIQUE (plugin_id, version);


--
-- Name: plugin_version_skill plugin_version_skill_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.plugin_version_skill
    ADD CONSTRAINT plugin_version_skill_pkey PRIMARY KEY (plugin_version_id, skill_id);


--
-- Name: principal principal_email_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.principal
    ADD CONSTRAINT principal_email_key UNIQUE (email);


--
-- Name: principal principal_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.principal
    ADD CONSTRAINT principal_pkey PRIMARY KEY (id);


--
-- Name: release_attempt_owner release_attempt_owner_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.release_attempt_owner
    ADD CONSTRAINT release_attempt_owner_pkey PRIMARY KEY (release_attempt_id, team_id);


--
-- Name: release_attempt release_attempt_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.release_attempt
    ADD CONSTRAINT release_attempt_pkey PRIMARY KEY (id);


--
-- Name: skill_run run_initiative_id_skill_version_id_caller_session_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.skill_run
    ADD CONSTRAINT run_initiative_id_skill_version_id_caller_session_key UNIQUE (initiative_id, skill_version_id, session);


--
-- Name: skill_run run_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.skill_run
    ADD CONSTRAINT run_pkey PRIMARY KEY (id);



--
-- Name: skill skill_name_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.skill
    ADD CONSTRAINT skill_name_key UNIQUE (name);


--
-- Name: skill skill_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.skill
    ADD CONSTRAINT skill_pkey PRIMARY KEY (id);


--
-- Name: skill_run skill_run_team_id_id_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.skill_run
    ADD CONSTRAINT skill_run_team_id_id_key UNIQUE (team_id, id);


--
-- Name: skill_version skill_version_content_hash_check; Type: CHECK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE zz.skill_version
    ADD CONSTRAINT skill_version_content_hash_check CHECK ((content_hash ~ '^[0-9a-f]{64}$'::text)) NOT VALID;


--
-- Name: skill_version skill_version_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.skill_version
    ADD CONSTRAINT skill_version_pkey PRIMARY KEY (id);


--
-- Name: skill_version skill_version_skill_id_id_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.skill_version
    ADD CONSTRAINT skill_version_skill_id_id_key UNIQUE (skill_id, id);


--
-- Name: skill_version skill_version_skill_id_version_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.skill_version
    ADD CONSTRAINT skill_version_skill_id_version_key UNIQUE (skill_id, version);


--
-- Name: team team_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.team
    ADD CONSTRAINT team_pkey PRIMARY KEY (id);


--
-- Name: team team_slug_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.team
    ADD CONSTRAINT team_slug_key UNIQUE (slug);


--
-- Name: bug_open; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX bug_open ON zz.bug USING btree (status, reported_at DESC);


--
-- Name: console_session_expiry; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX console_session_expiry ON zz.console_session USING btree (expires_at);


--
-- Name: console_session_principal; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX console_session_principal ON zz.console_session USING btree (principal_id);


--
-- Name: control_evidence_run_seq; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX control_evidence_run_seq ON zz.control_evidence USING btree (run_id, seq);


--
-- Name: control_evidence_supersedes; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX control_evidence_supersedes ON zz.control_evidence USING btree (run_id, supersedes) WHERE (supersedes IS NOT NULL);


--
-- Name: control_waiver_run; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX control_waiver_run ON zz.control_waiver USING btree (run_id);


--
-- Name: doc_body_trgm; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX doc_body_trgm ON zz.doc USING gin (body zz.gin_trgm_ops);


--
-- Name: doc_evidence; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX doc_evidence ON zz.doc USING gin (evidence);


--
-- Name: doc_id_unique; Type: INDEX; Schema: zz; Owner: -
--

CREATE UNIQUE INDEX doc_id_unique ON zz.doc USING btree (id);


--
-- Name: doc_supports; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX doc_supports ON zz.doc USING btree (team_slug, initiative, supports) WHERE (supports IS NOT NULL);


--
-- Name: doc_tags; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX doc_tags ON zz.doc USING gin (tags);


--
-- Name: doc_team_type; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX doc_team_type ON zz.doc USING btree (team_slug, type, status);


--
-- Name: doc_tsv; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX doc_tsv ON zz.doc USING gin (body_tsv);


--
-- Name: eval_assessment_eval_run_id_idx; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX eval_assessment_eval_run_id_idx ON zz.eval_assessment USING btree (eval_run_id);


--
-- Name: eval_evaluator_qualification_measure_id_qualified_at_idx; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX eval_evaluator_qualification_measure_id_qualified_at_idx ON zz.eval_evaluator_qualification USING btree (measure_id, qualified_at DESC);


--
-- Name: eval_finding_eval_run_id_idx; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX eval_finding_eval_run_id_idx ON zz.eval_finding USING btree (eval_run_id);


--
-- Name: eval_run_protocol_version_id_created_at_idx; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX eval_run_protocol_version_id_created_at_idx ON zz.eval_run USING btree (protocol_version_id, created_at DESC);


--
-- Name: event_kind_ts; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX event_kind_ts ON zz.event USING btree (kind, ts);


--
-- Name: event_refusal_owner_idx; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX event_refusal_owner_idx ON zz.event USING btree (refusal_owner) WHERE (ok = false);


--
-- Name: event_run; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX event_run ON zz.event USING btree (run_id) WHERE (run_id IS NOT NULL);


--
-- Name: improvement_run_eval_run_id_created_at_idx; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX improvement_run_eval_run_id_created_at_idx ON zz.improvement_run USING btree (eval_run_id, created_at DESC);


--
-- Name: knowledge_node_body_trgm; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX knowledge_node_body_trgm ON zz.knowledge_node USING gin (body zz.gin_trgm_ops);


--
-- Name: knowledge_node_tags; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX knowledge_node_tags ON zz.knowledge_node USING gin (tags);


--
-- Name: knowledge_node_team; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX knowledge_node_team ON zz.knowledge_node USING btree (team_id, lifecycle);


--
-- Name: knowledge_node_tsv; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX knowledge_node_tsv ON zz.knowledge_node USING gin (body_tsv);


--
-- Name: mcp_oauth_authz_expiry; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX mcp_oauth_authz_expiry ON zz.mcp_oauth_authz USING btree (expires_at);


--
-- Name: membership_principal; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX membership_principal ON zz.membership USING btree (principal_id);


--
-- Name: model_call_failed_ts; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX model_call_failed_ts ON zz.model_call USING btree (ts DESC) WHERE (NOT ok);


--
-- Name: model_call_purpose_ts; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX model_call_purpose_ts ON zz.model_call USING btree (purpose, ts);


--
-- Name: passkey_challenge_expiry; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX passkey_challenge_expiry ON zz.passkey_challenge USING btree (expires_at);


--
-- Name: passkey_enrolment_expiry; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX passkey_enrolment_expiry ON zz.passkey_enrolment USING btree (expires_at);


--
-- Name: passkey_enrolment_principal; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX passkey_enrolment_principal ON zz.passkey_enrolment USING btree (principal_id);


--
-- Name: passkey_principal; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX passkey_principal ON zz.passkey USING btree (principal_id);


--
-- Name: pat_live_label; Type: INDEX; Schema: zz; Owner: -
--

CREATE UNIQUE INDEX pat_live_label ON zz.pat USING btree (principal_id, label) WHERE ((revoked_at IS NULL) AND (label <> ''::text));


--
-- Name: pat_principal; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX pat_principal ON zz.pat USING btree (principal_id);


--
-- Name: release_attempt_applying_plugin_idx; Type: INDEX; Schema: zz; Owner: -
--

CREATE UNIQUE INDEX release_attempt_applying_plugin_idx ON zz.release_attempt USING btree (plugin_id) WHERE (status = 'applying'::text);


--
-- Name: release_attempt_live_candidate_idx; Type: INDEX; Schema: zz; Owner: -
--

CREATE UNIQUE INDEX release_attempt_live_candidate_idx ON zz.release_attempt USING btree (candidate_id) WHERE (status = ANY (ARRAY['applying'::text, 'released'::text]));


--
-- Name: run_skill_version; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX run_skill_version ON zz.skill_run USING btree (skill_version_id, started_at DESC);


--
-- Name: skill_run_identity; Type: INDEX; Schema: zz; Owner: -
--

CREATE UNIQUE INDEX skill_run_identity ON zz.skill_run USING btree (team_id, initiative_id, skill_version_id, session) NULLS NOT DISTINCT;


--
-- Name: assessment assessment_asked_by_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.assessment
    ADD CONSTRAINT assessment_asked_by_fkey FOREIGN KEY (asked_by) REFERENCES zz.principal(id);


--
-- Name: assessment assessment_evaluator_version_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.assessment
    ADD CONSTRAINT assessment_evaluator_version_id_fkey FOREIGN KEY (evaluator_version_id) REFERENCES zz.eval_evaluator_version(id);


--
-- Name: assessment assessment_model_call_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.assessment
    ADD CONSTRAINT assessment_model_call_id_fkey FOREIGN KEY (model_call_id) REFERENCES zz.model_call(id);


--
-- Name: assessment assessment_team_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.assessment
    ADD CONSTRAINT assessment_team_id_fkey FOREIGN KEY (team_id) REFERENCES zz.team(id);


--
-- Name: assessment assessment_team_id_initiative_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.assessment
    ADD CONSTRAINT assessment_team_id_initiative_id_fkey FOREIGN KEY (team_id, initiative_id) REFERENCES zz.initiative(team_id, id) ON DELETE SET NULL (initiative_id);


--
-- Name: bug bug_duplicate_of_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.bug
    ADD CONSTRAINT bug_duplicate_of_fkey FOREIGN KEY (team_id, duplicate_of) REFERENCES zz.bug(team_id, id);


--
-- Name: bug bug_initiative_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.bug
    ADD CONSTRAINT bug_initiative_id_fkey FOREIGN KEY (initiative_id) REFERENCES zz.initiative(id) ON DELETE SET NULL;


--
-- Name: bug bug_reported_by_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.bug
    ADD CONSTRAINT bug_reported_by_fkey FOREIGN KEY (reported_by) REFERENCES zz.principal(id);


--
-- Name: bug bug_resolved_by_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.bug
    ADD CONSTRAINT bug_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES zz.principal(id);


--
-- Name: bug bug_team_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.bug
    ADD CONSTRAINT bug_team_id_fkey FOREIGN KEY (team_id) REFERENCES zz.team(id);


--
-- Name: bug bug_team_id_initiative_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.bug
    ADD CONSTRAINT bug_team_id_initiative_id_fkey FOREIGN KEY (team_id, initiative_id) REFERENCES zz.initiative(team_id, id) ON DELETE SET NULL (initiative_id);


--
-- Name: candidate candidate_base_plugin_version_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.candidate
    ADD CONSTRAINT candidate_base_plugin_version_id_fkey FOREIGN KEY (base_plugin_version_id) REFERENCES zz.plugin_version(id);


--
-- Name: candidate candidate_improvement_run_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.candidate
    ADD CONSTRAINT candidate_improvement_run_id_fkey FOREIGN KEY (improvement_run_id) REFERENCES zz.improvement_run(id);


--
-- Name: candidate candidate_proposed_by_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.candidate
    ADD CONSTRAINT candidate_proposed_by_fkey FOREIGN KEY (proposed_by) REFERENCES zz.principal(id);


--
-- Name: console_session console_session_principal_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.console_session
    ADD CONSTRAINT console_session_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES zz.principal(id) ON DELETE CASCADE;


--
-- Name: console_session console_session_team_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.console_session
    ADD CONSTRAINT console_session_team_id_fkey FOREIGN KEY (team_id) REFERENCES zz.team(id) ON DELETE SET NULL;


--
-- Name: control_evidence control_evidence_run_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.control_evidence
    ADD CONSTRAINT control_evidence_run_id_fkey FOREIGN KEY (run_id) REFERENCES zz.control_run(id) ON DELETE CASCADE;


--
-- Name: control_evidence control_evidence_run_id_supersedes_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.control_evidence
    ADD CONSTRAINT control_evidence_run_id_supersedes_fkey FOREIGN KEY (run_id, supersedes) REFERENCES zz.control_evidence(run_id, entry_id);


--
-- Name: control_run control_run_initiative_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.control_run
    ADD CONSTRAINT control_run_initiative_id_fkey FOREIGN KEY (initiative_id) REFERENCES zz.initiative(id) ON DELETE CASCADE;


--
-- Name: control_run control_run_started_by_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.control_run
    ADD CONSTRAINT control_run_started_by_fkey FOREIGN KEY (started_by) REFERENCES zz.principal(id);


--
-- Name: control_waiver control_waiver_run_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.control_waiver
    ADD CONSTRAINT control_waiver_run_id_fkey FOREIGN KEY (run_id) REFERENCES zz.control_run(id) ON DELETE CASCADE;


--
-- Name: doc doc_initiative_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.doc
    ADD CONSTRAINT doc_initiative_id_fkey FOREIGN KEY (initiative_id) REFERENCES zz.initiative(id) ON DELETE SET NULL;


--
-- Name: doc doc_produced_by_run_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.doc
    ADD CONSTRAINT doc_produced_by_run_id_fkey FOREIGN KEY (produced_by_run_id) REFERENCES zz.skill_run(id) ON DELETE SET NULL;


--
-- Name: eval_assessment eval_assessment_assessment_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_assessment
    ADD CONSTRAINT eval_assessment_assessment_id_fkey FOREIGN KEY (assessment_id) REFERENCES zz.assessment(id);


--
-- Name: eval_assessment eval_assessment_bug_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_assessment
    ADD CONSTRAINT eval_assessment_bug_id_fkey FOREIGN KEY (bug_id) REFERENCES zz.bug(id);


--
-- Name: eval_assessment eval_assessment_doc_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_assessment
    ADD CONSTRAINT eval_assessment_doc_id_fkey FOREIGN KEY (doc_id) REFERENCES zz.doc(id);


--
-- Name: eval_assessment eval_assessment_eval_run_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_assessment
    ADD CONSTRAINT eval_assessment_eval_run_id_fkey FOREIGN KEY (eval_run_id) REFERENCES zz.eval_run(id);


--
-- Name: eval_assessment eval_assessment_event_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_assessment
    ADD CONSTRAINT eval_assessment_event_id_fkey FOREIGN KEY (event_id) REFERENCES zz.event(id);


--
-- Name: eval_assessment eval_assessment_knowledge_node_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_assessment
    ADD CONSTRAINT eval_assessment_knowledge_node_id_fkey FOREIGN KEY (knowledge_node_id) REFERENCES zz.knowledge_node(id);


--
-- Name: eval_assessment eval_assessment_measure_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_assessment
    ADD CONSTRAINT eval_assessment_measure_id_fkey FOREIGN KEY (measure_id) REFERENCES zz.eval_measure(id);


--
-- Name: eval_assessment eval_assessment_qualification_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_assessment
    ADD CONSTRAINT eval_assessment_qualification_id_fkey FOREIGN KEY (qualification_id) REFERENCES zz.eval_evaluator_qualification(id);


--
-- Name: eval_assessment eval_assessment_run_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_assessment
    ADD CONSTRAINT eval_assessment_run_id_fkey FOREIGN KEY (run_id) REFERENCES zz.skill_run(id);


--
-- Name: eval_dimension eval_dimension_protocol_version_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_dimension
    ADD CONSTRAINT eval_dimension_protocol_version_id_fkey FOREIGN KEY (protocol_version_id) REFERENCES zz.eval_protocol_version(id);


--
-- Name: eval_evaluator_qualification eval_evaluator_qualification_measure_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_evaluator_qualification
    ADD CONSTRAINT eval_evaluator_qualification_measure_id_fkey FOREIGN KEY (measure_id) REFERENCES zz.eval_measure(id);


--
-- Name: eval_evaluator_qualification eval_evaluator_qualification_qualified_by_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_evaluator_qualification
    ADD CONSTRAINT eval_evaluator_qualification_qualified_by_fkey FOREIGN KEY (qualified_by) REFERENCES zz.principal(id);


--
-- Name: eval_failure_mode eval_failure_mode_plugin_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_failure_mode
    ADD CONSTRAINT eval_failure_mode_plugin_id_fkey FOREIGN KEY (plugin_id) REFERENCES zz.plugin(id);


--
-- Name: eval_failure_mode_sighting eval_failure_mode_sighting_assessment_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_failure_mode_sighting
    ADD CONSTRAINT eval_failure_mode_sighting_assessment_id_fkey FOREIGN KEY (assessment_id) REFERENCES zz.assessment(id);


--
-- Name: eval_failure_mode_sighting eval_failure_mode_sighting_description_model_call_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_failure_mode_sighting
    ADD CONSTRAINT eval_failure_mode_sighting_description_model_call_id_fkey FOREIGN KEY (description_model_call_id) REFERENCES zz.model_call(id);


--
-- Name: eval_failure_mode_sighting eval_failure_mode_sighting_discovered_by_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_failure_mode_sighting
    ADD CONSTRAINT eval_failure_mode_sighting_discovered_by_fkey FOREIGN KEY (discovered_by) REFERENCES zz.principal(id);


--
-- Name: eval_failure_mode_sighting eval_failure_mode_sighting_failure_mode_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_failure_mode_sighting
    ADD CONSTRAINT eval_failure_mode_sighting_failure_mode_id_fkey FOREIGN KEY (failure_mode_id) REFERENCES zz.eval_failure_mode(id);


--
-- Name: eval_failure_mode_sighting eval_failure_mode_sighting_observation_snapshot_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_failure_mode_sighting
    ADD CONSTRAINT eval_failure_mode_sighting_observation_snapshot_id_fkey FOREIGN KEY (observation_snapshot_id) REFERENCES zz.eval_observation_snapshot(id);


--
-- Name: eval_finding eval_finding_decided_by_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_finding
    ADD CONSTRAINT eval_finding_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES zz.principal(id);


--
-- Name: eval_finding eval_finding_eval_run_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_finding
    ADD CONSTRAINT eval_finding_eval_run_id_fkey FOREIGN KEY (eval_run_id) REFERENCES zz.eval_run(id);


--
-- Name: eval_finding eval_finding_eval_run_id_superseded_by_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_finding
    ADD CONSTRAINT eval_finding_eval_run_id_superseded_by_fkey FOREIGN KEY (eval_run_id, superseded_by) REFERENCES zz.eval_finding(eval_run_id, id);


--
-- Name: eval_finding eval_finding_measure_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_finding
    ADD CONSTRAINT eval_finding_measure_id_fkey FOREIGN KEY (measure_id) REFERENCES zz.eval_measure(id);


--
-- Name: eval_idempotency eval_idempotency_principal_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_idempotency
    ADD CONSTRAINT eval_idempotency_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES zz.principal(id);


--
-- Name: eval_measure eval_measure_dimension_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_measure
    ADD CONSTRAINT eval_measure_dimension_id_fkey FOREIGN KEY (dimension_id) REFERENCES zz.eval_dimension(id);


--
-- Name: eval_measure eval_measure_dimension_id_protocol_version_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_measure
    ADD CONSTRAINT eval_measure_dimension_id_protocol_version_id_fkey FOREIGN KEY (dimension_id, protocol_version_id) REFERENCES zz.eval_dimension(id, protocol_version_id);


--
-- Name: eval_measure eval_measure_evaluator_version_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_measure
    ADD CONSTRAINT eval_measure_evaluator_version_id_fkey FOREIGN KEY (evaluator_version_id) REFERENCES zz.eval_evaluator_version(id);


--
-- Name: eval_observation_snapshot eval_observation_snapshot_plugin_version_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_observation_snapshot
    ADD CONSTRAINT eval_observation_snapshot_plugin_version_id_fkey FOREIGN KEY (plugin_version_id) REFERENCES zz.plugin_version(id);


--
-- Name: eval_observation_snapshot eval_observation_snapshot_recorded_by_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_observation_snapshot
    ADD CONSTRAINT eval_observation_snapshot_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES zz.principal(id);


--
-- Name: eval_protocol_failure_mode eval_protocol_failure_mode_failure_mode_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_protocol_failure_mode
    ADD CONSTRAINT eval_protocol_failure_mode_failure_mode_id_fkey FOREIGN KEY (failure_mode_id) REFERENCES zz.eval_failure_mode(id);


--
-- Name: eval_protocol_failure_mode eval_protocol_failure_mode_protocol_version_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_protocol_failure_mode
    ADD CONSTRAINT eval_protocol_failure_mode_protocol_version_id_fkey FOREIGN KEY (protocol_version_id) REFERENCES zz.eval_protocol_version(id);


--
-- Name: eval_protocol_version eval_protocol_version_affirmed_by_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_protocol_version
    ADD CONSTRAINT eval_protocol_version_affirmed_by_fkey FOREIGN KEY (affirmed_by) REFERENCES zz.principal(id);


--
-- Name: eval_protocol_version eval_protocol_version_approved_doc_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_protocol_version
    ADD CONSTRAINT eval_protocol_version_approved_doc_id_fkey FOREIGN KEY (approved_doc_id) REFERENCES zz.doc(id);


--
-- Name: eval_protocol_version eval_protocol_version_plugin_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_protocol_version
    ADD CONSTRAINT eval_protocol_version_plugin_id_fkey FOREIGN KEY (plugin_id) REFERENCES zz.plugin(id);


--
-- Name: eval_protocol_version eval_protocol_version_recorded_by_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_protocol_version
    ADD CONSTRAINT eval_protocol_version_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES zz.principal(id);


--
-- Name: eval_run_dimension eval_run_dimension_dimension_id_protocol_version_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_run_dimension
    ADD CONSTRAINT eval_run_dimension_dimension_id_protocol_version_id_fkey FOREIGN KEY (dimension_id, protocol_version_id) REFERENCES zz.eval_dimension(id, protocol_version_id);


--
-- Name: eval_run_dimension eval_run_dimension_eval_run_id_protocol_version_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_run_dimension
    ADD CONSTRAINT eval_run_dimension_eval_run_id_protocol_version_id_fkey FOREIGN KEY (eval_run_id, protocol_version_id) REFERENCES zz.eval_run(id, protocol_version_id);


--
-- Name: eval_run eval_run_observation_snapshot_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_run
    ADD CONSTRAINT eval_run_observation_snapshot_id_fkey FOREIGN KEY (observation_snapshot_id) REFERENCES zz.eval_observation_snapshot(id);


--
-- Name: eval_run eval_run_protocol_version_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_run
    ADD CONSTRAINT eval_run_protocol_version_id_fkey FOREIGN KEY (protocol_version_id) REFERENCES zz.eval_protocol_version(id);


--
-- Name: eval_run eval_run_started_by_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_run
    ADD CONSTRAINT eval_run_started_by_fkey FOREIGN KEY (started_by) REFERENCES zz.principal(id);


--
-- Name: eval_run eval_run_team_id_initiative_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_run
    ADD CONSTRAINT eval_run_team_id_initiative_id_fkey FOREIGN KEY (team_id, initiative_id) REFERENCES zz.initiative(team_id, id);


--
-- Name: event event_actor_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.event
    ADD CONSTRAINT event_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES zz.principal(id);


--
-- Name: event event_initiative_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.event
    ADD CONSTRAINT event_initiative_id_fkey FOREIGN KEY (initiative_id) REFERENCES zz.initiative(id) ON DELETE SET NULL;


--
-- Name: event event_run_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.event
    ADD CONSTRAINT event_run_id_fkey FOREIGN KEY (run_id) REFERENCES zz.skill_run(id) ON DELETE SET NULL;


--
-- Name: event event_skill_version_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.event
    ADD CONSTRAINT event_skill_version_id_fkey FOREIGN KEY (skill_version_id) REFERENCES zz.skill_version(id);


--
-- Name: event event_team_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.event
    ADD CONSTRAINT event_team_id_fkey FOREIGN KEY (team_id) REFERENCES zz.team(id);


--
-- Name: event event_team_id_initiative_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.event
    ADD CONSTRAINT event_team_id_initiative_id_fkey FOREIGN KEY (team_id, initiative_id) REFERENCES zz.initiative(team_id, id) ON DELETE SET NULL (initiative_id);


--
-- Name: event event_team_id_run_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.event
    ADD CONSTRAINT event_team_id_run_id_fkey FOREIGN KEY (team_id, run_id) REFERENCES zz.skill_run(team_id, id) ON DELETE SET NULL (run_id);


--
-- Name: improvement_run improvement_run_eval_run_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.improvement_run
    ADD CONSTRAINT improvement_run_eval_run_id_fkey FOREIGN KEY (eval_run_id) REFERENCES zz.eval_run(id);


--
-- Name: improvement_run_finding improvement_run_finding_finding_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.improvement_run_finding
    ADD CONSTRAINT improvement_run_finding_finding_id_fkey FOREIGN KEY (finding_id) REFERENCES zz.eval_finding(id);


--
-- Name: improvement_run_finding improvement_run_finding_improvement_run_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.improvement_run_finding
    ADD CONSTRAINT improvement_run_finding_improvement_run_id_fkey FOREIGN KEY (improvement_run_id) REFERENCES zz.improvement_run(id) ON DELETE CASCADE;


--
-- Name: initiative initiative_closed_by_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.initiative
    ADD CONSTRAINT initiative_closed_by_fkey FOREIGN KEY (closed_by) REFERENCES zz.principal(id);


--
-- Name: initiative_fact initiative_fact_initiative_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.initiative_fact
    ADD CONSTRAINT initiative_fact_initiative_id_fkey FOREIGN KEY (initiative_id) REFERENCES zz.initiative(id) ON DELETE CASCADE;


--
-- Name: initiative initiative_opened_by_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.initiative
    ADD CONSTRAINT initiative_opened_by_fkey FOREIGN KEY (opened_by) REFERENCES zz.principal(id);


--
-- Name: initiative initiative_team_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.initiative
    ADD CONSTRAINT initiative_team_id_fkey FOREIGN KEY (team_id) REFERENCES zz.team(id);


--
-- Name: knowledge_node_evidence knowledge_node_evidence_initiative_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.knowledge_node_evidence
    ADD CONSTRAINT knowledge_node_evidence_initiative_id_fkey FOREIGN KEY (initiative_id) REFERENCES zz.initiative(id);


--
-- Name: knowledge_node_evidence knowledge_node_evidence_node_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.knowledge_node_evidence
    ADD CONSTRAINT knowledge_node_evidence_node_id_fkey FOREIGN KEY (node_id) REFERENCES zz.knowledge_node(id) ON DELETE CASCADE;


--
-- Name: knowledge_node knowledge_node_superseded_by_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.knowledge_node
    ADD CONSTRAINT knowledge_node_superseded_by_id_fkey FOREIGN KEY (team_id, superseded_by_id) REFERENCES zz.knowledge_node(team_id, id);


--
-- Name: knowledge_node knowledge_node_team_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.knowledge_node
    ADD CONSTRAINT knowledge_node_team_id_fkey FOREIGN KEY (team_id) REFERENCES zz.team(id);


--
-- Name: mcp_oauth_authz mcp_oauth_authz_client_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.mcp_oauth_authz
    ADD CONSTRAINT mcp_oauth_authz_client_id_fkey FOREIGN KEY (client_id) REFERENCES zz.mcp_oauth_client(client_id) ON DELETE CASCADE;


--
-- Name: mcp_oauth_authz mcp_oauth_authz_principal_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.mcp_oauth_authz
    ADD CONSTRAINT mcp_oauth_authz_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES zz.principal(id) ON DELETE CASCADE;


--
-- Name: membership membership_added_by_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.membership
    ADD CONSTRAINT membership_added_by_fkey FOREIGN KEY (added_by) REFERENCES zz.principal(id);


--
-- Name: membership membership_principal_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.membership
    ADD CONSTRAINT membership_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES zz.principal(id);


--
-- Name: membership membership_team_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.membership
    ADD CONSTRAINT membership_team_id_fkey FOREIGN KEY (team_id) REFERENCES zz.team(id);


--
-- Name: passkey_challenge passkey_challenge_principal_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.passkey_challenge
    ADD CONSTRAINT passkey_challenge_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES zz.principal(id) ON DELETE CASCADE;


--
-- Name: passkey_enrolment passkey_enrolment_principal_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.passkey_enrolment
    ADD CONSTRAINT passkey_enrolment_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES zz.principal(id) ON DELETE CASCADE;


--
-- Name: passkey passkey_principal_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.passkey
    ADD CONSTRAINT passkey_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES zz.principal(id) ON DELETE CASCADE;


--
-- Name: pat pat_oauth_client_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.pat
    ADD CONSTRAINT pat_oauth_client_id_fkey FOREIGN KEY (oauth_client_id) REFERENCES zz.mcp_oauth_client(client_id);


--
-- Name: pat pat_principal_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.pat
    ADD CONSTRAINT pat_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES zz.principal(id);


--
-- Name: pat pat_team_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.pat
    ADD CONSTRAINT pat_team_id_fkey FOREIGN KEY (team_id) REFERENCES zz.team(id);


--
-- Name: plugin plugin_owner_team_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.plugin
    ADD CONSTRAINT plugin_owner_team_id_fkey FOREIGN KEY (owner_team_id) REFERENCES zz.team(id);


--
-- Name: plugin_release_owner plugin_release_owner_plugin_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.plugin_release_owner
    ADD CONSTRAINT plugin_release_owner_plugin_id_fkey FOREIGN KEY (plugin_id) REFERENCES zz.plugin(id) ON DELETE CASCADE;


--
-- Name: plugin_release_owner plugin_release_owner_team_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.plugin_release_owner
    ADD CONSTRAINT plugin_release_owner_team_id_fkey FOREIGN KEY (team_id) REFERENCES zz.team(id);


--
-- Name: plugin_tool plugin_tool_plugin_version_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.plugin_tool
    ADD CONSTRAINT plugin_tool_plugin_version_id_fkey FOREIGN KEY (plugin_version_id) REFERENCES zz.plugin_version(id) ON DELETE CASCADE;


--
-- Name: plugin_version plugin_version_plugin_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.plugin_version
    ADD CONSTRAINT plugin_version_plugin_id_fkey FOREIGN KEY (plugin_id) REFERENCES zz.plugin(id);


--
-- Name: plugin_version_skill plugin_version_skill_plugin_version_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.plugin_version_skill
    ADD CONSTRAINT plugin_version_skill_plugin_version_id_fkey FOREIGN KEY (plugin_version_id) REFERENCES zz.plugin_version(id) ON DELETE CASCADE;


--
-- Name: plugin_version_skill plugin_version_skill_skill_id_skill_version_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.plugin_version_skill
    ADD CONSTRAINT plugin_version_skill_skill_id_skill_version_id_fkey FOREIGN KEY (skill_id, skill_version_id) REFERENCES zz.skill_version(skill_id, id);


--
-- Name: principal principal_active_membership_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.principal
    ADD CONSTRAINT principal_active_membership_fkey FOREIGN KEY (active_team_id, id) REFERENCES zz.membership(team_id, principal_id) ON DELETE SET NULL (active_team_id);


--
-- Name: principal principal_active_team_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.principal
    ADD CONSTRAINT principal_active_team_id_fkey FOREIGN KEY (active_team_id) REFERENCES zz.team(id) ON DELETE SET NULL;


--
-- Name: release_attempt release_attempt_applied_by_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.release_attempt
    ADD CONSTRAINT release_attempt_applied_by_fkey FOREIGN KEY (applied_by) REFERENCES zz.principal(id);


--
-- Name: release_attempt release_attempt_candidate_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.release_attempt
    ADD CONSTRAINT release_attempt_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES zz.candidate(id);


--
-- Name: release_attempt_owner release_attempt_owner_release_attempt_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.release_attempt_owner
    ADD CONSTRAINT release_attempt_owner_release_attempt_id_fkey FOREIGN KEY (release_attempt_id) REFERENCES zz.release_attempt(id) ON DELETE CASCADE;


--
-- Name: release_attempt_owner release_attempt_owner_team_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.release_attempt_owner
    ADD CONSTRAINT release_attempt_owner_team_id_fkey FOREIGN KEY (team_id) REFERENCES zz.team(id);


--
-- Name: release_attempt release_attempt_plugin_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.release_attempt
    ADD CONSTRAINT release_attempt_plugin_id_fkey FOREIGN KEY (plugin_id) REFERENCES zz.plugin(id);


--
-- Name: release_attempt release_attempt_released_plugin_version_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.release_attempt
    ADD CONSTRAINT release_attempt_released_plugin_version_id_fkey FOREIGN KEY (released_plugin_version_id) REFERENCES zz.plugin_version(id);


--
-- Name: skill_run run_initiative_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.skill_run
    ADD CONSTRAINT run_initiative_id_fkey FOREIGN KEY (initiative_id) REFERENCES zz.initiative(id) ON DELETE CASCADE;


--
-- Name: skill_run run_skill_version_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.skill_run
    ADD CONSTRAINT run_skill_version_id_fkey FOREIGN KEY (skill_version_id) REFERENCES zz.skill_version(id);


--
-- Name: skill_run skill_run_team_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.skill_run
    ADD CONSTRAINT skill_run_team_id_fkey FOREIGN KEY (team_id) REFERENCES zz.team(id);


--
-- Name: skill_run skill_run_team_id_initiative_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.skill_run
    ADD CONSTRAINT skill_run_team_id_initiative_id_fkey FOREIGN KEY (team_id, initiative_id) REFERENCES zz.initiative(team_id, id) ON DELETE CASCADE;


--
-- Name: skill_version skill_version_skill_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.skill_version
    ADD CONSTRAINT skill_version_skill_id_fkey FOREIGN KEY (skill_id) REFERENCES zz.skill(id);


--
-- Name: team team_created_by_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.team
    ADD CONSTRAINT team_created_by_fkey FOREIGN KEY (created_by) REFERENCES zz.principal(id);
